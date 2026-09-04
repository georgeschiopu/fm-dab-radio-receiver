import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODES = ['fm', 'nfm', 'am', 'dab', 'meshtastic'];
const DEFAULT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'presets.json'
);

// Saved stations live in a JSON file on the server so every client (on any
// computer) sees the same list. Keyed by username so each user has their own
// stations. Point PRESETS_FILE at a mounted volume to keep them across
// container rebuilds.
let cache = null;
let overrideFile = null; // test helper

const presetsFile = () => overrideFile || process.env.PRESETS_FILE || DEFAULT_FILE;
const empty = () => Object.fromEntries(MODES.map((m) => [m, []]));

function cleanPreset(p, mode) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string') return null;
  const name = String(p.name).trim();
  if (!name) return null;
  const demod = ['am', 'usb', 'lsb', 'cw'].includes(p.demod) ? p.demod : undefined;
  return {
    name: name.slice(0, 80),
    freq: String(p.freq ?? ''),
    mode,
    service: p.service ? String(p.service).slice(0, 80) : undefined,
    sid: p.sid ? String(p.sid).slice(0, 8) : undefined,
    demod: mode === 'am' ? demod : undefined,
  };
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(presetsFile(), 'utf8'));
    if (raw && typeof raw === 'object') cache = raw;
  } catch {
    /* first run / missing file: start empty */
  }
  if (!cache || typeof cache !== 'object') cache = {};
  return cache;
}

function userPresets(user) {
  const map = load();
  if (!map[user] || typeof map[user] !== 'object') map[user] = empty();
  for (const mode of MODES) {
    if (!Array.isArray(map[user][mode])) map[user][mode] = [];
  }
  return map[user];
}

function persist() {
  const file = presetsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
}

export function getPresets(user, mode) {
  const m = MODES.includes(mode) ? mode : 'fm';
  return userPresets(user)[m];
}

export function setPresets(user, mode, list) {
  const m = MODES.includes(mode) ? mode : 'fm';
  const cleaned = (Array.isArray(list) ? list : [])
    .map((p) => cleanPreset(p, m))
    .filter(Boolean);
  userPresets(user)[m] = cleaned;
  persist();
  return cleaned;
}

export function setPresetsFileForTests(file) {
  overrideFile = file;
  cache = null;
}
