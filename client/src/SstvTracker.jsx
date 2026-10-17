// SSTV Sats — amateur-radio satellite tracker ported from the amsat-tracker
// project. The satellite list is fetched from the local /api/sstv endpoints
// (which source it from db.satnogs.org, SSTV transmitters only); orbits are
// propagated locally with SGP4, so live positions, footprints, ground tracks
// and pass predictions need no third-party API key.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapContainer,
  TileLayer,
  Polyline,
  Circle,
  CircleMarker,
  Tooltip,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  satrecFromTle,
  observerGd,
  propagateAt,
  lookAnglesAt,
  footprintRadiusKm,
  groundTrack,
  splitDateline,
  predictPasses,
  compass,
  fmtUTC,
  fmtDuration,
} from './sstvOrbit.js';

const SAT_COLORS = [
  '#4f8cff', '#22d3a6', '#ffb020', '#ff6b6b', '#c084fc', '#38bdf8',
  '#f472b6', '#a3e635', '#fb923c', '#2dd4bf', '#818cf8', '#facc15',
];

const LS_LOC = 'sstv-location';
const selKey = (user) => `sstv-${user || 'anon'}-selected`;

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');

const fmtMHz = (hz, d = 3) => `${(Number(hz) / 1e6).toFixed(d)} MHz`;

const bandOf = (hz) => {
  const m = Number(hz) / 1e6;
  if (m < 30) return 'HF';
  if (m < 300) return 'VHF';
  if (m < 1000) return 'UHF';
  if (m < 3000) return 'SHF';
  return 'EHF';
};

const flagOf = (cc) => {
  const s = String(cc || '').split(',')[0].trim().toUpperCase().slice(0, 2);
  return s.length === 2 ? String.fromCodePoint(...[...s].map((c) => 127397 + c.charCodeAt(0))) : '';
};

function Recenter({ lat, lon, zoom, active }) {
  const map = useMap();
  useEffect(() => {
    if (active && Number.isFinite(lat) && Number.isFinite(lon)) map.setView([lat, lon], zoom);
  }, [lat, lon, zoom, active, map]);
  return null;
}

function FitBounds({ bounds }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds || !bounds.length) return;
    const b = L.latLngBounds(bounds);
    if (b.isValid()) map.fitBounds(b.pad(0.25));
  }, [bounds, map]);
  return null;
}

