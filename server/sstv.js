// SSTV decoder for the demodulated NFM/SSB audio. Supports the two modes most
// often heard from amateur satellites: Robot 36 (VIS 8) and PD 120 (VIS 95).
// The 30 ms VIS header is always detected to find the frame start; a forced
// mode just overrides which mode the VIS value is interpreted as.
//
// An SSTV pixel is a tone: 1500 Hz = black, 2300 Hz = white (3.1372549 Hz per
// level) and 1200 Hz is horizontal sync. We recover the instantaneous audio
// frequency with a quadrature (I/Q) FM discriminator and average it over each
// pixel interval.

const FREQ_BLACK = 1500;
const FREQ_WHITE = 2300;
const FREQ_RANGE = FREQ_WHITE - FREQ_BLACK; // 800 Hz
const FREQ_SYNC = 1200;
const FREQ_VIS_START = 1900;
const TWO_PI = Math.PI * 2;

// VIS header timing (from the standard / PySSTV definition).
const VIS_LEADER = 0.300; // 1900 Hz
const VIS_BREAK = 0.010; // 1200 Hz
const VIS_START = 0.030; // 1200 Hz start bit
const VIS_BIT = 0.030; // per data/parity bit
const VIS_BITS_START = VIS_LEADER + VIS_BREAK + VIS_LEADER + VIS_START; // 0.640
const VIS_IMAGE_START = VIS_BITS_START + 8 * VIS_BIT + VIS_BIT; // 0.910

export const SSTV_MODES = {
  robot36: {
    key: 'robot36',
    name: 'Robot 36',
    vis: 8,
    width: 320,
    height: 240,
    layout: 'robot36',
    lineTime: 0.150,
    syncPulse: 0.009,
    yStart: 0.012, // luminance start relative to sync start
    cStart: 0.106, // chroma start relative to sync start
    pixelTime: 0.088 / 320,
    halfPixelTime: 0.044 / 320,
  },
  pd120: {
    key: 'pd120',
    name: 'PD 120',
    vis: 95,
    width: 640,
    height: 496,
    layout: 'pd120',
    lineTime: 0.50848, // 20 ms sync + 2.08 ms porch + 4 x 640 x 0.19 ms
    syncPulse: 0.020,
    pixelTime: 0.00019,
  },
};

const VIS_TO_MODE = { 8: 'robot36', 95: 'pd120' };

