import { describe, it, expect } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import { RtlTcpClient, CMD, DEFAULT_SAMPLE_RATE } from './rtlTcp.js';
import { FmDecoder, AmDecoder, LinearResampler, ChannelPowerMeter } from './dsp.js';
import { SpectrumAnalyzer, DEFAULT_BINS } from './spectrum.js';
import { channelBlockForFreq, channelFreqKHz, DabReceiver } from './dab.js';
import { imageSizeOfFile } from './fmLogos.js';
import {
  getPresets,
  setPresets,
  setPresetsFileForTests,
} from './presets.js';
import {
  registerUser,
  loginUser,
  sessionUser,
  setUsersFileForTests,
} from './auth.js';

function synthFmIq(samples, { fs = 288_000, modFreq = 1000, dev = 40000 } = {}) {
  const buf = Buffer.alloc(samples * 2);
  let phase = 0;
  for (let s = 0; s < samples; s++) {
    const audio = Math.sin((2 * Math.PI * modFreq * s) / fs);
    phase += (2 * Math.PI * dev * audio) / fs;
    phase %= 2 * Math.PI;
    buf[s * 2] = 128 + Math.round(Math.cos(phase) * 110);
    buf[s * 2 + 1] = 128 + Math.round(Math.sin(phase) * 110);
  }
  return buf;
}

// FM carrier with a fixed residual frequency offset (and configurable amplitude).
function synthFmOffsetIq(samples, { fs = 288_000, modFreq = 1000, dev = 40000, offset = 1200, amp = 110 } = {}) {
  const buf = Buffer.alloc(samples * 2);
  let phase = 0;
  let offsetPhase = 0;
  for (let s = 0; s < samples; s++) {
    const audio = Math.sin((2 * Math.PI * modFreq * s) / fs);
    phase += (2 * Math.PI * dev * audio) / fs;
    offsetPhase += (2 * Math.PI * offset) / fs;
    const total = phase + offsetPhase;
    buf[s * 2] = 128 + Math.round(Math.cos(total) * amp);
    buf[s * 2 + 1] = 128 + Math.round(Math.sin(total) * amp);
  }
  return buf;
}

function writeWav(path, pcm, sampleRate) {
  const n = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + n * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(n * 2, 40);
  const pcmBuf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  fs.writeFileSync(path, Buffer.concat([header, pcmBuf]));
}

function synthNoiseIq(samples, seed = 12345) {
  const buf = Buffer.alloc(samples * 2);
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < samples; i++) {
    buf[i * 2] = Math.round(128 + (rand() - 0.5) * 200);
    buf[i * 2 + 1] = Math.round(128 + (rand() - 0.5) * 200);
  }
  return buf;
}

function feedAll(dec, iq, CH) {
  const chunks = [];
  for (let i = 0; i < iq.length; i += CH * 2) {
    chunks.push(dec.process(iq.subarray(i, Math.min(i + CH * 2, iq.length))));
  }
  return chunks;
}

function rmsOf(chunks) {
  const last = chunks[chunks.length - 1];
  let sum = 0;
  for (let i = 0; i < last.length; i++) sum += (last[i] / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, last.length));
}

// Wanted NFM carrier at 0 Hz (1 kHz audio) plus a strong FM signal at +adjOff
// kHz (1.5 kHz audio). Before the channel filter this bleeds into the wanted
// channel's passband; after it, the adjacent signal must be rejected.
// Amplitudes are scaled so the composite never exceeds the int8 IQ range.
function synthFmPlusAdjacent(samples, { fs = 1_000_000, wantedFreq = 1000, wantedDev = 2500, adjOff = 100_000, adjFreq = 1500, adjDev = 2500, adjGain = 2 } = {}) {
  const buf = Buffer.alloc(samples * 2);
  let pw = 0;
  let pa = 0;
  const a1 = 35; // wanted amplitude
  const a2 = 35 * adjGain; // adjacent is stronger => harder rejection
  for (let s = 0; s < samples; s++) {
    const mw = Math.sin((2 * Math.PI * wantedFreq * s) / fs);
    const ma = Math.sin((2 * Math.PI * adjFreq * s) / fs);
    pw += (2 * Math.PI * wantedDev * mw) / fs;
    pa += (2 * Math.PI * adjDev * ma) / fs;
    const phiW = pw;
    const phiA = (2 * Math.PI * adjOff * s) / fs + pa;
    const xr = a1 * Math.cos(phiW) + a2 * Math.cos(phiA);
    const xi = a1 * Math.sin(phiW) + a2 * Math.sin(phiA);
    buf[s * 2] = 128 + Math.round(xr);
    buf[s * 2 + 1] = 128 + Math.round(xi);
  }
  return buf;
}

