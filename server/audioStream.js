import { EventEmitter } from 'node:events';
import { RtlTcpClient, DEFAULT_SAMPLE_RATE } from './rtlTcp.js';
import { FmDecoder, AmDecoder, ChannelPowerMeter } from './dsp.js';
import { SpectrumAnalyzer } from './spectrum.js';
import { DabReceiver } from './dab.js';

const NFM_SAMPLE_RATE = 1_000_000; // ±0.5 MHz visible span
const NFM_AUDIO_RATE = 50_000; // integer decimation of 1 MHz; resampled to 48k server-side
const NFM_OUTPUT_RATE = 48_000; // final rate sent to the browser (matches AudioContext)
const NFM_IF_CUTOFF = 6_000; // channel-selectivity filter before the discriminator
const NFM_AUDIO_CUTOFF = 4_000; // voice-grade NFM audio bandwidth
const NFM_GAIN = 1; // AGC normalizes level; this is just the start gain

// Tuned +25 kHz away from the requested channel when scanning. RTL tuners have
// a DC spike exactly at the LO frequency, and an FM carrier tuned exactly on
// channel sits on top of it where per-chunk DC removal would erase it.
const FM_IF_OFFSET = 25_000;

// NFM scanner: ham channels sit on a 12.5/25 kHz grid, so the in-channel power
// filter is kept narrow (rejects adjacent channels) and the IF offset is small
// enough that an on-grid carrier stays inside the passband while staying clear
// of the LO DC spike.
const NFM_SCAN_RF_BW = 15_000;
const NFM_SCAN_IF_OFFSET = 6_000;

// The interactive scanner tunes to each found signal and waits for the
// operator (save + continue / continue / stop). To decide "is there a signal"
// it first calibrates the noise floor on a few channels at the band start and
// then treats a channel as a hit when its power exceeds noiseFloor * factor.
const SCAN_CALIB_CHANNELS = 5; // channels at the band start used to measure the floor
const SCAN_MIN_THRESHOLD = 0.01; // safety floor so a degenerate 0-noise reading can't hit everything

export function scanThresholdFor(noiseFloor, factor = 2.5) {
  const mult = Number(factor) && Number(factor) > 0 ? Number(factor) : 2.5;
  return Math.max(Number(noiseFloor) * mult, SCAN_MIN_THRESHOLD);
}

const AM_SAMPLE_RATE = 1_000_000; // same span as NFM so the waterfall is shared
const AM_AUDIO_RATE = 50_000; // integer decimation of 1 MHz; resampled to 48k server-side
const AM_OUTPUT_RATE = 48_000; // final rate sent to the browser (matches AudioContext)
const AM_IF_CUTOFF = 6_000; // channel-selectivity filter before the envelope detector
const AM_AUDIO_CUTOFF = 5_000; // HF AM voice is a bit wider than NFM
const AM_GAIN = 1; // AGC normalizes level; this is just the start gain

export class AudioStreamManager extends EventEmitter {
  constructor() {
    super();
    this.rtl = null;
    this.dab = new DabReceiver();
    this.mode = 'fm';
    this.decoder = new FmDecoder();
    this.spec = new SpectrumAnalyzer();
    this.spec.onSpectrum = (line) => {
      if (this.onSpectrum) this.onSpectrum(line);
    };
    this.running = false;
    this.connected = false;
    this.host = null;
    this.port = null;
    this.freq = null;
    this.captureCenter = null; // hardware tuner freq; digital tuning shifts this.freq away from it
    this.gain = null;
    this.squelch = 0; // NFM squelch level, 0 = off
    this.stats = { signal: 0, audio: 0 };
    this.onPcm = null;
    this.scanning = false;
    this.scan = null;
  }

