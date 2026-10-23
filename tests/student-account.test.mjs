import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const qrValues = [];
const source = (await readFile(new URL('../worker/index.js', import.meta.url), 'utf8'))
  .replace("import qrcode from 'qrcode-generator';", `const qrcode = () => ({ addData(value) { globalThis.__qrValues.push(value); }, make() {}, createSvgTag() { return '<svg></svg>'; } });`);
globalThis.__qrValues = qrValues;
const module = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport { SCHEMA };').toString('base64'));
const worker = module.default;
const db = new DatabaseSync(':memory:');
const sqlLog = [];
db.exec('PRAGMA foreign_keys=ON');
// Start from the pre-v58 schema so the first API request exercises the additive
// production migration instead of silently relying on a freshly initialized DB.
const legacySchema = module.SCHEMA.replace(
  /CREATE TABLE IF NOT EXISTS board_post_reactions \([\s\S]*?\);\nCREATE INDEX IF NOT EXISTS board_post_reactions_student ON board_post_reactions\(student_id,post_id\);\n/,
  ''
);
assert.notEqual(legacySchema, module.SCHEMA, 'legacy fixture omits the newly introduced reaction table');
db.exec(legacySchema);

const now = new Date().toISOString();
const expiry = new Date(Date.now() + 86400000).toISOString();
const setupKey = 'student-account-test-secret';
db.prepare('INSERT INTO teachers VALUES(?,?,?,?,?,?)').run('teacher-a', 'teacher@example.test', '교사', 'x', 'x', now);
db.prepare('INSERT INTO classes(id,teacher_id,name,code,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run('class-a', 'teacher-a', '테스트 반', 'LOVE01', now, now);
db.prepare('INSERT INTO students(id,class_id,number,name,pin_hash,pin_salt,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
  .run('student-a', 'class-a', 7, '기존 명단 이름', await hash('salt-a|4321|' + setupKey), 'salt-a', '', now);
db.prepare('INSERT INTO contents(id,class_id,type,title,created_at,updated_at) VALUES(?,?,?,?,?,?)')
  .run('assignment-a', 'class-a', 'assignment', '과제', now, now);
db.prepare('INSERT INTO submissions(id,assignment_id,class_id,student_id,student_number,student_name,text,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('submission-a', 'assignment-a', 'class-a', 'student-a', 7, '기존 명단 이름', '기존 제출', now, now);

const rawTeacherToken = 'teacher-session';
await addSession('teacher', 'teacher-a', '', rawTeacherToken);
const env = {
  DB: { prepare, async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } },
  FILES: { async get() { return null; }, async delete() {} },
  CLASS_SYNC: { idFromName: (name) => name, get: () => ({ fetch: async () => new Response('ok') }) },
  TEACHER_SETUP_KEY: setupKey,
  ASSETS: { fetch() { throw new Error('Static assets are not part of these tests'); } }
};

function prepare(sql, args = []) {
  return {
    bind: (...next) => prepare(sql, next),
    async first() { sqlLog.push(sql); return db.prepare(sql).get(...args) || null; },
    async all() { sqlLog.push(sql); return { results: db.prepare(sql).all(...args) }; },
    async run() { sqlLog.push(sql); return db.prepare(sql).run(...args); }
  };
}

async function hash(value) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
}

async function addSession(role, userId, classId, token) {
  await db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)')
    .run(await hash(token), role, userId, classId, expiry, now);
}

async function request(action, payload, token = '') {
  const response = await worker.fetch(new Request('https://local.test/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, payload, token })
  }), env);
  return { status: response.status, body: await response.json() };
}

const login = (overrides = {}) => request('studentLogin', {
  classCode: 'LOVE01', number: 7, nickname: '푸른별', password: 'student-pass-2030', ...overrides
});

const unclaimed = await request('studentLogin', { classCode: 'LOVE01', number: 7, nickname: '새별', password: 'student-pass-2030' });
assert.equal(unclaimed.status, 409, 'legacy accounts require their one-time PIN before setup');
assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_post_reactions'").get(),
  'a pre-v58 database receives the additive reaction schema before class data is read');
sqlLog.length = 0;
const first = await login({ initialPin: '4321' });
assert.equal(first.status, 200, JSON.stringify(first.body));
assert.equal(sqlLog.filter((sql) => /SELECT version FROM classes/.test(sql)).length, 0,
  'student account setup passes the class version to sync instead of reading it again');
