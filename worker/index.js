const SCHEMA = `
CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  school TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  student_count INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS classes_teacher_order ON classes(teacher_id, display_order);
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(class_id, number),
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS students_class_number ON students(class_id, number);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  user_id TEXT NOT NULL,
  class_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(role, user_id);
CREATE TABLE IF NOT EXISTS contents (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS contents_class_type ON contents(class_id, type, created_at);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_number INTEGER NOT NULL,
  student_name TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(assignment_id, student_id),
  FOREIGN KEY (assignment_id) REFERENCES contents(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS submissions_class_assignment ON submissions(class_id, assignment_id);
CREATE TABLE IF NOT EXISTS board_posts (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_number INTEGER NOT NULL,
  student_name TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published',
  revision_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(board_id, student_id),
  FOREIGN KEY (board_id) REFERENCES contents(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS posts_class_board ON board_posts(class_id, board_id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_role TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS attachments (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner_type, owner_id, file_id),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS attachments_owner ON attachments(owner_type, owner_id, sort_order);
`;

class AppError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const encoder = new TextEncoder();

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function randomDigits() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(1000 + (bytes[0] % 9000));
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

async function derivePassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: encoder.encode(salt),
    iterations: 100000
  }, key, 256);
  return bytesToHex(bits);
}

async function pinHash(pin, salt, env) {
  return sha256(`${salt}|${pin}|${env.TEACHER_SETUP_KEY || ''}`);
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

function safeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name, X-File-Type, X-File-Size',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request) : {})
    }
  });
}

function ok(data, request) {
  return json({ ok: true, data }, 200, request);
}

function errorResponse(error, request) {
  if (error instanceof AppError) {
    return json({ ok: false, code: error.code, message: error.message, details: error.details }, error.status, request);
  }
  console.error(error && error.stack ? error.stack : error);
  const message = String(error && error.message || '');
  if (message.includes('UNIQUE constraint failed')) {
    return json({ ok: false, code: 'DUPLICATE', message: '이미 사용 중인 정보입니다.' }, 409, request);
  }
  return json({ ok: false, code: 'SERVER_ERROR', message: '서버에서 요청을 처리하지 못했습니다.' }, 500, request);
}

async function ensureSchema(env) {
  await env.DB.exec(SCHEMA);
}

async function schemaReady(env) {
  try {
    const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='teachers'").first();
    return Boolean(row);
  } catch (_) {
    return false;
  }
}

async function issueSession(env, role, userId, classId = '') {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const created = nowIso();
  const lifetime = role === 'teacher' ? 30 * 86400000 : 12 * 3600000;
  const expires = new Date(Date.now() + lifetime).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash, role, user_id, class_id, expires_at, created_at) VALUES(?,?,?,?,?,?)'
  ).bind(tokenHash, role, userId, classId || '', expires, created).run();
  return token;
}

async function sessionFromToken(env, token, expectedRole = '') {
  if (!token) throw new AppError('로그인이 필요합니다.', 'UNAUTHORIZED', 401);
  const row = await env.DB.prepare(
    'SELECT token_hash, role, user_id, class_id, expires_at FROM sessions WHERE token_hash=?'
  ).bind(await sha256(token)).first();
  if (!row || row.expires_at <= nowIso() || (expectedRole && row.role !== expectedRole)) {
    if (row) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(row.token_hash).run();
    throw new AppError('로그인이 만료되었습니다. 다시 로그인해 주세요.', 'SESSION_EXPIRED', 401);
  }
  return row;
}

async function ownedClass(env, session, classId) {
  const row = await env.DB.prepare(
    'SELECT * FROM classes WHERE id=? AND teacher_id=?'
  ).bind(String(classId || ''), session.user_id).first();
  if (!row) throw new AppError('클래스를 찾을 수 없습니다.', 'NOT_FOUND', 404);
  return row;
}

function classJson(row) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject || '',
    school: row.school || '',
    code: row.code,
    studentCount: Number(row.student_count || 0),
    displayOrder: Number(row.display_order || 0),
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function studentJson(row, includePin = false) {
  const item = {
    id: row.id,
    classId: row.class_id,
    number: Number(row.number),
    name: row.name,
    online: Boolean(row.online),
    lastSeenAt: row.last_seen_at || ''
  };
  if (includePin && row.pin) item.pin = row.pin;
  return item;
}

function contentJson(row) {
  return {
    id: row.id,
    classId: row.class_id,
    title: row.title,
    body: row.body || '',
    category: row.category || '',
    pinned: Boolean(row.pinned),
    dueAt: row.due_at || '',
    status: row.status || 'open',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: []
  };
}

function submissionJson(row) {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    classId: row.class_id,
    studentId: row.student_id,
    studentNumber: Number(row.student_number),
    studentName: row.student_name,
    text: row.text || '',
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    attachments: []
  };
}

function postJson(row) {
  return {
    id: row.id,
    boardId: row.board_id,
    classId: row.class_id,
    studentId: row.student_id,
    studentNumber: Number(row.student_number),
    studentName: row.student_name,
    text: row.text || '',
    status: row.status || 'published',
    revisionMessage: row.revision_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: []
  };
}

function fileJson(row) {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type || 'application/octet-stream',
    size: Number(row.size || 0)
  };
}

async function all(statement) {
  const result = await statement.all();
  return result.results || [];
}

async function loadAttachmentMap(env, classId) {
  const [contentFiles, submissionFiles, postFiles] = await Promise.all([
    all(env.DB.prepare(
      "SELECT a.owner_id, f.* FROM attachments a JOIN files f ON f.id=a.file_id JOIN contents c ON c.id=a.owner_id WHERE a.owner_type='content' AND c.class_id=? ORDER BY a.sort_order"
    ).bind(classId)),
    all(env.DB.prepare(
      "SELECT a.owner_id, f.* FROM attachments a JOIN files f ON f.id=a.file_id JOIN submissions s ON s.id=a.owner_id WHERE a.owner_type='submission' AND s.class_id=? ORDER BY a.sort_order"
    ).bind(classId)),
    all(env.DB.prepare(
      "SELECT a.owner_id, f.* FROM attachments a JOIN files f ON f.id=a.file_id JOIN board_posts p ON p.id=a.owner_id WHERE a.owner_type='board_post' AND p.class_id=? ORDER BY a.sort_order"
    ).bind(classId))
  ]);
  const map = new Map();
  for (const row of [...contentFiles, ...submissionFiles, ...postFiles]) {
    if (!map.has(row.owner_id)) map.set(row.owner_id, []);
    map.get(row.owner_id).push(fileJson(row));
  }
  return map;
}

