import qrcode from 'qrcode-generator';

const RELEASE = '2026-10-24-v63';
const FREE_R2_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
let featureSchemaVerified = false;
let featureSchemaError = '';
let coreSchemaCheckedAt = 0;
let schemaCheckPromise = null;
const initializedGuestRooms = new Set();
// Only raw, server-side snapshots are shared. Every response is copied and
// filtered for the authenticated student before it leaves this Worker.
const classSnapshots = new Map();
// The storage meter is a dashboard hint. Share one short-lived aggregate
// across requests handled by this isolate and refresh it after file rows move.
let fileStorageStatusCache = null;
let fileStorageStatusCacheAt = 0;
let fileStorageStatusPromise = null;
let fileStorageStatusGeneration = 0;
let studentCredentialSchemaReady = false;
let studentCredentialSchemaPromise = null;

const TEACHER_RESOURCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS teacher_resources (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS teacher_resources_teacher_updated ON teacher_resources(teacher_id,updated_at DESC,id DESC);
`;
let teacherResourceSchemaPromise = null;

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
  title TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS board_post_reactions (
  post_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(post_id,student_id),
  FOREIGN KEY (post_id) REFERENCES board_posts(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS board_post_reactions_student ON board_post_reactions(student_id,post_id);
CREATE TABLE IF NOT EXISTS idea_posts (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_number INTEGER NOT NULL,
  student_name TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (idea_id) REFERENCES contents(id) ON DELETE CASCADE,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idea_posts_class_idea ON idea_posts(class_id, idea_id, created_at);
CREATE INDEX IF NOT EXISTS idea_posts_student ON idea_posts(student_id, updated_at);
CREATE TABLE IF NOT EXISTS class_timers (
  class_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '활동 시간',
  sound TEXT NOT NULL DEFAULT 'bell',
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS guest_rooms (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  title TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'open',
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS guest_rooms_teacher_created ON guest_rooms(teacher_id, created_at);
CREATE TABLE IF NOT EXISTS guest_boards (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(room_id, title),
  FOREIGN KEY (room_id) REFERENCES guest_rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS guest_boards_room_order ON guest_boards(room_id, display_order, created_at);
CREATE TABLE IF NOT EXISTS guest_posts (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  board_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (room_id) REFERENCES guest_rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS guest_posts_room_kind ON guest_posts(room_id, kind, created_at);
CREATE INDEX IF NOT EXISTS guest_posts_participant ON guest_posts(participant_id, updated_at);
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
CREATE TABLE IF NOT EXISTS drive_archives (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  original_file_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  archive_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  drive_url TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_archives_class ON drive_archives(class_id, archived_at);
${TEACHER_RESOURCE_SCHEMA}
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

function normalizeClassCode(value) {
  return String(value || '').trim().normalize('NFC').toUpperCase();
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function randomDigits() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(1000 + (bytes[0] % 9000));
}

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
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
  const causeMessage = String(error && error.message || '');
  if (/exceeded.*(?:daily|free tier).*limit|daily.*(?:row read|row write).*limit/i.test(causeMessage)) {
    const retryAt = new Date();
    retryAt.setUTCHours(24, 0, 0, 0);
    return json({ ok: false, code: 'DAILY_LIMIT_EXCEEDED', message: '오늘의 무료 사용 한도에 도달했습니다. 한국 시간 다음 오전 9시 이후 다시 시도해 주세요.', details: { retryAt: retryAt.toISOString() } }, 429, request);
  }
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
  const statements = SCHEMA.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (let index = 0; index < statements.length; index += 1) {
    try {
      await env.DB.prepare(statements[index]).run();
    } catch (error) {
      const reason = String(error && error.message || '알 수 없는 D1 오류').slice(0, 300);
      throw new AppError(
        `데이터베이스 초기화 ${index + 1}단계에서 실패했습니다: ${reason}`,
        'DATABASE_SETUP_FAILED',
        500
      );
    }
  }
  await ensureBoardPostTitleSchema(env);
  await ensureGuestBoardSchema(env);
  await ensureClassTimerSoundSchema(env);
  featureSchemaVerified = true;
}

async function ensureClassTimerSoundSchema(env) {
  const columns = await all(env.DB.prepare('PRAGMA table_info(class_timers)'));
  if (columns.some((column) => column.name === 'sound')) return;
  try {
    await env.DB.prepare("ALTER TABLE class_timers ADD COLUMN sound TEXT NOT NULL DEFAULT 'bell'").run();
  } catch (error) {
    if (!String(error && error.message || '').includes('duplicate column name')) throw error;
  }
}

async function ensureBoardPostTitleSchema(env) {
  const columns = await all(env.DB.prepare('PRAGMA table_info(board_posts)'));
  if (columns.some((column) => column.name === 'title')) return;
  try {
    await env.DB.prepare("ALTER TABLE board_posts ADD COLUMN title TEXT NOT NULL DEFAULT ''").run();
  } catch (error) {
    if (!String(error && error.message || '').includes('duplicate column name')) throw error;
  }
}

async function ensureGuestBoardSchema(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS guest_boards (' +
      'id TEXT PRIMARY KEY,room_id TEXT NOT NULL,title TEXT NOT NULL,display_order INTEGER NOT NULL DEFAULT 0,' +
      'created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(room_id,title),' +
      'FOREIGN KEY (room_id) REFERENCES guest_rooms(id) ON DELETE CASCADE)'
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS guest_boards_room_order ON guest_boards(room_id,display_order,created_at)').run();
  const columns = await all(env.DB.prepare('PRAGMA table_info(guest_posts)'));
  if (!columns.some((column) => column.name === 'board_id')) {
    try {
      await env.DB.prepare("ALTER TABLE guest_posts ADD COLUMN board_id TEXT NOT NULL DEFAULT ''").run();
    } catch (error) {
      if (!String(error && error.message || '').includes('duplicate column name')) throw error;
    }
  }
  if (!columns.some((column) => column.name === 'title')) {
    try {
      await env.DB.prepare("ALTER TABLE guest_posts ADD COLUMN title TEXT NOT NULL DEFAULT ''").run();
    } catch (error) {
      if (!String(error && error.message || '').includes('duplicate column name')) throw error;
    }
  }
}

async function ensureStudentCredentialSchema(env) {
  if (studentCredentialSchemaReady) return;
  if (!studentCredentialSchemaPromise) {
    studentCredentialSchemaPromise = (async () => {
      const columns = await all(env.DB.prepare('PRAGMA table_info(students)'));
      if (!columns.length) throw new AppError('학생 계정 표를 찾을 수 없습니다.', 'DATABASE_SETUP_FAILED', 500);
      const known = new Set(columns.map((column) => column.name));
      for (const [name, definition] of [
        ['password_hash', "TEXT NOT NULL DEFAULT ''"],
        ['password_salt', "TEXT NOT NULL DEFAULT ''"]
      ]) {
        if (known.has(name)) continue;
        try {
          await env.DB.prepare(`ALTER TABLE students ADD COLUMN ${name} ${definition}`).run();
        } catch (error) {
          if (!String(error && error.message || '').includes('duplicate column name')) throw error;
        }
      }
      studentCredentialSchemaReady = true;
    })().finally(() => { studentCredentialSchemaPromise = null; });
  }
  await studentCredentialSchemaPromise;
}

async function checkSchema(env) {
  try {
    const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='teachers'").first();
    if (!row) return false;
    if (!featureSchemaVerified) {
      try {
        const featureTables = await all(env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('idea_posts','class_timers','guest_rooms','guest_posts','board_post_reactions')"
        ));
        if (featureTables.length < 5) await ensureSchema(env);
        else {
          await ensureBoardPostTitleSchema(env);
          await ensureGuestBoardSchema(env);
          await ensureClassTimerSoundSchema(env);
        }
        featureSchemaVerified = true;
        featureSchemaError = '';
      } catch (error) {
        featureSchemaError = String(error && error.message || '기능 데이터베이스 업데이트 실패').slice(0, 240);
        console.error('Optional feature schema upgrade failed:', error);
      }
    }
    coreSchemaCheckedAt = Date.now();
    return true;
  } catch (error) {
    if (/exceeded.*(?:daily|free tier).*limit|daily.*(?:row read|row write).*limit/i.test(String(error && error.message || ''))) throw error;
    console.error('Core database check failed:', error);
    return false;
  }
}

async function schemaReady(env) {
  if (coreSchemaCheckedAt && Date.now() - coreSchemaCheckedAt < 60000) return true;
  if (!schemaCheckPromise) {
    schemaCheckPromise = checkSchema(env).finally(() => { schemaCheckPromise = null; });
  }
  return schemaCheckPromise;
}

async function issueSession(env, role, userId, classId = '', expiresAt = '') {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const created = nowIso();
  const lifetime = role === 'teacher' ? 30 * 86400000 : 12 * 3600000;
  const expires = expiresAt || new Date(Date.now() + lifetime).toISOString();
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
    accountReady: Boolean(row.password_hash),
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
    title: row.title || '',
    text: row.text || '',
    status: row.status || 'published',
    revisionMessage: row.revision_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: []
  };
}

function timerJson(row) {
  if (!row) return null;
  return {
    classId: row.class_id,
    title: row.title || '활동 시간',
    sound: ['bell', 'chime', 'woodblock', 'ascending'].includes(row.sound) ? row.sound : 'bell',
    startedAt: row.started_at,
    endsAt: row.ends_at,
    ended: row.ends_at <= nowIso(),
    updatedAt: row.updated_at
  };
}

function ideaPostJson(row, revealAuthor = false, viewerId = '') {
  const item = {
    id: row.id,
    ideaId: row.idea_id,
    classId: row.class_id,
    text: row.text || '',
    groupName: row.group_name || '',
    mine: Boolean(viewerId && row.student_id === viewerId),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (revealAuthor) {
    item.studentId = row.student_id;
    item.studentNumber = Number(row.student_number);
    item.studentName = row.student_name;
  }
  return item;
}

function guestRoomJson(row) {
  const expired = Boolean(row && row.expires_at && row.expires_at <= nowIso());
  return {
    id: row.id,
    title: row.title,
    code: row.code,
    status: expired && row.status === 'open' ? 'expired' : row.status,
    expiresAt: row.expires_at,
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function guestBoardJson(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    displayOrder: Number(row.display_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function guestPostJson(row, viewerId = '') {
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    boardId: row.board_id || '',
    title: row.title || '',
    text: row.text || '',
    mine: Boolean(viewerId && row.participant_id === viewerId),
    teacher: String(row.participant_id || '').startsWith('teacher:'),
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

async function classData(env, classId, studentId = '', knownVersion = null) {
  let version = knownVersion;
  if (version == null) {
    const row = await env.DB.prepare('SELECT version FROM classes WHERE id=?').bind(classId).first();
    if (!row) throw new AppError('클래스를 찾을 수 없습니다.', 'NOT_FOUND', 404);
    version = Number(row.version || 1);
  }
  let entry = classSnapshots.get(classId);
  if (!entry || entry.version !== version || Date.now() >= entry.expiresAt) {
    if (!classSnapshots.has(classId) && classSnapshots.size >= 12) {
      classSnapshots.delete(classSnapshots.keys().next().value);
    }
    entry = { version, expiresAt: Date.now() + 10000, promise: null };
    classSnapshots.set(classId, entry);
    entry.promise = readClassSnapshot(env, classId).catch((error) => {
      if (classSnapshots.get(classId) === entry) classSnapshots.delete(classId);
      throw error;
    });
  }
  const data = structuredClone(await entry.promise);
  if (studentId) {
    for (const item of data.students) delete item.accountReady;
    data.submissions = data.submissions.filter((item) => item.studentId === studentId);
    for (const item of data.boardPosts) {
      if (item.studentId !== studentId) {
        item.status = 'published';
        item.revisionMessage = '';
      }
    }
    for (const item of data.ideaPosts) {
      item.mine = item.studentId === studentId;
      delete item.studentId;
      delete item.studentNumber;
      delete item.studentName;
    }
    if (data.boardPosts.length) {
      const selected = await all(env.DB.prepare(
        `SELECT post_id,emoji FROM board_post_reactions WHERE student_id=? AND post_id IN (${placeholders(data.boardPosts.length)})`
      ).bind(studentId, ...data.boardPosts.map((post) => post.id)));
      const byPost = new Map(selected.map((row) => [row.post_id, row.emoji]));
      for (const post of data.boardPosts) post.myReaction = byPost.get(post.id) || '';
    }
  }
  return data;
}

async function readClassSnapshot(env, classId, studentId = '') {
  const classRow = await env.DB.prepare('SELECT * FROM classes WHERE id=?').bind(classId).first();
  if (!classRow) throw new AppError('클래스를 찾을 수 없습니다.', 'NOT_FOUND', 404);
  const [studentRows, contentRows, submissionRows, postRows, ideaPostRows, timerRow, attachmentMap] = await Promise.all([
    all(env.DB.prepare('SELECT * FROM students WHERE class_id=? ORDER BY number').bind(classId)),
    all(env.DB.prepare('SELECT * FROM contents WHERE class_id=? ORDER BY created_at DESC').bind(classId)),
    all(env.DB.prepare(
      studentId
        ? 'SELECT * FROM submissions WHERE class_id=? AND student_id=? ORDER BY submitted_at DESC'
        : 'SELECT * FROM submissions WHERE class_id=? ORDER BY student_number, submitted_at DESC'
    ).bind(...(studentId ? [classId, studentId] : [classId]))),
    all(env.DB.prepare('SELECT * FROM board_posts WHERE class_id=? ORDER BY student_number').bind(classId)),
    all(env.DB.prepare('SELECT * FROM idea_posts WHERE class_id=? ORDER BY created_at, id').bind(classId)),
    env.DB.prepare('SELECT * FROM class_timers WHERE class_id=?').bind(classId).first(),
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
  if (posts.length) {
    const reactionRows = await all(env.DB.prepare(
      `SELECT post_id,emoji,COUNT(*) AS total FROM board_post_reactions WHERE post_id IN (${placeholders(posts.length)}) GROUP BY post_id,emoji`
    ).bind(...posts.map((post) => post.id)));
    const postById = new Map(posts.map((post) => [post.id, post]));
    for (const post of posts) post.reactions = {};
    for (const row of reactionRows) postById.get(row.post_id).reactions[row.emoji] = Number(row.total || 0);
  }
  const ideaPosts = ideaPostRows.map((row) => ideaPostJson(row, !studentId, studentId));
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
  const ideaPostCounts = new Map();
  for (const item of ideaPosts) ideaPostCounts.set(item.ideaId, (ideaPostCounts.get(item.ideaId) || 0) + 1);
  const announcements = contents.filter((item, index) => contentRows[index].type === 'announcement');
  const assignments = contents.filter((item, index) => contentRows[index].type === 'assignment')
    .map((item) => ({ ...item, submissionCount: submissionCounts.get(item.id) || 0 }));
  const boards = contents.filter((item, index) => contentRows[index].type === 'board')
    .map((item) => ({ ...item, postCount: postCounts.get(item.id) || 0 }));
  const ideas = contents.filter((item, index) => contentRows[index].type === 'idea')
    .map((item) => ({ ...item, responseCount: ideaPostCounts.get(item.id) || 0 }));
  return {
    classInfo: classJson(classRow),
    students,
    announcements,
    assignments,
    boards,
    ideas,
    submissions,
    boardPosts: posts,
    ideaPosts,
    timer: timerJson(timerRow),
  };
}

async function touchClass(env, classId) {
  const row = await env.DB.prepare('UPDATE classes SET version=version+1, updated_at=? WHERE id=? RETURNING version')
    .bind(nowIso(), classId).first();
  await notifyClassSync(env, classId, 'class-changed', Number(row && row.version || 0));
}

async function notifyClassSync(env, classId, type = 'class-changed', version = null) {
  if (!classId) return;
  classSnapshots.delete(String(classId));
  if (!env.CLASS_SYNC) return;
  try {
    const stub = env.CLASS_SYNC.get(env.CLASS_SYNC.idFromName(String(classId)));
    await stub.fetch('https://class-sync/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, classId: String(classId), version, eventId: crypto.randomUUID() })
    });
  } catch (error) {
    console.error('Class sync notification failed:', String(error && error.message || error));
  }
}

async function classSyncSocket(request, env) {
  if (String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    throw new AppError('실시간 동기화 연결이 필요합니다.', 'WEBSOCKET_REQUIRED', 426);
  }
  const protocols = String(request.headers.get('Sec-WebSocket-Protocol') || '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const token = protocols.find((item) => item !== 'learn-sync');
  if (!protocols.includes('learn-sync') || !token) throw new AppError('로그인이 필요합니다.', 'UNAUTHORIZED', 401);
  const session = await sessionFromToken(env, token);
  let classId = '';
  if (session.role === 'student') classId = session.class_id;
  else if (session.role === 'teacher') {
    classId = String(new URL(request.url).searchParams.get('classId') || '');
    await ownedClass(env, session, classId);
  } else throw new AppError('실시간 동기화 권한이 없습니다.', 'FORBIDDEN', 403);
  const stub = env.CLASS_SYNC.get(env.CLASS_SYNC.idFromName(String(classId)));
  return stub.fetch(request);
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
    invalidateFileStorageStatus();
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
    invalidateFileStorageStatus();
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

// Only resource-room requests initialize this table on existing databases.
async function ensureTeacherResourceSchema(env) {
  if (!teacherResourceSchemaPromise) {
    teacherResourceSchemaPromise = (async () => {
      for (const sql of TEACHER_RESOURCE_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
        await env.DB.prepare(sql).run();
      }
      const columns = await all(env.DB.prepare('PRAGMA table_info(teacher_resources)'));
      if (!columns.some((column) => column.name === 'category')) {
        try {
          await env.DB.prepare("ALTER TABLE teacher_resources ADD COLUMN category TEXT NOT NULL DEFAULT ''").run();
        } catch (error) {
          if (!String(error && error.message || '').includes('duplicate column name')) throw error;
        }
      }
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS teacher_resources_teacher_category_updated ON teacher_resources(teacher_id,category,updated_at DESC,id DESC)').run();
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS teacher_resources_teacher_title ON teacher_resources(teacher_id,title COLLATE NOCASE)').run();
    })().catch((error) => { teacherResourceSchemaPromise = null; throw error; });
  }
  return teacherResourceSchemaPromise;
}

async function ownedTeacherResource(env, session, id) {
  const row = await env.DB.prepare('SELECT * FROM teacher_resources WHERE id=? AND teacher_id=?')
    .bind(String(id || ''), session.user_id).first();
  if (!row) throw new AppError('자료를 찾을 수 없습니다.', 'NOT_FOUND', 404);
  return row;
}

function teacherResourceJson(row) {
  return { id: row.id, title: row.title, category: row.category || '', body: row.body, links: JSON.parse(row.links),
    createdAt: row.created_at, updatedAt: row.updated_at, attachments: [] };
}

async function getTeacherResources(env, session, payload) {
  await ensureTeacherResourceSchema(env);
  const cursor = payload.cursor;
  const category = payload.category == null ? null : normalizeResourceCategory(payload.category);
  const search = String(payload.search || '').trim().slice(0, 80);
  if (search.includes('%') || search.includes('_') || search.includes('\\')) {
    throw new AppError('검색어에서 %, _ 기호는 사용할 수 없습니다.', 'INVALID_SEARCH');
  }
  const conditions = ['teacher_id=?'];
  const bindings = [session.user_id];
  if (category !== null) { conditions.push('category=?'); bindings.push(category); }
  if (search) {
    conditions.push('title LIKE ? COLLATE NOCASE');
    bindings.push(search + '%');
  }
  if (cursor) {
    conditions.push('(updated_at<? OR (updated_at=? AND id<?))');
    bindings.push(String(cursor.updatedAt || ''), String(cursor.updatedAt || ''), String(cursor.id || ''));
  }
  const rows = await all(env.DB.prepare(
    'SELECT * FROM teacher_resources' + (search ? ' INDEXED BY teacher_resources_teacher_title' : '') +
    ' WHERE ' + conditions.join(' AND ') +
    ' ORDER BY updated_at DESC,id DESC LIMIT 51'
  ).bind(...bindings));
  const page = rows.slice(0, 50);
  const items = page.map(teacherResourceJson);
  if (page.length) {
    const attachments = await all(env.DB.prepare(
      `SELECT a.owner_id,f.* FROM attachments a JOIN files f ON f.id=a.file_id WHERE a.owner_type='teacher_resource' AND a.owner_id IN (${placeholders(page.length)}) ORDER BY a.sort_order`
    ).bind(...page.map((row) => row.id)));
    const map = new Map(items.map((item) => [item.id, item]));
    for (const file of attachments) map.get(file.owner_id).attachments.push(fileJson(file));
  }
  const last = page[page.length - 1];
  const categories = !cursor ? (await all(env.DB.prepare(
    "SELECT DISTINCT category FROM teacher_resources WHERE teacher_id=? AND category<>'' ORDER BY category"
  ).bind(session.user_id))).map((row) => row.category) : undefined;
  return { items, categories, nextCursor: rows.length > 50 ? { updatedAt: last.updated_at, id: last.id } : null };
}

function normalizeResourceCategory(value) {
  const category = String(value || '').trim().normalize('NFC');
  if (category.length > 40 || /[\u0000-\u001f\u007f]/.test(category)) {
    throw new AppError('카테고리 이름은 줄바꿈 없이 40자까지 입력해 주세요.', 'INVALID_CATEGORY');
  }
  return category;
}

function normalizeResourceLinks(value) {
  if (!Array.isArray(value) || value.length > 20) throw new AppError('링크는 최대 20개까지 저장할 수 있어요.', 'INVALID_LINK');
  return Array.from(new Set(value.map((entry) => {
    const text = String(entry || '').trim();
    let url;
    try { url = new URL(text); } catch (_) { /* Report a helpful validation error below. */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || text.length > 2048) {
      throw new AppError('링크는 https:// 또는 http://로 시작하는 웹 주소를 입력해 주세요.', 'INVALID_LINK');
    }
    return url.href;
  })));
}

async function upsertTeacherResource(env, session, payload) {
  await ensureTeacherResourceSchema(env);
  const existing = payload.id ? await ownedTeacherResource(env, session, payload.id) : null;
  const category = payload.category === undefined && existing ? existing.category : normalizeResourceCategory(payload.category);
  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  if (!title || title.length > 100) throw new AppError('제목은 1~100자로 입력해 주세요.', 'INVALID_TITLE');
  if (body.length > 5000) throw new AppError('설명은 5,000자까지 입력할 수 있어요.', 'INVALID_BODY');
  const links = normalizeResourceLinks(payload.links || []);
  if (!Array.isArray(payload.files || []) || !Array.isArray(payload.keepAttachmentIds || [])) {
    throw new AppError('첨부파일 정보를 확인해 주세요.', 'INVALID_UPLOAD');
  }
  // Validate new uploads before changing the resource or removing existing files.
  const ids = (payload.files || []).map((file) => String(file.id || ''));
  if (ids.length) {
    const files = await all(env.DB.prepare(`SELECT * FROM files WHERE id IN (${placeholders(ids.length)})`).bind(...ids));
    if (files.length !== ids.length || files.some((file) => file.uploader_role !== 'teacher' || file.uploader_id !== session.user_id || file.claimed_at)) {
      throw new AppError('새로 업로드한 파일을 선택해 주세요.', 'INVALID_UPLOAD');
    }
  }
  const id = existing ? existing.id : uid('resource');
  const time = nowIso();
  if (existing) {
    await env.DB.prepare('UPDATE teacher_resources SET title=?,category=?,body=?,links=?,updated_at=? WHERE id=? AND teacher_id=?')
      .bind(title, category, body, JSON.stringify(links), time, id, session.user_id).run();
  } else {
    await env.DB.prepare('INSERT INTO teacher_resources(id,teacher_id,title,category,body,links,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(id, session.user_id, title, category, body, JSON.stringify(links), time, time).run();
  }
  const attachments = await replaceAttachments(env, 'teacher_resource', id, payload.keepAttachmentIds, payload.files, session);
  return { ...teacherResourceJson(await ownedTeacherResource(env, session, id)), attachments };
}

async function deleteTeacherResource(env, session, payload) {
  await ensureTeacherResourceSchema(env);
  const row = await ownedTeacherResource(env, session, payload.id);
  await deleteOwnerFiles(env, 'teacher_resource', [row.id]);
  await env.DB.prepare('DELETE FROM teacher_resources WHERE id=? AND teacher_id=?').bind(row.id, session.user_id).run();
  return { deleted: true };
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
  await ensureStudentCredentialSchema(env);
  const code = normalizeClassCode(payload.classCode);
  const number = Number(payload.number);
  const nickname = String(payload.nickname || '').trim().normalize('NFC');
  const password = String(payload.password || '');
  if (!Number.isInteger(number) || number < 1 || number > 999) {
    throw new AppError('출석번호를 확인해 주세요.', 'INVALID_STUDENT_NUMBER');
  }
  if (!nickname || nickname.length > 20 || /[\u0000-\u001f\u007f]/.test(nickname)) {
    throw new AppError('닉네임은 1~20자로 입력해 주세요.', 'INVALID_NICKNAME');
  }
  if (password.length < 8 || password.length > 128) {
    throw new AppError('비밀번호는 8~128자로 입력해 주세요.', 'WEAK_PASSWORD');
  }
  const classRow = await env.DB.prepare('SELECT * FROM classes WHERE code=?').bind(code).first();
  if (!classRow) throw new AppError('클래스 코드를 확인해 주세요.', 'CLASS_NOT_FOUND', 404);
  const row = await env.DB.prepare('SELECT * FROM students WHERE class_id=? AND number=?').bind(classRow.id, number).first();
  if (!row) throw new AppError('출석번호를 확인해 주세요.', 'STUDENT_NOT_FOUND', 404);
  let changedName = false;
  let studentUpdate = null;
  if (row.password_hash) {
    const calculated = await derivePassword(password, row.password_salt);
    if (!safeEqual(calculated, row.password_hash)) throw new AppError('닉네임 또는 비밀번호를 확인해 주세요.', 'LOGIN_FAILED', 401);
    if (row.name !== nickname) {
      studentUpdate = env.DB.prepare('UPDATE students SET name=? WHERE id=?').bind(nickname, row.id);
      changedName = true;
    }
  } else {
    const initialPin = String(payload.initialPin || '');
    if (!initialPin) {
      throw new AppError('처음 로그인은 선생님이 준 초기 4자리 비밀번호를 입력해 계정을 만들어 주세요.', 'ACCOUNT_SETUP_REQUIRED', 409);
    }
    const calculated = await pinHash(initialPin, row.pin_salt, env);
    if (!safeEqual(calculated, row.pin_hash)) throw new AppError('초기 비밀번호가 일치하지 않습니다.', 'LOGIN_FAILED', 401);
    const salt = randomToken().slice(0, 32);
    const passwordHash = await derivePassword(password, salt);
    studentUpdate = env.DB.prepare('UPDATE students SET name=?,password_hash=?,password_salt=? WHERE id=?')
      .bind(nickname, passwordHash, salt, row.id);
    changedName = true;
  }
  if (changedName) {
    await env.DB.batch([
      studentUpdate,
      env.DB.prepare('UPDATE classes SET version=version+1,updated_at=? WHERE id=?').bind(nowIso(), classRow.id)
    ]);
    await notifyClassSync(env, classRow.id, 'class-changed', Number(classRow.version || 0) + 1);
  }
  const token = await issueSession(env, 'student', row.id, classRow.id);
  return { token, user: studentJson({ ...row, name: nickname }), classInfo: classJson(classRow) };
}

async function teacherDashboard(env, session) {
  const teacher = await env.DB.prepare('SELECT id,email,name FROM teachers WHERE id=?').bind(session.user_id).first();
  if (!teacher) throw new AppError('교사 계정을 찾을 수 없습니다.', 'UNAUTHORIZED', 401);
  const rows = await all(env.DB.prepare(
    'SELECT * FROM classes WHERE teacher_id=? ORDER BY display_order, created_at'
  ).bind(session.user_id));
  const classes = rows.map(classJson);
  const guestRows = await all(env.DB.prepare(
    'SELECT * FROM guest_rooms WHERE teacher_id=? ORDER BY created_at DESC'
  ).bind(session.user_id));
  const guestRooms = guestRows.map(guestRoomJson);
  return {
    teacher,
    classes,
    guestRooms,
    storage: await fileStorageStatus(env),
    totals: {
      classes: classes.length,
      guestRooms: guestRooms.filter((item) => item.status === 'open').length,
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

async function ownedGuestRoom(env, session, roomId) {
  const row = await env.DB.prepare(
    'SELECT * FROM guest_rooms WHERE id=? AND teacher_id=?'
  ).bind(String(roomId || ''), session.user_id).first();
  if (!row) throw new AppError('1회성 참여방을 찾을 수 없습니다.', 'NOT_FOUND', 404);
  return row;
}

async function touchGuestRoom(env, roomId) {
  await env.DB.prepare(
    'UPDATE guest_rooms SET version=version+1,updated_at=? WHERE id=?'
  ).bind(nowIso(), roomId).run();
}

async function guestRoomData(env, roomRow, viewerId = '') {
  const boards = await ensureDefaultGuestBoard(env, roomRow.id);
  const rows = await all(env.DB.prepare(
    'SELECT * FROM guest_posts WHERE room_id=? ORDER BY created_at,id'
  ).bind(roomRow.id));
  const attachmentRows = await all(env.DB.prepare(
    "SELECT a.owner_id,f.* FROM attachments a JOIN files f ON f.id=a.file_id JOIN guest_posts p ON p.id=a.owner_id WHERE a.owner_type='guest_post' AND p.room_id=? ORDER BY a.sort_order"
  ).bind(roomRow.id));
  const files = new Map();
  for (const row of attachmentRows) {
    if (!files.has(row.owner_id)) files.set(row.owner_id, []);
    files.get(row.owner_id).push(fileJson(row));
  }
  const posts = rows.map((row) => {
    const item = guestPostJson(row, viewerId);
    item.attachments = files.get(row.id) || [];
    return item;
  });
  return { room: guestRoomJson(roomRow), boards: boards.map(guestBoardJson), posts };
}

async function ensureDefaultGuestBoard(env, roomId) {
  let rows = await all(env.DB.prepare(
    'SELECT * FROM guest_boards WHERE room_id=? ORDER BY display_order,created_at,id'
  ).bind(roomId));
  if (!rows.length) {
    const created = nowIso();
    try {
      await env.DB.prepare(
        'INSERT INTO guest_boards(id,room_id,title,display_order,created_at,updated_at) VALUES(?,?,?,?,?,?)'
      ).bind(uid('gboard'), roomId, '파일 보드', 1, created, created).run();
    } catch (error) {
      if (!String(error && error.message || '').includes('UNIQUE constraint failed')) throw error;
    }
    rows = await all(env.DB.prepare(
      'SELECT * FROM guest_boards WHERE room_id=? ORDER BY display_order,created_at,id'
    ).bind(roomId));
  }
  const defaultBoard = rows[0];
  if (defaultBoard && !initializedGuestRooms.has(roomId)) {
    await env.DB.prepare("UPDATE guest_posts SET board_id=? WHERE room_id=? AND kind='board' AND (board_id='' OR board_id IS NULL)")
      .bind(defaultBoard.id, roomId).run();
    if (initializedGuestRooms.size >= 1000) initializedGuestRooms.clear();
    initializedGuestRooms.add(roomId);
  }
  return rows;
}

async function createGuestRoom(env, session, payload) {
  const title = String(payload.title || '').trim().slice(0, 60);
  if (!title) throw new AppError('참여방 이름을 입력해 주세요.', 'INVALID_TITLE');
  const hours = Math.max(2, Math.min(168, Number(payload.durationHours || 24)));
  let code = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = randomRoomCode();
    const exists = await env.DB.prepare('SELECT id FROM guest_rooms WHERE code=?').bind(candidate).first();
    if (!exists) { code = candidate; break; }
  }
  if (!code) throw new AppError('참여방 주소를 만들지 못했습니다. 다시 시도해 주세요.', 'CODE_FAILED', 500);
  const id = uid('room');
  const created = nowIso();
  const expires = new Date(Date.now() + hours * 3600000).toISOString();
  await env.DB.prepare(
    'INSERT INTO guest_rooms(id,teacher_id,title,code,status,expires_at,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
  ).bind(id, session.user_id, title, code, 'open', expires, 1, created, created).run();
  const row = await env.DB.prepare('SELECT * FROM guest_rooms WHERE id=?').bind(id).first();
  return guestRoomJson(row);
}

async function joinGuestRoom(env, payload) {
  const code = String(payload.code || '').trim().toUpperCase();
  const row = await env.DB.prepare('SELECT * FROM guest_rooms WHERE code=?').bind(code).first();
  if (!row) throw new AppError('참여방 주소가 올바르지 않습니다.', 'ROOM_NOT_FOUND', 404);
  const room = guestRoomJson(row);
  if (room.status !== 'open') {
    throw new AppError(room.status === 'expired' ? '이 참여방의 이용 시간이 끝났어요.' : '선생님이 참여방을 닫았어요.', 'ROOM_CLOSED', 410);
  }
  const participantId = uid('guest');
  const token = await issueSession(env, 'guest', participantId, row.id, row.expires_at);
  return { token, user: { id: participantId }, room };
}

async function getTeacherGuestRoom(env, session, payload) {
  const row = await ownedGuestRoom(env, session, payload.roomId);
  if (Number(payload.knownVersion) === Number(row.version || 1)) return { room: guestRoomJson(row), unchanged: true };
  return guestRoomData(env, row, `teacher:${session.user_id}`);
}

async function getGuestRoom(env, session, payload = {}) {
  const row = await env.DB.prepare('SELECT * FROM guest_rooms WHERE id=?').bind(session.class_id).first();
  if (!row) throw new AppError('참여방을 찾을 수 없습니다.', 'ROOM_NOT_FOUND', 404);
  if (Number(payload.knownVersion) === Number(row.version || 1)) return { room: guestRoomJson(row), unchanged: true };
  return guestRoomData(env, row, session.user_id);
}

async function createGuestBoard(env, session, payload) {
  const room = await ownedGuestRoom(env, session, payload.roomId);
  const title = String(payload.title || '').trim().slice(0, 50);
  if (!title) throw new AppError('보드 이름을 입력해 주세요.', 'INVALID_TITLE');
  const count = Number((await env.DB.prepare('SELECT COUNT(*) AS total FROM guest_boards WHERE room_id=?').bind(room.id).first()).total || 0);
  if (count >= 20) throw new AppError('한 참여방에는 파일 보드를 20개까지 만들 수 있습니다.', 'BOARD_LIMIT');
  const orderRow = await env.DB.prepare('SELECT COALESCE(MAX(display_order),0) AS last_order FROM guest_boards WHERE room_id=?').bind(room.id).first();
  const created = nowIso();
  const id = uid('gboard');
  try {
    await env.DB.prepare(
      'INSERT INTO guest_boards(id,room_id,title,display_order,created_at,updated_at) VALUES(?,?,?,?,?,?)'
    ).bind(id, room.id, title, Number(orderRow.last_order || 0) + 1, created, created).run();
  } catch (error) {
    if (String(error && error.message || '').includes('UNIQUE constraint failed')) {
      throw new AppError('같은 이름의 파일 보드가 이미 있습니다.', 'DUPLICATE_BOARD', 409);
    }
    throw error;
  }
  await touchGuestRoom(env, room.id);
  return guestBoardJson(await env.DB.prepare('SELECT * FROM guest_boards WHERE id=?').bind(id).first());
}

async function updateGuestBoard(env, session, payload) {
  const board = await env.DB.prepare('SELECT * FROM guest_boards WHERE id=?').bind(String(payload.boardId || '')).first();
  if (!board) throw new AppError('파일 보드를 찾을 수 없습니다.', 'NOT_FOUND', 404);
  await ownedGuestRoom(env, session, board.room_id);
  const title = String(payload.title || '').trim().slice(0, 50);
  if (!title) throw new AppError('보드 이름을 입력해 주세요.', 'INVALID_TITLE');
  try {
    await env.DB.prepare('UPDATE guest_boards SET title=?,updated_at=? WHERE id=?').bind(title, nowIso(), board.id).run();
  } catch (error) {
    if (String(error && error.message || '').includes('UNIQUE constraint failed')) {
      throw new AppError('같은 이름의 파일 보드가 이미 있습니다.', 'DUPLICATE_BOARD', 409);
    }
    throw error;
  }
  await touchGuestRoom(env, board.room_id);
  return guestBoardJson(await env.DB.prepare('SELECT * FROM guest_boards WHERE id=?').bind(board.id).first());
}

async function deleteGuestBoard(env, session, payload) {
  const board = await env.DB.prepare('SELECT * FROM guest_boards WHERE id=?').bind(String(payload.boardId || '')).first();
  if (!board) return { deleted: true };
  await ownedGuestRoom(env, session, board.room_id);
  const count = Number((await env.DB.prepare('SELECT COUNT(*) AS total FROM guest_boards WHERE room_id=?').bind(board.room_id).first()).total || 0);
  if (count <= 1) throw new AppError('파일 보드는 최소 1개가 필요합니다.', 'LAST_BOARD');
  const posts = await all(env.DB.prepare("SELECT id FROM guest_posts WHERE room_id=? AND kind='board' AND board_id=?").bind(board.room_id, board.id));
  await deleteOwnerFiles(env, 'guest_post', posts.map((item) => item.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM guest_posts WHERE room_id=? AND kind='board' AND board_id=?").bind(board.room_id, board.id),
    env.DB.prepare('DELETE FROM guest_boards WHERE id=?').bind(board.id)
  ]);
  await touchGuestRoom(env, board.room_id);
  return { deleted: true };
}

async function requireOpenGuestRoom(env, session) {
  const row = await env.DB.prepare('SELECT * FROM guest_rooms WHERE id=?').bind(session.class_id).first();
  if (!row) throw new AppError('참여방을 찾을 수 없습니다.', 'ROOM_NOT_FOUND', 404);
  const room = guestRoomJson(row);
  if (room.status !== 'open') {
    throw new AppError(room.status === 'expired' ? '이 참여방의 이용 시간이 끝났어요.' : '선생님이 참여방을 닫았어요.', 'ROOM_CLOSED', 410);
  }
  return row;
}

async function upsertGuestPost(env, session, payload) {
  let room;
  let participantId;
  if (session.role === 'teacher') {
    room = await ownedGuestRoom(env, session, payload.roomId);
    participantId = `teacher:${session.user_id}`;
    const visibleRoom = guestRoomJson(room);
    if (visibleRoom.status !== 'open') {
      throw new AppError(visibleRoom.status === 'expired' ? '이 참여방의 이용 시간이 끝났어요.' : '참여를 마감한 방에는 새 글을 올릴 수 없어요.', 'ROOM_CLOSED', 410);
    }
  } else if (session.role === 'guest') {
    room = await requireOpenGuestRoom(env, session);
    participantId = session.user_id;
  } else {
    throw new AppError('참여방 글 작성 권한이 없습니다.', 'FORBIDDEN', 403);
  }
  const kind = String(payload.kind || 'opinion');
  if (!['opinion', 'board', 'word'].includes(kind)) throw new AppError('글 종류가 올바르지 않습니다.', 'INVALID_TYPE');
  const maxLength = kind === 'word' ? 30 : (kind === 'opinion' ? 800 : 2000);
  const title = String(payload.title || '').trim().slice(0, 100);
  const text = String(payload.text || '').trim().slice(0, maxLength);
  const uploadedFiles = kind === 'board' ? (payload.files || []) : [];
  const keptFiles = kind === 'board' ? (payload.keepAttachmentIds || []) : [];
  if (!text && !uploadedFiles.length && !keptFiles.length) throw new AppError(kind === 'board' ? '글이나 파일을 올려 주세요.' : '내용을 입력해 주세요.', 'EMPTY_POST');
  if ((kind === 'board' || (kind === 'opinion' && session.role === 'teacher')) && !title) {
    throw new AppError(kind === 'board' ? '게시글 제목을 입력해 주세요.' : '공지 제목을 입력해 주세요.', 'INVALID_TITLE');
  }
  let row = null;
  const postId = String(payload.postId || '');
  if (postId) {
    row = await env.DB.prepare(
      'SELECT * FROM guest_posts WHERE id=? AND room_id=? AND participant_id=?'
    ).bind(postId, room.id, participantId).first();
    if (!row) throw new AppError('내 글만 수정할 수 있습니다.', 'FORBIDDEN', 403);
    if (row.kind !== kind) throw new AppError('글 종류가 올바르지 않습니다.', 'INVALID_TYPE');
  }
  let boardId = '';
  if (kind === 'board') {
    const defaultBoards = await ensureDefaultGuestBoard(env, room.id);
    boardId = String(payload.boardId || (row && row.board_id) || (defaultBoards[0] && defaultBoards[0].id) || '');
    const board = await env.DB.prepare('SELECT id FROM guest_boards WHERE id=? AND room_id=?').bind(boardId, room.id).first();
    if (!board) throw new AppError('파일 보드를 찾을 수 없습니다.', 'NOT_FOUND', 404);
  }
  if (row) {
    await env.DB.prepare('UPDATE guest_posts SET board_id=?,title=?,text=?,updated_at=? WHERE id=?')
      .bind(boardId, title, text, nowIso(), row.id).run();
  } else {
    const created = nowIso();
    row = { id: uid('gpost') };
    await env.DB.prepare(
      'INSERT INTO guest_posts(id,room_id,participant_id,kind,board_id,title,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).bind(row.id, room.id, participantId, kind, boardId, title, text, created, created).run();
  }
  const attachments = await replaceAttachments(
    env, 'guest_post', row.id, keptFiles, uploadedFiles, session
  );
  await touchGuestRoom(env, room.id);
  const saved = await env.DB.prepare('SELECT * FROM guest_posts WHERE id=?').bind(row.id).first();
  const result = guestPostJson(saved, participantId);
  result.attachments = attachments;
  return result;
}

async function deleteGuestPost(env, session, payload) {
  const postId = String(payload.postId || '');
  const row = await env.DB.prepare('SELECT * FROM guest_posts WHERE id=?').bind(postId).first();
  if (!row) return { deleted: true };
  if (session.role === 'teacher') {
    await ownedGuestRoom(env, session, row.room_id);
  } else if (session.role !== 'guest' || row.room_id !== session.class_id || row.participant_id !== session.user_id) {
    throw new AppError('내 글만 삭제할 수 있습니다.', 'FORBIDDEN', 403);
  }
  await deleteOwnerFiles(env, 'guest_post', [row.id]);
  await env.DB.prepare('DELETE FROM guest_posts WHERE id=?').bind(row.id).run();
  await touchGuestRoom(env, row.room_id);
  return { deleted: true };
}

async function closeGuestRoom(env, session, payload) {
  const row = await ownedGuestRoom(env, session, payload.roomId);
  const status = String(payload.status || '') === 'open' && row.expires_at > nowIso() ? 'open' : 'closed';
  await env.DB.prepare('UPDATE guest_rooms SET status=?,version=version+1,updated_at=? WHERE id=?')
    .bind(status, nowIso(), row.id).run();
  return guestRoomJson(await env.DB.prepare('SELECT * FROM guest_rooms WHERE id=?').bind(row.id).first());
}

async function reopenGuestRoom(env, session, payload) {
  const row = await ownedGuestRoom(env, session, payload.roomId);
  const hours = Math.max(2, Math.min(168, Number(payload.durationHours || 24)));
  const expires = new Date(Date.now() + hours * 3600000).toISOString();
  await env.DB.prepare('UPDATE guest_rooms SET status=?,expires_at=?,version=version+1,updated_at=? WHERE id=?')
    .bind('open', expires, nowIso(), row.id).run();
  return guestRoomJson(await env.DB.prepare('SELECT * FROM guest_rooms WHERE id=?').bind(row.id).first());
}

async function updateGuestRoom(env, session, payload) {
  const row = await ownedGuestRoom(env, session, payload.roomId);
  const title = String(payload.title || '').trim().slice(0, 60);
  if (!title) throw new AppError('참여방 이름을 입력해 주세요.', 'INVALID_TITLE');
  await env.DB.prepare('UPDATE guest_rooms SET title=?,version=version+1,updated_at=? WHERE id=?')
    .bind(title, nowIso(), row.id).run();
  return guestRoomJson(await env.DB.prepare('SELECT * FROM guest_rooms WHERE id=?').bind(row.id).first());
}

async function deleteGuestRoom(env, session, payload) {
  const row = await ownedGuestRoom(env, session, payload.roomId);
  const postRows = await all(env.DB.prepare('SELECT id FROM guest_posts WHERE room_id=?').bind(row.id));
  await deleteOwnerFiles(env, 'guest_post', postRows.map((item) => item.id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE role='guest' AND class_id=?").bind(row.id),
    env.DB.prepare('DELETE FROM guest_posts WHERE room_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM guest_boards WHERE room_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM guest_rooms WHERE id=?').bind(row.id)
  ]);
  return { deleted: true };
}

async function guestHeartbeat(env, session) {
  const row = await env.DB.prepare('SELECT * FROM guest_rooms WHERE id=?').bind(session.class_id).first();
  if (!row) throw new AppError('참여방을 찾을 수 없습니다.', 'ROOM_NOT_FOUND', 404);
  return { room: guestRoomJson(row) };
}

async function fileStorageStatus(env) {
  if (fileStorageStatusCache && Date.now() - fileStorageStatusCacheAt < 5 * 60 * 1000) {
    return fileStorageStatusCache;
  }
  if (fileStorageStatusPromise) return fileStorageStatusPromise;
  const generation = fileStorageStatusGeneration;
  let pending;
  pending = (async () => {
    const row = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS used_bytes,COUNT(*) AS file_count FROM files').first();
    const usedBytes = Number(row && row.used_bytes || 0);
    const percent = Math.min(999, Math.round((usedBytes / FREE_R2_STORAGE_BYTES) * 1000) / 10);
    let level = 'normal';
    if (percent >= 95) level = 'critical';
    else if (percent >= 85) level = 'warning';
    else if (percent >= 70) level = 'notice';
    const result = {
      usedBytes,
      fileCount: Number(row && row.file_count || 0),
      guideBytes: FREE_R2_STORAGE_BYTES,
      percent,
      level
    };
    if (generation === fileStorageStatusGeneration) {
      fileStorageStatusCache = result;
      fileStorageStatusCacheAt = Date.now();
    }
    return result;
  })().finally(() => { if (fileStorageStatusPromise === pending) fileStorageStatusPromise = null; });
  fileStorageStatusPromise = pending;
  return pending;
}

function invalidateFileStorageStatus() {
  fileStorageStatusGeneration += 1;
  fileStorageStatusCache = null;
  fileStorageStatusCacheAt = 0;
  fileStorageStatusPromise = null;
}

async function createClass(env, session, payload) {
  const name = String(payload.name || '').trim();
  const code = normalizeClassCode(payload.code);
  if (!name || !/^[A-Z0-9ㄱ-ㅎㅏ-ㅣ가-힣_-]{3,16}$/.test(code)) {
    throw new AppError('클래스 이름과 3~16자의 한글·영문·숫자 코드를 입력해 주세요.', 'INVALID_CLASS');
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

async function updateClass(env, session, payload) {
  const row = await ownedClass(env, session, payload.classId);
  const name = String(payload.name || '').trim().slice(0, 40);
  const subject = String(payload.subject || '').trim().slice(0, 30);
  const school = String(payload.school || '').trim().slice(0, 50);
  if (!name) throw new AppError('클래스 이름을 입력해 주세요.', 'INVALID_CLASS');
  await env.DB.prepare(
    'UPDATE classes SET name=?,subject=?,school=?,version=version+1,updated_at=? WHERE id=? AND teacher_id=?'
  ).bind(name, subject, school, nowIso(), row.id, session.user_id).run();
  await notifyClassSync(env, row.id, 'class-changed', Number(row.version || 0) + 1);
  return classJson(await env.DB.prepare('SELECT * FROM classes WHERE id=?').bind(row.id).first());
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
  if (normalizeClassCode(row.code) !== normalizeClassCode(payload.confirmCode)) {
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
    env.DB.prepare('DELETE FROM class_timers WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM idea_posts WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM board_posts WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM submissions WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM contents WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM students WHERE class_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM classes WHERE id=?').bind(row.id)
  ]);
  await notifyClassSync(env, row.id, 'class-deleted', Number(row.version || 0) + 1);
  return { deleted: true };
}

async function upsertContent(env, session, payload) {
  const type = String(payload.type || '');
  if (!['announcement', 'assignment', 'board', 'idea'].includes(type)) throw new AppError('잘못된 자료 유형입니다.', 'INVALID_TYPE');
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

async function getBulkContentTargets(env, session, payload) {
  const type = String(payload.type || '');
  if (!['announcement', 'assignment', 'board', 'idea'].includes(type)) throw new AppError('잘못된 자료 유형입니다.', 'INVALID_TYPE');
  const classIds = Array.from(new Set((Array.isArray(payload.classIds) ? payload.classIds : []).map((id) => String(id || '')).filter(Boolean)));
  if (classIds.length < 2 || classIds.length > 50) throw new AppError('2개 이상 50개 이하의 클래스를 선택해 주세요.', 'INVALID_CLASS_COUNT');
  const classes = await all(env.DB.prepare(
    `SELECT id,name FROM classes WHERE teacher_id=? AND id IN (${placeholders(classIds.length)}) ORDER BY display_order,name`
  ).bind(session.user_id, ...classIds));
  if (classes.length !== classIds.length) throw new AppError('선택한 클래스 중 관리 권한이 없는 항목이 있습니다.', 'FORBIDDEN', 403);
  const contents = await all(env.DB.prepare(
    `SELECT c.id,c.class_id,c.title,c.updated_at,group_concat(a.file_id) AS attachment_ids
     FROM contents c LEFT JOIN attachments a ON a.owner_type='content' AND a.owner_id=c.id
     WHERE c.class_id IN (${placeholders(classIds.length)}) AND c.type=?
     GROUP BY c.id ORDER BY c.updated_at DESC,c.title COLLATE NOCASE LIMIT 2500`
  ).bind(...classIds, type));
  const byClass = new Map(classes.map((item) => [item.id, { id: item.id, name: item.name, contents: [] }]));
  for (const item of contents) {
    const target = byClass.get(item.class_id);
    if (target) target.contents.push({ id: item.id, title: item.title, updatedAt: item.updated_at,
      attachmentIds: item.attachment_ids ? item.attachment_ids.split(',') : [] });
  }
  return { classes: classes.map((item) => byClass.get(item.id)) };
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
  if (type === 'idea') {
    await env.DB.prepare('DELETE FROM idea_posts WHERE idea_id=?').bind(row.id).run();
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
  await notifyClassSync(env, classRow.id, 'class-changed', Number(classRow.version || 0) + 1);
  return { students: created.map((row) => studentJson(row, true)) };
}

async function reissueClassPins(env, session, payload) {
  await ensureStudentCredentialSchema(env);
  const classRow = await ownedClass(env, session, payload.classId);
  const rows = await all(env.DB.prepare('SELECT * FROM students WHERE class_id=? ORDER BY number').bind(classRow.id));
  if (!rows.length) throw new AppError('먼저 학생을 등록해 주세요.', 'NO_STUDENTS');
  const output = [];
  const statements = [];
  for (const row of rows) {
    const pin = randomDigits();
    const salt = randomToken().slice(0, 20);
    statements.push(env.DB.prepare("UPDATE students SET pin_hash=?,pin_salt=?,password_hash='',password_salt='' WHERE id=?")
      .bind(await pinHash(pin, salt, env), salt, row.id));
    output.push(studentJson({ ...row, pin }, true));
  }
  statements.push(env.DB.prepare("DELETE FROM sessions WHERE role='student' AND class_id=?").bind(classRow.id));
  statements.push(env.DB.prepare('UPDATE classes SET version=version+1,updated_at=? WHERE id=?').bind(nowIso(), classRow.id));
  await env.DB.batch(statements);
  await notifyClassSync(env, classRow.id, 'class-changed', Number(classRow.version || 0) + 1);
  return { students: output };
}

async function resetStudentPin(env, session, payload) {
  await ensureStudentCredentialSchema(env);
  const row = await env.DB.prepare(
    'SELECT s.*,c.teacher_id,c.version FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?'
  ).bind(String(payload.studentId || '')).first();
  if (!row || row.teacher_id !== session.user_id) throw new AppError('학생을 찾을 수 없습니다.', 'NOT_FOUND', 404);
  const pin = randomDigits();
  const salt = randomToken().slice(0, 20);
  await env.DB.batch([
    env.DB.prepare("UPDATE students SET pin_hash=?,pin_salt=?,password_hash='',password_salt='' WHERE id=?").bind(await pinHash(pin, salt, env), salt, row.id),
    env.DB.prepare("DELETE FROM sessions WHERE role='student' AND user_id=?").bind(row.id),
    env.DB.prepare('UPDATE classes SET version=version+1,updated_at=? WHERE id=?').bind(nowIso(), row.class_id)
  ]);
  await notifyClassSync(env, row.class_id, 'class-changed', Number(row.version || 0) + 1);
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
    env.DB.prepare('DELETE FROM idea_posts WHERE student_id=?').bind(row.id),
    env.DB.prepare('DELETE FROM students WHERE id=?').bind(row.id),
    env.DB.prepare('UPDATE classes SET student_count=(SELECT COUNT(*) FROM students WHERE class_id=?),version=version+1,updated_at=? WHERE id=?')
      .bind(row.class_id, nowIso(), row.class_id)
  ]);
  await notifyClassSync(env, row.class_id);
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
  const title = String(payload.title || '').trim().slice(0, 80);
  const text = String(payload.text || '').trim();
  const hasFiles = (payload.files || []).length || (payload.keepAttachmentIds || []).length;
  if (!text && !hasFiles) throw new AppError('내용이나 파일을 하나 이상 게시해 주세요.', 'EMPTY_POST');
  const time = nowIso();
  let row = await env.DB.prepare('SELECT * FROM board_posts WHERE board_id=? AND student_id=?')
    .bind(board.id, student.id).first();
  if (row) {
    const nextTitle = Object.prototype.hasOwnProperty.call(payload, 'title') ? title : (row.title || '');
    await env.DB.prepare(
      "UPDATE board_posts SET title=?,text=?,student_name=?,student_number=?,status='published',revision_message='',updated_at=? WHERE id=?"
    ).bind(nextTitle, text, student.name, student.number, time, row.id).run();
  } else {
    const id = uid('post');
    await env.DB.prepare(
      'INSERT INTO board_posts(id,board_id,class_id,student_id,student_number,student_name,title,text,status,revision_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,\'published\',\'\',?,?)'
    ).bind(id, board.id, student.class_id, student.id, student.number, student.name, title, text, time, time).run();
    row = await env.DB.prepare('SELECT * FROM board_posts WHERE id=?').bind(id).first();
  }
  const attachments = await replaceAttachments(env, 'board_post', row.id, payload.keepAttachmentIds, payload.files, session);
  if (!text && !attachments.length) throw new AppError('내용이나 파일을 하나 이상 게시해 주세요.', 'EMPTY_POST');
  await touchClass(env, student.class_id);
  const result = postJson(await env.DB.prepare('SELECT * FROM board_posts WHERE id=?').bind(row.id).first());
  result.attachments = attachments;
  return result;
}

async function setBoardReaction(env, session, payload) {
  const emoji = String(payload.emoji || '');
  const allowed = new Set(['❤️', '👏', '😊', '💡', '👍']);
  if (!allowed.has(emoji)) throw new AppError('응원 이모지만 사용할 수 있어요.', 'INVALID_REACTION');
  const postId = String(payload.postId || '');
  const post = await env.DB.prepare('SELECT id,class_id,status FROM board_posts WHERE id=? AND class_id=?')
    .bind(postId, session.class_id).first();
  if (!post) throw new AppError('게시글을 찾을 수 없습니다.', 'NOT_FOUND', 404);
  if (post.status !== 'published' && post.status !== 'confirmed') {
    throw new AppError('공개된 게시글에만 응원할 수 있어요.', 'POST_NOT_PUBLIC');
  }
  const existing = await env.DB.prepare('SELECT emoji FROM board_post_reactions WHERE post_id=? AND student_id=?')
    .bind(post.id, session.user_id).first();
  if (existing && existing.emoji === emoji) {
    await env.DB.prepare('DELETE FROM board_post_reactions WHERE post_id=? AND student_id=?').bind(post.id, session.user_id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO board_post_reactions(post_id,student_id,emoji,updated_at) VALUES(?,?,?,?) ON CONFLICT(post_id,student_id) DO UPDATE SET emoji=excluded.emoji,updated_at=excluded.updated_at'
    ).bind(post.id, session.user_id, emoji, nowIso()).run();
  }
  const rows = await all(env.DB.prepare(
    'SELECT emoji,COUNT(*) AS total FROM board_post_reactions WHERE post_id=? GROUP BY emoji'
  ).bind(post.id));
  const reactions = {};
  for (const row of rows) reactions[row.emoji] = Number(row.total || 0);
  const mine = await env.DB.prepare('SELECT emoji FROM board_post_reactions WHERE post_id=? AND student_id=?')
    .bind(post.id, session.user_id).first();
  await touchClass(env, post.class_id);
  return { postId: post.id, reactions, myReaction: mine ? mine.emoji : '' };
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

async function upsertIdeaPost(env, session, payload) {
  const idea = await env.DB.prepare(
    "SELECT * FROM contents WHERE id=? AND class_id=? AND type='idea'"
  ).bind(String(payload.ideaId || ''), session.class_id).first();
  if (!idea) throw new AppError('아이디어 구름을 찾을 수 없습니다.', 'NOT_FOUND', 404);
  if (idea.status === 'closed') throw new AppError('지금은 의견 작성을 마감했어요.', 'IDEA_CLOSED');
  const student = await env.DB.prepare('SELECT * FROM students WHERE id=? AND class_id=?')
    .bind(session.user_id, session.class_id).first();
  if (!student) throw new AppError('학생 정보를 찾을 수 없습니다.', 'UNAUTHORIZED', 401);
  const text = String(payload.text || '').trim();
  const groupName = String(payload.groupName || '').trim();
  if (!text) throw new AppError('의견을 입력해 주세요.', 'EMPTY_IDEA_POST');
  if (text.length > 100) throw new AppError('의견은 100자 이내로 작성해 주세요.', 'IDEA_POST_TOO_LONG');
  if (groupName && !/^(?:[1-9]|1[0-2])모둠$/.test(groupName)) {
    throw new AppError('모둠을 다시 선택해 주세요.', 'INVALID_GROUP');
  }
  const time = nowIso();
  const postId = String(payload.postId || '');
  let row;
  if (postId) {
    row = await env.DB.prepare('SELECT * FROM idea_posts WHERE id=? AND idea_id=? AND student_id=?')
      .bind(postId, idea.id, student.id).first();
    if (!row) throw new AppError('수정할 의견을 찾을 수 없습니다.', 'NOT_FOUND', 404);
    await env.DB.prepare(
      'UPDATE idea_posts SET text=?,group_name=?,student_name=?,student_number=?,updated_at=? WHERE id=?'
    ).bind(text, groupName, student.name, student.number, time, row.id).run();
  } else {
    const id = uid('idea_post');
    await env.DB.prepare(
      'INSERT INTO idea_posts(id,idea_id,class_id,student_id,student_number,student_name,group_name,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, idea.id, student.class_id, student.id, student.number, student.name, groupName, text, time, time).run();
    row = await env.DB.prepare('SELECT * FROM idea_posts WHERE id=?').bind(id).first();
  }
  await touchClass(env, student.class_id);
  row = await env.DB.prepare('SELECT * FROM idea_posts WHERE id=?').bind(row.id).first();
  return ideaPostJson(row, false, student.id);
}

async function deleteIdeaPost(env, session, payload) {
  const row = await env.DB.prepare('SELECT * FROM idea_posts WHERE id=?')
    .bind(String(payload.postId || '')).first();
  if (!row) return { deleted: true };
  if (session.role === 'student') {
    if (row.student_id !== session.user_id) throw new AppError('내 의견만 삭제할 수 있습니다.', 'FORBIDDEN', 403);
  } else {
    await ownedClass(env, session, row.class_id);
  }
  await env.DB.prepare('DELETE FROM idea_posts WHERE id=?').bind(row.id).run();
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

async function startClassTimer(env, session, payload) {
  const classRow = await ownedClass(env, session, payload.classId);
  const title = String(payload.title || '활동 시간').trim().slice(0, 50) || '활동 시간';
  const durationSeconds = Math.min(7200, Math.max(10, Number(payload.durationSeconds || 0)));
  const sound = ['bell', 'chime', 'woodblock', 'ascending'].includes(String(payload.sound || 'bell'))
    ? String(payload.sound || 'bell') : 'bell';
  if (!Number.isFinite(durationSeconds)) throw new AppError('활동 시간을 확인해 주세요.', 'INVALID_TIMER');
  const startedAt = nowIso();
  const endsAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO class_timers(class_id,title,sound,started_at,ends_at,updated_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(class_id) DO UPDATE SET title=excluded.title,sound=excluded.sound,started_at=excluded.started_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at`
  ).bind(classRow.id, title, sound, startedAt, endsAt, startedAt).run();
  await touchClass(env, classRow.id);
  return timerJson(await env.DB.prepare('SELECT * FROM class_timers WHERE class_id=?').bind(classRow.id).first());
}

