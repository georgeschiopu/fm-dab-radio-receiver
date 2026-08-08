import net from 'node:net';
import fs from 'node:fs';
import { RtlTcpClient, CMD, DEFAULT_SAMPLE_RATE } from './rtlTcp.js';
import { FmDecoder } from './dsp.js';
import { SpectrumAnalyzer, DEFAULT_BINS } from './spectrum.js';
import { channelBlockForFreq, channelFreqKHz } from './dab.js';

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
  .then(testSpectrum)
  .then(testDabChannelMap)
  .then(() => {
    console.log('\nAll tests passed.');
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error('\nTest failed:', err.message);
    process.exit(1);
  });