  async start({ mode = 'fm', host, port, freq, gain = null, service = null }) {
    if (this.running) this.stop();
    this.mode = mode;
    this.host = host;
    this.port = port;
    this.freq = freq;
    this.gain = gain;
    this.stats = { signal: 0, audio: 0 };
    this.running = true;

    if (mode === 'dab') {
      const dab = this.dab;
      dab.start({ host, port, freqHz: freq, gain: gain ?? 40, service });
      dab.onPcm = (pcm) => {
        this.stats.audio = this._rms(pcm);
        this.connected = true;
        if (this.onPcm) this.onPcm(pcm);
      };
      dab.onInfo = (info) => {
        if (info.startsWith('eti-cmdline:') || info.startsWith('dablin:')) {
          this.emit('error', new Error(info));
        }
        if (dab.snr !== null) this.stats.signal = Math.min(1, dab.snr / 40);
        if (!dab.running) this.connected = false;
        this.emit('status', this.status());
      };
      this.connected = dab.running;
      this.emit('status', this.status());
      return;
    }

    // FM / NFM / AM mode: direct rtl_tcp IQ handled in-process
    if (mode === 'nfm') {
      this.decoder = new FmDecoder({
        inRate: NFM_SAMPLE_RATE,
        audioRate: NFM_AUDIO_RATE,
        audioCutoff: NFM_AUDIO_CUTOFF,
        deemphasis: 0,
        gain: NFM_GAIN,
        taps: 512,
        outputRate: NFM_OUTPUT_RATE,
        agc: true,
        squelch: this.squelch,
        channelFirst: true,
        channelCutoff: NFM_IF_CUTOFF,
      });
    } else if (mode === 'am') {
      this.decoder = new AmDecoder({
        inRate: AM_SAMPLE_RATE,
        audioRate: AM_AUDIO_RATE,
        audioCutoff: AM_AUDIO_CUTOFF,
        gain: AM_GAIN,
        taps: 512,
        outputRate: AM_OUTPUT_RATE,
        agc: true,
        channelCutoff: AM_IF_CUTOFF,
      });
    } else {
      this.decoder = new FmDecoder();
    }
    this.decoder.reset();
    this.spec = new SpectrumAnalyzer({ sampleRate: mode === 'nfm' || mode === 'am' ? AM_SAMPLE_RATE : DEFAULT_SAMPLE_RATE });
    this.spec.onSpectrum = (line) => {
      if (this.onSpectrum) this.onSpectrum(line);
    };
    this.spec.reset();
    const rtl = new RtlTcpClient({ host, port, sampleRate: mode === 'nfm' || mode === 'am' ? AM_SAMPLE_RATE : DEFAULT_SAMPLE_RATE });
    this.rtl = rtl;
    rtl.on('iq', (chunk) => this._onIq(chunk));
    rtl.on('disconnect', () => {
      this.connected = false;
      if (this.scanning) {
        const s = this.scan;
        this.scanning = false;
        this.scan = null;
        this.emit('scan', { kind: 'done', found: s ? s.found : 0, total: s ? s.freqs.length : 0, aborted: true });
      }
      this.emit('status', this.status());
    });
    rtl.on('error', (err) => this.emit('error', err));

    try {
      await rtl.connect({ freq, gain });
    } catch (err) {
      this.running = false;
      this.connected = false;
      this.rtl = null;
      throw err;
    }
    this.connected = true;
    this.captureCenter = freq;
    if (this.decoder && this.decoder.setChannelOffset) this.decoder.setChannelOffset(0);
    this.emit('status', this.status());
  }

  _onIq(chunk) {
    if (this.scanning && this.scan && !this.scan.paused) {
      // Band scanner: dwell on the tuned frequency measuring in-channel RF
      // energy, then step to the next channel. No audio/spectrum while the
      // sweep is running (a paused scan tunes the found channel so audio flows).
      const s = this.scan;
      const n = chunk.length >>> 1;
      // rtl_tcp keeps streaming: samples arriving right after a retune still
      // belong to the previous frequency. Flush them before measuring.
      if (s.settling) {
        s.settleLeft -= n;
        if (s.settleLeft <= 0) {
          s.settling = false;
          s.accum = { sum: 0, count: 0 };
        }
        return;
      }
      const power = s.meter.process(chunk);
      s.accum.sum += power * n;
      s.accum.count += n;
      if (s.accum.count >= s.dwellSamples) this._closeDwell();
      return;
    }
    const pcm = this.decoder.process(chunk);
    this.spec.push(chunk);
    // For NFM/AM the whole 1 MHz band is mostly noise, so the raw bandRms is a
    // poor signal indicator; the demodulated audio level (post-AGC/gate) is
    // proportional to the carrier lock instead.
    const signal =
      this.mode === 'nfm' || this.mode === 'am'
        ? Math.min(1, this.decoder.outputRms / 0.18)
        : this.decoder.bandRms;
    const audio = this.mode === 'nfm' || this.mode === 'am' ? this.decoder.outputRms : this.decoder.audioRms;
    this.stats = { signal, audio };
    if (this.onPcm) this.onPcm(pcm);
  }

