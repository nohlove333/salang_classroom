import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

// QR generation is outside this test; exercise the actual Worker HTTP handlers
// without installing Wrangler or contacting the production database.
const source = (await readFile(new URL('../worker/index.js', import.meta.url), 'utf8'))
  .replace("import qrcode from 'qrcode-generator';", 'const qrcode = () => { throw new Error("QR not used in resource tests"); };');
const workerModule = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { SCHEMA, TEACHER_RESOURCE_SCHEMA };').toString('base64'));
const worker = workerModule.default;
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
// Simulate an existing v47 database that has no resource table.
db.exec(workerModule.SCHEMA.replace(workerModule.TEACHER_RESOURCE_SCHEMA, ''));
const sqlLog = [];
function prepare(sql, args = []) {
  return {
    bind: (...next) => prepare(sql, next),
    async first() { sqlLog.push(sql); return db.prepare(sql).get(...args) || null; },
    async all() { sqlLog.push(sql); return { results: db.prepare(sql).all(...args) }; },
    async run() { sqlLog.push(sql); return db.prepare(sql).run(...args); }
  };
}
const objects = new Map();
const env = {
  DB: { prepare, async batch(statements) { return Promise.all(statements.map((stmt) => stmt.run())); } },
  FILES: {
    async put(key, body) { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
    async delete(key) { objects.delete(key); },
    async get(key) {
      const body = objects.get(key);
      return body && { body, size: body.length, writeHttpMetadata() {} };
    }
  },
  TEACHER_SETUP_KEY: 'local-test-only',
  ASSETS: { fetch() { throw new Error('No static asset requests expected'); } }
};
const time = new Date().toISOString();
const expires = new Date(Date.now() + 86400000).toISOString();
for (const id of ['teacher-a', 'teacher-b']) {
  db.prepare('INSERT INTO teachers VALUES(?,?,?,?,?,?)').run(id, id + '@example.test', id, 'unused', 'unused', time);
}
db.prepare('INSERT INTO classes(id,teacher_id,name,code,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('class-a', 'teacher-a', '기존 반', 'TEST', time, time);
db.prepare('INSERT INTO students(id,class_id,number,name,pin_hash,pin_salt,created_at) VALUES(?,?,?,?,?,?,?)').run('student-a', 'class-a', 1, '학생', 'unused', 'unused', time);
async function token(value, role, userId, classId = '') {
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(hash, role, userId, classId, expires, time);
  return value;
}
const a = await token('a', 'teacher', 'teacher-a');
const b = await token('b', 'teacher', 'teacher-b');
let studentCounter = 0;
const studentToken = () => token('student-' + (++studentCounter), 'student', 'student-a', 'class-a');
const guestToken = await token('guest', 'guest', 'guest-a', 'room-a');
async function call(action, payload = {}, auth = a, status = 200) {
  const response = await worker.fetch(new Request('https://local.test/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload, token: auth })
  }), env);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body.data || body;
}
async function upload(auth = a, name = '학습지.pdf') {
  const response = await worker.fetch(new Request('https://local.test/api/upload', {
    method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'X-File-Name': encodeURIComponent(name), 'X-File-Type': 'application/pdf', 'X-File-Size': '5' }, body: 'hello'
  }), env);
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='teacher_resources'").get(), undefined);
assert.deepEqual((await call('getTeacherResources')).items, []);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM students').get().n, 1);
const first = await upload();
const second = await upload(a, '수업자료.pdf');
const item = await call('upsertTeacherResource', {
  title: '수업 자료 <교사>', body: '첫 줄\n둘째 줄', links: ['https://example.com/lesson', 'https://example.com/lesson'], files: [first, second]
});
assert.equal(item.attachments.length, 2);
assert.equal(item.links.length, 1);
assert.equal(item.body, '첫 줄\n둘째 줄');
assert.deepEqual((await call('getTeacherResources')).items[0], item);
assert.deepEqual((await call('getTeacherResources', {}, b)).items, []);
for (const action of ['getTeacherResources', 'upsertTeacherResource', 'deleteTeacherResource']) {
  await call(action, { id: item.id }, await studentToken(), 401);
}
await call('getTeacherResources', {}, guestToken, 401);
await call('getTeacherResources', {}, '', 401);
await call('upsertTeacherResource', { id: item.id, title: '침입' }, b, 404);
await call('deleteTeacherResource', { id: item.id }, b, 404);
for (const auth of [await studentToken(), b]) {
  await call('prepareFileAccess', { fileId: first.id }, auth, auth === b ? 404 : 403);
}
const access = await call('prepareFileAccess', { fileId: first.id, intent: 'download' });
const downloaded = await worker.fetch(new Request(access.downloadUrl), env);
assert.equal(await downloaded.text(), 'hello');
const unsigned = await worker.fetch(new Request('https://local.test/api/file/' + first.id), env);
assert.equal(unsigned.status, 403);
for (const link of ['javascript:alert(1)', 'data:text/html,test', 'ftp://example.com', 'https://u:p@example.com', 'not a url']) {
  await call('upsertTeacherResource', { id: item.id, title: '바뀌면 안 됨', links: [link], keepAttachmentIds: [] }, a, 400);
}
const foreign = await upload(b);
await call('upsertTeacherResource', { id: item.id, title: '바뀌면 안 됨', files: [foreign] }, a, 400);
await call('upsertTeacherResource', { title: '중복 첨부', files: [first] }, a, 400);
assert.equal((await call('getTeacherResources')).items[0].title, item.title);
assert.equal(objects.size, 3);
await call('upsertTeacherResource', { id: item.id, title: '수정한 자료', links: ['http://example.com/'], keepAttachmentIds: [second.id] });
assert.equal(db.prepare('SELECT id FROM files WHERE id=?').get(first.id), undefined);
assert.equal(objects.size, 2);
const afterEdit = (await call('getTeacherResources')).items[0];
assert.equal(afterEdit.attachments.length, 1);
assert.equal(afterEdit.attachments[0].id, second.id);
// Resource room data and attachments must not enter normal student responses.
const normalClass = await call('getStudentClass', {}, await studentToken());
assert.equal(JSON.stringify(normalClass).includes('수정한 자료'), false);
assert.equal(JSON.stringify(normalClass).includes(second.id), false);
for (let i = 0; i < 55; i++) {
  db.prepare('INSERT INTO teacher_resources VALUES(?,?,?,?,?,?,?)').run('page-' + String(i).padStart(3, '0'), 'teacher-a', '자료 ' + i, '', '[]', time, time);
}
const page1 = await call('getTeacherResources');
assert.equal(page1.items.length, 50);
assert.ok(page1.nextCursor);
const page2 = await call('getTeacherResources', { cursor: page1.nextCursor });
assert.equal(page2.items.length, 6);
assert.equal(page2.nextCursor, null);
assert.equal(new Set([...page1.items, ...page2.items].map((entry) => entry.id)).size, 56);
assert.equal(sqlLog.filter((sql) => sql.includes('CREATE TABLE IF NOT EXISTS teacher_resources')).length, 1);
assert.ok(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM teacher_resources WHERE teacher_id=? ORDER BY updated_at DESC,id DESC LIMIT 51').all('teacher-a').some((r) => r.detail.includes('teacher_resources_teacher_updated')));
await call('deleteTeacherResource', { id: item.id });
assert.equal(objects.size, 1); // Only the other teacher's unattached upload remains.
assert.equal(db.prepare('SELECT id FROM files WHERE id=?').get(second.id), undefined);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE owner_type='teacher_resource' AND owner_id=?").get(item.id).n, 0);
await call('deleteTeacherResource', { id: item.id }, a, 404);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teachers').get().n, 2);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM classes').get().n, 1);
db.close();
console.log('PASS: existing DB upgrade, CRUD, links, multi-file upload/download/removal, teacher isolation, student/guest denial, normal class privacy, indexed pagination, one-time schema initialization.');
