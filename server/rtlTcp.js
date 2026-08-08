import net from 'node:net';
import { EventEmitter } from 'node:events';

export const DEFAULT_SAMPLE_RATE = 288_000; // broadcast FM needs only ~200 kHz band; low rate survives slow links

export const CMD = Object.freeze({
  SET_FREQ: 0x01,
  SET_SAMPLE_RATE: 0x02,
  SET_GAIN_MODE: 0x03,
  SET_GAIN: 0x04,
  SET_FREQ_CORRECTION: 0x05,
  SET_AGC_MODE: 0x08,
  SET_DIRECT_SAMPLING: 0x09,
  SET_OFFSET_TUNING: 0x0a,
});

const HEADER_SIZE = 12;

export class RtlTcpClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 1234, sampleRate = DEFAULT_SAMPLE_RATE } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.sampleRate = sampleRate;
    this.socket = null;
    this.connected = false;
    this.info = null;
    this._headerBuf = null;
    this._onHeader = null;
  }

  connect({ freq = 100_000_000, ppm = 0, gainAuto = true, gain = null } = {}) {
    return new Promise((resolve, reject) => {
      this._headerBuf = Buffer.alloc(0);
      this._onHeader = () => {
        this._onHeader = null;
        resolve(this.info);
      };

      const sock = net.createConnection({ host: this.host, port: this.port });
      this.socket = sock;
      sock.on('error', (err) => {
        this._onHeader = null;
        reject(err);
      });
      sock.on('close', () => {
        this.connected = false;
        this.emit('disconnect');
      });
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('connect', () => {
        this.connected = true;
        sock.removeAllListeners('error');
        sock.on('error', (err) => this.emit('error', err));
        this._send(CMD.SET_SAMPLE_RATE, this.sampleRate);
        this.setGain(gain, gainAuto);
        this._send(CMD.SET_AGC_MODE, 0); // RTL2832U digital AGC off (pumps on FM)
        this._send(CMD.SET_OFFSET_TUNING, 1);
        if (ppm) this._send(CMD.SET_FREQ_CORRECTION, ppm);
        this._send(CMD.SET_FREQ, freq);
      });
    });
  }

  setGain(gain, gainAuto = true) {
    if (!this.socket || !this.connected) return;
    if (gain === null || gain === undefined || !Number.isFinite(gain)) {
      this._send(CMD.SET_GAIN_MODE, gainAuto ? 0 : 1);
    } else {
      this._send(CMD.SET_GAIN_MODE, 1);
      this._send(CMD.SET_GAIN, Math.round(gain * 10));
    }
  }

  tune(freq) {
    if (!this.socket || !this.connected) return;
    this._send(CMD.SET_FREQ, freq);
    this.emit('tuned', freq);
  }

  close() {
    if (this.socket) {
      this.socket.removeAllListeners('error');
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  _send(cmd, value) {
    const buf = Buffer.alloc(5);
    buf[0] = cmd;
    buf.writeUInt32BE(value >>> 0, 1);
    this.socket.write(buf);
  }

  _onData(chunk) {
    if (!this._headerBuf) {
      this.emit('iq', chunk);
      return;
    }
    this._headerBuf = Buffer.concat([this._headerBuf, chunk]);
    if (this._headerBuf.length >= HEADER_SIZE) {
      const magic = this._headerBuf.toString('latin1', 0, 4);
      const tunerType = this._headerBuf.readUInt32BE(4);
      const tunerGainCount = this._headerBuf.readUInt32BE(8);
      this.info = { magic, tunerType, tunerGainCount };
      const rest = this._headerBuf.subarray(HEADER_SIZE);
      this._headerBuf = null;
      this.emit('header', this.info);
      const cb = this._onHeader;
      this._onHeader = null;
      if (cb) cb();
      if (rest.length) this.emit('iq', rest);
    }
  }
}
