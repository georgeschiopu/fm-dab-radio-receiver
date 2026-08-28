import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionSecret } from './auth.js';

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'user-settings.json');
let cache = null;
let overrideFile = null;

const settingsFile = () => overrideFile || process.env.USER_SETTINGS_FILE || DEFAULT_FILE;
const encryptionKey = () => crypto.createHash('sha256').update(getSessionSecret()).digest();

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    cache = {};
  }
  if (!cache || typeof cache !== 'object') cache = {};
  return cache;
}

function persist() {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decrypt(value) {
  const [version, ivText, tagText, dataText] = String(value || '').split(':');
  if (version !== 'v1' || !ivText || !tagText || !dataText) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function getMeshtasticSettings(user) {
  const record = load()[user];
  const key = record?.meshtasticKey ? decrypt(record.meshtasticKey) : null;
  return {
    key: key || 'default',
    keyMode: key && key !== 'default' ? 'custom' : 'default',
    hasCustomKey: Boolean(key && key !== 'default'),
  };
}

export function setMeshtasticSettings(user, rawKey) {
  const key = String(rawKey || 'default').trim() || 'default';
  if (!load()[user] || typeof load()[user] !== 'object') load()[user] = {};
  load()[user].meshtasticKey = encrypt(key);
  persist();
  return { keyMode: key === 'default' ? 'default' : 'custom', hasCustomKey: key !== 'default' };
}

export function setUserSettingsFileForTests(file) {
  overrideFile = file;
  cache = null;
}
