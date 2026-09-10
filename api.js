(function () {
  'use strict';

  var config = window.LEARN_CONFIG || {};
  var teacherSessionKey = 'learn_teacher_session_v1';
  var studentSessionKey = 'learn_student_session_v1';

  function ApiError(message, code, details) {
    this.name = 'ApiError';
    this.message = message || '요청을 처리하지 못했습니다.';
    this.code = code || 'UNKNOWN';
    this.details = details || null;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function sleep(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readSession(role) {
    var key = role === 'teacher' ? teacherSessionKey : studentSessionKey;
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch (error) {
      return null;
    }
  }

  function writeSession(role, value) {
    var key = role === 'teacher' ? teacherSessionKey : studentSessionKey;
    if (!value) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  }

  function fileToPayload(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        resolve({
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: result.indexOf(',') >= 0 ? result.split(',')[1] : result
        });
      };
      reader.onerror = function () {
        reject(new ApiError(file.name + ' 파일을 읽지 못했습니다.', 'FILE_READ_FAILED'));
      };
      reader.readAsDataURL(file);
    });
  }

  async function filesToPayload(files) {
    var list = Array.from(files || []);
    var maxEach = Number(config.maxFileSizeMb || 25) * 1024 * 1024;
    var maxTotal = Number(config.maxUploadSizeMb || 35) * 1024 * 1024;
    var total = list.reduce(function (sum, file) { return sum + file.size; }, 0);
    var oversized = list.find(function (file) { return file.size > maxEach; });
    if (oversized) {
      throw new ApiError(
        oversized.name + ' 파일이 ' + (config.maxFileSizeMb || 25) + 'MB를 넘습니다.',
        'FILE_TOO_LARGE'
      );
    }
    if (total > maxTotal) {
      throw new ApiError(
        '한 번에 올리는 파일의 합계는 ' + (config.maxUploadSizeMb || 35) + 'MB 이하여야 합니다.',
        'UPLOAD_TOO_LARGE'
      );
    }
    return Promise.all(list.map(fileToPayload));
  }

  function saveBase64File(file) {
    var binary = atob(file.data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    var blob = new Blob([bytes], { type: file.mimeType || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name || '첨부파일';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function openBundleParts(parts, pendingWindow) {
    (parts || []).forEach(function (part, index) {
      window.setTimeout(function () {
        if (index === 0 && pendingWindow && !pendingWindow.closed) {
          pendingWindow.location.href = part.downloadUrl;
          return;
        }
        var anchor = document.createElement('a');
        anchor.href = part.downloadUrl;
        anchor.download = part.name || '';
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, index * 700);
    });
  }

  function AppAPI() {}

  AppAPI.prototype.request = async function (action, payload, role, retryCount) {
    if (config.demoMode) {
      await sleep(170 + Math.random() * 240);
      return DemoAPI.request(action, payload || {}, role);
    }

    if (!config.apiUrl || config.apiUrl.indexOf('PASTE_') === 0) {
      throw new ApiError('Google Apps Script 주소가 아직 설정되지 않았습니다.', 'NOT_CONFIGURED');
    }

    var session = role ? readSession(role) : null;
    var body = {
      action: action,
      payload: payload || {},
      token: session && session.token ? session.token : ''
    };
    var safeToRetry = ['teacherDashboard', 'getTeacherClass', 'getStudentClass', 'getFileContent', 'heartbeat'];
    var retries = typeof retryCount === 'number' ? retryCount : (safeToRetry.indexOf(action) >= 0 ? 2 : 0);
    try {
      var response = await fetch(config.apiUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new ApiError('서버 응답이 원활하지 않습니다.', 'HTTP_' + response.status);
      }
      var result = await response.json();
      if (!result.ok) {
        if (result.code === 'SESSION_EXPIRED' || result.code === 'UNAUTHORIZED') {
          if (role) writeSession(role, null);
        }
        throw new ApiError(result.message, result.code, result.details);
      }
      return result.data;
    } catch (error) {
      var transient = !error.code || error.code.indexOf('HTTP_5') === 0 || error.code === 'BUSY';
      if (retries > 0 && transient) {
        await sleep(600 + Math.random() * 900);
        return this.request(action, payload, role, retries - 1);
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError('인터넷 연결을 확인한 뒤 다시 시도해 주세요.', 'NETWORK_ERROR');
    }
  };

  var demoStorageKey = 'learn_demo_database_v2';
  var demoFileDatabaseName = 'learn_demo_files_v1';
  var demoFileStoreName = 'files';
  var demoFileDatabasePromise = null;
  var demoFileMemory = {};

  function openDemoFileDatabase() {
    if (demoFileDatabasePromise) return demoFileDatabasePromise;
    demoFileDatabasePromise = new Promise(function (resolve) {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      var request;
      try {
        request = window.indexedDB.open(demoFileDatabaseName, 1);
      } catch (error) {
        resolve(null);
        return;
      }
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(demoFileStoreName)) {
          database.createObjectStore(demoFileStoreName, { keyPath: 'id' });
        }
      };
      request.onsuccess = function () {
        var database = request.result;
        database.onversionchange = function () { database.close(); };
        resolve(database);
      };
      request.onerror = function () { resolve(null); };
      request.onblocked = function () { resolve(null); };
    });
    return demoFileDatabasePromise;
  }

  async function putDemoFile(file) {
    var database = await openDemoFileDatabase();
    if (!database) {
      demoFileMemory[file.id] = clone(file);
      return;
    }
    return new Promise(function (resolve, reject) {
      var transaction = database.transaction(demoFileStoreName, 'readwrite');
      transaction.objectStore(demoFileStoreName).put(file);
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () {
        reject(new ApiError('이 기기의 저장 공간이 부족해 파일을 보관하지 못했습니다.', 'DEMO_FILE_STORAGE_FAILED'));
      };
      transaction.onabort = transaction.onerror;
    });
  }

  async function getDemoFile(fileId) {
    var database = await openDemoFileDatabase();
    if (!database) {
      if (demoFileMemory[fileId]) return clone(demoFileMemory[fileId]);
      throw new ApiError('파일을 찾을 수 없습니다. 같은 브라우저에서 다시 첨부해 주세요.', 'FILE_NOT_FOUND');
    }
    var record = await new Promise(function (resolve, reject) {
      var transaction = database.transaction(demoFileStoreName, 'readonly');
      var request = transaction.objectStore(demoFileStoreName).get(String(fileId));
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error); };
    });
    if (!record) throw new ApiError('파일을 찾을 수 없습니다. 같은 브라우저에서 다시 첨부해 주세요.', 'FILE_NOT_FOUND');
    return record;
  }

  async function deleteDemoFiles(fileIds) {
    var ids = Array.from(new Set((fileIds || []).filter(Boolean).map(String)));
    if (!ids.length) return;
    var database = await openDemoFileDatabase();
    if (!database) {
      ids.forEach(function (id) { delete demoFileMemory[id]; });
      return;
    }
    return new Promise(function (resolve) {
      var transaction = database.transaction(demoFileStoreName, 'readwrite');
      var store = transaction.objectStore(demoFileStoreName);
      ids.forEach(function (id) { store.delete(id); });
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { resolve(); };
      transaction.onabort = function () { resolve(); };
    });
  }

  function attachmentIds(items) {
    return (items || []).reduce(function (ids, item) {
      return ids.concat((item.attachments || []).map(function (file) { return file.id; }));
    }, []);
  }

  async function replaceDemoAttachments(existing, keepAttachmentIds, files) {
    var oldFiles = existing || [];
    var keepMap = {};
    (keepAttachmentIds || []).forEach(function (id) { keepMap[String(id)] = true; });
    var kept = oldFiles.filter(function (file) { return keepMap[String(file.id)]; });
    var removed = oldFiles.filter(function (file) { return !keepMap[String(file.id)]; })
      .map(function (file) { return file.id; });
    var added = [];
    for (var i = 0; i < (files || []).length; i += 1) {
      var source = files[i];
      var id = uid('file');
      var record = {
        id: id,
        name: String(source.name || '첨부파일'),
        mimeType: String(source.mimeType || 'application/octet-stream'),
        size: Number(source.size || 0),
        data: String(source.data || ''),
        createdAt: nowIso()
      };
      await putDemoFile(record);
      added.push({ id: id, name: record.name, mimeType: record.mimeType, size: record.size });
    }
    await deleteDemoFiles(removed);
    return kept.concat(added);
  }

  function normalizeDemoState(state) {
    var changed = false;
    (state.classes || []).forEach(function (item, index) {
      if (item.displayOrder == null || item.displayOrder === '') {
        item.displayOrder = index + 1;
        changed = true;
      }
    });
    [
      { key: 'announcements', fallback: '수업 안내' },
      { key: 'assignments', fallback: '학습 활동' },
      { key: 'boards', fallback: '생각 나눔' }
    ].forEach(function (group) {
      (state[group.key] || []).forEach(function (item) {
        if (typeof item.category === 'undefined') {
          item.category = group.fallback;
          changed = true;
        }
        if (!Array.isArray(item.attachments)) {
          item.attachments = [];
          changed = true;
        }
      });
    });
    ['submissions', 'boardPosts'].forEach(function (key) {
      (state[key] || []).forEach(function (item) {
        if (!Array.isArray(item.attachments)) {
          item.attachments = [];
          changed = true;
        }
      });
    });
    return changed;
  }

  function createDemoState() {
    var classes = [];
    var students = [];
    var announcements = [];
    var assignments = [];
    var boards = [];
    var submissions = [];
    var boardPosts = [];
    var subjects = ['사회', '도덕', '사회', '도덕'];
    for (var c = 1; c <= 12; c += 1) {
      var classId = 'class_' + c;
      classes.push({
        id: classId,
        name: '1학년 ' + c + '반',
        subject: subjects[(c - 1) % subjects.length],
        code: 'LOVE' + String(c).padStart(2, '0'),
        school: c <= 6 ? '사랑중학교' : (c <= 9 ? '배움중학교' : '마음중학교'),
        studentCount: 30,
        displayOrder: c,
        createdAt: new Date(Date.now() - c * 86400000).toISOString()
      });
      for (var s = 1; s <= 30; s += 1) {
        students.push({
          id: classId + '_student_' + s,
          classId: classId,
          number: s,
          name: s % 5 === 0 ? '김학생' + s : '학생 ' + s,
          pin: String(1000 + ((c * 97 + s * 31) % 9000)),
          online: c === 1 && s <= 8,
          lastSeenAt: s <= 8 ? nowIso() : ''
        });
      }
      announcements.push({
        id: 'notice_' + c,
        classId: classId,
        title: c === 1 ? '이번 주 수업 준비물 안내' : '첫 수업 안내',
        body: c === 1 ? '교과서와 학습지, 필기구를 준비해 주세요.' : '우리 반 수업 공간입니다.',
        category: c % 2 ? '수업 안내' : '준비물',
        pinned: true,
        attachments: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      assignments.push({
        id: 'assignment_' + c,
        classId: classId,
        title: c === 1 ? '가족 갈등 해결 대화문' : '첫 번째 생각 기록',
        body: '수업에서 배운 내용을 바탕으로 작성해 제출하세요.',
        category: c % 2 ? '수행 평가' : '학습 활동',
        dueAt: new Date(Date.now() + (c + 2) * 86400000).toISOString(),
        status: 'open',
        attachments: [],
        submissionCount: c === 1 ? 18 : 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      boards.push({
        id: 'board_' + c,
        classId: classId,
        title: c === 1 ? '우리 반 생각 나눔 보드' : '첫 번째 보드',
        body: '친구의 생각을 존중하며 글과 자료를 나눠 보세요.',
        category: c % 2 ? '생각 나눔' : '수업 자료',
        status: 'open',
        attachments: [],
        postCount: c === 1 ? 5 : 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    for (var p = 1; p <= 5; p += 1) {
      boardPosts.push({
        id: 'post_' + p,
        boardId: 'board_1',
        classId: 'class_1',
        studentId: 'class_1_student_' + p,
        studentNumber: p,
        studentName: '학생 ' + p,
        text: p === 1 ? '서로의 말을 끝까지 듣는 것이 갈등 해결의 시작이라고 생각합니다.' : '내 생각을 솔직하게 말하되 상대방을 탓하지 않겠습니다.',
        attachments: [],
        status: p === 2 ? 'revision' : 'published',
        revisionMessage: p === 2 ? '수업에서 배운 나 전달법 문장을 한 문장 덧붙여 주세요.' : '',
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    return {
      classes: classes,
      students: students,
      announcements: announcements,
      assignments: assignments,
      boards: boards,
      submissions: submissions,
      boardPosts: boardPosts
    };
  }

  function getDemoState() {
    try {
      var saved = JSON.parse(localStorage.getItem(demoStorageKey) || 'null');
      if (saved && saved.classes) {
        if (normalizeDemoState(saved)) setDemoState(saved);
        return saved;
      }
    } catch (error) {}
    var state = createDemoState();
    localStorage.setItem(demoStorageKey, JSON.stringify(state));
    return state;
  }

  function setDemoState(state) {
    localStorage.setItem(demoStorageKey, JSON.stringify(state));
  }

  function demoClassData(state, classId, studentId) {
    var classInfo = state.classes.find(function (item) { return item.id === classId; });
    if (!classInfo) throw new ApiError('클래스를 찾을 수 없습니다.', 'NOT_FOUND');
    var classStudents = state.students
      .filter(function (item) { return item.classId === classId; })
      .sort(function (a, b) { return Number(a.number) - Number(b.number); });
    var classSubmissions = state.submissions.filter(function (item) { return item.classId === classId; });
    var classPosts = state.boardPosts.filter(function (item) { return item.classId === classId; });
    var assignmentItems = state.assignments.filter(function (item) { return item.classId === classId; }).map(function (item) {
      return Object.assign({}, item, {
        submissionCount: classSubmissions.filter(function (submission) {
          return submission.assignmentId === item.id;
        }).length
      });
    });
    var boardItems = state.boards.filter(function (item) { return item.classId === classId; }).map(function (item) {
      return Object.assign({}, item, {
        postCount: classPosts.filter(function (post) { return post.boardId === item.id; }).length
      });
    });
    return {
      classInfo: clone(classInfo),
      students: clone(classStudents),
      announcements: clone(state.announcements.filter(function (item) { return item.classId === classId; })),
      assignments: clone(assignmentItems),
      boards: clone(boardItems),
      submissions: clone(classSubmissions.filter(function (item) {
        return !studentId || item.studentId === studentId;
      })),
      boardPosts: clone(classPosts.map(function (item) {
        if (!studentId || item.studentId === studentId) return item;
        return Object.assign({}, item, { status: 'published', revisionMessage: '' });
      })),
      onlineStudents: clone(classStudents.filter(function (item) { return item.online; }))
    };
  }

  var DemoAPI = {
    request: async function (action, payload, role) {
      var state = getDemoState();
      var result;

      if (action === 'teacherLogin' || action === 'teacherSignup') {
        result = {
          token: 'demo_teacher_token',
          user: { id: 'teacher_demo', email: payload.email || 'teacher@example.com', name: '사랑 선생님' }
        };
        writeSession('teacher', result);
        return result;
      }

      if (action === 'studentLogin') {
        var matchedClass = state.classes.find(function (item) {
          return item.code.toLowerCase() === String(payload.classCode || '').toLowerCase();
        }) || state.classes[0];
        var matchedStudent = state.students.find(function (item) {
          return item.classId === matchedClass.id && Number(item.number) === Number(payload.number || 1);
        }) || state.students[0];
        result = {
          token: 'demo_student_' + matchedStudent.id,
          user: clone(matchedStudent),
          classInfo: clone(matchedClass)
        };
        writeSession('student', result);
        return result;
      }

      if (action === 'teacherDashboard') {
        return {
          teacher: { id: 'teacher_demo', email: 'teacher@example.com', name: '사랑 선생님' },
          classes: clone(state.classes.slice().sort(function (a, b) {
            return Number(a.displayOrder || 9999) - Number(b.displayOrder || 9999) ||
              String(a.createdAt).localeCompare(String(b.createdAt));
          })),
          totals: {
            classes: state.classes.length,
            students: state.students.length,
            assignments: state.assignments.length,
            boards: state.boards.length
          }
        };
      }

      if (action === 'createClass') {
        if (state.classes.some(function (item) {
          return item.code.toLowerCase() === String(payload.code).toLowerCase();
        })) throw new ApiError('이미 사용 중인 클래스 코드입니다.', 'DUPLICATE_CLASS_CODE');
        var newClass = {
          id: uid('class'),
          name: payload.name,
          subject: payload.subject || '',
          school: payload.school || '',
          code: String(payload.code || '').toUpperCase(),
          studentCount: 0,
          displayOrder: state.classes.reduce(function (max, item) {
            return Math.max(max, Number(item.displayOrder || 0));
          }, 0) + 1,
          createdAt: nowIso()
        };
        state.classes.push(newClass);
        setDemoState(state);
        return clone(newClass);
      }

      if (action === 'reorderClasses') {
        var requestedIds = Array.isArray(payload.classIds) ? payload.classIds.map(String) : [];
        var knownIds = state.classes.map(function (item) { return String(item.id); });
        var uniqueIds = Array.from(new Set(requestedIds));
        var validOrder = uniqueIds.length === knownIds.length && knownIds.every(function (id) {
          return uniqueIds.indexOf(id) >= 0;
        });
        if (!validOrder) throw new ApiError('클래스 순서를 다시 불러온 뒤 시도해 주세요.', 'INVALID_CLASS_ORDER');
        requestedIds.forEach(function (id, index) {
          var item = state.classes.find(function (entry) { return String(entry.id) === id; });
          item.displayOrder = index + 1;
        });
        setDemoState(state);
        return { classIds: requestedIds };
      }

      if (action === 'deleteClass') {
        var targetClass = state.classes.find(function (item) { return item.id === payload.classId; });
        if (!targetClass || targetClass.code !== String(payload.confirmCode || '').toUpperCase()) {
          throw new ApiError('클래스 코드가 일치하지 않습니다.', 'CLASS_CODE_MISMATCH');
        }
        var classFileIds = [];
        ['announcements', 'assignments', 'boards', 'submissions', 'boardPosts'].forEach(function (key) {
          classFileIds = classFileIds.concat(attachmentIds(state[key].filter(function (item) {
            return item.classId === payload.classId;
          })));
        });
        state.classes = state.classes.filter(function (item) { return item.id !== payload.classId; });
        ['students', 'announcements', 'assignments', 'boards', 'submissions', 'boardPosts'].forEach(function (key) {
          state[key] = state[key].filter(function (item) { return item.classId !== payload.classId; });
        });
        await deleteDemoFiles(classFileIds);
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'getTeacherClass') {
        return demoClassData(state, payload.classId);
      }

      if (action === 'getStudentClass') {
        var studentSession = readSession('student');
        if (!studentSession) throw new ApiError('학생 로그인이 필요합니다.', 'UNAUTHORIZED');
        return demoClassData(state, studentSession.classInfo.id, studentSession.user.id);
      }

      if (action === 'upsertContent') {
        var tableMap = { announcement: 'announcements', assignment: 'assignments', board: 'boards' };
        var table = tableMap[payload.type];
        if (!table) throw new ApiError('잘못된 자료 유형입니다.', 'INVALID_TYPE');
        var existing = state[table].find(function (item) { return item.id === payload.id; });
        if (existing) {
          existing.attachments = await replaceDemoAttachments(
            existing.attachments,
            payload.keepAttachmentIds,
            payload.files
          );
          Object.assign(existing, payload.data, { updatedAt: nowIso() });
          result = existing;
        } else {
          result = Object.assign({
            id: uid(payload.type),
            classId: payload.classId,
            attachments: await replaceDemoAttachments([], [], payload.files),
            createdAt: nowIso(),
            updatedAt: nowIso()
          }, payload.data);
          state[table].unshift(result);
        }
        setDemoState(state);
        return clone(result);
      }

      if (action === 'deleteContent') {
        var deleteMap = { announcement: 'announcements', assignment: 'assignments', board: 'boards' };
        var deleteTable = deleteMap[payload.type];
        if (!deleteTable) throw new ApiError('잘못된 자료 유형입니다.', 'INVALID_TYPE');
        var deleteTarget = state[deleteTable].find(function (item) { return item.id === payload.id; });
        var relatedItems = deleteTarget ? [deleteTarget] : [];
        if (payload.type === 'assignment') {
          var relatedSubmissions = state.submissions.filter(function (item) { return item.assignmentId === payload.id; });
          relatedItems = relatedItems.concat(relatedSubmissions);
          state.submissions = state.submissions.filter(function (item) { return item.assignmentId !== payload.id; });
        }
        if (payload.type === 'board') {
          var relatedPosts = state.boardPosts.filter(function (item) { return item.boardId === payload.id; });
          relatedItems = relatedItems.concat(relatedPosts);
          state.boardPosts = state.boardPosts.filter(function (item) { return item.boardId !== payload.id; });
        }
        state[deleteTable] = state[deleteTable].filter(function (item) { return item.id !== payload.id; });
        await deleteDemoFiles(attachmentIds(relatedItems));
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'addStudents') {
        var start = Number(payload.startNumber || 1);
        var count = Number(payload.count || 30);
        var names = payload.names || [];
        var created = [];
        for (var n = 0; n < count; n += 1) {
          var number = start + n;
          if (state.students.some(function (item) {
            return item.classId === payload.classId && Number(item.number) === number;
          })) continue;
          var student = {
            id: uid('student'),
            classId: payload.classId,
            number: number,
            name: names[n] || '학생 ' + number,
            pin: String(Math.floor(1000 + Math.random() * 9000)),
            online: false,
            lastSeenAt: ''
          };
          state.students.push(student);
          created.push(student);
        }
        var classRow = state.classes.find(function (item) { return item.id === payload.classId; });
        if (classRow) {
          classRow.studentCount = state.students.filter(function (item) { return item.classId === payload.classId; }).length;
        }
        setDemoState(state);
        return { students: clone(created) };
      }

      if (action === 'reissueClassPins') {
        var classStudentsForPins = state.students.filter(function (item) {
          return item.classId === payload.classId;
        }).sort(function (a, b) { return Number(a.number) - Number(b.number); });
        if (!classStudentsForPins.length) throw new ApiError('먼저 학생을 등록해 주세요.', 'NO_STUDENTS');
        classStudentsForPins.forEach(function (student) {
          student.pin = String(Math.floor(1000 + Math.random() * 9000));
        });
        var activeStudent = readSession('student');
        if (activeStudent && activeStudent.classInfo && activeStudent.classInfo.id === payload.classId) {
          writeSession('student', null);
        }
        setDemoState(state);
        return { students: clone(classStudentsForPins) };
      }

      if (action === 'resetStudentPin') {
        var resetStudent = state.students.find(function (item) { return item.id === payload.studentId; });
        if (!resetStudent) throw new ApiError('학생을 찾을 수 없습니다.', 'NOT_FOUND');
        resetStudent.pin = String(Math.floor(1000 + Math.random() * 9000));
        setDemoState(state);
        return { studentId: resetStudent.id, pin: resetStudent.pin };
      }

      if (action === 'deleteStudent') {
        var studentSubmissions = state.submissions.filter(function (item) { return item.studentId === payload.studentId; });
        var studentPosts = state.boardPosts.filter(function (item) { return item.studentId === payload.studentId; });
        state.students = state.students.filter(function (item) { return item.id !== payload.studentId; });
        state.submissions = state.submissions.filter(function (item) { return item.studentId !== payload.studentId; });
        state.boardPosts = state.boardPosts.filter(function (item) { return item.studentId !== payload.studentId; });
        await deleteDemoFiles(attachmentIds(studentSubmissions.concat(studentPosts)));
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'upsertSubmission') {
        var ss = readSession('student');
        if (!ss) throw new ApiError('학생 로그인이 필요합니다.', 'UNAUTHORIZED');
        if (!String(payload.text || '').trim() && !(payload.files || []).length && !(payload.keepAttachmentIds || []).length) {
          throw new ApiError('내용이나 파일을 하나 이상 제출해 주세요.', 'EMPTY_SUBMISSION');
        }
        var submission = state.submissions.find(function (item) {
          return item.assignmentId === payload.assignmentId && item.studentId === ss.user.id;
        });
        if (submission) {
          submission.text = payload.text || '';
          submission.attachments = await replaceDemoAttachments(
            submission.attachments,
            payload.keepAttachmentIds,
            payload.files
          );
          if (!submission.text && !submission.attachments.length) {
            throw new ApiError('내용이나 파일을 하나 이상 제출해 주세요.', 'EMPTY_SUBMISSION');
          }
          submission.updatedAt = nowIso();
        } else {
          var submissionFiles = await replaceDemoAttachments([], [], payload.files);
          if (!String(payload.text || '').trim() && !submissionFiles.length) {
            throw new ApiError('내용이나 파일을 하나 이상 제출해 주세요.', 'EMPTY_SUBMISSION');
          }
          submission = {
            id: uid('submission'),
            assignmentId: payload.assignmentId,
            classId: ss.classInfo.id,
            studentId: ss.user.id,
            studentNumber: ss.user.number,
            studentName: ss.user.name,
            text: payload.text || '',
            attachments: submissionFiles,
            submittedAt: nowIso(),
            updatedAt: nowIso()
          };
          state.submissions.push(submission);
        }
        setDemoState(state);
        return clone(submission);
      }

      if (action === 'deleteSubmission') {
        var ds = readSession('student');
        if (!ds) throw new ApiError('학생 로그인이 필요합니다.', 'UNAUTHORIZED');
        var deletedSubmissions = state.submissions.filter(function (item) {
          return item.assignmentId === payload.assignmentId && item.studentId === ds.user.id;
        });
        state.submissions = state.submissions.filter(function (item) {
          return !(item.assignmentId === payload.assignmentId && item.studentId === ds.user.id);
        });
        await deleteDemoFiles(attachmentIds(deletedSubmissions));
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'upsertBoardPost') {
        var bs = readSession('student');
        if (!bs) throw new ApiError('학생 로그인이 필요합니다.', 'UNAUTHORIZED');
        if (!String(payload.text || '').trim() && !(payload.files || []).length && !(payload.keepAttachmentIds || []).length) {
          throw new ApiError('내용이나 파일을 하나 이상 게시해 주세요.', 'EMPTY_POST');
        }
        var post = state.boardPosts.find(function (item) {
          return item.boardId === payload.boardId && item.studentId === bs.user.id;
        });
        if (post) {
          post.text = payload.text || '';
          post.attachments = await replaceDemoAttachments(
            post.attachments,
            payload.keepAttachmentIds,
            payload.files
          );
          if (!post.text && !post.attachments.length) {
            throw new ApiError('내용이나 파일을 하나 이상 게시해 주세요.', 'EMPTY_POST');
          }
          post.status = 'published';
          post.revisionMessage = '';
          post.updatedAt = nowIso();
        } else {
          var postFiles = await replaceDemoAttachments([], [], payload.files);
          if (!String(payload.text || '').trim() && !postFiles.length) {
            throw new ApiError('내용이나 파일을 하나 이상 게시해 주세요.', 'EMPTY_POST');
          }
          post = {
            id: uid('post'),
            boardId: payload.boardId,
            classId: bs.classInfo.id,
            studentId: bs.user.id,
            studentNumber: bs.user.number,
            studentName: bs.user.name,
            text: payload.text || '',
            attachments: postFiles,
            status: 'published',
            revisionMessage: '',
            createdAt: nowIso(),
            updatedAt: nowIso()
          };
          state.boardPosts.push(post);
        }
        setDemoState(state);
        return clone(post);
      }

      if (action === 'deleteBoardPost') {
        var deletedPosts = state.boardPosts.filter(function (item) { return item.id === payload.postId; });
        state.boardPosts = state.boardPosts.filter(function (item) { return item.id !== payload.postId; });
        await deleteDemoFiles(attachmentIds(deletedPosts));
        setDemoState(state);
        return { deleted: true };
      }

      if (action === 'reviewBoardPost') {
        var reviewed = state.boardPosts.find(function (item) { return item.id === payload.postId; });
        if (!reviewed) throw new ApiError('게시물을 찾을 수 없습니다.', 'NOT_FOUND');
        var reviewDecision = String(payload.decision || (payload.message ? 'revision' : 'published'));
        if (['revision', 'confirmed', 'published'].indexOf(reviewDecision) < 0) {
          throw new ApiError('게시글 확인 상태가 올바르지 않습니다.', 'INVALID_REVIEW');
        }
        reviewed.status = reviewDecision;
        reviewed.revisionMessage = '';
        reviewed.updatedAt = nowIso();
        setDemoState(state);
        return clone(reviewed);
      }

      if (action === 'createDownloadBundle') {
        var sample = btoa(unescape(encodeURIComponent('미리보기 모드의 일괄 다운로드 예시 파일입니다.')));
        return {
          parts: [{
            name: (payload.title || '과제') + '_전체.zip',
            downloadUrl: 'data:text/plain;base64,' + sample
          }],
          fileCount: 0,
          demo: true
        };
      }

      if (action === 'getFileContent') {
        var demoFile = await getDemoFile(payload.fileId);
        return {
          id: String(demoFile.id),
          name: String(demoFile.name),
          mimeType: String(demoFile.mimeType),
          size: Number(demoFile.size || 0),
          data: String(demoFile.data || '')
        };
      }

      if (action === 'prepareFileAccess') {
        var preparedFile = await getDemoFile(payload.fileId);
        return {
          id: String(preparedFile.id),
          name: String(preparedFile.name),
          mimeType: String(preparedFile.mimeType),
          size: Number(preparedFile.size || 0),
          data: String(preparedFile.data || ''),
          previewUnsupported: /\.(doc|docx|ppt|pptx|xls|xlsx)$/i.test(String(preparedFile.name || ''))
        };
      }

      if (action === 'heartbeat') {
        return { onlineStudents: [] };
      }

      throw new ApiError('미리보기 모드에서 지원하지 않는 요청입니다: ' + action, 'DEMO_NOT_IMPLEMENTED');
    }
  };

  window.LearnAPI = new AppAPI();
  window.LearnFiles = {
    toPayload: filesToPayload,
    saveBase64: saveBase64File,
    openBundleParts: openBundleParts
  };
  window.LearnSession = {
    get: readSession,
    set: writeSession,
    clear: function (role) { writeSession(role, null); }
  };
  window.LearnApiError = ApiError;
})();
