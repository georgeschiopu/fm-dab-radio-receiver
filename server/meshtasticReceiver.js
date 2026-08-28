import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { MESHTASTIC_SAMPLE_RATE, MESHTASTIC_IF_OFFSET, parseMeshtasticPacket } from './meshtastic.js';

export class MeshtasticReceiver extends EventEmitter {
  constructor() {
    super();
    this.bin = process.env.LORARX_BIN || 'lorarx';
    this.child = null;
    this.key = 'default';
    this.frequency = null;
    this.stdout = '';
    this.seen = new Map();
    this.nodes = new Map();
  }

  start({ frequency, key = 'default' } = {}) {
    this.stop();
    this.key = key || 'default';
    this.frequency = frequency;
    this.stdout = '';
    const args = [
      '-i', '/dev/stdin', '-f', 'u8', '-r', String(MESHTASTIC_SAMPLE_RATE),
      '-W', '50', '-b', '8', '-o', String(MESHTASTIC_IF_OFFSET), '-v', '-Q', '-j', '/dev/stdout',
      '-M', String((frequency || 0) / 1e6),
      '-s', '7', '-s', '8', '-s', '9', '-s', '10', '-s', '11',
    ];
    const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk, child));
    child.stderr.on('data', (chunk) => this.emit('info', String(chunk).trim().slice(0, 300)));
    child.on('error', (err) => {
      if (this.child === child) this.emit('error', err);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.emit('exit', { code, signal });
      }
    });
  }

  _onStdout(chunk, child) {
    if (this.child !== child) return;
    this.stdout += chunk;
    let newline;
    while ((newline = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      try {
        const packet = parseMeshtasticPacket(JSON.parse(line), this.key, this.seen, this.nodes);
        if (packet) this.emit('packet', packet);
      } catch (err) {
        this.emit('info', `Meshtastic packet parse: ${err.message}`);
      }
    }
  }

  push(chunk) {
    if (this.child?.stdin?.writable) this.child.stdin.write(chunk);
  }

  setKey(key) {
    this.key = key || 'default';
  }

  setFrequency(frequency) {
    this.frequency = frequency;
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    this.stdout = '';
  }
}