  // Interactive scan in FM or NFM mode. Sweeps frequency by frequency, dwelling
  // ~dwellMs on each. Emits 'scan' events:
  //   {kind:'started', total}              scan begins
  //   {kind:'floor', noiseFloor}           noise floor calibrated, sweep starts
  //   {kind:'progress', freq, done, total} advancing to the next channel
  //   {kind:'hit', freq, signal, noiseFloor, done, total}
  //                                        a signal was found; the sweep PAUSES
  //                                        and audio is left tuned to it until
  //                                        resumeScan() or stopScan(). `freq`
  //                                        is the peak of a fine re-measurement
  //                                        around the coarse channel, because the
  //                                        coarse dwell can contain up to a
  //                                        channel of stale pre-retune data.
  //   {kind:'done', found, total, aborted} scan finished / stopped
  // Returns null if not in FM/NFM mode or not connected.
  //
  // Signals are decided relative to the measured noise floor: the first
  // SCAN_CALIB_CHANNELS channels calibrate the floor (their minimum power) and
  // a channel is a hit when its power exceeds noiseFloor * factor (`threshold`).
  //
  // The tuner is deliberately offset: the R820T/2 has a DC spike exactly at the
  // LO, and a carrier tuned exactly on-channel lands on that spike where
  // per-chunk DC removal would null it. Tuning a few kHz off puts the target
  // channel in the filter passband but clear of the spike.
  startScan({ startFreq, stopFreq, stepHz, threshold, dwellMs = 200 }) {
    if ((this.mode !== 'fm' && this.mode !== 'nfm') || !this.rtl || !this.connected) return null;
    const step = Math.max(1000, Math.round(Number(stepHz) || 100_000));
    const freqs = [];
    for (let f = Math.round(startFreq); f <= Math.round(stopFreq); f += step) freqs.push(f);
    if (!freqs.length) return null;
    const rate = this.decoder.inRate || DEFAULT_SAMPLE_RATE;
    const scanMode = this.mode;
    const settleSamples = Math.max(1000, Math.round(rate * 0.05)); // 50 ms of stale data
    this.scanning = true;
    this.scan = {
      freqs,
      idx: 0,
      scanMode,
      factor: Number(threshold) > 0 ? Number(threshold) : 2.5,
      threshold: 0, // filled in once the noise floor is calibrated
      // rtl_tcp keeps delivering pre-retune data for a while after a tune
      // command, so the sweep discards a generous settle window before each
      // measurement. The peak-localization pass below uses an even longer
      // settle so its readings are guaranteed to be on the candidate channel.
      sweepSettleSamples: settleSamples,
      sweepDwellSamples: Math.max(1000, Math.round((Number(dwellMs) || 200) * rate) / 1000),
      refineSettleSamples: Math.round(rate * 0.6), // 600 ms, well past one rtl_tcp chunk
      refineDwellSamples: Math.max(1000, Math.round(rate * 0.1)), // 100 ms
      settleSamples,
      dwellSamples: Math.max(1000, Math.round((Number(dwellMs) || 200) * rate) / 1000),
      settling: true,
      settleLeft: settleSamples,
      ifOffset: scanMode === 'nfm' ? NFM_SCAN_IF_OFFSET : FM_IF_OFFSET,
      accum: { sum: 0, count: 0 },
      calibrating: true,
      calibVals: [],
      noiseFloor: 0,
      found: 0,
      paused: false,
      refining: false,
      refine: null,
      meter:
        scanMode === 'nfm'
          ? new ChannelPowerMeter({ inRate: rate, rfBandwidth: NFM_SCAN_RF_BW })
          : new ChannelPowerMeter({ inRate: rate }),
    };
    this.rtl.tune(freqs[0] + this.scan.ifOffset);
    this.emit('scan', { kind: 'started', total: freqs.length, start: freqs[0], stop: freqs[freqs.length - 1] });
    return { total: freqs.length };
  }

  // Pauses are cleared by resumeScan(); this cancels the whole sweep.
  stopScan() {
    if (!this.scanning || !this.scan) return null;
    const s = this.scan;
    this.scanning = false;
    this.scan = null;
    return { total: s.freqs.length, found: s.found };
  }

