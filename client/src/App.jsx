import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioPlayer } from './audio.js';
import SpectrumAnalyzer from './SpectrumAnalyzer.jsx';
import Waterfall from './Waterfall.jsx';
import AdsbMap from './AdsbMap.jsx';
import AdsbTable from './AdsbTable.jsx';
import { getAircraftPosition, getCachedPosition } from './adsbEnrich.js';

// Presets are stored per mode and per user so FM / NFM station lists stay separate.
const presetKey = (user, m) => `sdr-${user}-${m}-stations`;

// Last DAB scan results survive a page refresh (per user).
const dabScanKey = (user) => `sdr-${user}-dab-scan`;

// NFM/AM waterfall: the tuner stays parked and the tuned channel is moved
// digitally inside the captured 1 MHz band, so the waterfall pans a sub-window
// around the tuned frequency with a fixed center marker.
const NFM_AM_VISIBLE_SPAN = 600_000;
const MESHTASTIC_DEFAULT_FREQ = 869.525;

// Stations are always shown sorted alphabetically by name (case-insensitive).
const sortPresets = (list) =>
  [...list].sort((a, b) =>
    String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })
  );

const fmtMHz = (hz) => `${(hz / 1e6).toFixed(2)} MHz`;

// ETSI EN 300 401 Band III block centres (MHz).
const DAB_CHANNELS = [
  ['5A', 174.928], ['5B', 176.64], ['5C', 178.352], ['5D', 180.064],
  ['6A', 181.936], ['6B', 183.648], ['6C', 185.36], ['6D', 187.072],
  ['7A', 188.928], ['7B', 190.64], ['7C', 192.352], ['7D', 194.064],
  ['8A', 195.936], ['8B', 197.648], ['8C', 199.36], ['8D', 201.072],
  ['9A', 202.928], ['9B', 204.64], ['9C', 206.352], ['9D', 208.064],
  ['10A', 209.936], ['10B', 211.648], ['10C', 213.36], ['10D', 215.072],
  ['11A', 216.928], ['11B', 218.64], ['11C', 220.352], ['11D', 222.064],
  ['12A', 223.936], ['12B', 225.648], ['12C', 227.36], ['12D', 229.072],
  ['13A', 230.748], ['13B', 232.496], ['13C', 234.208], ['13D', 235.776],
  ['13E', 237.488], ['13F', 239.2],
];

const dabChannelForMhz = (mhz) => {
  let best = DAB_CHANNELS[0];
  let bestDiff = Infinity;
  for (const ch of DAB_CHANNELS) {
    const d = Math.abs(mhz - ch[1]);
    if (d < bestDiff) {
      bestDiff = d;
      best = ch;
    }
  }
  return best;
};

