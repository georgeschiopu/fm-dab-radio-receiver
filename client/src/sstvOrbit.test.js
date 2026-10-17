import { describe, it, expect } from 'vitest';
import {
  satrecFromTle,
  observerGd,
  propagateAt,
  lookAnglesAt,
  footprintRadiusKm,
  splitDateline,
  predictPasses,
  compass,
  fmtUTC,
  fmtDuration,
} from './sstvOrbit.js';

const ISS_TLE = {
  tle1: '1 25544U 98067A   26290.17683437  .00008767  00000-0  16757-3 0  9995',
  tle2: '2 25544  51.6327  56.4129 0006776 273.6806  86.3408 15.48906925590665',
};

const OBS = { lat: 0, lng: 0, alt: 0 };

describe('sstvOrbit', () => {
  it('builds a satrec from a TLE and propagates a sub-satellite point', () => {
    const rec = satrecFromTle(ISS_TLE);
    expect(rec).toBeTruthy();
    const p = propagateAt(rec, new Date('2026-10-17T12:00:00Z'));
    expect(p).toBeTruthy();
    expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
    expect(Math.abs(p.lng)).toBeLessThanOrEqual(180);
    expect(p.altKm).toBeGreaterThan(300);
    expect(p.altKm).toBeLessThan(500);
  });

  it('computes look angles from an observer', () => {
    const rec = satrecFromTle(ISS_TLE);
    const la = lookAnglesAt(rec, new Date('2026-10-17T12:00:00Z'), observerGd(OBS));
    expect(Number.isFinite(la.az)).toBe(true);
    expect(Number.isFinite(la.el)).toBe(true);
    expect(la.range).toBeGreaterThan(0);
  });

  it('grows the visibility footprint with altitude', () => {
    expect(footprintRadiusKm(2000)).toBeGreaterThan(footprintRadiusKm(400));
    expect(footprintRadiusKm(400)).toBeGreaterThan(0);
  });

  it('splits a ground track at the antimeridian', () => {
    const segs = splitDateline([
      [0, 170],
      [0, 175],
      [0, -175],
      [0, -170],
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toHaveLength(2);
    expect(segs[1]).toHaveLength(2);
  });

  it('predicts valid, chronological passes for the next days', () => {
    const rec = satrecFromTle(ISS_TLE);
    const passes = predictPasses(rec, observerGd(OBS), {
      fromMs: Date.parse('2026-10-17T12:00:00Z'),
      days: 3,
      minEl: 0,
      stepSec: 30,
    });
    expect(passes.length).toBeGreaterThan(0);
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i].startUTC).toBeGreaterThanOrEqual(passes[i - 1].startUTC);
    }
    for (const p of passes) {
      expect(p.endUTC).toBeGreaterThan(p.startUTC);
      expect(p.maxEl).toBeGreaterThanOrEqual(0);
      expect(p.duration).toBeGreaterThan(0);
    }
  });

  it('formats compass, UTC time and duration', () => {
    expect(compass(0)).toBe('N');
    expect(compass(180)).toBe('S');
    expect(fmtUTC(0)).toBe('00:00:00Z');
    expect(fmtDuration(125)).toBe('2m 05s');
  });
});
