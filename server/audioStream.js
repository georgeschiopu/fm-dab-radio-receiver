import { EventEmitter } from 'node:events';
import { RtlTcpClient, DEFAULT_SAMPLE_RATE } from './rtlTcp.js';
import { FmDecoder, AmDecoder, SsbDecoder, ChannelPowerMeter } from './dsp.js';
import { SpectrumAnalyzer } from './spectrum.js';
import { DabReceiver, BAND_III } from './dab.js';
import { MeshtasticReceiver } from './meshtasticReceiver.js';
import { MESHTASTIC_DEFAULT_FREQ, MESHTASTIC_IF_OFFSET, MESHTASTIC_SAMPLE_RATE } from './meshtastic.js';
import { CwDecoder } from './cw.js';
import { AdsbReceiver } from './adsbReceiver.js';
import { ADSB_DEFAULT_FREQ, ADSB_SAMPLE_RATE } from './adsb.js';

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

// LSB / USB single-sideband (HF voice). Shares the 1 Msps NFM/AM waterfall,
// but the demod selects just one sideband of the tuned channel instead of the
// symmetric lobe that AM recovers.
const SSB_SAMPLE_RATE = 1_000_000;
const SSB_AUDIO_RATE = 50_000; // integer decimation of 1 MHz; resampled to 48k server-side
const SSB_OUTPUT_RATE = 48_000; // final rate sent to the browser (matches AudioContext)
const SSB_IF_CUTOFF = 6_000; // channel-selectivity filter before the sideband selection
const SSB_AUDIO_CUTOFF = 1_400; // selection low-pass half-width (voice bandwidth / 2)
const SSB_SHIFT = 1_500; // BFO: centres the kept voice band at DC and rejects the image
const SSB_GAIN = 1; // AGC normalizes level; this is just the start gain

export class AudioStreamManager extends EventEmitter {
  constructor() {
    super();
    this.rtl = null;
    this.dab = new DabReceiver();
    this.meshtastic = new MeshtasticReceiver();
    this.adsb = new AdsbReceiver();
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
    this.demod = 'am'; // HF demodulator (am / usb / lsb / cw)
    // CW (morse) decoding runs on the demodulated audio when the CW demodulator
    // is selected in HF mode.
    this.cw = new CwDecoder();
    this.cw.onText = (text) => this.emit('cw', text);
    this.onPcm = null;
    this.scanning = false;
    this.scan = null;
    this.onPacket = null;
    this.meshtasticKey = 'default';
    this.meshtasticPackets = 0;
    this.meshtastic.on('packet', (packet) => {
      this.meshtasticPackets++;
      if (this.onPacket) this.onPacket(packet);
    });
    this.meshtastic.on('error', (err) => this.emit('error', err));
    this.adsbCount = 0;
    this.adsb.on('aircraft', (aircraft) => {
      this.adsbCount = aircraft.length;
      this.emit('aircraft', aircraft);
    });
    this.adsb.on('info', (message) => this.emit('info', message));
    this.adsb.on('error', (err) => this.emit('error', err));
  }

