(function () {
  'use strict';

  var app = document.getElementById('app');
  var nav = document.querySelector('.top-nav');
  var menuButton = document.querySelector('[data-action="toggle-mobile-menu"]');
  var modeBanner = document.getElementById('mode-banner');
  var smartHome = document.querySelector('[data-smart-home]');
  var UI = window.LearnUI;
  var API = window.LearnAPI;
  var activeRoleKey = 'learn_active_role_v1';
  var teacherRouteKey = 'learn_last_teacher_route_v1';
  var studentRouteKey = 'learn_last_student_route_v1';

  function storageGet(key) {
    try { return localStorage.getItem(key) || ''; } catch (error) { return ''; }
  }

  function storageSet(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (error) {}
  }

  function hasSession(role) {
    var session = window.LearnSession.get(role);
    return Boolean(session && session.token);
  }

  function activateRole(role, route) {
    storageSet(activeRoleKey, role);
    if (role === 'teacher') storageSet(teacherRouteKey, route || '#/teacher');
    if (role === 'student') storageSet(studentRouteKey, route || '#/student/class/announcements');
  }

  function clearRole(role) {
    storageSet(role === 'teacher' ? teacherRouteKey : studentRouteKey, '');
    if (storageGet(activeRoleKey) === role) storageSet(activeRoleKey, '');
  }

  function rememberProtectedRoute(parts) {
    if (parts[0] === 'teacher' && parts[1] !== 'login' && parts[1] !== 'signup' && hasSession('teacher')) {
      activateRole('teacher', location.hash || '#/teacher');
    }
    if (parts[0] === 'student' && parts[1] === 'class' && hasSession('student')) {
      activateRole('student', location.hash || '#/student/class/announcements');
    }
  }

  function studentResumeRoute() {
    var route = storageGet(studentRouteKey);
    return /^#\/student\/class\/(posts|announcements|assignments|boards)$/.test(route)
      ? route
      : '#/student/class/announcements';
  }

  function resumeRoute() {
    var activeRole = storageGet(activeRoleKey);
    if (activeRole === 'student' && hasSession('student')) return studentResumeRoute();
    if (activeRole === 'teacher' && hasSession('teacher')) return '#/teacher';
    if (hasSession('student')) return studentResumeRoute();
    if (hasSession('teacher')) return '#/teacher';
    return '#/';
  }

  function smartHomeRoute() {
    var parts = routeParts();
    if (parts[0] === 'student' && hasSession('student')) return studentResumeRoute();
    if (parts[0] === 'teacher' && hasSession('teacher')) return '#/teacher';
    return resumeRoute();
  }

  function routeParts() {
    var raw = location.hash.replace(/^#\/?/, '');
    return raw ? raw.split('/').filter(Boolean).map(decodeURIComponent) : [];
  }

  function updateHeader(parts) {
    var area = parts[0] || '';
    document.querySelectorAll('[data-role-link]').forEach(function (link) {
      var teacherArea = area === 'teacher';
      link.hidden = link.dataset.roleLink === 'teacher' ? !teacherArea : teacherArea;
      link.classList.toggle('active', link.dataset.roleLink === area);
    });
    if (nav) nav.classList.remove('open');
    if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
  }

  function cleanupViews() {
    if (window.TeacherViews) window.TeacherViews.stop();
    if (window.StudentViews) window.StudentViews.stop();
    UI.closeModal();
  }

  function render() {
    var parts = routeParts();
    rememberProtectedRoute(parts);
    updateHeader(parts);
    cleanupViews();

    if (!parts.length) {
      renderLanding();
    } else if (parts[0] === 'teacher' && parts[1] === 'login') {
      renderTeacherAuth(false);
    } else if (parts[0] === 'teacher' && parts[1] === 'signup') {
      renderTeacherAuth(true);
    } else if (parts[0] === 'teacher' && parts[1] === 'class' && parts[2]) {
      window.TeacherViews.classPage(app, parts[2], parts[3] || 'announcements');
    } else if (parts[0] === 'teacher' && parts.length === 1) {
      window.TeacherViews.dashboard(app);
    } else if (parts[0] === 'student' && parts[1] === 'login') {
      renderStudentLogin();
    } else if (parts[0] === 'student' && parts[1] === 'class') {
      window.StudentViews.classPage(app, parts[2] || 'announcements');
    } else {
      renderNotFound();
    }
    window.setTimeout(function () { app.focus({ preventScroll: true }); }, 0);
  }

  function renderLanding() {
    app.innerHTML =
      '<section class="page landing-page">' +
        '<div class="hero-copy-wrap">' +
          '<p class="eyebrow">Classroom archive</p>' +
          '<h1 class="hero-title">사랑스런<span class="learn">(Learn)</span><br>수업 시간</h1>' +
          '<p class="hero-copy">공지부터 과제 제출, 친구들과 함께 보는 보드까지. 선생님과 학생의 수업 기록을 한곳에 차곡차곡 모아요.</p>' +
          '<div class="role-actions">' +
            '<a class="button" href="#/student/login">학생으로 입장</a>' +
          '</div>' +
        '</div>' +
        '<div class="hero-board" aria-label="수업 사이트 화면 미리보기">' +
          '<div class="mini-browser">' +
            '<div class="browser-bar"><span class="browser-dot"></span><span class="browser-dot"></span><span class="browser-dot"></span></div>' +
            '<div class="preview-shell">' +
              '<div class="preview-nav"><div class="preview-logo"></div><div class="preview-line active"></div><div class="preview-line"></div><div class="preview-line short"></div></div>' +
              '<div class="preview-main"><div class="preview-kicker"></div><div class="preview-title"></div>' +
                '<div class="preview-cards"><div class="preview-card"><strong>Notice</strong><span></span><span></span></div>' +
                  '<div class="preview-card"><strong>Task</strong><span></span><span></span></div>' +
                  '<div class="preview-card"><strong>Board</strong><span></span><span></span></div>' +
                  '<div class="preview-card"><strong>Class</strong><span></span><span></span></div></div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="floating-note"><strong>Learn together!</strong><span>생각을 기록하고, 나누고, 함께 배워요.</span></div>' +
        '</div>' +
      '</section>';
  }

  function renderTeacherAuth(signup) {
    var existing = window.LearnSession.get('teacher');
    if (existing && existing.token && !signup) {
      location.hash = '#/teacher';
      return;
    }
    app.innerHTML =
      '<section class="auth-page">' +
        '<div class="auth-intro"><p class="eyebrow">For teacher</p>' +
          '<h1>' + (signup ? '선생님의 수업 공간을 만들어요.' : '수업의 모든 기록을 한눈에.') + '</h1>' +
          '<p>' + (signup
            ? '처음 한 번만 계정을 만들면 클래스와 학생, 과제 제출물을 계속 관리할 수 있어요.'
            : '클래스별 공지·과제·보드와 접속 중인 학생을 확인하세요.') + '</p></div>' +
        '<div class="auth-card"><h2>' + (signup ? '교사 회원가입' : '교사 로그인') + '</h2>' +
          '<p>' + (signup ? '이메일과 비밀번호를 입력해 주세요.' : '등록한 교사 계정으로 로그인하세요.') + '</p>' +
          '<form class="form-stack" data-teacher-auth>' +
            '<div class="field"><label for="teacher-email">이메일</label><input id="teacher-email" name="email" type="email" autocomplete="email" required></div>' +
            '<div class="field"><label for="teacher-password">비밀번호</label><input id="teacher-password" name="password" type="password" autocomplete="' +
              (signup ? 'new-password' : 'current-password') + '" minlength="8" required>' +
              (signup ? '<span class="field-help">영문과 숫자를 포함해 8자 이상으로 정해 주세요.</span>' : '') + '</div>' +
            (signup
              ? '<div class="field"><label for="teacher-password-confirm">비밀번호 확인</label><input id="teacher-password-confirm" name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" required></div>' +
                '<div class="field"><label for="setup-key">최초 가입 보안키</label><input id="setup-key" name="setupKey" type="password" autocomplete="off" required>' +
                  '<span class="field-help">Google Apps Script 설정 단계에서 선생님이 직접 정한 보안키입니다. 외부인이 교사 계정을 만드는 것을 막아 줍니다.</span></div>'
              : '') +
            (window.LEARN_CONFIG.demoMode ? '<div class="info-box">미리보기 모드에서는 아무 이메일과 비밀번호를 입력해도 입장할 수 있어요.</div>' : '') +
            '<button class="button" type="submit">' + (signup ? '계정 만들기' : '로그인') + '</button>' +
          '</form>' +
          '<div class="auth-switch">' + (signup ? '이미 계정이 있나요? ' : '처음 사용하시나요? ') +
            '<a class="text-link" href="' + (signup ? '#/teacher/login' : '#/teacher/signup') + '">' +
              (signup ? '로그인' : '교사 회원가입') + '</a></div>' +
        '</div>' +
      '</section>';
    app.querySelector('[data-teacher-auth]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var values = new FormData(form);
      var password = String(values.get('password') || '');
      if (signup && password !== String(values.get('passwordConfirm') || '')) {
        UI.toast('비밀번호 확인이 일치하지 않습니다.', 'error');
        return;
      }
      var button = form.querySelector('[type="submit"]');
      UI.busy(button, true, signup ? '계정 만드는 중…' : '로그인 중…');
      try {
        var result = await API.request(signup ? 'teacherSignup' : 'teacherLogin', {
          email: String(values.get('email') || '').trim().toLowerCase(),
          password: password,
          setupKey: signup ? String(values.get('setupKey') || '') : ''
        });
        window.LearnSession.set('teacher', result);
        activateRole('teacher', '#/teacher');
        UI.toast(signup ? '교사 계정을 만들었습니다.' : '로그인했습니다.');
        location.hash = '#/teacher';
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(button, false);
      }
    });
  }

  function renderStudentLogin() {
    var existing = window.LearnSession.get('student');
    if (existing && existing.token) {
      location.hash = studentResumeRoute();
      return;
    }
    app.innerHTML =
      '<section class="auth-page">' +
        '<div class="auth-intro"><p class="eyebrow">For student</p>' +
          '<h1>우리 반 수업 공간으로 들어가요.</h1>' +
          '<p>선생님께 받은 클래스 코드, 출석번호, 4자리 비밀번호를 입력하세요.</p></div>' +
        '<div class="auth-card"><h2>학생 로그인</h2><p>내 정보는 우리 반 수업 공간에서만 사용돼요.</p>' +
          '<form class="form-stack" data-student-login>' +
            '<div class="field"><label for="student-class-code">클래스 코드</label><input id="student-class-code" name="classCode" autocomplete="off" required maxlength="16" placeholder="예: LOVE01"></div>' +
            '<div class="form-row">' +
              '<div class="field"><label for="student-number">출석번호</label><input id="student-number" name="number" type="number" inputmode="numeric" min="1" max="999" required placeholder="예: 7"></div>' +
              '<div class="field"><label for="student-pin">비밀번호</label><input id="student-pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" required placeholder="4자리"></div>' +
            '</div>' +
            (window.LEARN_CONFIG.demoMode ? '<div class="info-box">미리보기: 클래스 코드 LOVE01, 출석번호 1, 비밀번호는 아무 4자리 숫자를 입력하세요.</div>' : '') +
            '<button class="button" type="submit">우리 반 입장</button>' +
          '</form>' +
        '</div>' +
      '</section>';
    app.querySelector('[data-student-login]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var values = new FormData(form);
      var button = form.querySelector('[type="submit"]');
      UI.busy(button, true, '입장 확인 중…');
      try {
        var result = await API.request('studentLogin', {
          classCode: String(values.get('classCode') || '').trim().toUpperCase(),
          number: Number(values.get('number')),
          pin: String(values.get('pin') || '')
        });
        window.LearnSession.set('student', result);
        activateRole('student', '#/student/class/announcements');
        UI.toast(result.user.name + ' 학생, 반가워요!');
        location.hash = '#/student/class/announcements';
      } catch (error) {
        UI.toast(error.message, 'error');
        UI.busy(button, false);
      }
    });
  }

  function renderNotFound() {
    app.innerHTML = '<section class="page"><div class="panel">' +
      UI.empty('페이지를 찾을 수 없어요', '주소를 다시 확인하거나 첫 화면으로 돌아가 주세요.',
        '<a class="button" href="#/">첫 화면으로</a>') + '</div></section>';
  }

  if (menuButton) {
    menuButton.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      menuButton.setAttribute('aria-expanded', String(open));
    });
  }

  if (smartHome) {
    smartHome.addEventListener('click', function (event) {
      event.preventDefault();
      var target = smartHomeRoute();
      if (location.hash === target) render();
      else location.hash = target;
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') UI.closeModal();
  });

  modeBanner.hidden = !window.LEARN_CONFIG.demoMode;
  window.LearnNavigation = {
    activate: activateRole,
    clear: clearRole,
    resume: resumeRoute
  };
  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = resumeRoute();
  else render();
})();