async function classData(env, classId, studentId = '') {
  const classRow = await env.DB.prepare('SELECT * FROM classes WHERE id=?').bind(classId).first();
  if (!classRow) throw new AppError('클래스를 찾을 수 없습니다.', 'NOT_FOUND', 404);
  const cutoff = new Date(Date.now() - 90000).toISOString();
  const [studentRows, contentRows, submissionRows, postRows, attachmentMap] = await Promise.all([
    all(env.DB.prepare(
      'SELECT *, CASE WHEN last_seen_at>=? THEN 1 ELSE 0 END AS online FROM students WHERE class_id=? ORDER BY number'
    ).bind(cutoff, classId)),
    all(env.DB.prepare('SELECT * FROM contents WHERE class_id=? ORDER BY created_at DESC').bind(classId)),
    all(env.DB.prepare(
      studentId
        ? 'SELECT * FROM submissions WHERE class_id=? AND student_id=? ORDER BY submitted_at DESC'
        : 'SELECT * FROM submissions WHERE class_id=? ORDER BY student_number, submitted_at DESC'
    ).bind(...(studentId ? [classId, studentId] : [classId]))),
    all(env.DB.prepare('SELECT * FROM board_posts WHERE class_id=? ORDER BY student_number').bind(classId)),
    loadAttachmentMap(env, classId)
  ]);
  const students = studentRows.map(studentJson);
  const contents = contentRows.map((row) => {
    const item = contentJson(row);
    item.attachments = attachmentMap.get(item.id) || [];
    return item;
  });
  const submissions = submissionRows.map((row) => {
    const item = submissionJson(row);
    item.attachments = attachmentMap.get(item.id) || [];
    return item;
  });
  const posts = postRows.map((row) => {
    const item = postJson(row);
    item.attachments = attachmentMap.get(item.id) || [];
    if (studentId && item.studentId !== studentId) {
      item.status = 'published';
      item.revisionMessage = '';
    }
    return item;
  });
  const submissionCounts = new Map();
  if (!studentId) {
    for (const item of submissions) submissionCounts.set(item.assignmentId, (submissionCounts.get(item.assignmentId) || 0) + 1);
  } else {
    const counts = await all(env.DB.prepare(
      'SELECT assignment_id, COUNT(*) AS total FROM submissions WHERE class_id=? GROUP BY assignment_id'
    ).bind(classId));
    for (const row of counts) submissionCounts.set(row.assignment_id, Number(row.total));
  }
  const postCounts = new Map();
  for (const item of posts) postCounts.set(item.boardId, (postCounts.get(item.boardId) || 0) + 1);
  const announcements = contents.filter((item, index) => contentRows[index].type === 'announcement');
  const assignments = contents.filter((item, index) => contentRows[index].type === 'assignment')
    .map((item) => ({ ...item, submissionCount: submissionCounts.get(item.id) || 0 }));
  const boards = contents.filter((item, index) => contentRows[index].type === 'board')
    .map((item) => ({ ...item, postCount: postCounts.get(item.id) || 0 }));
  return {
    classInfo: classJson(classRow),
    students,
    announcements,
    assignments,
    boards,
    submissions,
    boardPosts: posts,
    onlineStudents: students.filter((item) => item.online)
  };
}

async function touchClass(env, classId) {
  await env.DB.prepare('UPDATE classes SET version=version+1, updated_at=? WHERE id=?').bind(nowIso(), classId).run();
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

async function deleteOwnerFiles(env, ownerType, ownerIds) {
  const ids = Array.from(new Set((ownerIds || []).filter(Boolean).map(String)));
  if (!ids.length) return;
  const rows = await all(env.DB.prepare(
    `SELECT f.id, f.r2_key FROM files f JOIN attachments a ON a.file_id=f.id WHERE a.owner_type=? AND a.owner_id IN (${placeholders(ids.length)})`
  ).bind(ownerType, ...ids));
  await Promise.all(rows.map((row) => env.FILES.delete(row.r2_key)));
  if (rows.length) {
    const fileIds = rows.map((row) => row.id);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM attachments WHERE file_id IN (${placeholders(fileIds.length)})`).bind(...fileIds),
      env.DB.prepare(`DELETE FROM files WHERE id IN (${placeholders(fileIds.length)})`).bind(...fileIds)
    ]);
  }
}

async function replaceAttachments(env, ownerType, ownerId, keepIds, uploadedFiles, session) {
  const existing = await all(env.DB.prepare(
    'SELECT f.id, f.r2_key FROM files f JOIN attachments a ON a.file_id=f.id WHERE a.owner_type=? AND a.owner_id=? ORDER BY a.sort_order'
  ).bind(ownerType, ownerId));
  const keep = new Set((keepIds || []).map(String));
  const removed = existing.filter((row) => !keep.has(String(row.id)));
  await Promise.all(removed.map((row) => env.FILES.delete(row.r2_key)));
  if (removed.length) {
    const removedIds = removed.map((row) => row.id);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM attachments WHERE file_id IN (${placeholders(removedIds.length)})`).bind(...removedIds),
      env.DB.prepare(`DELETE FROM files WHERE id IN (${placeholders(removedIds.length)})`).bind(...removedIds)
    ]);
  }
  const newIds = (uploadedFiles || []).map((item) => String(item.id || '')).filter(Boolean);
  if (newIds.length) {
    const rows = await all(env.DB.prepare(
      `SELECT * FROM files WHERE id IN (${placeholders(newIds.length)})`
    ).bind(...newIds));
    if (rows.length !== newIds.length || rows.some((row) => row.uploader_role !== session.role || row.uploader_id !== session.user_id)) {
      throw new AppError('업로드한 파일 정보를 확인하지 못했습니다.', 'INVALID_UPLOAD');
    }
    const start = existing.length - removed.length;
    const time = nowIso();
    const statements = [];
    rows.forEach((row, index) => {
      statements.push(env.DB.prepare(
        'INSERT OR IGNORE INTO attachments(owner_type, owner_id, file_id, sort_order) VALUES(?,?,?,?)'
      ).bind(ownerType, ownerId, row.id, start + index));
      statements.push(env.DB.prepare('UPDATE files SET claimed_at=? WHERE id=?').bind(time, row.id));
    });
    await env.DB.batch(statements);
  }
  const finalRows = await all(env.DB.prepare(
    'SELECT f.* FROM files f JOIN attachments a ON a.file_id=f.id WHERE a.owner_type=? AND a.owner_id=? ORDER BY a.sort_order'
  ).bind(ownerType, ownerId));
  return finalRows.map(fileJson);
}

