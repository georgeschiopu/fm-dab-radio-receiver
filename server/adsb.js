// ADS-B / Mode S decoding helpers.
//
// dump1090 is spawned as a child process (see adsbReceiver.js) and emits
// SBS-1 / BaseStation text lines on a local TCP port. Each line is a
// comma-separated record; the `MSG` transmission types carry the fields we
// care about. This module parses those lines and keeps a rolling view of
// every aircraft seen, so the client can render a map + table without
// reimplementing CPR or Mode S decoding.

export const ADSB_DEFAULT_FREQ = 1_090_000_000;
export const ADSB_SAMPLE_RATE = 2_000_000;
export const ADSB_TTL_MS = 600_000; // drop aircraft not heard for this long (10 min)

// SBS-1 `MSG` line field indexes (0-based) once split on commas.
const F = {
  type: 1,
  icao: 4,
  callsign: 10,
  altitude: 11,
  groundspeed: 12,
  track: 13,
  lat: 14,
  lon: 15,
  verticalRate: 16,
  squawk: 17,
  alert: 18,
  emergency: 19,
  spi: 20,
  onGround: 21,
};

function num(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function hexId(value) {
  if (!value) return undefined;
  const v = String(value).trim();
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return undefined;
  return v.toLowerCase();
}

// Parse a single SBS-1 line into a partial aircraft update (only fields that
// were present on this line are returned), or null if it is not a usable line.
export function parseSbsLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  const parts = text.split(',');
  if (parts[0] !== 'MSG') return null;
  const type = num(parts[F.type]);
  const icao = hexId(parts[F.icao]);
  if (!icao || type === undefined) return null;
  const update = { icao };
  if (type === 1) {
    const callsign = (parts[F.callsign] || '').trim();
    if (callsign) update.callsign = callsign;
  } else if (type === 3 || type === 5) {
    const alt = num(parts[F.altitude]);
    if (alt !== undefined) update.altitude = alt;
    if (type === 3) {
      const lat = num(parts[F.lat]);
      const lon = num(parts[F.lon]);
      if (lat !== undefined && lon !== undefined) {
        update.lat = lat;
        update.lon = lon;
      }
      const vr = num(parts[F.verticalRate]);
      if (vr !== undefined) update.verticalRate = vr;
    }
  } else if (type === 4) {
    const gs = num(parts[F.groundspeed]);
    if (gs !== undefined) update.speed = gs;
    const track = num(parts[F.track]);
    if (track !== undefined) update.track = track;
    const vr = num(parts[F.verticalRate]);
    if (vr !== undefined) update.verticalRate = vr;
  }
  const squawk = (parts[F.squawk] || '').trim();
  if (squawk && /^[0-7]{1,4}$/.test(squawk)) update.squawk = squawk;
  const alert = (parts[F.alert] || '').trim();
  if (alert === '1') update.alert = true;
  const emergency = (parts[F.emergency] || '').trim();
  if (emergency === '1') update.emergency = true;
  const spi = (parts[F.spi] || '').trim();
  if (spi === '1') update.spi = true;
  const onGround = (parts[F.onGround] || '').trim();
  if (onGround === '1') update.onGround = true;
  else if (onGround === '0') update.onGround = false;
  return update;
}

// Rolling view of every aircraft heard recently. Feed it parsed updates; read
// snapshots for the client. Aircraft that have not been updated within
// ADSB_TTL_MS are automatically forgotten on the next snapshot/prune.
export class AdsbTracker {
  constructor(ttlMs = ADSB_TTL_MS) {
    this.ttlMs = ttlMs;
    this.aircraft = new Map();
  }

  update(partial) {
    if (!partial || !partial.icao) return null;
    const now = Date.now();
    const prev = this.aircraft.get(partial.icao) || { icao: partial.icao, added: now, seen: now };
    const next = { ...prev, ...partial, seen: now };
    this.aircraft.set(partial.icao, next);
    return next;
  }

  prune(now = Date.now()) {
    for (const [icao, a] of this.aircraft) {
      if (now - a.seen > this.ttlMs) this.aircraft.delete(icao);
    }
  }

  // Snapshot suitable for the WebSocket client: dropped `seen` internal
  // timestamp replaced with a coarse `age` (seconds since last message).
  snapshot(now = Date.now()) {
    this.prune(now);
    const out = [];
    for (const a of this.aircraft.values()) {
      const { seen, added, ...rest } = a;
      out.push({
        ...rest,
        age: Math.round((now - seen) / 1000),
        addedAge: Math.round((now - added) / 1000),
      });
    }
    out.sort((x, y) => (x.icao < y.icao ? -1 : x.icao > y.icao ? 1 : 0));
    return out;
  }

  count() {
    this.prune();
    return this.aircraft.size;
  }
}
