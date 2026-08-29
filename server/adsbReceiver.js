import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { parseSbsLine, AdsbTracker } from './adsb.js';

const SBS_PORT = Number(process.env.ADSB_SBS_PORT || 10001);
const EMIT_INTERVAL_MS = 250; // throttle aircraft snapshots to the client

// Streams raw rtl_tcp IQ (u8, interleaved I/Q) into dump1090 and reads its
// SBS-1 BaseStation output back over a local TCP port. Mirrors the
// MeshtasticReceiver design: a child binary does the heavy demodulation while
// this adapter feeds it samples and parses its text output.
export class AdsbReceiver extends EventEmitter {
  constructor() {
    super();
    this.bin = process.env.ADSB_BIN || 'dump1090';
    this.child = null;
    this.client = null;
    this.buffer = '';
    this.tracker = new AdsbTracker();
    this.frequency = null;
    this.emitTimer = null;
    this.dirty = false;
  }

  start({ frequency } = {}) {
    this.stop();
    this.frequency = frequency;
    this.buffer = '';
    this.tracker = new AdsbTracker();
    const args = [
      '--ifile', '-',
      '--net',
      '--net-sbs-port', String(SBS_PORT),
      '--net-ri-port', '0',
      '--net-ro-port', '0',
      '--net-bi-port', '0',
      '--net-bo-port', '0',
      '--net-fatsv-port', '0',
      '--net-http-port', '0',
      '--quiet',
    ];
    console.log(`[adsb] spawning ${this.bin} ${args.join(' ')}`);
    const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const txt = String(chunk).trim();
      if (txt) {
        console.log(`[adsb] dump1090: ${txt.slice(0, 300)}`);
        this.emit('info', txt.slice(0, 300));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const txt = String(chunk).trim();
      if (txt) {
        console.error(`[adsb] dump1090: ${txt.slice(0, 300)}`);
        this.emit('info', txt.slice(0, 300));
      }
    });
    child.on('error', (err) => {
      console.error(`[adsb] failed to spawn dump1090: ${err.message}`);
      if (this.child === child) this.emit('error', err);
    });
    child.on('exit', (code, signal) => {
      console.log(`[adsb] dump1090 exited code=${code} signal=${signal}`);
      if (this.child === child) {
        this.child = null;
        this.emit('exit', { code, signal });
      }
    });

    // Connect to dump1090's SBS-1 output and parse it line by line.
    // dump1090 may not have opened its listening port yet, so retry on failure.
    const connectSbs = () => {
      if (!this.child) return;
      const client = net.connect(SBS_PORT, '127.0.0.1', () => {
        console.log(`[adsb] SBS client connected to 127.0.0.1:${SBS_PORT}`);
        this.emit('info', `SBS connected to 127.0.0.1:${SBS_PORT}`);
      });
      this.client = client;
      client.setEncoding('utf8');
      client.on('data', (chunk) => this._onSbs(chunk));
      client.on('error', (err) => {
        console.error(`[adsb] SBS client error: ${err.message}`);
        this.emit('error', `SBS connect failed: ${err.message}`);
        client.destroy();
      });
      client.on('close', () => {
        if (this.client !== client) return;
        this.client = null;
        if (this.child) {
          console.log(`[adsb] SBS client closed, retrying in 300ms`);
          setTimeout(connectSbs, 300);
        }
      });
    };
    connectSbs();

    this.emitTimer = setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      this.emit('aircraft', this.tracker.snapshot());
    }, EMIT_INTERVAL_MS);
  }

  _onSbs(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const update = parseSbsLine(line);
        if (update) {
          this.tracker.update(update);
          this.dirty = true;
        }
      } catch (err) {
        this.emit('info', `ADS-B parse: ${err.message}`);
      }
    }
  }

  push(chunk) {
    if (this.child?.stdin?.writable) this.child.stdin.write(chunk);
  }

  setFrequency(frequency) {
    this.frequency = frequency;
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const client = this.client;
    this.client = null;
    if (client) client.destroy();
    if (this.emitTimer) {
      clearInterval(this.emitTimer);
      this.emitTimer = null;
    }
    this.buffer = '';
  }
}
