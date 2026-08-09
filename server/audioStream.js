import { EventEmitter } from 'node:events';
import { RtlTcpClient, DEFAULT_SAMPLE_RATE } from './rtlTcp.js';
import { FmDecoder, AmDecoder } from './dsp.js';
import { SpectrumAnalyzer } from './spectrum.js';
import { DabReceiver } from './dab.js';

const NFM_SAMPLE_RATE = 1_000_000; // ±0.5 MHz visible span
const NFM_AUDIO_RATE = 50_000; // integer decimation of 1 MHz; resampled to 48k server-side
const NFM_OUTPUT_RATE = 48_000; // final rate sent to the browser (matches AudioContext)
const NFM_AUDIO_CUTOFF = 4_000; // voice-grade NFM bandwidth
const NFM_GAIN = 1; // AGC normalizes level; this is just the start gain

const AM_SAMPLE_RATE = 1_000_000; // same span as NFM so the waterfall is shared
const AM_AUDIO_RATE = 50_000; // integer decimation of 1 MHz; resampled to 48k server-side
const AM_OUTPUT_RATE = 48_000; // final rate sent to the browser (matches AudioContext)
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
    this.gain = null;
    this.squelch = 0; // NFM squelch level, 0 = off
    this.stats = { signal: 0, audio: 0 };
    this.onPcm = null;
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
    this.emit('status', this.status());
  }

  _onIq(chunk) {
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
    this.freq = freq;
    this.stats = { signal: 0, audio: 0 };
    if (this.mode === 'dab') {
      if (this.dab.running) {
        this.dab.start({ host: this.host, port: this.port, freqHz: freq, gain: this.gain ?? 40, service });
        this.connected = this.dab.running;
      }
    } else if (this.rtl && this.connected) {
      this.rtl.tune(freq);
    }
    this.emit('status', this.status());
  }

  stop() {
    this.running = false;
    this.connected = false;
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
      squelch: this.mode === 'nfm' ? this.squelch : 0,
      signal: this.stats.signal,
      audio: this.stats.audio,
    };
  }
}
