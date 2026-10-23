import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const source = (await readFile(new URL('../worker/index.js', import.meta.url), 'utf8'))
  .replace("import qrcode from 'qrcode-generator';", 'const qrcode = () => { throw new Error("QR not used in read optimization tests"); };')
  .replace("sound TEXT NOT NULL DEFAULT 'bell',", '');
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

async function request(action, payload = {}, token = rawToken) {
  const response = await worker.fetch(new Request('https://local.test/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload, token })
  }), env);
  const body = await response.json();
  return { status: response.status, body };
}
async function call(action, payload = {}, token = rawToken) {
  const response = await request(action, payload, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

await call('getTeacherClass', { classId: 'class-a' });
assert.ok(db.prepare('PRAGMA table_info(class_timers)').all().some((column) => column.name === 'sound'),
  'existing timer tables receive a non-destructive sound column upgrade');
assert.equal(sqlLog.filter((sql) => /SELECT version FROM classes/.test(sql)).length, 0,
  'teacher class loading should reuse the version read for ownership validation');
sqlLog.length = 0;
await call('heartbeat', { classId: 'class-a', knownVersion: 1 });
assert.equal(sqlLog.filter((sql) => /SELECT version FROM classes/.test(sql)).length, 0,
  'teacher heartbeat should reuse the version read for ownership validation');

const timer = await call('startClassTimer', {
  classId: 'class-a', title: '모둠 활동', durationSeconds: 60, sound: 'ascending'
});
assert.equal(timer.sound, 'ascending', 'timer sound choice is saved and returned to class clients');
const unsupportedSound = await call('startClassTimer', {
  classId: 'class-a', title: '다시 시작', durationSeconds: 60, sound: 'unsupported'
});
assert.equal(unsupportedSound.sound, 'bell', 'unknown timer sounds safely fall back to bell');

const roomOne = await call('createGuestRoom', { title: '현장 참여방 1' });
const roomTwo = await call('createGuestRoom', { title: '현장 참여방 2' });
assert.notEqual(roomOne.id, roomTwo.id, 'teachers can open additional one-time rooms');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guest_rooms WHERE teacher_id=?').get('teacher-a').count, 2,
  'creating another one-time room preserves the previously created room');

const firstJoin = await call('joinGuestRoom', { code: roomOne.code });
const originalPost = await call('upsertGuestPost', { kind: 'opinion', text: '다시 열어도 남아야 하는 의견' }, firstJoin.token);
const closedRoom = await call('closeGuestRoom', { roomId: roomOne.id, status: 'closed' });
assert.equal(closedRoom.status, 'closed');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guest_posts WHERE room_id=?').get(roomOne.id).count, 1,
  'closing a room retains existing posts');
const deniedJoin = await request('joinGuestRoom', { code: roomOne.code });
assert.equal(deniedJoin.status, 410, 'closed rooms reject new participant entry');

db.prepare('INSERT INTO teachers VALUES(?,?,?,?,?,?)').run('teacher-b', 'other@example.test', '다른 교사', 'x', 'x', now);
const foreignToken = 'foreign-teacher-token';
const foreignHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(foreignToken))).toString('hex');
db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(foreignHash, 'teacher', 'teacher-b', '', expiry, now);
const forbiddenReopen = await request('reopenGuestRoom', { roomId: roomOne.id }, foreignToken);
assert.equal(forbiddenReopen.status, 404, 'only the room owning teacher can reopen it');

const reopenedRoom = await call('reopenGuestRoom', { roomId: roomOne.id, durationHours: 24 });
assert.equal(reopenedRoom.id, roomOne.id, 'reopening updates the existing room');
assert.equal(reopenedRoom.code, roomOne.code, 'reopening reuses the existing participant code and QR target');
assert.equal(reopenedRoom.status, 'open');
assert.ok(new Date(reopenedRoom.expiresAt).getTime() > Date.now(), 'reopening extends the room expiry');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guest_posts WHERE room_id=?').get(roomOne.id).count, 1,
  'reopening retains prior activity');
const secondJoin = await call('joinGuestRoom', { code: roomOne.code });
const roomAfterJoin = await call('getGuestRoom', {}, secondJoin.token);
assert.equal(roomAfterJoin.room.id, roomOne.id);
assert.equal(roomAfterJoin.posts.some((post) => post.id === originalPost.id), true,
  'new participants can re-enter and read retained posts');
await call('upsertGuestPost', { kind: 'opinion', text: '재개방 후 작성 및 동기화 확인' }, secondJoin.token);
const syncedRoom = await call('getTeacherGuestRoom', { roomId: roomOne.id, knownVersion: reopenedRoom.version });
assert.equal(syncedRoom.posts.some((post) => post.text === '재개방 후 작성 및 동기화 확인'), true,
  'teacher sees a newly written post after room sync');
const closedAgain = await call('closeGuestRoom', { roomId: roomOne.id, status: 'closed' });
assert.equal(closedAgain.status, 'closed', 'teacher can close a reopened room again');
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guest_posts WHERE room_id=?').get(roomOne.id).count, 2,
  'closing again retains both pre-existing and reopened activity');

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

const studentSource = await readFile(new URL('../public/student.js', import.meta.url), 'utf8');
const postRead = studentSource.slice(studentSource.indexOf('function openBoardPost('), studentSource.indexOf('function startHeartbeat('));
assert.doesNotMatch(postRead, /API\.request\s*\(|location\.(?:reload|assign)\s*\(/,
  'reading a board post does not force a request or full-page refresh');
const uiSource = await readFile(new URL('../public/ui.js', import.meta.url), 'utf8');
for (const sound of ['bell', 'chime', 'woodblock', 'ascending']) {
  assert.ok(teacherSource.includes('value="' + sound + '"'), 'teacher timer offers the ' + sound + ' sound');
  assert.ok(uiSource.includes(sound + ':'), 'shared timer audio supports the ' + sound + ' sound');
}

console.log('PASS: read optimization, safe timer sounds, repeatable one-time rooms, and post reading without forced refresh.');
