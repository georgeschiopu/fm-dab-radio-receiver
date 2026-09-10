// RTTY (radioteletype) decoder for the demodulated SSB audio. RTTY is 2-FSK: a
// "mark" and a "space" tone (typically 170 Hz apart) keyed at 45.45 baud using
// the ITA2 (Baudot) alphabet — one start bit (space), five data bits, and 1.5
// stop bits (mark). The SSB receiver turns the two RF tones into two audio
// tones; this decoder auto-detects that tone pair, recovers the bit stream with
// a start-bit synchroniser, and decodes ITA2 text. Mark/space polarity and bit
// order vary between stations, so both are resolved from a short trial decode.

const BAUD = 45.45;
const SHIFT = 170;
const TEXT_MAX = 400;
const DETECT_SEC = 1.0; // audio buffered before the tone pair is detected
const WIN_MS = 8; // mark/space correlation window
const STEP_MS = 1; // decision update interval
const TONE_MIN = 400;
const TONE_MAX = 3200;
const TONE_STEP = 10;

// ITA2 code keyed by the five data bits in transmission order (first bit sent).
export const ITA2_LTRS = {
  '00011': 'A', '11001': 'B', '01110': 'C', '01001': 'D', '00001': 'E',
  '01101': 'F', '11010': 'G', '10100': 'H', '00110': 'I', '01011': 'J',
  '01111': 'K', '10010': 'L', '11100': 'M', '01100': 'N', '11000': 'O',
  '10110': 'P', '10111': 'Q', '01010': 'R', '00101': 'S', '10000': 'T',
  '00111': 'U', '11110': 'V', '10011': 'W', '11101': 'X', '10101': 'Y',
  '10001': 'Z',
};

export const ITA2_FIGS = {
  '00011': '-', '11001': '?', '01110': ':', '01001': '$', '00001': '3',
  '01101': '!', '11010': '&', '10100': '#', '00110': '8', '01011': "'",
  '01111': '(', '10010': ')', '11100': '.', '01100': ',', '11000': '9',
  '10110': '0', '10111': '1', '01010': '4', '00101': "'", '10000': '5',
  '00111': '7', '11110': ';', '10011': '2', '11101': '/', '10101': '6',
  '10001': '"',
};

const LTRS = '11111';
const FIGS = '11011';
const SPACE = '00100';
const CR = '01000';
const LF = '00010';

// Recover characters from a stream of 0/1 bit decisions (one per STEP_MS tick).
class BitSync {
  constructor(bitTicks, reverseBits, lagTicks = 0.5) {
    this.bitTicks = bitTicks;
    this.reverseBits = reverseBits;
    this.lagTicks = lagTicks;
    this.reset();
  }

  reset() {
    this.sampling = false;
    this.last = 1; // idle line rests at mark
    this.bits = [];
    this.sampleAt = 0;
    this.figure = false;
    this.text = '';
    this.valid = 0;
  }

  // decision: 0/1 for this tick. Returns a character when one is completed.
  push(decision, tick) {
    let ch = null;
    if (!this.sampling) {
      // A mark -> space edge marks the start bit.
      if (this.last === 1 && decision === 0) {
        this.sampling = true;
        this.bits = [];
        this.sampleAt = tick - this.lagTicks + 1.5 * this.bitTicks;
      }
    } else if (tick + 0.5 >= this.sampleAt) {
      this.bits.push(decision);
      this.sampleAt += this.bitTicks;
      if (this.bits.length === 6) {
        this.sampling = false;
        const stop = this.bits[5];
        if (stop === 1) {
          this.valid++;
          ch = this._decode(this.bits.slice(0, 5));
        }
        this.bits = [];
      }
    }
    this.last = decision;
    return ch;
  }

  _decode(bits) {
    let code = bits.join('');
    if (this.reverseBits) code = code.split('').reverse().join('');
    if (code === LTRS) {
      this.figure = false;
      return null;
    }
    if (code === FIGS) {
      this.figure = true;
      return null;
    }
    let ch;
    if (code === SPACE) ch = ' ';
    else if (code === CR || code === LF) ch = '\n';
    else ch = (this.figure ? ITA2_FIGS : ITA2_LTRS)[code];
    if (!ch) return null;
    this.text += ch;
    if (this.text.length > TEXT_MAX) this.text = this.text.slice(-TEXT_MAX);
    return ch;
  }
}

