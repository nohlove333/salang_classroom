(function () {
  'use strict';

  var modalRoot = document.getElementById('modal-root');
  var toastRoot = document.getElementById('toast-root');
  var objectUrls = [];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function attr(value) {
    return escapeHtml(value);
  }

  function nl2br(value) {
    return escapeHtml(value).replace(/\n/g, '<br>');
  }

  function formatDate(value, includeTime) {
    if (!value) return '';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    var options = {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    };
    if (includeTime) {
      options.hour = '2-digit';
      options.minute = '2-digit';
    }
    return new Intl.DateTimeFormat('ko-KR', options).format(date);
  }

  function toLocalInput(value) {
    if (!value) return '';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    var local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function fileSize(bytes) {
    var value = Number(bytes || 0);
    if (!value) return '';
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fileGlyph(file) {
    var type = String(file && file.mimeType || '').toLowerCase();
    var name = String(file && file.name || '').toLowerCase();
    if (type.indexOf('image/') === 0) return '▧';
    if (type.indexOf('video/') === 0) return '▶';
    if (type.indexOf('pdf') >= 0 || name.endsWith('.pdf')) return 'PDF';
    if (name.endsWith('.doc') || name.endsWith('.docx')) return 'W';
    if (name.endsWith('.ppt') || name.endsWith('.pptx')) return 'P';
    return '↧';
  }

  function attachmentList(files, role, allowRemove) {
    var list = files || [];
    if (!list.length) return '';
    return '<div class="attachment-list">' + list.map(function (file) {
      var remove = allowRemove
        ? '<button type="button" class="attachment-remove" data-remove-attachment="' + attr(file.id) + '" aria-label="' + attr(file.name) + ' 제거">×</button>'
        : '';
      return '<button type="button" class="attachment-chip" data-file-id="' + attr(file.id) +
        '" data-file-role="' + attr(role || '') + '" data-file-json="' + attr(encodeURIComponent(JSON.stringify(file))) + '">' +
        '<strong>' + escapeHtml(fileGlyph(file)) + '</strong><span>' + escapeHtml(file.name) + '</span>' +
        (file.size ? '<small>' + escapeHtml(fileSize(file.size)) + '</small>' : '') + remove + '</button>';
    }).join('') + '</div>';
  }

  function toast(message, type) {
    var element = document.createElement('div');
    element.className = 'toast' + (type === 'error' ? ' error' : '');
    element.textContent = message;
    toastRoot.appendChild(element);
    window.setTimeout(function () {
      element.style.opacity = '0';
      element.style.transform = 'translateY(8px)';
      window.setTimeout(function () { element.remove(); }, 180);
    }, type === 'error' ? 5200 : 3000);
  }

  function clearObjectUrls() {
    objectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    objectUrls = [];
  }

  function closeModal() {
    clearObjectUrls();
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
  }

  function openModal(options) {
    closeModal();
    var wide = options.wide ? ' wide' : '';
    modalRoot.innerHTML =
      '<div class="modal-backdrop" data-modal-backdrop>' +
        '<section class="modal' + wide + '" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
          '<header class="modal-head">' +
            '<h2 id="modal-title">' + escapeHtml(options.title || '') + '</h2>' +
            '<button class="icon-button" type="button" data-close-modal aria-label="창 닫기">×</button>' +
          '</header>' +
          '<div class="modal-body">' + (options.html || '') + '</div>' +
        '</section>' +
      '</div>';
    document.body.style.overflow = 'hidden';
    var close = modalRoot.querySelector('[data-close-modal]');
    if (close) close.addEventListener('click', closeModal);
    var backdrop = modalRoot.querySelector('[data-modal-backdrop]');
    if (backdrop && options.closeOnBackdrop !== false) {
      backdrop.addEventListener('click', function (event) {
        if (event.target === backdrop) closeModal();
      });
    }
    var dialog = modalRoot.querySelector('.modal');
    if (dialog) {
      var focusable = dialog.querySelector('input, textarea, select, button, [href]');
      if (focusable) window.setTimeout(function () { focusable.focus(); }, 20);
    }
    return dialog;
  }

  function confirmDialog(options) {
    return new Promise(function (resolve) {
      var dialog = openModal({
        title: options.title || '확인해 주세요',
        html:
          '<p style="margin:0;color:var(--muted);line-height:1.7">' + escapeHtml(options.message || '') + '</p>' +
          (options.inputLabel
            ? '<div class="field" style="margin-top:18px"><label for="confirm-input">' +
              escapeHtml(options.inputLabel) + '</label><input id="confirm-input" autocomplete="off"></div>'
            : '') +
          '<div class="modal-actions">' +
            '<button class="button secondary" type="button" data-confirm-no>취소</button>' +
            '<button class="button ' + (options.danger ? 'danger' : '') + '" type="button" data-confirm-yes>' +
              escapeHtml(options.confirmText || '확인') + '</button>' +
          '</div>'
      });
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        closeModal();
        resolve(value);
      }
      dialog.querySelector('[data-confirm-no]').addEventListener('click', function () { finish(null); });
      dialog.querySelector('[data-confirm-yes]').addEventListener('click', function () {
        var input = dialog.querySelector('#confirm-input');
        finish(input ? input.value : true);
      });
    });
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = label || '처리 중…';
    } else {
      button.disabled = false;
      button.textContent = button.dataset.originalLabel || button.textContent;
    }
  }

  function initFilePicker(dialog, initialFiles) {
    var input = dialog.querySelector('[data-file-input]');
    var drop = dialog.querySelector('[data-file-drop]');
    var list = dialog.querySelector('[data-selected-files]');
    var selected = [];
    var keepIds = (initialFiles || []).map(function (file) { return file.id; });
    var pickerPreviewUrls = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

    function selectedFileVisual(file) {
      if (String(file.type || '').indexOf('image/') !== 0) {
        return '<span class="selected-file-glyph">' + escapeHtml(fileGlyph({ name: file.name, mimeType: file.type })) + '</span>';
      }
      var url = pickerPreviewUrls && pickerPreviewUrls.get(file);
      if (!url) {
        url = URL.createObjectURL(file);
        objectUrls.push(url);
        if (pickerPreviewUrls) pickerPreviewUrls.set(file, url);
      }
      return '<img class="selected-file-preview" src="' + attr(url) + '" alt="">';
    }

    function paint() {
      if (!list) return;
      var oldItems = (initialFiles || []).filter(function (file) { return keepIds.indexOf(file.id) >= 0; }).map(function (file) {
        return '<div class="selected-file"><div class="selected-file-info"><span class="selected-file-glyph">' + escapeHtml(fileGlyph(file)) + '</span>' +
          '<span>기존 · ' + escapeHtml(file.name) + '</span></div>' +
          '<button type="button" data-remove-old="' + attr(file.id) + '">제거</button></div>';
      });
      var newItems = selected.map(function (file, index) {
        return '<div class="selected-file"><div class="selected-file-info">' + selectedFileVisual(file) +
          '<span><strong>새 파일</strong><br>' + escapeHtml(file.name) + ' · ' + escapeHtml(fileSize(file.size)) + '</span></div>' +
          '<button type="button" data-remove-new="' + index + '">제거</button></div>';
      });
      list.innerHTML = oldItems.concat(newItems).join('');
      list.querySelectorAll('[data-remove-old]').forEach(function (button) {
        button.addEventListener('click', function () {
          keepIds = keepIds.filter(function (id) { return id !== button.dataset.removeOld; });
          paint();
        });
      });
      list.querySelectorAll('[data-remove-new]').forEach(function (button) {
        button.addEventListener('click', function () {
          selected.splice(Number(button.dataset.removeNew), 1);
          paint();
        });
      });
    }

    function addFiles(files) {
      Array.from(files || []).forEach(function (file) {
        var duplicate = selected.some(function (item) {
          return item.name === file.name && item.size === file.size;
        });
        if (!duplicate) selected.push(file);
      });
      paint();
    }

    if (input) input.addEventListener('change', function () { addFiles(input.files); });
    if (drop) {
      ['dragenter', 'dragover'].forEach(function (eventName) {
        drop.addEventListener(eventName, function (event) {
          event.preventDefault();
          drop.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(function (eventName) {
        drop.addEventListener(eventName, function (event) {
          event.preventDefault();
          drop.classList.remove('dragover');
        });
      });
      drop.addEventListener('drop', function (event) { addFiles(event.dataTransfer.files); });
    }
    paint();
    return {
      files: function () { return selected.slice(); },
      keepAttachmentIds: function () { return keepIds.slice(); }
    };
  }

  function blobUrlFromBase64(file) {
    var binary = atob(file.data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType || 'application/octet-stream' }));
    objectUrls.push(url);
    return url;
  }

  async function resolveFileUrl(file, role) {
    if (file.publicUrl) return file.publicUrl;
    try {
      var response = await window.LearnAPI.request('getFileContent', { fileId: file.id }, role);
      return blobUrlFromBase64(response);
    } catch (error) {
      if (error.code !== 'FILE_PREVIEW_TOO_LARGE') throw error;
      var access = await window.LearnAPI.request('prepareFileAccess', { fileId: file.id }, role);
      return access.data ? blobUrlFromBase64(access) : access.publicUrl;
    }
  }

  async function temporaryAccess(file, role) {
    if (file.downloadUrl || file.previewUrl || file.publicUrl) return file;
    return window.LearnAPI.request('prepareFileAccess', { fileId: file.id }, role);
  }

  async function downloadAttachment(file, role) {
    var pendingWindow = null;
    try {
      if (file.downloadUrl) {
        var anchor = document.createElement('a');
        anchor.href = file.downloadUrl;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        anchor.download = file.name || '';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        return;
      }
      pendingWindow = window.open('about:blank', '_blank');
      if (pendingWindow) {
        pendingWindow.document.write('<!doctype html><meta charset="utf-8"><title>파일 준비 중</title><p style="font-family:sans-serif;padding:32px">파일을 준비하고 있어요. 이 창을 잠시 그대로 두세요.</p>');
      }
      var access = await temporaryAccess(file, role);
      if (access.data) {
        if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
        window.LearnFiles.saveBase64(access);
        return;
      }
      if (!access.downloadUrl) throw new Error('다운로드 주소를 만들지 못했습니다.');
      if (pendingWindow && !pendingWindow.closed) {
        pendingWindow.location.href = access.downloadUrl;
        return;
      }
      var link = document.createElement('a');
      link.href = access.downloadUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.download = access.name || file.name || '';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      if (pendingWindow && !pendingWindow.closed) pendingWindow.close();
      toast(error.message || '파일을 내려받지 못했습니다.', 'error');
    }
  }

  async function previewAttachment(file, role) {
    var mime = String(file.mimeType || '').toLowerCase();
    var name = String(file.name || '').toLowerCase();
    var isImage = mime.indexOf('image/') === 0;
    var isVideo = mime.indexOf('video/') === 0;
    var isPdf = mime.indexOf('pdf') >= 0 || name.endsWith('.pdf');
    var isOffice = /\.(doc|docx|ppt|pptx|xls|xlsx)$/i.test(name);
    var dialog = openModal({
      title: file.name || '첨부파일 미리보기',
      wide: true,
      html: '<div class="preview-stage"><div class="loader"></div></div>' +
        '<div class="modal-actions"><button class="button secondary" type="button" data-download-file>컴퓨터에 저장</button></div>'
    });
    dialog.querySelector('[data-download-file]').addEventListener('click', function () {
      downloadAttachment(file, role);
    });
    var stage = dialog.querySelector('.preview-stage');
    try {
      if (isImage) {
        var imageUrl = await resolveFileUrl(file, role);
        stage.innerHTML =
          '<div class="preview-toolbar">' +
            '<button type="button" data-zoom-out aria-label="축소">−</button>' +
            '<button type="button" data-zoom-reset aria-label="원래 크기">1:1</button>' +
            '<button type="button" data-zoom-in aria-label="확대">＋</button>' +
          '</div><img alt="' + attr(file.name) + '" draggable="false">';
        var image = stage.querySelector('img');
        image.src = imageUrl;
        initImagePanZoom(stage, image);
      } else if (isVideo) {
        var videoAccess = await temporaryAccess(file, role);
        var videoUrl = videoAccess.data
          ? blobUrlFromBase64(videoAccess)
          : (videoAccess.publicUrl || videoAccess.downloadUrl);
        stage.innerHTML = '<video controls playsinline src="' + attr(videoUrl) + '"></video>';
      } else if (isPdf) {
        var documentAccess = await temporaryAccess(file, role);
        var documentUrl = documentAccess.data
          ? blobUrlFromBase64(documentAccess)
          : documentAccess.previewUrl;
        if (!documentUrl) throw new Error('미리보기 주소를 만들지 못했습니다.');
        stage.innerHTML = '<iframe src="' + attr(documentUrl) + '" title="' + attr(file.name) + ' 미리보기" allow="autoplay"></iframe>';
      } else if (isOffice) {
        var officeAccess = await temporaryAccess(file, role);
        if (officeAccess.previewUnsupported || !officeAccess.previewUrl) {
          stage.innerHTML =
            '<div class="preview-message"><strong>이 파일은 저장해서 확인해 주세요.</strong>' +
              '<p>Word·PowerPoint·Excel 파일은 미리보기 모드에서 바로 열리지 않아요. 실제 수업 모드에서는 Google Drive 미리보기가 연결됩니다.</p>' +
              '<button class="button secondary" type="button" data-stage-download>컴퓨터에 저장</button>' +
            '</div>';
          stage.querySelector('[data-stage-download]').addEventListener('click', function () {
            downloadAttachment(file, role);
          });
        } else {
          stage.innerHTML = '<iframe src="' + attr(officeAccess.previewUrl) + '" title="' + attr(file.name) + ' 미리보기" allow="autoplay"></iframe>';
        }
      } else {
        stage.innerHTML =
          '<div style="padding:30px;color:white;text-align:center">' +
            '<p>이 파일은 브라우저에서 바로 미리볼 수 없습니다.</p>' +
            '<button class="button secondary" type="button" data-stage-download>컴퓨터에 저장</button>' +
          '</div>';
        stage.querySelector('[data-stage-download]').addEventListener('click', function () {
          downloadAttachment(file, role);
        });
      }
    } catch (error) {
      stage.innerHTML = '<div class="error-box">미리보기를 불러오지 못했습니다. 아래 저장 버튼을 이용해 주세요.</div>';
    }
  }

  function initImagePanZoom(stage, image) {
    var scale = 1;
    var x = 0;
    var y = 0;
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    function paint() {
      image.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')';
    }
    function changeZoom(amount) {
      scale = Math.max(0.5, Math.min(5, scale + amount));
      if (scale <= 1) { x = 0; y = 0; }
      paint();
    }
    stage.querySelector('[data-zoom-in]').addEventListener('click', function () { changeZoom(0.25); });
    stage.querySelector('[data-zoom-out]').addEventListener('click', function () { changeZoom(-0.25); });
    stage.querySelector('[data-zoom-reset]').addEventListener('click', function () {
      scale = 1; x = 0; y = 0; paint();
    });
    stage.addEventListener('wheel', function (event) {
      event.preventDefault();
      changeZoom(event.deltaY < 0 ? 0.18 : -0.18);
    }, { passive: false });
    image.addEventListener('pointerdown', function (event) {
      if (scale <= 1) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      image.setPointerCapture(event.pointerId);
      image.classList.add('dragging');
    });
    image.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      x += event.clientX - lastX;
      y += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      paint();
    });
    image.addEventListener('pointerup', function () {
      dragging = false;
      image.classList.remove('dragging');
    });
  }

  function bindAttachmentClicks(root, fallbackRole) {
    (root || document).querySelectorAll('[data-file-json]').forEach(function (button) {
      button.addEventListener('click', function (event) {
        if (event.target.closest('[data-remove-attachment]')) return;
        try {
          var file = JSON.parse(decodeURIComponent(button.dataset.fileJson));
          previewAttachment(file, button.dataset.fileRole || fallbackRole);
        } catch (error) {
          toast('첨부파일 정보를 읽지 못했습니다.', 'error');
        }
      });
    });
  }

  function emptyState(title, message, actionHtml) {
    return '<div class="empty-state">' +
      '<div class="empty-graphic">+</div>' +
      '<h3>' + escapeHtml(title) + '</h3>' +
      '<p>' + escapeHtml(message) + '</p>' +
      (actionHtml || '') +
    '</div>';
  }

  window.LearnUI = {
    escape: escapeHtml,
    attr: attr,
    nl2br: nl2br,
    date: formatDate,
    localDateTime: toLocalInput,
    size: fileSize,
    attachments: attachmentList,
    toast: toast,
    modal: openModal,
    closeModal: closeModal,
    confirm: confirmDialog,
    busy: setBusy,
    filePicker: initFilePicker,
    previewFile: previewAttachment,
    downloadFile: downloadAttachment,
    bindFiles: bindAttachmentClicks,
    empty: emptyState
  };
})();
