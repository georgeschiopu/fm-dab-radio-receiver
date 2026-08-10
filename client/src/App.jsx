import { useEffect, useRef, useState } from 'react';
import { AudioPlayer } from './audio.js';
import SpectrumAnalyzer from './SpectrumAnalyzer.jsx';
import Waterfall from './Waterfall.jsx';

// Presets are stored per mode so FM / NFM station lists stay separate.
const presetKey = (m) => `sdr-${m}-stations`;

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
  const [volume, setVolume] = useState(0.8);
  const [status, setStatus] = useState('Idle');
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ signal: 0, audio: 0 });
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

  const wsRef = useRef(null);
  const playerRef = useRef(null);
  const spectrumRef = useRef(null);
  const playingRef = useRef(false);

  const loadPresets = (m) => {
    try {
      const saved = JSON.parse(localStorage.getItem(presetKey(m)) || '[]');
      if (Array.isArray(saved)) setPresets(saved);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
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
    return () => {
      playingRef.current = false;
      if (wsRef.current) wsRef.current.close();
      if (playerRef.current) playerRef.current.close();
    };
  }, []);

  const persistPresets = (m, list) => {
    try {
      localStorage.setItem(presetKey(m), JSON.stringify(list));
    } catch {
      /* ignore */
    }
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

  const play = async (freqOverride, modeOverride, serviceOverride) => {
    if (busy) return;
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
    send({ op: 'stop' });
    if (playerRef.current) playerRef.current.stop();
    setPlaying(false);
    setStatus('Stopped');
    setDabInfo(null);
    setDabSlide(null);
    if (spectrumRef.current) spectrumRef.current.clear();
  };

  const tuneFreq = (mhz, m, service) => {
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
    } else {
      if (spectrumRef.current) spectrumRef.current.clear();
    }
  };

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
    const next = [...presets, { name, freq: cur, mode, service: mode === 'dab' ? dabService || undefined : undefined }];
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

  return (
    <div className="card">
      <h1>SDR Receiver</h1>

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
              <div className="station" key={i}>
                <button className="station-tune" onClick={() => selectPreset(p)}>
                  <span className="station-name">{p.name}</span>
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