// Cross-correlate a window against a tone, returning the power (I^2+Q^2).
function tonePower(win, cos, sin) {
  let c = 0;
  let s = 0;
  for (let k = 0; k < win.length; k++) {
    const v = win[k];
    c += v * cos[k];
    s += v * sin[k];
  }
  return c * c + s * s;
}

function toneTables(freq, sampleRate, n) {
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let k = 0; k < n; k++) {
    cos[k] = Math.cos(w * k);
    sin[k] = Math.sin(w * k);
  }
  return { cos, sin };
}

export class RttyDecoder {
  constructor({ sampleRate = 48_000, baud = BAUD, shift = SHIFT, onText = null } = {}) {
    this.sampleRate = sampleRate;
    this.baud = baud;
    this.bitLen = sampleRate / baud;
    this.shift = shift;
    this.onText = onText;
    this.winLen = Math.max(16, Math.round((sampleRate * WIN_MS) / 1000));
    this.stepLen = Math.max(1, Math.round((sampleRate * STEP_MS) / 1000));
    this.bitTicks = this.bitLen / this.stepLen;
    this.detectLen = Math.round(sampleRate * DETECT_SEC);
    this.reset();
  }

  reset() {
    this.text = '';
    this.locked = false;
    this.detect = [];
    this.ring = new Float64Array(this.winLen);
    this.ringPos = 0;
    this.ringFilled = 0;
    this.stepAcc = 0;
    this.tick = 0;
    this.markFreq = 0;
    this.spaceFreq = 0;
    this.invert = false;
    this.reverseBits = false;
    this.tables = null;
    this.sync = null;
  }