async function teacherSignup(env, payload) {
  if (!env.TEACHER_SETUP_KEY) {
    throw new AppError('Cloudflare에서 TEACHER_SETUP_KEY를 먼저 설정해 주세요.', 'NOT_CONFIGURED', 503);
  }
  if (!safeEqual(payload.setupKey, env.TEACHER_SETUP_KEY)) {
    throw new AppError('최초 가입 보안키가 일치하지 않습니다.', 'INVALID_SETUP_KEY', 403);
  }
  await ensureSchema(env);
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new AppError('이메일 주소를 확인해 주세요.', 'INVALID_EMAIL');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new AppError('비밀번호는 영문과 숫자를 포함해 8자 이상이어야 합니다.', 'WEAK_PASSWORD');
  }
  const exists = await env.DB.prepare('SELECT id FROM teachers WHERE email=?').bind(email).first();
  if (exists) throw new AppError('이미 가입된 이메일입니다.', 'DUPLICATE_EMAIL', 409);
  const salt = randomToken().slice(0, 24);
  const id = uid('teacher');
  const created = nowIso();
  await env.DB.prepare(
    'INSERT INTO teachers(id,email,name,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)'
  ).bind(id, email, '사랑 선생님', await derivePassword(password, salt), salt, created).run();
  const token = await issueSession(env, 'teacher', id);
  return { token, user: { id, email, name: '사랑 선생님' } };
}

async function teacherLogin(env, payload) {
  if (!(await schemaReady(env))) throw new AppError('아직 교사 계정이 없습니다. 먼저 회원가입해 주세요.', 'SETUP_REQUIRED', 404);
  const email = String(payload.email || '').trim().toLowerCase();
  const row = await env.DB.prepare('SELECT * FROM teachers WHERE email=?').bind(email).first();
  if (!row) throw new AppError('이메일 또는 비밀번호가 올바르지 않습니다.', 'LOGIN_FAILED', 401);
  const calculated = await derivePassword(String(payload.password || ''), row.password_salt);
  if (!safeEqual(calculated, row.password_hash)) {
    throw new AppError('이메일 또는 비밀번호가 올바르지 않습니다.', 'LOGIN_FAILED', 401);
  }
  const token = await issueSession(env, 'teacher', row.id);
  return { token, user: { id: row.id, email: row.email, name: row.name } };
}

async function studentLogin(env, payload) {
  if (!(await schemaReady(env))) throw new AppError('아직 개설된 클래스가 없습니다.', 'SETUP_REQUIRED', 404);
  const code = String(payload.classCode || '').trim().toUpperCase();
  const number = Number(payload.number);
  const classRow = await env.DB.prepare('SELECT * FROM classes WHERE code=?').bind(code).first();
  if (!classRow) throw new AppError('클래스 코드를 확인해 주세요.', 'CLASS_NOT_FOUND', 404);
  const row = await env.DB.prepare('SELECT * FROM students WHERE class_id=? AND number=?').bind(classRow.id, number).first();
  if (!row) throw new AppError('출석번호를 확인해 주세요.', 'STUDENT_NOT_FOUND', 404);
  const calculated = await pinHash(String(payload.pin || ''), row.pin_salt, env);
  if (!safeEqual(calculated, row.pin_hash)) throw new AppError('비밀번호가 일치하지 않습니다.', 'LOGIN_FAILED', 401);
  const seen = nowIso();
  await env.DB.prepare('UPDATE students SET last_seen_at=? WHERE id=?').bind(seen, row.id).run();
  row.last_seen_at = seen;
  const token = await issueSession(env, 'student', row.id, classRow.id);
  return { token, user: studentJson(row), classInfo: classJson(classRow) };
}

async function teacherDashboard(env, session) {
  const teacher = await env.DB.prepare('SELECT id,email,name FROM teachers WHERE id=?').bind(session.user_id).first();
  if (!teacher) throw new AppError('교사 계정을 찾을 수 없습니다.', 'UNAUTHORIZED', 401);
  const rows = await all(env.DB.prepare(
    'SELECT * FROM classes WHERE teacher_id=? ORDER BY display_order, created_at'
  ).bind(session.user_id));
  const classes = rows.map(classJson);
  return {
    teacher,
    classes,
    totals: {
      classes: classes.length,
      students: classes.reduce((sum, item) => sum + item.studentCount, 0),
      assignments: Number((await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM contents c JOIN classes k ON k.id=c.class_id WHERE k.teacher_id=? AND c.type='assignment'"
      ).bind(session.user_id).first()).total || 0),
      boards: Number((await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM contents c JOIN classes k ON k.id=c.class_id WHERE k.teacher_id=? AND c.type='board'"
      ).bind(session.user_id).first()).total || 0)
    }
  };
}

async function createClass(env, session, payload) {
  const name = String(payload.name || '').trim();
  const code = String(payload.code || '').trim().toUpperCase();
  if (!name || !/^[A-Z0-9_-]{3,16}$/.test(code)) {
    throw new AppError('클래스 이름과 3~16자의 영문·숫자 코드를 입력해 주세요.', 'INVALID_CLASS');
  }
  const duplicate = await env.DB.prepare('SELECT id FROM classes WHERE code=?').bind(code).first();
  if (duplicate) throw new AppError('이미 사용 중인 클래스 코드입니다.', 'DUPLICATE_CLASS_CODE', 409);
  const orderRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(display_order),0)+1 AS next_order FROM classes WHERE teacher_id=?'
  ).bind(session.user_id).first();
  const created = nowIso();
  const id = uid('class');
  await env.DB.prepare(
    'INSERT INTO classes(id,teacher_id,name,subject,school,code,student_count,display_order,version,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,1,?,?)'
  ).bind(id, session.user_id, name, String(payload.subject || '').trim(), String(payload.school || '').trim(), code,
    Number(orderRow.next_order || 1), created, created).run();
  return classJson(await env.DB.prepare('SELECT * FROM classes WHERE id=?').bind(id).first());
}

