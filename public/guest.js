(function () {
  'use strict';

  var UI = window.LearnUI;
  var API = window.LearnAPI;
  var activeContainer = null;
  var activeCode = '';
  var activeTab = 'opinion';
  var roomData = null;
  var syncTimer = null;
  var syncBusy = false;

  function loading(container) {
    container.innerHTML = '<section class="loading-screen"><div class="loader"></div><p>QR 참여방으로 들어가고 있어요.</p></section>';
  }

  function errorScreen(container, error) {
    container.innerHTML = '<section class="page"><div class="panel empty-state"><div class="empty-graphic">!</div>' +
      '<h3>참여방에 들어갈 수 없어요</h3><p>' + UI.escape(error.message || '주소를 다시 확인해 주세요.') + '</p></div></section>';
  }

  async function ensureGuestSession(code) {
    var session = window.LearnSession.get('guest');
    if (session && session.token && session.room && session.room.code === code) return session;
    window.LearnSession.clear('guest');
    var joined = await API.request('joinGuestRoom', { code: code });
    window.LearnSession.set('guest', joined);
    return joined;
  }

  async function render(container, code, tab, forceRefresh) {
    stop();
    var normalizedCode = String(code || '').trim().toUpperCase();
    var canReuse = !forceRefresh && roomData && activeCode === normalizedCode;
    activeContainer = container;
    activeCode = normalizedCode;
    activeTab = ['opinion', 'board', 'cloud'].indexOf(tab) >= 0 ? tab : 'opinion';
    if (canReuse) {
      paint();
      startSync();
      refresh();
      return;
    }
    loading(container);
    try {
      await ensureGuestSession(activeCode);
      roomData = await API.request('getGuestRoom', {}, 'guest');
      paint();
      startSync();
    } catch (error) {
      errorScreen(container, error);
    }
  }

  function roomStatusLabel(status) {
    return status === 'open' ? '참여 가능' : (status === 'expired' ? '이용 시간 종료' : '참여 마감');
  }

  function tabLink(value, label, count) {
    return '<a class="tab-button ' + (activeTab === value ? 'active' : '') + '" href="#/guest/' + UI.attr(activeCode) + '/' + value + '">' +
      UI.escape(label) + '<span>' + UI.escape(count || 0) + '</span></a>';
  }

  function postCard(post) {
    return '<article class="guest-feed-card ' + (post.mine ? 'mine' : '') + '">' +
      '<div class="guest-feed-meta"><span>' + (post.mine ? '내가 올린 글' : '익명 참여자') + '</span><time>' + UI.escape(UI.date(post.updatedAt, true)) + '</time></div>' +
      (post.text ? '<p>' + UI.nl2br(post.text) + '</p>' : '') +
      UI.attachmentGallery(post.attachments || [], 'guest', { maxItems: 6, allowDownload: post.mine }) +
      (post.mine ? '<div class="guest-feed-actions"><button class="text-link" type="button" data-edit-guest-post="' + UI.attr(post.id) + '">수정</button>' +
        '<button class="text-link danger" type="button" data-delete-guest-post="' + UI.attr(post.id) + '">삭제</button></div>' : '') +
    '</article>';
  }

  function wordCloud(posts) {
    if (!posts.length) return UI.empty('첫 아이디어를 기다리고 있어요', '짧은 단어나 문구를 익명으로 올려 보세요.');
    var counts = {};
    posts.forEach(function (post) { var key = String(post.text || '').trim(); if (key) counts[key] = (counts[key] || 0) + 1; });
    var keys = Object.keys(counts);
    var max = Math.max.apply(Math, keys.map(function (key) { return counts[key]; }));
    return '<div class="guest-word-cloud">' + keys.map(function (word, index) {
      var size = 1 + (counts[word] / max) * 1.8;
      return '<span class="tone-' + (index % 5) + '" style="font-size:' + size.toFixed(2) + 'rem">' + UI.escape(word) +
        (counts[word] > 1 ? '<small>×' + counts[word] + '</small>' : '') + '</span>';
    }).join('') + '</div>' +
      '<div class="my-word-list">' + posts.filter(function (post) { return post.mine; }).map(function (post) {
        return '<span>내 아이디어 · ' + UI.escape(post.text) + '<button type="button" data-delete-guest-post="' + UI.attr(post.id) + '" aria-label="삭제">×</button></span>';
      }).join('') + '</div>';
  }

  function composeBox(open) {
    if (!open) return '<div class="room-closed-note">이 참여방은 새 글 접수가 끝났어요. 올라온 내용은 계속 볼 수 있어요.</div>';
    if (activeTab === 'board') {
      return '<div class="guest-compose board"><div><strong>파일이나 자료를 공유해요</strong><span>사진, 영상, PDF, Word 파일을 여러 개 올릴 수 있어요.</span></div>' +
        '<button class="button" type="button" data-new-board-post>＋ 파일 보드에 올리기</button></div>';
    }
    if (activeTab === 'cloud') {
      return '<form class="guest-compose inline" data-new-guest-post><input type="hidden" name="kind" value="word">' +
        '<label for="guest-word">떠오르는 단어나 짧은 문구</label><div><input id="guest-word" name="text" maxlength="30" required placeholder="예: 존중"><button class="button" type="submit">구름에 올리기</button></div></form>';
    }
    return '<form class="guest-compose inline opinion" data-new-guest-post><input type="hidden" name="kind" value="opinion">' +
      '<label for="guest-opinion">익명으로 의견을 나눠요</label><div><textarea id="guest-opinion" name="text" rows="2" maxlength="800" required placeholder="자유롭게 의견을 적어 주세요."></textarea>' +
      '<button class="button" type="submit">의견 올리기</button></div></form>';
  }

  function paint() {
    if (!activeContainer || !activeContainer.isConnected || !roomData) return;
    var room = roomData.room;
    var posts = roomData.posts || [];
    var opinions = posts.filter(function (post) { return post.kind === 'opinion'; });
    var boards = posts.filter(function (post) { return post.kind === 'board'; });
    var words = posts.filter(function (post) { return post.kind === 'word'; });
    var shown = activeTab === 'board' ? boards : opinions;
    var feed = activeTab === 'cloud' ? wordCloud(words) :
      (shown.length ? shown.slice().reverse().map(postCard).join('') : UI.empty(activeTab === 'board' ? '아직 공유된 파일이 없어요' : '아직 의견이 없어요', '첫 번째 익명 글을 남겨 보세요.'));
    activeContainer.innerHTML = '<section class="app-page guest-room-page public">' +
      '<header class="guest-public-head"><div><p class="section-kicker">Live participation</p><h1>' + UI.escape(room.title) + '</h1>' +
        '<p><span class="status-pill ' + UI.attr(room.status) + '">' + UI.escape(roomStatusLabel(room.status)) + '</span> · ' + UI.escape(UI.date(room.expiresAt, true)) + '까지</p></div>' +
        '<div class="guest-anonymous-badge"><strong>익명</strong><span>이름 없이 참여 중</span></div></header>' +
      '<nav class="tab-bar guest-room-tabs" aria-label="참여방 메뉴">' + tabLink('opinion', '의견 나눔', opinions.length) +
        tabLink('board', '파일 보드', boards.length) + tabLink('cloud', '아이디어 구름', words.length) + '</nav>' +
      composeBox(room.status === 'open') + '<section class="guest-feed ' + UI.attr(activeTab) + '">' + feed + '</section></section>';
    bindEvents();
    UI.bindFiles(activeContainer, 'guest');
  }

  function bindEvents() {
    activeContainer.querySelectorAll('[data-new-guest-post]').forEach(function (form) {
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        var values = new FormData(form);
        var button = form.querySelector('[type="submit"]');
        UI.busy(button, true, '올리는 중…');
        try {
          await API.request('upsertGuestPost', { kind: String(values.get('kind')), text: String(values.get('text') || '').trim() }, 'guest');
          await refresh(); UI.toast('익명으로 올렸습니다.');
        } catch (error) { UI.toast(error.message, 'error'); UI.busy(button, false); }
      });
    });
    var newBoard = activeContainer.querySelector('[data-new-board-post]');
    if (newBoard) newBoard.addEventListener('click', function () { openBoardEditor(null); });
    activeContainer.querySelectorAll('[data-edit-guest-post]').forEach(function (button) {
      button.addEventListener('click', function () {
        var post = (roomData.posts || []).find(function (item) { return item.id === button.dataset.editGuestPost; });
        if (post) post.kind === 'board' ? openBoardEditor(post) : openTextEditor(post);
      });
    });
    activeContainer.querySelectorAll('[data-delete-guest-post]').forEach(function (button) {
      button.addEventListener('click', function () { deletePost(button.dataset.deleteGuestPost); });
    });
  }

  function uploadFields(post) {
    return '<div class="field"><label for="guest-board-text">설명</label><textarea id="guest-board-text" name="text" rows="4" maxlength="2000" placeholder="파일에 대한 설명을 적어 주세요.">' + UI.escape(post && post.text || '') + '</textarea></div>' +
      '<div class="field"><label>첨부파일</label><label class="file-drop" data-file-drop><input type="file" data-file-input multiple hidden>' +
        '<strong>파일을 끌어놓거나 눌러서 선택</strong><span>이미지, 영상, PDF, Word 등 · 파일당 최대 25MB</span></label><div data-selected-files></div></div>';
  }

  function openBoardEditor(post) {
    var dialog = UI.modal({ title: post ? '내 파일 게시글 수정' : '파일 보드에 올리기', html:
      '<form class="form-stack" data-guest-board-form>' + uploadFields(post) +
      '<div class="modal-actions"><button class="button secondary" type="button" data-cancel>취소</button><button class="button" type="submit">' + (post ? '수정 저장' : '익명으로 올리기') + '</button></div></form>' });
    var picker = UI.filePicker(dialog, post ? post.attachments : []);
    dialog.querySelector('[data-cancel]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-guest-board-form]').addEventListener('submit', async function (event) {
      event.preventDefault();
      var text = String(new FormData(event.currentTarget).get('text') || '').trim();
      if (!text && !picker.files().length && !picker.keepAttachmentIds().length) { UI.toast('글이나 파일을 하나 이상 올려 주세요.', 'error'); return; }
      var button = event.currentTarget.querySelector('[type="submit"]'); UI.busy(button, true, '업로드 중…');
      try {
        var files = await window.LearnFiles.toPayload(picker.files());
        await API.request('upsertGuestPost', { kind: 'board', postId: post ? post.id : '', text: text, files: files, keepAttachmentIds: picker.keepAttachmentIds() }, 'guest', 0);
        UI.closeModal(); await refresh(); UI.toast(post ? '게시글을 수정했습니다.' : '파일 보드에 올렸습니다.');
      } catch (error) { UI.toast(error.message, 'error'); UI.busy(button, false); }
    });
  }

  function openTextEditor(post) {
    var max = post.kind === 'word' ? 30 : 800;
    var dialog = UI.modal({ title: '내 글 수정', html: '<form class="form-stack" data-edit-text><div class="field"><label for="edit-guest-text">내용</label>' +
      (post.kind === 'word' ? '<input id="edit-guest-text" name="text" maxlength="30" value="' + UI.attr(post.text) + '" required>' : '<textarea id="edit-guest-text" name="text" rows="5" maxlength="' + max + '" required>' + UI.escape(post.text) + '</textarea>') +
      '</div><div class="modal-actions"><button class="button secondary" type="button" data-cancel>취소</button><button class="button" type="submit">수정 저장</button></div></form>' });
    dialog.querySelector('[data-cancel]').addEventListener('click', UI.closeModal);
    dialog.querySelector('[data-edit-text]').addEventListener('submit', async function (event) {
      event.preventDefault(); var button = event.currentTarget.querySelector('[type="submit"]'); UI.busy(button, true, '저장 중…');
      try { await API.request('upsertGuestPost', { kind: post.kind, postId: post.id, text: String(new FormData(event.currentTarget).get('text') || '').trim() }, 'guest'); UI.closeModal(); await refresh(); UI.toast('내 글을 수정했습니다.'); }
      catch (error) { UI.toast(error.message, 'error'); UI.busy(button, false); }
    });
  }

  async function deletePost(postId) {
    var yes = await UI.confirm({ title: '내 글 삭제', message: '올린 글과 첨부파일을 삭제할까요?', confirmText: '삭제', danger: true });
    if (!yes) return;
    try { await API.request('deleteGuestPost', { postId: postId }, 'guest'); await refresh(); UI.toast('삭제했습니다.'); }
    catch (error) { UI.toast(error.message, 'error'); }
  }

  async function refresh() {
    if (syncBusy) return;
    syncBusy = true;
    var y = window.scrollY;
    try { roomData = await API.request('getGuestRoom', {}, 'guest', 1); paint(); window.requestAnimationFrame(function () { window.scrollTo(0, y); }); }
    catch (error) {
      if (error.code === 'ROOM_CLOSED') UI.toast(error.message, 'error');
    } finally { syncBusy = false; }
  }

  function startSync() {
    syncTimer = window.setInterval(refresh, 6000);
  }

  function stop() {
    if (syncTimer) window.clearInterval(syncTimer);
    syncTimer = null;
    syncBusy = false;
  }

  window.GuestViews = { room: render, stop: stop };
})();