async function clearClassTimer(env, session, payload) {
  const classRow = await ownedClass(env, session, payload.classId);
  await env.DB.prepare('DELETE FROM class_timers WHERE class_id=?').bind(classRow.id).run();
  await touchClass(env, classRow.id);
  return { cleared: true };
}

async function heartbeat(env, session, payload) {
  const classId = session.role === 'student' ? session.class_id : String(payload.classId || '');
  // The ownership query already includes the version for teachers.
  const classRow = session.role === 'student'
    ? await env.DB.prepare('SELECT version FROM classes WHERE id=?').bind(classId).first()
    : await ownedClass(env, session, classId);
  const version = Number(classRow && classRow.version || 1);
  const changed = Number(payload.knownVersion) !== version;
  const result = { version, unchanged: !changed };
  if (changed) {
    result.classData = await classData(env, classId, session.role === 'student' ? session.user_id : '', version);
    result.version = result.classData.classInfo.version;
    result.timer = result.classData.timer;
    if (session.role === 'student') {
      result.boardReviews = result.classData.boardPosts.filter((post) => post.studentId === session.user_id)
        .map((post) => ({ postId: post.id, status: post.status || 'published', updatedAt: post.updatedAt || '' }));
    }
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
  if (link.owner_type === 'teacher_resource') {
    if (session.role !== 'teacher') throw new AppError('파일 접근 권한이 없습니다.', 'FORBIDDEN', 403);
    await ensureTeacherResourceSchema(env);
    await ownedTeacherResource(env, session, link.owner_id);
    return { row, downloadAllowed: true };
  }
  if (link.owner_type === 'guest_post') {
    const owner = await env.DB.prepare(
      'SELECT p.room_id,p.participant_id,r.teacher_id FROM guest_posts p JOIN guest_rooms r ON r.id=p.room_id WHERE p.id=?'
    ).bind(link.owner_id).first();
    if (!owner) throw new AppError('파일 연결 정보를 찾을 수 없습니다.', 'FILE_NOT_FOUND', 404);
    if (session.role === 'teacher') {
      if (owner.teacher_id !== session.user_id) throw new AppError('파일 접근 권한이 없습니다.', 'FORBIDDEN', 403);
      return { row, downloadAllowed: true };
    }
    if (session.role !== 'guest' || session.class_id !== owner.room_id) {
      throw new AppError('파일 접근 권한이 없습니다.', 'FORBIDDEN', 403);
    }
    return { row, downloadAllowed: owner.participant_id === session.user_id };
  }
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

function driveArchiveName(title, studentNumber, originalValue) {
  const original = String(originalValue || '첨부파일')
    .replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '첨부파일';
  const dot = original.lastIndexOf('.');
  const extension = dot > 0 && original.length - dot <= 12 ? original.slice(dot) : '';
  const originalBase = extension ? original.slice(0, dot) : original;
  const titlePart = safeFilePart(title || '자료');
  const numberPart = Number(studentNumber || 0) > 0 ? `_${Number(studentNumber)}번` : '';
  const fixedPrefix = `${titlePart}${numberPart}_`;
  const available = Math.max(20, 180 - fixedPrefix.length - extension.length);
  return `${fixedPrefix}${originalBase.slice(0, available)}${extension}`;
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

async function ensureDriveArchiveSchema(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS drive_archives (' +
      'id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL,class_id TEXT NOT NULL,' +
      'owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,original_file_id TEXT NOT NULL,' +
      'original_name TEXT NOT NULL,archive_name TEXT NOT NULL,mime_type TEXT NOT NULL,' +
      'size INTEGER NOT NULL,drive_file_id TEXT NOT NULL,drive_url TEXT NOT NULL,archived_at TEXT NOT NULL)'
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS drive_archives_class ON drive_archives(class_id, archived_at)').run();
}

async function driveArchiveContext(env, session, fileId) {
  const row = await env.DB.prepare(
    'SELECT f.*,a.owner_type,a.owner_id FROM files f JOIN attachments a ON a.file_id=f.id WHERE f.id=?'
  ).bind(String(fileId || '')).first();
  if (!row) throw new AppError('이미 보관했거나 찾을 수 없는 파일입니다.', 'FILE_NOT_FOUND', 404);

  let classId = '';
  let title = '자료';
  let studentNumber = 0;
  if (row.owner_type === 'content') {
    const owner = await env.DB.prepare('SELECT class_id,title FROM contents WHERE id=?').bind(row.owner_id).first();
    if (owner) {
      classId = owner.class_id;
      title = owner.title || title;
    }
  } else if (row.owner_type === 'submission') {
    const owner = await env.DB.prepare(
      'SELECT s.class_id,s.student_number,c.title FROM submissions s JOIN contents c ON c.id=s.assignment_id WHERE s.id=?'
    ).bind(row.owner_id).first();
    if (owner) {
      classId = owner.class_id;
      title = owner.title || '과제';
      studentNumber = Number(owner.student_number || 0);
    }
  } else if (row.owner_type === 'board_post') {
    const owner = await env.DB.prepare(
      'SELECT p.class_id,p.student_number,c.title FROM board_posts p JOIN contents c ON c.id=p.board_id WHERE p.id=?'
    ).bind(row.owner_id).first();
    if (owner) {
      classId = owner.class_id;
      title = owner.title || '보드';
      studentNumber = Number(owner.student_number || 0);
    }
  }
  if (!classId) throw new AppError('파일 연결 정보를 찾을 수 없습니다.', 'FILE_NOT_FOUND', 404);
  await ownedClass(env, session, classId);

  return {
    row,
    classId,
    archiveName: driveArchiveName(title, studentNumber, row.name)
  };
}

async function sendFileToDrive(env, request, session, fileId) {
  const context = await driveArchiveContext(env, session, fileId);
  const sourceUrl = await signedFileUrl(env, request, context.row, 'download');
  let response;
  try {
    response = await fetch(String(env.DRIVE_ARCHIVE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        archiveKey: String(env.DRIVE_ARCHIVE_KEY),
        sourceUrl,
        fileName: context.archiveName,
        mimeType: context.row.mime_type || 'application/octet-stream',
        sourceFileId: context.row.id
      }),
      redirect: 'follow'
    });
  } catch (_) {
    throw new AppError('Google Drive 보관 서버에 연결하지 못했습니다.', 'DRIVE_UNAVAILABLE', 502);
  }
  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch (_) {
    throw new AppError('Google Drive 보관 서버 설정을 확인해 주세요.', 'DRIVE_INVALID_RESPONSE', 502);
  }
  if (!response.ok || !result.ok || !result.data || !result.data.driveFileId) {
    throw new AppError(result.message || 'Google Drive로 파일을 옮기지 못했습니다.', result.code || 'DRIVE_ARCHIVE_FAILED', 502);
  }

  const archivedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO drive_archives(id,teacher_id,class_id,owner_type,owner_id,original_file_id,original_name,archive_name,mime_type,size,drive_file_id,drive_url,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      uid('arc'), session.user_id, context.classId, context.row.owner_type, context.row.owner_id,
      context.row.id, context.row.name, context.archiveName, context.row.mime_type || 'application/octet-stream',
      Number(context.row.size || 0), result.data.driveFileId, result.data.driveUrl || '', archivedAt
    ),
    env.DB.prepare('DELETE FROM attachments WHERE file_id=?').bind(context.row.id),
    env.DB.prepare('DELETE FROM files WHERE id=?').bind(context.row.id)
  ]);
  invalidateFileStorageStatus();
  try {
    await env.FILES.delete(context.row.r2_key);
  } catch (error) {
    console.error('R2 archive cleanup failed', context.row.r2_key, error);
  }
  return {
    fileId: context.row.id,
    archiveName: context.archiveName,
    driveFileId: result.data.driveFileId,
    driveUrl: result.data.driveUrl || '',
    classId: context.classId
  };
}

