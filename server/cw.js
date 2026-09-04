// CW (morse) decoder for the demodulated SSB audio. A CW signal is a pure tone
// keyed on/off; the SSB receiver outputs it as a beat note whose frequency is
// the offset between the receiver's carrier and the CW signal. Because the SSB
// AGC normalizes the level, the tone and the noise floor end up at the same RMS
// - so we cannot gate on amplitude alone. Instead we measure how concentrated
// the energy is at a single frequency (a tone is a narrow peak, noise is spread
// out) and use that concentration metric to decide key-down / key-up. The
// resulting on/off durations are then timed against an adaptive dot length and
// decoded into morse characters.

const WINDOW_MS = 10; // Goertzel analysis window
const HOP_MS = 5; // window step (overlapping, gives timing resolution for keying)
const TONE_MIN = 350; // CW beat-note range (Hz)
const TONE_MAX = 1150;
const TONE_STEP = 10;
const DEFAULT_DOT_SEC = 0.06; // ~20 WPM before the decoder adapts to the sender
const TEXT_MAX = 400; // rolling decoded text kept for display

export const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', '@': '.--.-.',
};

const MORSE_TO_CHAR = {};
for (const [ch, code] of Object.entries(MORSE)) MORSE_TO_CHAR[code] = ch;

export class CwDecoder {
  constructor({
    sampleRate = 48_000,
    windowMs = WINDOW_MS,
    hopMs = HOP_MS,
    toneMin = TONE_MIN,
    toneMax = TONE_MAX,
    toneStep = TONE_STEP,
    onText = null,
  } = {}) {
    this.sampleRate = sampleRate;
    this.windowMs = windowMs;
    this.hopMs = hopMs;
    this.winLen = Math.max(16, Math.round((sampleRate * windowMs) / 1000));
    this.hopLen = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
    this.toneFreqs = [];
    for (let f = toneMin; f <= toneMax; f += toneStep) this.toneFreqs.push(f);
    this.onText = onText;
    this.reset();
  }

  reset() {
    this.win = new Float64Array(this.winLen);
    this.acc = new Float64Array(this.hopLen);
    this.accPos = 0;
    this.winFilled = 0;
    this.on = false;
    this.markLen = 0;
    this.spaceLen = 0;
    this.spaceFinalized = false;
    this.elements = [];
    this.wordChars = 0;
    this.text = '';
    this.dotRef = DEFAULT_DOT_SEC;
    this.metricLow = 0.05;
    this.metricHigh = 0.6;
    this.thr = 0.3;
  }

  // pcm: mono audio samples. Accepts an Int16Array (the SSB decoder's output)
  // or a Float32Array in [-1, 1].
  push(pcm) {
    const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
    for (let i = 0; i < pcm.length; i++) {
      this.acc[this.accPos++] = pcm[i] * scale;
      if (this.accPos === this.hopLen) {
        this.win.copyWithin(0, this.hopLen);
        this.win.set(this.acc, this.winLen - this.hopLen);
        this.winFilled = Math.min(this.winLen, this.winFilled + this.hopLen);
        this.accPos = 0;
        if (this.winFilled === this.winLen) this._window(this.hopMs / 1000);
      }
    }
  }

  // Decode any trailing half-decoded character (e.g. when tuning away).
  flush() {
    const code = this.elements.map((e) => (e === 'dot' ? '.' : '-')).join('');
    this.elements = [];
    const ch = MORSE_TO_CHAR[code];
    if (ch) {
      this.text += ch;
      this._emit();
    }
  }

  _window(dt) {
    const { win, winLen } = this;
    let sumSq = 0;
    for (let i = 0; i < winLen; i++) sumSq += win[i] * win[i];
    const rms = Math.sqrt(sumSq / winLen);
    let metric = 0;
    if (rms > 1e-6) {
      let peakMag = 0;
      for (let i = 0; i < this.toneFreqs.length; i++) {
        const mag = this._goertzel(win, this.toneFreqs[i], this.sampleRate, winLen);
        if (mag > peakMag) peakMag = mag;
      }
      // Concentration: a tone puts most of the window's energy in one bin
      // (~0.7), while noise spreads it (~0.03). Amplitude-independent thanks
      // to the SSB AGC.
      metric = peakMag / (winLen * rms);
    }
    this._classify(metric, dt);
  }

  _goertzel(x, f, fs, N) {
    const w = (2 * Math.PI * f) / fs;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let n = 0; n < N; n++) {
      const s0 = x[n] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const real = s1 - s2 * Math.cos(w);
    const imag = s2 * Math.sin(w);
    return Math.sqrt(real * real + imag * imag);
  }

  _classify(metric, dt) {
    // Adapt the on/off threshold between the observed noise and tone levels.
    if (metric > this.thr) this.metricHigh += 0.02 * (metric - this.metricHigh);
    else this.metricLow += 0.02 * (metric - this.metricLow);
    this.thr = Math.max(0.05, (this.metricLow + this.metricHigh) * 0.5);
    const openThr = this.thr * 1.4;
    const closeThr = this.thr * 0.7;

    if (!this.on) {
      this.spaceLen += dt;
      // A long silence finalizes the current word even without a following mark.
      if (!this.spaceFinalized && this.spaceLen >= this.dotRef * 5.0) {
        this.spaceFinalized = true;
        this._finalizeSpace(this.spaceLen);
      }
      if (metric > openThr) {
        if (!this.spaceFinalized) this._finalizeSpace(this.spaceLen);
        this.on = true;
        this.markLen = 0;
        this.spaceLen = 0;
        this.spaceFinalized = false;
      }
    } else {
      this.markLen += dt;
      if (metric < closeThr) {
        this._endMark(this.markLen);
        this.on = false;
        this.markLen = 0;
        this.spaceLen = 0;
        this.spaceFinalized = false;
      }
    }
  }

  _endMark(markLen) {
    const d = this.dotRef;
    const isDot = markLen < d * 2.0;
    this.elements.push(isDot ? 'dot' : 'dash');
    // Adapt the dot reference toward observed dot/dash lengths (dash ~ 3 units).
    if (isDot) this.dotRef = this.dotRef * 0.85 + markLen * 0.15;
    else this.dotRef = this.dotRef * 0.85 + (markLen / 3) * 0.15;
  }

  _finalizeSpace(spaceLen) {
    const d = this.dotRef;
    if (spaceLen < d * 2.0) return; // intra-character gap
    const ch = this._decodePending();
    if (ch) this.wordChars++;
    if (spaceLen >= d * 5.0 && this.wordChars > 0) {
      this.text += ' ';
      this.wordChars = 0;
      this._emit();
    }
  }

  _decodePending() {
    const code = this.elements.map((e) => (e === 'dot' ? '.' : '-')).join('');
    this.elements = [];
    const ch = MORSE_TO_CHAR[code];
    if (ch) {
      this.text += ch;
      this._emit();
    }
    return ch;
  }

  _emit() {
    if (this.text.length > TEXT_MAX) this.text = this.text.slice(this.text.length - TEXT_MAX);
    if (this.onText) this.onText(this.text);
  }
}
