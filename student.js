(function () {
  'use strict';

  var UI = window.LearnUI;
  var API = window.LearnAPI;
  var studentData = null;
  var selectedBoards = {};
  var heartbeatTimer = null;
  var studentPostFilters = { type: 'all', category: 'all' };

  function sessionOrLogin() {
    var session = window.LearnSession.get('student');
    if (!session || !session.token) {
      location.hash = '#/student/login';
      return null;
    }
    return session;
  }

  function loading(container) {
    container.innerHTML = '<section class="loading-screen"><div class="loader"></div><p>우리 반 자료를 불러오고 있어요.</p></section>';
  }

  async function renderClass(container, tab) {
    var session = sessionOrLogin();
    if (!session) return;
    stopHeartbeat();
    var safeTab = ['posts', 'announcements', 'assignments', 'boards'].indexOf(tab) >= 0 ? tab : 'announcements';
    loading(container);
    try {
      studentData = await API.request('getStudentClass', {}, 'student');
      paintClass(container, safeTab, session);
      startHeartbeat(studentData.classInfo.id);
    } catch (error) {
      container.innerHTML = '<section class="page"><div class="panel">' +
        UI.empty('자료를 불러오지 못했어요', error.message || '잠시 후 다시 시도해 주세요.',
          '<button class="button" type="button" data-retry>다시 시도</button>') + '</div></section>';
      container.querySelector('[data-retry]').addEventListener('click', function () { renderClass(container, safeTab); });
    }
  }

  function paintClass(container, tab, session) {
    var classId = studentData.classInfo.id;
    container.innerHTML =
      '<section class="app-page">' +
        '<header class="workspace-head">' +
          '<div class="workspace-title-wrap"><div class="back-button" aria-hidden="true">' + UI.escape(session.user.number) + '</div>' +
            '<div><h1>' + UI.escape(studentData.classInfo.name) + '</h1>' +
              '<p>' + UI.escape(session.user.name) + ' · ' + UI.escape(studentData.classInfo.subject || '수업') + '</p></div></div>' +
          '<div class="inline-actions"><button class="button secondary small" type="button" data-refresh>새로고침</button>' +
            '<button class="button small" type="button" data-student-logout>나가기</button></div>' +
        '</header>' +
        '<nav class="tab-bar" aria-label="우리 반 메뉴">' +
          studentTab('posts', '글 목록', studentData.announcements.length + studentData.assignments.length + studentData.boards.length, tab) +
          studentTab('announcements', '공지', studentData.announcements.length, tab) +
          studentTab('assignments', '과제', studentData.assignments.length, tab) +
          studentTab('boards', '보드', studentData.boards.length, tab) +
        '</nav>' +
        '<section class="panel content-panel">' + renderTab(tab, session) + '</section>' +
      '</section>';
    container.querySelector('[data-refresh]').addEventListener('click', function () { renderClass(container, tab); });
    container.querySelector('[data-student-logout]').addEventListener('click', function () {
      window.LearnSession.clear('student');
      if (window.LearnNavigation) window.LearnNavigation.clear('student');
      location.hash = '#/';
    });
    bindTabActions(container, tab, session);
    UI.bindFiles(container, 'student');
  }

  function studentTab(key, label, count, active) {
    return '<a class="tab-button ' + (key === active ? 'active' : '') + '" href="#/student/class/' + key + '">' +
      UI.escape(label) + '<span class="tab-count">' + UI.escape(count) + '</span></a>';
  }

  function renderTab(tab, session) {
    if (tab === 'posts') return renderStudentPostIndex(session);
    if (tab === 'assignments') return renderAssignments(session);
    if (tab === 'boards') return renderBoards(session);
    return renderAnnouncements();
  }

  function contentCategory(item) {
    return String(item && item.category || '').trim() || '미분류';
  }

  function categoryBadge(item) {
    return '<span class="category-badge"># ' + UI.escape(contentCategory(item)) + '</span>';
  }

  function studentContentEntries() {
    var entries = [];
    [
      { type: 'announcement', label: '공지', items: studentData.announcements },
      { type: 'assignment', label: '과제', items: studentData.assignments },
      { type: 'board', label: '보드', items: studentData.boards }
    ].forEach(function (group) {
      group.items.forEach(function (item) {
        entries.push({ type: group.type, label: group.label, item: item });
      });
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

  function renderStudentPostIndex() {
    var entries = studentContentEntries();
    var categories = Array.from(new Set(entries.map(function (entry) {
      return contentCategory(entry.item);
    }))).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    if (studentPostFilters.category !== 'all' && categories.indexOf(studentPostFilters.category) < 0) {
      studentPostFilters.category = 'all';
    }
    var filtered = entries.filter(function (entry) {
      return (studentPostFilters.type === 'all' || entry.type === studentPostFilters.type) &&
        (studentPostFilters.category === 'all' || contentCategory(entry.item) === studentPostFilters.category);
    });
    var typeOptions = filterOption('all', '전체 글', studentPostFilters.type) +
      filterOption('announcement', '공지', studentPostFilters.type) +
      filterOption('assignment', '과제', studentPostFilters.type) +
      filterOption('board', '보드', studentPostFilters.type);
    var categoryOptions = filterOption('all', '전체 카테고리', studentPostFilters.category) +
      categories.map(function (category) { return filterOption(category, category, studentPostFilters.category); }).join('');
    var head = '<div class="content-head"><div><h2>글 목록</h2><p>우리 반 공지·과제·보드를 최신 글부터 확인하세요.</p></div>' +
      '<span class="post-result-count">' + filtered.length + '개</span></div>' +
      '<div class="post-filter-bar"><label><span>글 종류</span><select data-post-type-filter>' + typeOptions + '</select></label>' +
        '<label><span>카테고리</span><select data-post-category-filter>' + categoryOptions + '</select></label></div>';
    if (!filtered.length) return head + UI.empty('조건에 맞는 글이 없어요', '다른 글 종류나 카테고리를 선택해 보세요.');
    return head + '<div class="blog-list">' + filtered.map(studentPostIndexCard).join('') + '</div>';
  }

  function studentPostIndexCard(entry) {
    var item = entry.item;
    var dataAttribute = entry.type === 'announcement' ? 'data-view-announcement' :
      (entry.type === 'assignment' ? 'data-view-assignment' : 'data-view-board');
    var excerpt = String(item.body || '').trim() || ((item.attachments || []).length ? '첨부파일이 있는 글입니다.' : '작성된 내용이 없어요.');
    return '<article class="blog-row content-clickable" tabindex="0" ' + dataAttribute + '="' + UI.attr(item.id) +
      '" aria-label="' + UI.attr(item.title + ' 상세 보기') + '">' +
      '<div class="blog-row-labels"><span class="content-type-badge ' + UI.attr(entry.type) + '">' + UI.escape(entry.label) + '</span>' +
        categoryBadge(item) + '</div>' +
      '<div class="blog-row-main"><h3>' + UI.escape(item.title) + '</h3><p>' + UI.escape(excerpt) + '</p></div>' +
      '<div class="blog-row-meta"><span>' + UI.escape(UI.date(item.updatedAt || item.createdAt, true)) + '</span>' +
        ((item.attachments || []).length ? '<span>첨부 ' + item.attachments.length + '개</span>' : '') + '<b aria-hidden="true">›</b></div>' +
    '</article>';
  }

  function renderAnnouncements() {
    var items = studentData.announcements.slice().sort(function (a, b) {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    var head = '<div class="content-head"><div><h2>공지</h2><p>선생님이 전한 수업 소식을 확인하세요.</p></div></div>';
    if (!items.length) return head + UI.empty('새 공지가 없어요', '새로운 공지가 등록되면 이곳에 표시됩니다.');
    return head + '<div class="item-list">' + items.map(function (item) {
      return '<article class="item-card content-clickable ' + (item.pinned ? 'pinned' : '') + '" tabindex="0" ' +
        'data-view-announcement="' + UI.attr(item.id) + '" aria-label="' + UI.attr(item.title + ' 상세 보기') + '">' +
        '<div class="item-top"><div><h3>' + UI.escape(item.title) + '</h3>' +
          '<div class="meta-line">' + categoryBadge(item) + (item.pinned ? '<span class="status-badge">중요 공지</span>' : '') +
            '<span>' + UI.escape(UI.date(item.updatedAt, true)) + '</span></div></div></div>' +
        (item.body ? '<p class="item-body">' + UI.escape(item.body) + '</p>' : '') +
        UI.attachments(item.attachments, 'student') + '</article>';
    }).join('') + '</div>';
  }

  function renderAssignments(session) {
    var own = {};
    studentData.submissions.forEach(function (submission) { own[submission.assignmentId] = submission; });
    var head = '<div class="content-head"><div><h2>과제</h2><p>제출 내용과 파일은 선생님과 나만 볼 수 있어요.</p></div></div>';
    if (!studentData.assignments.length) return head + UI.empty('등록된 과제가 없어요', '새 과제가 등록되면 이곳에 표시됩니다.');
    return head + '<div class="item-list">' + studentData.assignments.map(function (assignment) {
      var submission = own[assignment.id];
      var open = assignment.status === 'open';
      return '<article class="item-card content-clickable" tabindex="0" data-view-assignment="' +
        UI.attr(assignment.id) + '" aria-label="' + UI.attr(assignment.title + ' 상세 보기') + '">' +
        '<div class="item-top"><div><h3>' + UI.escape(assignment.title) + '</h3>' +
          '<div class="meta-line">' + categoryBadge(assignment) + '<span class="status-badge ' + (open ? 'open' : '') + '">' + (open ? '제출 가능' : '마감') + '</span>' +
            (assignment.dueAt ? '<span>마감 ' + UI.escape(UI.date(assignment.dueAt, true)) + '</span>' : '') +
          '</div></div>' +
          '<button class="button ' + (submission ? 'secondary' : '') + ' small" type="button" data-submit-assignment="' +
            UI.attr(assignment.id) + '" ' + (!open ? 'disabled' : '') + '>' + (submission ? '제출 수정' : '제출하기') + '</button></div>' +
        (assignment.body ? '<p class="item-body">' + UI.escape(assignment.body) + '</p>' : '') +
        UI.attachments(assignment.attachments, 'student') +
        (submission ? submissionBox(submission, assignment, open) : '') +
      '</article>';
    }).join('') + '</div>';
  }

  function submissionBox(submission, assignment, open) {
    var previewContext = {
      heading: '내가 작성한 글',
      meta: assignment.title,
      text: submission.text || ''
    };
    return '<div class="submission-card submission-clickable" tabindex="0" role="button" data-view-own-submission="' +
      UI.attr(assignment.id) + '" aria-label="' + UI.attr(assignment.title + ' 내 제출물 상세 보기') + '"><div class="item-top"><div><strong>내 제출물</strong>' +
      '<div class="meta-line"><span>제출 ' + UI.escape(UI.date(submission.submittedAt, true)) + '</span>' +
        (submission.updatedAt !== submission.submittedAt ? '<span>수정 ' + UI.escape(UI.date(submission.updatedAt, true)) + '</span>' : '') +
      '</div></div><div class="inline-actions">' +
        (open ? '<button class="text-link" type="button" data-delete-submission="' + UI.attr(assignment.id) + '">제출 삭제</button>' : '') +
      '</div></div>' +
      (submission.text ? '<p class="item-body">' + UI.escape(submission.text) + '</p>' : '') +
      UI.attachmentGallery(submission.attachments, 'student', { compact: true, maxItems: 2, context: previewContext }) +
      '<span class="submission-open-hint">눌러서 제출 내용 전체 보기 ›</span></div>';
  }

  function renderBoards(session) {
    var classId = studentData.classInfo.id;
    var boards = studentData.boards;
    var head = '<div class="content-head"><div><h2>우리 반 보드</h2><p>친구의 생각을 읽고, 내 출석번호 카드에 글과 파일을 올려 보세요.</p></div></div>';
    if (!boards.length) return head + UI.empty('열린 보드가 없어요', '선생님이 보드를 만들면 이곳에 표시됩니다.');
    var chosenId = selectedBoards[classId];
    if (!chosenId || !boards.some(function (board) { return board.id === chosenId; })) chosenId = boards[0].id;
    selectedBoards[classId] = chosenId;
    var board = boards.find(function (item) { return item.id === chosenId; });
    var posts = studentData.boardPosts.filter(function (post) { return post.boardId === chosenId; });
    var byStudent = {};
    posts.forEach(function (post) { byStudent[post.studentId] = post; });
    var selectors = boards.length > 1
      ? '<div class="toolbar" style="margin-bottom:20px">' + boards.map(function (item) {
          return '<button class="button small ' + (item.id === chosenId ? '' : 'secondary') + '" type="button" data-select-board="' +
            UI.attr(item.id) + '">' + UI.escape(item.title) + '</button>';
        }).join('') + '</div>'
      : '';
    var cards = studentData.students.map(function (student) {
      var post = byStudent[student.id];
      var mine = student.id === session.user.id;
      var previewContext = post ? {
        heading: student.number + '번 ' + student.name + '의 글',
        meta: board.title,
        text: post.text || ''
      } : null;
      return '<article class="student-tile board-feed-card ' + (mine ? 'mine' : '') + '" tabindex="' + (post || mine ? '0' : '-1') +
        '" data-student-card="' + UI.attr(student.id) + '" data-post-id="' + UI.attr(post ? post.id : '') + '">' +
        '<div><span class="tile-number">' + UI.escape(student.number) + '</span><span class="tile-name">' +
          UI.escape(student.name) + (mine ? ' · 나' : '') + '</span></div>' +
        (post
          ? '<div class="tile-content">' + UI.escape((post.text || '첨부파일을 올렸어요.').slice(0, 92)) +
            (post.text && post.text.length > 92 ? '…' : '') + '</div>' +
            UI.attachmentGallery(post.attachments, 'student', { compact: true, maxItems: 1, context: previewContext }) +
            (mine && post.status === 'revision' ? '<div class="tile-review-state revision">수정이 필요해요</div>' : '') +
            (mine && post.status === 'confirmed' ? '<div class="tile-review-state confirmed">선생님 확인 완료</div>' : '')
          : mine && board.status === 'open'
            ? '<div class="tile-empty"><span class="tile-plus">＋</span>내 카드에 작성하기</div>'
            : '<div class="tile-empty">아직 작성하지 않았어요.</div>') +
      '</article>';
    }).join('');
    return head + selectors +
      '<article class="item-card content-clickable" tabindex="0" data-view-board="' + UI.attr(board.id) +
        '" aria-label="' + UI.attr(board.title + ' 상세 보기') + '" style="margin-bottom:20px"><div class="item-top"><div><h3>' + UI.escape(board.title) + '</h3>' +
        '<div class="meta-line">' + categoryBadge(board) + '<span class="status-badge ' + (board.status === 'open' ? 'open' : '') + '">' +
          (board.status === 'open' ? '작성 가능' : '읽기 전용') + '</span><span>게시 ' + posts.length + '/' + studentData.students.length + '명</span></div></div></div>' +
        (board.body ? '<p class="item-body">' + UI.escape(board.body) + '</p>' : '') + UI.attachments(board.attachments, 'student') + '</article>' +
      '<div class="board-grid">' + cards + '</div>';
  }

  function bindDetailCard(card, open) {
    function activate(event) {
      if (event && event.target.closest('button, a, input, textarea, select, label, [data-view-own-submission]')) return;
      open();
    }
    card.addEventListener('click', activate);
    card.addEventListener('keydown', function (event) {
      if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      activate();
    });
  }

  function openStudentContentDetail(type, item, session, container, tab) {
    var badge = '';
    var meta = [];
    var action = '';
    var submission = null;
    if (type === 'announcement') {
      badge = item.pinned ? '<span class="status-badge">중요 공지</span>' : '';
      meta.push(UI.date(item.updatedAt, true));
    }
    if (type === 'assignment') {
      var open = item.status === 'open';
      submission = studentData.submissions.find(function (entry) { return entry.assignmentId === item.id; });
      badge = '<span class="status-badge ' + (open ? 'open' : '') + '">' + (open ? '제출 가능' : '마감') + '</span>';
      if (item.dueAt) meta.push('마감 ' + UI.date(item.dueAt, true));
      if (open) {
        action = '<div class="modal-actions compact-actions"><button class="button small" type="button" data-detail-submit>' +
          (submission ? '제출 수정' : '제출하기') + '</button></div>';
      }
    }
    if (type === 'board') {
      badge = '<span class="status-badge ' + (item.status === 'open' ? 'open' : '') + '">' +
        (item.status === 'open' ? '작성 가능' : '읽기 전용') + '</span>';
      meta.push('게시 ' + (item.postCount || 0) + '/' + studentData.students.length + '명');
    }
    var dialog = UI.modal({
      title: item.title,
      wide: true,
      html:
        '<div class="detail-meta">' + categoryBadge(item) + badge + meta.map(function (text) {
          return '<span>' + UI.escape(text) + '</span>';
        }).join('') + '</div>' +
        '<div class="detail-body">' + (item.body ? UI.nl2br(item.body) : '<span class="muted-text">작성된 내용이 없어요.</span>') + '</div>' +
        UI.attachments(item.attachments, 'student') + action
    });
    UI.bindFiles(dialog, 'student');
    var submit = dialog.querySelector('[data-detail-submit]');
    if (submit) submit.addEventListener('click', function () {
      openSubmissionEditor(item, submission, container, tab);
    });
  }

  function bindTabActions(container, tab, session) {
    var postTypeFilter = container.querySelector('[data-post-type-filter]');
    if (postTypeFilter) postTypeFilter.addEventListener('change', function () {
      studentPostFilters.type = postTypeFilter.value;
      paintClass(container, tab, session);
    });
    var postCategoryFilter = container.querySelector('[data-post-category-filter]');
    if (postCategoryFilter) postCategoryFilter.addEventListener('change', function () {
      studentPostFilters.category = postCategoryFilter.value;
      paintClass(container, tab, session);
    });
    container.querySelectorAll('[data-view-announcement]').forEach(function (card) {
      bindDetailCard(card, function () {
        var item = studentData.announcements.find(function (entry) { return entry.id === card.dataset.viewAnnouncement; });
        if (item) openStudentContentDetail('announcement', item, session, container, tab);
      });
    });
    container.querySelectorAll('[data-view-assignment]').forEach(function (card) {
      bindDetailCard(card, function () {
        var item = studentData.assignments.find(function (entry) { return entry.id === card.dataset.viewAssignment; });
        if (item) openStudentContentDetail('assignment', item, session, container, tab);
      });
    });
    container.querySelectorAll('[data-view-board]').forEach(function (card) {
      bindDetailCard(card, function () {
        var item = studentData.boards.find(function (entry) { return entry.id === card.dataset.viewBoard; });
        if (item) openStudentContentDetail('board', item, session, container, tab);
      });
    });
    container.querySelectorAll('[data-submit-assignment]').forEach(function (button) {
      button.addEventListener('click', function () {
        var assignment = studentData.assignments.find(function (item) { return item.id === button.dataset.submitAssignment; });
        var submission = studentData.submissions.find(function (item) { return item.assignmentId === assignment.id; });
        openSubmissionEditor(assignment, submission, container, tab);
      });
    });
    container.querySelectorAll('[data-view-own-submission]').forEach(function (box) {
      function viewOwnSubmission(event) {
        if (event && event.target.closest('button, a')) return;
        if (event) event.stopPropagation();
        var assignment = studentData.assignments.find(function (item) { return item.id === box.dataset.viewOwnSubmission; });
        var submission = studentData.submissions.find(function (item) { return item.assignmentId === box.dataset.viewOwnSubmission; });
        if (assignment && submission) openOwnSubmissionDetail(assignment, submission, container, tab);
      }
      box.addEventListener('click', viewOwnSubmission);
      box.addEventListener('keydown', function (event) {
        if (event.target !== box || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        viewOwnSubmission(event);
      });
    });
    container.querySelectorAll('[data-delete-submission]').forEach(function (button) {
      button.addEventListener('click', function () { deleteSubmission(button.dataset.deleteSubmission, container, tab); });
    });
    container.querySelectorAll('[data-select-board]').forEach(function (button) {
      button.addEventListener('click', function () {
        selectedBoards[studentData.classInfo.id] = button.dataset.selectBoard;
        paintClass(container, tab, session);
      });
    });
    container.querySelectorAll('[data-student-card]').forEach(function (tile) {
      function activate(event) {
        if (event && event.target.closest('button, a, input, textarea, select, label')) return;
        var mine = tile.dataset.studentCard === session.user.id;
        var boardId = selectedBoards[studentData.classInfo.id];
        var board = studentData.boards.find(function (item) { return item.id === boardId; });
        var post = studentData.boardPosts.find(function (item) { return item.id === tile.dataset.postId; });
        if (post) {
          openBoardPost(post, board, mine, container, tab);
        } else if (mine && board.status === 'open') {
          openBoardEditor(board, post, container, tab);
        }
      }
      tile.addEventListener('click', activate);
      tile.addEventListener('keydown', function (event) {
        if (event.target === tile && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          activate(event);
        }
      });
    });
  }

  function openOwnSubmissionDetail(assignment, submission, container, tab) {
    var open = assignment.status === 'open';
    var context = {
      heading: '내가 작성한 글',
      meta: assignment.title,
      text: submission.text || ''
    };
    var dialog = UI.modal({
      title: assignment.title + ' · 내 제출물',
      wide: true,
      html:
        '<div class="detail-meta"><span class="status-badge submitted">제출 완료</span>' +
          '<span>제출 ' + UI.escape(UI.date(submission.submittedAt, true)) + '</span>' +
          (submission.updatedAt !== submission.submittedAt ? '<span>수정 ' + UI.escape(UI.date(submission.updatedAt, true)) + '</span>' : '') +
        '</div>' +
        '<section class="submission-detail-section"><h3>작성한 글</h3>' +
          '<div class="detail-body">' + (submission.text ? UI.nl2br(submission.text) : '<span class="muted-text">작성한 글 없이 파일만 제출했어요.</span>') + '</div></section>' +
        '<section class="submission-detail-section"><h3>첨부파일</h3>' +
          (UI.attachmentGallery(submission.attachments, 'student', { context: context }) || '<p class="muted-text">첨부한 파일이 없어요.</p>') +
        '</section>' +
        (open ? '<div class="modal-actions"><button class="button small" type="button" data-edit-own-submission>제출 수정</button></div>' : '')
    });
    UI.bindFiles(dialog, 'student');
    var edit = dialog.querySelector('[data-edit-own-submission]');
    if (edit) edit.addEventListener('click', function () {
      openSubmissionEditor(assignment, submission, container, tab);
    });
  }

  function uploadFields(existing, textValue, label) {
    return '<div class="field"><label for="student-text">' + UI.escape(label) + '</label>' +
      '<textarea id="student-text" name="text" maxlength="5000" placeholder="내용을 입력하세요.">' + UI.escape(textValue || '') + '</textarea></div>' +
      '<div class="field"><span class="field-label">첨부파일</span>' +
        '<label class="file-drop" data-file-drop><input type="file" multiple data-file-input>' +
          '<strong>파일을 끌어놓거나 눌러서 선택</strong><span>이미지, 영상, PDF, Word 등 · 파일당 최대 ' +
            UI.escape((window.LEARN_CONFIG || {}).maxFileSizeMb || 25) + 'MB</span></label>' +
        '<div class="selected-files" data-selected-files></div></div>';
  }

  function openSubmissionEditor(assignment, submission, container, tab) {
    var dialog = UI.modal({
      title: assignment.title + (submission ? ' 수정' : ' 제출'),
      html:
        '<form class="form-stack" data-submission-form>' +
          '<div class="info-box">제출한 내용과 파일은 선생님과 나만 확인할 수 있어요.</div>' +
          uploadFields(submission ? submission.attachments : [], submission ? submission.text : '', '제출 내용') +
          '<div class="modal-actions"><button class="button secondary" type="button" data-cancel>취소</button>' +
            '<button class="button" type="submit">' + (submission ? '수정해서 제출' : '제출하기') + '</button></div>' +
        '</form>'
    });
    var picker = UI.filePicker(dialog, submission ? submission.attachments : []);
    dialog.querySelector('[data-cancel]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-submission-form]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var text = String(new FormData(form).get('text') || '').trim();
      if (!text && !picker.files().length && !picker.keepAttachmentIds().length) {
        UI.toast('내용이나 파일을 하나 이상 제출해 주세요.', 'error');
        return;
      }
      var button = form.querySelector('[type="submit"]');
      UI.busy(button, true, '제출 중…');
      try {
        var files = await window.LearnFiles.toPayload(picker.files());
        await API.request('upsertSubmission', {
          assignmentId: assignment.id,
          text: text,
          files: files,
          keepAttachmentIds: picker.keepAttachmentIds()
        }, 'student', 0);
        UI.closeModal();
        UI.toast(submission ? '제출물을 수정했습니다.' : '과제를 제출했습니다.');
        renderClass(container, tab);
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(button, false);
      }
    });
  }

  async function deleteSubmission(assignmentId, container, tab) {
    var yes = await UI.confirm({
      title: '제출물 삭제',
      message: '작성한 내용과 첨부파일이 모두 삭제됩니다.',
      confirmText: '제출 삭제',
      danger: true
    });
    if (!yes) return;
    try {
      await API.request('deleteSubmission', { assignmentId: assignmentId }, 'student');
      UI.toast('제출물을 삭제했습니다.');
      renderClass(container, tab);
    } catch (error) {
      UI.toast(error.message, 'error');
    }
  }

  function openBoardEditor(board, post, container, tab) {
    var dialog = UI.modal({
      title: board.title + ' · 내 카드',
      html:
        (post && post.status === 'revision' ? '<div class="revision-note"><strong>선생님이 수정을 요청했어요.</strong><br>내용이나 첨부파일을 고친 뒤 다시 게시해 주세요.</div>' : '') +
        '<form class="form-stack" data-board-form style="margin-top:16px">' +
          uploadFields(post ? post.attachments : [], post ? post.text : '', '게시글 내용') +
          '<div class="modal-actions">' +
            (post ? '<button class="button danger" type="button" data-delete-my-post>내 글 삭제</button>' : '') +
            '<button class="button secondary" type="button" data-cancel>취소</button>' +
            '<button class="button" type="submit">' + (post ? '수정해서 게시' : '게시하기') + '</button></div>' +
        '</form>'
    });
    var picker = UI.filePicker(dialog, post ? post.attachments : []);
    dialog.querySelector('[data-cancel]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-board-form]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var text = String(new FormData(form).get('text') || '').trim();
      if (!text && !picker.files().length && !picker.keepAttachmentIds().length) {
        UI.toast('내용이나 파일을 하나 이상 게시해 주세요.', 'error');
        return;
      }
      var button = form.querySelector('[type="submit"]');
      UI.busy(button, true, '게시 중…');
      try {
        var files = await window.LearnFiles.toPayload(picker.files());
        await API.request('upsertBoardPost', {
          boardId: board.id,
          text: text,
          files: files,
          keepAttachmentIds: picker.keepAttachmentIds()
        }, 'student', 0);
        UI.closeModal();
        UI.toast(post ? '게시글을 수정했습니다.' : '내 카드에 게시했습니다.');
        renderClass(container, tab);
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(button, false);
      }
    });
    var deleteButton = dialog.querySelector('[data-delete-my-post]');
    if (deleteButton) deleteButton.addEventListener('click', async function () {
      var yes = await UI.confirm({
        title: '내 게시글 삭제',
        message: '내용과 첨부파일이 모두 삭제됩니다.',
        confirmText: '삭제',
        danger: true
      });
      if (!yes) return;
      try {
        await API.request('deleteBoardPost', { postId: post.id }, 'student');
        UI.closeModal();
        UI.toast('게시글을 삭제했습니다.');
        renderClass(container, tab);
      } catch (error) {
        UI.toast(error.message, 'error');
      }
    });
  }

  function openBoardPost(post, board, mine, container, tab) {
    var privateState = '';
    if (mine && post.status === 'revision') {
      privateState = '<div class="moderation-state revision"><strong>수정이 필요해요</strong>' +
        '<span>이 안내는 선생님과 나에게만 보여요.</span></div>';
    }
    if (mine && post.status === 'confirmed') {
      privateState = '<div class="moderation-state confirmed"><strong>선생님 확인 완료</strong>' +
        '<span>이 안내는 선생님과 나에게만 보여요.</span></div>';
    }
    var dialog = UI.modal({
      title: post.studentNumber + '번 ' + post.studentName,
      wide: true,
      html:
        privateState +
        '<div class="meta-line"><span>게시 ' + UI.escape(UI.date(post.createdAt, true)) + '</span>' +
          (post.updatedAt !== post.createdAt ? '<span>수정 ' + UI.escape(UI.date(post.updatedAt, true)) + '</span>' : '') +
        '</div>' +
        '<div class="detail-body">' + (post.text ? UI.nl2br(post.text) : '<span class="muted-text">작성된 글 없이 파일만 게시했어요.</span>') + '</div>' +
        UI.attachmentGallery(post.attachments, 'student', { context: {
          heading: post.studentNumber + '번 ' + post.studentName + '의 글',
          meta: board.title,
          text: post.text || ''
        } }) +
        (mine && board.status === 'open' ? '<div class="post-owner-actions"><button class="button ghost small" type="button" data-edit-my-post>수정</button></div>' : '')
    });
    UI.bindFiles(dialog, 'student');
    var edit = dialog.querySelector('[data-edit-my-post]');
    if (edit) edit.addEventListener('click', function () { openBoardEditor(board, post, container, tab); });
  }

  function startHeartbeat(classId) {
    stopHeartbeat();
    function beat() {
      API.request('heartbeat', { classId: classId }, 'student', 1).catch(function () {});
    }
    beat();
    heartbeatTimer = window.setInterval(beat, 45000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  window.StudentViews = {
    classPage: renderClass,
    stop: stopHeartbeat
  };
})();