async function archiveFilesToDrive(env, request, session, payload) {
  if (!env.DRIVE_ARCHIVE_URL || !env.DRIVE_ARCHIVE_KEY) {
    throw new AppError('Google Drive 보관 연결이 아직 설정되지 않았습니다.', 'DRIVE_NOT_CONFIGURED', 503);
  }
  const fileIds = Array.from(new Set((payload.fileIds || []).map((value) => String(value || '')).filter(Boolean)));
  if (!fileIds.length) throw new AppError('보관할 파일을 선택해 주세요.', 'NO_FILES');
  if (fileIds.length > 25) throw new AppError('한 번에 25개까지 보관할 수 있습니다.', 'TOO_MANY_FILES');
  await ensureDriveArchiveSchema(env);

  const archived = [];
  const failed = [];
  const touchedClasses = new Set();
  for (const fileId of fileIds) {
    try {
      const item = await sendFileToDrive(env, request, session, fileId);
      archived.push(item);
      touchedClasses.add(item.classId);
    } catch (error) {
      failed.push({
        fileId,
        message: error instanceof AppError ? error.message : '보관 중 오류가 발생했습니다.'
      });
    }
  }
  for (const classId of touchedClasses) await touchClass(env, classId);
  if (!archived.length && failed.length) {
    throw new AppError(failed[0].message, 'DRIVE_ARCHIVE_FAILED', 502, { failed });
  }
  return {
    archived,
    failed,
    archivedCount: archived.length,
    failedCount: failed.length
  };
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
  if (/^(workspace|calendar)/.test(action)) return workspaceAction(request, env, await sessionFromToken(env, body.token, 'teacher'), action, payload);
  if (action === 'joinGuestRoom') return joinGuestRoom(env, payload);
  const teacherActions = new Set([
    'getTeacherResources', 'upsertTeacherResource', 'deleteTeacherResource',
    'teacherDashboard', 'createClass', 'updateClass', 'reorderClasses', 'deleteClass', 'getTeacherClass',
    'upsertContent', 'getBulkContentTargets', 'deleteContent', 'addStudents', 'reissueClassPins', 'resetStudentPin',
    'deleteStudent', 'reviewBoardPost', 'startClassTimer', 'clearClassTimer',
    'createDownloadBundle', 'archiveFilesToDrive', 'getStorageStatus',
    'createGuestRoom', 'getTeacherGuestRoom', 'updateGuestRoom', 'closeGuestRoom', 'reopenGuestRoom', 'deleteGuestRoom',
    'createGuestBoard', 'updateGuestBoard', 'deleteGuestBoard'
  ]);
  const studentActions = new Set(['getStudentClass', 'upsertSubmission', 'deleteSubmission', 'upsertBoardPost', 'setBoardReaction', 'upsertIdeaPost']);
  const guestActions = new Set(['getGuestRoom', 'guestHeartbeat']);
  let role = '';
  if (teacherActions.has(action)) role = 'teacher';
  else if (studentActions.has(action)) role = 'student';
  else if (guestActions.has(action)) role = 'guest';
  const session = await sessionFromToken(env, body.token, role);

  switch (action) {
    case 'getTeacherResources': return getTeacherResources(env, session, payload);
    case 'upsertTeacherResource': return upsertTeacherResource(env, session, payload);
    case 'deleteTeacherResource': return deleteTeacherResource(env, session, payload);
    case 'teacherDashboard': return teacherDashboard(env, session);
    case 'getStorageStatus': return fileStorageStatus(env);
    case 'createClass': return createClass(env, session, payload);
    case 'updateClass': return updateClass(env, session, payload);
    case 'reorderClasses': return reorderClasses(env, session, payload);
    case 'deleteClass': return deleteClass(env, session, payload);
    case 'getTeacherClass':
      {
        const classRow = await ownedClass(env, session, payload.classId);
        // ownedClass already read the authoritative version with the ownership check.
        return classData(env, classRow.id, '', Number(classRow.version || 1));
      }
    case 'getStudentClass': return classData(env, session.class_id, session.user_id);
    case 'upsertContent': return upsertContent(env, session, payload);
    case 'getBulkContentTargets': return getBulkContentTargets(env, session, payload);
    case 'deleteContent': return deleteContent(env, session, payload);
    case 'addStudents': return addStudents(env, session, payload);
    case 'reissueClassPins': return reissueClassPins(env, session, payload);
    case 'resetStudentPin': return resetStudentPin(env, session, payload);
    case 'deleteStudent': return deleteStudent(env, session, payload);
    case 'upsertSubmission': return upsertSubmission(env, session, payload);
    case 'deleteSubmission': return deleteSubmission(env, session, payload);
    case 'upsertBoardPost': return upsertBoardPost(env, session, payload);
    case 'setBoardReaction': return setBoardReaction(env, session, payload);
    case 'deleteBoardPost': return deleteBoardPost(env, session, payload);
    case 'upsertIdeaPost': return upsertIdeaPost(env, session, payload);
    case 'deleteIdeaPost': return deleteIdeaPost(env, session, payload);
    case 'reviewBoardPost': return reviewBoardPost(env, session, payload);
    case 'startClassTimer': return startClassTimer(env, session, payload);
    case 'clearClassTimer': return clearClassTimer(env, session, payload);
    case 'heartbeat': return heartbeat(env, session, payload);
    case 'prepareFileAccess': return prepareFileAccess(env, request, session, payload);
    case 'getFileContent': return prepareFileAccess(env, request, session, { fileId: payload.fileId, intent: 'preview' });
    case 'createDownloadBundle': return createDownloadBundle(env, request, session, payload);
    case 'archiveFilesToDrive': return archiveFilesToDrive(env, request, session, payload);
    case 'createGuestRoom': return createGuestRoom(env, session, payload);
    case 'getTeacherGuestRoom': return getTeacherGuestRoom(env, session, payload);
    case 'updateGuestRoom': return updateGuestRoom(env, session, payload);
    case 'createGuestBoard': return createGuestBoard(env, session, payload);
    case 'updateGuestBoard': return updateGuestBoard(env, session, payload);
    case 'deleteGuestBoard': return deleteGuestBoard(env, session, payload);
    case 'getGuestRoom': return getGuestRoom(env, session, payload);
    case 'upsertGuestPost': return upsertGuestPost(env, session, payload);
    case 'deleteGuestPost': return deleteGuestPost(env, session, payload);
    case 'closeGuestRoom': return closeGuestRoom(env, session, payload);
    case 'reopenGuestRoom': return reopenGuestRoom(env, session, payload);
    case 'deleteGuestRoom': return deleteGuestRoom(env, session, payload);
    case 'guestHeartbeat': return guestHeartbeat(env, session);
    default: throw new AppError(`지원하지 않는 요청입니다: ${action}`, 'UNKNOWN_ACTION', 404);
  }
}

