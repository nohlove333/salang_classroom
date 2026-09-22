(function () {
  'use strict';

  var table = (function () {
    var values = new Uint32Array(256);
    for (var n = 0; n < 256; n += 1) {
      var current = n;
      for (var k = 0; k < 8; k += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
      values[n] = current >>> 0;
    }
    return values;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function write16(view, offset, value) { view.setUint16(offset, value, true); }
  function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

  function dosDateTime(date) {
    var year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function concat(parts, total) {
    var output = new Uint8Array(total);
    var offset = 0;
    parts.forEach(function (part) { output.set(part, offset); offset += part.length; });
    return output;
  }

  function makeZip(files) {
    var utf8 = new TextEncoder();
    var localParts = [];
    var centralParts = [];
    var localSize = 0;
    var centralSize = 0;
    var stamp = dosDateTime(new Date());

    files.forEach(function (file) {
      var name = utf8.encode(String(file.name || '첨부파일'));
      var data = file.data;
      var checksum = crc32(data);
      var local = new Uint8Array(30 + name.length);
      var localView = new DataView(local.buffer);
      write32(localView, 0, 0x04034b50);
      write16(localView, 4, 20);
      write16(localView, 6, 0x0800);
      write16(localView, 8, 0);
      write16(localView, 10, stamp.time);
      write16(localView, 12, stamp.date);
      write32(localView, 14, checksum);
      write32(localView, 18, data.length);
      write32(localView, 22, data.length);
      write16(localView, 26, name.length);
      write16(localView, 28, 0);
      local.set(name, 30);

      var central = new Uint8Array(46 + name.length);
      var centralView = new DataView(central.buffer);
      write32(centralView, 0, 0x02014b50);
      write16(centralView, 4, 20);
      write16(centralView, 6, 20);
      write16(centralView, 8, 0x0800);
      write16(centralView, 10, 0);
      write16(centralView, 12, stamp.time);
      write16(centralView, 14, stamp.date);
      write32(centralView, 16, checksum);
      write32(centralView, 20, data.length);
      write32(centralView, 24, data.length);
      write16(centralView, 28, name.length);
      write16(centralView, 30, 0);
      write16(centralView, 32, 0);
      write16(centralView, 34, 0);
      write16(centralView, 36, 0);
      write32(centralView, 38, 0);
      write32(centralView, 42, localSize);
      central.set(name, 46);

      localParts.push(local, data);
      centralParts.push(central);
      localSize += local.length + data.length;
      centralSize += central.length;
    });

    var end = new Uint8Array(22);
    var endView = new DataView(end.buffer);
    write32(endView, 0, 0x06054b50);
    write16(endView, 4, 0);
    write16(endView, 6, 0);
    write16(endView, 8, files.length);
    write16(endView, 10, files.length);
    write32(endView, 12, centralSize);
    write32(endView, 16, localSize);
    write16(endView, 20, 0);
    return concat(localParts.concat(centralParts, [end]), localSize + centralSize + end.length);
  }

  async function download(entries, zipName, onProgress) {
    var files = [];
    for (var index = 0; index < entries.length; index += 1) {
      if (onProgress) onProgress(index, entries.length, entries[index].name);
      var response = await fetch(entries[index].downloadUrl);
      if (!response.ok) throw new Error(entries[index].name + ' 파일을 불러오지 못했습니다.');
      files.push({ name: entries[index].name, data: new Uint8Array(await response.arrayBuffer()) });
    }
    if (onProgress) onProgress(entries.length, entries.length, 'ZIP 파일 만드는 중');
    var blob = new Blob([makeZip(files)], { type: 'application/zip' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = zipName || '전체_첨부파일.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  window.LearnZip = { download: download };
})();
