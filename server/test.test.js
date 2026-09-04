import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { RtlTcpClient, CMD, DEFAULT_SAMPLE_RATE } from './rtlTcp.js';
import { FmDecoder, AmDecoder, SsbDecoder, LinearResampler, ChannelPowerMeter } from './dsp.js';
import { SpectrumAnalyzer, DEFAULT_BINS } from './spectrum.js';
import { channelBlockForFreq, channelFreqKHz, DabReceiver } from './dab.js';
import { AudioStreamManager, scanThresholdFor } from './audioStream.js';
import { CwDecoder, MORSE } from './cw.js';
import { parseMeshtasticPacket, resolveMeshtasticKey } from './meshtastic.js';
import { parseSbsLine, AdsbTracker } from './adsb.js';
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

function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 127n) {
    out.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function protobufBytes(field, value) {
  return Buffer.concat([varint(field << 3 | 2), varint(value.length), value]);
}

function protobufVarint(field, value) {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

function encryptedMeshtasticText({ src = 0x12345678, dst = 0xffffffff, packetId = 42, message = 'hello mesh' } = {}) {
  const app = Buffer.concat([protobufVarint(1, 1), protobufBytes(2, Buffer.from(message))]);
  const key = resolveMeshtasticKey('default');
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(packetId, 0);
  iv.writeUInt32LE(src, 8);
  const cipher = crypto.createCipheriv('aes-128-ctr', key, iv);
  const encrypted = Buffer.concat([cipher.update(app), cipher.final()]);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(dst, 0);
  header.writeUInt32LE(src, 4);
  header.writeUInt32LE(packetId, 8);
  header[12] = 0x60;
  header[13] = 0x2a;
  return { crc: 1, payload: Buffer.concat([header, encrypted]).toString('base64') };
}

// Strong unmodulated NFM carrier at +offset Hz (inside the scanner's channel
// filter), used to simulate a live signal on a swept channel.
function synthNfmCarrier(samples, { fs = 1_000_000, offset = 3000, amp = 110 } = {}) {
  const buf = Buffer.alloc(samples * 2);
  for (let s = 0; s < samples; s++) {
    const ph = (2 * Math.PI * offset * s) / fs;
    buf[s * 2] = 128 + Math.round(amp * Math.cos(ph));
    buf[s * 2 + 1] = 128 + Math.round(amp * Math.sin(ph));
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

// Single-sideband: a pure complex exponential at +freq Hz is the analytic
// signal of the wanted sideband (USB) or, at -freq Hz, of LSB, with the
// carrier suppressed. The demodulator must recover that audio tone only from
// the matching sideband and reject the image.
function synthSsbToneIq(samples, { fs = 1_000_000, freq = 1000, amp = 110, side = 'usb' } = {}) {
  const buf = Buffer.alloc(samples * 2);
  const w = (2 * Math.PI * (side === 'usb' ? freq : -freq)) / fs;
  for (let s = 0; s < samples; s++) {
    const ph = w * s;
    buf[s * 2] = 128 + Math.round(amp * Math.cos(ph));
    buf[s * 2 + 1] = 128 + Math.round(amp * Math.sin(ph));
  }
  return buf;
}

// Runs an SSB tone through a decoder (chunked like a real stream) and returns
// the concatenated PCM plus a normalized tone-ratio probe, so a test can check
// both that the wanted 1 kHz tone is recovered and that the image is not.
function decodeSsbStats(iq, dec, CH = 60000) {
  const chunks = [];
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
  let sumSq = 0;
  for (let i = 0; i < N; i++) {
    const y = pcm[i] / 32768;
    sumSq += y * y;
  }
  const rms = Math.sqrt(sumSq / N);
  const totalPow = sumSq / N;
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
  return { pcm, N, rms, toneAt, ratio: toneAt(1000) };
}

// Synthesizes a keyed CW tone for a message: mark = tone, space = low noise
// (standing in for the AGC-boosted noise floor), timed with the standard
// dot=1 / dash=3 / intra=1 / inter-char=3 / word=7 unit ratios.
function synthCwAudio(message, { fs = 48_000, dotSec = 0.06, toneFreq = 700, amp = 0.25, noiseAmp = 0.02 } = {}) {
  const timeline = [];
  const words = message.toUpperCase().split(' ');
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    for (let c = 0; c < word.length; c++) {
      const code = MORSE[word[c]];
      if (!code) continue;
      for (let i = 0; i < code.length; i++) {
        timeline.push({ on: true, u: code[i] === '.' ? 1 : 3 });
        if (i < code.length - 1) timeline.push({ on: false, u: 1 });
      }
      if (c < word.length - 1) timeline.push({ on: false, u: 3 });
    }
    if (w < words.length - 1) timeline.push({ on: false, u: 7 });
  }
  // Trailing silence long enough for the decoder to finalize the last word.
  timeline.push({ on: false, u: 8 });

  const out = [];
  let t = 0;
  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (const seg of timeline) {
    const dur = seg.u * dotSec;
    const n = Math.round(dur * fs);
    for (let k = 0; k < n; k++) {
      if (seg.on) out.push(amp * Math.sin((2 * Math.PI * toneFreq * (t + k / fs))));
      else out.push(noiseAmp * (rand() - 0.5) * 2);
    }
    t += dur;
  }
  return Float32Array.from(out);
}

function decodeCw(audio, dec) {
  let last = '';
  dec.onText = (t) => {
    last = t;
  };
  for (let i = 0; i < audio.length; i += 2048) dec.push(audio.subarray(i, i + 2048));
  dec.flush();
  return last;
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

describe('Meshtastic parser', () => {
  it('decrypts default-key text packets and exposes the packet header', () => {
    const packet = parseMeshtasticPacket(encryptedMeshtasticText(), 'default');
    expect(packet.src).toBe('!12345678');
    expect(packet.dst).toBe('!ffffffff');
    expect(packet.message).toBe('hello mesh');
    expect(packet.portName).toBe('TEXT_MESSAGE_APP');
    expect(packet.hops).toBe('3/3');
  });

  it('suppresses duplicate source and packet ids', () => {
    const raw = encryptedMeshtasticText({ packetId: 99 });
    const seen = new Map();
    expect(parseMeshtasticPacket(raw, 'default', seen)).not.toBeNull();
    expect(parseMeshtasticPacket(raw, 'default', seen)).toBeNull();
  });

  it('expands the Meshtastic short default key', () => {
    expect(resolveMeshtasticKey('AQ==')).toEqual(resolveMeshtasticKey('default'));
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

describe('SSB DSP', () => {
  const mkDecoder = (sideband) =>
    new SsbDecoder({
      inRate: 1_000_000,
      audioRate: 50_000,
      audioCutoff: 1_400,
      gain: 1,
      taps: 512,
      outputRate: 48_000,
      agc: true,
      channelCutoff: 6_000,
      sideband,
      shift: 1_500,
    });

  it('demodulates a USB 1 kHz tone', () => {
    const iq = synthSsbToneIq(1_000_000, { side: 'usb' });
    const { pcm, rms, ratio, toneAt } = decodeSsbStats(iq, mkDecoder('usb'));
    writeWav('/tmp/usb_test.wav', pcm, 48000);
    console.log(`  USB rms=${rms.toFixed(4)} 1kHz ratio=${ratio.toFixed(3)} 500=${toneAt(500).toFixed(3)} 1500=${toneAt(1500).toFixed(3)}`);
    expect(rms).toBeGreaterThan(0.01);
    expect(rms).toBeLessThan(0.5);
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeGreaterThan(toneAt(500) * 5);
    expect(ratio).toBeGreaterThan(toneAt(1500) * 5);
  });

  it('demodulates a LSB 1 kHz tone', () => {
    const iq = synthSsbToneIq(1_000_000, { side: 'lsb' });
    const { pcm, rms, ratio, toneAt } = decodeSsbStats(iq, mkDecoder('lsb'));
    writeWav('/tmp/lsb_test.wav', pcm, 48000);
    console.log(`  LSB rms=${rms.toFixed(4)} 1kHz ratio=${ratio.toFixed(3)} 500=${toneAt(500).toFixed(3)} 1500=${toneAt(1500).toFixed(3)}`);
    expect(rms).toBeGreaterThan(0.01);
    expect(rms).toBeLessThan(0.5);
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeGreaterThan(toneAt(500) * 5);
    expect(ratio).toBeGreaterThan(toneAt(1500) * 5);
  });

  it('rejects the opposite sideband (image) of a wrong-side tone', () => {
    // A USB-coded tone must NOT appear as 1 kHz audio through the LSB path and
    // vice-versa, otherwise adjacent SSB stations would bleed into each other.
    const usb = synthSsbToneIq(1_000_000, { side: 'usb' });
    const lsb = synthSsbToneIq(1_000_000, { side: 'lsb' });
    const sbUsb = decodeSsbStats(usb, mkDecoder('usb'));
    const lsbWrong = decodeSsbStats(usb, mkDecoder('lsb'));
    const usbWrong = decodeSsbStats(lsb, mkDecoder('usb'));
    const sbLsb = decodeSsbStats(lsb, mkDecoder('lsb'));
    console.log(`  image rejection: USB->USB=${sbUsb.ratio.toFixed(3)} USB->LSB=${lsbWrong.ratio.toFixed(3)} LSB->USB=${usbWrong.ratio.toFixed(3)} LSB->LSB=${sbLsb.ratio.toFixed(3)}`);
    // The wanted sideband clearly dominates over the (leaking) image.
    expect(sbUsb.ratio).toBeGreaterThan(lsbWrong.ratio * 5);
    expect(sbLsb.ratio).toBeGreaterThan(usbWrong.ratio * 5);
  });
});

describe('CW decoder', () => {
  it('decodes morse text from a keyed tone', () => {
    const dec = new CwDecoder({ sampleRate: 48_000 });
    const audio = synthCwAudio('SOS', { dotSec: 0.06, toneFreq: 700 });
    const text = decodeCw(audio, dec);
    console.log(`  CW 'SOS' decoded: ${JSON.stringify(text)}`);
    expect(text.trim()).toBe('SOS');
  });

  it('decodes multiple words separated by a gap', () => {
    const dec = new CwDecoder({ sampleRate: 48_000 });
    const audio = synthCwAudio('HI THERE', { dotSec: 0.06, toneFreq: 600 });
    const text = decodeCw(audio, dec);
    console.log(`  CW 'HI THERE' decoded: ${JSON.stringify(text)}`);
    expect(text.replace(/\s+/g, ' ').trim()).toBe('HI THERE');
  });

  it('adapts to a faster (shorter-dot) sender', () => {
    const dec = new CwDecoder({ sampleRate: 48_000 });
    const audio = synthCwAudio('CQ', { dotSec: 0.04, toneFreq: 800 });
    const text = decodeCw(audio, dec);
    console.log(`  CW 'CQ' (40ms dot) decoded: ${JSON.stringify(text)}`);
    expect(text.replace(/\s+/g, ' ').trim()).toBe('CQ');
  });

  it('does not decode an unkeyed continuous tone', () => {
    const dec = new CwDecoder({ sampleRate: 48_000 });
    // One long, uninterrupted tone is not a valid morse sequence.
    const audio = new Float32Array(48_000 * 2);
    for (let i = 0; i < audio.length; i++) audio[i] = 0.25 * Math.sin((2 * Math.PI * 700 * i) / 48_000);
    const text = decodeCw(audio, dec);
    console.log(`  CW continuous tone decoded: ${JSON.stringify(text)}`);
    expect(text).toBe('');
  });
});

describe('HF demodulator selection', () => {
  it('switches AM/USB/LSB/CW without reconnecting and preserves the channel offset', () => {
    const mgr = new AudioStreamManager();
    mgr.mode = 'am';
    mgr.connected = true;
    mgr.captureCenter = 7_000_000;
    mgr.freq = 7_100_000;
    mgr.rtl = { tune: vi.fn() };
    mgr.decoder = mgr._createHfDecoder('am');
    expect(mgr.decoder).toBeInstanceOf(AmDecoder);

    // USB: decoder becomes an SSB demodulator, tuned +100 kHz digitally.
    mgr.setDemod('usb');
    expect(mgr.demod).toBe('usb');
    expect(mgr.decoder).toBeInstanceOf(SsbDecoder);
    expect(mgr.decoder.mixOffset).toBe(100_000);

    // CW uses the SSB demodulator (USB sideband) plus the CW decoder.
    mgr.setDemod('cw');
    expect(mgr.decoder).toBeInstanceOf(SsbDecoder);

    // Non-HF modes ignore demodulator switching.
    mgr.mode = 'nfm';
    mgr.demod = 'am';
    mgr.setDemod('usb');
    expect(mgr.demod).toBe('am');
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

describe('DAB service list parsing', () => {
  it('collects every programme service from SId lines, not just the playing one', () => {
    const rec = new DabReceiver();
    // dablin prints the full ensemble as "SId 0xNNNN: programme service label
    // '...'" and only the currently selected station as "service label '...'".
    rec._handleDablinLine("ensemble label 'BBC National'");
    rec._handleDablinLine("SId 0xC221: programme service label 'BBC Radio 1'");
    rec._handleDablinLine("SId 0xC222: programme service label 'BBC Radio 2'");
    rec._handleDablinLine("SId 0xC423: programme service label 'BBC Radio 3'");
    rec._handleDablinLine("service label 'BBC Radio 1'");

    const snap = rec.servicesSnapshot();
    expect(snap.length).toBe(3);
    expect(snap.map((s) => s.name)).toEqual(['BBC Radio 1', 'BBC Radio 2', 'BBC Radio 3']);
    expect(snap.find((s) => s.name === 'BBC Radio 2').sid).toBe('C222');
    expect(rec.ensemble).toBe('BBC National');
    console.log(`OK: ${snap.length} services from SId lines, e.g. ${snap[1].name} (SId ${snap[1].sid})`);
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
      setPresets('alice', 'am', [{ name: 'AM1', freq: '7.1', demod: 'usb' }]);
      setPresets('bob', 'fm', [{ name: 'Bob FM', freq: '88.8' }]);
      const aliceAm = getPresets('alice', 'am');
      expect(aliceAm.length).toBe(1);
      expect(aliceAm[0].mode).toBe('am');
      expect(aliceAm[0].demod).toBe('usb');
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

  it('backfills modes added after a user record was created', () => {
    const file = `/tmp/opencode-legacy-presets-${process.pid}.json`;
    fs.writeFileSync(file, JSON.stringify({ alice: { fm: [] } }));
    setPresetsFileForTests(file);
    try {
      expect(getPresets('alice', 'meshtastic')).toEqual([]);
      expect(getPresets('alice', 'dab')).toEqual([]);
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

describe('Scanner noise-floor threshold', () => {
  it('scales the measured noise floor by the sensitivity factor', () => {
    expect(scanThresholdFor(0.05, 2.5)).toBeCloseTo(0.125, 5);
    expect(scanThresholdFor(0.05, 1.5)).toBeCloseTo(0.075, 5);
    expect(scanThresholdFor(0, 2.5)).toBe(0.01); // degenerate 0 floor still has a floor
    expect(scanThresholdFor(0.05)).toBeCloseTo(0.125, 5); // default factor
  });
});

// Drives AudioStreamManager's scan path with a fake rtl_tcp, feeding IQ for
// each channel (settle + dwell samples) and asserting on the emitted events.
function setupScanManager({ mode = 'nfm' } = {}) {
  const mgr = new AudioStreamManager();
  mgr.mode = mode;
  mgr.connected = true;
  mgr.rtl = { tune: vi.fn() };
  mgr.decoder = {
    inRate: mode === 'nfm' ? 1_000_000 : DEFAULT_SAMPLE_RATE,
    process: vi.fn(() => new Float32Array(0)),
    setChannelOffset: vi.fn(),
    outputRms: 0,
    audioRms: 0,
    bandRms: 0,
  };
  const events = [];
  mgr.on('scan', (e) => events.push(e));
  return { mgr, events };
}

function feedChannel(mgr, iq) {
  // The active settle window (50 ms for the sweep, 600 ms for peak refinement)
  // is flushed before the dwell measurement begins, so feed it as its own chunk.
  const settle = mgr.scan ? mgr.scan.settleLeft : Math.round(mgr.decoder.inRate * 0.05);
  mgr._onIq(iq.subarray(0, settle * 2));
  mgr._onIq(iq.subarray(settle * 2));
}

// Feeds one settle+dwell step tuned for whatever channel the scan is currently
// on, placing a fixed-RF carrier `F_c` at the correct baseband offset. During
// the peak-refinement pass the scan is on a fine candidate grid, so this keeps
// the synthetic signal at a fixed frequency, exactly like a real on-air signal.
function feedScanTone(mgr, F_c, amp = 110) {
  const s = mgr.scan;
  if (!s) return;
  const nom = s.refining ? s.refine.candidates[s.refine.idx] : s.freqs[s.idx];
  const offset = F_c - (nom + s.ifOffset);
  const rate = mgr.decoder.inRate;
  feedChannel(mgr, synthNfmCarrier(s.settleLeft + s.dwellSamples, { fs: rate, offset, amp }));
}

function feedScanNoise(mgr, seed = 12345) {
  const s = mgr.scan;
  if (!s) return;
  const rate = mgr.decoder.inRate;
  feedChannel(mgr, synthNoiseIq(s.settleLeft + s.dwellSamples, seed));
}

describe('NFM interactive scanner', () => {
  it('pauses on a signal and finishes the sweep after resume', () => {
    const { mgr, events } = setupScanManager({ mode: 'nfm' });
    const start = 144_000_000;
    const step = 25_000;
    const nChannels = 8;
    const stop = start + (nChannels - 1) * step;
    const res = mgr.startScan({ startFreq: start, stopFreq: stop, stepHz: step, threshold: 2.5, dwellMs: 10 });
    expect(res.total).toBe(nChannels);

    // A strong signal 3 kHz above channel 6's LO (clear of the DC spike).
    const F_c = start + 6 * step + mgr.scan.ifOffset + 3_000;
    let guard = 0;
    while (mgr.scanning && !mgr.scan.paused && guard++ < 300) feedScanTone(mgr, F_c);

    const hit = events.find((e) => e.kind === 'hit');
    expect(hit).toBeTruthy();
    expect(hit.freq).toBe(start + 6 * step); // refined peak, not the coarse channel
    expect(hit.signal).toBeGreaterThan(0.1);
    expect(mgr.scanning).toBe(true);
    expect(mgr.scan.paused).toBe(true);

    // The operator decides to keep scanning.
    const cont = mgr.resumeScan();
    expect(cont.total).toBe(nChannels);

    // Finish the remaining channel.
    guard = 0;
    while (mgr.scanning && !events.some((e) => e.kind === 'done') && guard++ < 50) feedScanTone(mgr, F_c);

    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeTruthy();
    expect(done.total).toBe(nChannels);
    expect(done.found).toBe(1);
    expect(done.aborted).toBeFalsy();
    expect(mgr.scanning).toBe(false);
  });

  it('reports the frequency of the strongest signal, not the stale coarse hit', () => {
    const { mgr, events } = setupScanManager({ mode: 'nfm' });
    const start = 144_000_000;
    const step = 25_000;
    mgr.startScan({ startFreq: start, stopFreq: start + 7 * 25_000, stepHz: step, threshold: 2.5, dwellMs: 10 });

    // A real signal 1 kHz inside the bottom of channel 6's coarse window: the
    // coarse dwell fires on channel 6, but the in-window power peaks half a
    // step below, so the refinement must report that half-step channel.
    const F_c = start + 6 * step - 1_000;
    let guard = 0;
    while (mgr.scanning && !mgr.scan.paused && guard++ < 300) feedScanTone(mgr, F_c);

    const hit = events.find((e) => e.kind === 'hit');
    expect(hit).toBeTruthy();
    expect(hit.freq).toBe(start + 6 * step - 12_500); // half-step below the coarse hit
    expect(mgr.scan.paused).toBe(true);
  });

  it('completes with no hits on a quiet band', () => {
    const { mgr, events } = setupScanManager({ mode: 'nfm' });
    const start = 144_000_000;
    const step = 25_000;
    const nChannels = 8;
    const stop = start + (nChannels - 1) * step;
    mgr.startScan({ startFreq: start, stopFreq: stop, stepHz: step, threshold: 2.5, dwellMs: 10 });

    let guard = 0;
    while (mgr.scanning && guard++ < 200) feedScanNoise(mgr, 7000 + guard);

    expect(events.find((e) => e.kind === 'hit')).toBeFalsy();
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeTruthy();
    expect(done.found).toBe(0);
  });

  it('stopScan aborts a paused scan', () => {
    const { mgr } = setupScanManager({ mode: 'nfm' });
    const start = 144_000_000;
    mgr.startScan({ startFreq: start, stopFreq: start + 7 * 25_000, stepHz: 25_000, threshold: 2.5, dwellMs: 10 });

    const F_c = start + 7 * 25_000 + mgr.scan.ifOffset + 3_000; // last channel
    let guard = 0;
    while (mgr.scanning && !mgr.scan.paused && guard++ < 300) feedScanTone(mgr, F_c);

    expect(mgr.scan.paused).toBe(true);
    const r = mgr.stopScan();
    expect(r.found).toBe(1);
    expect(mgr.scanning).toBe(false);
    expect(mgr.scan).toBe(null);
  });
});

describe('DAB scanner', () => {
  // Runs the async DAB sweep to completion with a fake dab receiver and a near-
  // zero sleep so the whole band is swept in a few ticks.
  async function runDabScan({ channelsWithServices = new Map() } = {}) {
    const mgr = new AudioStreamManager();
    mgr.mode = 'dab';
    mgr.connected = true;
    mgr.host = '192.168.0.6';
    mgr.port = 1234;
    mgr.gain = 40;
    mgr.dab = {
      start: vi.fn(({ freqHz }) => {
        mgr.dab._freq = freqHz;
      }),
      stop: vi.fn(),
      servicesSnapshot: vi.fn(() => {
        const ch = mgr.dab._freq / 1000;
        return channelsWithServices.get(ch) || [];
      }),
      running: true,
      channel: null,
      ensemble: null,
    };
    const events = [];
    mgr.on('scan', (e) => events.push(e));
    const origSleep = mgr._sleep;
    mgr._sleep = () => Promise.resolve();
    const res = mgr.startDabScan({ dwellMs: 500 });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('DAB scan timed out')), 5000);
        mgr.on('scan', (e) => {
          if (e.kind === 'done') {
            clearTimeout(t);
            resolve();
          }
        });
      });
    } finally {
      mgr._sleep = origSleep;
    }
    return { mgr, events, res };
  }

  it('sweeps every Band III channel and reports services grouped by channel', async () => {
    // Services only appear on 11A (216928 kHz) and 12A (223936 kHz).
    const chs = new Map([
      [216928, [{ name: 'BBC Radio 1', sid: 'C221' }, { name: 'BBC Radio 2', sid: 'C222' }]],
      [223936, [{ name: 'Classic FM', sid: 'C321' }]],
    ]);
    const { events, res } = await runDabScan({ channelsWithServices: chs });

    expect(res.total).toBe(38);
    const started = events.find((e) => e.kind === 'started');
    expect(started.total).toBe(38);

    const channelEvts = events.filter((e) => e.kind === 'channel');
    expect(channelEvts.length).toBe(38);

    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeTruthy();
    expect(done.aborted).toBe(false);
    expect(done.found).toBe(3);
    expect(done.channels.length).toBe(2);
    const c11 = done.channels.find((c) => c.channel === '11A');
    expect(c11).toBeTruthy();
    expect(c11.services[0].name).toBe('BBC Radio 1');
    expect(c11.services[0].sid).toBe('C221');
    const c12 = done.channels.find((c) => c.channel === '12A');
    expect(c12.services[0].sid).toBe('C321');
  });

  it('aborts cleanly via stopScan while sweeping', async () => {
    const mgr = new AudioStreamManager();
    mgr.mode = 'dab';
    mgr.connected = true;
    mgr.host = 'h';
    mgr.port = 1;
    mgr.gain = 40;
    mgr.dab = {
      start: vi.fn(),
      stop: vi.fn(),
      servicesSnapshot: vi.fn(() => []),
      running: true,
      channel: null,
      ensemble: null,
    };
    mgr._sleep = () => Promise.resolve();
    mgr.startDabScan({ dwellMs: 500 });
    const r = mgr.stopScan();
    expect(r).toBeTruthy();
    expect(mgr.scanning).toBe(false);
    expect(mgr.scan).toBe(null);
    expect(mgr.dab.stop).toHaveBeenCalled();
    // The async loop sees the abort and stops emitting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mgr.scanning).toBe(false);
  });

  it('keeps sweeping past a channel whose dab.start() throws', async () => {
    const mgr = new AudioStreamManager();
    mgr.mode = 'dab';
    mgr.connected = true;
    mgr.host = 'h';
    mgr.port = 1;
    mgr.gain = 40;
    let calls = 0;
    mgr.dab = {
      // 5C (the third channel) fails to spawn; every other channel decodes a service.
      start: vi.fn(({ freqHz }) => {
        calls++;
        if (calls === 3) throw new Error('spawn ENOENT');
        mgr.dab._freq = freqHz;
      }),
      stop: vi.fn(),
      servicesSnapshot: vi.fn(() => {
        const ch = mgr.dab._freq / 1000;
        return [{ name: `Stn@${ch}`, sid: 'C100' }];
      }),
      running: true,
      channel: null,
      ensemble: null,
    };
    const events = [];
    mgr.on('scan', (e) => events.push(e));
    mgr._sleep = () => Promise.resolve();
    mgr.startDabScan({ dwellMs: 500 });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('DAB scan timed out')), 5000);
      mgr.on('scan', (e) => {
        if (e.kind === 'done') {
          clearTimeout(t);
          resolve();
        }
      });
    });

    // The failed channel must not stop the sweep: all 38 channels are visited.
    expect(events.filter((e) => e.kind === 'channel').length).toBe(38);
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeTruthy();
    expect(done.aborted).toBe(false);
    // 38 channels minus the one that failed to start.
    expect(done.channels.length).toBe(37);
    expect(mgr.scanning).toBe(false);
    expect(mgr.scan).toBe(null);
  });

  it('keeps polling a slow-locking channel until its service list stabilises', async () => {
    const mgr = new AudioStreamManager();
    mgr.mode = 'dab';
    mgr.connected = true;
    mgr.host = 'h';
    mgr.port = 1;
    mgr.gain = 40;
    // Services on 8B (197648 kHz) appear one per snapshot, simulating a weak
    // ensemble whose FIC takes a while to decode fully. Other channels are empty.
    mgr.dab = {
      start: vi.fn(({ freqHz }) => {
        mgr.dab._freq = freqHz;
        mgr.dab._polls = 0; // per-channel snapshot counter
      }),
      stop: vi.fn(),
      servicesSnapshot: vi.fn(() => {
        mgr.dab._polls++;
        const ch = mgr.dab._freq / 1000;
        if (ch !== 197648) return [];
        const n = Math.min(3, mgr.dab._polls);
        return Array.from({ length: n }, (_, i) => ({ name: `Stn${i + 1}`, sid: `C${100 + i}` }));
      }),
      running: true,
      channel: null,
      ensemble: null,
    };
    mgr._sleep = () => Promise.resolve();
    let done = null;
    mgr.on('scan', (e) => {
      if (e.kind === 'done') done = e;
    });
    mgr.startDabScan({ dwellMs: 900 });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('DAB scan timed out')), 5000);
      mgr.on('scan', (e) => {
        if (e.kind === 'done') {
          clearTimeout(t);
          resolve();
        }
      });
    });

    const ch8b = done.channels.find((c) => c.channel === '8B');
    expect(ch8b).toBeTruthy();
    expect(ch8b.services.length).toBe(3);
  });
});

describe('ADS-B SBS-1 parsing', () => {
  it('parses a callsign (MSG,1) and keeps it on later updates', () => {
    const tracker = new AdsbTracker();
    tracker.update(parseSbsLine('MSG,1,1,1,abc123,11111,111,111,111,111,EZY123,0'));
    tracker.update(parseSbsLine('MSG,3,1,1,abc123,111,111,111,,,,37000,,,51.47,-0.45,,,,'));
    const snap = tracker.snapshot();
    const [a] = snap;
    expect(a.icao).toBe('abc123');
    expect(a.callsign).toBe('EZY123');
    expect(a.altitude).toBe(37000);
    expect(a.lat).toBeCloseTo(51.47);
    expect(a.lon).toBeCloseTo(-0.45);
    expect(typeof a.age).toBe('number');
    expect(typeof a.addedAge).toBe('number');
    // Snapshot exposes no internal timestamps.
    expect(snap[0]).not.toHaveProperty('seen');
    expect(snap[0]).not.toHaveProperty('added');
  });

  it('parses airborne velocity (MSG,4) for speed and track', () => {
    const u = parseSbsLine('MSG,4,1,1,def456,111,111,111,,,,,450,275,,1200,0,0,0');
    expect(u.speed).toBe(450);
    expect(u.track).toBe(275);
    expect(u.icao).toBe('def456');
  });

  it('ignores non-MSG and malformed lines', () => {
    expect(parseSbsLine('AIR,1,2,3')).toBeNull();
    expect(parseSbsLine('MSG,3,1,1,badhex,111,111,111,,37000,,,51.47,-0.45,,,,0,0')).toBeNull();
    expect(parseSbsLine('')).toBeNull();
  });

  it('expires aircraft not heard within the TTL', async () => {
    const tracker = new AdsbTracker(50);
    tracker.update(parseSbsLine('MSG,1,1,1,aaa111,111,111,111,111,111,BBA111,0'));
    expect(tracker.count()).toBe(1);
    await new Promise((r) => setTimeout(r, 70));
    tracker.update(parseSbsLine('MSG,1,1,1,bbb222,111,111,111,111,111,BBB222,0'));
    expect(tracker.snapshot().find((a) => a.icao === 'aaa111')).toBeUndefined();
    expect(tracker.count()).toBe(1);
  });

  it('flags emergency/squawk fields', () => {
    const u = parseSbsLine('MSG,3,1,1,ccc333,111,111,111,,,,,,,51.5,-0.5,,7700,0,1');
    expect(u.squawk).toBe('7700');
    expect(u.emergency).toBe(true);
  });

  it('parses SPI (ident) and on-ground flags', () => {
    const u = parseSbsLine('MSG,3,1,1,def456,111,111,111,111,111,,37000,,,51.5,-0.5,-800,1200,0,1,0,1');
    expect(u.altitude).toBe(37000);
    expect(u.lat).toBe(51.5);
    expect(u.verticalRate).toBe(-800);
    expect(u.squawk).toBe('1200');
    expect(u.alert).toBeUndefined();
    expect(u.emergency).toBe(true);
    expect(u.spi).toBeUndefined();
    expect(u.onGround).toBe(true);

    const g = parseSbsLine('MSG,3,1,1,def456,111,111,111,111,111,,1000,,,52.0,-1.0,0,,0,0,1,0');
    expect(g.spi).toBe(true);
    expect(g.onGround).toBe(false);
  });
});