async function handleUpload(request, env) {
  if (!(await schemaReady(env))) throw new AppError('먼저 교사 계정을 만들어 주세요.', 'SETUP_REQUIRED', 404);
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const session = await sessionFromToken(env, token);
  if (session.role === 'guest') await requireOpenGuestRoom(env, session);
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
    invalidateFileStorageStatus();
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

function studentLoginQr(request) {
  const requestUrl = new URL(request.url);
  const classCode = String(requestUrl.searchParams.get('code') || '').trim().normalize('NFC').toUpperCase();
  const studentUrl = `${requestUrl.origin}/?${classCode ? `classCode=${encodeURIComponent(classCode)}&` : ''}#/student/login`;
  const code = qrcode(0, 'M');
  code.addData(studentUrl, 'Byte');
  code.make();
  const svg = code.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function guestRoomQr(request) {
  const requestUrl = new URL(request.url);
  const codeValue = String(requestUrl.searchParams.get('code') || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{12}$/.test(codeValue)) throw new AppError('참여방 QR 코드가 올바르지 않습니다.', 'INVALID_ROOM_CODE');
  const guestUrl = `${requestUrl.origin}/#/guest/${encodeURIComponent(codeValue)}/opinion`;
  const code = qrcode(0, 'M');
  code.addData(guestUrl, 'Byte');
  code.make();
  const svg = code.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api')) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    try {
      if (url.pathname === '/student-login-qr.svg' && request.method === 'GET') {
        return studentLoginQr(request);
      }
      if (url.pathname === '/guest-room-qr.svg' && request.method === 'GET') {
        return guestRoomQr(request);
      }
      if (url.pathname === '/api/calendar/callback' && request.method === 'GET') return await calendarCallback(request, env);
      if (url.pathname === '/api/health') {
        const databaseReady = await schemaReady(env);
        if (databaseReady) await ensureWorkspace(env);
        return ok({
          status: 'ok',
          databaseReady,
          featureSchemaReady: databaseReady && featureSchemaVerified,
          databaseIssue: databaseReady && featureSchemaError ? featureSchemaError : '',
          provider: 'cloudflare',
          release: RELEASE,
          workspaceSchemaReady: databaseReady,
          calendarConfigured: calendarConfigured(env)
        }, request);
      }
      if (url.pathname === '/api/sync' && request.method === 'GET') return await classSyncSocket(request, env);
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        return ok(await handleUpload(request, env), request);
      }
      if (url.pathname.startsWith('/api/file/') && request.method === 'GET') {
        const fileId = decodeURIComponent(url.pathname.slice('/api/file/'.length));
        return await handleSignedFile(request, env, fileId);
      }
      if (url.pathname === '/api' && request.method === 'POST') {
        const data = await handleAction(request, env);
        const response = ok(data, request);
        if (data && data.state && data.url && data.url.startsWith('https://accounts.google.com/')) response.headers.set('Set-Cookie', 'learn_oauth='+data.state+'; Path=/api/calendar; HttpOnly; Secure; SameSite=Lax; Max-Age=600');
        response.headers.set('Cache-Control', 'no-store');
        return response;
      }
      if (url.pathname.startsWith('/api')) throw new AppError('API 주소를 찾을 수 없습니다.', 'NOT_FOUND', 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error, request);
    }
  }
};