  // Continues the sweep after a 'hit' was presented to the operator.
  resumeScan() {
    const s = this.scan;
    if (!s || !s.paused) return null;
    s.paused = false;
    s.idx++;
    if (s.idx < s.freqs.length) {
      this._tuneNext();
      this.emit('scan', { kind: 'resumed', freq: s.freqs[s.idx], done: s.idx, total: s.freqs.length });
    } else {
      const done = { kind: 'done', found: s.found, total: s.freqs.length, noiseFloor: s.noiseFloor };
      this.scanning = false;
      this.scan = null;
      this.emit('scan', done);
    }
    return { total: s.freqs.length };
  }

  // Move the tuner to the current channel and start its settle/dwell cycle.
  _tuneNext() {
    this._tuneTo(this.scan.freqs[this.scan.idx]);
  }

  // Tune the hardware to `freq` (offset from the LO DC spike) and arm the
  // settle/dwell cycle. The refinement pass uses a longer settle so its power
  // readings are taken after any stale pre-retune data has drained.
  _tuneTo(freq) {
    const s = this.scan;
    s.accum = { sum: 0, count: 0 };
    s.settling = true;
    if (s.refining) {
      s.settleLeft = s.refineSettleSamples;
      s.dwellSamples = s.refineDwellSamples;
    } else {
      s.settleLeft = s.settleSamples;
      s.dwellSamples = s.sweepDwellSamples;
    }
    // Drop the channel filter state so a strong signal from the previous
    // channel can't leak into this measurement through its transient.
    if (s.meter) s.meter.reset();
    this.rtl.tune(freq + s.ifOffset);
    this.emit('scan', {
      kind: 'progress',
      freq,
      done: s.idx,
      total: s.freqs.length,
      found: s.found,
      signal: 0,
    });
  }

  _closeDwell() {
    const s = this.scan;
    if (!s) return;
    const avg = s.accum.count ? s.accum.sum / s.accum.count : 0;
    const freq = s.refining ? s.refine.candidates[s.refine.idx] : s.freqs[s.idx];

    // Noise-floor calibration pass on the first channels of the band.
    if (s.calibrating) {
      s.calibVals.push(avg);
      s.idx++;
      if (s.idx < SCAN_CALIB_CHANNELS) {
        this._tuneNext();
        return;
      }
      s.noiseFloor = Math.min(...s.calibVals);
      s.threshold = scanThresholdFor(s.noiseFloor, s.factor);
      s.calibrating = false;
      this.emit('scan', { kind: 'floor', noiseFloor: s.noiseFloor, total: s.freqs.length });
      if (s.idx < s.freqs.length) {
        this._tuneNext();
      } else {
        this._finishScan();
      }
      return;
    }

    // Peak-localization pass: the coarse dwell that just fired can contain up
    // to a channel of stale pre-retune data, so its channel can sit one step
    // too high. Each candidate here is re-measured after a full settle and the
    // strongest one is what gets reported to the operator.
    if (s.refining) {
      s.refine.results.push({ freq, avg });
      s.refine.idx++;
      if (s.refine.idx < s.refine.candidates.length) {
        this._tuneTo(s.refine.candidates[s.refine.idx]);
      } else {
        const best = s.refine.results.reduce((a, b) => (b.avg > a.avg ? b : a));
        s.refining = false;
        s.refine = null;
        s.found++;
        s.paused = true;
        this.emit('scan', {
          kind: 'hit',
          freq: best.freq,
          signal: Number(best.avg.toFixed(4)),
          noiseFloor: s.noiseFloor,
          done: s.idx,
          total: s.freqs.length,
        });
      }
      return;
    }

    if (avg > s.threshold) {
      // Coarse hit: localize the actual signal peak on a fine grid around this
      // channel before reporting, so the frequency shown matches where the
      // signal is strongest rather than the (possibly stale) coarse channel.
      const step = s.freqs.length > 1 ? s.freqs[1] - s.freqs[0] : 100_000;
      const half = Math.round(step / 2);
      const cand = [];
      for (const off of [-2 * step, -1.5 * step, -step, -half, 0, half]) {
        const f = Math.round(freq + off);
        if (f >= s.freqs[0] && f <= s.freqs[s.freqs.length - 1]) cand.push(f);
      }
      s.refining = true;
      s.refine = { candidates: cand, idx: 0, results: [] };
      this._tuneTo(cand[0]);
      return;
    }

    s.idx++;
    if (s.idx < s.freqs.length) {
      this._tuneNext();
    } else {
      this._finishScan();
    }
  }

