// Fetches per-aircraft enrichment (registration, type, operator) from the free
// adsbdb API, keyed by the ICAO 24-bit address. Results are cached so each
// aircraft is only looked up once, and failed/unassigned addresses are cached
// too so they aren't re-fetched on every update.

const cache = new Map();
const inflight = new Map();

const FAILED = { failed: true, registration: null, type: null, operator: null, photo: null };

function shape(ac) {
  if (!ac) return FAILED;
  const type = ac.type ? (ac.manufacturer ? `${ac.manufacturer} ${ac.type}` : ac.type) : ac.icao_type || null;
  const operator = ac.airline?.name || ac.operator?.name || ac.registered_owner || null;
  const photo = ac.url_photo_thumbnail || ac.url_photo || null;
  return { failed: false, registration: ac.registration || null, type, operator, photo };
}

// Cached value (sync) for rendering; undefined if not known yet.
export function getCachedAircraftInfo(icao) {
  if (!icao) return undefined;
  return cache.get(String(icao).toLowerCase());
}

// Return a promise with the aircraft info, fetching (and caching) if needed.
export function getAircraftInfo(icao) {
  const key = String(icao || '').toLowerCase();
  if (!key) return Promise.resolve(FAILED);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    let info = FAILED;
    try {
      const res = await fetch(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`);
      if (res.ok) {
        const data = await res.json();
        info = shape(data?.response?.aircraft);
      }
    } catch {
      info = FAILED;
    } finally {
      inflight.delete(key);
    }
    cache.set(key, info);
    return info;
  })();

  inflight.set(key, p);
  return p;
}

// --- Live position fallback (OpenSky Network, keyless) -----------------------
// When our own receiver hasn't decoded a position for an aircraft, fill it in
// from the crowdsourced OpenSky network so the table has no empty lat/lon and
// the map can plot it. Cached per ICAO; missing entries are cached too (as
// null) so we don't re-query every update.

const posCache = new Map();
const posPending = new Map();

export function getCachedPosition(icao) {
  if (!icao) return undefined;
  const key = String(icao).toLowerCase();
  return posCache.has(key) ? posCache.get(key) : undefined;
}

export function getAircraftPosition(icao) {
  const key = String(icao || '').toLowerCase();
  if (!key) return Promise.resolve(null);
  if (posCache.has(key)) return Promise.resolve(posCache.get(key));
  if (posPending.has(key)) return posPending.get(key);

  const p = (async () => {
    let pos = null;
    try {
      const res = await fetch(`https://opensky-network.org/api/states/all?icao24=${encodeURIComponent(key)}`);
      if (res.ok) {
        const data = await res.json();
        // States: [icao24, callsign, origin, tPos, last, lon(5), lat(6),
        //          baroAlt(7), onGround(8), vel(9), track(10), vert(11), ...]
        const state = (data?.states || []).find((s) => s[5] != null && s[6] != null);
        if (state) {
          pos = {
            lon: state[5],
            lat: state[6],
            onGround: Boolean(state[8]),
          };
        }
      }
    } catch {
      pos = null;
    } finally {
      posPending.delete(key);
    }
    posCache.set(key, pos);
    return pos;
  })();

  posPending.set(key, p);
  return p;
}