async function reorderClasses(env, session, payload) {
  const requested = Array.from(new Set((payload.classIds || []).map(String)));
  const rows = await all(env.DB.prepare('SELECT id FROM classes WHERE teacher_id=?').bind(session.user_id));
  const known = rows.map((row) => row.id);
  if (requested.length !== known.length || known.some((id) => !requested.includes(id))) {
    throw new AppError('클래스 순서를 다시 불러온 뒤 시도해 주세요.', 'INVALID_CLASS_ORDER');
  }
  await env.DB.batch(requested.map((id, index) => env.DB.prepare(
    'UPDATE classes SET display_order=?, updated_at=? WHERE id=? AND teacher_id=?'
  ).bind(index + 1, nowIso(), id, session.user_id)));
  return { classIds: requested };
}

async function deleteClass(env, session, payload) {
  const row = await ownedClass(env, session, payload.classId);
  if (row.code !== String(payload.confirmCode || '').trim().toUpperCase()) {
    throw new AppError('클래스 코드가 일치하지 않습니다.', 'CLASS_CODE_MISMATCH');
  }
  const [contents, submissions, posts] = await Promise.all([
    all(env.DB.prepare('SELECT id FROM contents WHERE class_id=?').bind(row.id)),
    all(env.DB.prepare('SELECT id FROM submissions WHERE class_id=?').bind(row.id)),
    all(env.DB.prepare('SELECT id FROM board_posts WHERE class_id=?').bind(row.id))
  ]);
  await deleteOwnerFiles(env, 'content', contents.map((item) => item.id));
  await deleteOwnerFiles(env, 'submission', submissions.map((item) => item.id));
  await deleteOwnerFiles(env, 'board_post', posts.map((item) => item.id));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM board_posts WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM submissions WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM contents WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM students WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM classes WHERE id=?').bind(row.id)
  ]);
  return { deleted: true };
}

async function upsertContent(env, session, payload) {
  const type = String(payload.type || '');
  if (!['announcement', 'assignment', 'board'].includes(type)) throw new AppError('잘못된 자료 유형입니다.', 'INVALID_TYPE');
  const classRow = await ownedClass(env, session, payload.classId);
  const data = payload.data || {};
  const title = String(data.title || '').trim();
  if (!title) throw new AppError('제목을 입력해 주세요.', 'TITLE_REQUIRED');
  const time = nowIso();
  let id = String(payload.id || '');
  if (id) {
    const existing = await env.DB.prepare('SELECT * FROM contents WHERE id=? AND class_id=? AND type=?').bind(id, classRow.id, type).first();
    if (!existing) throw new AppError('수정할 글을 찾을 수 없습니다.', 'NOT_FOUND', 404);
    await env.DB.prepare(
      'UPDATE contents SET title=?,body=?,category=?,pinned=?,due_at=?,status=?,updated_at=? WHERE id=?'
    ).bind(title, String(data.body || ''), String(data.category || ''), data.pinned ? 1 : 0,
      String(data.dueAt || ''), String(data.status || 'open'), time, id).run();
  } else {
    id = uid(type);
    await env.DB.prepare(
      'INSERT INTO contents(id,class_id,type,title,body,category,pinned,due_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, classRow.id, type, title, String(data.body || ''), String(data.category || ''), data.pinned ? 1 : 0,
      String(data.dueAt || ''), String(data.status || 'open'), time, time).run();
  }
  const attachments = await replaceAttachments(env, 'content', id, payload.keepAttachmentIds, payload.files, session);
  await touchClass(env, classRow.id);
  const result = contentJson(await env.DB.prepare('SELECT * FROM contents WHERE id=?').bind(id).first());
  result.attachments = attachments;
  return result;
}

async function deleteContent(env, session, payload) {
  const type = String(payload.type || '');
  const row = await env.DB.prepare('SELECT * FROM contents WHERE id=? AND class_id=? AND type=?')
    .bind(String(payload.id || ''), String(payload.classId || ''), type).first();
  if (!row) throw new AppError('삭제할 글을 찾을 수 없습니다.', 'NOT_FOUND', 404);
  await ownedClass(env, session, row.class_id);
  await deleteOwnerFiles(env, 'content', [row.id]);
  if (type === 'assignment') {
    const related = await all(env.DB.prepare('SELECT id FROM submissions WHERE assignment_id=?').bind(row.id));
    await deleteOwnerFiles(env, 'submission', related.map((item) => item.id));
    await env.DB.prepare('DELETE FROM submissions WHERE assignment_id=?').bind(row.id).run();
  }
  if (type === 'board') {
    const related = await all(env.DB.prepare('SELECT id FROM board_posts WHERE board_id=?').bind(row.id));
    await deleteOwnerFiles(env, 'board_post', related.map((item) => item.id));
    await env.DB.prepare('DELETE FROM board_posts WHERE board_id=?').bind(row.id).run();
  }
  await env.DB.prepare('DELETE FROM contents WHERE id=?').bind(row.id).run();
  await touchClass(env, row.class_id);
  return { deleted: true };
}

