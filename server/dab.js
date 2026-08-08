import { spawn } from 'node:child_process';

// ETSI EN 300 401 Band III DAB ensemble block centres (kHz).
// Matches the table used by eti-cmdline (band-handler.cpp).
const BAND_III = [
  ['5A', 174928], ['5B', 176640], ['5C', 178352], ['5D', 180064],
  ['6A', 181936], ['6B', 183648], ['6C', 185360], ['6D', 187072],
  ['7A', 188928], ['7B', 190640], ['7C', 192352], ['7D', 194064],
  ['8A', 195936], ['8B', 197648], ['8C', 199360], ['8D', 201072],
  ['9A', 202928], ['9B', 204640], ['9C', 206352], ['9D', 208064],
  ['10A', 209936], ['10B', 211648], ['10C', 213360], ['10D', 215072],
  ['11A', 216928], ['11B', 218640], ['11C', 220352], ['11D', 222064],
  ['12A', 223936], ['12B', 225648], ['12C', 227360], ['12D', 229072],
  ['13A', 230748], ['13B', 232496], ['13C', 234208], ['13D', 235776],
  ['13E', 237488], ['13F', 239200],
];

// Map a DAB frequency (Hz) to the nearest Band III channel block name.
export function channelBlockForFreq(freqHz) {
  const mhz = freqHz / 1000;
  let best = null;
  let bestDiff = Infinity;
  for (const [name, khz] of BAND_III) {
    const diff = Math.abs(mhz - khz);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = name;
    }
  }
  return best;
}

export function channelFreqKHz(name) {
  const hit = BAND_III.find(([n]) => n === name);
  return hit ? hit[1] : null;
}