// Windowed-sinc low-pass used to isolate the +/-900 Hz baseband after the
// signal is mixed down to 1900 Hz.
function designLowpass(cutoffHz, sampleRate, taps) {
  const h = new Float64Array(taps);
  const fc = cutoffHz / sampleRate;
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - m;
    const sinc = n === 0 ? 2 * fc : Math.sin(TWO_PI * fc * n) / (Math.PI * n);
    const w =
      0.42 -
      0.5 * Math.cos((TWO_PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

export class SstvDecoder {
  constructor({ sampleRate = 48000, mode = 'auto', onFrame = null, onMode = null } = {}) {
    this.sampleRate = sampleRate;
    this.mode = mode; // 'auto' | 'robot36' | 'pd120'
    this.onFrame = onFrame;
    this.onMode = onMode;
    this.taps = 127;
    this.lp = designLowpass(900, sampleRate, this.taps);
    this.reset();
  }

  reset() {
    const taps = this.taps;
    this.iLine = new Float64Array(taps);
    this.qLine = new Float64Array(taps);
    this.linePos = 0;
    this.filled = 0;
    this.loPhase = 0;
    this.dLo = (TWO_PI * FREQ_VIS_START) / this.sampleRate;
    this.prevI = 0;
    this.prevQ = 0;
    this.havePrev = false;
    this.freq = new Float32Array(1 << 16);
    this.freqLen = 0;
    this.searchPos = 0;
    this.state = 'search';
    this.active = null; // active mode descriptor
    this.lineIndex = 0;
    this.nextLineStart = 0;
    this.width = 0;
    this.height = 0;
    this.imgY = null;
    this.imgC = null;
    this.imgCb = null;
    this.imgCr = null;
    this.rgba = null;
    this.lastEmit = 0;
    this.nextHeaderSearch = 0;
    this.done = false;
  }

  setMode(mode) {
    const m = mode === 'robot36' || mode === 'pd120' ? mode : 'auto';
    if (m === this.mode) return;
    this.mode = m;
    // A forced-mode change mid-frame restarts detection.
    if (this.state === 'decode') this._beginSearch(this.freqLen);
  }

  _pushFreq(v) {
    if (this.freqLen === this.freq.length) {
      const next = new Float32Array(this.freq.length * 2);
      next.set(this.freq);
      this.freq = next;
    }
    this.freq[this.freqLen++] = v;
  }

  // pcm: mono audio, Int16Array (the demodulator output) or Float32Array [-1,1].
  push(pcm) {
    const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
    const { lp, taps } = this;
    const iLine = this.iLine;
    const qLine = this.qLine;
    for (let n = 0; n < pcm.length; n++) {
      const x = pcm[n] * scale;
      const c = Math.cos(this.loPhase);
      const s = Math.sin(this.loPhase);
      iLine[this.linePos] = x * c;
      qLine[this.linePos] = -x * s;
      let si = 0;
      let sq = 0;
      let k = this.linePos;
      for (let j = 0; j < taps; j++) {
        si += lp[j] * iLine[k];
        sq += lp[j] * qLine[k];
        if (--k < 0) k = taps - 1;
      }
      this.linePos = (this.linePos + 1) % taps;
      if (this.filled < taps) this.filled++;
      this.loPhase += this.dLo;
      if (this.loPhase > TWO_PI) this.loPhase -= TWO_PI;

      if (this.filled >= taps) {
        if (this.havePrev) {
          const mag = si * si + sq * sq;
          if (mag < 1e-9) {
            // Near-silence: no meaningful carrier, report 0 Hz.
            this._pushFreq(0);
          } else {
            const re = si * this.prevI + sq * this.prevQ;
            const im = sq * this.prevI - si * this.prevQ;
            const dev = (Math.atan2(im, re) * this.sampleRate) / TWO_PI;
            this._pushFreq(FREQ_VIS_START + dev);
          }
        }
        this.prevI = si;
        this.prevQ = sq;
        this.havePrev = true;
      }
    }
    this._process();
  }

  _meanFreq(a, b) {
    const lo = Math.max(0, Math.floor(a));
    const hi = Math.min(this.freqLen, Math.ceil(b));
    if (hi <= lo) return 0;
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += this.freq[i];
    return sum / (hi - lo);
  }

  _process() {
    if (this.state === 'search') {
      if (this.freqLen > 4 * 60 * this.sampleRate) {
        // Give up on a 4-minute stretch of noise and start fresh.
        const keep = this.freqLen;
        this.freq = new Float32Array(1 << 16);
        this.freqLen = 0;
        this.searchPos = 0;
        void keep;
      }
      this._searchHeader();
    } else if (this.state === 'decode') {
      this._decode();
    }
  }

  _classAt(sample) {
    const m = this._meanFreq(sample, sample + Math.round(0.002 * this.sampleRate));
    if (m >= 1700 && m <= 2100) return 'H';
    if (m >= 1000 && m <= 1400) return 'L';
    return '.';
  }

  _searchHeader() {
    const fs = this.sampleRate;
    const step = Math.round(0.004 * fs);
    const need = Math.round(0.95 * fs);
    let p = this.searchPos;
    while (p + need < this.freqLen) {
      // Start of a leader (1900 Hz) run.
      if (this._classAt(p) !== 'H' || this._classAt(p - step) === 'H') {
        p += step;
        continue;
      }
      const h1 = this._runEnd(p, 'H', Math.round(0.45 * fs));
      const h1len = h1 - p;
      if (h1len < 0.22 * fs) {
        p = Math.max(h1, p + step);
        continue;
      }
      // Break, then the second leader.
      const bEnd = this._skipUntilClass(h1, 'H', Math.round(0.05 * fs));
      if (bEnd == null) {
        p = h1;
        continue;
      }
      const h2 = this._runEnd(bEnd, 'H', Math.round(0.45 * fs));
      if (h2 - bEnd < 0.22 * fs) {
        p = h2;
        continue;
      }
      // The bits start a fixed time after the first leader; read and validate.
      const bitsStart = p + Math.round(VIS_BITS_START * fs);
      const mode = this._readVis(bitsStart);
      if (mode) {
        this._beginDecode(mode, p + Math.round(VIS_IMAGE_START * fs));
        return;
      }
      this.searchPos = p + Math.round(VIS_IMAGE_START * fs);
      p = h2;
    }
    this.searchPos = Math.max(0, Math.min(p, this.freqLen - need));
  }

  _runEnd(start, cls, maxLen) {
    const step = Math.round(0.004 * this.sampleRate);
    let p = start;
    const limit = start + maxLen;
    while (p < limit && this._classAt(p) === cls) p += step;
    return Math.min(p, start + maxLen);
  }

  // Advance past the current class and a short transition, returning the sample
  // where `cls` starts again (or null if it doesn't within maxWait).
  _skipUntilClass(start, cls, maxWait) {
    const step = Math.round(0.002 * this.sampleRate);
    const limit = start + maxWait;
    let p = start;
    while (p < limit) {
      if (this._classAt(p) === cls) return p;
      p += step;
    }
    return null;
  }

  _readVis(bitsStart) {
    const fs = this.sampleRate;
    const bitLen = VIS_BIT * fs;
    const bits = [];
    for (let b = 0; b < 8; b++) {
      const m = this._meanFreq(bitsStart + b * bitLen + 4, bitsStart + (b + 1) * bitLen - 4);
      bits.push(m <= 1200 ? 1 : 0);
    }
    const ones = bits.slice(0, 7).reduce((a, v) => a + v, 0);
    if (bits[7] !== (ones % 2)) return null; // parity mismatch
    let value = 0;
    for (let i = 0; i < 7; i++) value |= bits[i] << i;
    if (this.mode !== 'auto') return SSTV_MODES[this.mode];
    return VIS_TO_MODE[value] ? SSTV_MODES[VIS_TO_MODE[value]] : null;
  }

  _beginSearch(fromSample) {
    this.state = 'search';
    this.active = null;
    this.searchPos = Math.max(0, fromSample | 0);
  }

  _beginDecode(mode, imageStart) {
    this.active = mode;
    this.state = 'decode';
    this.lineIndex = 0;
    this.nextLineStart = imageStart;
    this.width = mode.width;
    this.height = mode.height;
    const n = mode.width * mode.height;
    this.imgY = new Float32Array(n).fill(128);
    if (mode.layout === 'robot36') {
      this.imgC = new Float32Array(n).fill(128);
      this.imgCb = null;
      this.imgCr = null;
    } else {
      const half = (mode.width * mode.height) / 2;
      this.imgCb = new Float32Array(half).fill(128);
      this.imgCr = new Float32Array(half).fill(128);
      this.imgC = null;
    }
    this.rgba = new Uint8ClampedArray(n * 4);
    this.lastEmit = 0;
    if (this.onMode) this.onMode(mode.name);
  }

  _syncStart(approx, syncPulse) {
    const fs = this.sampleRate;
    const syncLen = syncPulse * fs;
    const lo = Math.max(0, Math.floor(approx - 0.03 * fs));
    const hi = Math.min(this.freqLen - 1, Math.floor(approx + 0.05 * fs));
    if (hi <= lo) return null;
    let bestStart = -1;
    let bestLen = 0;
    let runStart = -1;
    let cur = 0;
    for (let i = lo; i <= hi; i++) {
      const f = this.freq[i];
      if (f >= 1050 && f <= 1370) {
        if (cur === 0) runStart = i;
        cur++;
        if (cur > bestLen) {
          bestLen = cur;
          bestStart = runStart;
        }
      } else {
        cur = 0;
      }
    }
    if (bestLen < 0.5 * syncLen) return null;
    const center = bestStart + bestLen / 2;
    return center - syncLen / 2;
  }

  _pixel(sample, win) {
    const half = win / 2;
    return this._meanFreq(sample - half, sample + half);
  }

  _haveLine(mode) {
    return this.nextLineStart + mode.lineTime * this.sampleRate <= this.freqLen;
  }

  _decode() {
    const mode = this.active;
    const fs = this.sampleRate;
    while (this.lineIndex < mode.height && this._haveLine(mode)) {
      const sync = this._syncStart(this.nextLineStart, mode.syncPulse);
      if (sync == null) break;
      if (mode.layout === 'robot36') this._decodeRobotLine(mode, sync);
      else this._decodePdPeriod(mode, sync);
      this.nextLineStart = sync + mode.lineTime * fs;
      this._maybeEmit();
    }
    if (this.lineIndex >= mode.height) {
      this._emitFrame(true);
      this._beginSearch(this.freqLen);
    }
  }

  _decodeRobotLine(mode, sync) {
    const fs = this.sampleRate;
    const w = mode.width;
    const line = this.lineIndex;
    const yWin = Math.max(6, Math.round(mode.pixelTime * fs));
    const cWin = Math.max(6, Math.round(mode.halfPixelTime * fs));
    const yBase = line * w;
    for (let px = 0; px < w; px++) {
      const ys = sync + (mode.yStart + (px + 0.5) * mode.pixelTime) * fs;
      const cs = sync + (mode.cStart + (px + 0.5) * mode.halfPixelTime) * fs;
      this.imgY[yBase + px] = this._freqToByte(this._pixel(ys, yWin));
      this.imgC[yBase + px] = this._freqToByte(this._pixel(cs, cWin));
    }
    this.lineIndex++;
  }

  _decodePdPeriod(mode, sync) {
    const fs = this.sampleRate;
    const w = mode.width;
    const pair = this.lineIndex / 2; // period index
    const win = Math.max(4, Math.round(mode.pixelTime * fs));
    const y0Base = (pair * 2) * w;
    const y1Base = (pair * 2 + 1) * w;
    const cBase = pair * w;
    const y0Start = sync + (mode.syncPulse + 0.00208) * fs;
    const c0 = y0Start + w * mode.pixelTime * fs;
    const c1 = c0 + w * mode.pixelTime * fs;
    const y1Start = c1 + w * mode.pixelTime * fs;
    for (let px = 0; px < w; px++) {
      const p0 = y0Start + (px + 0.5) * mode.pixelTime * fs;
      const pb = c0 + (px + 0.5) * mode.pixelTime * fs;
      const pr = c1 + (px + 0.5) * mode.pixelTime * fs;
      const p1 = y1Start + (px + 0.5) * mode.pixelTime * fs;
      this.imgY[y0Base + px] = this._freqToByte(this._pixel(p0, win));
      this.imgY[y1Base + px] = this._freqToByte(this._pixel(p1, win));
      this.imgCb[cBase + px] = this._freqToByte(this._pixel(pb, win));
      this.imgCr[cBase + px] = this._freqToByte(this._pixel(pr, win));
    }
    this.lineIndex += 2;
  }

  _freqToByte(f) {
    const v = ((f - FREQ_BLACK) / FREQ_RANGE) * 255;
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  _maybeEmit() {
    if (this.freqLen - this.lastEmit >= 0.8 * this.sampleRate) this._emitFrame(false);
  }

  _emitFrame() {
    this.lastEmit = this.freqLen;
    const w = this.width;
    const h = this.height;
    const out = this.rgba;
    if (this.active.layout === 'robot36') {
      for (let y = 0; y < h; y++) {
        const even = (y & 1) === 0;
        for (let x = 0; x < w; x++) {
          const Y = this.imgY[y * w + x];
          const own = this.imgC[y * w + x];
          let Cb = 128;
          let Cr = 128;
          if (even) {
            Cr = own;
            if (y + 1 < h) Cb = this.imgC[(y + 1) * w + x];
          } else {
            Cb = own;
            if (y - 1 >= 0) Cr = this.imgC[(y - 1) * w + x];
          }
          this._writeRgb(out, (y * w + x) * 4, Y, Cb, Cr);
        }
      }
    } else {
      const rows = h / 2;
      for (let p = 0; p < rows; p++) {
        const Cb = this.imgCb;
        const Cr = this.imgCr;
        for (let x = 0; x < w; x++) {
          const cb = Cb[p * w + x];
          const cr = Cr[p * w + x];
          const y0 = this.imgY[(p * 2) * w + x];
          const y1 = this.imgY[(p * 2 + 1) * w + x];
          this._writeRgb(out, ((p * 2) * w + x) * 4, y0, cb, cr);
          this._writeRgb(out, ((p * 2 + 1) * w + x) * 4, y1, cb, cr);
        }
      }
    }
    if (this.onFrame) {
      this.onFrame({ pixels: out, width: w, height: h, mode: this.active.name });
    }
  }

  _writeRgb(out, o, Y, Cb, Cr) {
    const cb = Cb - 128;
    const cr = Cr - 128;
    out[o] = clampByte(Y + 1.402 * cr);
    out[o + 1] = clampByte(Y - 0.344136 * cb - 0.714136 * cr);
    out[o + 2] = clampByte(Y + 1.772 * cb);
    out[o + 3] = 255;
  }
}
