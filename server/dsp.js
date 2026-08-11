const AUDIO_RATE = 48_000;
const AUDIO_CUTOFF = 15_000; // audio low-pass
const DEEMPHASIS_TAU = 75e-6; // s, standard broadcast FM de-emphasis
const DC_R = 0.9995; // DC-blocker pole
const PCM_GAIN = 0.35; // headroom for typical broadcast deviation

// AGC keeps the demodulated NFM audio near a fixed RMS level regardless of
// deviation / signal strength, and stops the discriminator noise from
// clipping to full scale (the "loud static" complaint).
const AGC_TARGET = 0.18; // target output RMS (0..1)
const AGC_ATTACK = 0.25; // gain reduce rate (signal got louder)
const AGC_RELEASE = 0.05; // gain raise rate (signal got quieter)
const AGC_MAX_GAIN = 60;

// Squelch: an unlocked discriminator produces phase jumps near +/- pi, while
// a locked NFM carrier stays within a few hundred Hz of the center. We count
// the fraction of samples whose instantaneous frequency exceeds SQUELCH_RAD
// and open/close the gate with hysteresis.
const SQUELCH_RAD = 1.0; // > ~159 kHz instantaneous offset = noise jump
const SQUELCH_OPEN = 0.01; // jump ratio below which a carrier is present
const SQUELCH_CLOSE = 0.05; // jump ratio above which it is pure noise

// Linear interpolator for rational rate conversion (50 kHz -> 48 kHz).
// The audio is already low-passed well below Nyquist, so linear interp is
// perfectly adequate for voice-grade NFM.
export class LinearResampler {
  constructor(fromRate, toRate) {
    this.ratio = fromRate / toRate;
    this.t = 0; // fractional input position of the next output sample
    this.prev = 0; // input sample just before the current buffer
    this.hasPrev = false;
  }

  reset() {
    this.t = 0;
    this.prev = 0;
    this.hasPrev = false;
  }

  process(input) {
    const n = input.length;
    if (!this.hasPrev) {
      this.prev = n ? input[0] : 0;
      this.hasPrev = true;
    }
    const { ratio, prev } = this;
    const out = [];
    let t = this.t;
    while (t < 0) {
      const frac = t + 1;
      out.push(prev * (1 - frac) + input[0] * frac);
      t += ratio;
    }
    while (t < n) {
      const idx = Math.floor(t);
      const frac = t - idx;
      const s0 = idx === 0 ? prev : input[idx - 1];
      const s1 = input[idx];
      out.push(s0 + (s1 - s0) * frac);
      t += ratio;
    }
    this.t = t - n;
    this.prev = input[n - 1];
    return Float64Array.from(out);
  }
}

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

// Non-decimating real FIR low-pass used to shape the audio after the
// discriminator when the channel filter runs before it (channelFirst).
class FirFilter {
  constructor(taps) {
    this.h = Float64Array.from(taps);
    this.n = this.h.length;
    this.buf = new Float64Array(this.n);
    this.pos = 0;
  }

  reset() {
    this.buf.fill(0);
    this.pos = 0;
  }

  process(input) {
    const { h, n } = this;
    const buf = this.buf;
    const out = new Float64Array(input.length);
    for (let s = 0; s < input.length; s++) {
      buf[this.pos] = input[s];
      let y = 0;
      let p = this.pos;
      for (let k = 0; k < n; k++) {
        y += h[k] * buf[p];
        p = p === 0 ? n - 1 : p - 1;
      }
      out[s] = y;
      this.pos = (this.pos + 1) % n;
    }
    return out;
  }
}

