const AUDIO_RATE = 48_000;
const AUDIO_CUTOFF = 15_000; // audio low-pass
const DEEMPHASIS_TAU = 75e-6; // s, standard broadcast FM de-emphasis
const DC_R = 0.9995; // DC-blocker pole
const PCM_GAIN = 0.35; // headroom for typical broadcast deviation

function designLowpass(cutoff, fs, n) {
  // Blackman-Harris windowed sinc, unity DC gain
  const h = new Float64Array(n);
  const center = (n - 1) / 2;
  const wc = (2 * Math.PI * cutoff) / fs;
  const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = i - center;
    const sinc = d === 0 ? wc / Math.PI : Math.sin(wc * d) / (Math.PI * d);
    const t = (2 * Math.PI * i) / (n - 1);
    const win = a0 - a1 * Math.cos(t) + a2 * Math.cos(2 * t) - a3 * Math.cos(3 * t);
    h[i] = sinc * win;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

class FirDecimator {
  constructor(taps, m) {
    this.m = m;
    this.h = Float64Array.from(taps);
    this.n = this.h.length;
    this.maxQ = Math.ceil(this.n / this.m);
    this.groups = [];
    this.cur = { r: new Float64Array(m), i: new Float64Array(m) };
    this.pos = 0;
  }

  _finalizeGroup(outR, outI) {
    const { m, h, n } = this;
    const cur = this.cur;
    let yr = 0;
    let yi = 0;
    for (let p = 0; p < m; p++) {
      const off = m - 1 - p;
      const rv = cur.r[off];
      const iv = cur.i[off];
      let idx = p;
      let q = 0;
      let hi = this.groups.length - 1;
      while (idx < n) {
        const tap = h[idx];
        if (q === 0) {
          yr += tap * rv;
          yi += tap * iv;
        } else if (hi >= 0) {
          const g = this.groups[hi];
          yr += tap * g.r[off];
          yi += tap * g.i[off];
          hi--;
        }
        idx += m;
        q++;
      }
    }
    outR.push(yr);
    outI.push(yi);
    this.groups.push(cur);
    if (this.groups.length > this.maxQ) this.groups.shift();
    this.cur = { r: new Float64Array(m), i: new Float64Array(m) };
    this.pos = 0;
  }

  process(rIn, iIn) {
    const outR = [];
    const outI = [];
    const m = this.m;
    for (let s = 0; s < rIn.length; s++) {
      this.cur.r[this.pos] = rIn[s];
      this.cur.i[this.pos] = iIn[s];
      this.pos++;
      if (this.pos === m) this._finalizeGroup(outR, outI);
    }
    return { r: Float64Array.from(outR), i: Float64Array.from(outI) };
  }

  processReal(inR) {
    const out = [];
    const m = this.m;
    for (let s = 0; s < inR.length; s++) {
      this.cur.r[this.pos] = inR[s];
      this.pos++;
      if (this.pos === m) {
        const { m: mm, h, n } = this;
        const cur = this.cur;
        let y = 0;
        for (let p = 0; p < mm; p++) {
          const off = mm - 1 - p;
          const rv = cur.r[off];
          let idx = p;
          let q = 0;
          let hi = this.groups.length - 1;
          while (idx < n) {
            const tap = h[idx];
            if (q === 0) {
              y += tap * rv;
            } else if (hi >= 0) {
              y += tap * this.groups[hi].r[off];
              hi--;
            }
            idx += mm;
            q++;
          }
        }
        out.push(y);
        this.groups.push(cur);
        if (this.groups.length > this.maxQ) this.groups.shift();
        this.cur = { r: new Float64Array(mm), i: new Float64Array(mm) };
        this.pos = 0;
      }
    }
    return Float64Array.from(out);
  }

  reset() {
    this.groups = [];
    this.cur = { r: new Float64Array(this.m), i: new Float64Array(this.m) };
    this.pos = 0;
  }
}

export class FmDecoder {
  constructor({ inRate = 288_000 } = {}) {
    if (inRate % AUDIO_RATE !== 0) throw new Error(`inRate ${inRate} must be a multiple of ${AUDIO_RATE}`);
    this.inRate = inRate;
    this.m = inRate / AUDIO_RATE;
    this.dec = new FirDecimator(designLowpass(AUDIO_CUTOFF, inRate, 256), this.m);
    this.dc = { R: DC_R, xpR: 0, ypR: 0, xpI: 0, ypI: 0 };
    this.prev = { r: 0, i: 0 };
    this.deem = { y: 0, alpha: 1 - Math.exp(-1 / (inRate * DEEMPHASIS_TAU)) };
    this.bandRms = 0;
    this.audioRms = 0;
  }

  reset() {
    this.dec.reset();
    this.dc = { R: DC_R, xpR: 0, ypR: 0, xpI: 0, ypI: 0 };
    this.prev = { r: 0, i: 0 };
    this.deem = { y: 0, alpha: this.deem.alpha };
    this.bandRms = 0;
    this.audioRms = 0;
  }

  // buf: Node Buffer of interleaved unsigned 8-bit I/Q at inRate.
  // Returns a fresh Int16Array of 48 kHz mono PCM.
  process(buf) {
    const n = buf.length >>> 1;
    const r = new Float64Array(n);
    const i = new Float64Array(n);
    const m = new Float64Array(n);
    const { R } = this.dc;
    let xpR = this.dc.xpR, ypR = this.dc.ypR;
    let xpI = this.dc.xpI, ypI = this.dc.ypI;
    let pr = this.prev.r;
    let pi = this.prev.i;
    let bandSum = 0;
    for (let s = 0; s < n; s++) {
      const xr = (buf[s * 2] - 127.5) / 127.5;
      const xi = (buf[s * 2 + 1] - 127.5) / 127.5;
      const yr = xr - xpR + R * ypR;
      const yi = xi - xpI + R * ypI;
      r[s] = yr;
      i[s] = yi;
      xpR = xr; ypR = yr;
      xpI = xi; ypI = yi;
      bandSum += yr * yr + yi * yi;

      const cross = yr * pi - yi * pr;
      const dot = yr * pr + yi * pi;
      m[s] = Math.atan2(cross, dot);
      pr = yr;
      pi = yi;
    }
    this.dc.xpR = xpR; this.dc.ypR = ypR;
    this.dc.xpI = xpI; this.dc.ypI = ypI;
    this.prev.r = pr;
    this.prev.i = pi;
    this.bandRms = Math.sqrt(bandSum / (n * 2));

    const alpha = this.deem.alpha;
    let y = this.deem.y;
    for (let s = 0; s < n; s++) {
      y = m[s] * alpha + y * (1 - alpha);
      m[s] = y;
    }
    this.deem.y = y;

    const a = this.dec.processReal(m);

    let audioSum = 0;
    for (let k = 0; k < a.length; k++) audioSum += a[k] * a[k];
    this.audioRms = Math.sqrt(audioSum / Math.max(1, a.length));

    const out = new Int16Array(a.length);
    const g = PCM_GAIN * 32767;
    for (let k = 0; k < a.length; k++) {
      let v = a[k] * g;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out[k] = v;
    }
    return out;
  }
}
