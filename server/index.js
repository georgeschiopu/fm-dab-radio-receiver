import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { AudioStreamManager } from './audioStream.js';
import { SlideWatcher } from './slides.js';
import { DEFAULT_SAMPLE_RATE } from './rtlTcp.js';
import { DEFAULT_BINS } from './spectrum.js';
import { getPresets, setPresets } from './presets.js';
import { presetLogo } from './fmLogos.js';
import {
  registerUser,
  loginUser,
  cookieUser,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Curated station -> logo map (label and SId keys). Served from /logos/.
const STATIONS_FILE = path.join(__dirname, 'stations.json');
let stationMap = { logos: {}, sids: {} };
try {
  stationMap = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
} catch (err) {
  console.warn(`[logo] could not read ${STATIONS_FILE}: ${err.message}`);
}
const LOGOS_DIR = path.join(__dirname, 'logos');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const normLogos = new Map();
for (const [label, file] of Object.entries(stationMap.logos || {})) normLogos.set(norm(label), file);

function logoFor(service, sid) {
  if (sid && stationMap.sids && stationMap.sids[sid]) {
    const file = normLogos.get(norm(stationMap.sids[sid]));
    if (file) return `/logos/${encodeURIComponent(file)}`;
  }
  if (service) {
    const file = normLogos.get(norm(service));
    if (file) return `/logos/${encodeURIComponent(file)}`;
  }
  return null;
}
const PORT = Number(process.env.PORT || 8080);
const DEFAULT_HOST = process.env.RTL_TCP_HOST || '192.168.0.6';
const DEFAULT_PORT = Number(process.env.RTL_TCP_PORT || 1234);
const DEFAULT_FREQ = Number(process.env.RTL_TCP_FREQ || 97_900_000);
const DEFAULT_GAIN = process.env.RTL_TCP_GAIN !== undefined ? Number(process.env.RTL_TCP_GAIN) : 40;
const DEFAULT_MODE = process.env.RTL_TCP_MODE || 'fm';
const DAB_DEFAULT_FREQ = Number(process.env.RTL_TCP_DAB_FREQ || 216_928_000);
const NFM_DEFAULT_FREQ = Number(process.env.RTL_TCP_NFM_FREQ || 145_000_000);
const AM_DEFAULT_FREQ = Number(process.env.RTL_TCP_AM_FREQ || 7_100_000);
const DAB_SAMPLE_RATE = 2_048_000;
const DIST_DIR = path.join(__dirname, '..', 'client', 'dist');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());

// Everything under /api (except register/login) requires a valid session.
function requireAuth(req, res, next) {
  const user = cookieUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

const manager = new AudioStreamManager();
manager.on('status', (s) => broadcast(statusMsg(s)));
manager.on('scan', (m) => broadcast({ type: 'scan', ...m }));
manager.on('error', (err) => broadcast({ type: 'error', message: err.message }));

// MOT slideshow covers written by dablin -> broadcast to clients as base64.
const slides = new SlideWatcher();
slides.on('slide', (s) =>
  broadcast({ type: 'slide', mime: s.mime, data: s.data.toString('base64') })
);
slides.start();

function clearSlides() {
  slides.clear();
  broadcast({ type: 'slide', data: null });
}

function statusMsg(s) {
  const st = s || manager.status();
  return {
    type: 'status',
    ...st,
    logo: st.mode === 'dab' ? logoFor(st.service, st.sid) : null,
    span: st.span ?? DEFAULT_SAMPLE_RATE,
    spanDab: DAB_SAMPLE_RATE,
    bins: DEFAULT_BINS,
  };
}

function sendBinary(buf) {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(buf, { binary: true });
  }
}

manager.onPcm = (pcm) => {
  const data = Buffer.allocUnsafe(2 + pcm.byteLength);
  data[0] = 0x01; // PCM Int16 LE
  data[1] = 0x00; // alignment pad
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(data, 2);
  sendBinary(data);
};

manager.onSpectrum = (line) => {
  const data = Buffer.allocUnsafe(3 + line.byteLength);
  data[0] = 0x02; // spectrum dB line
  data.writeUInt16LE(line.byteLength, 1);
  Buffer.from(line.buffer, line.byteOffset, line.byteLength).copy(data, 3);
  sendBinary(data);
};

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(text);
  }
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const r = registerUser(username, password);
  if (r.error) return res.status(400).json({ error: r.error });
  res.cookie(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });
  res.json({ ok: true, username: r.username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const r = loginUser(username, password);
  if (r.error) return res.status(401).json({ error: r.error });
  res.cookie(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });
  res.json({ ok: true, username: r.username });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user });
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    freq: DEFAULT_FREQ,
    gain: DEFAULT_GAIN,
    mode: DEFAULT_MODE,
    dabFreq: DAB_DEFAULT_FREQ,
    nfmFreq: NFM_DEFAULT_FREQ,
    amFreq: AM_DEFAULT_FREQ,
    squelch: 0,
  });
});

app.get('/api/presets', requireAuth, async (req, res) => {
  const mode = req.query.mode || 'fm';
  const presets = getPresets(req.user, mode);
  const withLogos = await Promise.allSettled(
    presets.map(async (p) => {
      const curated = logoFor(p.service, p.sid);
      const logo = curated || (await presetLogo(p));
      return { ...p, logo };
    })
  );
  res.json({
    mode,
    presets: withLogos.map((r) => (r.status === 'fulfilled' ? r.value : r.reason)),
  });
});

