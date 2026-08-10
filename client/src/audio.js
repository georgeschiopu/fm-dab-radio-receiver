const TARGET_SAMPLE_RATE = 48000;

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.nextTime = 0;
    this.playing = false;
    this.rate = TARGET_SAMPLE_RATE;
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ sampleRate: TARGET_SAMPLE_RATE });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.5;
    this.gain.connect(this.ctx.destination);
    await this.ctx.resume();
  }

  setRate(rate) {
    if (Number.isFinite(rate) && rate > 0) this.rate = rate;
  }

  start() {
    if (!this.ctx) return;
    this.playing = true;
    this.nextTime = this.ctx.currentTime + 0.12;
  }

  push(pcm) {
    if (!this.playing || !this.ctx || pcm.length === 0) return;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, pcm.length, this.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    if (this.nextTime < ctx.currentTime + 0.02) this.nextTime = ctx.currentTime + 0.02;
    if (this.nextTime - ctx.currentTime > 1.0) this.nextTime = ctx.currentTime + 0.1;
    src.start(this.nextTime);
    this.nextTime += buf.duration;
  }

  setVolume(v) {
    if (this.gain) this.gain.gain.value = v;
  }

  stop() {
    this.playing = false;
  }

  async close() {
    this.playing = false;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* already closed */
      }
      this.ctx = null;
    }
  }
}