// AM: carrier at +cOff kHz (0 = centered on the tuned channel), amplitude-
// modulated by a 1 kHz tone at 50%.
function synthAmIq(samples, { fs = 1_000_000, cOff = 0, modFreq = 1000, depth = 0.5 } = {}) {
  const buf = Buffer.alloc(samples * 2);
  for (let s = 0; s < samples; s++) {
    const t = s / fs;
    const env = 0.6 * (1 + depth * Math.sin(2 * Math.PI * modFreq * t));
    const ph = 2 * Math.PI * cOff * t;
    buf[s * 2] = 128 + Math.round(env * Math.cos(ph) * 110);
    buf[s * 2 + 1] = 128 + Math.round(env * Math.sin(ph) * 110);
  }
  return buf;
}

describe('rtl-tcp protocol', () => {
  it('parses the header and sends tune commands in order', async () => {
    const receivedCmds = [];
    const server = net.createServer((sock) => {
      const header = Buffer.alloc(12);
      header.write('RTL0', 0, 'latin1');
      header.writeUInt32BE(2, 4);
      header.writeUInt32BE(5, 8);
      sock.write(header);
      sock.on('data', (chunk) => {
        for (let i = 0; i + 4 < chunk.length; i += 5) {
          receivedCmds.push([chunk[i], chunk.readUInt32BE(i + 1)]);
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const client = new RtlTcpClient({ host: '127.0.0.1', port });
    const info = await client.connect({ freq: 97_900_000 });
    expect(info.magic).toBe('RTL0');
    expect(info.tunerType).toBe(2);
    expect(info.tunerGainCount).toBe(5);

    client.tune(88_500_000);
    await new Promise((r) => setTimeout(r, 200));
    client.close();
    server.close();

    const expected = [
      [CMD.SET_SAMPLE_RATE, DEFAULT_SAMPLE_RATE],
      [CMD.SET_GAIN_MODE, 0],
      [CMD.SET_AGC_MODE, 0],
      [CMD.SET_OFFSET_TUNING, 1],
      [CMD.SET_FREQ, 97_900_000],
      [CMD.SET_FREQ, 88_500_000],
    ];
    expect(receivedCmds).toEqual(expected);
  });
});

describe('FM DSP', () => {
  it('demodulates a clean 1 kHz tone', () => {
    const samples = 576_000; // 2 s at 288 ksps
    const iq = synthFmIq(samples);
    const dec = new FmDecoder();
    const chunks = [];
    const CH = 60000;
    for (let i = 0; i < iq.length; i += CH * 2) {
      chunks.push(dec.process(iq.subarray(i, Math.min(i + CH * 2, iq.length))));
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const expectedOut = Math.floor(samples / 6);
    expect(Math.abs(total - expectedOut)).toBeLessThanOrEqual(2);

    const pcm = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    writeWav('/tmp/fm_test.wav', pcm, 48000);

    let sumSq = 0;
    let c = 0;
    let s = 0;
    const N = pcm.length;
    for (let i = 0; i < N; i++) {
      const y = pcm[i] / 32768;
      sumSq += y * y;
      const w = (2 * Math.PI * 1000 * i) / 48000;
      c += y * Math.cos(w);
      s += y * Math.sin(w);
    }
    const totalPow = sumSq / N;
    const tonePow = ((c * c + s * s) / N) / N;
    const rms = Math.sqrt(totalPow);
    const ratio = totalPow > 0 ? tonePow / totalPow : 0;

    const toneAt = (freq) => {
      let tc = 0;
      let ts = 0;
      for (let i = 0; i < N; i++) {
        const w = (2 * Math.PI * freq * i) / 48000;
        tc += (pcm[i] / 32768) * Math.cos(w);
        ts += (pcm[i] / 32768) * Math.sin(w);
      }
      return ((tc * tc + ts * ts) / N) / N / totalPow;
    };

    console.log(`  output samples: ${N}, rms: ${rms.toFixed(4)}, 1kHz tone ratio: ${ratio.toFixed(3)}`);
    console.log(`  tone ratios @500Hz=${toneAt(500).toFixed(3)} @1000Hz=${ratio.toFixed(3)} @1500Hz=${toneAt(1500).toFixed(3)}`);

    expect(rms).toBeGreaterThan(0.01);
    expect(rms).toBeLessThan(0.5);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeGreaterThan(toneAt(500) * 5);
    expect(ratio).toBeGreaterThan(toneAt(1500) * 5);
  });
});

describe('NFM DSP', () => {
  it('demodulates a clean 1 kHz tone at 1 Msps', () => {
    const samples = 2_000_000; // 2 s at 1 Msps
    const iq = synthFmIq(samples, { fs: 1_000_000, modFreq: 1000, dev: 2500 });
    const dec = new FmDecoder({ inRate: 1_000_000, audioRate: 50_000, audioCutoff: 4_000, deemphasis: 0, gain: 1, taps: 512, channelFirst: true, channelCutoff: 6_000 });
    const chunks = [];
    const CH = 60000;
    for (let i = 0; i < iq.length; i += CH * 2) {
      chunks.push(dec.process(iq.subarray(i, Math.min(i + CH * 2, iq.length))));
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const expectedOut = Math.floor(samples / 20);
    expect(Math.abs(total - expectedOut)).toBeLessThanOrEqual(2);

    const pcm = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    writeWav('/tmp/nfm_test.wav', pcm, 50000);

    const N = pcm.length;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const y = pcm[i] / 32768;
      sumSq += y * y;
    }
    const totalPow = sumSq / N;
    const rms = Math.sqrt(totalPow);
    const toneAt = (freq) => {
      let tc = 0;
      let ts = 0;
      for (let i = 0; i < N; i++) {
        const w = (2 * Math.PI * freq * i) / 50000;
        tc += (pcm[i] / 32768) * Math.cos(w);
        ts += (pcm[i] / 32768) * Math.sin(w);
      }
      return ((tc * tc + ts * ts) / N) / N / totalPow;
    };
    const ratio = toneAt(1000);
    console.log(`  output samples: ${N}, rms: ${rms.toFixed(4)}, 1kHz tone ratio: ${ratio.toFixed(3)}`);
    console.log(`  tone ratios @500Hz=${toneAt(500).toFixed(3)} @1000Hz=${ratio.toFixed(3)} @1500Hz=${toneAt(1500).toFixed(3)}`);

    expect(rms).toBeGreaterThan(0.01);
    expect(rms).toBeLessThan(0.5);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeGreaterThan(toneAt(500) * 5);
    expect(ratio).toBeGreaterThan(toneAt(1500) * 5);
  });
});

describe('NFM AGC and squelch', () => {
  it('normalizes level and mutes noise when squelch is enabled', () => {
    const CH = 60000;
    const strong = synthFmIq(1_000_000, { fs: 1_000_000, modFreq: 1000, dev: 5000 });
    const weak = synthFmIq(1_000_000, { fs: 1_000_000, modFreq: 1000, dev: 1000 });
    const noise = synthNoiseIq(1_000_000);

    const mkDec = (squelch = 0) =>
      new FmDecoder({ inRate: 1_000_000, audioRate: 50_000, audioCutoff: 4_000, deemphasis: 0, gain: 1, taps: 512, outputRate: 48_000, agc: true, squelch, channelFirst: true, channelCutoff: 6_000 });

    const decStrong = mkDec();
    const outStrong = feedAll(decStrong, strong, CH);
    const rmsStrong = rmsOf(outStrong);
    expect(rmsStrong).toBeGreaterThan(0.08);
    expect(rmsStrong).toBeLessThan(0.35);

    const decWeak = mkDec();
    const outWeak = feedAll(decWeak, weak, CH);
    const rmsWeak = rmsOf(outWeak);
    expect(rmsWeak).toBeGreaterThan(0.08);
    expect(rmsWeak).toBeLessThan(0.35);

    const decNoiseOpen = mkDec();
    const outNoiseOpen = feedAll(decNoiseOpen, noise, CH);
    expect(decNoiseOpen.squelch).toBe(0);
    let openEnergy = 0;
    for (const c of outNoiseOpen) for (const v of c) openEnergy += (v / 32768) ** 2;
    expect(openEnergy).toBeGreaterThan(1e-4);

    const decNoise = mkDec(1);
    const outNoise = feedAll(decNoise, noise, CH);
    expect(decNoise.squelchOpen).toBe(false);
    let noiseEnergy = 0;
    for (const c of outNoise) for (const v of c) noiseEnergy += (v / 32768) ** 2;
    expect(noiseEnergy).toBeLessThan(1e-6);

    const decSig = mkDec(1);
    const outSig = feedAll(decSig, strong, CH);
    expect(decSig.squelchOpen).toBe(true);
    expect(rmsOf(outSig)).toBeGreaterThan(0.05);

    const decToggle = mkDec();
    decToggle.setSquelch(1);
    const outToggle = feedAll(decToggle, noise, CH);
    let toggleEnergy = 0;
    for (const c of outToggle) for (const v of c) toggleEnergy += (v / 32768) ** 2;
    expect(toggleEnergy).toBeLessThan(1e-6);

    console.log(`  strong rms=${rmsStrong.toFixed(3)}, weak rms=${rmsWeak.toFixed(3)}`);
  });
});

describe('NFM adjacent-channel rejection', () => {
  it('rejects a strong +100 kHz adjacent station', () => {
    const samples = 2_000_000; // 2 s at 1 Msps
    const iq = synthFmPlusAdjacent(samples);
    const dec = new FmDecoder({ inRate: 1_000_000, audioRate: 50_000, audioCutoff: 4_000, deemphasis: 0, gain: 1, taps: 512, outputRate: 48_000, agc: true, channelFirst: true, channelCutoff: 6_000 });
    const chunks = [];
    const CH = 60000;
    for (let i = 0; i < iq.length; i += CH * 2) {
      chunks.push(dec.process(iq.subarray(i, Math.min(i + CH * 2, iq.length))));
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const pcm = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    const N = pcm.length;
    const totalPow = (() => {
      let s = 0;
      for (let i = 0; i < N; i++) s += (pcm[i] / 32768) ** 2;
      return s / N;
    })();
    const toneAt = (freq) => {
      let tc = 0;
      let ts = 0;
      for (let i = 0; i < N; i++) {
        const w = (2 * Math.PI * freq * i) / 48000;
        tc += (pcm[i] / 32768) * Math.cos(w);
        ts += (pcm[i] / 32768) * Math.sin(w);
      }
      return ((tc * tc + ts * ts) / N) / N / totalPow;
    };
    const wantedRatio = toneAt(1000);
    const adjacentRatio = toneAt(1500);
    console.log(`  1kHz (wanted) ratio=${wantedRatio.toFixed(3)}, 1.5kHz (adjacent) ratio=${adjacentRatio.toFixed(3)}`);
    expect(wantedRatio).toBeGreaterThan(0.4);
    expect(adjacentRatio).toBeLessThan(0.03);
  });
});

describe('NFM digital offset tuning', () => {
  it('mixes a 30 kHz-offset carrier to baseband', () => {
    const samples = 2_000_000; // 2 s at 1 Msps
    const iq = synthFmOffsetIq(samples, { fs: 1_000_000, modFreq: 1000, dev: 2500, offset: 30_000 });
    const dec = new FmDecoder({ inRate: 1_000_000, audioRate: 50_000, audioCutoff: 4_000, deemphasis: 0, gain: 1, taps: 512, outputRate: 48_000, agc: true, channelFirst: true, channelCutoff: 6_000 });
    dec.setChannelOffset(30_000);

    const chunks = [];
    const CH = 60000;
    for (let i = 0; i < iq.length; i += CH * 2) {
      chunks.push(dec.process(iq.subarray(i, Math.min(i + CH * 2, iq.length))));
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const pcm = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    const N = pcm.length;
    const totalPow = (() => {
      let s = 0;
      for (let i = 0; i < N; i++) s += (pcm[i] / 32768) ** 2;
      return s / N;
    })();
    const toneAt = (freq) => {
      let tc = 0;
      let ts = 0;
      for (let i = 0; i < N; i++) {
        const w = (2 * Math.PI * freq * i) / 48000;
        tc += (pcm[i] / 32768) * Math.cos(w);
        ts += (pcm[i] / 32768) * Math.sin(w);
      }
      return ((tc * tc + ts * ts) / N) / N / totalPow;
    };
    const ratio = toneAt(1000);
    console.log(`  output samples: ${N}, 1kHz tone ratio: ${ratio.toFixed(3)} (offset carrier mixed to baseband)`);
    expect(ratio).toBeGreaterThan(0.4);
  });
});

describe('AM DSP', () => {
  it('demodulates a clean 1 kHz tone', () => {
    const samples = 2_000_000; // 2 s at 1 Msps
    const iq = synthAmIq(samples);
    const dec = new AmDecoder({ inRate: 1_000_000, audioRate: 50_000, audioCutoff: 5_000, gain: 1, taps: 512, outputRate: 48_000, agc: true });
    const chunks = [];
    const CH = 60000;
    for (let i = 0; i < iq.length; i += CH * 2) {
      chunks.push(dec.process(iq.subarray(i, Math.min(i + CH * 2, iq.length))));
    }
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const expectedOut = Math.floor((samples / 20) * (48_000 / 50_000));
    expect(Math.abs(total - expectedOut)).toBeLessThanOrEqual(2);

    const pcm = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    writeWav('/tmp/am_test.wav', pcm, 48000);

    const N = pcm.length;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const y = pcm[i] / 32768;
      sumSq += y * y;
    }
    const totalPow = sumSq / N;
    const rms = Math.sqrt(totalPow);
    const toneAt = (freq) => {
      let tc = 0;
      let ts = 0;
      for (let i = 0; i < N; i++) {
        const w = (2 * Math.PI * freq * i) / 48000;
        tc += (pcm[i] / 32768) * Math.cos(w);
        ts += (pcm[i] / 32768) * Math.sin(w);
      }
      return ((tc * tc + ts * ts) / N) / N / totalPow;
    };
    const ratio = toneAt(1000);
    console.log(`  output samples: ${N}, rms: ${rms.toFixed(4)}, 1kHz tone ratio: ${ratio.toFixed(3)}`);
    console.log(`  tone ratios @500Hz=${toneAt(500).toFixed(3)} @1000Hz=${ratio.toFixed(3)} @1500Hz=${toneAt(1500).toFixed(3)}`);

    expect(rms).toBeGreaterThan(0.01);
    expect(rms).toBeLessThan(0.5);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeGreaterThan(toneAt(500) * 5);
    expect(ratio).toBeGreaterThan(toneAt(1500) * 5);
  });
});

describe('Channel power meter', () => {
  it('separates on-channel signal from adjacent channels and noise', () => {
    const fs = 288_000;
    const meter = new ChannelPowerMeter({ inRate: fs });

    const strong = synthFmOffsetIq(576_000, { fs, offset: 1200 });
    const onCh = meter.process(strong);
    expect(onCh).toBeGreaterThan(0.3);

    const quiet = synthFmOffsetIq(576_000, { fs, offset: 1200, amp: 0 });
    const floor = meter.process(quiet);
    expect(floor).toBeLessThan(0.05);

    const adjacent = synthFmOffsetIq(576_000, { fs, offset: 1200 + 100_000 });
    const adj = meter.process(adjacent);
    expect(adj).toBeLessThan(0.1);
    expect(onCh).toBeGreaterThan(adj * 3);

    console.log(`  on-channel=${onCh.toFixed(4)}  adjacent(+100kHz)=${adj.toFixed(4)}  noise-floor=${floor.toFixed(4)}`);
  });
});

describe('Resampler', () => {
  it('is length-correct and tone-preserving across 50k->48k', () => {
    const n = 100_000; // 2 s at 50 kHz
    const input = new Float64Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / 50_000);

    const oneShot = new LinearResampler(50_000, 48_000);
    const out = oneShot.process(input);
    expect(Math.abs(out.length - 96_000)).toBeLessThanOrEqual(5);

    const chunked = new LinearResampler(50_000, 48_000);
    const parts = [];
    for (let i = 0; i < n; i += 4096) {
      parts.push(chunked.process(input.subarray(i, Math.min(i + 4096, n))));
    }
    const total = parts.reduce((a, c) => a + c.length, 0);
    expect(Math.abs(total - out.length)).toBeLessThanOrEqual(2);

    let tc = 0;
    let ts = 0;
    let pow = 0;
    for (let i = 0; i < out.length; i++) {
      const w = (2 * Math.PI * 1000 * i) / 48_000;
      tc += out[i] * Math.cos(w);
      ts += out[i] * Math.sin(w);
      pow += out[i] * out[i];
    }
    const ratio = ((tc * tc + ts * ts) / out.length) / out.length / (pow / out.length);
    expect(ratio).toBeGreaterThan(0.45);
    console.log(`  ${n} -> ${out.length} samples (${total} chunked), 1kHz tone ratio=${ratio.toFixed(3)}`);
  });
});

describe('Spectrum analyzer', () => {
  it('localizes a +20 kHz carrier to the expected display bin', () => {
    const sr = DEFAULT_SAMPLE_RATE;
    const fftSize = 2048;
    const n = fftSize * 40; // 40 blocks
    const buf = Buffer.alloc(n * 2);
    const f = 20_000; // +20 kHz carrier
    let ph = 0;
    for (let s = 0; s < n; s++) {
      ph += (2 * Math.PI * f) / sr;
      buf[s * 2] = 128 + Math.round(Math.cos(ph) * 110);
      buf[s * 2 + 1] = 128 + Math.round(Math.sin(ph) * 110);
    }

    const an = new SpectrumAnalyzer({ sampleRate: sr, fps: 20 });
    expect(an.bins).toBe(DEFAULT_BINS);
    const lines = [];
    an.onSpectrum = (d) => lines.push(Uint8Array.from(d));

    const CH = 2048;
    for (let i = 0; i < buf.length; i += CH * 2) {
      an.push(buf.subarray(i, i + CH * 2));
    }

    expect(lines.length).toBeGreaterThanOrEqual(2);
    const last = lines[lines.length - 1];
    expect(last.length).toBe(DEFAULT_BINS);

    const expBin = Math.floor(((f + sr / 2) / sr) * DEFAULT_BINS);
    let best = -1;
    let bestVal = -1;
    for (let d = 0; d < DEFAULT_BINS; d++) {
      if (last[d] > bestVal) {
        bestVal = last[d];
        best = d;
      }
    }
    expect(Math.abs(best - expBin)).toBeLessThanOrEqual(3);
    console.log(`  lines: ${lines.length}, peak at display bin ${best} (expected ~${expBin})`);
  });
});

describe('DAB PCM conversion', () => {
  it('averages stereo int16 frames into mono PCM', () => {
    const rec = new DabReceiver();
    rec._setFormat(48000, 2, false);

    const out = [];
    rec.onPcm = (pcm, rate) => out.push({ pcm, rate });

    const nFrames = 100;
    const buf = Buffer.alloc(nFrames * 4);
    for (let i = 0; i < nFrames; i++) {
      buf.writeInt16LE(1000, i * 4);
      buf.writeInt16LE(2000, i * 4 + 2);
    }
    rec._onPcm(buf);

    expect(out.length).toBe(1);
    const { pcm, rate } = out[0];
    expect(pcm.length).toBe(nFrames);
    expect(rate).toBe(48000);
    expect(pcm[0]).toBe(1500);
    expect(Math.abs(pcm[nFrames - 1] - 1500)).toBe(0);
    console.log(`OK: ${pcm.length} int16 mono samples from int16 stereo, avg sample=${pcm[0]}`);
  });
});

describe('DAB channel map', () => {
  it('maps band-III frequencies to channel names and back', () => {
    const cases = [
      [174928000, '5A'],
      [192352000, '7C'],
      [195936000, '8A'],
      [206352000, '9C'],
      [209936000, '10A'],
      [216928000, '11A'],
      [227360000, '12C'],
      [239200000, '13F'],
    ];
    for (const [freq, expected] of cases) {
      expect(channelBlockForFreq(freq)).toBe(expected);
    }
    expect(channelFreqKHz('11A')).toBe(216928);
    expect(channelFreqKHz('ZZ')).toBe(null);
    console.log(`OK: ${cases.length} channel mappings + roundtrip correct`);
  });
});

describe('Preset store', () => {
  it('stores presets per-user with sanitization and disk persistence', () => {
    const file = `/tmp/opencode-presets-${process.pid}.json`;
    setPresetsFileForTests(file);
    try {
      expect(Array.isArray(getPresets('alice', 'fm')) && getPresets('alice', 'fm').length === 0).toBe(true);
      const added = setPresets('alice', 'fm', [
        { name: 'Radio1', freq: '95.1', service: 'Radio One' },
        { name: '', freq: '99.9' },
        null,
        { name: 'X'.repeat(100), freq: '98.0' },
      ]);
      expect(added.length).toBe(2);
      expect(added[0].name).toBe('Radio1');
      expect(added[0].service).toBe('Radio One');
      expect(added[1].name.length).toBe(80);
      expect(getPresets('alice', 'nfm').length).toBe(0);
      expect(getPresets('bob', 'fm').length).toBe(0);
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(stored.alice.fm.length).toBe(2);
      expect(stored.alice.fm[0].name).toBe('Radio1');
      setPresets('alice', 'am', [{ name: 'AM1', freq: '7.1' }]);
      setPresets('bob', 'fm', [{ name: 'Bob FM', freq: '88.8' }]);
      const aliceAm = getPresets('alice', 'am');
      expect(aliceAm.length).toBe(1);
      expect(aliceAm[0].mode).toBe('am');
      expect(getPresets('bob', 'fm').length).toBe(1);
      expect(getPresets('alice', 'fm').length).toBe(2);
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('Auth', () => {
  it('registers, logs in, and verifies session tokens with hashed passwords', () => {
    const file = `/tmp/opencode-users-${process.pid}.json`;
    setUsersFileForTests(file);
    try {
      const reg = registerUser('Alice', 'secret123');
      expect(reg.ok).toBe(true);
      expect(reg.username).toBe('alice');
      expect(typeof reg.token).toBe('string');

      const dup = registerUser('ALICE', 'other123');
      expect(dup.ok).toBeFalsy();
      expect(dup.error).toBeTruthy();

      const badName = registerUser('a', 'secret123');
      expect(badName.ok).toBeFalsy();

      const shortPass = registerUser('bob', '123');
      expect(shortPass.ok).toBeFalsy();

      const wrongPass = loginUser('alice', 'nope123');
      expect(wrongPass.ok).toBeFalsy();

      const missing = loginUser('nobody', 'secret123');
      expect(missing.ok).toBeFalsy();

      const login = loginUser('Alice', 'secret123');
      expect(login.ok).toBe(true);
      expect(login.username).toBe('alice');

      expect(sessionUser(login.token)).toBe('alice');
      expect(sessionUser(`${login.token}x`)).toBe(null);
      expect(sessionUser(login.token + '.extra')).toBe(null);

      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(stored.alice).toBeTruthy();
      expect(stored.alice.hash).not.toBe('secret123');
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('Logo image dimensions', () => {
  it('reads width/height from PNG and JPEG headers', () => {
    const dir = `/tmp/opencode-logos-${process.pid}`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000c0000000c0' +
          '0806000000000000000000000000000000',
        'hex'
      );
      const pngFile = `${dir}/logo.png`;
      fs.writeFileSync(pngFile, png);
      expect(imageSizeOfFile(pngFile)).toEqual({ width: 192, height: 192 });

      const jpeg = Buffer.from(
        'ffd8ffc0000b0800400080010100ffd9',
        'hex'
      );
      const jpegFile = `${dir}/logo.jpg`;
      fs.writeFileSync(jpegFile, jpeg);
      expect(imageSizeOfFile(jpegFile)).toEqual({ width: 128, height: 64 });
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('returns null for unknown formats and unreadable files', () => {
    const dir = `/tmp/opencode-logos-${process.pid}`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      const svgFile = `${dir}/logo.svg`;
      fs.writeFileSync(svgFile, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      expect(imageSizeOfFile(svgFile)).toBe(null);
      expect(imageSizeOfFile(`${dir}/missing.png`)).toBe(null);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});