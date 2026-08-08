import { DEFAULT_SAMPLE_RATE } from './rtlTcp.js';

export const DEFAULT_BINS = 256;
export const DB_MIN = -120;
export const DB_STEP = 0.5; // dB per byte

export class SpectrumAnalyzer {
  constructor({ fftSize = 2048, bins = DEFAULT_BINS, sampleRate = DEFAULT_SAMPLE_RATE, fps = 20 } = {}) {
    if (fftSize % bins !== 0) throw new Error(`fftSize ${fftSize} must be a multiple of bins ${bins}`);
    this.fftSize = fftSize;
    this.bins = bins;
    this.sampleRate = sampleRate;
    this.onSpectrum = null;
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.win = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
    this.pos = 0;
    this.group = fftSize / bins;
    this.avgCount = Math.max(1, Math.round((sampleRate / fftSize) / fps));
    this.acc = new Float64Array(bins);
    this.accCount = 0;
    this.line = new Uint8Array(bins);
    this.dbRef = 10 * Math.log10((fftSize / 2) * (fftSize / 2));
  }

  reset() {
    this.re.fill(0);
    this.im.fill(0);
    this.pos = 0;
    this.acc.fill(0);
    this.accCount = 0;
  }

  // chunk: Node Buffer of interleaved unsigned 8-bit I/Q
  push(chunk) {
    const n = chunk.length >>> 1;
    const { fftSize } = this;
    const re = this.re;
    const im = this.im;
    let idx = 0;
    for (let s = 0; s < n; s++) {
      re[this.pos] = (chunk[idx] - 127.5) / 127.5;
      im[this.pos] = (chunk[idx + 1] - 127.5) / 127.5;
      idx += 2;
      this.pos++;
      if (this.pos === fftSize) {
        this.pos = 0;
        this._block();
      }
    }
  }

  _fft() {
    const n = this.fftSize;
    const re = this.re;
    const im = this.im;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cwr = 1;
        let cwi = 0;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
          const vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + half] = ur - vr;
          im[i + k + half] = ui - vi;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
    }
  }

  _block() {
    const { fftSize, group, bins, win } = this;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < fftSize; i++) {
      re[i] *= win[i];
      im[i] *= win[i];
    }
    this._fft();
    const acc = this.acc;
    const dbRef = this.dbRef;
    const half = bins / 2;
    for (let d = 0; d < bins; d++) {
      // reorder FFT bins: -fs/2 (left) .. DC (center) .. +fs/2 (right)
      const k0 = ((d + half) % bins) * group;
      let power = 0;
      for (let k = k0; k < k0 + group; k++) {
        const r = re[k];
        const i = im[k];
        power += r * r + i * i;
      }
      acc[d] += 10 * Math.log10(power + 1e-20) - dbRef;
    }
    this.accCount++;
    if (this.accCount >= this.avgCount) {
      const line = this.line;
      for (let d = 0; d < bins; d++) {
        const db = acc[d] / this.accCount;
        const v = Math.round((db - DB_MIN) / DB_STEP);
        line[d] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      acc.fill(0);
      this.accCount = 0;
      if (this.onSpectrum) this.onSpectrum(line);
    }
  }
}
