import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODES = ['fm', 'nfm', 'am', 'dab'];
const DEFAULT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'presets.json'
);

// Saved stations live in a JSON file on the server so every client (on any
// computer) sees the same list. Point PRESETS_FILE at a mounted volume to keep
// them across container rebuilds.
let cache = null;
let overrideFile = null; // test helper

const presetsFile = () => overrideFile || process.env.PRESETS_FILE || DEFAULT_FILE;
const empty = () => Object.fromEntries(MODES.map((m) => [m, []]));

function cleanPreset(p, mode) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string') return null;
  const name = String(p.name).trim();
  if (!name) return null;
  return {
    name: name.slice(0, 80),
    freq: String(p.freq ?? ''),
    mode,
    service: p.service ? String(p.service).slice(0, 80) : undefined,
  };
}

function load() {
  if (cache) return cache;
  const out = empty();
  try {
    const raw = JSON.parse(fs.readFileSync(presetsFile(), 'utf8'));
    for (const m of MODES) {
      if (!Array.isArray(raw[m])) continue;
      out[m] = raw[m].map((p) => cleanPreset(p, m)).filter(Boolean);
    }
  } catch {
    /* first run / missing file: start empty */
  }
  cache = out;
  return cache;
}

function persist() {
  const file = presetsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
}

export function getPresets(mode) {
  const m = MODES.includes(mode) ? mode : 'fm';
  return load()[m];
}

export function setPresets(mode, list) {
  const m = MODES.includes(mode) ? mode : 'fm';
  const cleaned = (Array.isArray(list) ? list : [])
    .map((p) => cleanPreset(p, m))
    .filter(Boolean);
  load()[m] = cleaned;
  persist();
  return cleaned;
}

export function setPresetsFileForTests(file) {
  overrideFile = file;
  cache = null;
}
