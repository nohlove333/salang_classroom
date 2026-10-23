import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const source = (await readFile(new URL('../worker/index.js', import.meta.url), 'utf8'))
  .replace("import qrcode from 'qrcode-generator';", 'const qrcode = () => { throw new Error("QR not used in read optimization tests"); };');
const workerModule = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { SCHEMA };').toString('base64'));
const worker = workerModule.default;
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
db.exec(workerModule.SCHEMA);

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
  DB: { prepare, async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } },
  FILES: {
    async put(key, body) { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
    async delete(key) { objects.delete(key); },
    async get(key) { const body = objects.get(key); return body && { body, size: body.length, writeHttpMetadata() {} }; }
  },
  TEACHER_SETUP_KEY: 'read-optimization-test',
  ASSETS: { fetch() { throw new Error('Static assets are not part of these tests'); } }
};
const now = new Date().toISOString();
const expiry = new Date(Date.now() + 86400000).toISOString();
db.prepare('INSERT INTO teachers VALUES(?,?,?,?,?,?)').run('teacher-a', 'teacher@example.test', '교사', 'x', 'x', now);
db.prepare('INSERT INTO classes(id,teacher_id,name,code,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run('class-a', 'teacher-a', '기존 반', 'CLASS', now, now);
const rawToken = 'teacher-token';
const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken))).toString('hex');
db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(hash, 'teacher', 'teacher-a', '', expiry, now);

async function call(action, payload = {}) {
  const response = await worker.fetch(new Request('https://local.test/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload, token: rawToken })
  }), env);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data;
}

await call('getTeacherClass', { classId: 'class-a' });
assert.equal(sqlLog.filter((sql) => /SELECT version FROM classes/.test(sql)).length, 0,
  'teacher class loading should reuse the version read for ownership validation');

sqlLog.length = 0;
await call('teacherDashboard');
await call('teacherDashboard');
assert.equal(sqlLog.filter((sql) => /SUM\(size\).*COUNT\(\*\).*FROM files/i.test(sql)).length, 1,
  'repeated dashboard reads in one Worker isolate should share the global storage aggregate');

const uploaded = await worker.fetch(new Request('https://local.test/api/upload', {
  method: 'POST', headers: {
    Authorization: 'Bearer ' + rawToken,
    'X-File-Name': encodeURIComponent('학습지.pdf'), 'X-File-Type': 'application/pdf', 'X-File-Size': '5'
  }, body: 'hello'
}), env);
assert.equal(uploaded.status, 200);
await call('getStorageStatus');
assert.equal(sqlLog.filter((sql) => /SUM\(size\).*COUNT\(\*\).*FROM files/i.test(sql)).length, 2,
  'uploading a file should invalidate the cached storage aggregate');

const teacherSource = await readFile(new URL('../public/teacher.js', import.meta.url), 'utf8');
assert.doesNotMatch(teacherSource.slice(teacherSource.indexOf('function startClassSync'), teacherSource.indexOf('async function renderGuestRoom')),
  /checkStorageStatus\s*\(/, 'class change events should not trigger global file-storage reads');

console.log('PASS: teacher class version query reuse, shared storage aggregate, file-write invalidation, and no storage scan on class sync.');
