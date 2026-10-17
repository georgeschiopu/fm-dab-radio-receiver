import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSstvSatellites,
  parseTleEntry,
  parseCelestrakTle,
  SstvCatalog,
  DB_BASE,
  CELESTRAK_BASE,
} from './sstvSats.js';
import { SSTV_FALLBACK } from './sstvSatsFallback.js';

const okJson = (data) => ({
  ok: true,
  status: 200,
  json: async () => data,
  text: async () => JSON.stringify(data),
});

const okText = (text) => ({
  ok: true,
  status: 200,
  json: async () => JSON.parse(text),
  text: async () => text,
});

describe('parseSstvSatellites', () => {
  const transmitters = [
    { norad_cat_id: 25544, downlink_low: 437800000, description: 'Mode U - SSTV', status: 'active', alive: true },
    { norad_cat_id: 25544, downlink_low: 145800000, description: 'Mode V Imaging', status: 'active', alive: true },
    { norad_cat_id: 25544, downlink_low: 437800000, description: 'dup', status: 'inactive', alive: false },
    { norad_cat_id: 57172, downlink_low: 437625000, description: 'Mode U - SSTV', status: 'active', alive: true },
    { norad_cat_id: 0, downlink_low: 100000000, status: 'active' },
  ];
  const meta = new Map([
    [25544, { name: 'ISS', countries: 'RU,US', status: 'in orbit' }],
  ]);

  it('groups transmitters by NORAD id and dedupes downlinks', () => {
    const list = parseSstvSatellites(transmitters, meta);
    const iss = list.find((s) => s.norad === 25544);
    expect(iss).toBeTruthy();
    expect(iss.name).toBe('ISS');
    expect(iss.freqs).toHaveLength(2);
    expect(iss.active).toBe(true);
  });

  it('falls back to the snapshot name when metadata is unavailable', () => {
    const list = parseSstvSatellites(transmitters, new Map());
    expect(list.find((s) => s.norad === 57172).name).toMatch(/UmKA|57172/i);
  });

  it('sorts the list alphabetically by name', () => {
    const list = parseSstvSatellites(transmitters, meta);
    const names = list.map((s) => s.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});

describe('parseTleEntry', () => {
  it('normalises a SatNOGS TLE record', () => {
    const tle = parseTleEntry({
      tle0: '0 ISS (ZARYA)',
      tle1: '1 25544U 98067A   26290.17683437  .00008767  00000-0  16757-3 0  9995',
      tle2: '2 25544  51.6327  56.4129 0006776 273.6806  86.3408 15.48906925590665',
      norad_cat_id: 25544,
    });
    expect(tle.norad).toBe(25544);
    expect(tle.name).toBe('ISS (ZARYA)');
  });

  it('rejects incomplete records', () => {
    expect(parseTleEntry({ tle1: 'x' })).toBeNull();
  });
});

describe('parseCelestrakTle', () => {
  it('parses a three-line Celestrak response', () => {
    const text =
      'UMKA 1 (RS40S)\n1 57172U 23091G   26290.22947505  .00005993  00000+0  26513-3 0  9995\n2 57172  97.4901 348.4571 0013615  57.9718 302.2839 15.21976631182569';
    const tle = parseCelestrakTle(57172, text);
    expect(tle.tle1.startsWith('1 57172')).toBe(true);
    expect(tle.tle2.startsWith('2 57172')).toBe(true);
  });

  it('returns null for an error body', () => {
    expect(parseCelestrakTle(1, 'No GP data found')).toBeNull();
  });
});

describe('SstvCatalog', () => {
  const transmitters = [
    { norad_cat_id: 25544, downlink_low: 145800000, description: 'ISS SSTV', status: 'active', alive: true },
  ];
  const sats = [{ norad_cat_id: 25544, name: 'ISS', countries: 'RU,US', status: 'in orbit' }];
  const tle = {
    tle0: '0 ISS (ZARYA)',
    tle1: '1 25544U 98067A   26290.17683437  .00008767  00000-0  16757-3 0  9995',
    tle2: '2 25544  51.6327  56.4129 0006776 273.6806  86.3408 15.48906925590665',
    norad_cat_id: 25544,
  };

  it('builds the list from the SatNOGS API and caches it', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.startsWith(`${DB_BASE}/transmitters/`)) return okJson(transmitters);
      if (url.startsWith(`${DB_BASE}/satellites/`)) return okJson(sats);
      throw new Error(`unexpected ${url}`);
    };
    let clock = 1000;
    const catalog = new SstvCatalog({ fetchImpl, now: () => clock });
    const list = await catalog.getSatellites();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('ISS');
    const n = calls.length;
    clock += 1000;
    await catalog.getSatellites();
    expect(calls.length).toBe(n); // served from cache
  });

  it('falls back to the baked snapshot when the API fails', async () => {
    const fetchImpl = async () => {
      throw new Error('offline');
    };
    const catalog = new SstvCatalog({ fetchImpl });
    const list = await catalog.getSatellites();
    expect(list.length).toBe(SSTV_FALLBACK.length);
    expect(list.some((s) => s.norad === 25544)).toBe(true);
  });

  it('fetches and parses TLEs for a small set of satellites', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith(`${DB_BASE}/tle/`)) return okJson([tle]);
      throw new Error(`unexpected ${url}`);
    };
    const catalog = new SstvCatalog({ fetchImpl });
    const tles = await catalog.getTles([25544]);
    expect(tles[25544].tle1.startsWith('1 25544')).toBe(true);
  });

  it('persists TLEs to disk and reuses them after a restart', async () => {
    const cacheFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'sstv-cache-')),
      'tles.json'
    );
    const fetchImpl = async (url) => {
      if (url.startsWith(`${DB_BASE}/tle/`)) return okJson([tle]);
      throw new Error(`unexpected ${url}`);
    };
    const first = new SstvCatalog({ fetchImpl, cacheFile });
    const tles = await first.getTles([25544]);
    expect(tles[25544].tle1.startsWith('1 25544')).toBe(true);
    expect(fs.existsSync(cacheFile)).toBe(true);

    // A fresh instance (e.g. after a container restart) reads the disk cache and
    // never touches the network.
    const offline = async () => {
      throw new Error('should not fetch');
    };
    const restarted = new SstvCatalog({ fetchImpl: offline, cacheFile });
    const reused = await restarted.getTles([25544]);
    expect(reused[25544].tle1.startsWith('1 25544')).toBe(true);
  });

  it('falls back to Celestrak when SatNOGS has no TLE', async () => {
    const fetchImpl = async (url) => {
      if (url.startsWith(`${DB_BASE}/tle/`)) return okJson([]);
      if (url.startsWith(CELESTRAK_BASE))
        return okText(
          'UMKA 1 (RS40S)\n1 57172U 23091G   26290.22947505  .00005993  00000+0  26513-3 0  9995\n2 57172  97.4901 348.4571 0013615  57.9718 302.2839 15.21976631182569'
        );
      throw new Error(`unexpected ${url}`);
    };
    const catalog = new SstvCatalog({ fetchImpl });
    const tles = await catalog.getTles([57172]);
    expect(tles[57172].tle1.startsWith('1 57172')).toBe(true);
  });
});