export class FmDecoder {
  constructor({
    inRate = 288_000,
    audioRate = AUDIO_RATE,
    audioCutoff = AUDIO_CUTOFF,
    deemphasis = DEEMPHASIS_TAU,
    gain = PCM_GAIN,
    taps = 256,
    outputRate = 0, // if set (!= audioRate) the audio is resampled to it
    agc = false, // automatic gain control on the demodulated audio
    squelch = 0, // 0 = off; otherwise a level in 0..1 that tightens the gate
    channelFirst = false, // IF-selectivity: channel-filter+decimate before the discriminator
    channelCutoff = 0, // width (Hz) of the pre-demodulator channel filter
  } = {}) {
    if (inRate % audioRate !== 0) throw new Error(`inRate ${inRate} must be a multiple of ${audioRate}`);
    if (channelFirst && !channelCutoff) throw new Error('channelCutoff is required when channelFirst is set');
    this.inRate = inRate;
    this.audioRate = outputRate || audioRate; // final rate reported to the client
    this.decRate = audioRate; // rate the FIR decimator outputs
    this.m = inRate / audioRate;
    this.channelFirst = channelFirst;
    this.dec = channelFirst ? null : new FirDecimator(designLowpass(audioCutoff, inRate, taps), this.m);
    if (channelFirst) {
      // The channel filter is applied to the complex baseband BEFORE the
      // discriminator, so adjacent FM signals (whose audio modulation would
      // otherwise fall inside the post-demod low-pass) are rejected first.
      this.ifDec = new FirDecimator(designLowpass(channelCutoff, inRate, taps), this.m);
      this.audioFir = new FirFilter(designLowpass(audioCutoff, audioRate, taps));
      this.ifPrev = { r: 0, i: 0 };
    } else {
      this.ifDec = null;
      this.audioFir = null;
      this.ifPrev = null;
    }
    this.dc = { R: DC_R, xpR: 0, ypR: 0, xpI: 0, ypI: 0 };
    this.prev = { r: 0, i: 0 };
    this.deem = {
      y: 0,
      alpha: deemphasis > 0 ? 1 - Math.exp(-1 / ((channelFirst ? audioRate : inRate) * deemphasis)) : 1,
    };
    this.gain = gain;
    this.agc = agc;
    this.squelch = 0;
    this.squelchLevel = 0;
    this.squelchClose = SQUELCH_CLOSE;
    this.agcGain = agc ? 1 : gain;
    this.gate = 1;
    this.squelchOpen = false;
    this.resampler = outputRate && outputRate !== audioRate ? new LinearResampler(audioRate, outputRate) : null;
    this.bandRms = 0;
    this.audioRms = 0;
    this.outputRms = 0;
    this.setSquelch(squelch);
  }

  // Set the squelch level. 0 disables it (gate always open); a value in 0..1
  // enables carrier-lock gating, with higher values closing on cleaner signals.
  setSquelch(level) {
    const v = Math.min(1, Math.max(0, Number(level) || 0));
    const wasOn = this.squelch;
    this.squelchLevel = v;
    this.squelch = v > 0 ? 1 : 0;
    // Higher level -> closer to the open threshold -> tighter squelch.
    this.squelchClose = this.squelch ? SQUELCH_OPEN + 0.2 * (1 - v) : SQUELCH_CLOSE;
    if (this.squelch && !wasOn) this.gate = 0; // start muted, no noise burst
    if (!this.squelch) {
      this.squelchOpen = false;
      this.gate = 1;
    }
  }

  reset() {
    if (this.dec) this.dec.reset();
    if (this.ifDec) this.ifDec.reset();
    if (this.audioFir) this.audioFir.reset();
    this.dc = { R: DC_R, xpR: 0, ypR: 0, xpI: 0, ypI: 0 };
    this.prev = { r: 0, i: 0 };
    this.ifPrev = this.ifPrev ? { r: 0, i: 0 } : null;
    this.deem = { y: 0, alpha: this.deem.alpha };
    this.bandRms = 0;
    this.audioRms = 0;
    this.outputRms = 0;
    this.agcGain = this.agc ? 1 : this.gain;
    this.squelchOpen = false;
    this.gate = this.squelch ? 0 : 1;
    if (this.resampler) this.resampler.reset();
  }

  // buf: Node Buffer of interleaved unsigned 8-bit I/Q at inRate.
  // Returns a fresh Int16Array of audioRate Hz mono PCM.
  process(buf) {
    const n = buf.length >>> 1;
    const r = new Float64Array(n);
    const i = new Float64Array(n);
    const { R } = this.dc;
    let xpR = this.dc.xpR, ypR = this.dc.ypR;
    let xpI = this.dc.xpI, ypI = this.dc.ypI;
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
    }
    this.dc.xpR = xpR; this.dc.ypR = ypR;
    this.dc.xpI = xpI; this.dc.ypI = ypI;
    this.bandRms = Math.sqrt(bandSum / (n * 2));

    // Discriminate only the wanted channel. When channelFirst is set the full
    // band is channel-filtered + decimated first, so an adjacent FM carrier's
    // audio modulation (which would otherwise sit inside the 0..audioCutoff
    // passband of the post-demod low-pass) is removed before demodulation.
    let m;
    if (this.channelFirst) {
      const c = this.ifDec.process(r, i);
      m = new Float64Array(c.r.length);
      let pr = this.ifPrev.r;
      let pi = this.ifPrev.i;
      for (let k = 0; k < c.r.length; k++) {
        const cr = c.r[k];
        const ci = c.i[k];
        m[k] = Math.atan2(cr * pi - ci * pr, cr * pr + ci * pi);
        pr = cr;
        pi = ci;
      }
      this.ifPrev.r = pr;
      this.ifPrev.i = pi;
    } else {
      m = new Float64Array(n);
      let pr = this.prev.r;
      let pi = this.prev.i;
      for (let s = 0; s < n; s++) {
        m[s] = Math.atan2(r[s] * pi - i[s] * pr, r[s] * pr + i[s] * pi);
        pr = r[s];
        pi = i[s];
      }
      this.prev.r = pr;
      this.prev.i = pi;
    }