async function addStudents(env, session, payload) {
  const classRow = await ownedClass(env, session, payload.classId);
  const start = Math.max(1, Number(payload.startNumber || 1));
  const count = Math.min(60, Math.max(1, Number(payload.count || 30)));
  const names = Array.isArray(payload.names) ? payload.names : [];
  const existingRows = await all(env.DB.prepare('SELECT number FROM students WHERE class_id=?').bind(classRow.id));
  const existing = new Set(existingRows.map((row) => Number(row.number)));
  const created = [];
  const statements = [];
  for (let index = 0; index < count; index += 1) {
    const number = start + index;
    if (existing.has(number)) continue;
    const id = uid('student');
    const pin = randomDigits();
    const salt = randomToken().slice(0, 20);
    const name = String(names[index] || `학생 ${number}`).trim() || `학생 ${number}`;
    const createdAt = nowIso();
    statements.push(env.DB.prepare(
      'INSERT INTO students(id,class_id,number,name,pin_hash,pin_salt,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?,?)'
    ).bind(id, classRow.id, number, name, await pinHash(pin, salt, env), salt, '', createdAt));
    created.push({ id, class_id: classRow.id, number, name, pin, last_seen_at: '', online: 0 });
  }
  if (statements.length) await env.DB.batch(statements);
  await env.DB.batch([
    env.DB.prepare('UPDATE classes SET student_count=(SELECT COUNT(*) FROM students WHERE class_id=?),version=version+1,updated_at=? WHERE id=?')
      .bind(classRow.id, nowIso(), classRow.id)
  ]);
  return { students: created.map((row) => studentJson(row, true)) };
}

async function reissueClassPins(env, session, payload) {
  const classRow = await ownedClass(env, session, payload.classId);
  const rows = await all(env.DB.prepare('SELECT * FROM students WHERE class_id=? ORDER BY number').bind(classRow.id));
  if (!rows.length) throw new AppError('먼저 학생을 등록해 주세요.', 'NO_STUDENTS');
  const output = [];
  const statements = [];
  for (const row of rows) {
    const pin = randomDigits();
    const salt = randomToken().slice(0, 20);
    statements.push(env.DB.prepare('UPDATE students SET pin_hash=?,pin_salt=? WHERE id=?')
      .bind(await pinHash(pin, salt, env), salt, row.id));
    output.push(studentJson({ ...row, pin }, true));
  }
  statements.push(env.DB.prepare("DELETE FROM sessions WHERE role='student' AND class_id=?").bind(classRow.id));
  statements.push(env.DB.prepare('UPDATE classes SET version=version+1,updated_at=? WHERE id=?').bind(nowIso(), classRow.id));
  await env.DB.batch(statements);
  return { students: output };
}

async function resetStudentPin(env, session, payload) {
  const row = await env.DB.prepare(
    'SELECT s.*,c.teacher_id FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?'
  ).bind(String(payload.studentId || '')).first();
  if (!row || row.teacher_id !== session.user_id) throw new AppError('학생을 찾을 수 없습니다.', 'NOT_FOUND', 404);
  const pin = randomDigits();
  const salt = randomToken().slice(0, 20);
  await env.DB.batch([
    env.DB.prepare('UPDATE students SET pin_hash=?,pin_salt=? WHERE id=?').bind(await pinHash(pin, salt, env), salt, row.id),
    env.DB.prepare("DELETE FROM sessions WHERE role='student' AND user_id=?").bind(row.id)
  ]);
  return { studentId: row.id, pin };
}

async function deleteStudent(env, session, payload) {
  const row = await env.DB.prepare(
    'SELECT s.*,c.teacher_id FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.class_id=?'
  ).bind(String(payload.studentId || ''), String(payload.classId || '')).first();
  if (!row || row.teacher_id !== session.user_id) throw new AppError('학생을 찾을 수 없습니다.', 'NOT_FOUND', 404);
  const [submissions, posts] = await Promise.all([
    all(env.DB.prepare('SELECT id FROM submissions WHERE student_id=?').bind(row.id)),
    all(env.DB.prepare('SELECT id FROM board_posts WHERE student_id=?').bind(row.id))
  ]);
  await deleteOwnerFiles(env, 'submission', submissions.map((item) => item.id));
  await deleteOwnerFiles(env, 'board_post', posts.map((item) => item.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE role='student' AND user_id=?").bind(row.id),
    env.DB.prepare('DELETE FROM submissions WHERE student_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM board_posts WHERE student_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM students WHERE id=?').bind(row.id),
    env.DB.prepare('UPDATE classes SET student_count=(SELECT COUNT(*) FROM students WHERE class_id=?),version=version+1,updated_at=? WHERE id=?')
      .bind(row.class_id, nowIso(), row.class_id)
  ]);
  return { deleted: true };
}

