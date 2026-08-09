import net from 'node:net';
import fs from 'node:fs';
import { RtlTcpClient, CMD, DEFAULT_SAMPLE_RATE } from './rtlTcp.js';
import { FmDecoder, LinearResampler } from './dsp.js';
import { SpectrumAnalyzer, DEFAULT_BINS } from './spectrum.js';
import { channelBlockForFreq, channelFreqKHz, DabReceiver } from './dab.js';

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
};

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

async function testProtocol() {
  console.log('--- protocol test ---');
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
  assert(info.magic === 'RTL0', 'magic not parsed');
  assert(info.tunerType === 2, 'tuner type not parsed');
  assert(info.tunerGainCount === 5, 'gain count not parsed');

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
  assert(
    JSON.stringify(receivedCmds) === JSON.stringify(expected),
    `commands mismatch:\n got ${JSON.stringify(receivedCmds)}\n exp ${JSON.stringify(expected)}`
  );
  console.log(`OK: header parsed, ${receivedCmds.length} commands sent in order`);
}

async function testDsp() {
  console.log('--- dsp test ---');
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
  assert(
    Math.abs(total - expectedOut) <= 2,
    `output length ${total} != ~${expectedOut}`
  );

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
  console.log('  wav written: /tmp/fm_test.wav');

  assert(rms > 0.01, 'audio too quiet (rms too low)');
  assert(rms < 0.5, 'audio clipping (rms too high)');
  assert(ratio > 0.45, `1kHz tone not dominant (ratio=${ratio.toFixed(3)})`);
  assert(ratio > toneAt(500) * 5, 'unexpected energy at 500Hz');
  assert(ratio > toneAt(1500) * 5, 'unexpected energy at 1500Hz');
  console.log('OK: demodulated output is a clean 1kHz tone');
}

