import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_COOKIE = 'sdr_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const DEFAULT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'users.json'
);

// Users + hashed passwords live in a JSON file (env USERS_FILE to relocate).
let usersCache = null;
let overrideFile = null; // test helper

const usersFile = () => overrideFile || process.env.USERS_FILE || DEFAULT_FILE;

// The signing secret is kept next to the users file so sessions survive
// restarts (point USERS_FILE at the mounted volume in Docker).
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(path.dirname(usersFile()), 'session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* generate below */
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();

function loadUsers() {
  if (usersCache) return usersCache;
  try {
    usersCache = JSON.parse(fs.readFileSync(usersFile(), 'utf8'));
  } catch {
    /* first run / missing file: start empty */
  }
  if (!usersCache || typeof usersCache !== 'object') usersCache = {};
  return usersCache;
}

function persistUsers() {
  const file = usersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(usersCache, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const a = Buffer.from(crypto.scryptSync(password, salt, 64).toString('hex'), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function signToken(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(expect);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.u !== 'string' || typeof data.exp !== 'number') return null;
    if (data.exp < Date.now()) return null;
    if (!loadUsers()[data.u]) return null;
    return data.u;
  } catch {
    return null;
  }
}

export function registerUser(username, password) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(name)) {
    return { error: 'Username must be 3-32 chars (letters, digits, . _ -)' };
  }
  if (typeof password !== 'string' || password.length < 6) {
    return { error: 'Password must be at least 6 characters' };
  }
  const users = loadUsers();
  if (users[name]) return { error: 'Username already taken' };
  const { salt, hash } = hashPassword(password);
  users[name] = { salt, hash, created: Date.now() };
  persistUsers();
  return { ok: true, username: name, token: signToken(name) };
}

export function loginUser(username, password) {
  const name = String(username || '').trim().toLowerCase();
  const users = loadUsers();
  const rec = users[name];
  if (!rec) return { error: 'Invalid username or password' };
  if (!verifyPassword(String(password || ''), rec.salt, rec.hash)) {
    return { error: 'Invalid username or password' };
  }
  return { ok: true, username: name, token: signToken(name) };
}

export function sessionUser(token) {
  return verifyToken(token);
}

export function cookieUser(req) {
  const hdr = req.headers.cookie || '';
  const parts = hdr
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  if (!parts) return null;
  return verifyToken(parts.slice(SESSION_COOKIE.length + 1));
}

export function getSessionSecret() {
  return SECRET;
}

export function setUsersFileForTests(file) {
  overrideFile = file;
  usersCache = null;
}

export { SESSION_COOKIE, SESSION_TTL_MS };
