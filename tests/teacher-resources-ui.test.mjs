import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Test the real view/controller with small event targets, without a browser.
class Element {
  constructor() { this.innerHTML = ''; this.dataset = {}; this.style = {}; this.events = {}; this.children = new Map(); }
  addEventListener(name, fn) { this.events[name] = fn; }
  querySelector(selector) {
    const attribute = selector.slice(1, -1).split('=')[0];
    if (!this.innerHTML.includes(attribute)) return null;
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  async trigger(name) { return this.events[name]({ currentTarget: this, preventDefault() {} }); }
}
const document = { getElementById: () => new Element(), addEventListener() {}, removeEventListener() {} };
const location = { hash: '#/teacher/resources' };
const calls = [];
let teacherToken = 'teacher-a';
let modal;
let modalHtml;
let formValues = {};
let items = [{ id: 'resource-1', title: '<資料>', category: '사회 1', body: '본문', links: [], attachments: [] }];
const window = {
  addEventListener() {},
  LearnSession: { get: () => teacherToken ? { token: teacherToken } : null },
  LearnSync: { start() { throw new Error('Resource room must not poll'); } },
  LearnFiles: { async toPayload() { return []; } },
  LearnAPI: { async request(action, payload, role) {
    calls.push({ action, payload, role });
    assert.equal(role, 'teacher');
    if (action === 'getTeacherResources') return {
      items: items.filter((item) => (payload.category == null || item.category === payload.category) &&
        (!payload.search || item.title.toLocaleLowerCase().startsWith(payload.search.toLocaleLowerCase()))),
      categories: ['사회 1', 'uncategorized', '새 분류 <학습지>'], nextCursor: null
    };
    if (action === 'upsertTeacherResource') { items = [{ ...payload, id: 'saved', attachments: [] }]; return items[0]; }
    throw new Error(action);
  } }
};
const context = vm.createContext({ window, document, location, URL, console, FormData: class { get(key) { return formValues[key]; } } });
vm.runInContext(await readFile(new URL('../public/ui.js', import.meta.url), 'utf8'), context);
window.LearnUI.bindFiles = () => {};
window.LearnUI.toast = () => {};
window.LearnUI.closeModal = () => {};
window.LearnUI.filePicker = () => ({ files: () => [], keepAttachmentIds: () => [] });
window.LearnUI.modal = ({ html }) => {
  modalHtml = html;
  modal = new Element();
  modal.innerHTML = html;
  const form = modal.querySelector('[data-resource-form]');
  form.innerHTML = html;
  return modal;
};
vm.runInContext(await readFile(new URL('../public/teacher.js', import.meta.url), 'utf8'), context);
const container = new Element();
await window.TeacherViews.resourcesPage(container);
assert.equal(calls.at(-1).payload.category, null);
assert.ok(container.innerHTML.includes('&lt;資料&gt;'));
assert.ok(container.innerHTML.includes('새 분류 &lt;학습지&gt;'));
let filter = container.querySelector('[data-resource-category-filter]');
filter.value = 'category:uncategorized';
await filter.trigger('change');
await new Promise(setImmediate);
assert.equal(calls.at(-1).payload.category, 'uncategorized');
assert.equal(calls.at(-1).payload.cursor, null);
assert.ok(container.innerHTML.includes('이 카테고리에 자료가 없어요'));
filter = container.querySelector('[data-resource-category-filter]');
filter.value = 'uncategorized';
await filter.trigger('change');
await new Promise(setImmediate);
assert.equal(calls.at(-1).payload.category, '');
filter.value = 'category:사회 1';
await filter.trigger('change');
await new Promise(setImmediate);
await container.querySelector('[data-add-resource]').trigger('click');
assert.match(modalHtml, /name="category"[^>]*value="사회 1"/);
assert.ok(modalHtml.includes('새 분류 &lt;학습지&gt;'));
formValues = { title: '새 자료', category: '  새 카테고리  ', body: '메모', links: 'https://example.com/' };
await modal.querySelector('[data-resource-form]').trigger('submit');
await new Promise(setImmediate);
assert.equal(calls.find((call) => call.action === 'upsertTeacherResource').payload.category, '새 카테고리');
assert.equal(calls.at(-1).payload.category, '새 카테고리');
assert.ok(container.innerHTML.includes('새 카테고리'));
formValues = { search: '새' };
await container.querySelector('[data-resource-search-form]').trigger('submit');
await new Promise(setImmediate);
assert.equal(calls.at(-1).payload.search, '새');
assert.equal(calls.at(-1).payload.category, '새 카테고리', 'title search is combined with category selection');
assert.ok(container.innerHTML.includes('value="새"'));
// Changing accounts resets the previous account's filter and suggestions.
teacherToken = 'teacher-b';
await window.TeacherViews.resourcesPage(container);
assert.equal(calls.at(-1).payload.category, null);
assert.equal(calls.at(-1).payload.search, '');
teacherToken = '';
await window.TeacherViews.resourcesPage(container);
assert.equal(location.hash, '#/teacher/login');
console.log('PASS: category/search filters, empty category, creation form, save and filter selection, account reset, login redirect, no polling.');