    const alpha = this.deem.alpha;
    let y = this.deem.y;
    for (let s = 0; s < m.length; s++) {
      y = m[s] * alpha + y * (1 - alpha);
      m[s] = y;
    }
    this.deem.y = y;

    // Squelch: count unlocked-phase noise jumps in the discriminator output.
    if (this.squelch) {
      let jumps = 0;
      for (let s = 0; s < m.length; s++) if (m[s] > SQUELCH_RAD || m[s] < -SQUELCH_RAD) jumps++;
      const ratio = jumps / m.length;
      if (!this.squelchOpen && ratio < SQUELCH_OPEN) this.squelchOpen = true;
      else if (this.squelchOpen && ratio > this.squelchClose) this.squelchOpen = false;
    }

    const a = this.channelFirst ? this.audioFir.process(m) : this.dec.processReal(m);

    let audioSum = 0;
    for (let k = 0; k < a.length; k++) audioSum += a[k] * a[k];
    this.audioRms = Math.sqrt(audioSum / Math.max(1, a.length));

    // AGC: drive the decimated audio toward a fixed RMS level.
    let g = this.gain;
    if (this.agc) {
      const target = AGC_TARGET / Math.max(this.audioRms, 1e-4);
      const coeff = target < this.agcGain ? AGC_ATTACK : AGC_RELEASE;
      this.agcGain += (target - this.agcGain) * coeff;
      g = Math.min(this.agcGain, AGC_MAX_GAIN);
    }

    // Soft gate (squelch) with fast open / slow close to avoid clicks.
    const gateTarget = this.squelch && !this.squelchOpen ? 0 : 1;
    this.gate += (gateTarget - this.gate) * (gateTarget > this.gate ? 0.7 : 0.3);

    let out = a;
    if (this.resampler) out = this.resampler.process(a);

    const scaled = new Int16Array(out.length);
    const gg = (g * this.gate) * 32767;
    for (let k = 0; k < out.length; k++) {
      let v = out[k] * gg;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      scaled[k] = v;
    }

    let outSum = 0;
    for (let k = 0; k < scaled.length; k++) outSum += (scaled[k] / 32768) ** 2;
    this.outputRms = Math.sqrt(outSum / Math.max(1, scaled.length));

    return scaled;
  }
}

// AM demodulator: complex envelope detection (sqrt(I^2 + Q^2)) at the full
// input rate, then a DC blocker strips the carrier so the AC modulation
// becomes the audio, which is low-passed + decimated, AGC'd, and resampled to
// the output rate. No squelch: a missing carrier just means hiss (AGC keeps
// it from clipping).
export class AmDecoder {
  constructor({
    inRate = 1_000_000,
    audioRate = 50_000,
    audioCutoff = 5_000,
    gain = 1,
    taps = 512,
    outputRate = 48_000,
    agc = true,
    channelCutoff = 6_000, // IF-selectivity filter width before the envelope detector
  } = {}) {
    if (inRate % audioRate !== 0) throw new Error(`inRate ${inRate} must be a multiple of ${audioRate}`);
    this.inRate = inRate;
    this.audioRate = outputRate || audioRate;
    this.decRate = audioRate;
    this.m = inRate / audioRate;
    // The channel filter removes adjacent carriers before the envelope
    // detector, which would otherwise produce in-band beat audio from any
    // strong signal within the whole waterfall span.
    this.ifDec = new FirDecimator(designLowpass(channelCutoff, inRate, taps), this.m);
    this.audioFir = new FirFilter(designLowpass(audioCutoff, audioRate, taps));
    this.dec = null;
    this.dc = { R: DC_R, xp: 0, yp: 0 }; // envelope DC blocker (removes carrier)
    this.gain = gain;
    this.agc = agc;
    this.agcGain = agc ? 1 : gain;
    this.resampler = outputRate && outputRate !== audioRate ? new LinearResampler(audioRate, outputRate) : null;
    this.bandRms = 0;
    this.audioRms = 0;
    this.outputRms = 0;
  }