  // pcm: mono audio (Int16Array from the SSB decoder, or Float32/64 in [-1,1]).
  push(pcm) {
    const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] * scale;
      if (!this.locked) {
        this.detect.push(v);
        if (this.detect.length >= this.detectLen) this._lock();
      } else {
        this._pushSample(v);
      }
    }
  }

  // Streaming path for one sample once the tone pair is locked.
  _pushSample(v) {
    this.ring[this.ringPos++] = v;
    if (this.ringPos >= this.winLen) this.ringPos = 0;
    if (this.ringFilled < this.winLen) this.ringFilled++;
    this.stepAcc++;
    if (this.stepAcc >= this.stepLen) {
      this.stepAcc = 0;
      if (this.ringFilled === this.winLen) {
        const diff = this._ringDiff();
        let d = diff > 0 ? 1 : 0;
        if (this.invert) d = d ? 0 : 1;
        const ch = this.sync.push(d, this.tick++);
        if (ch !== null) this._emit();
      }
    }
  }

  flush() {
    this._emit();
  }

  _emit() {
    if (this.sync) {
      this.text = this.sync.text;
      if (this.onText) this.onText(this.text);
    }
  }

  // Average power spectrum (Welch over 10 ms windows) to find the FSK tone pair.
  _detectTones(samples) {
    const fs = this.sampleRate;
    const nWin = Math.max(64, Math.round(fs * 0.01));
    const freqs = [];
    for (let f = TONE_MIN; f <= TONE_MAX; f += TONE_STEP) freqs.push(f);
    const tables = freqs.map((f) => toneTables(f, fs, nWin));
    const power = new Float64Array(freqs.length);
    for (let start = 0; start + nWin <= samples.length; start += nWin) {
      const win = samples.subarray(start, start + nWin);
      for (let fi = 0; fi < freqs.length; fi++) {
        power[fi] += tonePower(win, tables[fi].cos, tables[fi].sin);
      }
    }
    let p1 = 0;
    for (let fi = 1; fi < freqs.length; fi++) if (power[fi] > power[p1]) p1 = fi;
    const f1 = freqs[p1];
    const lo = f1 - 1.8 * this.shift;
    const hi = f1 + 1.8 * this.shift;
    const skipLo = f1 - 0.5 * this.shift;
    const skipHi = f1 + 0.5 * this.shift;
    let p2 = -1;
    for (let fi = 0; fi < freqs.length; fi++) {
      const f = freqs[fi];
      if (f < lo || f > hi) continue;
      if (f > skipLo && f < skipHi) continue;
      if (p2 === -1 || power[fi] > power[p2]) p2 = fi;
    }
    if (p2 === -1) return null;
    const f2 = freqs[p2];
    const sep = Math.abs(f1 - f2);
    if (sep < 0.5 * this.shift || sep > 1.9 * this.shift) return null;
    return f1 < f2 ? { lo: f1, hi: f2 } : { lo: f2, hi: f1 };
  }

  _lock() {
    const samples = Float64Array.from(this.detect);
    const tones = this._detectTones(samples);
    if (!tones) {
      // No pair found yet: keep the tail and try again with fresh audio.
      this.detect = this.detect.slice(-Math.floor(this.detectLen / 2));
      return;
    }
    this.markFreq = tones.lo;
    this.spaceFreq = tones.hi;
    const best = this._pickSettings(samples, tones.lo, tones.hi);
    this.invert = best.invert;
    this.reverseBits = best.reverseBits;
    this.lagTicks = best.lagTicks;
    this.tables = {
      mark: toneTables(tones.lo, this.sampleRate, this.winLen),
      space: toneTables(tones.hi, this.sampleRate, this.winLen),
    };
    this.sync = new BitSync(this.bitTicks, this.reverseBits, this.lagTicks);
    this.locked = true;
    // Replay the detection buffer through the streaming path so the characters
    // it contains are decoded (and no audio is lost at the lock boundary).
    const buffered = this.detect;
    this.detect = [];
    this.ring = new Float64Array(this.winLen);
    this.ringPos = 0;
    this.ringFilled = 0;
    this.stepAcc = 0;
    this.tick = 0;
    for (let i = 0; i < buffered.length; i++) this._pushSample(buffered[i]);
    this._emit();
  }

  // Trial-decode the detection buffer under both polarities and bit orders,
  // across a few start-edge lags (the correlation window delays the detected
  // edge), and keep whichever recovers the most valid characters.
  _pickSettings(samples, lo, hi) {
    const mark = toneTables(lo, this.sampleRate, this.winLen);
    const space = toneTables(hi, this.sampleRate, this.winLen);
    const diffs = [];
    for (let start = 0; start + this.winLen <= samples.length; start += this.stepLen) {
      const win = samples.subarray(start, start + this.winLen);
      diffs.push(tonePower(win, mark.cos, mark.sin) - tonePower(win, space.cos, space.sin));
    }
    const lag0 = this.winLen / (2 * this.stepLen);
    const lags = [0.5, lag0 * 0.5, lag0, lag0 * 1.5].map((l) => Math.round(l * 2) / 2);
    let best = null;
    for (const invert of [false, true]) {
      for (const reverseBits of [false, true]) {
        for (const lagTicks of lags) {
          const sync = new BitSync(this.bitTicks, reverseBits, lagTicks);
          for (let i = 0; i < diffs.length; i++) {
            let d = diffs[i] > 0 ? 1 : 0;
            if (invert) d = d ? 0 : 1;
            sync.push(d, i);
          }
          if (!best || sync.valid > best.valid) {
            best = { invert, reverseBits, lagTicks, valid: sync.valid, text: sync.text };
          }
        }
      }
    }
    return best;
  }

  _ringDiff() {
    const { winLen, ring, ringPos } = this;
    const mark = this.tables.mark;
    const space = this.tables.space;
    let c1 = 0;
    let s1 = 0;
    let c2 = 0;
    let s2 = 0;
    let p = ringPos; // ringPos points at the oldest sample
    for (let k = 0; k < winLen; k++) {
      const v = ring[p];
      c1 += v * mark.cos[k];
      s1 += v * mark.sin[k];
      c2 += v * space.cos[k];
      s2 += v * space.sin[k];
      p++;
      if (p >= winLen) p = 0;
    }
    return c1 * c1 + s1 * s1 - (c2 * c2 + s2 * s2);
  }
}
