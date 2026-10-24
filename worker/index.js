import qrcode from 'qrcode-generator';

const RELEASE = '2026-10-25-v68';
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
  if (row && expectedRole && row.role !== expectedRole) throw new AppError('이 기능에 접근할 권한이 없습니다.','UNAUTHORIZED',401);
  if (!row || row.expires_at <= nowIso()) {
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
    displayMode: row.display_mode || 'anonymous',
    id: row.id,
    ideaId: row.idea_id,
    classId: row.class_id,
    text: row.text || '',
    groupName: row.group_name || '',
    mine: Boolean(viewerId && row.student_id === viewerId),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (revealAuthor || row.display_mode === 'named') {
    if(revealAuthor) item.studentId = row.student_id;
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
    if(data.classInfo.lifecycle && data.classInfo.lifecycle!=='active')for(const kind of ['assignments','boards','ideas'])for(const item of data[kind])item.status='closed';
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
      if(item.displayMode!=='named'){delete item.studentNumber;delete item.studentName;}
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
  await ensureOperations(env);
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
  await ensureOperations(env);
  const lifecycle = await env.DB.prepare('SELECT status FROM class_operations WHERE class_id=?').bind(classId).first();
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
    classInfo: { ...classJson(classRow), lifecycle: lifecycle?.status || 'active' },
    categories: await categoryLabels(env, classRow.teacher_id, 'class:' + classId),
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
  if (category !== null) { if(payload.includeDescendants && category) { conditions.push('(category=? OR (category>=? AND category<?))'); bindings.push(category,category+' / ',category+' / \uffff'); } else { conditions.push('category=?'); bindings.push(category); } }
  if (search) {
    if(payload.searchMode==='text'){conditions.push('(title LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE)');bindings.push('%'+search+'%','%'+search+'%');}else{conditions.push('title LIKE ? COLLATE NOCASE');bindings.push(search + '%');}
  }
  if (cursor) {
    conditions.push('(updated_at<? OR (updated_at=? AND id<?))');
    bindings.push(String(cursor.updatedAt || ''), String(cursor.updatedAt || ''), String(cursor.id || ''));
  }
  const kinds={image:'image/%',video:'video/%',pdf:'application/pdf',document:'application/%'};
  if(payload.fileKind==='link')conditions.push("json_array_length(links)>0");
  else if(kinds[payload.fileKind]){conditions.push("EXISTS(SELECT 1 FROM attachments a JOIN files f ON f.id=a.file_id WHERE a.owner_type='teacher_resource' AND a.owner_id=teacher_resources.id AND f.mime_type LIKE ?)");bindings.push(kinds[payload.fileKind]);}
  const rows = await all(env.DB.prepare(
    'SELECT * FROM teacher_resources' + (search && payload.searchMode!=='text' ? ' INDEXED BY teacher_resources_teacher_title' : '') +
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
  const categoryTree = !cursor ? await categoryLabels(env, session.user_id, 'resources') : undefined;
  const combined = categories ? Array.from(new Set([...(categoryTree || []).map(x => x.path), ...categories])) : undefined;
  return { items, categories: combined, categoryTree, nextCursor: rows.length > 50 ? { updatedAt: last.updated_at, id: last.id } : null };
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
  await ensureOperations(env);const timer=timerJson(await env.DB.prepare('SELECT * FROM guest_timers WHERE class_id=?').bind(roomRow.id).first());
  return { room: guestRoomJson(roomRow), boards: boards.map(guestBoardJson), posts, timer };
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
    await ensureOperations(env);
    const backupUsage=await env.DB.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM class_backups').first();
    const usedBytes = Number(row && row.used_bytes || 0)+Number(backupUsage?.bytes||0);
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
  await ensureOperations(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM class_operations WHERE class_id=?').bind(row.id),
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
  const displayMode=String(payload.displayMode||'anonymous');
  if(!['anonymous','named','group'].includes(displayMode)||(displayMode==='group'&&!groupName))throw new AppError('표시 방식과 모둠을 확인해 주세요.','INVALID_GROUP');
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
  await env.DB.prepare('UPDATE idea_posts SET display_mode=? WHERE id=?').bind(displayMode,row.id).run();
  await touchClass(env,student.class_id);
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
  if (action.startsWith('ops')) return operationsAction(request, env, await sessionFromToken(env, body.token, 'teacher'), action, payload);
  if (action === 'joinGuestRoom') return joinGuestRoom(env, payload);
  const teacherActions = new Set([
    'getTeacherResources', 'upsertTeacherResource', 'deleteTeacherResource', 'exportClassArchive', 'manageCategory',
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

  if (session.role === 'student' && ['upsertSubmission','deleteSubmission','upsertBoardPost','deleteBoardPost','upsertIdeaPost','deleteIdeaPost','setBoardReaction'].includes(action)) await requireActiveClass(env, session.class_id);

  switch (action) {
    case 'manageCategory': return manageCategory(env, session, payload);
    case 'exportClassArchive': return exportClassArchive(env, request, session, payload);
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
  if (session.role === 'student') await requireActiveClass(env, session.class_id);
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
  async scheduled(controller, env, ctx) { ctx.waitUntil(runScheduledBackups(env)); },
  async fetch(request, env) {
    env = { ...env, DB: env.DB ? instrumentD1(env.DB) : env.DB };
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
        if (databaseReady) { await ensureWorkspace(env); await ensureCategorySchema(env); await ensureOperations(env); }
        return ok({
          status: 'ok',
          databaseReady,
          featureSchemaReady: databaseReady && featureSchemaVerified,
          databaseIssue: databaseReady && featureSchemaError ? featureSchemaError : '',
          provider: 'cloudflare',
          release: RELEASE,
          workspaceSchemaReady: databaseReady,
          categorySchemaReady: databaseReady,
          operationsSchemaReady: databaseReady,
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
  await saveGoogleToken(env,row.teacher_id,{...t,expires:Date.now()+t.expires_in*1000});invalidateCalendarCache(row.teacher_id);
  return new Response(null,{status:303,headers:{Location:new URL('/#/teacher/calendar',u).href,'Set-Cookie':'learn_oauth=; Path=/api/calendar; HttpOnly; Secure; SameSite=Lax; Max-Age=0','Cache-Control':'no-store'}});
}
async function workspaceAction(request,env,session,action,p) {
  await ensureWorkspace(env); const owner=session.user_id;
  if(action==='workspaceGet') {
    const rows=await all(env.DB.prepare('SELECT kind,value,revision FROM teacher_workspace WHERE teacher_id=?').bind(owner));
    const classes=await all(env.DB.prepare('SELECT id,name,subject FROM classes WHERE teacher_id=? ORDER BY display_order').bind(owner));
    const connection=await env.DB.prepare('SELECT teacher_id FROM calendar_connections WHERE teacher_id=?').bind(owner).first();
    const upcoming=await all(env.DB.prepare("SELECT c.id,c.class_id,c.title,c.due_at,k.name AS class_name FROM contents c JOIN classes k ON k.id=c.class_id WHERE k.teacher_id=? AND c.type='assignment' AND c.due_at>=? ORDER BY c.due_at LIMIT 12").bind(owner,new Date().toISOString().slice(0,10)));
    await ensureOperations(env);
    const pending=await all(env.DB.prepare("SELECT k.id,k.name FROM classes k WHERE k.teacher_id=? AND EXISTS(SELECT 1 FROM board_posts p WHERE p.class_id=k.id AND p.status='published') ORDER BY k.display_order LIMIT 12").bind(owner));
    return {pending,upcoming,documents:Object.fromEntries(rows.map(r=>[r.kind,{value:JSON.parse(r.value),revision:r.revision}])),classes,calendar:{configured:calendarConfigured(env),connected:!!connection}};
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
    invalidateCalendarCache(owner);
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
    return cachedCalendarEvents(env,owner,base+'?'+q);
  }
  if(action==='calendarEventGet') return googleRequest(env,owner,base+'/'+encodeURIComponent(p.id));
  if(action==='calendarEventSave' || action==='calendarEventDelete') {
    invalidateCalendarCache(owner);
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

async function exportClassArchive(env, request, session, payload) {
  const row = await ownedClass(env, session, payload.classId);
  const snapshot = await classData(env, row.id, '', Number(row.version || 1));
  await ensureWorkspace(env);
  const recordRow = await env.DB.prepare("SELECT value,revision FROM teacher_workspace WHERE teacher_id=? AND kind='records'").bind(session.user_id).first();
  const records = recordRow ? JSON.parse(recordRow.value).filter(record => record.classId === row.id) : [];
  const after = await ownedClass(env, session, row.id);
  if (Number(after.version) !== Number(row.version)) throw new AppError('내보내는 동안 수업 자료가 변경되었습니다. 다시 시도해 주세요.', 'ARCHIVE_CHANGED', 409);
  delete snapshot.classInfo.code;
  snapshot.students = snapshot.students.map(({id,number,name}) => ({id,number,name}));
  delete snapshot.timer;
  const fileMap = new Map();
  for (const group of ['announcements','assignments','boards','ideas','submissions','boardPosts']) {
    for (const item of snapshot[group] || []) for (const file of item.attachments || []) fileMap.set(file.id, file);
  }
  if (fileMap.size > 2000) throw new AppError('첨부파일이 2,000개를 초과합니다. 활동별 다운로드를 이용해 주세요.', 'ARCHIVE_TOO_LARGE', 413);
  // IDs come only from the authorized class snapshot, never from caller-provided file lists.
  const files = [];
  for (const file of fileMap.values()) files.push({...file,downloadUrl:payload.includeFiles ? await signedFileUrl(env, request, file, 'download') : ''});
  return {format:'learn-class-archive',schemaVersion:1,exportedAt:nowIso(),classVersion:Number(row.version),recordsRevision:Number(recordRow?.revision || 0),snapshot,records,files};
}

let categorySchemaPromise;
async function ensureCategorySchema(env) {
  if(!categorySchemaPromise) categorySchemaPromise=env.DB.prepare('CREATE TABLE IF NOT EXISTS teacher_categories (teacher_id TEXT NOT NULL,scope TEXT NOT NULL,path TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(teacher_id,scope,path))').run().catch(e=>{categorySchemaPromise=null;throw e;});
  await categorySchemaPromise;
}
async function categoryLabels(env,teacherId,scope) {
  await ensureCategorySchema(env);
  return all(env.DB.prepare('SELECT path,position FROM teacher_categories WHERE teacher_id=? AND scope=? ORDER BY position,path').bind(teacherId,scope));
}
async function manageCategory(env,session,p) {
  const isResource=p.scope==='resources',scope=isResource?'resources':'class:'+String(p.classId||'');
  if(isResource)await ensureTeacherResourceSchema(env);else await ownedClass(env,session,p.classId);
  const labels=await categoryLabels(env,session.user_id,scope);
  const table=isResource?'teacher_resources':'contents',key=isResource?'teacher_id':'class_id',owner=isResource?session.user_id:p.classId;
  const used=(await all(env.DB.prepare(`SELECT DISTINCT category FROM ${table} WHERE ${key}=? AND category<>''`).bind(owner))).map(r=>r.category);
  const paths=Array.from(new Set([...labels.map(x=>x.path),...used].flatMap(path=>path.split(' / ').map((_,i)=>path.split(' / ').slice(0,i+1).join(' / ')))));
  const path=normalizeResourceCategory(p.path),target=normalizeResourceCategory(p.target);
  if(!path || path==='미분류' || path==='all' || path.split(' / ').some(x=>!x.trim())||path.split(' / ').length>5)throw new AppError('분류 경로를 확인해 주세요. 최대 5단계, 전체 40자입니다.','INVALID_CATEGORY');
  const affected=paths.filter(x=>x===path||x.startsWith(path+' / '));
  const statements=[];
  if(p.operation==='add') {
    if(paths.length>=100)throw new AppError('분류는 최대 100개입니다.','CATEGORY_LIMIT');
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO teacher_categories VALUES(?,?,?,?)').bind(session.user_id,scope,path,labels.length));
  }else if(p.operation==='rename') {
    if(!affected.length)throw new AppError('분류를 찾을 수 없습니다.','NOT_FOUND',404);
    if(!target||target==='미분류'||target==='all'||target===path||target.startsWith(path+' / '))throw new AppError('이동할 새 경로를 확인해 주세요. 자신의 하위로 이동할 수 없습니다.','INVALID_CATEGORY');
    if(affected.length>100)throw new AppError('한 번에 변경할 수 있는 분류 수를 초과했습니다.','CATEGORY_LIMIT');
    const mapped=affected.map(x=>target+x.slice(path.length));
    if(mapped.some(x=>x.length>40||x.split(' / ').length>5||x.split(' / ').some(s=>!s.trim())))throw new AppError('변경 후 경로가 40자 또는 5단계를 초과합니다.','INVALID_CATEGORY');
    if(mapped.some(x=>paths.includes(x)&&!affected.includes(x))&&!p.merge)throw new AppError('동일한 분류가 있습니다. 통합 옵션을 선택해 주세요.','CATEGORY_EXISTS',409);
    statements.push(env.DB.prepare(`UPDATE ${table} SET category=? || substr(category,?) WHERE ${key}=? AND (category=? OR substr(category,1,?)=?)`).bind(target,path.length+1,owner,path,path.length+3,path+' / '));
    for(const old of affected)statements.push(env.DB.prepare('DELETE FROM teacher_categories WHERE teacher_id=? AND scope=? AND path=?').bind(session.user_id,scope,old));
    for(let i=0;i<affected.length;i++) {
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO teacher_categories VALUES(?,?,?,?)').bind(session.user_id,scope,mapped[i],labels.find(x=>x.path===affected[i])?.position||0));
    }
  }else if(p.operation==='delete') {
    if(affected.length>100)throw new AppError('한 번에 변경할 분류 수를 초과했습니다.','CATEGORY_LIMIT');
    for(const item of affected){statements.push(env.DB.prepare(`UPDATE ${table} SET category='' WHERE ${key}=? AND category=?`).bind(owner,item));statements.push(env.DB.prepare('DELETE FROM teacher_categories WHERE teacher_id=? AND scope=? AND path=?').bind(session.user_id,scope,item));}
  }else if(p.operation==='order') {
    if(!Array.isArray(p.order)||p.order.length>100||p.order.some(x=>!paths.includes(x)))throw new AppError('분류 순서를 확인해 주세요.','INVALID_CATEGORY');
    p.order.forEach((x,i)=>statements.push(env.DB.prepare('INSERT INTO teacher_categories VALUES(?,?,?,?) ON CONFLICT(teacher_id,scope,path) DO UPDATE SET position=excluded.position').bind(session.user_id,scope,x,i)));
  }else throw new AppError('분류 작업을 확인해 주세요.','INVALID');
  if(statements.length)await env.DB.batch(statements);
  if(!isResource)await touchClass(env,p.classId);
  return {updated:true};
}

// Optional, owner-scoped operations. No automatic deletion of classroom data.
const operationsSchema = `CREATE TABLE IF NOT EXISTS class_operations(class_id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',backup_enabled INTEGER NOT NULL DEFAULT 0,next_backup INTEGER NOT NULL DEFAULT 0,last_backup TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,display TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS board_posts_class_status ON board_posts(class_id,status);
CREATE INDEX IF NOT EXISTS operations_owner ON class_operations(teacher_id,class_id);
CREATE INDEX IF NOT EXISTS operations_due ON class_operations(backup_enabled,next_backup);
CREATE TABLE IF NOT EXISTS class_backups(id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL,class_id TEXT NOT NULL,created_at TEXT NOT NULL,r2_key TEXT NOT NULL,checksum TEXT NOT NULL,bytes INTEGER NOT NULL,restored_class_id TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS backups_owner_class ON class_backups(teacher_id,class_id,created_at DESC);
CREATE TABLE IF NOT EXISTS guest_timers(class_id TEXT PRIMARY KEY,title TEXT NOT NULL,sound TEXT NOT NULL,started_at TEXT NOT NULL,ends_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backup_jobs(id TEXT PRIMARY KEY,teacher_id TEXT NOT NULL,class_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',cursor INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL,state TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS backup_jobs_due ON backup_jobs(kind,status,error,created_at);
CREATE INDEX IF NOT EXISTS backup_jobs_owner ON backup_jobs(teacher_id,status,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_source ON backup_jobs(teacher_id,kind,source_id) WHERE status IN ('pending','cleaning');
CREATE TABLE IF NOT EXISTS restore_claims(backup_id TEXT PRIMARY KEY,class_id TEXT NOT NULL,valid INTEGER NOT NULL DEFAULT 1 CHECK(valid=1));`;
let operationsReady;
async function ensureOperations(env) {
  if (!operationsReady) operationsReady=(async()=>{for(const sql of operationsSchema.split(';').map(x=>x.trim()).filter(Boolean)) await env.DB.prepare(sql).run();const cols=await all(env.DB.prepare('PRAGMA table_info(idea_posts)'));if(!cols.some(c=>c.name==='display_mode')){try{await env.DB.prepare("ALTER TABLE idea_posts ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'anonymous'").run();}catch(e){if(!String(e.message).includes('duplicate column'))throw e;}}})().catch(e=>{operationsReady=null;throw e;});
  return operationsReady;
}
async function requireActiveClass(env,id) {
  await ensureOperations(env);
  const row=await env.DB.prepare('SELECT status FROM class_operations WHERE class_id=?').bind(id).first();
  if(row && row.status!=='active') throw new AppError('마감·보관 중인 클래스입니다. 자료는 볼 수 있으며 선생님이 재개하면 작성할 수 있습니다.','CLASS_CLOSED',409);
}
async function operationRow(env,session,id) {
  await ownedClass(env,session,id);await ensureOperations(env);
  await env.DB.prepare('INSERT OR IGNORE INTO class_operations(class_id,teacher_id) VALUES(?,?)').bind(id,session.user_id).run();
  return env.DB.prepare('SELECT * FROM class_operations WHERE class_id=? AND teacher_id=?').bind(id,session.user_id).first();
}
async function operationsAction(request,env,session,action,p) {
  await ensureOperations(env);
  if(action==='opsGuestTimerSet') {
    const room=await ownedGuestRoom(env,session,p.roomId);
    if(p.clear)await env.DB.prepare('DELETE FROM guest_timers WHERE class_id=?').bind(room.id).run();
    else{const seconds=Number(p.seconds);if(!Number.isInteger(seconds)||seconds<10||seconds>7200)throw new AppError('10초~120분을 입력해 주세요.','INVALID');const sound=['bell','chime','woodblock','ascending'].includes(p.sound)?p.sound:'bell',time=nowIso();await env.DB.prepare('INSERT INTO guest_timers VALUES(?,?,?,?,?,?) ON CONFLICT(class_id) DO UPDATE SET title=excluded.title,sound=excluded.sound,started_at=excluded.started_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at').bind(room.id,String(p.title||'활동 시간').slice(0,50),sound,time,new Date(Date.now()+seconds*1000).toISOString(),time).run();}
    await touchGuestRoom(env,room.id);return {saved:true};
  }
  if(action==='opsCloudUsage') return cloudUsage(env,session);
  if(action==='opsOverview') {
    const classes=await all(env.DB.prepare("SELECT c.id,c.name,COALESCE(o.status,'active') status,COALESCE(o.backup_enabled,0) backup_enabled,o.next_backup,o.last_backup,o.last_error FROM classes c LEFT JOIN class_operations o ON o.class_id=c.id WHERE c.teacher_id=? ORDER BY c.display_order").bind(session.user_id));
    const backups=await all(env.DB.prepare('SELECT id,class_id,created_at,bytes,restored_class_id FROM class_backups WHERE teacher_id=? ORDER BY created_at DESC LIMIT 100').bind(session.user_id));
    const jobs=await all(env.DB.prepare("SELECT id,class_id,kind,status,cursor,total,error,created_at FROM backup_jobs WHERE teacher_id=? AND status IN ('pending','cleaning') ORDER BY created_at DESC LIMIT 30").bind(session.user_id));
    return {classes,backups,jobs,cloudConfigured:!!(env.CF_ANALYTICS_ACCOUNT_ID&&env.CF_ANALYTICS_TOKEN),automaticDeletion:false,role:env.OWNER_TEACHER_ID===session.user_id?'owner':'teacher',metrics:env.OWNER_TEACHER_ID===session.user_id?{scope:'현재 Worker 인스턴스의 all/run/batch 결과 합계. first 조회·다른 인스턴스 제외. 계정 전체 사용량 아님',...d1Telemetry}:null,storage:await fileStorageStatus(env)};
  }
  if(action==='opsDisplayGet') {
    await ownedClass(env,session,p.classId);
    const row=await env.DB.prepare('SELECT display FROM class_operations WHERE class_id=?').bind(p.classId).first();
    const data=await classData(env,p.classId);
    const display=JSON.parse(row?.display||'{}');
    return {display,className:data.classInfo.name,timer:data.timer,boards:data.boards.map(x=>({id:x.id,title:x.title})),posts:data.boardPosts.filter(x=>['published','confirmed'].includes(x.status)).map(x=>({id:x.id,boardId:x.boardId,title:x.title,text:x.text,attachments:x.attachments||[]})),announcements:data.announcements.map(x=>({id:x.id,title:x.title,body:x.body,attachments:x.attachments||[]}))};
  }
  if(action==='opsDisplaySet') {
    await operationRow(env,session,p.classId);
    if(!['board','announcement','blank'].includes(p.mode))throw new AppError('화면 종류를 확인해 주세요.','INVALID');
    if(p.contentId){const c=await env.DB.prepare('SELECT id FROM contents WHERE id=? AND class_id=? AND type=?').bind(String(p.contentId),p.classId,p.mode).first();if(!c)throw new AppError('표시할 자료를 찾을 수 없습니다.','NOT_FOUND',404);}
    const display={mode:p.mode,contentId:String(p.contentId||''),fontSize:Math.max(18,Math.min(60,Number(p.fontSize)||28)),updatedAt:nowIso()};
    await env.DB.prepare('UPDATE class_operations SET display=? WHERE class_id=? AND teacher_id=?').bind(JSON.stringify(display),p.classId,session.user_id).run();await touchClass(env,p.classId);return {display};
  }
  if(action==='opsLifecycle') {
    const row=await operationRow(env,session,p.classId);
    if(!['active','closed','archived'].includes(p.status))throw new AppError('상태를 확인해 주세요.','INVALID');
    if(p.previous!==row.status)throw new AppError('다른 창에서 상태가 바뀌었습니다. 새로 불러와 주세요.','CONFLICT',409);
    const changed=await env.DB.prepare('UPDATE class_operations SET status=? WHERE class_id=? AND teacher_id=? AND status=?').bind(p.status,p.classId,session.user_id,p.previous).run();
    if(!changed.meta?.changes)throw new AppError('상태 변경이 충돌했습니다.','CONFLICT',409);
    await touchClass(env,p.classId);return {status:p.status};
  }
  if(action==='opsBackupPolicy') {
    await operationRow(env,session,p.classId);
    await env.DB.prepare("UPDATE class_operations SET backup_enabled=?,next_backup=?,last_error='' WHERE class_id=? AND teacher_id=?").bind(p.enabled?1:0,Date.now()+7*86400000,p.classId,session.user_id).run();
    return {enabled:!!p.enabled,intervalDays:7};
  }
  if(action==='opsBackupStart') {await operationRow(env,session,p.classId);const old=await pendingJob(env,session,'backup',p.classId);return old?jobResult(old):createClassBackup(env,session,p.classId,true);}
  if(action==='opsRestoreStart')return startRestoreJob(env,session,p);
  if(action==='opsVerifyStart')return startRestoreJob(env,session,p,'verify');
  if(action==='opsJobStep')return stepBackupJob(env,session,p.jobId);
  if(action==='opsJobCancel'){const job=await ownedJob(env,session,p.jobId);if(job.status==='done')return jobResult(job);await env.DB.prepare("UPDATE backup_jobs SET status='cleaning',cursor=0 WHERE id=? AND lease_until<?").bind(job.id,Date.now()).run();return stepBackupJob(env,session,job.id);}
  if(action==='opsBackupNow') {await operationRow(env,session,p.classId);return createClassBackup(env,session,p.classId);}
  if(action==='opsBackupVerify') {const initial=await verifiedBackup(env,session,p.backupId,true);if(initial.pack.files.length>5)return startRestoreJob(env,session,p,'verify');const {pack,row}=await verifiedBackup(env,session,p.backupId);return {verified:true,createdAt:row.created_at,counts:Object.fromEntries(Object.entries(pack.tables).map(([k,v])=>[k,v.length])),files:pack.files.length};}
  if(action==='opsBackupRestore')return restoreClassBackup(env,session,p);
  throw new AppError('지원하지 않는 관리 요청입니다.','INVALID');
}
const backupTables=['students','contents','submissions','board_posts','idea_posts'];
async function createClassBackup(env,session,id,staged=false) {
  const cls=await ownedClass(env,session,id);await ensureOperations(env);
  const pending=await pendingJob(env,session,'backup',id);if(pending)throw new AppError('진행 중인 보관을 먼저 이어가거나 정리해 주세요.','BACKUP_BUSY',409);await ensureWorkspace(env);await ensureCategorySchema(env);
  const lock=await env.DB.prepare('UPDATE class_operations SET lease_until=? WHERE class_id=? AND teacher_id=? AND lease_until<? RETURNING class_id').bind(Date.now()+600000,id,session.user_id,Date.now()).first();
  if(!lock)throw new AppError('이미 보관 작업 중입니다. 잠시 후 다시 확인해 주세요.','BACKUP_BUSY',409);
  const copied=[];let manifestKey='',commitAttempted=false;
  try {
    const count=await env.DB.prepare('SELECT COUNT(*) n FROM class_backups WHERE teacher_id=? AND class_id=?').bind(session.user_id,id).first();
    if(count.n>=3)throw new AppError('클래스별 서버 보관본 3개에 도달했습니다. 기존 보관본은 자동 삭제하지 않습니다. 정기 보관을 끄거나 HTML로 보관해 주세요.','BACKUP_CAP');
    const results=await env.DB.batch(backupTables.map(t=>env.DB.prepare(`SELECT * FROM ${t} WHERE class_id=? LIMIT ${staged?5001:501}`).bind(id)));
    const tables=Object.fromEntries(backupTables.map((t,i)=>[t,results[i].results||[]]));
    if(Object.values(tables).reduce((n,rows)=>n+rows.length,0)>(staged?5000:500))throw new AppError('큰 클래스는 현재 서버 보관 한도를 넘습니다. 수업 HTML 보관을 이용해 주세요.','BACKUP_CAP');
    // Credentials and sessions are never copied; restored students must be reissued a PIN.
    tables.students=tables.students.map(({pin_hash,pin_salt,password_hash,password_salt,...r})=>r);
    const ownerSql="SELECT id FROM contents WHERE class_id=? UNION ALL SELECT id FROM submissions WHERE class_id=? UNION ALL SELECT id FROM board_posts WHERE class_id=? UNION ALL SELECT id FROM idea_posts WHERE class_id=?";
    const attachments=await all(env.DB.prepare(`SELECT * FROM attachments WHERE owner_id IN (${ownerSql}) LIMIT 1001`).bind(id,id,id,id));
    const ids=[...new Set(attachments.map(a=>a.file_id))];
    if(attachments.length>1000||ids.length>(staged?200:5))throw new AppError('서버 보관 첨부 한도(단계 보관 200개)를 초과했습니다. 수업 HTML 보관을 이용해 주세요.','BACKUP_CAP');
    const files=ids.length?await all(env.DB.prepare('SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids))):[];
    if(files.length!==ids.length)throw new AppError('첨부 메타데이터가 누락되어 보관을 중단했습니다.','BACKUP_MISSING');
    const backupId=uid('backup');let bytes=0;
    if(!staged)for(const f of files){const source=await env.FILES.get(f.r2_key);if(!source?.body)throw new AppError('첨부 원본을 찾지 못했습니다.','BACKUP_MISSING');const target=`backups/${session.user_id}/${backupId}/${f.id}`;const written=await env.FILES.put(target,source.body);copied.push(target);if(!written||written.size!==source.size||written.etag!==source.etag)throw new AppError('첨부 복사 검증에 실패했습니다.','BACKUP_INTEGRITY');f.backup_key=target;f.backup_etag=written.etag;bytes+=written.size;}
    const rec=await env.DB.prepare("SELECT value,revision FROM teacher_workspace WHERE teacher_id=? AND kind='records'").bind(session.user_id).first();
    const reactions=await all(env.DB.prepare('SELECT r.* FROM board_post_reactions r JOIN board_posts p ON p.id=r.post_id WHERE p.class_id=? LIMIT 501').bind(id));
    if(reactions.length>500)throw new AppError('공감 내역이 보관 한도를 초과합니다.','BACKUP_CAP');
    const driveArchives=await all(env.DB.prepare('SELECT * FROM drive_archives WHERE class_id=? AND teacher_id=? LIMIT 501').bind(id,session.user_id));
    if(driveArchives.length>500)throw new AppError('외부 보관 링크가 한도를 초과합니다.','BACKUP_CAP');
    const pack={reactions,driveArchives,format:'learn-server-backup',schema:1,owner:session.user_id,classInfo:{name:cls.name,subject:cls.subject,school:cls.school},sourceClassId:id,tables,attachments,files,categories:await categoryLabels(env,session.user_id,'class:'+id),records:JSON.parse(rec?.value||'[]').filter(x=>x.classId===id),createdAt:nowIso()};
    const current=await ownedClass(env,session,id);
    if(current.version!==cls.version)throw new AppError('수업 자료가 변경되어 보관을 중단했습니다. 다시 시도해 주세요.','BACKUP_CHANGED',409);
    const jsonText=JSON.stringify(pack);if(new TextEncoder().encode(jsonText).length>(staged?8000000:1500000))throw new AppError('보관 문서 한도를 초과했습니다.','BACKUP_CAP');
    const checksum=await sha256(jsonText);
    if(staged){
      const packKey=`backup-jobs/${session.user_id}/${backupId}/snapshot.json`;
      await env.FILES.put(packKey,jsonText);copied.push(packKey);
      const check=await env.FILES.get(packKey);if(!check||await sha256(await check.text())!==checksum)throw new AppError('작업 원본 검사 실패','BACKUP_INTEGRITY');
      commitAttempted=true;
      await env.DB.prepare('INSERT INTO backup_jobs(id,teacher_id,class_id,kind,source_id,total,state,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(backupId,session.user_id,id,'backup',id,files.length,JSON.stringify({packKey,checksum,sourceVersion:cls.version,bytes:0,etags:[]}),pack.createdAt).run();
      return {jobId:backupId,status:'pending',cursor:0,total:files.length,kind:'backup'};
    }
    manifestKey=`backups/${session.user_id}/${backupId}/manifest.json`;await env.FILES.put(manifestKey,jsonText,{httpMetadata:{contentType:'application/json'}});copied.push(manifestKey);
    const check=await env.FILES.get(manifestKey);if(!check||await sha256(await check.text())!==checksum)throw new AppError('보관본 재읽기 검증에 실패했습니다.','BACKUP_INTEGRITY');
    commitAttempted=true;
    await env.DB.batch([env.DB.prepare('INSERT INTO class_backups(id,teacher_id,class_id,created_at,r2_key,checksum,bytes) VALUES(?,?,?,?,?,?,?)').bind(backupId,session.user_id,id,pack.createdAt,manifestKey,checksum,bytes+new TextEncoder().encode(jsonText).length),env.DB.prepare("UPDATE class_operations SET last_backup=?,last_error='',next_backup=?,lease_until=0 WHERE class_id=?").bind(pack.createdAt,Date.now()+7*86400000,id)]);
    invalidateFileStorageStatus();return {id:backupId,verified:true,files:files.length};
  }catch(e){if(!commitAttempted)for(const key of copied)try{await env.FILES.delete(key);}catch{}await env.DB.prepare('UPDATE class_operations SET last_error=?,next_backup=?,lease_until=0,backup_enabled=CASE WHEN ?=1 THEN 0 ELSE backup_enabled END WHERE class_id=?').bind(String(e.message).slice(0,300)+(e.code==='BACKUP_CAP'?' (정기 보관 자동 중지)':''),Date.now()+86400000,e.code==='BACKUP_CAP'?1:0,id).run();throw e;}
}
async function verifiedBackup(env,session,id,skipFiles=false) {
  const row=await env.DB.prepare('SELECT * FROM class_backups WHERE id=? AND teacher_id=?').bind(String(id||''),session.user_id).first();if(!row)throw new AppError('보관본을 찾을 수 없습니다.','NOT_FOUND',404);
  const obj=await env.FILES.get(row.r2_key);if(!obj)throw new AppError('보관 파일이 없습니다.','BACKUP_MISSING');const text=await obj.text();if(await sha256(text)!==row.checksum)throw new AppError('보관 파일이 손상되었습니다.','BACKUP_INTEGRITY');
  const pack=JSON.parse(text);if(pack.format!=='learn-server-backup'||pack.schema!==1||pack.owner!==session.user_id)throw new AppError('보관 형식 또는 소유자가 일치하지 않습니다.','BACKUP_INTEGRITY');
  if(!skipFiles)for(const file of pack.files){const f=await env.FILES.head(file.backup_key);if(!f||f.etag!==file.backup_etag||f.size!==file.size)throw new AppError('보관 첨부가 누락되거나 변경되었습니다.','BACKUP_INTEGRITY');}
  return {pack,row};
}
async function restoreClassBackup(env,session,p,jobPlan=null) {
  const {pack,row}=await verifiedBackup(env,session,p.backupId,true);
  if(!jobPlan&&pack.files.length>5)return startRestoreJob(env,session,p);
  if(!jobPlan)await verifiedBackup(env,session,p.backupId);
  if(row.restored_class_id)return {classId:row.restored_class_id,reused:true};
  const name=String(p.name||'').trim().slice(0,40);if(!name)throw new AppError('복원할 새 클래스 이름을 입력해 주세요.','INVALID');
  await ensureStudentCredentialSchema(env);await ensureWorkspace(env);
  const classId=jobPlan?.classId||uid('class'),code=jobPlan?.code||randomRoomCode(),maps=new Map(jobPlan?.maps||[]),statements=[],inserts=new Map(),created=nowIso();
  for(const rows of Object.values(pack.tables))for(const r of rows)maps.has(r.id)||maps.set(r.id,uid('restored'));
  for(const f of pack.files)maps.has(f.id)||maps.set(f.id,uid('file'));
  function insert(table,r){if(!inserts.has(table))inserts.set(table,[]);inserts.get(table).push(r);}
  insert('classes',{id:classId,teacher_id:session.user_id,name,subject:pack.classInfo.subject||'',school:pack.classInfo.school||'',code,student_count:pack.tables.students.length,created_at:created,updated_at:created});
  for(const t of backupTables){for(const original of pack.tables[t]){const r={...original,id:maps.get(original.id),class_id:classId};for(const k of ['student_id','assignment_id','board_id','idea_id'])if(r[k]){if(!maps.has(r[k]))throw new AppError('보관 관계가 손상되었습니다.','BACKUP_INTEGRITY');r[k]=maps.get(r[k]);}if(t==='students'){r.pin_salt=randomToken();r.pin_hash=await pinHash(randomToken(),r.pin_salt,env);r.password_hash='';r.password_salt='';r.last_seen_at='';}insert(t,r);}}
  // Restored files are independent copies; source backup objects remain untouched.
  for(const f of pack.files)insert('files',{id:maps.get(f.id),r2_key:`restored/${classId}/${maps.get(f.id)}`,name:f.name,mime_type:f.mime_type,size:f.size,uploader_role:'teacher',uploader_id:session.user_id,created_at:created,claimed_at:created});
  for(const a of pack.attachments){if(!maps.has(a.owner_id)||!maps.has(a.file_id))throw new AppError('첨부 관계가 손상되었습니다.','BACKUP_INTEGRITY');insert('attachments',{...a,owner_id:maps.get(a.owner_id),file_id:maps.get(a.file_id)});}
  for(const r of pack.reactions||[])if(maps.has(r.post_id)&&maps.has(r.student_id))insert('board_post_reactions',{...r,post_id:maps.get(r.post_id),student_id:maps.get(r.student_id)});
  for(const r of pack.driveArchives||[])if(maps.has(r.owner_id))insert('drive_archives',{...r,id:uid('archive'),class_id:classId,teacher_id:session.user_id,owner_id:maps.get(r.owner_id)});
  for(const c of pack.categories)insert('teacher_categories',{teacher_id:session.user_id,scope:'class:'+classId,path:c.path,position:c.position});
  insert('class_operations',{class_id:classId,teacher_id:session.user_id,status:'archived'});
  const recordDoc=await env.DB.prepare("SELECT value,revision FROM teacher_workspace WHERE teacher_id=? AND kind='records'").bind(session.user_id).first();
  const recoveredRecords=pack.records.map(x=>({...x,id:uid('record'),classId,className:name}));
  const recordsJson=JSON.stringify([...JSON.parse(recordDoc?.value||'[]'),...recoveredRecords]);
  if(recordsJson.length>180000)throw new AppError('교사 기록 저장 한도를 초과합니다. 기록을 정리한 뒤 복원해 주세요.','BACKUP_CAP');
  statements.unshift(env.DB.prepare("INSERT INTO restore_claims(backup_id,class_id,valid) VALUES(?,?,CASE WHEN COALESCE((SELECT revision FROM teacher_workspace WHERE teacher_id=? AND kind='records'),0)=? THEN 1 ELSE 0 END)").bind(row.id,classId,session.user_id,recordDoc?.revision||0));
  statements.push(env.DB.prepare("INSERT INTO teacher_workspace(teacher_id,kind,value,revision) VALUES(?,'records',?,1) ON CONFLICT(teacher_id,kind) DO UPDATE SET value=excluded.value,revision=teacher_workspace.revision+1").bind(session.user_id,recordsJson));
  // Race guard: a concurrent restoration fails the entire transaction instead of creating a duplicate.
  statements.unshift(env.DB.prepare("UPDATE class_backups SET restored_class_id=? WHERE id=? AND teacher_id=? AND restored_class_id='' RETURNING id").bind(classId,row.id,session.user_id));
  for(const [table,rows] of inserts){const keys=Object.keys(rows[0]);let chunk=[],size=2;const flush=()=>{if(chunk.length)statements.push(env.DB.prepare(`INSERT INTO ${table}(${keys.join(',')}) SELECT ${keys.map(k=>"json_extract(value,'$."+k+"')").join(',')} FROM json_each(?)`).bind(JSON.stringify(chunk)));chunk=[];size=2;};for(const r of rows){const n=new TextEncoder().encode(JSON.stringify(r)).length+1;if(n>900000)throw new AppError('단일 자료가 복원 한도를 초과합니다.','BACKUP_CAP');if(size+n>900000)flush();chunk.push(r);size+=n;}flush();}
  if(statements.length>40)throw new AppError('복원 문서 한도를 초과합니다.','BACKUP_CAP');
  const copies=[];let restoreCommitAttempted=false;
  try{if(!jobPlan)for(const f of pack.files){const source=await env.FILES.get(f.backup_key);const key=`restored/${classId}/${maps.get(f.id)}`;const result=await env.FILES.put(key,source.body);copies.push(key);if(result?.etag!==f.backup_etag)throw new AppError('복원 파일 확인에 실패했습니다.','BACKUP_INTEGRITY');}
    // Unique source-backup claim is enforced within the same D1 batch.
    restoreCommitAttempted=true;await env.DB.batch(statements);
  }catch(e){if(!restoreCommitAttempted)for(const k of copies)try{await env.FILES.delete(k);}catch{}throw e;}
  invalidateFileStorageStatus();return {classId,code,studentsRequirePinReset:true,recordsRestored:recoveredRecords.length};
}
async function runScheduledBackups(env) {
  if(!await schemaReady(env))return;await ensureOperations(env);
  const job=await env.DB.prepare("SELECT * FROM backup_jobs WHERE kind='backup' AND status IN ('pending','cleaning') AND lease_until<? AND error='' ORDER BY created_at LIMIT 1").bind(Date.now()).first();
  if(job){try{await stepBackupJob(env,{user_id:job.teacher_id,role:'teacher'},job.id);}catch(e){console.error('Backup step failed',job.id,e.code||'ERROR');}return;}
  const due=await all(env.DB.prepare('SELECT class_id,teacher_id FROM class_operations WHERE backup_enabled=1 AND next_backup<=? AND lease_until<? ORDER BY next_backup LIMIT 1').bind(Date.now(),Date.now()));
  for(const r of due){try{const session={user_id:r.teacher_id,role:'teacher'},j=await createClassBackup(env,session,r.class_id,true);await stepBackupJob(env,session,j.jobId);}catch(e){console.error('Scheduled class backup failed',r.class_id,e.code||'ERROR');}}
}

// D1 result metadata only; does not write counters back into D1 or retain SQL/student data.
const d1Telemetry={requests:0,rowsRead:0,rowsWritten:0,since:new Date().toISOString()};
function instrumentD1(db){
 const record=r=>{if(r?.meta){d1Telemetry.requests++;d1Telemetry.rowsRead+=Number(r.meta.rows_read||0);d1Telemetry.rowsWritten+=Number(r.meta.rows_written||0);}return r;};
 const originals=new WeakMap();
 const wrap=s=>{const proxy=new Proxy(s,{get(t,k){if(k==='bind')return(...a)=>wrap(t.bind(...a));if(k==='all'||k==='run')return async(...a)=>record(await t[k](...a));const v=t[k];return typeof v==='function'?v.bind(t):v;}});originals.set(proxy,s);return proxy;};
 return new Proxy(db,{get(t,k){if(k==='prepare')return sql=>wrap(t.prepare(sql));if(k==='batch')return async ss=>(await t.batch(ss.map(x=>originals.get(x)||x))).map(record);const v=t[k];return typeof v==='function'?v.bind(t):v;}});
}


// Optional account analytics: no network request until the owner explicitly opens it.
const cloudUsageCache=new Map();
async function cloudUsage(env,session) {
  if(!env.OWNER_TEACHER_ID||env.OWNER_TEACHER_ID!==session.user_id)throw new AppError('제작자만 계정 사용량을 볼 수 있습니다.','FORBIDDEN',403);
  if(!env.CF_ANALYTICS_ACCOUNT_ID||!env.CF_ANALYTICS_TOKEN)return {connected:false,reason:'서버의 Cloudflare 분석 연결을 설정한 뒤 조회할 수 있습니다.'};
  const cacheKey=await sha256(env.CF_ANALYTICS_ACCOUNT_ID+'|'+env.CF_ANALYTICS_TOKEN),cached=cloudUsageCache.get(cacheKey);
  if(cached&&cached.expires>Date.now())return cached.promise;
  const promise=(async()=>{
    const end=new Date().toISOString(),start=end.slice(0,10)+'T00:00:00.000Z';
    const datasets=[
      ['Workers','workersInvocationsAdaptive','sum { requests errors subrequests }'],
      ['D1','d1AnalyticsAdaptiveGroups','sum { rowsRead rowsWritten readQueries writeQueries }'],
      ['R2','r2OperationsAdaptiveGroups','sum { requests }'],
      ['Durable Objects','durableObjectsInvocationsAdaptiveGroups','sum { requests }']
    ];
    const products=await Promise.all(datasets.map(async([name,node,fields])=>{
      try{
        const query=`query($account:string!){viewer{accounts(filter:{accountTag:$account}){${node}(limit:1,filter:{datetime_geq:${JSON.stringify(start)},datetime_leq:${JSON.stringify(end)}}){${fields}}}}}`;
        const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',headers:{Authorization:'Bearer '+env.CF_ANALYTICS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{account:env.CF_ANALYTICS_ACCOUNT_ID,start,end}}),signal:AbortSignal.timeout(15000)});
        if(!response.ok)return {name,available:false,reason:'분석 서버 응답 '+response.status+' · 권한과 연결을 확인하세요.'};
        const json=await response.json(),rows=json.data?.viewer?.accounts?.[0]?.[node];
        if(json.errors?.length||!Array.isArray(rows))return {name,available:false,reason:'이 분석 자료를 조회할 수 없습니다. 계정의 분석 권한·요금제·API 필드를 확인하세요.'};
        // No dimensions requested: the API aggregates the complete selected account/time window.
        return {name,available:true,values:rows[0]?.sum||{},empty:!rows.length};
      }catch{return {name,available:false,reason:'분석 서버에 연결하지 못했습니다. 잠시 후 다시 조회하세요.'};}
    }));
    return {connected:products.some(p=>p.available),configured:true,scope:'Cloudflare 계정 전체 · 오늘 UTC 00:00 이후(한국 시간 오전 9시 기준)',start,end,fetchedAt:new Date().toISOString(),products,note:'분석 반영 지연·샘플링이 있을 수 있습니다. 청구서·잔여 무료 한도와 동일한 수치가 아니며 저장용량은 Cloudflare 대시보드에서 확인하세요.'};
  })();
  cloudUsageCache.clear();cloudUsageCache.set(cacheKey,{expires:Date.now()+300000,promise});return promise;
}

function jobResult(job,extra={}) {return {jobId:job.id,kind:job.kind,status:job.status,cursor:job.cursor,total:job.total,...extra};}
async function pendingJob(env,session,kind,source) {return env.DB.prepare("SELECT * FROM backup_jobs WHERE teacher_id=? AND kind=? AND source_id=? AND status IN ('pending','cleaning')").bind(session.user_id,kind,source).first();}
async function ownedJob(env,session,id) {const j=await env.DB.prepare('SELECT * FROM backup_jobs WHERE id=? AND teacher_id=?').bind(String(id||''),session.user_id).first();if(!j)throw new AppError('작업을 찾을 수 없습니다.','NOT_FOUND',404);return j;}
async function startRestoreJob(env,session,p,kind='restore') {
  const old=await pendingJob(env,session,kind,p.backupId);if(old)return jobResult(old);
  const {pack,row}=await verifiedBackup(env,session,p.backupId,true);
  if(kind==='restore'&&row.restored_class_id)return {status:'done',classId:row.restored_class_id,reused:true};
  const name=String(p.name||(kind==='verify'?'검사':'')).trim().slice(0,40);if(!name)throw new AppError('새 클래스 이름을 입력하세요.','INVALID');
  const maps=[];for(const rows of Object.values(pack.tables))for(const r of rows)maps.push([r.id,uid('restored')]);for(const f of pack.files)maps.push([f.id,uid('file')]);
  const id=uid('restorejob'),state={backupId:row.id,name,classId:uid('class'),code:randomRoomCode(),maps,checksum:row.checksum};
  await env.DB.prepare('INSERT INTO backup_jobs(id,teacher_id,class_id,kind,source_id,total,state,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,session.user_id,row.class_id,kind,row.id,pack.files.length,JSON.stringify(state),nowIso()).run();
  return {jobId:id,kind,status:'pending',cursor:0,total:pack.files.length};
}
async function stepBackupJob(env,session,id) {
  const existing=await ownedJob(env,session,id);
  if(existing.status==='done')return jobResult(existing,JSON.parse(existing.state).result||{});
  const lease=Date.now()+120000;
  const job=await env.DB.prepare("UPDATE backup_jobs SET lease_until=? WHERE id=? AND teacher_id=? AND lease_until<? AND status IN ('pending','cleaning') RETURNING *").bind(lease,id,session.user_id,Date.now()).first();
  if(!job)throw new AppError('다른 창에서 처리 중입니다. 잠시 후 이어가세요.','BACKUP_BUSY',409);
  const state=JSON.parse(job.state);let commitAttempted=false;
  try{
    let pack;
    if(job.kind==='backup'){
      const obj=await env.FILES.get(state.packKey);if(!obj)throw new AppError('진행 중 보관 원본이 없습니다.','BACKUP_MISSING');const text=await obj.text();if(await sha256(text)!==state.checksum)throw new AppError('작업 원본이 변경되었습니다.','BACKUP_INTEGRITY');pack=JSON.parse(text);
    }else{
      const source=await verifiedBackup(env,session,state.backupId,true);if(source.row.checksum!==state.checksum)throw new AppError('복원 원본이 변경되었습니다.','BACKUP_INTEGRITY');
      if(job.kind==='restore'&&source.row.restored_class_id){const result={classId:source.row.restored_class_id,reused:true};await env.DB.prepare("UPDATE backup_jobs SET status='done',lease_until=0,state=? WHERE id=? AND lease_until=?").bind(JSON.stringify({...state,result}),id,lease).run();return jobResult({...job,status:'done'},result);}
      pack=source.pack;
    }
    const maps=new Map(state.maps||[]),target=f=>job.kind==='backup'?`backups/${session.user_id}/${id}/${f.id}`:`restored/${state.classId}/${maps.get(f.id)}`;
    const end=Math.min(job.cursor+3,pack.files.length);
    for(let i=job.cursor;i<end;i++){
      const file=pack.files[i],key=target(file);
      if(job.status==='cleaning'){if(job.kind!=='verify')await env.FILES.delete(key);continue;}
      if(job.kind==='verify'){const f=await env.FILES.head(file.backup_key);if(!f||f.etag!==file.backup_etag||f.size!==file.size)throw new AppError('보관 첨부가 누락되거나 변경되었습니다.','BACKUP_INTEGRITY');continue;}
      const source=await env.FILES.get(job.kind==='backup'?file.r2_key:file.backup_key);
      if(!source?.body||source.size!==file.size||(job.kind==='restore'&&source.etag!==file.backup_etag))throw new AppError('첨부 원본이 누락되거나 변경되었습니다. 파일을 확인한 뒤 이어가세요.','BACKUP_INTEGRITY');
      const written=await env.FILES.put(key,source.body);
      if(!written||written.etag!==source.etag||written.size!==source.size)throw new AppError('첨부 복사 검증 실패. 다시 이어갈 수 있습니다.','BACKUP_INTEGRITY');
      if(job.kind==='backup')state.etags[i]=written.etag;
    }
    if(end<pack.files.length){
      await env.DB.prepare("UPDATE backup_jobs SET cursor=?,state=?,lease_until=0,error='' WHERE id=? AND lease_until=?").bind(end,JSON.stringify(state),id,lease).run();return jobResult({...job,cursor:end});
    }
    if(job.status==='cleaning'){
      if(job.kind==='backup'){await env.FILES.delete(`backups/${session.user_id}/${id}/manifest.json`);await env.FILES.delete(state.packKey);await env.DB.prepare('UPDATE class_operations SET lease_until=0,next_backup=? WHERE class_id=? AND teacher_id=?').bind(Date.now()+7*86400000,job.class_id,session.user_id).run();}
      await env.DB.prepare('DELETE FROM backup_jobs WHERE id=? AND lease_until=?').bind(id,lease).run();return jobResult({...job,status:'cancelled',cursor:end});
    }
    let result;
    if(job.kind==='verify'){result={verified:true,files:pack.files.length};await env.DB.prepare("UPDATE backup_jobs SET status='done',cursor=?,state=?,lease_until=0,error='' WHERE id=? AND lease_until=?").bind(end,JSON.stringify({...state,result}),id,lease).run();return jobResult({...job,status:'done',cursor:end},result);}
    if(job.kind==='backup'){
      const current=await ownedClass(env,session,job.class_id);if(Number(current.version)!==Number(state.sourceVersion))throw new AppError('보관 도중 클래스가 바뀌었습니다. 진행본 정리 후 새로 시작해 주세요.','BACKUP_CHANGED',409);
      pack.files=pack.files.map((f,i)=>({...f,backup_key:target(f),backup_etag:state.etags[i]}));
      const text=JSON.stringify(pack),checksum=await sha256(text),key=`backups/${session.user_id}/${id}/manifest.json`;
      await env.FILES.put(key,text,{httpMetadata:{contentType:'application/json'}});const check=await env.FILES.get(key);
      if(!check||await sha256(await check.text())!==checksum)throw new AppError('완성 보관본 재읽기 검사 실패','BACKUP_INTEGRITY');
      result={id,verified:true,files:pack.files.length};state.result=result;
      commitAttempted=true;
      await env.DB.batch([
        env.DB.prepare('INSERT INTO class_backups(id,teacher_id,class_id,created_at,r2_key,checksum,bytes) VALUES(?,?,?,?,?,?,?)').bind(id,session.user_id,job.class_id,pack.createdAt,key,checksum,pack.files.reduce((n,f)=>n+f.size,0)+new TextEncoder().encode(text).length),
        env.DB.prepare("UPDATE class_operations SET last_backup=?,last_error='',lease_until=0,next_backup=? WHERE class_id=? AND teacher_id=?").bind(pack.createdAt,Date.now()+7*86400000,job.class_id,session.user_id),
        env.DB.prepare("UPDATE backup_jobs SET status='done',cursor=?,state=?,lease_until=0,error='' WHERE id=? AND lease_until=?").bind(end,JSON.stringify(state),id,lease)
      ]);
      // Complete snapshot is durable; removal failure of temporary metadata does not fail the backup.
      try{await env.FILES.delete(state.packKey);}catch{}
    }else{
      // Keep the last copy checkpoint before atomic DB restoration, so a lost response is retryable.
      await env.DB.prepare('UPDATE backup_jobs SET cursor=?,state=? WHERE id=? AND lease_until=?').bind(end,JSON.stringify(state),id,lease).run();
      commitAttempted=true;result=await restoreClassBackup(env,session,{backupId:state.backupId,name:state.name},state);
      await env.DB.prepare("UPDATE backup_jobs SET status='done',lease_until=0,error='',state=? WHERE id=? AND lease_until=?").bind(JSON.stringify({...state,result}),id,lease).run();
    }
    invalidateFileStorageStatus();return jobResult({...job,status:'done',cursor:end},result);
  }catch(e){
    // Never delete copies after an uncertain commit. A retry reconciles the committed backup/restore.
    if(commitAttempted&&job.kind==='backup'){
      const saved=await env.DB.prepare('SELECT id FROM class_backups WHERE id=? AND teacher_id=?').bind(id,session.user_id).first();
      if(saved){await env.DB.prepare("UPDATE backup_jobs SET status='done',lease_until=0,error='' WHERE id=?").bind(id).run();return jobResult({...job,status:'done',cursor:job.total},{id,verified:true});}
    }
    await env.DB.prepare('UPDATE backup_jobs SET error=?,lease_until=0 WHERE id=? AND lease_until=?').bind(String(e.message).slice(0,300),id,lease).run();throw e;
  }
}

// Short-lived per-owner request coalescing; events are never persisted to D1.
const calendarReadCache=new Map();
function invalidateCalendarCache(owner){for(const [key,row] of calendarReadCache)if(row.owner===owner)calendarReadCache.delete(key);}
async function cachedCalendarEvents(env,owner,path){
 const key=owner+'|'+path,cached=calendarReadCache.get(key);if(cached&&cached.expires>Date.now())return cached.promise;
 if(calendarReadCache.size>=40)calendarReadCache.delete(calendarReadCache.keys().next().value);
 const row={owner,expires:Date.now()+15000};row.promise=googleRequest(env,owner,path).catch(e=>{if(calendarReadCache.get(key)===row)calendarReadCache.delete(key);throw e;});calendarReadCache.set(key,row);return row.promise;
}
