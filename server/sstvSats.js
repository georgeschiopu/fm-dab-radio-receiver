// Satellite data for the "SSTV Sats" mode.
//
// The satellite list is derived from the db.satnogs.org API: every transmitter
// whose downlink mode is SSTV (mode id 5). Names/mission metadata come from the
// DB satellite catalogue and the TLEs from the DB TLE endpoint, with Celestrak
// as a backup. Orbits are propagated locally on the client with SGP4, so the
// tracker needs no API key. If SatNOGS is unreachable the baked-in snapshot in
// sstvSatsFallback.js is served instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSTV_FALLBACK } from './sstvSatsFallback.js';

export const SSTV_MODE_ID = 5;
export const DB_BASE = 'https://db.satnogs.org/api';
export const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';

// The satellite list changes slowly; 6 h is plenty. TLEs are refreshed by the
// providers a few times a day, so a 12 h TTL catches essentially every update
// while keeping upstream traffic to ~2 fetches/day per satellite. The full TLE
// index (a large catalogue download) is cached and persisted for the same 12 h.
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const TLE_TTL_MS = 12 * 60 * 60 * 1000;
const TLE_INDEX_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const TLE_INDEX_THRESHOLD = 8;

const DEFAULT_CACHE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'sstv-tle-cache.json'
);

const USER_AGENT = 'fm-dab-radio-receiver';

// TLE line 0 is "0 ISS (ZARYA)"; strip the leading designator to get the name.
function nameFromTle0(tle0) {
  return String(tle0 || '')
    .replace(/^0\s+/, '')
    .trim();
}