  reset() {
    this.ifDec.reset();
    this.audioFir.reset();
    this.dc = { R: DC_R, xp: 0, yp: 0 };
    this.bandRms = 0;
    this.audioRms = 0;
    this.outputRms = 0;
    this.agcGain = this.agc ? 1 : this.gain;
    if (this.resampler) this.resampler.reset();
  }

  // buf: Node Buffer of interleaved unsigned 8-bit I/Q at inRate.
  // Returns a fresh Int16Array of audioRate Hz mono PCM.
  process(buf) {
    const n = buf.length >>> 1;
    const r = new Float64Array(n);
    const i = new Float64Array(n);
    let bandSum = 0;
    for (let s = 0; s < n; s++) {
      const xr = (buf[s * 2] - 127.5) / 127.5;
      const xi = (buf[s * 2 + 1] - 127.5) / 127.5;
      r[s] = xr;
      i[s] = xi;
      bandSum += xr * xr + xi * xi;
    }
    this.bandRms = Math.sqrt(bandSum / (n * 2));

    // Select the tuned channel first so adjacent carriers are removed before
    // the envelope detector, preventing beat-note bleed from other signals.
    const c = this.ifDec.process(r, i);
    const { R } = this.dc;
    let xp = this.dc.xp;
    let yp = this.dc.yp;
    const env = new Float64Array(c.r.length);
    for (let k = 0; k < c.r.length; k++) {
      const mag = Math.sqrt(c.r[k] * c.r[k] + c.i[k] * c.i[k]);
      const y = mag - xp + R * yp; // high-pass the envelope to remove the carrier DC
      env[k] = y;
      xp = mag;
      yp = y;
    }
    this.dc.xp = xp;
    this.dc.yp = yp;

    const a = this.audioFir.process(env);

    let audioSum = 0;
    for (let k = 0; k < a.length; k++) audioSum += a[k] * a[k];
    this.audioRms = Math.sqrt(audioSum / Math.max(1, a.length));

    // AGC: same normalizing loop as the NFM path.
    let g = this.gain;
    if (this.agc) {
      const target = AGC_TARGET / Math.max(this.audioRms, 1e-4);
      const coeff = target < this.agcGain ? AGC_ATTACK : AGC_RELEASE;
      this.agcGain += (target - this.agcGain) * coeff;
      g = Math.min(this.agcGain, AGC_MAX_GAIN);
    }

    let out = a;
    if (this.resampler) out = this.resampler.process(a);

    const scaled = new Int16Array(out.length);
    const gg = g * 32767;
    for (let k = 0; k < out.length; k++) {
      let v = out[k] * gg;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      scaled[k] = v;
    }

    let outSum = 0;
    for (let k = 0; k < scaled.length; k++) outSum += (scaled[k] / 32768) ** 2;
    this.outputRms = Math.sqrt(outSum / Math.max(1, scaled.length));

    return scaled;
  }
}

// RF energy confined to a narrow band around the tuned center frequency. Used
// by the FM scanner: an on-frequency FM carrier (constant envelope) reads high,
// while an adjacent station 100 kHz away falls outside the passband and reads
// near the in-band noise floor. A full-band RMS could not tell those apart at
// 288 ksps because the whole +/-144 kHz span is always visible.
export class ChannelPowerMeter {
  constructor({ rfBandwidth = 80_000, inRate = 288_000, taps = 512, dec = 4 } = {}) {
    // Per-chunk DC removal (mean subtract) drops the ADC offset and carriers
    // sitting exactly at baseband DC; real on-air carriers sit at the residual
    // frequency error (hundreds of Hz) and pass through fine.
    this.dec = new FirDecimator(designLowpass(rfBandwidth / 2, inRate, taps), dec);
  }

  reset() {
    this.dec.reset();
  }

  // buf: Node Buffer of interleaved unsigned 8-bit I/Q at inRate.
  // Returns the RMS of the decimated, channel-filtered complex signal (0..1).
  process(buf) {
    const n = buf.length >>> 1;
    const r = new Float64Array(n);
    const i = new Float64Array(n);
    let mr = 0;
    let mi = 0;
    for (let s = 0; s < n; s++) {
      const xr = (buf[s * 2] - 127.5) / 127.5;
      const xi = (buf[s * 2 + 1] - 127.5) / 127.5;
      r[s] = xr;
      i[s] = xi;
      mr += xr;
      mi += xi;
    }
    mr /= n;
    mi /= n;
    for (let s = 0; s < n; s++) {
      r[s] -= mr;
      i[s] -= mi;
    }
    const c = this.dec.process(r, i);
    let sum = 0;
    for (let k = 0; k < c.r.length; k++) sum += c.r[k] * c.r[k] + c.i[k] * c.i[k];
    return Math.sqrt(sum / c.r.length);
  }
}