  async start({ mode = 'fm', host, port, freq, gain = null, service = null, meshtasticKey = 'default', demod = 'am' }) {
    if (this.running) this.stop();
    this.mode = mode;
    this.host = host;
    this.port = port;
    this.freq = freq;
    this.gain = gain;
    this.meshtasticKey = meshtasticKey || 'default';
    this.demod = demod;
    this.meshtasticPackets = 0;
    this.stats = { signal: 0, audio: 0 };
    this.running = true;

    if (mode === 'dab') {
      const dab = this.dab;
      dab.start({ host, port, freqHz: freq, gain: gain ?? 40, service });
      dab.onPcm = (pcm) => {
        if (this.scanning) return; // a DAB scan is sweeping channels, no audio
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

    // Meshtastic uses the same raw 1 Msps stream as the waterfall, but hands it
    // to lorarx instead of producing browser audio.
    if (mode === 'meshtastic') {
      this.decoder = null;
      this.meshtastic.start({ frequency: freq || MESHTASTIC_DEFAULT_FREQ, key: this.meshtasticKey });
    } else if (mode === 'adsb') {
      // ADS-B/Mode S: rtl_tcp IQ is piped straight into dump1090 (2 Msps),
      // whose decoded aircraft we forward to the client as a map + table.
      this.decoder = null;
      this.adsb.start({ frequency: freq || ADSB_DEFAULT_FREQ });
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
      // HF band (0-30 MHz): the demodulator (AM / USB / LSB / CW) is chosen
      // separately for the tuned frequency. All four share the same 1 Msps
      // front-end so switching demodulators never retunes the hardware.
      this.decoder = this._createHfDecoder(demod);
    } else if (mode !== 'meshtastic' && mode !== 'adsb') {
      this.decoder = new FmDecoder();
    }
    if (this.decoder) this.decoder.reset();
    if (this.cw) this.cw.reset();
    // NFM/HF capture the whole 1 Msps band; a full-rate FFT on every
    // 2048-sample block (~488/s) is far more waterfall than the 20 lines/s
    // display needs and steals CPU from the audio path while the user rides the
    // tuning knob. Stride the FFT so the waterfall stays smooth but costs a
    // fraction of the CPU.
    const hf = mode === 'am';
    const nfmAm = mode === 'nfm' || hf;
    this.spec = new SpectrumAnalyzer({
      sampleRate: mode === 'meshtastic' ? MESHTASTIC_SAMPLE_RATE : mode === 'adsb' ? ADSB_SAMPLE_RATE : nfmAm ? AM_SAMPLE_RATE : DEFAULT_SAMPLE_RATE,
      fftEvery: nfmAm || mode === 'meshtastic' || mode === 'adsb' ? 4 : 1,
    });
    this.spec.onSpectrum = (line) => {
      if (this.onSpectrum) this.onSpectrum(line);
    };
    this.spec.reset();
    const rtl = new RtlTcpClient({ host, port, sampleRate: nfmAm || mode === 'meshtastic' ? AM_SAMPLE_RATE : mode === 'adsb' ? ADSB_SAMPLE_RATE : DEFAULT_SAMPLE_RATE });
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
      const tunerFreq = mode === 'meshtastic' ? freq - MESHTASTIC_IF_OFFSET : freq;
      await rtl.connect({ freq: tunerFreq, gain });
    } catch (err) {
      this.running = false;
      this.connected = false;
      this.rtl = null;
      throw err;
    }
    this.connected = true;
    this.captureCenter = mode === 'meshtastic' ? freq - MESHTASTIC_IF_OFFSET : freq;
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
    if (this.mode === 'meshtastic') {
      this.meshtastic.push(chunk);
      this.spec.push(chunk);
      return;
    }
    if (this.mode === 'adsb') {
      this.adsb.push(chunk);
      return;
    }
    const pcm = this.decoder.process(chunk);
    this.spec.push(chunk);
    // CW decode the demodulated audio when the CW demodulator is selected.
    if (this.mode === 'am' && this.demod === 'cw' && this.cw) {
      this.cw.push(pcm);
    }
    // For NFM/HF the whole 1 MHz band is mostly noise, so the raw bandRms
    // is a poor signal indicator; the demodulated audio level (post-AGC/gate)
    // is proportional to the carrier lock instead.
    const narrow = this.mode === 'nfm' || this.mode === 'am';
    const signal = narrow ? Math.min(1, this.decoder.outputRms / 0.18) : this.decoder.bandRms;
    const audio = narrow ? this.decoder.outputRms : this.decoder.audioRms;
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
    if (s.kind === 'dab') {
      // DAB scan: abort the async sweep loop and stop the dab child processes.
      s.aborted = true;
      this.scanning = false;
      this.scan = null;
      this.dab.stop();
      return { total: s.channels.length, found: s.results.length };
    }
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

  // Interactive DAB scan. Sweeps every Band III channel (5A..13F), dwelling
  // ~dwellMs on each so eti-cmdline can lock and dablin can decode the FIC,
  // and collects the service labels + SIds decoded on each channel. Emits
  // 'scan' events:
  //   {kind:'started', total:38}                          scan begins
  //   {kind:'progress', channel, done, total}             dwelling on a channel
  //   {kind:'channel', channel, freqHz, ensemble, services:[{name,sid}], done, total}
  //                                                        a channel finished its dwell
  //   {kind:'done', aborted, total, channels:[{channel, freqHz, ensemble, services}]}
  //                                                        full results (non-empty channels)
  // Unlike the FM/NFM power scan there is no pause-at-hit: the sweep runs the
  // whole band and presents everything at the end. Returns null if not in DAB
  // mode or already scanning.
  startDabScan({ dwellMs = 3000 } = {}) {
    if (this.mode !== 'dab' || this.scanning || !this.dab) return null;
    const channels = BAND_III.map(([name, khz]) => ({ channel: name, freqHz: khz * 1000 }));
    this.scanning = true;
    this.scan = {
      kind: 'dab',
      channels,
      idx: 0,
      results: [],
      dwellMs: Math.max(500, Math.round(Number(dwellMs) || 3000)),
      aborted: false,
    };
    this.emit('scan', { kind: 'started', total: channels.length });
    this._runDabScan();
    return { total: channels.length };
  }

  // Runs the DAB sweep asynchronously: tune each channel, let it dwell, snapshot
  // the decoded services, then move on. Checks this.scan on every step so a
  // stopScan()/tune()/stop() cancels the loop. Each channel is isolated in a
  // try/catch so a single failed channel (e.g. a spawn error or a dropped
  // rtl_tcp connection) can never abort the whole sweep: the scan always runs
  // to the end of the band and emits a 'done' event.
  async _runDabScan() {
    const s = this.scan;
    if (!s || s.kind !== 'dab') return;
    const host = this.host;
    const port = this.port;
    const gain = this.gain ?? 40;
    while (s && !s.aborted && s.idx < s.channels.length) {
      const ch = s.channels[s.idx];
      this.emit('scan', { kind: 'progress', channel: ch.channel, done: s.idx, total: s.channels.length });
      let services = [];
      try {
        this.dab.start({ host, port, freqHz: ch.freqHz, gain, service: null });
        await this._sleep(s.dwellMs);
        if (!this.scan || this.scan.aborted) return;
        services = this.dab.servicesSnapshot();
        // A signal is present when services have decoded or eti-cmdline reports
        // an SNR. dablin prints services incrementally as FIC frames arrive, so
        // keep polling the decoder until the list stops growing (or the extra
        // window is spent) — this catches slow-locking ensembles (e.g. a weak
        // 8B) that would otherwise be skipped after one fixed dwell.
        if (services.length || this.dab.snr != null) {
          // Poll until the list stops growing (or the extra window is spent) —
          // this catches slow-locking ensembles (e.g. a weak 8B) that would
          // otherwise be skipped after one fixed dwell. A signal with no
          // services yet waits out the window; a growing list keeps polling.
          const extraPolls = 3;
          let prevCount = services.length;
          for (let i = 0; i < extraPolls; i++) {
            await this._sleep(Math.max(500, Math.round(s.dwellMs / 3)));
            if (!this.scan || this.scan.aborted) return;
            services = this.dab.servicesSnapshot();
            if (services.length > prevCount) {
              prevCount = services.length; // still growing, keep polling
            } else if (services.length > 0) {
              break; // stable list already decoded
            }
            // zero services: keep waiting out the window for a slow lock
          }
        }
        if (services.length) {
          s.results.push({
            channel: ch.channel,
            freqHz: ch.freqHz,
            ensemble: this.dab.ensemble,
            services,
          });
        }
      } catch (err) {
        console.error(`[dab scan] channel ${ch.channel} failed: ${err.message}`);
      }
      try {
        this.emit('scan', {
          kind: 'channel',
          channel: ch.channel,
          freqHz: ch.freqHz,
          ensemble: this.dab.ensemble,
          services,
          done: s.idx + 1,
          total: s.channels.length,
        });
      } catch (err) {
        console.error(`[dab scan] channel ${ch.channel} broadcast failed: ${err.message}`);
      }
      s.idx++;
    }
    const cur = this.scan;
    if (!cur || cur.kind !== 'dab') return;
    const done = {
      kind: 'done',
      aborted: cur.aborted,
      found: cur.results.reduce((a, c) => a + c.services.length, 0),
      total: cur.channels.length,
      channels: cur.results,
    };
    this.scanning = false;
    this.scan = null;
    try {
      this.emit('scan', done);
    } catch (err) {
      console.error(`[dab scan] done broadcast failed: ${err.message}`);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  // Build the HF (0-30 MHz) demodulator for a given demodulator selection.
  _createHfDecoder(demod) {
    if (demod === 'usb' || demod === 'lsb') {
      return new SsbDecoder({
        inRate: SSB_SAMPLE_RATE,
        audioRate: SSB_AUDIO_RATE,
        audioCutoff: SSB_AUDIO_CUTOFF,
        gain: SSB_GAIN,
        taps: 512,
        outputRate: SSB_OUTPUT_RATE,
        agc: true,
        channelCutoff: SSB_IF_CUTOFF,
        sideband: demod,
        shift: SSB_SHIFT,
      });
    }
    if (demod === 'cw') {
      // CW is received as a beat tone, normally on the upper sideband.
      return new SsbDecoder({
        inRate: SSB_SAMPLE_RATE,
        audioRate: SSB_AUDIO_RATE,
        audioCutoff: SSB_AUDIO_CUTOFF,
        gain: SSB_GAIN,
        taps: 512,
        outputRate: SSB_OUTPUT_RATE,
        agc: true,
        channelCutoff: SSB_IF_CUTOFF,
        sideband: 'usb',
        shift: SSB_SHIFT,
      });
    }
    return new AmDecoder({
      inRate: AM_SAMPLE_RATE,
      audioRate: AM_AUDIO_RATE,
      audioCutoff: AM_AUDIO_CUTOFF,
      gain: AM_GAIN,
      taps: 512,
      outputRate: AM_OUTPUT_RATE,
      agc: true,
      channelCutoff: AM_IF_CUTOFF,
    });
  }

  // Switch the HF demodulator without retuning the hardware (all HF demods use
  // the same 1 Msps front-end). Keeps the digital channel offset so the tuned
  // frequency stays put, and restarts CW decoding.
  setDemod(demod) {
    const d = ['am', 'usb', 'lsb', 'cw'].includes(demod) ? demod : 'am';
    if (this.mode !== 'am' || d === this.demod) return;
    const off = this.captureCenter != null && this.freq != null ? this.freq - this.captureCenter : 0;
    this.demod = d;
    if (this.decoder && this.rtl) {
      this.decoder = this._createHfDecoder(d);
      this.decoder.reset();
      const maxOff = Math.floor((this.decoder.inRate / 2) * 0.8);
      if (this.decoder.setChannelOffset && Math.abs(off) <= maxOff) this.decoder.setChannelOffset(off);
    }
    if (this.cw) this.cw.reset();
    this.emit('status', this.status());
  }

  setMeshtasticKey(key) {
    this.meshtasticKey = key || 'default';
    this.meshtastic.setKey(this.meshtasticKey);
    this.emit('status', this.status());
  }

  tune(freq, service = null) {
    if (this.scanning && this.scan && !this.scan.paused) {
      this.scanning = false;
      this.scan = null;
      this.emit('scan', { kind: 'done', found: 0, total: 0, aborted: true });
    }
    this.freq = freq;
    if (this.cw) this.cw.reset();
    if (this.mode === 'dab') {
      this.stats = { signal: 0, audio: 0 };
      if (this.dab.running) {
        this.dab.start({ host: this.host, port: this.port, freqHz: freq, gain: this.gain ?? 40, service });
        this.connected = this.dab.running;
      }
    } else if (this.rtl && this.connected) {
      if (this.mode === 'meshtastic') {
        this.meshtastic.setFrequency(freq);
        this.rtl.tune(freq - MESHTASTIC_IF_OFFSET);
        this.emit('status', this.status());
        return;
      }
      if (this.mode === 'adsb') {
        this.adsb.setFrequency(freq);
        this.rtl.tune(freq);
        this.captureCenter = freq;
        this.emit('status', this.status());
        return;
      }
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
    this.meshtastic.stop();
    this.adsb.stop();
    this.dab.stop();
    if (this.cw) this.cw.reset();
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
      demod: this.mode === 'am' ? this.demod : null,
      meshtasticPackets: this.mode === 'meshtastic' ? this.meshtasticPackets : 0,
      adsbCount: this.mode === 'adsb' ? this.adsbCount : 0,
      scanning: this.scanning,
      signal: this.stats.signal,
      audio: this.stats.audio,
    };
  }
}
