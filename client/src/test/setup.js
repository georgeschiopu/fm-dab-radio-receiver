import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined' && window.HTMLCanvasElement) {
  // jsdom has no canvas implementation; provide a stub 2D context.
  const ctx = {
    fillStyle: '#000',
    fillRect() {},
    clearRect() {},
    drawImage() {},
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1) * 4)) };
    },
    putImageData() {},
  };
  window.HTMLCanvasElement.prototype.getContext = function (type) {
    return type === '2d' ? ctx : null;
  };
}

// The spectrum/waterfall animation loops run via requestAnimationFrame. Stub it
// out so component tests don't spin an infinite rAF timer.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// Minimal Web Audio API mock used by client/src/audio.js.
class MockAudioParam {
  constructor(value = 0) {
    this.value = value;
  }
}

class MockAudioContext {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 48000;
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.gain = null;
  }

  createGain() {
    this.gain = { gain: new MockAudioParam(0.5), connect() {} };
    return this.gain;
  }

  createBuffer(channels, length, sampleRate) {
    const data = new Float32Array(length);
    return {
      numberOfChannels: channels,
      sampleRate,
      duration: length / sampleRate,
      length,
      getChannelData() {
        return data;
      },
    };
  }

  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, stop() {} };
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

globalThis.AudioContext = MockAudioContext;
if (typeof window !== 'undefined') {
  globalThis.window.AudioContext = MockAudioContext;
}