  _finishScan() {
    const s = this.scan;
    if (!s) return;
    const done = { kind: 'done', found: s.found, total: s.freqs.length, noiseFloor: s.noiseFloor };
    this.scanning = false;
    this.scan = null;
    this.emit('scan', done);
  }

  _rms(pcm) {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
    return Math.sqrt(sum / Math.max(1, pcm.length));
  }

  setGain(gain) {
    if (this.mode === 'dab') {
      if (!this.dab.running) return;
      this.gain = gain;
      this.dab.stop();
      this.dab.start({ host: this.host, port: this.port, freqHz: this.freq, gain: gain ?? 40, service: this.dab.service });
      this.connected = this.dab.running;
      this.emit('status', this.status());
      return;
    }
    if (!this.rtl || !this.connected) return;
    this.gain = gain;
    this.rtl.setGain(gain);
    this.emit('status', this.status());
  }

  setSquelch(level) {
    const v = Math.min(1, Math.max(0, Number(level) || 0));
    this.squelch = v;
    if (this.mode === 'nfm' && this.decoder) this.decoder.setSquelch(v);
    this.emit('status', this.status());
  }

  tune(freq, service = null) {
    if (this.scanning && this.scan && !this.scan.paused) {
      this.scanning = false;
      this.scan = null;
      this.emit('scan', { kind: 'done', found: 0, total: 0, aborted: true });
    }
    this.freq = freq;
    if (this.mode === 'dab') {
      this.stats = { signal: 0, audio: 0 };
      if (this.dab.running) {
        this.dab.start({ host: this.host, port: this.port, freqHz: freq, gain: this.gain ?? 40, service });
        this.connected = this.dab.running;
      }
    } else if (this.rtl && this.connected) {
      const rate = this.decoder ? this.decoder.inRate : DEFAULT_SAMPLE_RATE;
      const maxOff = Math.floor(rate / 2 * 0.8);
      const off = this.captureCenter != null ? freq - this.captureCenter : 0;
      if (this.decoder && this.decoder.setChannelOffset && Math.abs(off) <= maxOff) {
        // Digital tune: shift the channel inside the already-captured band. No
        // hardware retune, so the stream never drops and audio stays clean
        // while riding the knob. Only recenter the hardware at band edges.
        this.decoder.setChannelOffset(off);
      } else {
        this.captureCenter = freq;
        this.stats = { signal: 0, audio: 0 };
        if (this.decoder && this.decoder.setChannelOffset) this.decoder.setChannelOffset(0);
        this.rtl.tune(freq);
      }
    }
    this.emit('status', this.status());
  }

  stop() {
    this.running = false;
    this.connected = false;
    this.scanning = false;
    this.scan = null;
    this.spec.reset();
    if (this.rtl) {
      this.rtl.close();
      this.rtl = null;
    }
    this.dab.stop();
    this.emit('status', this.status());
  }

  status() {
    return {
      mode: this.mode,
      running: this.running,
      connected: this.connected,
      host: this.host,
      port: this.port,
      freq: this.freq,
      gain: this.gain,
      channel: this.mode === 'dab' ? this.dab.channel : null,
      service: this.mode === 'dab' ? this.dab.service : null,
      sid: this.mode === 'dab' ? this.dab.sid : null,
      ensemble: this.mode === 'dab' ? this.dab.ensemble : null,
      snr: this.mode === 'dab' ? this.dab.snr : null,
      services: this.mode === 'dab' ? this.dab.services : [],
      rate: this.mode === 'dab' ? this.dab.rate : this.decoder ? this.decoder.audioRate : null,
      span: this.mode === 'dab' ? null : this.spec ? this.spec.sampleRate : null,
      center: this.mode === 'dab' ? null : this.captureCenter,
      squelch: this.mode === 'nfm' ? this.squelch : 0,
      scanning: this.scanning,
      signal: this.stats.signal,
      audio: this.stats.audio,
    };
  }
}