app.put('/api/presets', requireAuth, (req, res) => {
  const body = req.body || {};
  const mode = req.query.mode || body.mode || 'fm';
  res.json({ mode, presets: setPresets(req.user, mode, body.presets) });
});

app.use('/logos', express.static(LOGOS_DIR, { maxAge: '1h' }));
app.use(express.static(DIST_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => {
    if (err && err.code === 'ENOENT') {
      res.status(503).send('Client not built yet. Run: npm run build');
    }
  });
});

wss.on('connection', (ws, req) => {
  const user = cookieUser(req);
  if (!user) {
    ws.close(1008, 'Not authenticated');
    return;
  }
  ws.user = user;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.send(JSON.stringify(statusMsg()));

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.op === 'tune') {
      const freq = Math.round(Number(msg.freq));
      const host = msg.host || DEFAULT_HOST;
      const port = Number(msg.port || DEFAULT_PORT);
      const gain = msg.gain !== undefined && msg.gain !== '' ? Number(msg.gain) : DEFAULT_GAIN;
      const mode = msg.mode || 'fm';
      const service = msg.service !== undefined && msg.service !== '' ? String(msg.service) : null;
      if (!Number.isFinite(freq) || freq <= 0) return;
      if (msg.squelch !== undefined && Number.isFinite(Number(msg.squelch))) {
        manager.setSquelch(Number(msg.squelch));
      }
      clearSlides();
      try {
        if (
          !manager.running ||
          manager.host !== host ||
          manager.port !== port ||
          manager.mode !== mode ||
          !manager.connected
        ) {
          await manager.start({ mode, host, port, freq, gain, service });
        } else {
          manager.tune(freq, service);
          manager.setGain(gain);
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: `rtl_tcp: ${err.message}` }));
      }
    } else if (msg.op === 'gain') {
      const gain = msg.gain !== undefined && msg.gain !== '' ? Number(msg.gain) : DEFAULT_GAIN;
      if (Number.isFinite(gain)) manager.setGain(gain);
    } else if (msg.op === 'squelch') {
      const level = msg.level !== undefined ? Number(msg.level) : 0;
      if (Number.isFinite(level)) manager.setSquelch(level);
    } else if (msg.op === 'scan') {
      const mode = msg.mode === 'nfm' ? 'nfm' : msg.mode === 'dab' ? 'dab' : 'fm';
      const host = msg.host || DEFAULT_HOST;
      const port = Number(msg.port || DEFAULT_PORT);
      const gain = msg.gain !== undefined && msg.gain !== '' ? Number(msg.gain) : DEFAULT_GAIN;
      if (mode === 'dab') {
        try {
          if (
            !manager.running ||
            manager.host !== host ||
            manager.port !== port ||
            manager.mode !== mode ||
            !manager.connected
          ) {
            await manager.start({ mode, host, port, freq: DAB_DEFAULT_FREQ, gain });
          } else {
            manager.setGain(gain);
          }
          const result = manager.startDabScan({ dwellMs: msg.dwell });
          if (!result) ws.send(JSON.stringify({ type: 'scan', kind: 'error', message: 'Scan requires DAB mode and a connected rtl_tcp' }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'scan', kind: 'error', message: `rtl_tcp: ${err.message}` }));
        }
        return;
      }
      const start = Math.round(Number(msg.start));
      const stop = Math.round(Number(msg.stop));
      if (!Number.isFinite(start) || !Number.isFinite(stop) || start <= 0 || stop <= start) return;
      try {
        if (
          !manager.running ||
          manager.host !== host ||
          manager.port !== port ||
          manager.mode !== mode ||
          !manager.connected
        ) {
          await manager.start({ mode, host, port, freq: start, gain });
        } else {
          manager.setGain(gain);
        }
        const result = manager.startScan({
          startFreq: start,
          stopFreq: stop,
          stepHz: msg.step,
          threshold: msg.threshold,
          dwellMs: msg.dwell,
        });
        if (!result) ws.send(JSON.stringify({ type: 'scan', kind: 'error', message: 'Scan requires FM or NFM mode and a connected rtl_tcp' }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'scan', kind: 'error', message: `rtl_tcp: ${err.message}` }));
      }
    } else if (msg.op === 'scanContinue') {
      const r = manager.resumeScan();
      if (!r) ws.send(JSON.stringify({ type: 'scan', kind: 'error', message: 'No paused scan to continue' }));
    } else if (msg.op === 'scanStop') {
      const r = manager.stopScan();
      if (r) ws.send(JSON.stringify({ type: 'scan', kind: 'done', found: r.found, total: r.total, aborted: true }));
    } else if (msg.op === 'stop') {
      clearSlides();
      manager.stop();
    }
  });
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30000);

// live signal/audio meters
const statsTimer = setInterval(() => {
  if (manager.running && manager.connected) {
    broadcast(statusMsg());
  }
}, 500);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(statsTimer);
});

function shutdown() {
  manager.stop();
  slides.stop();
  clearInterval(heartbeat);
  clearInterval(statsTimer);
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`sdr-fm-receiver listening on :${PORT}`);
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.warn('client/dist not built - run: npm run build');
  }
});
