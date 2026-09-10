(function () {
  'use strict';

  var UI = window.LearnUI;
  var API = window.LearnAPI;
  var classData = null;
  var presenceTimer = null;
  var classSortStorageKey = 'learn_teacher_class_sort_v1';
  var teacherPostFilters = { type: 'all', category: 'all' };

  function classSortMode() {
    try {
      var value = localStorage.getItem(classSortStorageKey);
      return ['school', 'subject', 'custom'].indexOf(value) >= 0 ? value : 'custom';
    } catch (error) {
      return 'custom';
    }
  }

  function saveClassSortMode(value) {
    try { localStorage.setItem(classSortStorageKey, value); } catch (error) {}
  }

  function sessionOrLogin() {
    var session = window.LearnSession.get('teacher');
    if (!session || !session.token) {
      location.hash = '#/teacher/login';
      return null;
    }
    return session;
  }

  function loading(container, message) {
    container.innerHTML = '<section class="loading-screen"><div class="loader"></div><p>' +
      UI.escape(message || '자료를 불러오고 있어요.') + '</p></section>';
  }

  function errorScreen(container, error, retry) {
    container.innerHTML = '<section class="page"><div class="panel empty-state">' +
      '<div class="empty-graphic">!</div><h3>자료를 불러오지 못했어요</h3>' +
      '<p>' + UI.escape(error.message || '잠시 후 다시 시도해 주세요.') + '</p>' +
      '<button class="button" type="button" data-retry>다시 시도</button></div></section>';
    container.querySelector('[data-retry]').addEventListener('click', retry);
  }

  async function renderDashboard(container) {
    if (!sessionOrLogin()) return;
    stopPresence();
    loading(container, '클래스 목록을 불러오고 있어요.');
    try {
      var data = await API.request('teacherDashboard', {}, 'teacher');
      var sortMode = classSortMode();
      container.innerHTML =
        '<section class="app-page">' +
          '<div class="dashboard-head">' +
            '<div class="section-title"><p class="section-kicker">Teacher studio</p>' +
              '<h1>' + UI.escape((data.teacher.name || '선생님') + '의 클래스') + '</h1>' +
              '<p>클래스를 열어 공지, 과제, 보드와 학생을 관리하세요.</p></div>' +
            '<div class="dashboard-tools">' +
              '<button class="button secondary" type="button" data-logout>로그아웃</button>' +
              '<button class="button" type="button" data-create-class>＋ 클래스 만들기</button>' +
            '</div>' +
          '</div>' +
          '<div class="summary-strip" aria-label="전체 현황">' +
            summaryCell('클래스', data.totals.classes) +
            summaryCell('등록 학생', data.totals.students) +
            summaryCell('진행 과제', data.totals.assignments) +
            summaryCell('열린 보드', data.totals.boards) +
          '</div>' +
          (data.classes.length
            ? classSortToolbar(sortMode) + renderClassCollection(data.classes, sortMode)
            : '<div class="panel">' + UI.empty('첫 클래스를 만들어 보세요', '클래스 코드와 이름을 정하면 바로 학생을 등록할 수 있어요.', '<button class="button" type="button" data-create-class>클래스 만들기</button>') + '</div>') +
        '</section>';
      container.querySelectorAll('[data-create-class]').forEach(function (button) {
        button.addEventListener('click', function () { openClassEditor(container); });
      });
      container.querySelector('[data-logout]').addEventListener('click', function () {
        window.LearnSession.clear('teacher');
        if (window.LearnNavigation) window.LearnNavigation.clear('teacher');
        location.hash = '#/teacher/login';
      });
      container.querySelectorAll('[data-open-class]').forEach(function (card) {
        card.addEventListener('click', function (event) {
          if (event.target.closest('[data-class-action]')) return;
          location.hash = '#/teacher/class/' + card.dataset.openClass + '/announcements';
        });
        card.addEventListener('keydown', function (event) {
          if (event.target === card && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            location.hash = '#/teacher/class/' + card.dataset.openClass + '/announcements';
          }
        });
      });
      container.querySelectorAll('[data-delete-class]').forEach(function (button) {
        button.addEventListener('click', function (event) {
          event.stopPropagation();
          deleteClass(button.dataset.deleteClass, button.dataset.className, button.dataset.classCode, container);
        });
      });
      container.querySelectorAll('[data-class-sort]').forEach(function (button) {
        button.addEventListener('click', function () {
          saveClassSortMode(button.dataset.classSort);
          renderDashboard(container);
        });
      });
      container.querySelectorAll('[data-class-move]').forEach(function (button) {
        button.addEventListener('click', function (event) {
          event.stopPropagation();
          moveClass(button, data.classes, container);
        });
      });
    } catch (error) {
      if (error.code === 'UNAUTHORIZED' || error.code === 'SESSION_EXPIRED') return;
      errorScreen(container, error, function () { renderDashboard(container); });
    }
  }

  function summaryCell(label, number) {
    return '<div class="summary-cell"><span>' + UI.escape(label) + '</span><strong>' +
      UI.escape(number || 0) + '</strong></div>';
  }

  function classSortToolbar(active) {
    return '<section class="class-sort-panel" aria-labelledby="class-sort-title">' +
      '<div><h2 id="class-sort-title">클래스 정렬</h2><p>' +
        (active === 'custom' ? '화살표로 선생님이 원하는 순서를 정할 수 있어요.' : '같은 항목끼리 모아 이름순으로 보여 줍니다.') +
      '</p></div>' +
      '<div class="sort-choice" role="group" aria-label="클래스 정렬 방법">' +
        sortChoice('school', '학교별', active) +
        sortChoice('subject', '과목별', active) +
        sortChoice('custom', '내 순서', active) +
      '</div></section>';
  }

  function sortChoice(value, label, active) {
    return '<button class="sort-choice-button ' + (value === active ? 'active' : '') + '" type="button" data-class-sort="' +
      value + '" aria-pressed="' + (value === active ? 'true' : 'false') + '">' + UI.escape(label) + '</button>';
  }

  function compareClassNames(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), 'ko') ||
      String(a.code || '').localeCompare(String(b.code || ''), 'ko');
  }

  function classesInCustomOrder(classes) {
    return classes.slice().sort(function (a, b) {
      return Number(a.displayOrder || 9999) - Number(b.displayOrder || 9999) ||
        String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  }

  function renderClassCollection(classes, mode) {
    if (mode === 'custom') {
      var custom = classesInCustomOrder(classes);
      return '<div class="class-grid">' + custom.map(function (item, index) {
        return classCard(item, index, custom.length, true);
      }).join('') + '</div>';
    }
    var field = mode === 'school' ? 'school' : 'subject';
    var emptyLabel = mode === 'school' ? '학교 미입력' : '과목 미입력';
    var grouped = {};
    classes.forEach(function (item) {
      var key = String(item[field] || '').trim() || emptyLabel;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(item);
    });
    return '<div class="class-groups">' + Object.keys(grouped).sort(function (a, b) {
      if (a === emptyLabel) return 1;
      if (b === emptyLabel) return -1;
      return a.localeCompare(b, 'ko');
    }).map(function (label) {
      var items = grouped[label].slice().sort(compareClassNames);
      return '<section class="class-group"><div class="class-group-head"><h2>' + UI.escape(label) + '</h2>' +
        '<span>' + items.length + '개 클래스</span></div><div class="class-grid">' +
        items.map(function (item) { return classCard(item, 0, 0, false); }).join('') + '</div></section>';
    }).join('') + '</div>';
  }

  function classCard(item, index, total, customOrder) {
    var orderControls = customOrder
      ? '<div class="class-order-controls" data-class-action role="group" aria-label="' + UI.attr(item.name) + ' 순서 바꾸기">' +
          '<button type="button" data-class-move="up" data-class-id="' + UI.attr(item.id) + '" aria-label="위로 이동" ' + (index === 0 ? 'disabled' : '') + '>↑</button>' +
          '<button type="button" data-class-move="down" data-class-id="' + UI.attr(item.id) + '" aria-label="아래로 이동" ' + (index === total - 1 ? 'disabled' : '') + '>↓</button>' +
        '</div>'
      : '';
    return '<article class="class-card" tabindex="0" role="link" data-open-class="' + UI.attr(item.id) + '">' +
      '<div class="class-card-top"><span class="class-code">' + UI.escape(item.code) + '</span>' + orderControls + '</div>' +
      '<h2>' + UI.escape(item.name) + '</h2>' +
      '<p>' + UI.escape([item.school, item.subject].filter(Boolean).join(' · ') || '수업 정보 없음') + '</p>' +
      '<div class="class-meta"><span>학생 ' + UI.escape(item.studentCount || 0) + '명</span>' +
        '<button class="text-link" type="button" data-delete-class="' + UI.attr(item.id) +
          '" data-class-action data-class-name="' + UI.attr(item.name) + '" data-class-code="' + UI.attr(item.code) + '">삭제</button></div>' +
    '</article>';
  }

  async function moveClass(button, classes, container) {
    var ordered = classesInCustomOrder(classes);
    var index = ordered.findIndex(function (item) { return item.id === button.dataset.classId; });
    var nextIndex = button.dataset.classMove === 'up' ? index - 1 : index + 1;
    if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return;
    var moved = ordered[index];
    ordered[index] = ordered[nextIndex];
    ordered[nextIndex] = moved;
    UI.busy(button, true, '…');
    try {
      await API.request('reorderClasses', {
        classIds: ordered.map(function (item) { return item.id; })
      }, 'teacher');
      renderDashboard(container);
    } catch (error) {
      UI.toast(error.message, 'error');
      UI.busy(button, false);
    }
  }

  function openClassEditor(container) {
    var dialog = UI.modal({
      title: '새 클래스 만들기',
      html:
        '<form class="form-stack" data-class-form>' +
          '<div class="form-row">' +
            '<div class="field"><label for="class-name">클래스 이름</label><input id="class-name" name="name" placeholder="예: 1학년 1반" required maxlength="40"></div>' +
            '<div class="field"><label for="class-subject">과목</label><input id="class-subject" name="subject" placeholder="예: 도덕" maxlength="30"></div>' +
          '</div>' +
          '<div class="field"><label for="class-school">학교명</label><input id="class-school" name="school" placeholder="예: 사랑중학교" maxlength="50"></div>' +
          '<div class="field"><label for="class-code">클래스 코드</label><input id="class-code" name="code" placeholder="예: LOVE101" required minlength="4" maxlength="16" pattern="[A-Za-z0-9_-]+">' +
            '<span class="field-help">영문, 숫자, 밑줄(_), 하이픈(-)만 사용할 수 있어요. 학생 로그인과 클래스 삭제에 사용됩니다.</span></div>' +
          '<div class="modal-actions"><button class="button secondary" type="button" data-close-modal>취소</button>' +
            '<button class="button" type="submit">클래스 만들기</button></div>' +
        '</form>'
    });
    dialog.querySelector('[data-close-modal]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-class-form]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var submit = form.querySelector('[type="submit"]');
      var formData = new FormData(form);
      UI.busy(submit, true, '만드는 중…');
      try {
        await API.request('createClass', {
          name: String(formData.get('name') || '').trim(),
          subject: String(formData.get('subject') || '').trim(),
          school: String(formData.get('school') || '').trim(),
          code: String(formData.get('code') || '').trim().toUpperCase()
        }, 'teacher');
        UI.closeModal();
        UI.toast('클래스를 만들었습니다.');
        renderDashboard(container);
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(submit, false);
      }
    });
  }

  async function deleteClass(classId, className, classCode, container) {
    var typed = await UI.confirm({
      title: className + ' 삭제',
      message: '클래스의 공지, 과제, 보드, 학생 자료가 함께 삭제됩니다. 삭제하려면 클래스 코드를 입력하세요.',
      inputLabel: '클래스 코드 (' + classCode + ')',
      confirmText: '클래스 삭제',
      danger: true
    });
    if (typed == null) return;
    try {
      await API.request('deleteClass', { classId: classId, confirmCode: String(typed).trim().toUpperCase() }, 'teacher');
      UI.toast('클래스를 삭제했습니다.');
      renderDashboard(container);
    } catch (error) {
      UI.toast(error.message, 'error');
    }
  }

  async function renderClass(container, classId, tab) {
    if (!sessionOrLogin()) return;
    stopPresence();
    var safeTab = ['posts', 'announcements', 'assignments', 'boards', 'students'].indexOf(tab) >= 0 ? tab : 'announcements';
    loading(container, '클래스 자료를 불러오고 있어요.');
    try {
      classData = await API.request('getTeacherClass', { classId: classId }, 'teacher');
      paintClass(container, classId, safeTab);
      startPresence(classId);
    } catch (error) {
      errorScreen(container, error, function () { renderClass(container, classId, safeTab); });
    }
  }

  function paintClass(container, classId, tab) {
    var counts = {
      posts: classData.announcements.length + classData.assignments.length + classData.boards.length,
      announcements: classData.announcements.length,
      assignments: classData.assignments.length,
      boards: classData.boards.length,
      students: classData.students.length
    };
    container.innerHTML =
      '<section class="app-page">' +
        '<div class="workspace-layout">' +
          '<div class="workspace-main">' +
            '<header class="workspace-head">' +
              '<div class="workspace-title-wrap">' +
                '<button class="back-button" type="button" data-back-dashboard aria-label="클래스 목록으로">←</button>' +
                '<div><h1>' + UI.escape(classData.classInfo.name) + '</h1>' +
                  '<p>' + UI.escape([classData.classInfo.school, classData.classInfo.subject].filter(Boolean).join(' · ')) +
                  ' · 클래스 코드 <strong>' + UI.escape(classData.classInfo.code) + '</strong></p></div>' +
              '</div>' +
              '<div class="inline-actions"><button class="button secondary small" type="button" data-share-student-link>학생 링크 공유</button>' +
                '<button class="button secondary small" type="button" data-copy-code>코드 복사</button>' +
                '<button class="button small" type="button" data-refresh>새로고침</button></div>' +
            '</header>' +
            '<nav class="tab-bar" aria-label="클래스 관리 메뉴">' +
              tabButton(classId, 'posts', '글 목록', counts.posts, tab) +
              tabButton(classId, 'announcements', '공지', counts.announcements, tab) +
              tabButton(classId, 'assignments', '과제', counts.assignments, tab) +
              tabButton(classId, 'boards', '보드', counts.boards, tab) +
              tabButton(classId, 'students', '학생 관리', counts.students, tab) +
            '</nav>' +
            '<section class="panel content-panel">' + renderTab(tab, classId) + '</section>' +
          '</div>' +
          renderPresence(classData.onlineStudents || []) +
        '</div>' +
      '</section>';
    container.querySelector('[data-back-dashboard]').addEventListener('click', function () {
      location.hash = '#/teacher';
    });
    container.querySelector('[data-copy-code]').addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(classData.classInfo.code);
        UI.toast('클래스 코드를 복사했습니다.');
      } catch (error) {
        UI.toast('코드: ' + classData.classInfo.code);
      }
    });
    container.querySelector('[data-share-student-link]').addEventListener('click', function () {
      shareStudentLink(classData.classInfo);
    });
    container.querySelector('[data-refresh]').addEventListener('click', function () {
      renderClass(container, classId, tab);
    });
    bindTabActions(container, classId, tab);
    UI.bindFiles(container, 'teacher');
  }

  function tabButton(classId, key, label, count, active) {
    return '<a class="tab-button ' + (key === active ? 'active' : '') + '" href="#/teacher/class/' +
      UI.attr(classId) + '/' + key + '">' + UI.escape(label) +
      '<span class="tab-count">' + UI.escape(count) + '</span></a>';
  }

  function renderPresence(students) {
    return '<aside class="panel presence-panel" aria-label="접속 중인 학생">' +
      '<div class="presence-head"><h2>접속 중</h2><span class="online-count" data-online-count>' +
        UI.escape(students.length) + '명</span></div>' +
      '<div class="presence-list" data-presence-list>' + presenceRows(students) + '</div>' +
    '</aside>';
  }

  function presenceRows(students) {
    if (!students.length) return '<p style="color:var(--muted);font-size:.82rem">현재 접속 중인 학생이 없어요.</p>';
    return students.map(function (student) {
      return '<div class="presence-person"><span class="presence-avatar">' + UI.escape(student.number) + '</span>' +
        '<span>' + UI.escape(student.name) + '</span><span class="presence-dot" aria-label="접속 중"></span></div>';
    }).join('');
  }

  function renderTab(tab, classId) {
    if (tab === 'posts') return renderTeacherPostIndex(classId);
    if (tab === 'assignments') return renderContentList('assignment', classData.assignments, classId);
    if (tab === 'boards') return renderContentList('board', classData.boards, classId);
    if (tab === 'students') return renderStudents(classId);
    return renderContentList('announcement', classData.announcements, classId);
  }

  function typeInfo(type) {
    return {
      announcement: { plural: '공지', create: '새 공지', empty: '아직 등록된 공지가 없어요', hint: '학생에게 알려 줄 내용을 작성해 보세요.' },
      assignment: { plural: '과제', create: '새 과제', empty: '아직 등록된 과제가 없어요', hint: '제출 기한과 안내를 정해 과제를 등록해 보세요.' },
      board: { plural: '보드', create: '새 보드', empty: '아직 등록된 보드가 없어요', hint: '학생들이 서로의 생각을 나눌 공간을 만들어 보세요.' }
    }[type];
  }

  function contentCategory(item) {
    return String(item && item.category || '').trim() || '미분류';
  }

  function categoryBadge(item) {
    return '<span class="category-badge"># ' + UI.escape(contentCategory(item)) + '</span>';
  }

  function teacherContentEntries() {
    var entries = [];
    [
      { type: 'announcement', items: classData.announcements },
      { type: 'assignment', items: classData.assignments },
      { type: 'board', items: classData.boards }
    ].forEach(function (group) {
      group.items.forEach(function (item) { entries.push({ type: group.type, item: item }); });
    });
    return entries.sort(function (a, b) {
      return String(b.item.updatedAt || b.item.createdAt || '').localeCompare(
        String(a.item.updatedAt || a.item.createdAt || '')
      );
    });
  }

  function filterOption(value, label, current) {
    return '<option value="' + UI.attr(value) + '" ' + (value === current ? 'selected' : '') + '>' +
      UI.escape(label) + '</option>';
  }

  function renderTeacherPostIndex() {
    var entries = teacherContentEntries();
    var categories = Array.from(new Set(entries.map(function (entry) {
      return contentCategory(entry.item);
    }))).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    if (teacherPostFilters.category !== 'all' && categories.indexOf(teacherPostFilters.category) < 0) {
      teacherPostFilters.category = 'all';
    }
    var filtered = entries.filter(function (entry) {
      var typeMatch = teacherPostFilters.type === 'all' || entry.type === teacherPostFilters.type;
      var categoryMatch = teacherPostFilters.category === 'all' || contentCategory(entry.item) === teacherPostFilters.category;
      return typeMatch && categoryMatch;
    });
    var typeOptions = filterOption('all', '전체 글', teacherPostFilters.type) +
      filterOption('announcement', '공지', teacherPostFilters.type) +
      filterOption('assignment', '과제', teacherPostFilters.type) +
      filterOption('board', '보드', teacherPostFilters.type);
    var categoryOptions = filterOption('all', '전체 카테고리', teacherPostFilters.category) +
      categories.map(function (category) { return filterOption(category, category, teacherPostFilters.category); }).join('');
    var head = '<div class="content-head"><div><h2>글 목록</h2><p>공지·과제·보드를 블로그처럼 한곳에서 찾아보세요.</p></div>' +
      '<span class="post-result-count">' + filtered.length + '개</span></div>' +
      '<div class="post-filter-bar"><label><span>글 종류</span><select data-post-type-filter>' + typeOptions + '</select></label>' +
        '<label><span>카테고리</span><select data-post-category-filter>' + categoryOptions + '</select></label></div>';
    if (!filtered.length) return head + UI.empty('조건에 맞는 글이 없어요', '다른 글 종류나 카테고리를 선택해 보세요.');
    return head + '<div class="blog-list">' + filtered.map(teacherPostIndexCard).join('') + '</div>';
  }

  function teacherPostIndexCard(entry) {
    var item = entry.item;
    var info = typeInfo(entry.type);
    var excerpt = String(item.body || '').trim() || ((item.attachments || []).length ? '첨부파일이 있는 글입니다.' : '작성된 내용이 없어요.');
    return '<article class="blog-row content-clickable" tabindex="0" data-view-content="' + UI.attr(entry.type) +
      '" data-content-id="' + UI.attr(item.id) + '" aria-label="' + UI.attr(item.title + ' 상세 보기') + '">' +
      '<div class="blog-row-labels"><span class="content-type-badge ' + UI.attr(entry.type) + '">' + UI.escape(info.plural) + '</span>' +
        categoryBadge(item) + '</div>' +
      '<div class="blog-row-main"><h3>' + UI.escape(item.title) + '</h3><p>' + UI.escape(excerpt) + '</p></div>' +
      '<div class="blog-row-meta"><span>' + UI.escape(UI.date(item.updatedAt || item.createdAt, true)) + '</span>' +
        ((item.attachments || []).length ? '<span>첨부 ' + item.attachments.length + '개</span>' : '') + '<b aria-hidden="true">›</b></div>' +
    '</article>';
  }

  function renderContentList(type, items, classId) {
    var info = typeInfo(type);
    var head =
      '<div class="content-head"><div><h2>' + info.plural + ' 관리</h2><p>' + info.hint + '</p></div>' +
        '<button class="button" type="button" data-create-content="' + type + '">＋ ' + info.create + '</button></div>';
    if (!items.length) {
      return head + UI.empty(info.empty, info.hint, '<button class="button secondary" type="button" data-create-content="' + type + '">등록하기</button>');
    }
    return head + '<div class="item-list">' + items.map(function (item) {
      return contentCard(type, item, classId);
    }).join('') + '</div>';
  }

  function contentCard(type, item) {
    var badge = '';
    var meta = [];
    if (type === 'announcement') {
      if (item.pinned) badge = '<span class="status-badge">상단 고정</span>';
      meta.push('수정 ' + UI.date(item.updatedAt, true));
    }
    if (type === 'assignment') {
      badge = '<span class="status-badge ' + (item.status === 'open' ? 'open' : '') + '">' +
        (item.status === 'open' ? '제출 가능' : '마감') + '</span>';
      if (item.dueAt) meta.push('마감 ' + UI.date(item.dueAt, true));
      meta.push('제출 ' + (item.submissionCount || 0) + '/' + classData.students.length + '명');
    }
    if (type === 'board') {
      badge = '<span class="status-badge ' + (item.status === 'open' ? 'open' : '') + '">' +
        (item.status === 'open' ? '작성 가능' : '읽기 전용') + '</span>';
      meta.push('게시 ' + (item.postCount || 0) + '/' + classData.students.length + '명');
    }
    return '<article class="item-card content-clickable ' + (item.pinned ? 'pinned' : '') + '" tabindex="0" ' +
      'data-view-content="' + UI.attr(type) + '" data-content-id="' + UI.attr(item.id) + '" ' +
      'aria-label="' + UI.attr(item.title + ' 상세 보기') + '">' +
      '<div class="item-top"><div><h3>' + UI.escape(item.title) + '</h3>' +
        '<div class="meta-line">' + categoryBadge(item) + badge + meta.map(function (text) { return '<span>' + UI.escape(text) + '</span>'; }).join('') + '</div></div>' +
        '<div class="card-actions">' +
          (type === 'assignment' ? '<button class="button ghost small" type="button" data-view-submissions="' + UI.attr(item.id) + '">제출 보기</button>' : '') +
          (type === 'board' ? '<button class="button ghost small" type="button" data-open-board="' + UI.attr(item.id) + '">보드 보기</button>' : '') +
          '<button class="button ghost small" type="button" data-edit-content="' + type + '" data-content-id="' + UI.attr(item.id) + '">수정</button>' +
          '<button class="text-link" type="button" data-delete-content="' + type + '" data-content-id="' + UI.attr(item.id) + '">삭제</button>' +
        '</div></div>' +
      (item.body ? '<p class="item-body">' + UI.escape(item.body) + '</p>' : '') +
      UI.attachments(item.attachments, 'teacher') +
    '</article>';
  }

  function contentListFor(type) {
    if (type === 'announcement') return classData.announcements;
    if (type === 'assignment') return classData.assignments;
    return classData.boards;
  }

  function openTeacherContentDetail(type, item, classId, container, tab) {
    var info = typeInfo(type);
    var meta = [];
    var badge = '';
    if (type === 'announcement') {
      badge = item.pinned ? '<span class="status-badge">중요 공지</span>' : '';
      meta.push('수정 ' + UI.date(item.updatedAt, true));
    }
    if (type === 'assignment') {
      badge = '<span class="status-badge ' + (item.status === 'open' ? 'open' : '') + '">' +
        (item.status === 'open' ? '제출 가능' : '마감') + '</span>';
      if (item.dueAt) meta.push('마감 ' + UI.date(item.dueAt, true));
      meta.push('제출 ' + (item.submissionCount || 0) + '/' + classData.students.length + '명');
    }
    var dialog = UI.modal({
      title: item.title,
      wide: true,
      html:
        '<div class="detail-meta">' + categoryBadge(item) + badge + meta.map(function (text) {
          return '<span>' + UI.escape(text) + '</span>';
        }).join('') + '</div>' +
        '<div class="detail-body">' + (item.body ? UI.nl2br(item.body) : '<span class="muted-text">작성된 내용이 없어요.</span>') + '</div>' +
        UI.attachments(item.attachments, 'teacher') +
        '<div class="modal-actions compact-actions">' +
          (type === 'assignment' ? '<button class="button secondary small" type="button" data-detail-submissions>제출 보기</button>' : '') +
          '<button class="button ghost small" type="button" data-detail-edit>' + UI.escape(info.plural) + ' 수정</button>' +
        '</div>'
    });
    UI.bindFiles(dialog, 'teacher');
    var submissions = dialog.querySelector('[data-detail-submissions]');
    if (submissions) submissions.addEventListener('click', function () {
      openSubmissions(item.id, classId, container, tab);
    });
    dialog.querySelector('[data-detail-edit]').addEventListener('click', function () {
      openContentEditor(type, item, classId, container, tab);
    });
  }

  function renderStudents() {
    var rows = classData.students.map(function (student) {
      return '<tr><td><strong>' + UI.escape(student.number) + '</strong></td><td>' + UI.escape(student.name) + '</td>' +
        '<td><span class="pin-code">••••</span></td>' +
        '<td>' + (student.online ? '<span class="status-badge open">접속 중</span>' : '<span style="color:var(--muted)">오프라인</span>') + '</td>' +
        '<td><div class="inline-actions"><button class="button ghost small" type="button" data-reset-pin="' + UI.attr(student.id) +
          '" data-student-label="' + UI.attr(student.number + '번 ' + student.name) + '">비밀번호 재발급</button>' +
          '<button class="text-link" type="button" data-delete-student="' + UI.attr(student.id) +
          '" data-student-label="' + UI.attr(student.number + '번 ' + student.name) + '">삭제</button></div></td></tr>';
    }).join('');
    return '<div class="content-head"><div><h2>학생 관리</h2><p>출석번호와 개인 4자리 비밀번호를 발급하고 관리하세요.</p></div>' +
      '<div class="inline-actions">' +
        (classData.students.length ? '<button class="button secondary" type="button" data-reissue-class-pins>전체 로그인표 새로 발급</button>' : '') +
        '<button class="button" type="button" data-add-students>＋ 학생 등록</button></div></div>' +
      (classData.students.length
        ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>번호</th><th>이름</th><th>비밀번호</th><th>상태</th><th>관리</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : UI.empty('등록된 학생이 없어요', '한 반 30명을 한 번에 등록할 수 있어요.', '<button class="button secondary" type="button" data-add-students>학생 등록</button>'));
  }

  function bindTabActions(container, classId, tab) {
    var postTypeFilter = container.querySelector('[data-post-type-filter]');
    if (postTypeFilter) postTypeFilter.addEventListener('change', function () {
      teacherPostFilters.type = postTypeFilter.value;
      paintClass(container, classId, tab);
    });
    var postCategoryFilter = container.querySelector('[data-post-category-filter]');
    if (postCategoryFilter) postCategoryFilter.addEventListener('change', function () {
      teacherPostFilters.category = postCategoryFilter.value;
      paintClass(container, classId, tab);
    });
    container.querySelectorAll('[data-view-content]').forEach(function (card) {
      function openCard(event) {
        if (event && event.target.closest('button, a, input, textarea, select, label')) return;
        var type = card.dataset.viewContent;
        var item = contentListFor(type).find(function (entry) { return entry.id === card.dataset.contentId; });
        if (!item) return;
        if (type === 'board') openTeacherBoard(item.id, classId, container, tab);
        else openTeacherContentDetail(type, item, classId, container, tab);
      }
      card.addEventListener('click', openCard);
      card.addEventListener('keydown', function (event) {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        openCard();
      });
    });
    container.querySelectorAll('[data-create-content]').forEach(function (button) {
      button.addEventListener('click', function () {
        openContentEditor(button.dataset.createContent, null, classId, container, tab);
      });
    });
    container.querySelectorAll('[data-edit-content]').forEach(function (button) {
      button.addEventListener('click', function () {
        var type = button.dataset.editContent;
        var list = contentListFor(type);
        var item = list.find(function (entry) { return entry.id === button.dataset.contentId; });
        openContentEditor(type, item, classId, container, tab);
      });
    });
    container.querySelectorAll('[data-delete-content]').forEach(function (button) {
      button.addEventListener('click', function () {
        deleteContent(button.dataset.deleteContent, button.dataset.contentId, classId, container, tab);
      });
    });
    container.querySelectorAll('[data-view-submissions]').forEach(function (button) {
      button.addEventListener('click', function () { openSubmissions(button.dataset.viewSubmissions, classId, container, tab); });
    });
    container.querySelectorAll('[data-open-board]').forEach(function (button) {
      button.addEventListener('click', function () { openTeacherBoard(button.dataset.openBoard, classId, container, tab); });
    });
    container.querySelectorAll('[data-add-students]').forEach(function (button) {
      button.addEventListener('click', function () { openStudentCreator(classId, container, tab); });
    });
    container.querySelectorAll('[data-reissue-class-pins]').forEach(function (button) {
      button.addEventListener('click', function () { reissueClassPins(classId, container, tab); });
    });
    container.querySelectorAll('[data-reset-pin]').forEach(function (button) {
      button.addEventListener('click', function () { resetPin(button.dataset.resetPin, button.dataset.studentLabel); });
    });
    container.querySelectorAll('[data-delete-student]').forEach(function (button) {
      button.addEventListener('click', function () {
        deleteStudent(button.dataset.deleteStudent, button.dataset.studentLabel, classId, container, tab);
      });
    });
  }

  function contentFields(type, item) {
    var value = item || {};
    var extra = '';
    if (type === 'announcement') {
      extra = '<label style="display:flex;align-items:center;gap:9px;font-size:.9rem;font-weight:700">' +
        '<input type="checkbox" name="pinned" ' + (value.pinned ? 'checked' : '') + '> 상단에 고정</label>';
    } else {
      extra = '<div class="form-row">' +
        (type === 'assignment' ? '<div class="field"><label for="content-due">제출 마감</label><input id="content-due" name="dueAt" type="datetime-local" value="' + UI.attr(UI.localDateTime(value.dueAt)) + '"></div>' : '') +
        '<div class="field"><label for="content-status">상태</label><select id="content-status" name="status">' +
          '<option value="open" ' + (value.status !== 'closed' ? 'selected' : '') + '>' + (type === 'board' ? '작성 가능' : '제출 가능') + '</option>' +
          '<option value="closed" ' + (value.status === 'closed' ? 'selected' : '') + '>' + (type === 'board' ? '읽기 전용' : '마감') + '</option></select></div>' +
      '</div>';
    }
    return '<div class="field"><label for="content-title">제목</label><input id="content-title" name="title" required maxlength="100" value="' + UI.attr(value.title || '') + '"></div>' +
      '<div class="field"><label for="content-category">카테고리</label><input id="content-category" name="category" list="content-category-options" maxlength="40" value="' + UI.attr(value.category || '') + '" placeholder="예: 수업 안내, 수행 평가">' +
        '<datalist id="content-category-options"><option value="수업 안내"><option value="준비물"><option value="수업 자료"><option value="학습 활동"><option value="수행 평가"><option value="생각 나눔"></datalist>' +
        '<span class="field-help">같은 카테고리의 글을 글 목록에서 모아 볼 수 있어요.</span></div>' +
      '<div class="field"><label for="content-body">내용</label><textarea id="content-body" name="body" maxlength="5000">' + UI.escape(value.body || '') + '</textarea></div>' +
      extra +
      '<div class="field"><span class="field-label">첨부파일</span>' +
        '<label class="file-drop" data-file-drop><input type="file" multiple data-file-input>' +
          '<strong>파일을 끌어놓거나 눌러서 선택</strong><span>파일당 최대 ' + UI.escape((window.LEARN_CONFIG || {}).maxFileSizeMb || 25) + 'MB · 여러 개 선택 가능</span></label>' +
        '<div class="selected-files" data-selected-files></div></div>';
  }

  function openContentEditor(type, item, classId, container, tab) {
    var info = typeInfo(type);
    var dialog = UI.modal({
      title: item ? info.plural + ' 수정' : info.create,
      html: '<form class="form-stack" data-content-form>' + contentFields(type, item) +
        '<div class="modal-actions"><button class="button secondary" type="button" data-cancel>취소</button>' +
          '<button class="button" type="submit">' + (item ? '수정 저장' : '등록') + '</button></div></form>'
    });
    var picker = UI.filePicker(dialog, item ? item.attachments : []);
    dialog.querySelector('[data-cancel]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-content-form]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var button = form.querySelector('[type="submit"]');
      var values = new FormData(form);
      var data = {
        title: String(values.get('title') || '').trim(),
        body: String(values.get('body') || '').trim(),
        category: String(values.get('category') || '').trim()
      };
      if (type === 'announcement') data.pinned = values.get('pinned') === 'on';
      if (type === 'assignment') {
        data.dueAt = values.get('dueAt') ? new Date(values.get('dueAt')).toISOString() : '';
        data.status = values.get('status') || 'open';
      }
      if (type === 'board') data.status = values.get('status') || 'open';
      UI.busy(button, true, '파일 저장 중…');
      try {
        var files = await window.LearnFiles.toPayload(picker.files());
        await API.request('upsertContent', {
          type: type,
          id: item ? item.id : '',
          classId: classId,
          data: data,
          files: files,
          keepAttachmentIds: picker.keepAttachmentIds()
        }, 'teacher', 0);
        UI.closeModal();
        UI.toast((item ? '수정' : '등록') + '했습니다.');
        renderClass(container, classId, tab);
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(button, false);
      }
    });
  }

  async function deleteContent(type, id, classId, container, tab) {
    var info = typeInfo(type);
    var yes = await UI.confirm({
      title: info.plural + ' 삭제',
      message: type === 'announcement'
        ? '이 공지와 첨부파일을 삭제할까요?'
        : '연결된 학생 자료와 첨부파일도 함께 삭제됩니다.',
      confirmText: '삭제',
      danger: true
    });
    if (!yes) return;
    try {
      await API.request('deleteContent', { type: type, id: id, classId: classId }, 'teacher');
      UI.toast('삭제했습니다.');
      renderClass(container, classId, tab);
    } catch (error) {
      UI.toast(error.message, 'error');
    }
  }

  function openStudentCreator(classId, container, tab) {
    var existingNumbers = classData.students.map(function (student) { return Number(student.number); });
    var firstAvailable = 1;
    while (existingNumbers.indexOf(firstAvailable) >= 0) firstAvailable += 1;
    var dialog = UI.modal({
      title: '학생 등록 및 비밀번호 발급',
      html:
        '<form class="form-stack" data-student-form>' +
          '<div class="form-row">' +
            '<div class="field"><label for="start-number">시작 출석번호</label><input id="start-number" name="startNumber" type="number" min="1" max="999" value="' + firstAvailable + '" required></div>' +
            '<div class="field"><label for="student-count">등록 인원</label><input id="student-count" name="count" type="number" min="1" max="60" value="30" required></div>' +
          '</div>' +
          '<div class="field"><label for="student-names">학생 이름</label><textarea id="student-names" name="names" placeholder="한 줄에 한 명씩 입력하세요.&#10;김사랑&#10;이배움"></textarea>' +
            '<span class="field-help">이름을 비워 두면 ‘학생 1’처럼 임시 이름으로 등록됩니다. 등록 후 발급표를 저장할 수 있어요.</span></div>' +
          '<div class="modal-actions"><button class="button secondary" type="button" data-cancel>취소</button>' +
            '<button class="button" type="submit">등록하고 발급</button></div>' +
        '</form>'
    });
    dialog.querySelector('[data-cancel]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-student-form]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var values = new FormData(form);
      var names = String(values.get('names') || '').split(/\r?\n/).map(function (name) { return name.trim(); }).filter(Boolean);
      var button = form.querySelector('[type="submit"]');
      UI.busy(button, true, '발급 중…');
      try {
        var response = await API.request('addStudents', {
          classId: classId,
          startNumber: Number(values.get('startNumber')),
          count: Number(values.get('count')),
          names: names
        }, 'teacher');
        showIssuedPins(response.students, classData.classInfo.code, function () {
          renderClass(container, classId, tab);
        });
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(button, false);
      }
    });
  }

  function showIssuedPins(students, classCode, onClose) {
    var rows = students.map(function (student) {
      return '<tr><td>' + UI.escape(student.number) + '</td><td>' + UI.escape(student.name) + '</td>' +
        '<td class="pin-code">' + UI.escape(student.pin) + '</td></tr>';
    }).join('');
    var dialog = UI.modal({
      title: '학생 비밀번호 발급 완료',
      wide: true,
      html:
        '<div class="info-box">비밀번호 원문은 지금만 확인할 수 있어요. 학생에게 전달하기 전에 발급표를 저장해 주세요.</div>' +
        '<div class="table-wrap" style="margin-top:16px"><table class="data-table"><thead><tr><th>출석번호</th><th>이름</th><th>4자리 비밀번호</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="modal-actions"><button class="button secondary" type="button" data-print-pins>로그인표 인쇄</button>' +
          '<button class="button secondary" type="button" data-download-pins>발급표 CSV 저장</button>' +
          '<button class="button" type="button" data-done>확인</button></div>'
    });
    dialog.querySelector('[data-print-pins]').addEventListener('click', function () {
      printLoginSlips(students, classCode);
    });
    dialog.querySelector('[data-download-pins]').addEventListener('click', function () {
      var csv = '\ufeff클래스코드,출석번호,이름,비밀번호\n' + students.map(function (student) {
        return [classCode, student.number, '"' + String(student.name).replace(/"/g, '""') + '"', student.pin].join(',');
      }).join('\n');
      downloadText(classData.classInfo.name + '_학생_비밀번호.csv', csv, 'text/csv;charset=utf-8');
    });
    dialog.querySelector('[data-done]').addEventListener('click', function () {
      UI.closeModal();
      if (onClose) onClose();
    });
  }

  async function reissueClassPins(classId, container, tab) {
    var yes = await UI.confirm({
      title: '전체 로그인표 새로 발급',
      message: '등록 학생 ' + classData.students.length + '명의 기존 비밀번호가 모두 바뀌고, 로그인 중인 학생은 다시 로그인해야 합니다.',
      confirmText: '전체 새로 발급',
      danger: true
    });
    if (!yes) return;
    try {
      var response = await API.request('reissueClassPins', { classId: classId }, 'teacher', 0);
      showIssuedPins(response.students, classData.classInfo.code, function () {
        renderClass(container, classId, tab);
      });
    } catch (error) {
      UI.toast(error.message, 'error');
    }
  }

  function studentAccessUrl() {
    var url = new URL(window.location.href);
    url.search = '';
    url.hash = '#/student/login';
    return url.toString();
  }

  async function shareStudentLink(classInfo) {
    var url = studentAccessUrl();
    var shareData = {
      title: '사랑스런(Learn) 수업시간 · ' + classInfo.name,
      text: classInfo.name + ' 학생 접속 링크',
      url: url
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        UI.toast('학생 접속 링크를 공유했습니다.');
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      UI.toast('학생 접속 링크를 복사했습니다.');
    } catch (error) {
      var dialog = UI.modal({
        title: '학생 접속 링크',
        html: '<p class="muted-text">아래 주소를 길게 눌러 복사한 뒤 학생에게 보내 주세요.</p>' +
          '<div class="field"><label for="student-access-url">' + UI.escape(classInfo.name) + '</label>' +
            '<input id="student-access-url" value="' + UI.attr(url) + '" readonly></div>'
      });
      var input = dialog.querySelector('#student-access-url');
      input.focus();
      input.select();
    }
  }

  function printLoginSlips(students, classCode) {
    var printWindow = window.open('', '_blank');
    if (!printWindow) {
      UI.toast('팝업을 허용한 뒤 다시 눌러 주세요.', 'error');
      return;
    }
    var classInfo = classData.classInfo;
    var accessUrl = studentAccessUrl();
    var slips = students.map(function (student) {
      return '<section class="slip"><div class="slip-brand">사랑스런(Learn) 수업시간</div>' +
        '<h2>' + UI.escape(classInfo.name) + '</h2>' +
        '<p class="school">' + UI.escape(classInfo.school || '우리 학교') + '</p>' +
        '<dl><div><dt>클래스 코드</dt><dd>' + UI.escape(classCode) + '</dd></div>' +
          '<div><dt>출석번호</dt><dd>' + UI.escape(student.number) + '번</dd></div>' +
          '<div><dt>이름</dt><dd>' + UI.escape(student.name) + '</dd></div>' +
          '<div><dt>비밀번호</dt><dd class="pin">' + UI.escape(student.pin) + '</dd></div></dl>' +
        '<small>학생 접속: ' + UI.escape(accessUrl) + '</small></section>';
    }).join('');
    printWindow.document.open();
    printWindow.document.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + UI.escape(classInfo.name) + ' 학생 로그인표</title><style>' +
      '@page{size:A4;margin:10mm}*{box-sizing:border-box}body{margin:0;color:#1d1b20;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
      '.print-toolbar{position:sticky;top:0;z-index:2;display:flex;justify-content:center;gap:10px;padding:14px;background:#fff;border-bottom:1px solid #ddd}' +
      '.print-toolbar button{border:0;border-radius:999px;padding:11px 22px;background:#18171b;color:#fff;font-family:inherit;font-size:16px;font-weight:700;cursor:pointer}' +
      '.sheet{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5mm;padding:10mm}' +
      '.slip{min-height:52mm;border:1.5px dashed #7b6f75;border-radius:12px;padding:7mm;break-inside:avoid;background:linear-gradient(135deg,#fff 70%,#fff2f6)}' +
      '.slip-brand{font-size:12px;font-weight:800;color:#bd4964}.slip h2{margin:4px 0 0;font-size:21px}.school{margin:2px 0 10px;color:#666;font-size:13px}' +
      'dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:0}dl div{border-top:1px solid #ddd;padding-top:5px}dt{font-size:10px;color:#777}dd{margin:2px 0 0;font-size:15px;font-weight:750}.pin{font-size:20px;letter-spacing:.16em;color:#bd4964}' +
      '.slip small{display:block;margin-top:10px;color:#777;font-size:9px;line-height:1.35;overflow-wrap:anywhere}@media(max-width:620px){.sheet{grid-template-columns:1fr;padding:14px}.slip{min-height:auto}}' +
      '@media print{.print-toolbar{display:none}.sheet{padding:0;grid-template-columns:repeat(2,minmax(0,1fr));gap:5mm}.slip{min-height:52mm}}' +
      '</style></head><body><div class="print-toolbar"><button type="button" onclick="window.print()">인쇄 또는 PDF 저장</button></div>' +
      '<main class="sheet">' + slips + '</main></body></html>');
    printWindow.document.close();
    printWindow.focus();
  }

  function downloadText(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain' }));
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  async function resetPin(studentId, studentLabel) {
    var yes = await UI.confirm({
      title: '비밀번호 재발급',
      message: studentLabel + ' 학생의 기존 비밀번호는 즉시 사용할 수 없게 됩니다.',
      confirmText: '새 비밀번호 발급'
    });
    if (!yes) return;
    try {
      var response = await API.request('resetStudentPin', { studentId: studentId }, 'teacher');
      var dialog = UI.modal({
        title: studentLabel + ' 새 비밀번호',
        html: '<div style="padding:20px;text-align:center"><span class="pin-code" style="font-size:2.4rem">' +
          UI.escape(response.pin) + '</span><p style="color:var(--muted)">학생에게 이 4자리 숫자를 전달해 주세요.</p></div>' +
          '<div class="modal-actions"><button class="button" type="button" data-done>확인</button></div>'
      });
      dialog.querySelector('[data-done]').addEventListener('click', UI.closeModal);
    } catch (error) {
      UI.toast(error.message, 'error');
    }
  }

  async function deleteStudent(studentId, studentLabel, classId, container, tab) {
    var yes = await UI.confirm({
      title: studentLabel + ' 삭제',
      message: '학생 계정과 이 학생의 제출물·보드 글이 함께 삭제됩니다.',
      confirmText: '학생 삭제',
      danger: true
    });
    if (!yes) return;
    try {
      await API.request('deleteStudent', { studentId: studentId, classId: classId }, 'teacher');
      UI.toast('학생을 삭제했습니다.');
      renderClass(container, classId, tab);
    } catch (error) {
      UI.toast(error.message, 'error');
    }
  }

  function openSubmissions(assignmentId, classId, container, tab) {
    var assignment = classData.assignments.find(function (item) { return item.id === assignmentId; });
    var submissions = classData.submissions.filter(function (item) { return item.assignmentId === assignmentId; })
      .sort(function (a, b) { return Number(a.studentNumber) - Number(b.studentNumber); });
    var html =
      '<div class="content-head"><div><p style="margin:0">제출 ' + submissions.length + '/' + classData.students.length + '명</p></div>' +
        '<button class="button" type="button" data-download-all ' + (!submissions.length ? 'disabled' : '') + '>ZIP 일괄 다운로드</button></div>';
    if (!submissions.length) {
      html += UI.empty('아직 제출물이 없어요', '학생이 과제를 제출하면 이곳에 표시됩니다.');
    } else {
      html += '<div class="item-list">' + submissions.map(function (submission) {
        var context = {
          heading: submission.studentNumber + '번 ' + submission.studentName + ' 작성 내용',
          meta: assignment.title,
          text: submission.text || ''
        };
        return '<article class="item-card content-clickable submission-summary-card" tabindex="0" data-teacher-submission="' +
          UI.attr(submission.id) + '" aria-label="' + UI.attr(submission.studentNumber + '번 ' + submission.studentName + ' 제출물 상세 보기') +
          '"><div class="item-top"><div><h3>' +
          UI.escape(submission.studentNumber + '번 ' + submission.studentName) + '</h3>' +
          '<div class="meta-line"><span>제출 ' + UI.escape(UI.date(submission.submittedAt, true)) + '</span>' +
          (submission.updatedAt !== submission.submittedAt ? '<span>마지막 수정 ' + UI.escape(UI.date(submission.updatedAt, true)) + '</span>' : '') +
          '</div></div><span class="status-badge submitted">제출 완료</span></div>' +
          (submission.text ? '<p class="item-body">' + UI.escape(submission.text) + '</p>' : '') +
          UI.attachmentGallery(submission.attachments, 'teacher', { compact: true, maxItems: 2, context: context }) +
          '<span class="submission-open-hint">눌러서 글과 파일 전체 보기 ›</span></article>';
      }).join('') + '</div>';
    }
    var dialog = UI.modal({ title: assignment.title + ' 제출물', wide: true, html: html });
    UI.bindFiles(dialog, 'teacher');
    dialog.querySelectorAll('[data-teacher-submission]').forEach(function (card) {
      function openDetail(event) {
        if (event && event.target.closest('button, a')) return;
        var submission = submissions.find(function (item) { return item.id === card.dataset.teacherSubmission; });
        if (submission) openTeacherSubmissionDetail(submission, assignment, classId, container, tab);
      }
      card.addEventListener('click', openDetail);
      card.addEventListener('keydown', function (event) {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        openDetail(event);
      });
    });
    var downloadAll = dialog.querySelector('[data-download-all]');
    if (downloadAll) downloadAll.addEventListener('click', function () {
      createBundle(downloadAll, 'assignment', assignment.id, assignment.title, classId);
    });
  }

  function openTeacherSubmissionDetail(submission, assignment, classId, container, tab) {
    var context = {
      heading: submission.studentNumber + '번 ' + submission.studentName + ' 작성 내용',
      meta: assignment.title,
      text: submission.text || ''
    };
    var dialog = UI.modal({
      title: submission.studentNumber + '번 ' + submission.studentName + ' · 제출물',
      wide: true,
      html:
        '<div class="detail-meta"><span class="status-badge submitted">제출 완료</span>' +
          '<span>제출 ' + UI.escape(UI.date(submission.submittedAt, true)) + '</span>' +
          (submission.updatedAt !== submission.submittedAt ? '<span>마지막 수정 ' + UI.escape(UI.date(submission.updatedAt, true)) + '</span>' : '') +
        '</div>' +
        '<section class="submission-detail-section"><h3>학생이 작성한 글</h3>' +
          '<div class="detail-body">' + (submission.text ? UI.nl2br(submission.text) : '<span class="muted-text">작성한 글 없이 파일만 제출했어요.</span>') + '</div></section>' +
        '<section class="submission-detail-section"><h3>첨부파일</h3>' +
          (UI.attachmentGallery(submission.attachments, 'teacher', { context: context }) || '<p class="muted-text">첨부한 파일이 없어요.</p>') +
        '</section>' +
        '<div class="modal-actions"><button class="button secondary small" type="button" data-back-to-submissions>제출 목록으로</button></div>'
    });
    UI.bindFiles(dialog, 'teacher');
    dialog.querySelector('[data-back-to-submissions]').addEventListener('click', function () {
      openSubmissions(assignment.id, classId, container, tab);
    });
  }

  function openTeacherBoard(boardId, classId, container, tab) {
    var board = classData.boards.find(function (item) { return item.id === boardId; });
    var posts = classData.boardPosts.filter(function (item) { return item.boardId === boardId; });
    var byStudent = {};
    posts.forEach(function (post) { byStudent[post.studentId] = post; });
    var cards = classData.students.map(function (student) {
      var post = byStudent[student.id];
      var context = post ? {
        heading: student.number + '번 ' + student.name + '의 글',
        meta: board.title,
        text: post.text || ''
      } : null;
      return '<article class="student-tile board-feed-card" tabindex="' + (post ? '0' : '-1') + '" data-teacher-post="' + UI.attr(post ? post.id : '') + '">' +
        '<div><span class="tile-number">' + UI.escape(student.number) + '</span><span class="tile-name">' + UI.escape(student.name) + '</span></div>' +
        (post
          ? '<div class="tile-content">' + UI.escape((post.text || '첨부파일 게시물').slice(0, 92)) +
            (post.text && post.text.length > 92 ? '…' : '') + '</div>' +
            UI.attachmentGallery(post.attachments, 'teacher', { compact: true, maxItems: 1, context: context }) +
            (post.status === 'revision' ? '<div class="tile-review-state revision">반려 · 수정 필요</div>' : '') +
            (post.status === 'confirmed' ? '<div class="tile-review-state confirmed">확인 완료</div>' : '')
          : '<div class="tile-empty">아직 작성하지 않았어요.</div>') +
      '</article>';
    }).join('');
    var dialog = UI.modal({
      title: board.title,
      wide: true,
      html:
        '<div class="detail-meta" style="margin-bottom:14px">' + categoryBadge(board) +
          '<span class="status-badge ' + (board.status === 'open' ? 'open' : '') + '">' +
            (board.status === 'open' ? '작성 가능' : '읽기 전용') + '</span></div>' +
        '<div class="content-head"><div><p>' + UI.escape(board.body || '') + '</p></div>' +
          '<button class="button secondary" type="button" data-board-download ' + (!posts.length ? 'disabled' : '') + '>ZIP 일괄 다운로드</button></div>' +
        UI.attachments(board.attachments, 'teacher') +
        '<div class="board-grid" style="margin-top:20px">' + cards + '</div>'
    });
    UI.bindFiles(dialog, 'teacher');
    var bundleButton = dialog.querySelector('[data-board-download]');
    if (bundleButton) bundleButton.addEventListener('click', function () {
      createBundle(bundleButton, 'board', board.id, board.title, classId);
    });
    dialog.querySelectorAll('[data-teacher-post]').forEach(function (tile) {
      tile.addEventListener('click', function (event) {
        if (event.target.closest('button, a, input, textarea, select, label')) return;
        if (!tile.dataset.teacherPost) return;
        var post = posts.find(function (entry) { return entry.id === tile.dataset.teacherPost; });
        openBoardPostReview(post, board, classId, container, tab);
      });
      tile.addEventListener('keydown', function (event) {
        if (event.target === tile && (event.key === 'Enter' || event.key === ' ') && tile.dataset.teacherPost) {
          event.preventDefault();
          var post = posts.find(function (entry) { return entry.id === tile.dataset.teacherPost; });
          openBoardPostReview(post, board, classId, container, tab);
        }
      });
    });
  }

  function openBoardPostReview(post, board, classId, container, tab) {
    var statusText = moderationStateHtml(post.status);
    var dialog = UI.modal({
      title: post.studentNumber + '번 ' + post.studentName + '의 게시글',
      wide: true,
      closeOnBackdrop: false,
      html:
        statusText +
        '<div class="detail-meta"><span>게시 ' + UI.escape(UI.date(post.createdAt, true)) + '</span>' +
          (post.updatedAt !== post.createdAt ? '<span>수정 ' + UI.escape(UI.date(post.updatedAt, true)) + '</span>' : '') + '</div>' +
        '<div class="detail-body">' + (post.text ? UI.nl2br(post.text) : '<span class="muted-text">작성된 글 없이 파일만 게시했어요.</span>') + '</div>' +
        UI.attachmentGallery(post.attachments, 'teacher', { context: {
          heading: post.studentNumber + '번 ' + post.studentName + '의 글',
          meta: board.title,
          text: post.text || ''
        } }) +
        '<div class="modal-actions moderation-actions">' +
          '<button class="button soft" type="button" data-review-decision="revision">반려</button>' +
          '<button class="button danger" type="button" data-delete-post>삭제</button>' +
          '<button class="button confirmed" type="button" data-review-decision="confirmed">확인</button>' +
        '</div>'
    });
    UI.bindFiles(dialog, 'teacher');
    dialog.querySelectorAll('[data-review-decision]').forEach(function (button) {
      button.addEventListener('click', async function () {
        var decision = button.dataset.reviewDecision;
        UI.busy(button, true, decision === 'revision' ? '반려 중…' : '확인 중…');
        try {
          var updatedPost = await API.request('reviewBoardPost', {
            postId: post.id,
            classId: classId,
            decision: decision
          }, 'teacher');
          var postIndex = classData.boardPosts.findIndex(function (item) { return item.id === updatedPost.id; });
          if (postIndex >= 0) classData.boardPosts[postIndex] = updatedPost;
          post = updatedPost;
          var stateBox = dialog.querySelector('[data-moderation-state]');
          if (stateBox) {
            stateBox.className = 'moderation-state' + (decision === 'revision' ? ' revision' : ' confirmed');
            stateBox.innerHTML = decision === 'revision'
              ? '<strong>반려됨</strong><span>학생에게만 수정 필요 상태가 표시돼요.</span>'
              : '<strong>확인 완료</strong><span>학생에게만 확인 완료 상태가 표시돼요.</span>';
          }
          UI.toast(decision === 'revision' ? '수정이 필요하도록 반려했습니다.' : '게시글을 확인했습니다.');
          UI.busy(button, false);
        } catch (error) {
          UI.toast(error.message, 'error');
          UI.busy(button, false);
        }
      });
    });
    dialog.querySelector('[data-delete-post]').addEventListener('click', async function () {
      var yes = await UI.confirm({
        title: '학생 게시글 삭제',
        message: post.studentNumber + '번 ' + post.studentName + '의 글과 첨부파일을 삭제할까요?',
        confirmText: '삭제',
        danger: true
      });
      if (!yes) {
        openBoardPostReview(post, board, classId, container, tab);
        return;
      }
      try {
        await API.request('deleteBoardPost', { postId: post.id, classId: classId }, 'teacher');
        classData.boardPosts = classData.boardPosts.filter(function (item) { return item.id !== post.id; });
        board.postCount = Math.max(0, Number(board.postCount || 0) - 1);
        paintClass(container, classId, tab);
        openTeacherBoard(board.id, classId, container, tab);
        UI.toast('게시글을 삭제했습니다.');
      } catch (error) {
        UI.toast(error.message, 'error');
      }
    });
  }

  function moderationStateHtml(status) {
    if (status === 'revision') {
      return '<div class="moderation-state revision" data-moderation-state><strong>반려됨</strong><span>학생에게만 수정 필요 상태가 표시돼요.</span></div>';
    }
    if (status === 'confirmed') {
      return '<div class="moderation-state confirmed" data-moderation-state><strong>확인 완료</strong><span>학생에게만 확인 완료 상태가 표시돼요.</span></div>';
    }
    return '<div class="moderation-state" data-moderation-state><strong>확인 전</strong><span>아래 버튼으로 게시글 상태를 정해 주세요.</span></div>';
  }

  async function createBundle(button, kind, itemId, title, classId) {
    var pendingWindow = window.open('about:blank', '_blank');
    if (pendingWindow) {
      pendingWindow.document.write('<!doctype html><meta charset="utf-8"><title>ZIP 준비 중</title><p style="font-family:sans-serif;padding:32px">ZIP 파일을 만들고 있어요. 자료가 많으면 잠시 걸릴 수 있습니다.</p>');
    }
    UI.busy(button, true, 'ZIP 만드는 중…');
    try {
      var response = await API.request('createDownloadBundle', {
        kind: kind,
        itemId: itemId,
        title: title,
        classId: classId
      }, 'teacher', 0);
      if (!response.parts || !response.parts.length) {
        throw new Error('내려받을 첨부파일이 없습니다.');
      }
      window.LearnFiles.openBundleParts(response.parts.slice(0, 1), pendingWindow);
      if (response.parts.length > 1) {
        var links = response.parts.slice(1).map(function (part, index) {
          return '<a class="button secondary" href="' + UI.attr(part.downloadUrl) + '" target="_blank" rel="noopener">' +
            UI.escape((index + 2) + '부 내려받기') + '</a>';
        }).join('');
        UI.modal({
          title: '나머지 ZIP 파일',
          html: '<div class="info-box">파일이 커서 여러 ZIP으로 나누었습니다. 첫 파일은 다운로드를 시작했고, 아래 파일도 차례로 내려받아 주세요.</div>' +
            '<div class="modal-actions">' + links + '</div>'
        });
      }
      UI.toast(response.parts.length > 1
        ? '파일 크기에 맞춰 ' + response.parts.length + '개 ZIP으로 나누어 내려받습니다.'
        : 'ZIP 다운로드를 시작했습니다.');
      UI.busy(button, false);
    } catch (error) {
      if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
      UI.toast(error.message || 'ZIP 파일을 만들지 못했습니다.', 'error');
      UI.busy(button, false);
    }
  }

  function startPresence(classId) {
    stopPresence();
    function heartbeat() {
      API.request('heartbeat', { classId: classId }, 'teacher', 1).then(function (response) {
        var list = document.querySelector('[data-presence-list]');
        var count = document.querySelector('[data-online-count]');
        if (list && response.onlineStudents) list.innerHTML = presenceRows(response.onlineStudents);
        if (count && response.onlineStudents) count.textContent = response.onlineStudents.length + '명';
      }).catch(function () {});
    }
    heartbeat();
    presenceTimer = window.setInterval(heartbeat, 45000);
  }

  function stopPresence() {
    if (presenceTimer) window.clearInterval(presenceTimer);
    presenceTimer = null;
  }

  window.TeacherViews = {
    dashboard: renderDashboard,
    classPage: renderClass,
    stop: stopPresence
  };
})();