export default function App() {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('1234');
  const [mode, setMode] = useState('fm');
  const [freq, setFreq] = useState('');
  const [nfmFreq, setNfmFreq] = useState('145.000');
  const [hfFreq, setHfFreq] = useState('7.100');
  const [demod, setDemod] = useState('am');
  const [meshtasticFreq, setMeshtasticFreq] = useState(MESHTASTIC_DEFAULT_FREQ.toFixed(3));
  const [adsbFreq, setAdsbFreq] = useState('1090.000');
  const [adsbAircraft, setAdsbAircraft] = useState([]);
  const [adsbSelected, setAdsbSelected] = useState(null);
  const [adsbRange, setAdsbRange] = useState(100);
  const [posOverrides, setPosOverrides] = useState({});

  // Fill positions our receiver hasn't decoded yet (e.g. far/weak aircraft)
  // from the crowdsourced OpenSky network, so the table/map have no gaps.
  useEffect(() => {
    for (const a of adsbAircraft) {
      if (a.lat != null && a.lon != null) continue;
      if (getCachedPosition(a.icao) !== undefined) continue;
      getAircraftPosition(a.icao).then((pos) => {
        setPosOverrides((prev) => ({ ...prev, [a.icao]: pos }));
      });
    }
  }, [adsbAircraft]);

  // Prefer our own position; only fill lat/lon (and onGround) when missing.
  const displayAircraft = useMemo(
    () =>
      adsbAircraft.map((a) => {
        if (a.lat != null && a.lon != null) return a;
        const o = posOverrides[a.icao];
        if (o && o.lat != null && o.lon != null) {
          return { ...a, lat: o.lat, lon: o.lon, onGround: a.onGround ?? o.onGround };
        }
        return a;
      }),
    [adsbAircraft, posOverrides]
  );
  const [homeLat, setHomeLat] = useState(null);
  const [homeLon, setHomeLon] = useState(null);
  const [dabFreq, setDabFreq] = useState('216.928');
  const [gain, setGain] = useState('');
  const [squelch, setSquelch] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [status, setStatus] = useState('Idle');
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ signal: 0, audio: 0 });
  const [scanning, setScanning] = useState(false);
  const [scanTotal, setScanTotal] = useState(0);
  const [scanDone, setScanDone] = useState(0);
  const [scanProgress, setScanProgress] = useState('');
  const [scanSensitivity, setScanSensitivity] = useState('normal');
  const [scanFound, setScanFound] = useState(null);
  const [scanError, setScanError] = useState('');
  const [scanBand, setScanBand] = useState('2m');
  const [scanNoiseFloor, setScanNoiseFloor] = useState(null);
  const [scanName, setScanName] = useState('');
  const [dabScanResults, setDabScanResults] = useState([]);
  const [dabScanConfirm, setDabScanConfirm] = useState(false);
  const [dabInfo, setDabInfo] = useState(null);
  const [dabServices, setDabServices] = useState([]);
  const [dabService, setDabService] = useState('');
  const [dabSlide, setDabSlide] = useState(null);
  const [dabLogo, setDabLogo] = useState(null);
  const [meshtasticPackets, setMeshtasticPackets] = useState([]);
  const [meshtasticKeyMode, setMeshtasticKeyMode] = useState('default');
  const [meshtasticKey, setMeshtasticKey] = useState('');
  const [meshtasticKeyStatus, setMeshtasticKeyStatus] = useState('');
  const [presets, setPresets] = useState([]);
  const [newName, setNewName] = useState('');
  const [span, setSpan] = useState(288_000);
  const [bins, setBins] = useState(256);
  const [centerHz, setCenterHz] = useState(null);
  const [tunePct, setTunePct] = useState(50); // tuned channel position in the waterfall
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authName, setAuthName] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [tuneStep, setTuneStep] = useState(100_000);
  const [knobAngle, setKnobAngle] = useState(0);
  const [cwText, setCwText] = useState('');

  const wsRef = useRef(null);
  const playerRef = useRef(null);
  const spectrumRef = useRef(null);
  const playingRef = useRef(false);
  const presetsModeRef = useRef(null);
  const knobRef = useRef(null);
  const wheelAccRef = useRef(0);
  const tuneFreqRef = useRef(null);
  const fineRef = useRef({ mode: 'fm', tuneStep: 100_000, nfmFreq: '145.000', hfFreq: '7.100' });
  fineRef.current = { mode, tuneStep, nfmFreq, hfFreq };
  const tuneScanHitRef = useRef(null);

  const loadPresets = (m) => {
    presetsModeRef.current = m;
    fetch(`/api/presets?mode=${m}`)
      .then((r) => {
        if (r.status === 401) throw new Error('unauthorized');
        return r.json();
      })
      .then((data) => {
        if (presetsModeRef.current !== m) return;
        const list = sortPresets(Array.isArray(data.presets) ? data.presets : []);
        setPresets(list);
        try {
          localStorage.setItem(presetKey(user, m), JSON.stringify(list));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        if (presetsModeRef.current !== m) return;
        try {
          const saved = JSON.parse(localStorage.getItem(presetKey(user, m)) || '[]');
          if (Array.isArray(saved)) setPresets(sortPresets(saved));
        } catch {
          /* ignore */
        }
      });
  };

  const enterApp = (username) => {
    setAuthChecked(true);
    // Restore the last DAB scan results so they survive a page refresh.
    try {
      const saved = JSON.parse(localStorage.getItem(dabScanKey(username)) || '[]');
      if (Array.isArray(saved) && saved.length) setDabScanResults(saved);
    } catch {
      /* ignore */
    }
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        setHost(cfg.host);
        setPort(String(cfg.port));
        setFreq((cfg.freq / 1e6).toFixed(1));
        if (cfg.gain !== undefined) setGain(String(cfg.gain));
        if (cfg.mode) setMode(cfg.mode);
        if (cfg.dabFreq) setDabFreq((cfg.dabFreq / 1e6).toFixed(3));
        if (cfg.nfmFreq) setNfmFreq((cfg.nfmFreq / 1e6).toFixed(3));
        if (cfg.amFreq) setHfFreq((cfg.amFreq / 1e6).toFixed(3));
        if (cfg.meshtasticFreq) setMeshtasticFreq((cfg.meshtasticFreq / 1e6).toFixed(3));
        if (cfg.adsbFreq) setAdsbFreq((cfg.adsbFreq / 1e6).toFixed(3));
        if (cfg.homeLat != null) setHomeLat(cfg.homeLat);
        if (cfg.homeLon != null) setHomeLon(cfg.homeLon);
        if (cfg.squelch !== undefined) setSquelch(cfg.squelch);
        loadPresets(cfg.mode || 'fm');
        fetch('/api/meshtastic-config')
          .then((r) => r.json())
          .then((settings) => setMeshtasticKeyMode(settings.keyMode === 'custom' ? 'custom' : 'default'))
          .catch(() => {});
      })
      .catch(() => {
        setHost('192.168.0.6');
        setPort('1234');
        setFreq('95.1');
        setGain('40');
        setDabFreq('216.928');
        setNfmFreq('145.000');
        setHfFreq('7.100');
        setMeshtasticFreq(MESHTASTIC_DEFAULT_FREQ.toFixed(3));
        setMode('fm');
        loadPresets('fm');
      });
  };

  const saveMeshtasticKey = async () => {
    const key = meshtasticKeyMode === 'default' ? 'default' : meshtasticKey.trim();
    if (meshtasticKeyMode === 'custom' && !key) {
      setMeshtasticKeyStatus('Enter a channel key first');
      return;
    }
    try {
      const response = await fetch('/api/meshtastic-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save key');
      setMeshtasticKey('');
      setMeshtasticKeyStatus(meshtasticKeyMode === 'default' ? 'Using default key' : 'Custom key saved');
      send({ op: 'meshtasticKey', key });
    } catch (err) {
      setMeshtasticKeyStatus(err.message);
    }
  };

  useEffect(() => {
    fetch('/api/me')
      .then((r) => {
        if (!r.ok) throw new Error('not authenticated');
        return r.json();
      })
      .then((d) => {
        setUser(d.username);
        enterApp(d.username);
      })
      .catch(() => setAuthChecked(true));
    return () => {
      playingRef.current = false;
      if (wsRef.current) wsRef.current.close();
      if (playerRef.current) playerRef.current.close();
    };
  }, []);

  // Keep the last completed DAB scan results across page refreshes (per user).
  useEffect(() => {
    if (!user || !dabScanResults.length) return;
    try {
      localStorage.setItem(dabScanKey(user), JSON.stringify(dabScanResults));
    } catch {
      /* ignore */
    }
  }, [user, dabScanResults]);

  const persistPresets = (m, list) => {
    try {
      localStorage.setItem(presetKey(user, m), JSON.stringify(list));
    } catch {
      /* ignore */
    }
    fetch(`/api/presets?mode=${m}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets: list }),
    })
      .then((r) => {
        if (r.status === 401) {
          setUser(null);
          setAuthChecked(true);
        }
      })
      .catch(() => {
        /* server unreachable: local cache kept as fallback */
      });
  };

  const submitAuth = async (e) => {
    e.preventDefault();
    if (authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await fetch(`/api/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: authName, password: authPass }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAuthError(data.error || 'Request failed');
        return;
      }
      setUser(data.username);
      setAuthName('');
      setAuthPass('');
      enterApp(data.username);
    } catch {
      setAuthError('Network error');
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    playingRef.current = false;
    if (wsRef.current) wsRef.current.close();
    if (playerRef.current) playerRef.current.stop();
    setPlaying(false);
    setStatus('Idle');
    setPresets([]);
    setUser(null);
    setAuthChecked(true);
  };

  const ensurePlayer = async () => {
    if (!playerRef.current) playerRef.current = new AudioPlayer();
    await playerRef.current.init();
    return playerRef.current;
  };

  const openWs = () =>
    new Promise((resolve, reject) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
      ws.onclose = () => {
        if (playingRef.current) setStatus('Disconnected');
        setBusy(false);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const msg = JSON.parse(ev.data);
           if (msg.type === 'status') {
             if (msg.demod === 'am' || msg.demod === 'usb' || msg.demod === 'lsb' || msg.demod === 'cw') setDemod(msg.demod);
             if (msg.mode === 'meshtastic') {
               setStatus(msg.connected ? `Meshtastic · ${msg.meshtasticPackets || 0} packets` : 'Tuning Meshtastic…');
               if (msg.connected) {
                 setStats({ signal: 0, audio: 0 });
                 setCenterHz(msg.center != null ? msg.center : msg.freq);
               }
                if (msg.span) setSpan(msg.span);
                if (msg.bins) setBins(msg.bins);
              } else if (msg.mode === 'adsb') {
                setStatus(msg.connected ? `ADS-B · ${msg.adsbCount || 0} aircraft` : 'Tuning ADS-B…');
                if (msg.connected) {
                  setStats({ signal: 0, audio: 0 });
                  setCenterHz(msg.center != null ? msg.center : msg.freq);
                }
              } else if (msg.mode === 'dab') {
              setDabInfo({
                channel: msg.channel || null,
                service: msg.service || null,
                ensemble: msg.ensemble || null,
                snr: msg.snr != null ? msg.snr : null,
              });
              if (Array.isArray(msg.services)) setDabServices(msg.services);
              setDabLogo(msg.logo || null);
              if (playerRef.current) playerRef.current.setRate(msg.rate || 48000);
              if (msg.connected) setStats({ signal: msg.signal || 0, audio: msg.audio || 0 });
              setStatus(
                msg.connected
                  ? `DAB ${msg.channel || ''} · ${msg.service || 'playing'}`
                  : 'Tuning DAB…'
              );
            } else {
              setStatus(msg.connected ? `Tuned to ${(msg.freq / 1e6).toFixed(1)} MHz` : 'Idle');
              if (msg.connected) {
                setStats({ signal: msg.signal || 0, audio: msg.audio || 0 });
                const c = msg.center != null ? msg.center : msg.freq;
                setCenterHz(c);
                const half = (msg.span || span) / 2;
                setTunePct(Math.min(100, Math.max(0, 50 + ((msg.freq - c) / half) * 50)));
              }
              if (playerRef.current) playerRef.current.setRate(msg.rate || 48000);
              if (msg.span) setSpan(msg.span);
              if (msg.bins) setBins(msg.bins);
            }
            setBusy(false);
           } else if (msg.type === 'error') {
             setStatus(`Error: ${msg.message}`);
             setBusy(false);
            } else if (msg.type === 'meshtastic') {
              setMeshtasticPackets((prev) => [msg.packet, ...prev].slice(0, 100));
              setStatus(`Meshtastic · packet from ${msg.packet.src}`);
            } else if (msg.type === 'adsb') {
              setAdsbAircraft(msg.aircraft || []);
              setStatus(`ADS-B · ${(msg.aircraft || []).length} aircraft`);
            } else if (msg.type === 'cw') {
              setCwText(msg.text || '');
            } else if (msg.type === 'info') {
             setStatus(msg.message);
          } else if (msg.type === 'slide') {
            setDabSlide(msg.data ? `data:${msg.mime};base64,${msg.data}` : null);
          } else if (msg.type === 'scan') {
            if (msg.kind === 'started') {
              setScanTotal(msg.total || 0);
              setScanDone(0);
              setScanProgress('');
              setScanFound(null);
            } else if (msg.kind === 'floor') {
              if (msg.noiseFloor != null) setScanNoiseFloor(msg.noiseFloor);
            } else if (msg.kind === 'progress') {
              setScanDone(msg.done || 0);
              setScanTotal(msg.total || 0);
              setScanProgress(msg.freq ? `${(msg.freq / 1e6).toFixed(mode === 'nfm' ? 3 : 1)} MHz` : '');
            } else if (msg.kind === 'channel') {
              // DAB scan: a channel finished its dwell. Record it in the results
              // so the list builds live while the sweep runs.
              setScanDone(msg.done || 0);
              setScanTotal(msg.total || 0);
              setScanProgress(msg.channel || '');
              if (Array.isArray(msg.services) && msg.services.length) {
                setDabScanResults((prev) => [
                  ...prev,
                  {
                    channel: msg.channel,
                    freqHz: msg.freqHz,
                    ensemble: msg.ensemble || null,
                    services: msg.services,
                  },
                ]);
              }
            } else if (msg.kind === 'hit') {
              // Tune straight to the found signal so the operator can listen
              // while the modal asks whether to save it or keep scanning.
              setScanFound({ freq: msg.freq, signal: msg.signal });
              if (msg.noiseFloor != null) setScanNoiseFloor(msg.noiseFloor);
              if (tuneScanHitRef.current) tuneScanHitRef.current(msg.freq);
            } else if (msg.kind === 'done') {
              setScanning(false);
              setScanFound(null);
              setScanDone(msg.total || 0);
              if (Array.isArray(msg.channels)) {
                // DAB scan: full grouped results from the server.
                setDabScanResults(msg.channels);
              }
              setStatus(
                msg.aborted
                  ? 'Scan stopped'
                  : msg.channels
                    ? `DAB scan complete — ${msg.found || 0} station${msg.found === 1 ? '' : 's'} found`
                    : `Scan complete — ${msg.found || 0} signal${msg.found === 1 ? '' : 's'} found`
              );
            } else if (msg.kind === 'error') {
              setScanError(msg.message || 'Scan failed');
              setScanning(false);
              setScanFound(null);
            }
          }
        } else {
          const bytes = new Uint8Array(ev.data);
          const kind = bytes[0];
          if (kind === 1) {
            const int16 = new Int16Array(ev.data, 2, (ev.data.byteLength - 2) / 2);
            playerRef.current && playerRef.current.push(int16);
          } else if (kind === 2) {
            const nb = bytes[1] | (bytes[2] << 8);
            spectrumRef.current && spectrumRef.current.push(bytes.subarray(3, 3 + nb));
          }
        }
      };
      wsRef.current = ws;
    });

  const send = (msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const SCAN_SENSITIVITY = { high: 1.5, normal: 2.5, low: 5 };
  const NFM_BANDS = {
    '2m': { label: '2m · 144–148 MHz', start: 144_000_000, stop: 148_000_000, step: 12_500 },
    '70cm': { label: '70cm · 430–440 MHz', start: 430_000_000, stop: 440_000_000, step: 25_000 },
  };

  const fmtHitFreq = (freq) => (freq / 1e6).toFixed(mode === 'nfm' ? 3 : 1);

  // Tunes the receiver to a frequency found by the scan so the operator can
  // listen while the modal asks whether to save it or continue. The paused
  // scan stays intact: the server only aborts a scan on tune when it is not
  // paused.
  const tuneScanHit = async (freq) => {
    const f = fmtHitFreq(freq);
    if (mode === 'nfm') setNfmFreq(f);
    else setFreq(f);
    try {
       const player = await ensurePlayer();
       if (player) player.setVolume(volume);
      let ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) ws = await openWs();
      send({
        op: 'tune',
        mode,
        freq: Math.round(freq),
        host,
        port: parseInt(port, 10),
        gain: gain.trim() === '' ? undefined : Number(gain),
        squelch: mode === 'nfm' ? squelch : 0,
      });
       player.start();
      playingRef.current = true;
      setPlaying(true);
    } catch (err) {
      setScanError(err.message || 'Tune failed');
    }
  };
  tuneScanHitRef.current = tuneScanHit;

  const startScan = async () => {
    if ((mode !== 'fm' && mode !== 'nfm') || scanning || busy) return;
    setScanning(true);
    setScanFound(null);
    setScanName('');
    setScanDone(0);
    setScanTotal(0);
    setScanProgress('');
    setScanError('');
    setScanNoiseFloor(null);
    try {
      let ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) ws = await openWs();
      if (playingRef.current && playerRef.current) playerRef.current.stop();
      playingRef.current = false;
      setPlaying(false);
      const band = NFM_BANDS[scanBand];
      send({
        op: 'scan',
        mode,
        start: mode === 'nfm' ? band.start : 87_500_000,
        stop: mode === 'nfm' ? band.stop : 108_000_000,
        step: mode === 'nfm' ? band.step : 100_000,
        threshold: SCAN_SENSITIVITY[scanSensitivity] || 2.5,
        dwell: mode === 'nfm' ? 150 : 200,
        host,
        port: parseInt(port, 10),
        gain: gain.trim() === '' ? undefined : Number(gain),
      });
    } catch (err) {
      setScanError(err.message || 'Scan connection failed');
      setScanning(false);
    }
  };

  const stopScan = () => {
    if (!scanning && !scanFound) return;
    setScanning(false);
    setScanFound(null);
    if (mode === 'dab') setDabScanResults([]);
    send({ op: 'scanStop' });
  };

  const continueScan = () => {
    setScanFound(null);
    send({ op: 'scanContinue' });
  };

  // DAB scan: sweep every Band III channel and build a live results list. The
  // server runs the whole band (no pause-at-hit) and sends the full grouped
  // results when it finishes. If a previous scan left results behind, ask first
  // (a fresh scan replaces them) before wiping and re-sweeping the band.
  const startDabScan = async () => {
    if (mode !== 'dab' || scanning || busy) return;
    if (dabScanResults.length > 0) {
      setDabScanConfirm(true);
      return;
    }
    await runDabScan();
  };

  const runDabScan = async () => {
    if (mode !== 'dab' || scanning || busy) return;
    setDabScanConfirm(false);
    setScanning(true);
    setDabScanResults([]);
    setScanDone(0);
    setScanTotal(0);
    setScanProgress('');
    setScanError('');
    try {
      let ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) ws = await openWs();
      if (playingRef.current && playerRef.current) playerRef.current.stop();
      playingRef.current = false;
      setPlaying(false);
      send({
        op: 'scan',
        mode: 'dab',
        dwell: 3000,
        host,
        port: parseInt(port, 10),
        gain: gain.trim() === '' ? undefined : Number(gain),
      });
    } catch (err) {
      setScanError(err.message || 'Scan connection failed');
      setScanning(false);
    }
  };

  // Favourites for DAB: star an individual station (scanner name + channel
  // frequency) to add/remove it, not the whole channel.
  const isDabFavourite = (channel, serviceName) => {
    const freq = (channel.freqHz / 1e6).toFixed(3);
    return presets.some((p) => p.mode === 'dab' && p.service === serviceName && p.freq === freq);
  };

  const toggleDabFavourite = (channel, service) => {
    const freq = (channel.freqHz / 1e6).toFixed(3);
    const exists = isDabFavourite(channel, service.name);
    const next = exists
      ? presets.filter((p) => !(p.mode === 'dab' && p.service === service.name && p.freq === freq))
      : sortPresets([
          ...presets,
          {
            name: service.name,
            freq,
            mode: 'dab',
            service: service.name,
            sid: service.sid || undefined,
          },
        ]);
    setPresets(next);
    persistPresets('dab', next);
  };

  const saveScanHit = () => {
    if (!scanFound) return;
    const name = scanName.trim() || `${mode === 'nfm' ? 'NFM' : 'FM'} ${fmtHitFreq(scanFound.freq)} MHz`;
    const next = sortPresets([
      ...presets,
      { name, freq: fmtHitFreq(scanFound.freq), mode },
    ]);
    setPresets(next);
    persistPresets(mode, next);
    continueScan();
  };

  const play = async (freqOverride, modeOverride, serviceOverride, demodOverride) => {
    if (busy) return;
    if (scanning) {
      setScanning(false);
      send({ op: 'scanStop' });
    }
    setBusy(true);
    try {
      const m = modeOverride || mode;
      const dem = m === 'am' ? demodOverride || demod : 'am';
       const target = freqOverride ?? (m === 'dab' ? dabFreq : m === 'nfm' ? nfmFreq : m === 'am' ? hfFreq : m === 'meshtastic' ? meshtasticFreq : m === 'adsb' ? adsbFreq : freq);
       const player = m === 'meshtastic' || m === 'adsb' ? null : await ensurePlayer();
       if (player) player.setVolume(volume);
      let ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) ws = await openWs();
      const freqHz = Math.round(parseFloat(target) * 1e6);
      const dabServiceNow =
        serviceOverride !== undefined && serviceOverride !== '' ? serviceOverride : dabService;
      send({
        op: 'tune',
        mode: m,
        freq: freqHz,
        host,
        port: parseInt(port, 10),
        gain: gain.trim() === '' ? undefined : Number(gain),
        service: m === 'dab' ? dabServiceNow || undefined : undefined,
        squelch: m === 'nfm' ? squelch : 0,
        demod: dem,
      });
       if (player) player.start();
      playingRef.current = true;
      setPlaying(true);
      setStatus('Tuning…');
       setDabInfo(null);
       setDabSlide(null);
       if (m === 'meshtastic') setMeshtasticPackets([]);
       if (m === 'adsb') setAdsbAircraft([]);
       if (m === 'am') setCwText('');
      if (m === 'dab') setDabServices([]);
      if (spectrumRef.current) spectrumRef.current.clear();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      setBusy(false);
    }
  };

  const stop = async () => {
    playingRef.current = false;
    if (scanning) {
      setScanning(false);
      send({ op: 'scanStop' });
    }
    send({ op: 'stop' });
    if (playerRef.current) playerRef.current.stop();
    setPlaying(false);
    setStatus('Stopped');
    setDabInfo(null);
    setDabSlide(null);
    if (spectrumRef.current) spectrumRef.current.clear();
  };

  const tuneFreq = (mhz, m, service, { clear = true, demod: demodOverride } = {}) => {
    const m2 = m || mode;
    send({
      op: 'tune',
      mode: m2,
      freq: Math.round(parseFloat(mhz) * 1e6),
      service: service || undefined,
      squelch: m2 === 'nfm' ? squelch : 0,
      demod: m2 === 'am' ? demodOverride || demod : 'am',
    });
    if (m2 === 'dab') {
      setDabInfo(null);
      setDabSlide(null);
    } else if (clear) {
      // A fresh tune usually wipes the waterfall. Fine knob steps pass
      // clear:false so the display keeps scrolling instead of restarting.
      if (spectrumRef.current) spectrumRef.current.clear();
    }
    if (m2 === 'am') setCwText('');
  };
  tuneFreqRef.current = tuneFreq;

  const changeFreq = (e) => {
    setFreq(e.target.value);
    if (playingRef.current && mode === 'fm') tuneFreq(e.target.value, 'fm');
  };

  const changeDabChannel = (e) => {
    const name = e.target.value;
    const ch = DAB_CHANNELS.find(([n]) => n === name);
    if (!ch) return;
    setDabFreq(ch[1].toFixed(3));
    setDabService('');
    setDabServices([]);
    if (playingRef.current && mode === 'dab') tuneFreq(ch[1], 'dab');
  };

  const changeDabService = (e) => {
    const label = e.target.value;
    setDabService(label);
    if (playingRef.current && mode === 'dab') tuneFreq(dabFreq, 'dab', label);
  };

  const changeMode = (m) => {
    if (mode === m) return;
    if (scanning) {
      setScanning(false);
      send({ op: 'scanStop' });
    }
    setScanFound(null);
    setMode(m);
    loadPresets(m);
    setCwText('');
    if (m === 'am') setDemod('am'); // HF defaults to the AM demodulator
    if (playingRef.current) {
      tuneFreq(m === 'dab' ? dabFreq : m === 'nfm' ? nfmFreq : m === 'am' ? hfFreq : m === 'meshtastic' ? meshtasticFreq : m === 'adsb' ? adsbFreq : freq, m, m === 'dab' ? dabService : undefined);
    }
  };

  const changeNfmFreq = (e) => {
    setNfmFreq(e.target.value);
    if (playingRef.current && mode === 'nfm') tuneFreq(e.target.value, 'nfm');
  };

  const changeHfFreq = (e) => {
    setHfFreq(e.target.value);
    if (playingRef.current && mode === 'am') tuneFreq(e.target.value, 'am');
  };

  const setHfDemod = (d) => {
    setDemod(d);
    setCwText('');
    if (playingRef.current && mode === 'am') send({ op: 'demod', demod: d });
  };

  const changeMeshtasticFreq = (e) => {
    setMeshtasticFreq(e.target.value);
    if (playingRef.current && mode === 'meshtastic') tuneFreq(e.target.value, 'meshtastic');
  };

  const changeAdsbFreq = (e) => {
    setAdsbFreq(e.target.value);
    if (playingRef.current && mode === 'adsb') tuneFreq(e.target.value, 'adsb');
  };

  const changeGain = (e) => {
    const g = Number(e.target.value);
    setGain(String(g));
    if (playingRef.current) send({ op: 'gain', gain: g });
  };

  const changeSquelch = (e) => {
    const v = Number(e.target.value) / 5;
    setSquelch(v);
    send({ op: 'squelch', level: v });
  };

  const changeVolume = (e) => {
    setVolume(Number(e.target.value));
    if (playerRef.current) playerRef.current.setVolume(Number(e.target.value));
  };

  const addPreset = () => {
    const name = newName.trim();
    const cur = mode === 'dab' ? dabFreq : mode === 'nfm' ? nfmFreq : mode === 'am' ? hfFreq : mode === 'meshtastic' ? meshtasticFreq : mode === 'adsb' ? adsbFreq : freq;
    if (!name || !parseFloat(cur)) return;
    const next = sortPresets([
      ...presets,
      {
        name,
        freq: cur,
        mode,
        demod: mode === 'am' ? demod : undefined,
        service: mode === 'dab' ? dabService || undefined : undefined,
      },
    ]);
    setPresets(next);
    persistPresets(mode, next);
    setNewName('');
  };

  const removePreset = (i) => {
    const next = presets.filter((_, idx) => idx !== i);
    setPresets(next);
    persistPresets(mode, next);
  };

  const selectPreset = (p) => {
    const m = p.mode || 'fm';
    const dem = m === 'am' ? p.demod || 'am' : undefined;
    if (m === 'nfm') setNfmFreq(p.freq);
    else if (m === 'am') {
      setHfFreq(p.freq);
      setDemod(dem);
    } else if (m === 'meshtastic') setMeshtasticFreq(p.freq);
    else if (m === 'adsb') setAdsbFreq(p.freq);
    else if (m === 'dab') {
      setDabFreq(p.freq);
      setDabService(p.service || '');
    } else setFreq(p.freq);
    if (m !== mode) loadPresets(m);
    setMode(m);
    if (playingRef.current) {
      tuneFreq(p.freq, m, p.service, { demod: dem });
    } else {
      play(p.freq, m, p.service, dem);
    }
  };

  const dabChannel = mode === 'dab' ? dabChannelForMhz(parseFloat(dabFreq) || 216.928)[0] : null;

  // Fine-tune knob (NFM/AM): a native non-passive wheel listener so
  // preventDefault stops the page scrolling while tuning. Each ~100 wheel
  // units is one notch that steps the frequency by `tuneStep` Hz and turns
  // the knob by KNOB_DEG degrees.
  const KNOB_DEG = 9;
  useEffect(() => {
    const el = knobRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 16; // line-based wheels
      else if (e.deltaMode === 2) d *= 100; // page-based wheels
      wheelAccRef.current += d;
      const ticks = Math.trunc(wheelAccRef.current / 100);
      if (ticks === 0) return;
      wheelAccRef.current -= ticks * 100;
      const { mode: m, tuneStep: step, nfmFreq: nf, hfFreq: hf } = fineRef.current;
      const cur = m === 'nfm' ? nf : m === 'am' ? hf : null;
      if (cur === null) return;
      const hz = Math.round(parseFloat(cur) * 1e6);
      // HF band spans 0-30 MHz.
      const maxHz = m === 'am' ? 30_000_000 : 1_000_000_000;
      const next = Math.max(0, Math.min(maxHz, hz - ticks * step));
      const s = (next / 1e6).toFixed(4);
      if (m === 'nfm') {
        setNfmFreq(s);
        if (playingRef.current && tuneFreqRef.current) tuneFreqRef.current(s, 'nfm', undefined, { clear: false });
      } else {
        setHfFreq(s);
        if (playingRef.current && tuneFreqRef.current) tuneFreqRef.current(s, 'am', undefined, { clear: false });
      }
      setKnobAngle((a) => (((a - ticks * KNOB_DEG) % 360) + 360) % 360);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode]);

  const freqMatch = (a, b) => {
    const fa = parseFloat(a);
    const fb = parseFloat(b);
    return Number.isFinite(fa) && Number.isFinite(fb) && Math.abs(fa - fb) < 5e-4;
  };
  const currentFreq = mode === 'dab' ? dabFreq : mode === 'nfm' ? nfmFreq : mode === 'am' ? hfFreq : mode === 'meshtastic' ? meshtasticFreq : mode === 'adsb' ? adsbFreq : freq;
  const currentService = mode === 'dab' ? dabInfo?.service || dabService || '' : '';
  const isPlayingPreset = (p) => {
    if (!playing || !p.freq || !freqMatch(p.freq, currentFreq)) return false;
    if (mode === 'dab' && p.service) return currentService === p.service;
    return true;
  };

  // Is this scan result station the one currently being played? Mirrors
  // isPlayingPreset so clicking a station in the results list highlights it
  // the same way a clicked favourite does.
  const isPlayingScanService = (channel, serviceName) => {
    if (!playing || mode !== 'dab') return false;
    const freq = (channel.freqHz / 1e6).toFixed(3);
    if (!freqMatch(freq, currentFreq)) return false;
    return currentService === serviceName;
  };

  // Show the playing DAB station's logo (from the saved stations list, falling
  // back to the server-provided one) next to the station info.
  const activeLogo =
    mode === 'dab' && !dabSlide
      ? presets.find((p) => p.mode === 'dab' && p.logo && isPlayingPreset(p))?.logo || (dabLogo || null)
      : null;

  if (!authChecked) {
    return (
      <div className="card auth-card">
        <h1>ODV Project</h1>
        <div className="auth-loading">Checking session…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="card auth-card">
        <h1>ODV Project</h1>
        <form className="auth-form" onSubmit={submitAuth}>
          <div className="auth-tabs">
            <button
              type="button"
              className={authMode === 'login' ? 'active' : ''}
              onClick={() => {
                setAuthMode('login');
                setAuthError('');
              }}
            >
              Login
            </button>
            <button
              type="button"
              className={authMode === 'register' ? 'active' : ''}
              onClick={() => {
                setAuthMode('register');
                setAuthError('');
              }}
            >
              Register
            </button>
          </div>
          <label>
            Username
            <input
              value={authName}
              onChange={(e) => setAuthName(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={authPass}
              onChange={(e) => setAuthPass(e.target.value)}
              autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {authError && <div className="auth-error">{authError}</div>}
          <button className="primary" type="submit" disabled={authBusy}>
            {authBusy ? 'Please wait…' : authMode === 'login' ? 'Login' : 'Create account'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="topbar">
        <h1>ODV Project</h1>
        <div className="topbar-user">
          <span>{user}</span>
          <button onClick={logout}>Logout</button>
        </div>
      </div>

      <select
        className="mode-select"
        aria-label="Receiver mode"
        value={mode}
        onChange={(e) => changeMode(e.target.value)}
      >
        <option value="fm">FM</option>
        <option value="nfm">NFM</option>
        <option value="am">HF</option>
        <option value="dab">DAB</option>
        <option value="meshtastic">Meshtastic</option>
        <option value="adsb">ADS-B</option>
      </select>

      <div className="columns">
        <div className="col col-left">
          <div className="row">
            <label>
              rtl_tcp host
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.0.6" />
            </label>
            <label>
              port
              <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </label>
          </div>

          <label>
            RF gain (dB)
            <div className="gain-row">
              <input
                type="range"
                min="0"
                max="60"
                step="1"
                value={gain === '' ? 40 : Number(gain)}
                onChange={changeGain}
              />
              <span className="gain-value">{gain === '' ? '40' : gain} dB</span>
            </div>
          </label>

          {mode === 'fm' || mode === 'nfm' || mode === 'am' || mode === 'meshtastic' || mode === 'adsb' ? (
            <>
              <label>
                Frequency (MHz)
                <input
                  value={mode === 'nfm' ? nfmFreq : mode === 'am' ? hfFreq : mode === 'meshtastic' ? meshtasticFreq : mode === 'adsb' ? adsbFreq : freq}
                  onChange={mode === 'nfm' ? changeNfmFreq : mode === 'am' ? changeHfFreq : mode === 'meshtastic' ? changeMeshtasticFreq : mode === 'adsb' ? changeAdsbFreq : changeFreq}
                  placeholder={mode === 'nfm' ? '145.000' : mode === 'am' ? '0.000 – 30.000' : mode === 'meshtastic' ? '869.525' : mode === 'adsb' ? '1090.000' : '95.1'}
                  inputMode="decimal"
                />
              </label>
              {mode === 'nfm' && (
                <label>
                  Squelch
                  <div className="gain-row">
                    <input
                      type="range"
                      min="0"
                      max="5"
                      step="1"
                      value={Math.round(squelch * 5)}
                      onChange={changeSquelch}
                    />
                    <span className="gain-value">
                      {squelch === 0 ? 'Off' : `${Math.round(squelch * 5)}`}
                    </span>
                  </div>
                </label>
              )}
              {mode === 'meshtastic' && (
                <div className="meshtastic-settings">
                  <label>
                    Channel key
                    <select value={meshtasticKeyMode} onChange={(e) => setMeshtasticKeyMode(e.target.value)}>
                      <option value="default">Default key</option>
                      <option value="custom">Custom PSK</option>
                    </select>
                  </label>
                  {meshtasticKeyMode === 'custom' && (
                    <input
                      type="password"
                      value={meshtasticKey}
                      onChange={(e) => setMeshtasticKey(e.target.value)}
                      placeholder="Hex or Base64 PSK"
                    />
                  )}
                  <button onClick={saveMeshtasticKey}>Save channel key</button>
                  {meshtasticKeyStatus && <span className="meshtastic-key-status">{meshtasticKeyStatus}</span>}
                </div>
              )}
            </>
          ) : (
            <>
              <label>
                DAB channel
                <select value={dabChannel} onChange={changeDabChannel}>
                  {DAB_CHANNELS.map(([name, mhz]) => (
                    <option key={name} value={name}>
                      {name} — {mhz.toFixed(3)} MHz
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Station
                <select value={dabService} onChange={changeDabService} disabled={!dabServices.length}>
                  <option value="">First station found</option>
                  {[...dabServices]
                    .sort((a, b) => a.localeCompare(b))
                    .map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}

          <div className="row buttons">
            {!playing ? (
              <button className="primary" onClick={play} disabled={busy}>
                {busy ? 'Connecting…' : 'Play'}
              </button>
            ) : (
              <button onClick={stop}>Stop</button>
            )}
          </div>

          {mode === 'dab' && (
            <div className="scan">
              <div className="scan-title">
                DAB band scan
                <span className="scan-help">5A – 13F · 174–240 MHz</span>
              </div>
              {scanning ? (
                <div className="scan-progress">
                  <div className="scan-bar">
                    <div
                      className="scan-fill"
                      style={{ width: `${scanTotal ? (scanDone / scanTotal) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="scan-meta">
                    <span>{scanDone}/{scanTotal}</span>
                    <span>{scanProgress}</span>
                    <button onClick={stopScan} disabled={!scanning}>Stop</button>
                  </div>
                </div>
              ) : (
                <div className="scan-start">
                  <button className="primary" onClick={startDabScan} disabled={busy}>
                    Scan DAB band
                  </button>
                </div>
              )}
              {scanError && <div className="scan-error">{scanError}</div>}
              {dabScanResults.length > 0 && (
                <div className="dab-scan-results">
                  <div className="dab-scan-results-title">
                    {dabScanResults.reduce((a, c) => a + c.services.length, 0)} stations found
                  </div>
                  {dabScanResults.map((ch) => (
                    <div className="dab-scan-channel" key={ch.channel}>
                      <div className="dab-scan-channel-head">
                        <span className="dab-scan-channel-name">Channel {ch.channel}</span>
                        <span className="dab-scan-channel-freq">
                          {(ch.freqHz / 1e6).toFixed(3)} MHz{ch.ensemble ? ` · ${ch.ensemble}` : ''}
                        </span>
                      </div>
                      <div className="dab-scan-services">
                        {ch.services.map((s) => {
                          const fav = isDabFavourite(ch, s.name);
                          const playingNow = isPlayingScanService(ch, s.name);
                          return (
                            <div
                              className={`dab-scan-service${playingNow ? ' active' : ''}`}
                              key={s.name}
                            >
                              <button
                                className="dab-scan-service-tune"
                                onClick={() => {
                                  const f = (ch.freqHz / 1e6).toFixed(3);
                                  setDabFreq(f);
                                  setDabService(s.name);
                                  play(f, 'dab', s.name);
                                }}
                              >
                                <span className="dab-scan-service-name">{s.name}</span>
                                {s.sid && <span className="dab-scan-service-sid">SId {s.sid}</span>}
                              </button>
                              <button
                                className={`dab-scan-star${fav ? ' active' : ''}`}
                                onClick={() => toggleDabFavourite(ch, s)}
                                title={fav ? 'Remove from favourites' : 'Add to favourites'}
                              >
                                {fav ? '★' : '☆'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {(mode === 'fm' || mode === 'nfm') && (
            <div className="scan">
              <div className="scan-title">
                {mode === 'nfm' ? 'NFM band scan' : 'FM band scan'}
                <span className="scan-help">
                  {mode === 'nfm' ? NFM_BANDS[scanBand].label : '87.5–108 MHz'}
                </span>
              </div>
              {scanning ? (
                <div className="scan-progress">
                  <div className="scan-bar">
                    <div
                      className="scan-fill"
                      style={{ width: `${scanTotal ? (scanDone / scanTotal) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="scan-meta">
                    <span>{scanDone}/{scanTotal}</span>
                    <span>{scanProgress}</span>
                    <button onClick={stopScan} disabled={!scanning}>Stop</button>
                  </div>
                </div>
              ) : (
                <div className="scan-start">
                  {mode === 'nfm' && (
                    <select value={scanBand} onChange={(e) => setScanBand(e.target.value)}>
                      {Object.entries(NFM_BANDS).map(([key, b]) => (
                        <option key={key} value={key}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    value={scanSensitivity}
                    onChange={(e) => setScanSensitivity(e.target.value)}
                  >
                    <option value="high">High sensitivity</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low sensitivity</option>
                  </select>
                  <button className="primary" onClick={startScan} disabled={busy}>
                    {mode === 'nfm' ? 'Scan NFM band' : 'Scan FM band'}
                  </button>
                </div>
              )}
              {scanError && <div className="scan-error">{scanError}</div>}
            </div>
          )}

          {(mode === 'nfm' || mode === 'am') && (
            <div className="tune">
              <div className="tune-label">Manual tuning · {tuneStep / 1e6} MHz/step</div>
              <div className="tune-row">
                <div className="tune-knob" ref={knobRef} title="Scroll to tune">
                  <div className="tune-knob-indicator" style={{ transform: `rotate(${knobAngle}deg)` }} />
                </div>
                <div className="tune-steps">
                  {[100, 1_000, 10_000, 100_000].map((s) => (
                    <button
                      key={s}
                      className={`tune-step${tuneStep === s ? ' active' : ''}`}
                      onClick={() => setTuneStep(s)}
                    >
                      {s / 1e6} MHz
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {mode !== 'meshtastic' && mode !== 'adsb' && (
            <label>
              Volume
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={changeVolume}
              />
            </label>
          )}
        </div>

        <div className="col col-center">
          {mode === 'adsb' ? (
            <div className="adsb-panel">
              <div className="adsb-panel-head">
                <span>ADS-B · {currentFreq} MHz</span>
                <select value={adsbRange} onChange={(e) => setAdsbRange(Number(e.target.value))}>
                  <option value={25}>25 km</option>
                  <option value={50}>50 km</option>
                  <option value={100}>100 km</option>
                  <option value={200}>200 km</option>
                </select>
              </div>
              <AdsbMap
                aircraft={displayAircraft}
                homeLat={homeLat}
                homeLon={homeLon}
                rangeKm={adsbRange}
                selected={adsbSelected}
                onSelect={setAdsbSelected}
              />
              <AdsbTable aircraft={displayAircraft} selected={adsbSelected} onSelect={setAdsbSelected} />
            </div>
          ) : mode === 'fm' || mode === 'nfm' || mode === 'am' || mode === 'meshtastic' ? (
            <div className="waterfall-wrap">
              <div className="waterfall-title">
                {mode === 'meshtastic'
                  ? `Meshtastic LoRa · ${currentFreq} MHz`
                  : mode === 'nfm' || mode === 'am'
                  ? `Spectrum ±${(NFM_AM_VISIBLE_SPAN / 2 / 1e6).toFixed(2)} MHz around ${currentFreq} MHz`
                  : centerHz
                    ? `Spectrum ±${(span / 2 / 1e6).toFixed(2)} MHz around ${fmtMHz(centerHz)}`
                    : 'Spectrum —'}
              </div>
              <div className="waterfall-canvas">
                {mode === 'fm' ? (
                  <SpectrumAnalyzer ref={spectrumRef} bins={bins} height={160} />
                ) : (
                  <Waterfall
                    ref={spectrumRef}
                    bins={bins}
                    height={160}
                    span={span}
                    centerHz={centerHz}
                    freqHz={Math.round((parseFloat(currentFreq) || 0) * 1e6)}
                    visibleSpan={NFM_AM_VISIBLE_SPAN}
                  />
                )}
                {centerHz && (
                  <div
                    className="waterfall-marker"
                    style={{ left: mode === 'nfm' || mode === 'am' ? '50%' : `${tunePct}%` }}
                  />
                )}
              </div>
              <div className="waterfall-axis">
                {mode === 'nfm' || mode === 'am' || mode === 'meshtastic' ? (
                  <>
                    <span>{fmtMHz(Math.round((parseFloat(currentFreq) || 0) * 1e6) - NFM_AM_VISIBLE_SPAN / 2)}</span>
                    <span className="waterfall-center">{(parseFloat(currentFreq) || 0).toFixed(4)} MHz</span>
                    <span>{fmtMHz(Math.round((parseFloat(currentFreq) || 0) * 1e6) + NFM_AM_VISIBLE_SPAN / 2)}</span>
                  </>
                ) : (
                  <>
                    <span>{centerHz ? fmtMHz(centerHz - span / 2) : ''}</span>
                    <span className="waterfall-center">{centerHz ? fmtMHz(centerHz) : ''}</span>
                    <span>{centerHz ? fmtMHz(centerHz + span / 2) : ''}</span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="dab-panel">
              <div
                className={`dab-info${dabSlide ? ' has-slide' : ''}`}
                style={dabSlide ? { backgroundImage: `url(${dabSlide})` } : null}
              >
                {!dabSlide &&
                  (activeLogo ? (
                    <img className="dab-logo-img" src={activeLogo} alt={dabInfo?.service || ''} />
                  ) : (
                    <div className="dab-logo-placeholder">No logo</div>
                  ))}
                <div className="dab-info-text">
                  {dabInfo && dabInfo.ensemble ? (
                    <div className="dab-ensemble">{dabInfo.ensemble}</div>
                  ) : (
                    <div className="dab-ensemble dim">Waiting for ensemble…</div>
                  )}
                  <div className="dab-service">{dabInfo?.service || '—'}</div>
                  <div className="dab-meta">
                    {dabInfo?.channel ? `Channel ${dabInfo.channel}` : ''}
                    {dabInfo?.snr != null ? ` · SNR ${dabInfo.snr} dB` : ''}
                  </div>
                </div>
              </div>
            </div>
          )}

          {mode === 'meshtastic' && (
            <div className="meshtastic-panel">
              <div className="meshtastic-panel-title">Received packets</div>
              {meshtasticPackets.length === 0 ? (
                <div className="stations-empty">Waiting for Meshtastic traffic…</div>
              ) : (
                meshtasticPackets.map((packet) => (
                  <div className="meshtastic-packet" key={`${packet.src}-${packet.packetId}-${packet.timestamp}`}>
                    <div className="meshtastic-packet-head">
                      <strong>{packet.src}</strong>
                      <span>{packet.snr != null ? `SNR ${packet.snr} dB` : ''}{packet.rssi != null ? ` · RSSI ${packet.rssi} dBm` : ''}</span>
                    </div>
                    {packet.message && <div className="meshtastic-message">{packet.message}</div>}
                    {packet.position && (
                      <div className="meshtastic-detail">
                        Position {packet.position.latitude?.toFixed(5)}, {packet.position.longitude?.toFixed(5)}
                        {packet.position.altitude != null ? ` · ${packet.position.altitude} m` : ''}
                      </div>
                    )}
                    {packet.telemetry && (
                      <div className="meshtastic-detail">
                        Telemetry {packet.telemetry.voltage != null ? `${packet.telemetry.voltage.toFixed(2)} V` : ''}
                        {packet.telemetry.temperature != null ? ` · ${packet.telemetry.temperature.toFixed(1)} °C` : ''}
                        {packet.telemetry.relativeHumidity != null ? ` · ${packet.telemetry.relativeHumidity.toFixed(1)}% RH` : ''}
                      </div>
                    )}
                    {!packet.message && !packet.position && !packet.telemetry && (
                      <div className="meshtastic-detail">{packet.portName || 'Packet'} · {packet.hops}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {(mode === 'fm' || mode === 'nfm' || mode === 'am' || mode === 'dab') && (
            <div className="meters">
              <Meter label="Signal" value={stats.signal} />
              <Meter label="Audio" value={stats.audio} />
            </div>
          )}

          {mode === 'am' && demod === 'cw' && cwText && (
            <div className="cw-panel">
              <div className="cw-panel-title">CW decoded</div>
              <div className="cw-panel-text">{cwText}</div>
            </div>
          )}
        </div>

        {mode !== 'adsb' && (
          <div className="col col-right">
            {mode === 'am' && (
              <div className="demod-buttons">
                {['am', 'usb', 'lsb', 'cw'].map((d) => (
                  <button
                    key={d}
                    className={`demod-button${demod === d ? ' active' : ''}`}
                    onClick={() => setHfDemod(d)}
                  >
                    {d.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            <div className="stations">
              <div className="stations-title">{mode === 'dab' ? 'Favourites' : 'Stations'}</div>
            {presets.length === 0 && (
              <div className="stations-empty">
                {mode === 'dab'
                  ? 'No favourites yet — star stations from the DAB scan.'
                  : 'No saved stations yet.'}
              </div>
            )}
            {presets.map((p, i) => (
              <div className={`station${isPlayingPreset(p) ? ' active' : ''}`} key={i}>
                <button className={`station-tune${p.mode === 'dab' ? ' dab' : ''}`} onClick={() => selectPreset(p)}>
                  <span className="station-info">
                    {p.logo && (
                      <img className="station-logo" src={p.logo} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    )}
                    <span className="station-name">{p.name}</span>
                  </span>
                  {p.mode === 'dab' && p.service && (
                    <span className="station-service">{p.service}</span>
                  )}
                  <span className="station-freq">
                    {p.mode === 'dab'
                      ? `${dabChannelForMhz(parseFloat(p.freq) || 216.928)[0]} · ${p.freq} MHz`
                      : `${p.freq} MHz${p.mode === 'am' && p.demod ? ` · ${String(p.demod).toUpperCase()}` : ''}`}
                  </span>
                </button>
                <button className="station-del" onClick={() => removePreset(i)} title="Delete">
                  ✕
                </button>
              </div>
            ))}
            {mode !== 'dab' && (
              <div className="row">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addPreset()}
                  placeholder="Station name"
                />
                <button onClick={addPreset}>Save current</button>
              </div>
            )}
            </div>
          </div>
        )}
      </div>

      <div className={`status ${status.startsWith('Error') ? 'error' : ''}`}>{status}</div>

      {dabScanConfirm && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">Start a new DAB scan?</div>
            <div className="scan-modal-meta">
              This will delete the previous scan results and scan the DAB band again.
            </div>
            <div className="modal-actions">
              <button className="primary" onClick={runDabScan}>Scan again</button>
              <button onClick={() => setDabScanConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {scanFound && (
        <div className="modal-overlay">
          <div className="modal scan-modal">
            <div className="modal-title">Signal found</div>
            <div className="scan-modal-freq">{fmtHitFreq(scanFound.freq)} MHz</div>
            <div className="scan-modal-meta">
              Signal {(scanFound.signal * 100).toFixed(0)}%
              {mode === 'nfm' && scanNoiseFloor != null
                ? ` · noise floor ${Math.round(scanNoiseFloor * 100)}%`
                : ''}
            </div>
            <label>
              Station name
              <input
                value={scanName}
                onChange={(e) => setScanName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveScanHit()}
                placeholder={`${mode === 'nfm' ? 'NFM' : 'FM'} ${fmtHitFreq(scanFound.freq)} MHz`}
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button className="primary" onClick={saveScanHit}>Save & Continue</button>
              <button onClick={continueScan}>Continue</button>
              <button onClick={stopScan}>Stop scan</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Meter({ label, value }) {
  const pct = Math.max(0, Math.min(1, (value * 2.5) ** 0.6));
  const db = value > 0 ? (20 * Math.log10(value)).toFixed(0) : '-∞';
  return (
    <div className="meter">
      <div className="meter-label">{label}</div>
      <div className="meter-bar">
        <div className="meter-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="meter-db">{db} dBFS</div>
    </div>
  );
}