export default function SstvTracker({ user, onTuneDownlink }) {
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [status, setStatus] = useState('Idle');

  const [location, setLocation] = useState(() => readLS(LS_LOC, null));
  const [lat, setLat] = useState(() => readLS(LS_LOC, null)?.lat ?? '');
  const [lng, setLng] = useState(() => readLS(LS_LOC, null)?.lng ?? '');
  const [alt, setAlt] = useState(() => readLS(LS_LOC, null)?.alt ?? 0);

  const [selected, setSelected] = useState(() => readLS(selKey(user), []));
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [expanded, setExpanded] = useState({});

  const [tracking, setTracking] = useState(false);
  const [live, setLive] = useState([]);
  const [tracks, setTracks] = useState({});

  const [passDays, setPassDays] = useState(5);
  const [minEl, setMinEl] = useState(0);
  const [passes, setPasses] = useState(null);
  const [passLoading, setPassLoading] = useState(false);
  const [plotted, setPlotted] = useState(null);

  const satrecsRef = useRef(new Map());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const locRef = useRef(location);
  locRef.current = location;
  const rafRef = useRef(0);

  // Load the SSTV satellite catalogue once.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/sstv/satellites')
      .then((r) => {
        if (r.status === 401) throw new Error('unauthorized');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setCatalog(Array.isArray(d.satellites) ? d.satellites : []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setListError(e.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the selection per user.
  useEffect(() => {
    try {
      localStorage.setItem(selKey(user), JSON.stringify(selected));
    } catch {
      /* ignore */
    }
  }, [selected, user]);

  const satById = useCallback(
    (norad) => catalog.find((s) => s.norad === Number(norad)) || null,
    [catalog]
  );

  const colorFor = useCallback(
    (norad) => {
      const idx = selected.indexOf(Number(norad));
      return SAT_COLORS[(idx < 0 ? 0 : idx) % SAT_COLORS.length];
    },
    [selected]
  );

  const ensureSatrecs = useCallback(async (norads) => {
    const missing = [...new Set(norads.map(Number))].filter((n) => !satrecsRef.current.has(n));
    if (!missing.length) return true;
    const res = await fetch(`/api/sstv/tle?norads=${missing.join(',')}`);
    if (!res.ok) throw new Error(`TLE HTTP ${res.status}`);
    const data = await res.json();
    let got = 0;
    for (const n of missing) {
      const tle = data.tles && data.tles[n];
      const rec = tle ? satrecFromTle(tle) : null;
      if (rec) {
        satrecsRef.current.set(n, rec);
        got++;
      }
    }
    return got > 0;
  }, []);

  // Live tracking: propagate selected satellites with SGP4 and refresh the map
  // ~5x/s and the ground tracks every 5 s.
  useEffect(() => {
    if (!tracking) {
      setLive([]);
      return undefined;
    }
    let alive = true;
    let lastLive = 0;
    let lastTrack = 0;
    const tick = () => {
      if (!alive) return;
      const ms = Date.now();
      const now = new Date(ms);
      const obs = observerGd(locRef.current);
      const rows = [];
      for (const n of selectedRef.current) {
        const rec = satrecsRef.current.get(Number(n));
        if (!rec) continue;
        const p = propagateAt(rec, now);
        if (!p) continue;
        const la = lookAnglesAt(rec, now, obs);
        rows.push({
          norad: Number(n),
          lat: p.lat,
          lng: p.lng,
          altKm: p.altKm,
          az: la ? la.az : null,
          el: la ? la.el : null,
          range: la ? la.range : null,
          footprint: footprintRadiusKm(p.altKm, 0),
        });
      }
      if (ms - lastLive > 200) {
        lastLive = ms;
        setLive(rows);
      }
      if (ms - lastTrack > 5000) {
        lastTrack = ms;
        const start = ms - 45 * 60 * 1000;
        const end = ms + 45 * 60 * 1000;
        const tr = {};
        for (const n of selectedRef.current) {
          const rec = satrecsRef.current.get(Number(n));
          if (!rec) continue;
          tr[n] = splitDateline(groundTrack(rec, start, end, 60));
        }
        setTracks(tr);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [tracking]);

  const saveLocation = (loc) => {
    try {
      localStorage.setItem(LS_LOC, JSON.stringify(loc));
    } catch {
      /* ignore */
    }
  };

  const applyLocation = () => {
    const la = parseFloat(lat);
    const lo = parseFloat(lng);
    const al = parseFloat(alt) || 0;
    if (!Number.isFinite(la) || la < -90 || la > 90) return setStatus('Enter a valid latitude (-90..90)');
    if (!Number.isFinite(lo) || lo < -180 || lo > 180) return setStatus('Enter a valid longitude (-180..180)');
    const loc = { lat: la, lng: lo, alt: al };
    setLocation(loc);
    saveLocation(loc);
    setStatus(`Home set to ${la.toFixed(4)}, ${lo.toFixed(4)}`);
  };

  const useGeolocation = () => {
    if (!navigator.geolocation) return setStatus('Geolocation not supported');
    setStatus('Locating…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = {
          lat: +pos.coords.latitude.toFixed(6),
          lng: +pos.coords.longitude.toFixed(6),
          alt: Math.round(pos.coords.altitude || 0),
        };
        setLocation(loc);
        setLat(loc.lat);
        setLng(loc.lng);
        setAlt(loc.alt);
        saveLocation(loc);
        setStatus('Location set from device');
      },
      (err) => setStatus(`Geolocation failed: ${err.message}`),
      { enableHighAccuracy: false, timeout: 10000 }
    );
  };

  const toggleSelected = (norad) => {
    const n = Number(norad);
    setSelected((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));
  };

  const selectAll = () => setSelected(filtered.map((s) => s.norad));
  const selectNone = () => setSelected([]);

  const startTracking = async () => {
    if (!location) return setStatus('Set your home location first');
    if (!selected.length) return setStatus('Select at least one satellite');
    setStatus('Fetching TLEs…');
    try {
      await ensureSatrecs(selected);
    } catch (e) {
      setStatus(`TLE error: ${e.message}`);
      return;
    }
    setTracking(true);
    setStatus(`Tracking ${selected.length} satellite(s)`);
  };

  const stopTracking = () => {
    setTracking(false);
    setStatus('Idle');
  };

  const loadPasses = async () => {
    if (!location) return setStatus('Set your home location first');
    if (!selected.length) return setStatus('Select at least one satellite');
    setPassLoading(true);
    setStatus('Loading predictions…');
    try {
      await ensureSatrecs(selected);
      const obs = observerGd(location);
      const fromMs = Date.now();
      const all = [];
      for (const n of selected) {
        const rec = satrecsRef.current.get(Number(n));
        if (!rec) continue;
        const sat = satById(n);
        const ps = predictPasses(rec, obs, { fromMs, days: passDays, minEl, stepSec: 45 });
        for (const p of ps) all.push({ ...p, norad: Number(n), name: sat ? sat.name : `NORAD ${n}` });
      }
      all.sort((a, b) => a.startUTC - b.startUTC);
      setPasses(all);
      setStatus(`${all.length} pass(es) in the next ${passDays} day(s)`);
    } catch (e) {
      setStatus(`Prediction error: ${e.message}`);
      setPasses([]);
    } finally {
      setPassLoading(false);
    }
  };

  const plotPass = async (p) => {
    try {
      await ensureSatrecs([p.norad]);
    } catch {
      /* ignore */
    }
    const rec = satrecsRef.current.get(Number(p.norad));
    if (!rec) return;
    const pts = groundTrack(rec, p.startUTC * 1000, p.endUTC * 1000, 15);
    setPlotted({ norad: p.norad, pass: p, segments: splitDateline(pts), bounds: pts });
  };

  const filtered = useMemo(() => {
    const f = search.trim().toLowerCase();
    return catalog
      .filter((s) => !activeOnly || s.active)
      .filter((s) => !f || s.name.toLowerCase().includes(f) || String(s.norad).includes(f));
  }, [catalog, search, activeOnly]);

  const passGroups = useMemo(() => {
    if (!passes) return null;
    const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const groups = [];
    for (const p of passes) {
      const d = new Date(p.startUTC * 1000);
      const k = dayKey(d);
      let g = groups[groups.length - 1];
      if (!g || g.key !== k) {
        g = { key: k, date: d, items: [] };
        groups.push(g);
      }
      g.items.push(p);
    }
    return groups;
  }, [passes]);

  const todayKey = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }, []);

  const liveSorted = useMemo(
    () => [...live].sort((a, b) => (b.el ?? -99) - (a.el ?? -99)),
    [live]
  );

  const mapCenter = location ? [location.lat, location.lng] : [20, 0];
  const mapZoom = location ? 3 : 2;

  return (
    <div className="sstv-tracker">
      <div className="sstv-status">
        <span className={listError ? 'sstv-pill err' : 'sstv-pill'}>{status}</span>
        {listError && <span className="sstv-hint">SatNOGS list: {listError} (using cached data)</span>}
      </div>

      <div className="sstv-panels">
        {/* Home location */}
        <section className="sstv-panel">
          <h2>Home location</h2>
          <div className="sstv-grid3">
            <label>
              Latitude
              <input type="number" step="0.000001" min="-90" max="90" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="51.5074" />
            </label>
            <label>
              Longitude
              <input type="number" step="0.000001" min="-180" max="180" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-0.1278" />
            </label>
            <label>
              Altitude (m)
              <input type="number" step="1" min="0" max="9000" value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="0" />
            </label>
          </div>
          <div className="sstv-row">
            <button onClick={useGeolocation}>📍 Use my location</button>
            <button className="primary" onClick={applyLocation}>Save location</button>
            <span className="sstv-hint">
              {location ? `${fmt(location.lat, 4)}, ${fmt(location.lng, 4)}` : 'No location saved'}
            </span>
          </div>
        </section>

        {/* Satellites */}
        <section className="sstv-panel">
          <div className="sstv-panel-head">
            <h2>SSTV satellites</h2>
            <span className="sstv-hint">{selected.length} selected · from db.satnogs.org</span>
          </div>
          <div className="sstv-row">
            <input
              type="search"
              className="sstv-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter name / NORAD…"
            />
            <label className="sstv-check">
              <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
              Active only
            </label>
            <button onClick={selectAll}>All</button>
            <button onClick={selectNone}>None</button>
          </div>
          {loading ? (
            <div className="sstv-empty">Loading SSTV satellites…</div>
          ) : filtered.length === 0 ? (
            <div className="sstv-empty">No satellites match.</div>
          ) : (
            <ul className="sstv-list">
              {filtered.map((s) => (
                <li key={s.norad} className="sstv-entry">
                  <label className="sstv-item">
                    <input type="checkbox" checked={selected.includes(s.norad)} onChange={() => toggleSelected(s.norad)} />
                    <span className="sstv-meta">
                      <span className="sstv-name">
                        {s.name} {flagOf(s.countries) && <span className="sstv-flag">{flagOf(s.countries)}</span>}
                      </span>
                      <span className="sstv-sub">
                        NORAD {s.norad}
                        {s.status && s.status !== 'in orbit' ? ` · ${s.status}` : ''}
                      </span>
                    </span>
                    <span className={`sstv-badge${s.active ? ' ok' : ''}`}>{s.active ? 'active' : s.status || 'unknown'}</span>
                  </label>
                  <button
                    className="sstv-freq-toggle"
                    aria-expanded={!!expanded[s.norad]}
                    onClick={() => setExpanded((e) => ({ ...e, [s.norad]: !e[s.norad] }))}
                  >
                    {expanded[s.norad] ? 'Freqs ▴' : 'Freqs ▾'}
                  </button>
                  {expanded[s.norad] && (
                    <div className="sstv-freq-row">
                      {s.freqs.length === 0 ? (
                        <div className="sstv-empty">No listed downlinks.</div>
                      ) : (
                        <table className="sstv-freq-table">
                          <thead>
                            <tr>
                              <th>Band</th>
                              <th>Downlink</th>
                              <th>Description</th>
                              <th>Status</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {s.freqs.map((f, i) => (
                              <tr key={`${f.down}-${i}`}>
                                <td><span className="sstv-band">{bandOf(f.down)}</span></td>
                                <td className="num">{fmtMHz(f.down)}</td>
                                <td>{f.desc || '—'}</td>
                                <td className={f.status === 'active' ? 'ok' : 'muted'}>{f.status || 'unknown'}</td>
                                <td>
                                  {onTuneDownlink && (
                                    <button
                                      className="sstv-tune"
                                      onClick={() => onTuneDownlink(f.down)}
                                      title={`Listen to ${fmtMHz(f.down)} (NFM)`}
                                    >
                                      Tune
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      <p className="sstv-hint">Reference frequencies from SatNOGS — verify before operating.</p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Live tracking */}
        <section className="sstv-panel sstv-wide">
          <div className="sstv-panel-head">
            <h2>Live tracking &amp; ground footprints</h2>
            <div className="sstv-row">
              {!tracking ? (
                <button className="primary" onClick={startTracking}>Start</button>
              ) : (
                <button onClick={stopTracking}>Stop</button>
              )}
              <button onClick={() => setPlotted(null)}>Clear pass</button>
              <span className="sstv-hint">{tracking ? `${live.length} tracked` : 'Idle'}</span>
            </div>
          </div>
          <div className="sstv-map">
            <MapContainer center={mapCenter} zoom={mapZoom} className="sstv-map-leaflet">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <Recenter
                lat={location ? location.lat : NaN}
                lon={location ? location.lng : NaN}
                zoom={mapZoom}
                active={!!location}
              />
              <FitBounds bounds={plotted ? plotted.bounds : null} />
              {Object.entries(tracks).map(([norad, segs]) =>
                segs.map((seg, i) => (
                  <Polyline key={`t-${norad}-${i}`} positions={seg} pathOptions={{ color: colorFor(norad), weight: 2, opacity: 0.6 }} />
                ))
              )}
              {plotted &&
                plotted.segments.map((seg, i) => (
                  <Polyline key={`p-${i}`} positions={seg} pathOptions={{ color: colorFor(plotted.norad), weight: 3, opacity: 0.95 }} />
                ))}
              {live.map((r) => (
                <Circle
                  key={`f-${r.norad}`}
                  center={[r.lat, r.lng]}
                  radius={r.footprint * 1000}
                  pathOptions={{ color: colorFor(r.norad), fillColor: colorFor(r.norad), fillOpacity: 0.1, weight: 1 }}
                />
              ))}
              {live.map((r) => (
                <CircleMarker
                  key={`m-${r.norad}`}
                  center={[r.lat, r.lng]}
                  radius={6}
                  pathOptions={{ color: '#fff', weight: 2, fillColor: colorFor(r.norad), fillOpacity: 1 }}
                >
                  <Tooltip direction="top" offset={[0, -8]}>
                    {satById(r.norad)?.name || `NORAD ${r.norad}`}
                  </Tooltip>
                </CircleMarker>
              ))}
              {location && (
                <CircleMarker center={[location.lat, location.lng]} radius={6} pathOptions={{ color: '#0b1020', weight: 2, fillColor: '#f0883e', fillOpacity: 1 }} />
              )}
            </MapContainer>
          </div>
          <div className="sstv-table-wrap">
            <table className="sstv-table">
              <thead>
                <tr>
                  <th>Satellite</th>
                  <th>Az</th>
                  <th>El</th>
                  <th>Alt km</th>
                  <th>Range km</th>
                  <th>Footprint km</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {!tracking && (
                  <tr>
                    <td colSpan={7} className="sstv-empty">
                      {selected.length ? 'Press Start to track.' : 'Select satellites and press Start.'}
                    </td>
                  </tr>
                )}
                {tracking && liveSorted.length === 0 && (
                  <tr>
                    <td colSpan={7} className="sstv-empty">Waiting for orbit data…</td>
                  </tr>
                )}
                {liveSorted.map((r) => {
                  const up = (r.el ?? -1) > 0;
                  return (
                    <tr key={r.norad}>
                      <td>
                        <span className="sstv-dot" style={{ background: colorFor(r.norad) }} />
                        {satById(r.norad)?.name || r.norad}
                      </td>
                      <td className="num">{r.az != null ? `${fmt(r.az, 1)}° ${compass(r.az)}` : '—'}</td>
                      <td className="num">{r.el != null ? `${fmt(r.el, 1)}°` : '—'}</td>
                      <td className="num">{fmt(r.altKm, 0)}</td>
                      <td className="num">{r.range != null ? fmt(r.range, 0) : '—'}</td>
                      <td className="num">{fmt(r.footprint, 0)}</td>
                      <td>{up ? <span className="sstv-up">above horizon</span> : <span className="sstv-muted">below horizon</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Pass predictions */}
        <section className="sstv-panel sstv-wide">
          <div className="sstv-panel-head">
            <h2>Pass predictions</h2>
            <div className="sstv-row">
              <label className="sstv-inline">
                Days
                <input type="number" min="1" max="10" value={passDays} onChange={(e) => setPassDays(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 5)))} />
              </label>
              <label className="sstv-inline">
                Min el
                <input type="number" min="0" max="90" value={minEl} onChange={(e) => setMinEl(Math.max(0, Math.min(90, parseInt(e.target.value, 10) || 0)))} />
              </label>
              <button className="primary" onClick={loadPasses} disabled={passLoading}>
                {passLoading ? 'Loading…' : 'Load predictions'}
              </button>
            </div>
          </div>
          {!passes ? (
            <div className="sstv-empty">Select satellites, then load predictions. Times are local.</div>
          ) : passes.length === 0 ? (
            <div className="sstv-empty">No passes found in the next {passDays} day(s).</div>
          ) : (
            <div className="sstv-table-wrap">
              <table className="sstv-table sstv-pass-table">
                <thead>
                  <tr>
                    <th>Satellite</th>
                    <th>Date</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Duration</th>
                    <th>Max el</th>
                  </tr>
                </thead>
                <tbody>
                  {passGroups.map((g) => {
                    const isToday = g.key === todayKey;
                    return [
                      <tr key={`d-${g.key}`} className="sstv-day-row">
                        <td colSpan={6}>
                          {g.date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                          {isToday ? ' · Today' : ''}
                          <span className="sstv-day-count">{g.items.length} pass(es)</span>
                        </td>
                      </tr>,
                      ...g.items.map((p, i) => (
                        <tr
                          key={`p-${g.key}-${i}`}
                          className="sstv-pass-row"
                          onClick={() => plotPass(p)}
                          title="Click to plot this pass on the map"
                        >
                          <td>
                            <span className="sstv-dot" style={{ background: colorFor(p.norad) }} />
                            {p.name}
                          </td>
                          <td>{new Date(p.startUTC * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                          <td className="num">{new Date(p.startUTC * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                          <td className="num">{new Date(p.endUTC * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                          <td className="num">{fmtDuration(p.duration)}</td>
                          <td className="num"><strong>{fmt(p.maxEl, 1)}°</strong></td>
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
          {plotted && (
            <p className="sstv-hint">
              Plotted {plotted.name || satById(plotted.norad)?.name} · rise {fmtUTC(plotted.pass.startUTC)} · max {fmt(plotted.pass.maxEl, 1)}° · set {fmtUTC(plotted.pass.endUTC)}
            </p>
          )}
        </section>
      </div>

      <p className="sstv-hint">
        Satellite data © <a href="https://db.satnogs.org" target="_blank" rel="noopener noreferrer">SatNOGS DB</a> (CC BY-SA 4.0) · TLEs propagated locally with SGP4.
      </p>
    </div>
  );
}
