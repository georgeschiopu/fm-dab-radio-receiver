import { useEffect, useRef, useState } from 'react';
import { AudioPlayer } from './audio.js';
import SpectrumAnalyzer from './SpectrumAnalyzer.jsx';
import Waterfall from './Waterfall.jsx';

// Presets are stored per mode and per user so FM / NFM station lists stay separate.
const presetKey = (user, m) => `sdr-${user}-${m}-stations`;

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
  const [amFreq, setAmFreq] = useState('7.100');
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
  const [scanHits, setScanHits] = useState([]);
  const [scanError, setScanError] = useState('');
  const [savePrompt, setSavePrompt] = useState(null);
  const [saveName, setSaveName] = useState('');
  const [dabInfo, setDabInfo] = useState(null);
  const [dabServices, setDabServices] = useState([]);
  const [dabService, setDabService] = useState('');
  const [dabSlide, setDabSlide] = useState(null);
  const [dabLogo, setDabLogo] = useState(null);
  const [presets, setPresets] = useState([]);
  const [newName, setNewName] = useState('');
  const [span, setSpan] = useState(288_000);
  const [bins, setBins] = useState(256);
  const [centerHz, setCenterHz] = useState(null);
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authName, setAuthName] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [tuneStep, setTuneStep] = useState(100_000);
  const [knobAngle, setKnobAngle] = useState(0);

  const wsRef = useRef(null);
  const playerRef = useRef(null);
  const spectrumRef = useRef(null);
  const playingRef = useRef(false);
  const presetsModeRef = useRef(null);
  const knobRef = useRef(null);
  const wheelAccRef = useRef(0);
  const tuneFreqRef = useRef(null);
  const fineRef = useRef({ mode: 'fm', tuneStep: 100_000, nfmFreq: '145.000', amFreq: '7.100' });
  fineRef.current = { mode, tuneStep, nfmFreq, amFreq };

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

  const enterApp = () => {
    setAuthChecked(true);
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
        if (cfg.amFreq) setAmFreq((cfg.amFreq / 1e6).toFixed(3));
        if (cfg.squelch !== undefined) setSquelch(cfg.squelch);
        loadPresets(cfg.mode || 'fm');
      })
      .catch(() => {
        setHost('192.168.0.6');
        setPort('1234');
        setFreq('95.1');
        setGain('40');
        setDabFreq('216.928');
        setNfmFreq('145.000');
        setAmFreq('7.100');
        setMode('fm');
        loadPresets('fm');
      });
  };

  useEffect(() => {
    fetch('/api/me')
      .then((r) => {
        if (!r.ok) throw new Error('not authenticated');
        return r.json();
      })
      .then((d) => {
        setUser(d.username);
        enterApp();
      })
      .catch(() => setAuthChecked(true));
    return () => {
      playingRef.current = false;
      if (wsRef.current) wsRef.current.close();
      if (playerRef.current) playerRef.current.close();
    };
  }, []);

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
      enterApp();
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
            if (msg.mode === 'dab') {
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
                setCenterHz(msg.freq);
              }
              if (playerRef.current) playerRef.current.setRate(msg.rate || 48000);
              if (msg.span) setSpan(msg.span);
              if (msg.bins) setBins(msg.bins);
            }
            setBusy(false);
          } else if (msg.type === 'error') {
            setStatus(`Error: ${msg.message}`);
            setBusy(false);
          } else if (msg.type === 'slide') {
            setDabSlide(msg.data ? `data:${msg.mime};base64,${msg.data}` : null);
          } else if (msg.type === 'scan') {
            if (msg.kind === 'started') {
              setScanTotal(msg.total || 0);
              setScanDone(0);
              setScanProgress('');
            } else if (msg.kind === 'progress') {
              setScanDone(msg.done || 0);
              setScanTotal(msg.total || 0);
              setScanProgress(msg.freq ? `${(msg.freq / 1e6).toFixed(1)} MHz` : '');
            } else if (msg.kind === 'done') {
              setScanning(false);
              setScanDone(msg.total || 0);
              if (msg.hits) setScanHits(msg.hits);
            } else if (msg.kind === 'error') {
              setScanError(msg.message || 'Scan failed');
              setScanning(false);
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

  const SCAN_SENSITIVITY = { high: 0.08, normal: 0.12, low: 0.18 };

  const startScan = async () => {
    if (mode !== 'fm' || scanning || busy) return;
    setScanning(true);
    setScanHits([]);
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
        start: 87_500_000,
        stop: 108_000_000,
        step: 100_000,
        threshold: SCAN_SENSITIVITY[scanSensitivity] || 0.12,
        dwell: 200,
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
    if (!scanning) return;
    setScanning(false);
    send({ op: 'scanStop' });
  };

  const playHit = (hit) => {
    play((hit.freq / 1e6).toFixed(1), 'fm');
  };

  const clearScanHits = () => {
    setScanHits([]);
    setScanDone(0);
    setScanTotal(0);
    setScanProgress('');
  };

  const saveHit = (hit) => {
    setSavePrompt(hit);
    setSaveName('');
  };

  const confirmSaveHit = () => {
    if (!savePrompt) return;
    const name = saveName.trim() || `FM ${(savePrompt.freq / 1e6).toFixed(1)} MHz`;
    const next = sortPresets([
      ...presets,
      { name, freq: (savePrompt.freq / 1e6).toFixed(1), mode: 'fm' },
    ]);
    setPresets(next);
    persistPresets('fm', next);
    setSavePrompt(null);
  };

  const play = async (freqOverride, modeOverride, serviceOverride) => {
    if (busy) return;
    if (scanning) {
      setScanning(false);
      send({ op: 'scanStop' });
    }
    setBusy(true);
    try {
      const m = modeOverride || mode;
      const target = freqOverride ?? (m === 'dab' ? dabFreq : m === 'nfm' ? nfmFreq : m === 'am' ? amFreq : freq);
      const player = await ensurePlayer();
      player.setVolume(volume);
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
      });
      player.start();
      playingRef.current = true;
      setPlaying(true);
      setStatus('Tuning…');
      setDabInfo(null);
      setDabSlide(null);
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

  const tuneFreq = (mhz, m, service, { clear = true } = {}) => {
    const m2 = m || mode;
    send({
      op: 'tune',
      mode: m2,
      freq: Math.round(parseFloat(mhz) * 1e6),
      service: service || undefined,
      squelch: m2 === 'nfm' ? squelch : 0,
    });
    if (m2 === 'dab') {
      setDabInfo(null);
      setDabSlide(null);
    } else if (clear) {
      // A fresh tune usually wipes the waterfall. Fine knob steps pass
      // clear:false so the display keeps scrolling instead of restarting.
      if (spectrumRef.current) spectrumRef.current.clear();
    }
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
    setMode(m);
    loadPresets(m);
    if (playingRef.current) {
      tuneFreq(m === 'dab' ? dabFreq : m === 'nfm' ? nfmFreq : m === 'am' ? amFreq : freq, m, m === 'dab' ? dabService : undefined);
    }
  };

  const changeNfmFreq = (e) => {
    setNfmFreq(e.target.value);
    if (playingRef.current && mode === 'nfm') tuneFreq(e.target.value, 'nfm');
  };

  const changeAmFreq = (e) => {
    setAmFreq(e.target.value);
    if (playingRef.current && mode === 'am') tuneFreq(e.target.value, 'am');
  };

  const changeGain = (e) => {
    const g = Number(e.target.value);
    setGain(String(g));
    if (playingRef.current) send({ op: 'gain', gain: g });
  };

  const changeSquelch = (e) => {
    const v = Number(e.target.value) / 100;
    setSquelch(v);
    send({ op: 'squelch', level: v });
  };

  const changeVolume = (e) => {
    setVolume(Number(e.target.value));
    if (playerRef.current) playerRef.current.setVolume(Number(e.target.value));
  };

  const addPreset = () => {
    const name = newName.trim();
    const cur = mode === 'dab' ? dabFreq : mode === 'nfm' ? nfmFreq : mode === 'am' ? amFreq : freq;
    if (!name || !parseFloat(cur)) return;
    const next = sortPresets([
      ...presets,
      { name, freq: cur, mode, service: mode === 'dab' ? dabService || undefined : undefined },
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
    if (m === 'nfm') setNfmFreq(p.freq);
    else if (m === 'am') setAmFreq(p.freq);
    else if (m === 'dab') {
      setDabFreq(p.freq);
      setDabService(p.service || '');
    } else setFreq(p.freq);
    if (m !== mode) loadPresets(m);
    setMode(m);
    if (playingRef.current) {
      tuneFreq(p.freq, m, p.service);
    } else {
      play(p.freq, m, p.service);
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
      const { mode: m, tuneStep: step, nfmFreq: nf, amFreq: af } = fineRef.current;
      const cur = m === 'nfm' ? nf : m === 'am' ? af : null;
      if (cur === null) return;
      const hz = Math.round(parseFloat(cur) * 1e6);
      const next = Math.max(0, Math.min(1_000_000_000, hz - ticks * step));
      const s = (next / 1e6).toFixed(3);
      if (m === 'nfm') {
        setNfmFreq(s);
        if (playingRef.current && tuneFreqRef.current) tuneFreqRef.current(s, 'nfm', undefined, { clear: false });
      } else {
        setAmFreq(s);
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
  const currentFreq = mode === 'dab' ? dabFreq : mode === 'nfm' ? nfmFreq : mode === 'am' ? amFreq : freq;
  const currentService = mode === 'dab' ? dabInfo?.service || dabService || '' : '';
  const isPlayingPreset = (p) => {
    if (!playing || !p.freq || !freqMatch(p.freq, currentFreq)) return false;
    if (mode === 'dab' && p.service) return currentService === p.service;
    return true;
  };

  if (!authChecked) {
    return (
      <div className="card auth-card">
        <h1>SDR Receiver</h1>
        <div className="auth-loading">Checking session…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="card auth-card">
        <h1>SDR Receiver</h1>
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
        <h1>SDR Receiver</h1>
        <div className="topbar-user">
          <span>{user}</span>
          <button onClick={logout}>Logout</button>
        </div>
      </div>

      <div className="mode-toggle">
        <button
          className={mode === 'fm' ? 'active' : ''}
          onClick={() => changeMode('fm')}
        >
          FM
        </button>
        <button
          className={mode === 'nfm' ? 'active' : ''}
          onClick={() => changeMode('nfm')}
        >
          NFM
        </button>
        <button
          className={mode === 'am' ? 'active' : ''}
          onClick={() => changeMode('am')}
        >
          AM
        </button>
        <button
          className={mode === 'dab' ? 'active' : ''}
          onClick={() => changeMode('dab')}
        >
          DAB
        </button>
      </div>

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

          {mode === 'fm' || mode === 'nfm' || mode === 'am' ? (
            <>
              <label>
                Frequency (MHz)
                <input
                  value={mode === 'nfm' ? nfmFreq : mode === 'am' ? amFreq : freq}
                  onChange={mode === 'nfm' ? changeNfmFreq : mode === 'am' ? changeAmFreq : changeFreq}
                  placeholder={mode === 'nfm' ? '145.000' : mode === 'am' ? '7.100' : '95.1'}
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
                      max="100"
                      step="1"
                      value={Math.round(squelch * 100)}
                      onChange={changeSquelch}
                    />
                    <span className="gain-value">
                      {squelch === 0 ? 'Off' : `${Math.round(squelch * 100)}`}
                    </span>
                  </div>
                </label>
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

          {mode === 'fm' && (
            <div className="scan">
              <div className="scan-title">
                FM band scan
                <span className="scan-help">87.5–108 MHz</span>
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
                  <select
                    value={scanSensitivity}
                    onChange={(e) => setScanSensitivity(e.target.value)}
                  >
                    <option value="high">High sensitivity</option>
                    <option value="normal">Normal</option>
                    <option value="low">Low sensitivity</option>
                  </select>
                  <button className="primary" onClick={startScan} disabled={busy}>
                    Scan FM band
                  </button>
                </div>
              )}
              {scanError && <div className="scan-error">{scanError}</div>}
              {scanHits.length > 0 && (
                <div className="scan-hits">
                  <div className="scan-hits-title">
                    <span>Found {scanHits.length} station{scanHits.length === 1 ? '' : 's'}</span>
                    <button className="scan-done" onClick={clearScanHits}>Done</button>
                  </div>
                  {scanHits.map((h, i) => (
                    <div className="scan-hit" key={i}>
                      <button
                        className={`scan-hit-tune${playing && freqMatch((h.freq / 1e6).toFixed(1), currentFreq) ? ' active' : ''}`}
                        onClick={() => playHit(h)}
                      >
                        <span className="station-name">{(h.freq / 1e6).toFixed(1)} MHz</span>
                        <span className="scan-hit-signal">{(h.signal * 100).toFixed(0)}%</span>
                      </button>
                      <button className="scan-hit-save" onClick={() => saveHit(h)} title="Save to stations">
                        +
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
                  {[10_000, 50_000, 100_000, 500_000].map((s) => (
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
        </div>

        <div className="col col-right">
          <div className="stations">
            <div className="stations-title">Stations</div>
            {presets.length === 0 && <div className="stations-empty">No saved stations yet.</div>}
            {presets.map((p, i) => (
              <div className={`station${isPlayingPreset(p) ? ' active' : ''}`} key={i}>
                <button className="station-tune" onClick={() => selectPreset(p)}>
                  <span className="station-info">
                    {p.logo && (
                      <img className="station-logo" src={p.logo} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                    )}
                    <span className="station-name">{p.name}</span>
                  </span>
                  <span className="station-freq">
                    {(p.mode === 'dab' && p.service ? `${p.service} · ` : '')}
                    {p.mode === 'dab' ? `${dabChannelForMhz(parseFloat(p.freq) || 216.928)[0]} (${p.freq} MHz)` : `${p.freq} MHz`}
                  </span>
                </button>
                <button className="station-del" onClick={() => removePreset(i)} title="Delete">
                  ✕
                </button>
              </div>
            ))}
            <div className="row">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPreset()}
                placeholder="Station name"
              />
              <button onClick={addPreset}>Save current</button>
            </div>
          </div>

          {mode === 'fm' || mode === 'nfm' || mode === 'am' ? (
            <div className="waterfall-wrap">
              <div className="waterfall-title">
                Spectrum {centerHz ? `±${(span / 2 / 1e6).toFixed(2)} MHz around ${fmtMHz(centerHz)}` : '—'}
              </div>
              <div className="waterfall-canvas">
                {mode === 'fm' ? (
                  <SpectrumAnalyzer ref={spectrumRef} bins={bins} height={160} />
                ) : (
                  <Waterfall ref={spectrumRef} bins={bins} height={160} />
                )}
                {centerHz && <div className="waterfall-marker" />}
              </div>
              <div className="waterfall-axis">
                <span>{centerHz ? fmtMHz(centerHz - span / 2) : ''}</span>
                <span className="waterfall-center">{centerHz ? fmtMHz(centerHz) : ''}</span>
                <span>{centerHz ? fmtMHz(centerHz + span / 2) : ''}</span>
              </div>
            </div>
          ) : (
            <div className="dab-panel">
              <div
                className={`dab-info${dabSlide ? ' has-slide' : ''}${dabLogo ? ' has-logo' : ''}`}
                style={dabSlide ? { backgroundImage: `url(${dabSlide})` } : null}
              >
                {dabLogo && !dabSlide && (
                  <img className="dab-logo" src={dabLogo} alt={dabInfo?.service || ''} />
                )}
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
          )}

          <div className="meters">
            <Meter label="Signal" value={stats.signal} />
            <Meter label="Audio" value={stats.audio} />
          </div>
        </div>
      </div>

      <div className={`status ${status.startsWith('Error') ? 'error' : ''}`}>{status}</div>

      {savePrompt && (
        <div className="modal-overlay" onClick={() => setSavePrompt(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              Save station {(savePrompt.freq / 1e6).toFixed(1)} MHz
            </div>
            <label>
              Name
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirmSaveHit()}
                placeholder={`FM ${(savePrompt.freq / 1e6).toFixed(1)}`}
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button className="primary" onClick={confirmSaveHit}>Save</button>
              <button onClick={() => setSavePrompt(null)}>Cancel</button>
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
