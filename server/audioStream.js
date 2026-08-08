import { EventEmitter } from 'node:events';
import { RtlTcpClient } from './rtlTcp.js';
import { FmDecoder } from './dsp.js';
import { SpectrumAnalyzer } from './spectrum.js';
import { DabReceiver } from './dab.js';

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

    // FM mode: direct rtl_tcp IQ handled in-process
    this.decoder.reset();
    this.spec.reset();
    const rtl = new RtlTcpClient({ host, port });
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
    this.stats = { signal: this.decoder.bandRms, audio: this.decoder.audioRms };
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
      ensemble: this.mode === 'dab' ? this.dab.ensemble : null,
      snr: this.mode === 'dab' ? this.dab.snr : null,
      services: this.mode === 'dab' ? this.dab.services : [],
      rate: this.mode === 'dab' ? this.dab.rate : null,
      signal: this.stats.signal,
      audio: this.stats.audio,
    };
  }
}
