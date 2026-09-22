const DRIVE_FOLDER_ID = '1tQ1zNZTnlCQymzYAYL1HzjA4jjcuvwFb';
const SOURCE_ORIGIN = 'https://salang-classroom.nohlove333.workers.dev';

function doGet() {
  return jsonResponse_({
    ok: true,
    service: 'learn-drive-archive',
    folderReady: Boolean(DRIVE_FOLDER_ID)
  });
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const expectedKey = PropertiesService.getScriptProperties().getProperty('ARCHIVE_KEY') || '';
    if (!expectedKey || !safeEqual_(payload.archiveKey, expectedKey)) {
      return jsonResponse_({ ok: false, code: 'FORBIDDEN', message: '보관 인증키가 올바르지 않습니다.' });
    }

    const sourceUrl = String(payload.sourceUrl || '');
    if (!sourceUrl.startsWith(SOURCE_ORIGIN + '/api/file/')) {
      return jsonResponse_({ ok: false, code: 'INVALID_SOURCE', message: '허용되지 않은 파일 주소입니다.' });
    }

    const fileName = safeFileName_(payload.fileName || '보관파일');
    const response = UrlFetchApp.fetch(sourceUrl, {
      followRedirects: true,
      muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    if (status < 200 || status >= 300) {
      throw new Error('Cloudflare 파일을 불러오지 못했습니다. HTTP ' + status);
    }

    const blob = response.getBlob().setName(fileName);
    if (payload.mimeType) blob.setContentType(String(payload.mimeType));
    const driveFile = DriveApp.getFolderById(DRIVE_FOLDER_ID).createFile(blob);

    return jsonResponse_({
      ok: true,
      data: {
        driveFileId: driveFile.getId(),
        driveUrl: driveFile.getUrl(),
        name: driveFile.getName()
      }
    });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      code: 'ARCHIVE_FAILED',
      message: String((error && error.message) || error || 'Google Drive 보관에 실패했습니다.')
    });
  }
}

function safeEqual_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function safeFileName_(value) {
  return String(value || '보관파일')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || '보관파일';
}

function jsonResponse_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
