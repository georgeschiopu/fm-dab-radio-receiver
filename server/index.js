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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DEFAULT_HOST = process.env.RTL_TCP_HOST || '192.168.0.6';
const DEFAULT_PORT = Number(process.env.RTL_TCP_PORT || 1234);
const DEFAULT_FREQ = Number(process.env.RTL_TCP_FREQ || 97_900_000);
const DEFAULT_GAIN = process.env.RTL_TCP_GAIN !== undefined ? Number(process.env.RTL_TCP_GAIN) : 40;
const DEFAULT_MODE = process.env.RTL_TCP_MODE || 'fm';
const DAB_DEFAULT_FREQ = Number(process.env.RTL_TCP_DAB_FREQ || 216_928_000);
const DAB_SAMPLE_RATE = 2_048_000;
const DIST_DIR = path.join(__dirname, '..', 'client', 'dist');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const manager = new AudioStreamManager();
manager.on('status', (s) => broadcast(statusMsg(s)));
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
  return {
    type: 'status',
    ...(s || manager.status()),
    span: DEFAULT_SAMPLE_RATE,
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

app.get('/api/config', (req, res) => {
  res.json({
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    freq: DEFAULT_FREQ,
    gain: DEFAULT_GAIN,
    mode: DEFAULT_MODE,
    dabFreq: DAB_DEFAULT_FREQ,
  });
});

app.use(express.static(DIST_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => {
    if (err && err.code === 'ENOENT') {
      res.status(503).send('Client not built yet. Run: npm run build');
    }
  });
});

wss.on('connection', (ws) => {
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
