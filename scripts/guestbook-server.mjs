import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(crypto.scrypt);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.data');
const DB_PATH = path.join(DATA_DIR, 'guestbook.sqlite');
const OWNER_KEY_PATH = path.join(DATA_DIR, 'owner-key.txt');
const PORT = Number(process.env.GUESTBOOK_PORT || 4185);
const HOST = process.env.GUESTBOOK_HOST || '127.0.0.1';
const SESSION_COOKIE = 'rippleshe_guest';
const SESSION_DAYS = 30;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const REGISTRATION_OPEN = !IS_PRODUCTION || process.env.GUESTBOOK_REGISTRATION_OPEN === '1';
const WRITING_OPEN = !IS_PRODUCTION || process.env.GUESTBOOK_WRITING_OPEN === '1';
const TRUST_PROXY = process.env.GUESTBOOK_TRUST_PROXY === '1';
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  ...(process.env.GUESTBOOK_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean),
]);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    nickname TEXT NOT NULL,
    greeting TEXT NOT NULL DEFAULT '',
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`);

function loadOwnerKey() {
  if (process.env.RIPPLESHE_OWNER_KEY?.trim()) return process.env.RIPPLESHE_OWNER_KEY.trim();
  if (fs.existsSync(OWNER_KEY_PATH)) return fs.readFileSync(OWNER_KEY_PATH, 'utf8').trim();
  const key = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(OWNER_KEY_PATH, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`\n[来客簿] 已生成新的主人钥匙，并仅保存到 ${OWNER_KEY_PATH}\n`);
  return key;
}
const OWNER_KEY = loadOwnerKey();

const rates = new Map();
const rateSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, state] of rates) if (state.resetAt <= now) rates.delete(key);
}, 15 * 60_000);
rateSweep.unref();
function allowRate(key, limit, windowMs) {
  const now = Date.now();
  const state = rates.get(key);
  if (!state || state.resetAt <= now) {
    rates.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (state.count >= limit) return false;
  state.count += 1;
  return true;
}

function nowIso() { return new Date().toISOString(); }
function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...extraHeaders,
  });
  res.end(body);
}
function parseCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    out[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return out;
}
function clientIp(req) {
  const source = TRUST_PROXY ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : req.socket.remoteAddress;
  return String(source || 'unknown').split(',')[0].trim();
}
function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}
function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-headers', 'content-type, x-rippleshe-owner');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  if (IS_PRODUCTION) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}
async function readJson(req, max = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('内容太长了'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('内容没有写好'), { status: 400 }); }
}
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function cleanLine(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanMessage(value) { return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, 600); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function validUsername(value) { return /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{1,23}$/u.test(value); }

async function passwordDigest(password, salt) {
  return Buffer.from(await scrypt(password, salt, 64)).toString('base64url');
}
async function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return { salt, hash: await passwordDigest(password, salt) };
}
async function verifyPassword(password, salt, expected) {
  const actual = Buffer.from(await passwordDigest(password, salt));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('base64url'); }
function sessionCookie(token, maxAgeSeconds) {
  const secure = (IS_PRODUCTION || process.env.GUESTBOOK_SECURE_COOKIE === '1') ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
function createSession(userId) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(tokenHash(token), userId, createdAt, expiresAt);
  return token;
}
function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id,u.email,u.username,u.nickname,u.greeting,u.created_at,u.status
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'
  `).get(tokenHash(token), nowIso());
  if (!row) return null;
  db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(nowIso(), row.id);
  return row;
}
function publicUser(row) {
  return { id: row.id, username: row.username, nickname: row.nickname, greeting: row.greeting || '' };
}
function ownerAuthorized(req) {
  const supplied = String(req.headers['x-rippleshe-owner'] || '');
  if (!supplied || supplied.length !== OWNER_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(OWNER_KEY));
}
function messageRows(limit = 80) {
  return db.prepare(`
    SELECT m.id,m.body,m.created_at,u.username,u.nickname,u.greeting
    FROM messages m JOIN users u ON u.id=m.user_id
    WHERE m.deleted_at IS NULL AND u.status='active'
    ORDER BY m.created_at DESC LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 80, 1), 120));
}
function publicStats() {
  const visitors = db.prepare("SELECT COUNT(*) AS n FROM users WHERE status='active'").get().n;
  const messages = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL').get().n;
  return { visitors, messages };
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (!originAllowed(req) && ['POST','DELETE','PUT','PATCH','OPTIONS'].includes(req.method || '')) return json(res, 403, { error: '这次敲门的来路没有对上。' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const ip = clientIp(req);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { registration_open: REGISTRATION_OPEN, writing_open: WRITING_OPEN });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = currentUser(req);
      return json(res, 200, { user: user ? publicUser(user) : null });
    }

    if (req.method === 'GET' && url.pathname === '/api/messages') {
      return json(res, 200, { messages: messageRows(url.searchParams.get('limit')), stats: publicStats() });
    }

    if (req.method === 'POST' && url.pathname === '/api/register') {
      if (!REGISTRATION_OPEN) return json(res, 503, { error: '来客登记还没有正式开放。' });
      if (!allowRate(`register:${ip}`, 5, 60 * 60_000)) return json(res, 429, { error: '今天敲门的次数有点多，过一会儿再来。' });
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const username = cleanLine(body.username, 24);
      const nickname = cleanLine(body.nickname, 30);
      const greeting = cleanLine(body.greeting, 80);
      const password = String(body.password || '');
      if (!validEmail(email)) return json(res, 400, { error: '这个邮箱看起来还没有写完整。' });
      if (!validUsername(username)) return json(res, 400, { error: '用户名用 2–24 个中英文、数字、点、横线或下划线就好。' });
      if (!nickname) return json(res, 400, { error: '留一个想被怎样称呼的名字吧。' });
      if (password.length < 8 || password.length > 128) return json(res, 400, { error: '密码至少 8 个字符。' });
      const exists = db.prepare('SELECT email,username FROM users WHERE email=? OR username=?').all(email, username);
      if (exists.some((row) => String(row.email).toLowerCase() === email)) return json(res, 409, { error: '这个邮箱已经来过了，直接登录就好。' });
      if (exists.some((row) => String(row.username).toLowerCase() === username.toLowerCase())) return json(res, 409, { error: '这个用户名已经有人拾走了，换一个吧。' });
      const { salt, hash } = await makePassword(password);
      const createdAt = nowIso();
      const result = db.prepare(`INSERT INTO users(email,username,nickname,greeting,password_salt,password_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(email, username, nickname, greeting, salt, hash, createdAt, createdAt);
      const userId = Number(result.lastInsertRowid);
      const token = createSession(userId);
      return json(res, 201, { user: { id: userId, username, nickname, greeting } }, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!allowRate(`login:${ip}`, 12, 15 * 60_000)) return json(res, 429, { error: '先歇一会儿，再试一次。' });
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const user = db.prepare('SELECT * FROM users WHERE email=? AND status=\'active\'').get(email);
      if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) return json(res, 401, { error: '邮箱或密码没有对上。' });
      const token = createSession(user.id);
      return json(res, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
      return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
    }

    if (req.method === 'POST' && url.pathname === '/api/messages') {
      if (!WRITING_OPEN) return json(res, 503, { error: '这会儿先只读水边旧字，还没有开放落笔。' });
      const user = currentUser(req);
      if (!user) return json(res, 401, { error: '先在来客簿里认个名字，再落笔。' });
      if (!allowRate(`message:${user.id}`, 6, 10 * 60_000)) return json(res, 429, { error: '墨迹还没干，过一会儿再写下一张。' });
      const body = await readJson(req);
      const message = cleanMessage(body.message);
      if (!message) return json(res, 400, { error: '这一页还是空的。' });
      if (message.length > 600) return json(res, 400, { error: '这一页写得太满了，留在 600 字以内吧。' });
      const createdAt = nowIso();
      const result = db.prepare('INSERT INTO messages(user_id,body,created_at) VALUES(?,?,?)').run(user.id, message, createdAt);
      return json(res, 201, { message: { id: Number(result.lastInsertRowid), body: message, created_at: createdAt, ...publicUser(user) } });
    }

    if (req.method === 'GET' && url.pathname === '/api/owner/visitors') {
      if (!ownerAuthorized(req)) return json(res, 403, { error: '这页只给主人看。' });
      const users = db.prepare(`
        SELECT u.id,u.email,u.username,u.nickname,u.greeting,u.created_at,u.last_seen_at,u.status,
          COUNT(m.id) AS message_count
        FROM users u LEFT JOIN messages m ON m.user_id=u.id AND m.deleted_at IS NULL
        GROUP BY u.id ORDER BY u.created_at DESC
      `).all();
      return json(res, 200, { users, stats: publicStats() });
    }

    if (req.method === 'GET' && url.pathname === '/api/owner/messages') {
      if (!ownerAuthorized(req)) return json(res, 403, { error: '这页只给主人看。' });
      const messages = db.prepare(`
        SELECT m.id,m.body,m.created_at,m.deleted_at,u.email,u.username,u.nickname
        FROM messages m JOIN users u ON u.id=m.user_id ORDER BY m.created_at DESC LIMIT 300
      `).all();
      return json(res, 200, { messages });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/owner/messages/')) {
      if (!ownerAuthorized(req)) return json(res, 403, { error: '这页只给主人看。' });
      const id = Number(url.pathname.split('/').pop());
      if (!Number.isInteger(id)) return json(res, 400, { error: '没有找到这一张。' });
      db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(nowIso(), id);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/owner/users/')) {
      if (!ownerAuthorized(req)) return json(res, 403, { error: '这页只给主人看。' });
      const id = Number(url.pathname.split('/').pop());
      if (!Number.isInteger(id)) return json(res, 400, { error: '没有找到这位来客。' });
      db.prepare('DELETE FROM users WHERE id=?').run(id);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: '这里没有这一页。' });
  } catch (error) {
    console.error('[来客簿]', error);
    return json(res, error.status || 500, { error: error.status ? error.message : '水面起了一点波纹，稍后再试。' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`来客簿  http://${HOST}:${PORT}`);
});

function shutdown() {
  try { server.close(); } catch {}
  try { db.close(); } catch {}
}
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
