import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const storage = new Map([['learn_teacher_session_v1', JSON.stringify({ token: 'test-token' })]]);
const timers = new Map();
let nextTimer = 1;
const sockets = [];
class MockWebSocket {
  static OPEN = 1;
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = MockWebSocket.OPEN; sockets.push(this); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
const document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {}
};
const window = {
  LEARN_CONFIG: { apiUrl: 'https://classroom.example/api' },
  addEventListener() {},
  removeEventListener() {},
  setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); }
};
const localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
  get length() { return storage.size; },
  key(index) { return [...storage.keys()][index] || null; }
};
const context = vm.createContext({ window, document, localStorage, navigator: { onLine: true },
  location: { href: 'https://classroom.example/' }, URL, WebSocket: MockWebSocket,
  fetch: async () => { throw new Error('fetch is not expected'); }, console, Date, Math, Promise, setTimeout, clearTimeout });
vm.runInContext(await readFile(new URL('../public/api.js', import.meta.url), 'utf8'), context);

const changes = [];
const connection = window.LearnAPI.connectClassSync('teacher', 'class-1', (event) => changes.push(event));
assert.equal(sockets.length, 1);
sockets[0].onopen();
sockets[0].onmessage({ data: JSON.stringify({ type: 'class-changed', classId: 'class-1', version: 2, eventId: 'e1' }) });
sockets[0].onmessage({ data: JSON.stringify({ type: 'class-changed', classId: 'class-1', version: 2, eventId: 'e2' }) });
assert.equal(changes.length, 0, 'change messages should coalesce briefly');
const coalesced = [...timers.entries()].find(([, fn]) => fn);
assert.ok(coalesced);
timers.delete(coalesced[0]);
coalesced[1]();
assert.equal(changes.length, 1);
assert.ok(['reconnected', 'class-changed'].includes(changes[0].type));
sockets[0].onmessage({ data: JSON.stringify({ type: 'class-changed', classId: 'class-1', version: 3, eventId: 'e3' }) });
sockets[0].onmessage({ data: JSON.stringify({ type: 'class-changed', classId: 'class-1', version: 4, eventId: 'e4' }) });
const newestChange = [...timers.entries()].find(([, fn]) => fn);
timers.delete(newestChange[0]);
newestChange[1]();
assert.equal(changes[1].version, 4, 'the coalesced message should preserve the newest version');
sockets[0].onmessage({ data: JSON.stringify({ type: 'class-deleted', classId: 'class-1', version: 5, eventId: 'e5' }) });
assert.equal(changes.length, 3, 'class deletion should be delivered immediately');
assert.equal(changes[2].type, 'class-deleted');
connection.stop();

// Model seven simultaneously active classes with one teacher and 30 students each.
const workerSource = (await readFile(new URL('../worker/index.js', import.meta.url), 'utf8'))
  .replace("import qrcode from 'qrcode-generator';", 'const qrcode = () => { throw new Error("QR not used in class sync tests"); };');
const workerModule = await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));
let delivered = 0;
for (let classNumber = 1; classNumber <= 7; classNumber += 1) {
  const received = [];
  const hub = new workerModule.ClassSyncHub({
    getWebSockets: () => Array.from({ length: 31 }, () => ({ send: (message) => received.push(JSON.parse(message)) }))
  });
  const response = await hub.fetch(new Request('https://class-sync/notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'class-changed', classId: `class-${classNumber}`, version: 4, eventId: `e-${classNumber}` })
  }));
  assert.equal((await response.json()).sent, 31);
  assert.equal(received.length, 31);
  assert.ok(received.every((event) => event.classId === `class-${classNumber}` && event.version === 4));
  delivered += received.length;
}
assert.equal(delivered, 217, 'seven classes × (one teacher + 30 students)');
console.log('PASS: coalesced pushes, immediate deletion push, cleanup, and 217-socket fanout simulation.');
