// Local SGP4 orbit propagation for the SSTV Sats tracker.
//
// Lifted from the amsat-tracker project: TLEs are propagated in the browser with
// satellite.js so live positions, ground tracks, footprints and pass
// predictions need no server round-trips after the TLEs are fetched.
import satellite from './vendor/satellite.cjs';

export const EARTH_R = 6371.0; // mean Earth radius, km

export function satrecFromTle(tle) {
  if (!tle || !tle.tle1 || !tle.tle2) return null;
  try {
    return satellite.twoline2satrec(tle.tle1.trim(), tle.tle2.trim());
  } catch {
    return null;
  }
}

export function observerGd(location) {
  const lat = Number(location?.lat) || 0;
  const lng = Number(location?.lng) || 0;
  const alt = Number(location?.alt) || 0;
  return {
    latitude: satellite.degreesToRadians(lat),
    longitude: satellite.degreesToRadians(lng),
    height: alt / 1000, // km
  };
}

// Sub-satellite point + altitude for a given date.
export function propagateAt(satrec, date) {
  let pv;
  try {
    pv = satellite.propagate(satrec, date);
  } catch {
    return null;
  }
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(date);
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  return {
    lat: satellite.degreesLat(gd.latitude),
    lng: satellite.degreesLong(gd.longitude),
    altKm: gd.height,
    positionEci: pv.position,
    gmst,
  };
}

// Azimuth / elevation / range from the observer to the satellite.
export function lookAnglesAt(satrec, date, obs) {
  let pv;
  try {
    pv = satellite.propagate(satrec, date);
  } catch {
    return null;
  }
  if (!pv || !pv.position) return null;
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const la = satellite.ecfToLookAngles(obs, ecf);
  return {
    az: satellite.radiansToDegrees(la.azimuth),
    el: satellite.radiansToDegrees(la.elevation),
    range: la.rangeSat,
  };
}

// Radius on the ground of the region from which the satellite is visible above
// a minimum elevation.
export function footprintRadiusKm(altKm, minElDeg = 0) {
  if (!Number.isFinite(altKm)) return 0;
  const minEl = (minElDeg * Math.PI) / 180;
  const ratio = (EARTH_R / (EARTH_R + altKm)) * Math.cos(minEl);
  const central = Math.acos(Math.min(1, Math.max(-1, ratio))) - minEl;
  return EARTH_R * central;
}

// Ground track as [lat, lng] points between two epoch-ms values.
export function groundTrack(satrec, startMs, endMs, stepSec) {
  const pts = [];
  for (let t = startMs; t <= endMs; t += stepSec * 1000) {
    const p = propagateAt(satrec, new Date(t));
    if (p) pts.push([p.lat, p.lng]);
  }
  return pts;
}

// Split a track at the ±180° antimeridian so the map does not draw a
// wrap-around line across the whole world.
export function splitDateline(pts) {
  if (!pts || pts.length < 2) return pts && pts.length ? [pts] : [];
  const segs = [[pts[0]]];
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i][1] - pts[i - 1][1]) > 180) segs.push([]);
    segs[segs.length - 1].push(pts[i]);
  }
  return segs.filter((s) => s.length > 1);
}

// Predict passes over an observer for the next `days` days by scanning the
// elevation at a fixed step. Returns chronologically sorted passes, each with
// startUTC / maxUTC / endUTC (unix seconds) and maxEl (degrees).
export function predictPasses(
  satrec,
  obs,
  { fromMs = Date.now(), days = 5, minEl = 0, stepSec = 30 } = {}
) {
  const stepMs = Math.max(5, stepSec) * 1000;
  const endMs = fromMs + days * 86_400_000;
  const passes = [];
  let cur = null;
  let prevEl = null;
  let prevT = fromMs;

  for (let t = fromMs; t <= endMs; t += stepMs) {
    const la = lookAnglesAt(satrec, new Date(t), obs);
    if (!la) {
      prevEl = null;
      continue;
    }
    const el = la.el;
    if (prevEl !== null) {
      if (prevEl <= minEl && el > minEl) {
        // Rising: start a new pass. Interpolate the crossing time a little.
        cur = { startUTC: t / 1000, maxEl: el, maxUTC: t / 1000, az: la.az };
      } else if (cur) {
        if (el > cur.maxEl) {
          cur.maxEl = el;
          cur.maxUTC = t / 1000;
          cur.az = la.az;
        }
      }
      if (cur && prevEl > minEl && el <= minEl) {
        // Setting: close the pass. Interpolate between prevT and t.
        const f = (prevEl - minEl) / (prevEl - el || 1);
        cur.endUTC = (prevT + f * (t - prevT)) / 1000;
        if (cur.endUTC > cur.startUTC && cur.maxEl >= minEl) passes.push(cur);
        cur = null;
      }
    }
    prevEl = el;
    prevT = t;
  }

  // A pass still in progress at the horizon end: use the last sample.
  if (cur && prevEl !== null && prevEl > minEl) {
    cur.endUTC = endMs / 1000;
    passes.push(cur);
  }

  for (const p of passes) {
    p.maxEl = Number(p.maxEl.toFixed(1));
    p.duration = Math.round(p.endUTC - p.startUTC);
    p.az = Number(p.az.toFixed(1));
  }
  return passes;
}

export function compass(az) {
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  return dirs[Math.round(((az % 360) / 22.5)) % 16];
}

export function fmtUTC(unix) {
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

export function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