function testNfmDsp() {
  console.log('--- nfm dsp test ---');
  const samples = 2_000_000; // 2 s at 1 Msps
  const iq = synthFmIq(samples, { fs: 1_000_000, modFreq: 1000, dev: 2500 });
  const dec = new FmDecoder({ inRate: 1_000_000, audioRate: 50_000, audioCutoff: 4_000, deemphasis: 0, gain: 22, taps: 512 });
  const chunks = [];
  const CH = 60000;
  for (let i = 0; i < iq.length; i += CH * 2) {
    chunks.push(dec.process(iq.subarray(i, Math.min(i + CH * 2, iq.length))));
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const expectedOut = Math.floor(samples / 20);
  assert(Math.abs(total - expectedOut) <= 2, `output length ${total} != ~${expectedOut}`);

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
  console.log('  wav written: /tmp/nfm_test.wav');

  assert(rms > 0.01, 'audio too quiet (rms too low)');
  assert(rms < 0.5, 'audio clipping (rms too high)');
  assert(ratio > 0.45, `1kHz tone not dominant (ratio=${ratio.toFixed(3)})`);
  assert(ratio > toneAt(500) * 5, 'unexpected energy at 500Hz');
  assert(ratio > toneAt(1500) * 5, 'unexpected energy at 1500Hz');
  console.log('OK: NFM demodulated output is a clean 1kHz tone');
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

function testNfmAgcSquelch() {
  console.log('--- nfm agc/squelch test ---');
  const CH = 60000;
  // Wide-deviation signal would clip under the old fixed gain 22.
  const strong = synthFmIq(1_000_000, { fs: 1_000_000, modFreq: 1000, dev: 5000 });
  const weak = synthFmIq(1_000_000, { fs: 1_000_000, modFreq: 1000, dev: 1000 });
  const noise = synthNoiseIq(1_000_000);

  const mkDec = (squelch = 0) =>
    new FmDecoder({ inRate: 1_000_000, audioRate: 50_000, audioCutoff: 4_000, deemphasis: 0, gain: 1, taps: 512, outputRate: 48_000, agc: true, squelch });

  // AGC normalizes the level for strong and weak signals.
  const decStrong = mkDec();
  const outStrong = feedAll(decStrong, strong, CH);
  const rmsStrong = rmsOf(outStrong);
  assert(rmsStrong > 0.08 && rmsStrong < 0.35, `strong-signal RMS ${rmsStrong.toFixed(3)} not AGC-normalized (~0.18)`);

  const decWeak = mkDec();
  const outWeak = feedAll(decWeak, weak, CH);
  const rmsWeak = rmsOf(outWeak);
  assert(rmsWeak > 0.08 && rmsWeak < 0.35, `weak-signal RMS ${rmsWeak.toFixed(3)} not AGC-normalized (~0.18)`);

  // Squelch is OFF by default: noise passes through (AGC keeps it from clipping).
  const decNoiseOpen = mkDec();
  const outNoiseOpen = feedAll(decNoiseOpen, noise, CH);
  assert(decNoiseOpen.squelch === 0, 'squelch must be off by default');
  let openEnergy = 0;
  for (const c of outNoiseOpen) for (const v of c) openEnergy += (v / 32768) ** 2;
  assert(openEnergy > 1e-4, 'noise should NOT be muted when squelch is off');

  // Squelch enabled: pure noise is muted, a strong carrier opens the gate.
  const decNoise = mkDec(1);
  const outNoise = feedAll(decNoise, noise, CH);
  assert(!decNoise.squelchOpen, 'squelch must stay closed on pure noise');
  let noiseEnergy = 0;
  for (const c of outNoise) for (const v of c) noiseEnergy += (v / 32768) ** 2;
  assert(noiseEnergy < 1e-6, `squelch failed to mute noise (energy ${noiseEnergy.toFixed(6)})`);

  const decSig = mkDec(1);
  const outSig = feedAll(decSig, strong, CH);
  assert(decSig.squelchOpen, 'squelch should open on a strong carrier');
  assert(rmsOf(outSig) > 0.05, 'squelched signal output too quiet');

  // Runtime setSquelch toggle behaves identically to constructor config.
  const decToggle = mkDec();
  decToggle.setSquelch(1);
  const outToggle = feedAll(decToggle, noise, CH);
  let toggleEnergy = 0;
  for (const c of outToggle) for (const v of c) toggleEnergy += (v / 32768) ** 2;
  assert(toggleEnergy < 1e-6, 'setSquelch(1) did not mute noise');

  console.log(`  strong rms=${rmsStrong.toFixed(3)}, weak rms=${rmsWeak.toFixed(3)}`);
  console.log('OK: NFM AGC normalizes level; squelch is off by default and mutes noise when enabled');
}

function testResampler() {
  console.log('--- resampler test ---');
  const n = 100_000; // 2 s at 50 kHz
  const input = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / 50_000);

  // one-shot
  const oneShot = new LinearResampler(50_000, 48_000);
  const out = oneShot.process(input);
  assert(Math.abs(out.length - 96_000) <= 5, `resampled length ${out.length} != ~96000`);

  // chunked processing must be identical to one-shot (state continuity)
  const chunked = new LinearResampler(50_000, 48_000);
  const parts = [];
  for (let i = 0; i < n; i += 4096) {
    parts.push(chunked.process(input.subarray(i, Math.min(i + 4096, n))));
  }
  const total = parts.reduce((a, c) => a + c.length, 0);
  assert(Math.abs(total - out.length) <= 2, `chunked length ${total} != one-shot ${out.length}`);

  // the 1 kHz tone must stay at 1 kHz after conversion to 48 kHz
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
  assert(ratio > 0.45, `1kHz tone not preserved through resampler (ratio=${ratio.toFixed(3)})`);
  console.log(`  ${n} -> ${out.length} samples (${total} chunked), 1kHz tone ratio=${ratio.toFixed(3)}`);
  console.log('OK: 50k->48k resampler is length-correct and tone-preserving');
}

function testSpectrum() {
  console.log('--- spectrum test ---');
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
  assert(an.bins === DEFAULT_BINS, 'bins mismatch');
  const lines = [];
  an.onSpectrum = (d) => lines.push(Uint8Array.from(d));

  const CH = 2048;
  for (let i = 0; i < buf.length; i += CH * 2) {
    an.push(buf.subarray(i, i + CH * 2));
  }

  assert(lines.length >= 2, `expected spectrum lines, got ${lines.length}`);
  const last = lines[lines.length - 1];
  assert(last.length === DEFAULT_BINS, `line length ${last.length} != ${DEFAULT_BINS}`);

  // expected display bin for a +f Hz carrier: d = (f + sr/2)/sr * bins
  const expBin = Math.floor(((f + sr / 2) / sr) * DEFAULT_BINS);
  let best = -1;
  let bestVal = -1;
  for (let d = 0; d < DEFAULT_BINS; d++) {
    if (last[d] > bestVal) {
      bestVal = last[d];
      best = d;
    }
  }
  assert(
    Math.abs(best - expBin) <= 3,
    `peak at display bin ${best}, expected ~${expBin}`
  );
  console.log(`  lines: ${lines.length}, peak at display bin ${best} (expected ~${expBin})`);
  console.log('OK: spectrum analyzer localizes a 20 kHz carrier');
}

function testDabPcmConversion() {
  console.log('--- dab pcm conversion test ---');
  const rec = new DabReceiver();
  rec._setFormat(48000, 2, false); // dablin int16 stereo

  const out = [];
  rec.onPcm = (pcm, rate) => out.push({ pcm, rate });

  // 100 stereo frames: left = 1000, right = 2000
  const nFrames = 100;
  const buf = Buffer.alloc(nFrames * 4);
  for (let i = 0; i < nFrames; i++) {
    buf.writeInt16LE(1000, i * 4);
    buf.writeInt16LE(2000, i * 4 + 2);
  }
  rec._onPcm(buf);

  assert(out.length === 1, `expected one PCM push, got ${out.length}`);
  const { pcm, rate } = out[0];
  assert(pcm.length === nFrames, `expected ${nFrames} mono samples, got ${pcm.length}`);
  assert(rate === 48000, `rate ${rate} != 48000`);
  assert(pcm[0] === 1500, `first sample ${pcm[0]} != averaged 1500`);
  assert(Math.abs(pcm[nFrames - 1] - 1500) === 0, 'last sample not averaged');
  console.log(`OK: ${pcm.length} int16 mono samples from int16 stereo, avg sample=${pcm[0]}`);
}

function testDabChannelMap() {
  console.log('--- dab channel map test ---');
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
    const got = channelBlockForFreq(freq);
    assert(got === expected, `freq ${freq} -> ${got}, expected ${expected}`);
  }
  assert(channelFreqKHz('11A') === 216928, 'channelFreqKHz(11A)');
  assert(channelFreqKHz('ZZ') === null, 'channelFreqKHz invalid');
  console.log(`OK: ${cases.length} channel mappings + roundtrip correct`);
}

testProtocol()
  .then(testDsp)
  .then(testNfmDsp)
  .then(testNfmAgcSquelch)
  .then(testResampler)
  .then(testSpectrum)
  .then(testDabPcmConversion)
  .then(testDabChannelMap)
  .then(() => {
    console.log('\nAll tests passed.');
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error('\nTest failed:', err.message);
    process.exit(1);
  });