export class ClassSyncHub {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/notify' && request.method === 'POST') {
      let event = {};
      try { event = await request.json(); } catch (_) {}
      const message = JSON.stringify({
        type: event.type === 'class-deleted' ? 'class-deleted' : 'class-changed',
        classId: String(event.classId || ''),
        version: event.version == null ? null : Number(event.version),
        eventId: String(event.eventId || crypto.randomUUID())
      });
      let sent = 0;
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(message); sent += 1; }
        catch (_) { try { socket.close(1011, 'sync notification failed'); } catch (_) {} }
      }
      return Response.json({ sent });
    }
    if (!['/api/sync', '/connect'].includes(url.pathname) || request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Not found', { status: 404 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { 'Sec-WebSocket-Protocol': 'learn-sync' }
    });
  }
}




// Teacher workspace: bounded per-owner JSON documents; Google events never enter D1.
const workspaceSchema = `CREATE TABLE IF NOT EXISTS teacher_workspace (teacher_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(teacher_id,kind));
CREATE TABLE IF NOT EXISTS calendar_connections (teacher_id TEXT PRIMARY KEY, encrypted TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calendar_oauth_states (state TEXT PRIMARY KEY, teacher_id TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS calendar_oauth_expires ON calendar_oauth_states(expires);
CREATE INDEX IF NOT EXISTS contents_class_type_due ON contents(class_id,type,due_at);`;
let workspaceReady;
async function ensureWorkspace(env) {
  if (!workspaceReady) workspaceReady = env.DB.batch(workspaceSchema.split(';').filter(x=>x.trim()).map(sql=>env.DB.prepare(sql))).catch(e=>{workspaceReady=null;throw e;});
  await workspaceReady;
}
function calendarConfigured(env) { return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.CALENDAR_TOKEN_KEY); }
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unb64(s) { return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0)); }
async function tokenCipher(env, value, decrypt=false, owner='') {
  const raw = unb64(env.CALENDAR_TOKEN_KEY || '');
  if(raw.length!==32) throw new AppError('캘린더 암호화 키 설정이 필요합니다.','CALENDAR_SETUP',503);
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
  if(decrypt) { const [iv,data]=value.split('.'); return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:new TextEncoder().encode(owner)},key,unb64(data)))); }
  const iv=crypto.getRandomValues(new Uint8Array(12));
  return b64url(iv)+'.'+b64url(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(owner)},key,new TextEncoder().encode(JSON.stringify(value))));
}
async function saveGoogleToken(env,owner,value) {
  await env.DB.prepare('INSERT INTO calendar_connections(teacher_id,encrypted) VALUES(?,?) ON CONFLICT(teacher_id) DO UPDATE SET encrypted=excluded.encrypted').bind(owner,await tokenCipher(env,value,false,owner)).run();
}
async function googleToken(env,owner) {
  const row=await env.DB.prepare('SELECT encrypted FROM calendar_connections WHERE teacher_id=?').bind(owner).first();
  if(!row) throw new AppError('Google 계정을 연결해 주세요.','CALENDAR_DISCONNECTED',409);
  const t=await tokenCipher(env,row.encrypted,true,owner);
  if(t.expires>Date.now()+60000) return t.access_token;
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:t.refresh_token,grant_type:'refresh_token'})});
  if(!r.ok) throw new AppError('Google 연결을 다시 인증해 주세요.','CALENDAR_RECONNECT',401);
  const n=await r.json(); await saveGoogleToken(env,owner,{...t,...n,expires:Date.now()+n.expires_in*1000}); return n.access_token;
}
async function googleRequest(env,owner,path,options={}) {
  const token=await googleToken(env,owner);
  const r=await fetch('https://www.googleapis.com/calendar/v3/'+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers}});
  if(r.status===412) throw new AppError('다른 곳에서 일정이 변경되었습니다. 최신 일정을 확인한 뒤 다시 저장해 주세요. 작성 내용은 유지됩니다.','CALENDAR_CONFLICT',409);
  if(r.status===410) throw new AppError('동기화 토큰이 만료되었습니다.','SYNC_RESET',410);
  if(!r.ok) throw new AppError(r.status===403?'이 캘린더를 수정할 권한이 없거나 API 한도에 도달했습니다.':'Google 요청에 실패했습니다. 작성 내용은 유지됩니다.','GOOGLE_'+r.status,r.status===429?429:502);
  return r.status===204?{}:r.json();
}
async function calendarCallback(request,env) {
  await ensureWorkspace(env);
  const u=new URL(request.url), state=u.searchParams.get('state');
  const row=await env.DB.prepare('DELETE FROM calendar_oauth_states WHERE state=? RETURNING teacher_id,verifier,expires').bind(state||'').first();
  const cookie=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('learn_oauth='));
  if(!row || row.expires<Date.now() || cookie!=='learn_oauth='+state) throw new AppError('연결 요청이 만료되었거나 브라우저가 다릅니다. 다시 연결해 주세요.','OAUTH_STATE',400);
  if(u.searchParams.has('error')) return Response.redirect(new URL('/#/teacher/settings',u).href,303);
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:env.GOOGLE_REDIRECT_URI,code:u.searchParams.get('code')||'',code_verifier:row.verifier,grant_type:'authorization_code'})});
  if(!r.ok) throw new AppError('Google 연결을 완료하지 못했습니다. 다시 시도해 주세요.','OAUTH_EXCHANGE',400);
  const t=await r.json(); if(!t.refresh_token) throw new AppError('오프라인 접근 동의가 필요합니다. 다시 연결해 주세요.','OAUTH_REFRESH',400);
  await saveGoogleToken(env,row.teacher_id,{...t,expires:Date.now()+t.expires_in*1000});
  return new Response(null,{status:303,headers:{Location:new URL('/#/teacher/calendar',u).href,'Set-Cookie':'learn_oauth=; Path=/api/calendar; HttpOnly; Secure; SameSite=Lax; Max-Age=0','Cache-Control':'no-store'}});
}
async function workspaceAction(request,env,session,action,p) {
  await ensureWorkspace(env); const owner=session.user_id;
  if(action==='workspaceGet') {
    const rows=await all(env.DB.prepare('SELECT kind,value,revision FROM teacher_workspace WHERE teacher_id=?').bind(owner));
    const classes=await all(env.DB.prepare('SELECT id,name,subject FROM classes WHERE teacher_id=? ORDER BY display_order').bind(owner));
    const connection=await env.DB.prepare('SELECT teacher_id FROM calendar_connections WHERE teacher_id=?').bind(owner).first();
    const upcoming=await all(env.DB.prepare("SELECT c.id,c.class_id,c.title,c.due_at,k.name AS class_name FROM contents c JOIN classes k ON k.id=c.class_id WHERE k.teacher_id=? AND c.type='assignment' AND c.due_at>=? ORDER BY c.due_at LIMIT 12").bind(owner,new Date().toISOString().slice(0,10)));
    return {upcoming,documents:Object.fromEntries(rows.map(r=>[r.kind,{value:JSON.parse(r.value),revision:r.revision}])),classes,calendar:{configured:calendarConfigured(env),connected:!!connection}};
  }
  if(action==='workspaceSave') {
    if(!['settings','timetable','records','notes'].includes(p.kind)) throw new AppError('잘못된 저장 항목입니다.','INVALID');
    if(p.value===undefined || p.value===null) throw new AppError('저장 내용을 확인해 주세요.','INVALID');
    const value=JSON.stringify(p.value); if(value.length>180000) throw new AppError('저장 용량을 초과했습니다. 기록을 내보내고 나누어 주세요.','TOO_LARGE');
    if(p.kind==='timetable' && (!Array.isArray(p.value.week)||!Array.isArray(p.value.exceptions))) throw new AppError('시간표 형식을 확인해 주세요.','INVALID');
    if(p.kind==='records' && !Array.isArray(p.value)) throw new AppError('기록 형식을 확인해 주세요.','INVALID');
    if(p.kind==='timetable' || p.kind==='records') {
      const refs=p.kind==='records'?p.value:[...p.value.week,...p.value.exceptions.flatMap(x=>x.lessons||[])];
      for(const id of new Set(refs.map(x=>x.classId).filter(Boolean))) await ownedClass(env,session,id);
    }
    const result=await env.DB.prepare('INSERT INTO teacher_workspace(teacher_id,kind,value,revision) SELECT ?,?,?,1 WHERE ?=0 ON CONFLICT(teacher_id,kind) DO NOTHING').bind(owner,p.kind,value,Number(p.revision||0)).run();
    if(!Number(result.meta?.changes??result.changes)) {
      const changed=await env.DB.prepare('UPDATE teacher_workspace SET value=?,revision=revision+1 WHERE teacher_id=? AND kind=? AND revision=? RETURNING revision').bind(value,owner,p.kind,Number(p.revision||0)).first();
      if(!changed) throw new AppError('다른 창에서 변경되었습니다. 입력을 복사한 뒤 새로 불러와 주세요.','WORKSPACE_CONFLICT',409);
      return changed;
    }
    return {revision:1};
  }
  if(action==='calendarConnect') {
    if(!calendarConfigured(env)) throw new AppError('Google OAuth 서버 설정이 필요합니다. 설정 화면의 안내를 확인해 주세요.','CALENDAR_SETUP',503);
    const state=crypto.randomUUID(),verifier=b64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare('DELETE FROM calendar_oauth_states WHERE expires<?').bind(Date.now()).run();
    await env.DB.prepare('INSERT INTO calendar_oauth_states VALUES(?,?,?,?)').bind(state,owner,verifier,Date.now()+600000).run();
    const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:env.GOOGLE_REDIRECT_URI,response_type:'code',scope:'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',access_type:'offline',prompt:'consent',state,code_challenge:b64url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))),code_challenge_method:'S256'}).toString();
    return {url:u.href,state};
  }
  if(action==='calendarDisconnect') {
    const row=await env.DB.prepare('SELECT encrypted FROM calendar_connections WHERE teacher_id=?').bind(owner).first();
    let revoked=false;
    if(row) { const t=await tokenCipher(env,row.encrypted,true,owner); try { revoked=(await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token:t.refresh_token||t.access_token})})).ok; } catch {} }
    await env.DB.prepare('DELETE FROM calendar_connections WHERE teacher_id=?').bind(owner).run();
    return {disconnected:true,revoked};
  }
  if(action==='calendarList') return googleRequest(env,owner,'users/me/calendarList?maxResults=250'+(p.pageToken?'&pageToken='+encodeURIComponent(p.pageToken):''));
  const base='calendars/'+encodeURIComponent(String(p.calendarId||'primary'))+'/events';
  if(action==='calendarEvents') {
    const q=new URLSearchParams({singleEvents:'true',maxResults:'250',showDeleted:'true'});
    if(p.syncToken) q.set('syncToken',p.syncToken);
    else { const start=Date.parse(p.start),end=Date.parse(p.end); if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>100*86400000) throw new AppError('조회 기간은 100일 이내로 선택해 주세요.','INVALID'); q.set('timeMin',new Date(start).toISOString()); q.set('timeMax',new Date(end).toISOString()); }
    if(p.pageToken) q.set('pageToken',p.pageToken);
    return googleRequest(env,owner,base+'?'+q);
  }
  if(action==='calendarEventGet') return googleRequest(env,owner,base+'/'+encodeURIComponent(p.id));
  if(action==='calendarEventSave' || action==='calendarEventDelete') {
    if(p.id && !p.etag) throw new AppError('최신 일정 버전이 필요합니다.','ETAG_REQUIRED',409);
    if(action==='calendarEventDelete') { if(!p.id) throw new AppError('일정을 선택해 주세요.','INVALID'); return googleRequest(env,owner,base+'/'+encodeURIComponent(p.id),{method:'DELETE',headers:{'If-Match':p.etag}}); }
    const e=p.event||{}; if(!String(e.summary||'').trim()||!e.start||!e.end) throw new AppError('제목과 날짜를 입력해 주세요.','INVALID');
    const body={}; for(const k of ['summary','start','end','description','location','colorId','recurrence','reminders','extendedProperties']) if(e[k]!==undefined) body[k]=e[k];
    if(!p.id) { if(!/^[a-v0-9]{16,64}$/.test(p.operationId||'')) throw new AppError('저장 요청 ID가 필요합니다.','INVALID'); body.id=p.operationId; }
    try { return await googleRequest(env,owner,base+(p.id?'/'+encodeURIComponent(p.id):''),{method:p.id?'PATCH':'POST',headers:p.id?{'If-Match':p.etag}:{},body:JSON.stringify(body)}); }
    catch(error) { if(!p.id&&error.code==='GOOGLE_409') return googleRequest(env,owner,base+'/'+body.id); throw error; }
  }
  throw new AppError('지원하지 않는 업무 요청입니다.','INVALID');
}