// Build the SSTV satellite list from SatNOGS transmitters plus optional
// satellite metadata (name/country/status). Pure and order-independent so it can
// be unit-tested without the network.
export function parseSstvSatellites(transmitters, satByNorad = new Map()) {
  const byNorad = new Map();
  for (const t of transmitters || []) {
    const norad = Number(t.norad_cat_id);
    if (!Number.isFinite(norad) || norad <= 0) continue;
    if (!byNorad.has(norad)) {
      const meta = satByNorad.get(norad) || {};
      byNorad.set(norad, {
        norad,
        name: meta.name || meta.names || `NORAD ${norad}`,
        countries: meta.countries || '',
        status: meta.status || 'unknown',
        active: false,
        freqs: [],
      });
    }
    const entry = byNorad.get(norad);
    const down = Number(t.downlink_low);
    if (Number.isFinite(down) && down > 0) {
      entry.freqs.push({
        down,
        desc: t.description || '',
        status: t.status || 'unknown',
        alive: !!t.alive,
      });
    }
  }

  const list = [...byNorad.values()];
  for (const s of list) {
    // Collapse duplicate downlinks (same frequency listed with several modes).
    const seen = new Map();
    for (const f of s.freqs) {
      const prev = seen.get(f.down);
      if (!prev) seen.set(f.down, { ...f });
      else if (f.status === 'active' || f.alive) Object.assign(prev, f);
    }
    s.freqs = [...seen.values()].sort((a, b) => a.down - b.down);
    s.active = s.freqs.some((f) => f.status === 'active' || f.alive);
    if (!s.name || s.name.startsWith('NORAD ')) {
      const fb = SSTV_FALLBACK.find((f) => f.norad === s.norad);
      if (fb) {
        s.name = fb.name;
        s.countries = s.countries || fb.countries;
      }
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

// Normalise a SatNOGS TLE record into the shape the client consumes.
export function parseTleEntry(entry) {
  if (!entry || !entry.tle1 || !entry.tle2) return null;
  return {
    norad: Number(entry.norad_cat_id),
    name: nameFromTle0(entry.tle0),
    tle0: entry.tle0 || `0 ${nameFromTle0(entry.tle0)}`,
    tle1: String(entry.tle1).trim(),
    tle2: String(entry.tle2).trim(),
  };
}

// Parse a Celestrak GP response (either "name\n1 …\n2 …" or just the two lines).
export function parseCelestrakTle(norad, text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  let name = '';
  let l1;
  let l2;
  if (lines.length >= 3 && !lines[0].startsWith('1 ')) {
    [name, l1, l2] = lines;
  } else if (lines.length >= 2) {
    [l1, l2] = lines;
  }
  if (!l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) return null;
  return { norad: Number(norad), name, tle0: `0 ${name}`, tle1: l1, tle2: l2 };
}

// Talks to the SatNOGS DB (and Celestrak) with in-memory caching so the client
// can keep the tracked satellites fresh without hammering the upstream APIs.
export class SstvCatalog {
  constructor({
    fetchImpl,
    now = () => Date.now(),
    listTtlMs = LIST_TTL_MS,
    tleTtlMs = TLE_TTL_MS,
    tleIndexTtlMs = TLE_INDEX_TTL_MS,
    cacheFile = null,
  } = {}) {
    this.fetch = fetchImpl || globalThis.fetch;
    this.now = now;
    this.listTtlMs = listTtlMs;
    this.tleTtlMs = tleTtlMs;
    this.tleIndexTtlMs = tleIndexTtlMs;
    this.cacheFile = cacheFile;
    this._list = null;
    this._listAt = 0;
    this._tleIndex = null;
    this._tleIndexAt = 0;
    this._tles = new Map();
    this._loadCache();
  }

  // TLEs are persisted to disk so a container restart (or server reboot) reuses
  // them instead of re-downloading every satellite's orbital elements. The
  // `at` timestamps travel with the data, so the TTL still applies on reload.
  _loadCache() {
    if (!this.cacheFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const [norad, entry] of Object.entries(raw.tles || {})) {
        if (entry && entry.data && Number.isFinite(entry.at)) {
          this._tles.set(Number(norad), entry);
        }
      }
      if (raw.index && raw.index.entries && Number.isFinite(raw.index.at)) {
        this._tleIndex = new Map(
          Object.entries(raw.index.entries).map(([n, e]) => [Number(n), e])
        );
        this._tleIndexAt = raw.index.at;
      }
    } catch {
      /* no cache yet / unreadable: start empty */
    }
  }

  _saveCache() {
    if (!this.cacheFile) return;
    try {
      const tles = {};
      for (const [norad, entry] of this._tles) tles[norad] = entry;
      const payload = {
        tles,
        index:
          this._tleIndex && this._tleIndexAt
            ? { entries: Object.fromEntries(this._tleIndex), at: this._tleIndexAt }
            : null,
      };
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(payload));
    } catch {
      /* caching is best-effort; never fail a request over it */
    }
  }

  async fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'text/plain', 'User-Agent': USER_AGENT },
      });
      if (!res.ok) return null;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  // Follow DRF pagination if the endpoint returns {results, next}; a plain array
  // is returned as-is (the SatNOGS DB currently returns unpaginated lists).
  async fetchCollection(url) {
    const out = [];
    let next = url;
    let guard = 0;
    while (next && guard++ < 50) {
      const data = await this.fetchJson(next);
      if (Array.isArray(data)) {
        out.push(...data);
        break;
      }
      out.push(...(data.results || []));
      next = data.next || null;
    }
    return out;
  }

  async getSatellites({ force = false } = {}) {
    const fresh = this._list && this.now() - this._listAt < this.listTtlMs;
    if (fresh && !force) return this._list;
    try {
      const transmitters = await this.fetchCollection(
        `${DB_BASE}/transmitters/?format=json&mode=${SSTV_MODE_ID}`
      );
      let satByNorad = new Map();
      try {
        const sats = await this.fetchCollection(`${DB_BASE}/satellites/?format=json`);
        satByNorad = new Map(sats.map((s) => [Number(s.norad_cat_id), s]));
      } catch {
        // Names can still be recovered from the fallback snapshot.
      }
      const list = parseSstvSatellites(transmitters, satByNorad);
      if (!list.length) throw new Error('no SSTV satellites returned');
      this._list = list;
      this._listAt = this.now();
      return list;
    } catch (err) {
      // Always-stale cache so the next request retries the live API.
      this._list = SSTV_FALLBACK.map((s) => ({
        ...s,
        freqs: s.freqs.map((f) => ({ ...f })),
      }));
      this._listAt = 0;
      this._lastListError = err;
      return this._list;
    }
  }

  async ensureTleIndex() {
    if (this._tleIndex && this.now() - this._tleIndexAt < this.tleIndexTtlMs) {
      return this._tleIndex;
    }
    const entries = await this.fetchCollection(`${DB_BASE}/tle/?format=json`);
    const index = new Map();
    for (const e of entries) {
      const parsed = parseTleEntry(e);
      if (parsed) index.set(parsed.norad, parsed);
    }
    this._tleIndex = index;
    this._tleIndexAt = this.now();
    this._saveCache();
    return index;
  }

  async fetchSingleTle(norad) {
    try {
      const data = await this.fetchCollection(
        `${DB_BASE}/tle/?format=json&norad_cat_id=${norad}`
      );
      const parsed = parseTleEntry(data[0]);
      if (parsed) return parsed;
    } catch {
      /* fall through to Celestrak */
    }
    try {
      const text = await this.fetchText(`${CELESTRAK_BASE}?CATNR=${norad}&FORMAT=TLE`);
      return parseCelestrakTle(norad, text);
    } catch {
      return null;
    }
  }

  async getTles(norads) {
    const want = [
      ...new Set(
        (norads || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
      ),
    ];
    const out = {};
    const missing = [];
    for (const n of want) {
      const cached = this._tles.get(n);
      if (cached && this.now() - cached.at < this.tleTtlMs) out[n] = cached.data;
      else missing.push(n);
    }
    if (!missing.length) return out;

    let index = null;
    if (missing.length > TLE_INDEX_THRESHOLD) {
      try {
        index = await this.ensureTleIndex();
      } catch {
        index = null;
      }
    }

    let learned = false;
    for (const n of missing) {
      let entry = index ? index.get(n) : null;
      if (!entry) entry = await this.fetchSingleTle(n);
      if (entry) {
        this._tles.set(n, { data: entry, at: this.now() });
        out[n] = entry;
        learned = true;
      }
    }
    if (learned) this._saveCache();
    return out;
  }
}

export const sstvCatalog = new SstvCatalog({
  cacheFile: process.env.SSTV_CACHE_FILE || DEFAULT_CACHE_FILE,
});
