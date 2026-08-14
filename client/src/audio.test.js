import { describe, it, expect, beforeEach } from 'vitest';
import { AudioPlayer } from './audio.js';

// @vitest-environment jsdom

describe('AudioPlayer', () => {
  beforeEach(() => {
    window.AudioContext.mockInstanceCount = 0;
  });

  it('initializes a Web Audio context and gain node', async () => {
    const player = new AudioPlayer();
    expect(player.ctx).toBeNull();
    await player.init();
    expect(player.ctx).toBeTruthy();
    expect(player.ctx.state).toBe('running');
    expect(player.gain).toBeTruthy();
    expect(player.gain.gain.value).toBe(0.5);
    await player.close();
  });

  it('is idempotent across repeated init calls', async () => {
    const player = new AudioPlayer();
    await player.init();
    const ctx = player.ctx;
    await player.init();
    expect(player.ctx).toBe(ctx);
    await player.close();
  });

  it('accepts a positive finite sample rate and ignores junk', () => {
    const player = new AudioPlayer();
    player.setRate(44100);
    expect(player.rate).toBe(44100);
    player.setRate(NaN);
    expect(player.rate).toBe(44100);
    player.setRate(-5);
    expect(player.rate).toBe(44100);
    expect(player.rate).toBe(44100);
  });

  it('does not schedule audio before start()', async () => {
    const player = new AudioPlayer();
    await player.init();
    player.push(new Int16Array(100));
    expect(player.nextTime).toBe(0);
    expect(player.playing).toBe(false);
    await player.close();
  });

  it('starts playback and schedules buffers, then stops', async () => {
    const player = new AudioPlayer();
    await player.init();
    player.start();
    expect(player.playing).toBe(true);
    expect(player.nextTime).toBeGreaterThan(player.ctx.currentTime);

    player.push(new Int16Array(480));
    expect(player.nextTime).toBeGreaterThan(player.ctx.currentTime);

    player.stop();
    expect(player.playing).toBe(false);
    await player.close();
  });

  it('updates volume on the gain node', async () => {
    const player = new AudioPlayer();
    await player.init();
    player.setVolume(0.8);
    expect(player.gain.gain.value).toBe(0.8);
    await player.close();
  });

  it('closes and clears the audio context', async () => {
    const player = new AudioPlayer();
    await player.init();
    await player.close();
    expect(player.ctx).toBeNull();
  });
});