assert.equal(first.body.data.user.id, 'student-a', 'student identity remains linked to old submissions');
assert.equal(first.body.data.user.name, '푸른별');
const migrated = db.prepare('SELECT * FROM students WHERE id=?').get('student-a');
assert.equal(migrated.password_hash.length, 64);
assert.notEqual(migrated.password_hash, 'student-pass-2030', 'password is stored only as a derived hash');
assert.equal(db.prepare('SELECT student_id,text FROM submissions WHERE id=?').get('submission-a').student_id, 'student-a');
const teacherClass = await request('getTeacherClass', { classId: 'class-a' }, rawTeacherToken);
assert.equal(teacherClass.body.data.students[0].accountReady, true, 'teachers can see account setup status');
const studentClass = await request('getStudentClass', {}, first.body.data.token);
assert.equal(Object.hasOwn(studentClass.body.data.students[0], 'accountReady'), false, 'students cannot see classmates account status');

const second = await login({ nickname: '별하나' });
assert.equal(second.status, 200, JSON.stringify(second.body));
assert.equal(second.body.data.user.name, '별하나', 'students can change their nickname on successful login');
const wrong = await login({ password: 'wrong-pass-2030' });
assert.equal(wrong.status, 401, 'wrong account password is rejected');
sqlLog.length = 0;
const reset = await request('resetStudentPin', { studentId: 'student-a' }, rawTeacherToken);
assert.equal(reset.status, 200, JSON.stringify(reset.body));
assert.equal(sqlLog.filter((sql) => /SELECT version FROM classes/.test(sql)).length, 0,
  'teacher reset reuses the class version from its authorization query');
const needsSetup = await login({ initialPin: '' });
assert.equal(needsSetup.status, 409, 'teacher reset returns the account to first-login setup');
const restored = await login({ initialPin: reset.body.data.pin, nickname: '별하나' });
assert.equal(restored.status, 200, JSON.stringify(restored.body));
sqlLog.length = 0;
const reissued = await request('reissueClassPins', { classId: 'class-a' }, rawTeacherToken);
assert.equal(reissued.status, 200, JSON.stringify(reissued.body));
assert.equal(sqlLog.filter((sql) => /SELECT version FROM classes/.test(sql)).length, 0,
  'bulk reset reuses the class version and avoids an extra D1 SELECT');
const reactionLogin = await login({ initialPin: reissued.body.data.students[0].pin, nickname: '별하나' });
assert.equal(reactionLogin.status, 200, JSON.stringify(reactionLogin.body));
const reactionToken = reactionLogin.body.data.token;

db.prepare("INSERT INTO contents(id,class_id,type,title,body,category,pinned,due_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
  .run('board-a', 'class-a', 'board', '응원 보드', '', '', 0, '', 'open', now, now);
db.prepare("INSERT INTO board_posts(id,board_id,class_id,student_id,student_number,student_name,title,text,status,revision_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
  .run('post-a', 'board-a', 'class-a', 'student-a', 7, '별하나', '좋은 생각', '함께 해보자', 'published', '', now, now);
const firstReaction = await request('setBoardReaction', { postId: 'post-a', emoji: '❤️' }, reactionToken);
assert.equal(firstReaction.status, 200, JSON.stringify(firstReaction.body));
assert.deepEqual(firstReaction.body.data.reactions, { '❤️': 1 });
const changedReaction = await request('setBoardReaction', { postId: 'post-a', emoji: '👍' }, reactionToken);
assert.deepEqual(changedReaction.body.data.reactions, { '👍': 1 }, 'one student can keep only one reaction per post');
const classWithReaction = await request('getStudentClass', {}, reactionToken);
const ownPost = classWithReaction.body.data.boardPosts.find((post) => post.id === 'post-a');
assert.equal(ownPost.myReaction, '👍', 'student reload restores their selected reaction');
assert.deepEqual(ownPost.reactions, { '👍': 1 });
const removedReaction = await request('setBoardReaction', { postId: 'post-a', emoji: '👍' }, reactionToken);
assert.equal(removedReaction.body.data.myReaction, '', 'selecting the active reaction toggles it off');
assert.equal(Object.keys(removedReaction.body.data.reactions).length, 0);
const inappropriateReaction = await request('setBoardReaction', { postId: 'post-a', emoji: '😡' }, reactionToken);
assert.equal(inappropriateReaction.status, 400, 'negative emoji are rejected');
const teacherReaction = await request('setBoardReaction', { postId: 'post-a', emoji: '❤️' }, rawTeacherToken);
assert.equal(teacherReaction.status, 401, 'teachers cannot impersonate student reactions');

const qr = await worker.fetch(new Request('https://local.test/student-login-qr.svg?code=LOVE01'), env);
assert.equal(qr.status, 200);
assert.equal(qrValues.at(-1), 'https://local.test/?classCode=LOVE01&#/student/login');

console.log('PASS: student account migration, password hashing, nickname reset, class-coded QR, and positive-only post reactions.');