const stripAnsi = (s) =>
  s
    .replace(/\u001b\]0;[^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\u001b\[[0-9]*[A-Za-z]/g, '')
    .trim();

// Decodes ETI (from eti-cmdline-rtl_tcp) to mono int16 PCM at 48kHz using dablin.
export class DabReceiver {
  constructor() {
    this.etiBin = process.env.ETI_CMDLINE_BIN || 'eti-cmdline-rtl_tcp';
    this.dablinBin = process.env.DABLIN_BIN || 'dablin';
    this.eti = null;
    this.dablin = null;
    this.onPcm = null;
    this.onInfo = null;
    this.running = false;
    this.freq = null;
    this.channel = null;
    this.gain = null;
    this.service = null;
    this.ensemble = null;
    this.snr = null;
    this.services = [];
    this.rate = null;
    this.channels = null;
    this.float32 = null;
    this._pcmBuf = Buffer.alloc(0);
    this._channelKey = null;
  }

  status() {
    return {
      running: this.running,
      freq: this.freq,
      channel: this.channel,
      gain: this.gain,
      service: this.service,
      ensemble: this.ensemble,
      snr: this.snr,
      services: this.services,
      rate: this.rate,
    };
  }

  start({ host, port, freqHz, gain = 40, service = null }) {
    this.stop();
    this.running = true;
    this.freq = freqHz;
    this.channel = channelBlockForFreq(freqHz);
    this.gain = gain;
    this.service = service;
    this.ensemble = null;
    this.snr = null;
    this._pcmBuf = Buffer.alloc(0);
    this._resetFormat();

    const channelKey = `${host}:${port}:${this.channel}`;
    if (channelKey !== this._channelKey) {
      this._channelKey = channelKey;
      this.services = [];
    }

    // eti-cmdline-rtl_tcp: IQ over rtl_tcp -> ETI-NI frames on stdout.
    // -Q forces manual tuner gain in eti-stuff's rtl_tcp reader, so the
    // requested -G value is actually applied instead of auto gain.
    const etiArgs = ['-H', host, '-I', String(port), '-B', 'BAND_III', '-C', this.channel, '-G', String(gain), '-Q'];
    const eti = spawn(this.etiBin, etiArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.eti = eti;

    eti.stderr.on('data', (d) => {
      if (this.eti !== eti) return;
      for (const line of String(d).split('\n')) {
        const clean = stripAnsi(line);
        const m = clean.match(/estimated snr:\s*(\d+)/);
        if (m) this.snr = Number(m[1]);
      }
      this._info(`eti: ${stripAnsi(String(d)).slice(0, 200)}`);
    });
    eti.on('error', (err) => {
      if (this.eti === eti) this._info(`eti-cmdline: ${err.message}`);
    });
    eti.on('exit', (code) => this._onExit(eti, 'eti-cmdline', code));

    // dablin: ETI -> PCM on stdout. -1 plays the first service found,
    // -l <label> plays a specific station chosen by the user.
    const dablinArgs = service ? ['-p', '-l', service] : ['-p', '-1'];
    const dablin = spawn(this.dablinBin, dablinArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.dablin = dablin;

    dablin.stderr.on('data', (d) => {
      if (this.dablin !== dablin) return;
      for (const line of String(d).split('\n')) {
        const clean = stripAnsi(line);
        const fm = clean.match(/PCMOutput: format set; samplerate: (\d+), channels: (\d+)(?:, output: ([\w ]+))?/);
        if (fm) this._setFormat(Number(fm[1]), Number(fm[2]), fm[3] ? fm[3].startsWith('32bit float') : true);
        const sl = clean.match(/service label '([^']+)'/);
        if (sl) this._addService(sl[1]);
        const el = clean.match(/ensemble label '([^']+)'/);
        if (el) this.ensemble = el[1];
      }
    });
    dablin.on('error', (err) => {
      if (this.dablin === dablin) this._info(`dablin: ${err.message}`);
    });
    dablin.on('exit', (code) => this._onExit(dablin, 'dablin', code));

    eti.stdout.pipe(dablin.stdin);
    dablin.stdout.on('data', (c) => {
      if (this.dablin !== dablin) return;
      this._onPcm(c);
    });
  }

  _addService(label) {
    if (this.services.includes(label)) return;
    this.services.push(label);
    if (!this.service) this.service = label;
  }

  _resetFormat() {
    this.rate = null;
    this.channels = null;
    this.float32 = null;
  }

  _setFormat(rate, channels, float32) {
    if (this.rate === rate && this.channels === channels && this.float32 === float32) return;
    this.rate = rate;
    this.channels = channels;
    this.float32 = float32;
    this._pcmBuf = Buffer.alloc(0);
    this._info(`pcm format: ${rate} Hz, ${channels} ch`);
  }

  _onPcm(chunk) {
    if (!this.onPcm) return;
    if (this.rate === null || this.channels === null) {
      this._pcmBuf = Buffer.concat([this._pcmBuf, chunk]);
      if (this._pcmBuf.length > 1024 * 1024) this._pcmBuf = Buffer.alloc(0);
      return;
    }
    this._pcmBuf = Buffer.concat([this._pcmBuf, chunk]);
    const { float32, channels } = this;
    const bytesPerSample = float32 ? 4 : 2;
    const frame = channels * bytesPerSample;
    const usable = this._pcmBuf.length - (this._pcmBuf.length % frame);
    if (usable === 0) return;
    const out = Buffer.allocUnsafe((usable / frame) * 2);
    for (let i = 0, o = 0; i < usable; i += frame, o += 2) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        const off = i + c * bytesPerSample;
        const v = float32 ? this._pcmBuf.readFloatLE(off) : this._pcmBuf.readInt16LE(off) / 32768;
        sum += v;
      }
      const m = sum / channels;
      let v = Math.round(m * 32767);
      v = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
      out.writeInt16LE(v, o);
    }
    this._pcmBuf = this._pcmBuf.subarray(usable);
    this.onPcm(new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2), this.rate);
  }

  _onExit(child, name, code) {
    const current = name === 'eti-cmdline' ? this.eti : this.dablin;
    if (current !== child) return;
    this.running = false;
    this._info(`${name} exited (${code})`);
  }

  _info(msg) {
    if (this.onInfo) this.onInfo(msg);
  }

  stop() {
    for (const child of [this.eti, this.dablin]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    this.eti = null;
    this.dablin = null;
    this._pcmBuf = Buffer.alloc(0);
    this.running = false;
  }
}
