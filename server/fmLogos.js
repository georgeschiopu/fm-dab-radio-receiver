import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Lazy radio-station logo lookup for non-DAB (FM/NFM/AM) presets.
//
// Sources (in order, all free / no API key):
//   1. radio-browser.info community station database (name + frequency search)
//   2. Google favicon service for the station homepage when radio-browser has
//      no favicon of its own
//
// Results are downloaded into server/logos/fm/ and cached in map.json so the
// network is only hit once per station. Negative results are remembered too and
// only retried after NEGATIVE_TTL_MS, so unknown stations don't cause a lookup
// on every request. Lookups are concurrency-safe: parallel /api/presets calls
// for the same station share one in-flight request.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGOS_DIR = path.join(__dirname, 'logos');
const FM_DIR = path.join(LOGOS_DIR, 'fm');
const MAP_FILE = path.join(FM_DIR, 'map.json');
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'sdr-fm-receiver/1.0 (personal radio receiver; station logo lookup)';
const RB_BASE = 'https://de1.api.radio-browser.info/json';
const GOOGLE_FAVICON = 'https://www.google.com/s2/favicons?domain=';

let map = { entries: {} };
try {
  map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
} catch {
  /* first run / missing file */
}
const mem = new Map();
const inflight = new Map();
let persistTimer = null;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const cacheKey = (preset) => `${preset.mode}|${norm(preset.name)}|${preset.freq}`;

function slugFor(name, suffix = '') {
  const base = norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const tail = String(suffix || '').replace(/[^0-9.]/g, '').replace('.', '-');
  return `${base || 'station'}${tail ? `-${tail}` : ''}`;
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(FM_DIR, { recursive: true });
      fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
    } catch {
      /* cache is best-effort */
    }
  }, 1000);
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchRadioBrowser(name) {
  const qs = new URLSearchParams({ name, limit: '12' });
  const data = await fetchJson(`${RB_BASE}/stations/search?${qs}`);
  return Array.isArray(data) ? data : [];
}

const tokens = (s) => norm(s).split(/\W+/).filter(Boolean);

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 75;
  const at = new Set(tokens(a));
  const bt = tokens(b);
  if (!at.size) return 0;
  let hits = 0;
  for (const t of bt) if (at.has(t)) hits++;
  return (hits / Math.max(at.size, bt.length)) * 100;
}

function scoreCandidate(preset, cand) {
  const sn = norm(preset.name);
  const cn = norm(cand.name);
  let s = nameSimilarity(sn, cn);
  if (cand.countrycode === 'GB') s += 15;
  const freq = norm(preset.freq);
  if (freq && cn.includes(freq)) s += 20;
  if (cand.favicon) s += 5;
  return s;
}

async function downloadTo(url, destBase) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null; // error page / stub
    const byType = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
    };
    let ext = byType[type];
    if (!ext) {
      try {
        ext = path.extname(new URL(url).pathname).replace(/^\./, '') || 'png';
      } catch {
        ext = 'png';
      }
    }
    fs.mkdirSync(FM_DIR, { recursive: true });
    const file = `${destBase}.${ext}`;
    fs.writeFileSync(file, buf);
    return path.basename(file);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveLogo(preset) {
  const results = await searchRadioBrowser(preset.name);
  let best = null;
  let bestScore = 0;
  for (const cand of results) {
    const sc = scoreCandidate(preset, cand);
    if (sc > bestScore) {
      bestScore = sc;
      best = cand;
    }
  }

  let url = null;
  if (best && bestScore >= 40) {
    const base = path.join(FM_DIR, slugFor(preset.name, preset.freq));
    if (best.favicon) {
      const file = await downloadTo(best.favicon, base);
      if (file) url = `/logos/fm/${file}`;
    }
    if (!url && best.homepage) {
      try {
        const domain = new URL(best.homepage).hostname;
        const file = await downloadTo(`${GOOGLE_FAVICON}${encodeURIComponent(domain)}&sz=128`, base);
        if (file) url = `/logos/fm/${file}`;
      } catch {
        /* ignore */
      }
    }
  }

  const entry = { url, ts: Date.now() };
  mem.set(cacheKey(preset), entry);
  map.entries[cacheKey(preset)] = entry;
  persistSoon();
  return url;
}

export function presetLogo(preset, { prefer } = {}) {
  if (prefer) return Promise.resolve(prefer);
  if (!preset || !preset.name) return Promise.resolve(null);
  const k = cacheKey(preset);
  const cached = mem.get(k) || map.entries[k];
  if (cached) {
    if (cached.url) return Promise.resolve(cached.url);
    if (Date.now() - cached.ts < NEGATIVE_TTL_MS) return Promise.resolve(null);
  }
  if (inflight.has(k)) return inflight.get(k);
  const p = resolveLogo(preset).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
