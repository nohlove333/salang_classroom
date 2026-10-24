import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor() { this.innerHTML = ''; this.events = {}; }
  addEventListener(name, callback) { this.events[name] = callback; }
  querySelectorAll() { return []; }
}

const modalRoot = new Element();
const toastRoot = new Element();
const document = {
  getElementById(id) { return id === 'modal-root' ? modalRoot : toastRoot; },
  addEventListener() {}
};
const context = vm.createContext({ window: {addEventListener(){}}, document, URL, console, setTimeout, clearTimeout, CustomEvent });
vm.runInContext(await readFile(new URL('../public/ui.js', import.meta.url), 'utf8'), context);
const input = new Element();
const drop = new Element();
const list = new Element();
const dialog = { querySelector(selector) {
  return selector === '[data-file-input]' ? input : selector === '[data-file-drop]' ? drop : list;
} };
const initialFiles = Array.from({ length: 4 }, (_, index) => ({
  id: 'old-' + index, name: '자료-' + index + '.pdf', mimeType: 'application/pdf', size: (index + 1) * 1024
}));
const picker = context.window.LearnUI.filePicker(dialog, initialFiles);
assert.match(list.innerHTML, /<details class="selected-files-fold">/, 'large attachment groups start folded');
assert.match(list.innerHTML, /첨부파일 4개 · 전체 10\.0 KB/);
assert.match(list.innerHTML, /1\.0 KB/, 'existing attachments show their stored size');
input.files = [{ name: '새 자료.pdf', type: 'application/pdf', size: 2048 }];
input.events.change();
assert.match(list.innerHTML, /첨부파일 5개 · 전체 12\.0 KB/);
assert.match(list.innerHTML, /새 자료\.pdf · 2\.0 KB/, 'new attachment size remains visible inside the fold');
assert.equal(picker.files().length, 1);
assert.equal(picker.keepAttachmentIds().length, 4, 'folding the display does not change retained attachment ids');
console.log('PASS: attachment sizes, aggregate size summary, foldable long lists, and retained file selection.');