async function upsertSubmission(env, session, payload) {
  const assignment = await env.DB.prepare(
    "SELECT * FROM contents WHERE id=? AND class_id=? AND type='assignment'"
  ).bind(String(payload.assignmentId || ''), session.class_id).first();
  if (!assignment) throw new AppError('과제를 찾을 수 없습니다.', 'NOT_FOUND', 404);
  if (assignment.status === 'closed') throw new AppError('마감된 과제입니다.', 'ASSIGNMENT_CLOSED');
  const student = await env.DB.prepare('SELECT * FROM students WHERE id=? AND class_id=?')
    .bind(session.user_id, session.class_id).first();
  if (!student) throw new AppError('학생 정보를 찾을 수 없습니다.', 'UNAUTHORIZED', 401);
  const text = String(payload.text || '').trim();
  const hasFiles = (payload.files || []).length || (payload.keepAttachmentIds || []).length;
  if (!text && !hasFiles) throw new AppError('내용이나 파일을 하나 이상 제출해 주세요.', 'EMPTY_SUBMISSION');
  const time = nowIso();
  let row = await env.DB.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?')
    .bind(assignment.id, student.id).first();
  if (row) {
    await env.DB.prepare('UPDATE submissions SET text=?,student_name=?,student_number=?,updated_at=? WHERE id=?')
      .bind(text, student.name, student.number, time, row.id).run();
  } else {
    const id = uid('submission');
    await env.DB.prepare(
      'INSERT INTO submissions(id,assignment_id,class_id,student_id,student_number,student_name,text,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).bind(id, assignment.id, student.class_id, student.id, student.number, student.name, text, time, time).run();
    row = await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(id).first();
  }
  const attachments = await replaceAttachments(env, 'submission', row.id, payload.keepAttachmentIds, payload.files, session);
  if (!text && !attachments.length) throw new AppError('내용이나 파일을 하나 이상 제출해 주세요.', 'EMPTY_SUBMISSION');
  await touchClass(env, student.class_id);
  const result = submissionJson(await env.DB.prepare('SELECT * FROM submissions WHERE id=?').bind(row.id).first());
  result.attachments = attachments;
  return result;
}

async function deleteSubmission(env, session, payload) {
  const row = await env.DB.prepare('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?')
    .bind(String(payload.assignmentId || ''), session.user_id).first();
  if (!row) return { deleted: true };
  await deleteOwnerFiles(env, 'submission', [row.id]);
  await env.DB.prepare('DELETE FROM submissions WHERE id=?').bind(row.id).run();
  await touchClass(env, row.class_id);
  return { deleted: true };
}

async function upsertBoardPost(env, session, payload) {
  const board = await env.DB.prepare(
    "SELECT * FROM contents WHERE id=? AND class_id=? AND type='board'"
  ).bind(String(payload.boardId || ''), session.class_id).first();
  if (!board) throw new AppError('보드를 찾을 수 없습니다.', 'NOT_FOUND', 404);
  if (board.status === 'closed') throw new AppError('지금은 작성할 수 없는 보드입니다.', 'BOARD_CLOSED');
  const student = await env.DB.prepare('SELECT * FROM students WHERE id=? AND class_id=?')
    .bind(session.user_id, session.class_id).first();
  if (!student) throw new AppError('학생 정보를 찾을 수 없습니다.', 'UNAUTHORIZED', 401);
  const text = String(payload.text || '').trim();
  const hasFiles = (payload.files || []).length || (payload.keepAttachmentIds || []).length;
  if (!text && !hasFiles) throw new AppError('내용이나 파일을 하나 이상 게시해 주세요.', 'EMPTY_POST');
  const time = nowIso();
  let row = await env.DB.prepare('SELECT * FROM board_posts WHERE board_id=? AND student_id=?')
    .bind(board.id, student.id).first();
  if (row) {
    await env.DB.prepare(
      "UPDATE board_posts SET text=?,student_name=?,student_number=?,status='published',revision_message='',updated_at=? WHERE id=?"
    ).bind(text, student.name, student.number, time, row.id).run();
  } else {
    const id = uid('post');
    await env.DB.prepare(
      'INSERT INTO board_posts(id,board_id,class_id,student_id,student_number,student_name,text,status,revision_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,\'published\',\'\',?,?)'
    ).bind(id, board.id, student.class_id, student.id, student.number, student.name, text, time, time).run();
    row = await env.DB.prepare('SELECT * FROM board_posts WHERE id=?').bind(id).first();
  }
  const attachments = await replaceAttachments(env, 'board_post', row.id, payload.keepAttachmentIds, payload.files, session);
  if (!text && !attachments.length) throw new AppError('내용이나 파일을 하나 이상 게시해 주세요.', 'EMPTY_POST');
  await touchClass(env, student.class_id);
  const result = postJson(await env.DB.prepare('SELECT * FROM board_posts WHERE id=?').bind(row.id).first());
  result.attachments = attachments;
  return result;
}

async function deleteBoardPost(env, session, payload) {
  const row = await env.DB.prepare('SELECT * FROM board_posts WHERE id=?').bind(String(payload.postId || '')).first();
  if (!row) return { deleted: true };
  if (session.role === 'student') {
    if (row.student_id !== session.user_id) throw new AppError('내 게시글만 삭제할 수 있습니다.', 'FORBIDDEN', 403);
  } else {
    await ownedClass(env, session, row.class_id);
  }
  await deleteOwnerFiles(env, 'board_post', [row.id]);
  await env.DB.prepare('DELETE FROM board_posts WHERE id=?').bind(row.id).run();
  await touchClass(env, row.class_id);
  return { deleted: true };
}

async function reviewBoardPost(env, session, payload) {
  const row = await env.DB.prepare('SELECT * FROM board_posts WHERE id=? AND class_id=?')
    .bind(String(payload.postId || ''), String(payload.classId || '')).first();
  if (!row) throw new AppError('게시글을 찾을 수 없습니다.', 'NOT_FOUND', 404);
  await ownedClass(env, session, row.class_id);
  const decision = String(payload.decision || 'published');
  if (!['revision', 'confirmed', 'published'].includes(decision)) throw new AppError('확인 상태가 올바르지 않습니다.', 'INVALID_REVIEW');
  await env.DB.prepare('UPDATE board_posts SET status=?,revision_message=\'\',updated_at=? WHERE id=?')
    .bind(decision, nowIso(), row.id).run();
  await touchClass(env, row.class_id);
  const result = postJson(await env.DB.prepare('SELECT * FROM board_posts WHERE id=?').bind(row.id).first());
  const attachmentRows = await all(env.DB.prepare(
    "SELECT f.* FROM files f JOIN attachments a ON a.file_id=f.id WHERE a.owner_type='board_post' AND a.owner_id=? ORDER BY a.sort_order"
  ).bind(row.id));
  result.attachments = attachmentRows.map(fileJson);
  return result;
}

async function heartbeat(env, session, payload) {
  const classId = session.role === 'student' ? session.class_id : String(payload.classId || '');
  if (session.role === 'student') {
    await env.DB.prepare('UPDATE students SET last_seen_at=? WHERE id=? AND class_id=?')
      .bind(nowIso(), session.user_id, classId).run();
  } else {
    await ownedClass(env, session, classId);
  }
  const classRow = await env.DB.prepare('SELECT version FROM classes WHERE id=?').bind(classId).first();
  const result = { version: Number(classRow && classRow.version || 1) };
  if (session.role === 'teacher') {
    const cutoff = new Date(Date.now() - 90000).toISOString();
    const rows = await all(env.DB.prepare(
      'SELECT *,1 AS online FROM students WHERE class_id=? AND last_seen_at>=? ORDER BY number'
    ).bind(classId, cutoff));
    result.onlineStudents = rows.map(studentJson);
  }
  return result;
}

async function fileAccess(env, session, fileId) {
  const row = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(String(fileId || '')).first();
  if (!row) throw new AppError('파일을 찾을 수 없습니다.', 'FILE_NOT_FOUND', 404);
  const link = await env.DB.prepare('SELECT owner_type,owner_id FROM attachments WHERE file_id=?').bind(row.id).first();
  if (!link) {
    if (row.uploader_role === session.role && row.uploader_id === session.user_id) {
      return { row, downloadAllowed: true };
    }
    throw new AppError('파일 접근 권한이 없습니다.', 'FORBIDDEN', 403);
  }
  let classId = '';
  let studentId = '';
  if (link.owner_type === 'content') {
    const owner = await env.DB.prepare('SELECT class_id FROM contents WHERE id=?').bind(link.owner_id).first();
    classId = owner && owner.class_id;
  } else if (link.owner_type === 'submission') {
    const owner = await env.DB.prepare('SELECT class_id,student_id FROM submissions WHERE id=?').bind(link.owner_id).first();
    classId = owner && owner.class_id;
    studentId = owner && owner.student_id;
  } else if (link.owner_type === 'board_post') {
    const owner = await env.DB.prepare('SELECT class_id,student_id FROM board_posts WHERE id=?').bind(link.owner_id).first();
    classId = owner && owner.class_id;
    studentId = owner && owner.student_id;
  }
  if (!classId) throw new AppError('파일 연결 정보를 찾을 수 없습니다.', 'FILE_NOT_FOUND', 404);
  if (session.role === 'teacher') {
    await ownedClass(env, session, classId);
    return { row, downloadAllowed: true };
  }
  if (session.class_id !== classId) throw new AppError('파일 접근 권한이 없습니다.', 'FORBIDDEN', 403);
  return { row, downloadAllowed: link.owner_type === 'content' || studentId === session.user_id };
}

async function signedFileUrl(env, request, row, intent) {
  if (!env.TEACHER_SETUP_KEY) throw new AppError('파일 서명키가 설정되지 않았습니다.', 'NOT_CONFIGURED', 503);
  const expires = Math.floor(Date.now() / 1000) + 900;
  const value = `${row.id}|${intent}|${expires}`;
  const signature = await hmac(value, env.TEACHER_SETUP_KEY);
  const origin = new URL(request.url).origin;
  return `${origin}/api/file/${encodeURIComponent(row.id)}?intent=${intent}&expires=${expires}&signature=${encodeURIComponent(signature)}`;
}

async function prepareFileAccess(env, request, session, payload) {
  const access = await fileAccess(env, session, payload.fileId);
  const requested = String(payload.intent || 'preview');
  if (requested === 'download' && !access.downloadAllowed) {
    throw new AppError('친구가 올린 파일은 미리보기만 할 수 있습니다.', 'DOWNLOAD_FORBIDDEN', 403);
  }
  const previewUrl = await signedFileUrl(env, request, access.row, 'preview');
  const downloadUrl = access.downloadAllowed ? await signedFileUrl(env, request, access.row, 'download') : '';
  const office = /\.(doc|docx|ppt|pptx|xls|xlsx)$/i.test(access.row.name || '');
  return {
    ...fileJson(access.row),
    publicUrl: previewUrl,
    previewUrl: office
      ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(previewUrl)}`
      : previewUrl,
    downloadUrl,
    downloadAllowed: access.downloadAllowed,
    previewUnsupported: false
  };
}

function safeFilePart(value) {
  return String(value || '파일').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '파일';
}

async function createDownloadBundle(env, request, session, payload) {
  const classRow = await ownedClass(env, session, payload.classId);
  const kind = String(payload.kind || '');
  const itemId = String(payload.itemId || '');
  let rows = [];
  if (kind === 'assignment') {
    rows = await all(env.DB.prepare(
      "SELECT f.*,s.student_number,s.student_name FROM files f JOIN attachments a ON a.file_id=f.id JOIN submissions s ON s.id=a.owner_id WHERE a.owner_type='submission' AND s.assignment_id=? AND s.class_id=? ORDER BY s.student_number,a.sort_order"
    ).bind(itemId, classRow.id));
  } else if (kind === 'board') {
    rows = await all(env.DB.prepare(
      "SELECT f.*,p.student_number,p.student_name FROM files f JOIN attachments a ON a.file_id=f.id JOIN board_posts p ON p.id=a.owner_id WHERE a.owner_type='board_post' AND p.board_id=? AND p.class_id=? ORDER BY p.student_number,a.sort_order"
    ).bind(itemId, classRow.id));
  } else {
    throw new AppError('다운로드 종류가 올바르지 않습니다.', 'INVALID_TYPE');
  }
  if (!rows.length) throw new AppError('내려받을 첨부파일이 없습니다.', 'NO_FILES', 404);
  const title = safeFilePart(payload.title || (kind === 'assignment' ? '과제' : '보드'));
  const duplicateCounter = new Map();
  const files = [];
  for (const row of rows) {
    const original = safeFilePart(row.name || '첨부파일');
    const dot = original.lastIndexOf('.');
    const extension = dot > 0 ? original.slice(dot) : '';
    const base = `${title}_${Number(row.student_number)}번`;
    const count = (duplicateCounter.get(base) || 0) + 1;
    duplicateCounter.set(base, count);
    const name = `${base}${count > 1 ? `_${String(count).padStart(2, '0')}` : ''}${extension}`;
    files.push({
      id: row.id,
      name,
      size: Number(row.size || 0),
      downloadUrl: await signedFileUrl(env, request, row, 'download')
    });
  }
  return { files, fileCount: files.length, zipName: `${title}_전체.zip` };
}

async function handleAction(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    throw new AppError('요청 내용을 읽지 못했습니다.', 'INVALID_JSON');
  }
  const action = String(body.action || '');
  const payload = body.payload || {};
  if (action === 'teacherSignup') return teacherSignup(env, payload);
  if (action === 'teacherLogin') return teacherLogin(env, payload);
  if (action === 'studentLogin') return studentLogin(env, payload);
  if (!(await schemaReady(env))) throw new AppError('먼저 교사 계정을 만들어 주세요.', 'SETUP_REQUIRED', 404);
  const teacherActions = new Set([
    'teacherDashboard', 'createClass', 'reorderClasses', 'deleteClass', 'getTeacherClass',
    'upsertContent', 'deleteContent', 'addStudents', 'reissueClassPins', 'resetStudentPin',
    'deleteStudent', 'reviewBoardPost', 'createDownloadBundle'
  ]);
  const studentActions = new Set(['getStudentClass', 'upsertSubmission', 'deleteSubmission', 'upsertBoardPost']);
  let role = '';
  if (teacherActions.has(action)) role = 'teacher';
  else if (studentActions.has(action)) role = 'student';
  const session = await sessionFromToken(env, body.token, role);

  switch (action) {
    case 'teacherDashboard': return teacherDashboard(env, session);
    case 'createClass': return createClass(env, session, payload);
    case 'reorderClasses': return reorderClasses(env, session, payload);
    case 'deleteClass': return deleteClass(env, session, payload);
    case 'getTeacherClass':
      await ownedClass(env, session, payload.classId);
      return classData(env, String(payload.classId));
    case 'getStudentClass': return classData(env, session.class_id, session.user_id);
    case 'upsertContent': return upsertContent(env, session, payload);
    case 'deleteContent': return deleteContent(env, session, payload);
    case 'addStudents': return addStudents(env, session, payload);
    case 'reissueClassPins': return reissueClassPins(env, session, payload);
    case 'resetStudentPin': return resetStudentPin(env, session, payload);
    case 'deleteStudent': return deleteStudent(env, session, payload);
    case 'upsertSubmission': return upsertSubmission(env, session, payload);
    case 'deleteSubmission': return deleteSubmission(env, session, payload);
    case 'upsertBoardPost': return upsertBoardPost(env, session, payload);
    case 'deleteBoardPost': return deleteBoardPost(env, session, payload);
    case 'reviewBoardPost': return reviewBoardPost(env, session, payload);
    case 'heartbeat': return heartbeat(env, session, payload);
    case 'prepareFileAccess': return prepareFileAccess(env, request, session, payload);
    case 'getFileContent': return prepareFileAccess(env, request, session, { fileId: payload.fileId, intent: 'preview' });
    case 'createDownloadBundle': return createDownloadBundle(env, request, session, payload);
    default: throw new AppError(`지원하지 않는 요청입니다: ${action}`, 'UNKNOWN_ACTION', 404);
  }
}

async function handleUpload(request, env) {
  if (!(await schemaReady(env))) throw new AppError('먼저 교사 계정을 만들어 주세요.', 'SETUP_REQUIRED', 404);
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const session = await sessionFromToken(env, token);
  const declaredSize = Number(request.headers.get('X-File-Size') || request.headers.get('Content-Length') || 0);
  const maxBytes = 25 * 1024 * 1024;
  if (!declaredSize || declaredSize > maxBytes) {
    throw new AppError('파일은 25MB 이하만 업로드할 수 있습니다.', 'FILE_TOO_LARGE', 413);
  }
  if (!request.body) throw new AppError('업로드할 파일이 없습니다.', 'EMPTY_FILE');
  let name = '첨부파일';
  try { name = decodeURIComponent(request.headers.get('X-File-Name') || name); } catch (_) {}
  name = String(name).replace(/[\u0000-\u001f]/g, '').slice(0, 180) || '첨부파일';
  const mimeType = String(request.headers.get('X-File-Type') || 'application/octet-stream').slice(0, 120);
  const id = uid('file');
  const key = `${session.role}/${session.user_id}/${new Date().toISOString().slice(0, 10)}/${id}`;
  await env.FILES.put(key, request.body, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { originalName: encodeURIComponent(name), uploaderRole: session.role }
  });
  try {
    await env.DB.prepare(
      'INSERT INTO files(id,r2_key,name,mime_type,size,uploader_role,uploader_id,created_at,claimed_at) VALUES(?,?,?,?,?,?,?,?,\'\')'
    ).bind(id, key, name, mimeType, declaredSize, session.role, session.user_id, nowIso()).run();
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }
  return fileJson({ id, name, mime_type: mimeType, size: declaredSize });
}

async function handleSignedFile(request, env, fileId) {
  const url = new URL(request.url);
  const intent = url.searchParams.get('intent') === 'download' ? 'download' : 'preview';
  const expires = Number(url.searchParams.get('expires') || 0);
  const signature = String(url.searchParams.get('signature') || '');
  if (!env.TEACHER_SETUP_KEY || expires < Math.floor(Date.now() / 1000)) {
    throw new AppError('파일 주소가 만료되었습니다. 다시 열어 주세요.', 'LINK_EXPIRED', 403);
  }
  const expected = await hmac(`${fileId}|${intent}|${expires}`, env.TEACHER_SETUP_KEY);
  if (!safeEqual(signature, expected)) throw new AppError('잘못된 파일 주소입니다.', 'INVALID_SIGNATURE', 403);
  const row = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(fileId).first();
  if (!row) throw new AppError('파일을 찾을 수 없습니다.', 'FILE_NOT_FOUND', 404);
  const object = await env.FILES.get(row.r2_key, { range: request.headers });
  if (!object) throw new AppError('저장된 파일을 찾을 수 없습니다.', 'FILE_NOT_FOUND', 404);
  const safeName = encodeURIComponent(row.name).replace(/'/g, '%27');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', row.mime_type || headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Accept-Ranges', 'bytes');
  let status = 200;
  if (object.range && typeof object.range.offset === 'number' && typeof object.range.length === 'number') {
    status = 206;
    headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
    headers.set('Content-Length', String(object.range.length));
  } else {
    headers.set('Content-Length', String(object.size));
  }
  headers.set('Content-Disposition', `${intent === 'download' ? 'attachment' : 'inline'}; filename*=UTF-8''${safeName}`);
  headers.set('Cache-Control', 'private, max-age=300');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api')) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    try {
      if (url.pathname === '/api/health') {
        return ok({ status: 'ok', databaseReady: await schemaReady(env), provider: 'cloudflare' }, request);
      }
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        return ok(await handleUpload(request, env), request);
      }
      if (url.pathname.startsWith('/api/file/') && request.method === 'GET') {
        const fileId = decodeURIComponent(url.pathname.slice('/api/file/'.length));
        return await handleSignedFile(request, env, fileId);
      }
      if (url.pathname === '/api' && request.method === 'POST') {
        return ok(await handleAction(request, env), request);
      }
      if (url.pathname.startsWith('/api')) throw new AppError('API 주소를 찾을 수 없습니다.', 'NOT_FOUND', 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error, request);
    }
  }
};
