import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Leaflet needs real layout measurement, so stub react-leaflet/leaflet out; the
// tracker's list/tuning logic is what these tests exercise.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }) => <div data-testid="sstv-map">{children}</div>,
  TileLayer: () => null,
  Polyline: () => null,
  Circle: () => null,
  CircleMarker: ({ children }) => <div>{children}</div>,
  Tooltip: ({ children }) => <div>{children}</div>,
  useMap: () => ({ setView: () => {}, fitBounds: () => {} }),
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: () => ({}),
    latLngBounds: () => ({ isValid: () => false }),
  },
}));

import SstvTracker from './SstvTracker.jsx';

const SATELLITES = [
  {
    norad: 25544,
    name: 'ISS',
    countries: 'RU,US',
    status: 'in orbit',
    active: true,
    freqs: [
      { down: 145800000, desc: 'Mode V Imaging', status: 'active', alive: true },
      { down: 437550000, desc: 'Mode U - SSTV - Robot-36', status: 'active', alive: true },
    ],
  },
  {
    norad: 57172,
    name: 'UmKA-1',
    countries: 'RU',
    status: 'in orbit',
    active: true,
    freqs: [{ down: 437625000, desc: 'Mode U - SSTV', status: 'active', alive: true }],
  },
];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (String(url).startsWith('/api/sstv/satellites')) {
        return { ok: true, status: 200, json: async () => ({ satellites: SATELLITES }) };
      }
      if (String(url).startsWith('/api/sstv/tle')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tles: {
              25544: {
                tle1: '1 25544U 98067A   26290.17683437  .00008767  00000-0  16757-3 0  9995',
                tle2: '2 25544  51.6327  56.4129 0006776 273.6806  86.3408 15.48906925590665',
              },
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SstvTracker', () => {
  it('renders the SSTV satellite list from the API', async () => {
    render(<SstvTracker user="alice" onTuneDownlink={() => {}} />);
    expect(await screen.findByText('ISS')).toBeInTheDocument();
    expect(screen.getByText('UmKA-1')).toBeInTheDocument();
    expect(screen.getByTestId('sstv-map')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('shows the downlinks and tunes the SDR on demand', async () => {
    const user = userEvent.setup();
    const onTune = vi.fn();
    render(<SstvTracker user="alice" onTuneDownlink={onTune} />);
    await screen.findByText('ISS');

    const freqsButtons = screen.getAllByRole('button', { name: /Freqs/ });
    await user.click(freqsButtons[0]);
    expect(await screen.findByText('145.800 MHz')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Tune' })[0]);
    expect(onTune).toHaveBeenCalledWith(145800000);
  });

  it('persists the satellite selection per user', async () => {
    const user = userEvent.setup();
    render(<SstvTracker user="alice" onTuneDownlink={() => {}} />);
    await screen.findByText('ISS');

    await user.click(screen.getByRole('checkbox', { name: /ISS/ }));
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('sstv-alice-selected') || '[]');
      expect(stored.length).toBe(1);
    });
  });
});
