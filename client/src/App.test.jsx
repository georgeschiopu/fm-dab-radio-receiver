import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';

// @vitest-environment jsdom

class MockWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = 'blob';
    this.sent = [];
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
  }

  send(msg) {
    this.sent.push(JSON.parse(msg));
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  emit(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
}

const okRoute = (data) => ({ ok: true, status: 200, json: async () => data });
const errRoute = () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });

function authenticatedFetch() {
  return vi.fn(async (url) => {
    if (url === '/api/me') return okRoute({ username: 'alice' });
    if (url === '/api/config')
      return okRoute({ host: '192.168.0.6', port: 1234, freq: 95100000, gain: 40, mode: 'fm', squelch: 0 });
    if (url.startsWith('/api/presets')) return okRoute({ presets: [] });
    return errRoute();
  });
}

// RF is the only top-level mode for FM/NFM/AM/USB/LSB/CW/RTTY; pick a demod by
// clicking its button in the right column.
async function selectDemod(user, label) {
  await user.click(screen.getByRole('button', { name: label }));
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('shows the login form when not authenticated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errRoute()));
    render(<App />);
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ODV Project' })).toBeInTheDocument();
  });

  it('renders the main UI with stations in their own right column', async () => {
    vi.stubGlobal('fetch', authenticatedFetch());
    const { container } = render(<App />);
    await screen.findByText('Stations');

    expect(container.querySelector('.col-center .meters')).toBeTruthy();
    expect(container.querySelector('.col-right .stations')).toBeTruthy();
    expect(screen.getByText('No saved stations yet.')).toBeInTheDocument();
  });

  it('tunes to a found FM signal and resumes scanning from the modal', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);

    const freqInput = await screen.findByPlaceholderText('95.1');
    expect(freqInput.value).toBe('95.1');

    await user.click(screen.getByRole('button', { name: 'Scan FM band' }));

    const ws = MockWebSocket.instances[0];
    await waitFor(() => expect(ws.readyState).toBe(MockWebSocket.OPEN));

    ws.emit({ type: 'scan', kind: 'hit', freq: 95100000, signal: 0.5, noiseFloor: 0.05 });

    await screen.findByText('Signal found');
    await screen.findByText('95.1 MHz');
    await waitFor(() => expect(freqInput.value).toBe('95.1'));
    expect(ws.sent.some((m) => m.op === 'tune' && m.freq === 95100000)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(ws.sent.some((m) => m.op === 'scanContinue')).toBe(true));
    expect(screen.queryByText('Signal found')).not.toBeInTheDocument();
  });

  it('saves a found 2m signal to stations from the scan modal', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);
    await screen.findByText('Stations');

    await selectDemod(user, 'NFM');
    await screen.findByText('NFM band scan');

    await user.click(screen.getByRole('button', { name: 'Scan NFM band' }));

    const ws = MockWebSocket.instances[0];
    await waitFor(() => expect(ws.readyState).toBe(MockWebSocket.OPEN));

    ws.emit({ type: 'scan', kind: 'hit', freq: 145025000, signal: 0.6, noiseFloor: 0.04 });

    await screen.findByText('145.025 MHz');
    expect(ws.sent.some((m) => m.op === 'tune' && m.freq === 145025000)).toBe(true);

    await user.type(screen.getByPlaceholderText('NFM 145.025 MHz'), 'Repeater');
    await user.click(screen.getByRole('button', { name: 'Save & Continue' }));

    await waitFor(() => expect(ws.sent.some((m) => m.op === 'scanContinue')).toBe(true));
    await screen.findByText('Repeater');
    expect(screen.queryByText('Signal found')).not.toBeInTheDocument();
  });

  it('updates the Frequency input when tuning while playing', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);

    const freqInput = await screen.findByPlaceholderText('95.1');
    await user.click(screen.getByRole('button', { name: 'Play' }));

    await waitFor(() => expect(freqInput).toBeInTheDocument());
    await user.clear(freqInput);
    await user.type(freqInput, '99.9');
    expect(freqInput.value).toBe('99.9');
  });

  it('tunes the HF frequency with a USB-knob scroll wheel', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);
    await screen.findByText('Stations');
    await selectDemod(user, 'AM');

    const input = await screen.findByLabelText('Frequency (MHz)');
    expect(input.value).toBe('7.100');
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    await waitFor(() => expect(input.value).toBe('7.0000'));
  });

  it('tunes the HF frequency with arrow keys from a USB knob', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);
    await screen.findByText('Stations');
    await selectDemod(user, 'AM');

    const input = await screen.findByLabelText('Frequency (MHz)');
    expect(input.value).toBe('7.100');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await waitFor(() => expect(input.value).toBe('7.2000'));
  });

  it('stars an individual DAB scan station into favourites and unstars it', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);
    await screen.findByText('Stations');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiver mode' }), 'dab');
    await screen.findByText('DAB band scan');

    await user.click(screen.getByRole('button', { name: 'Scan DAB band' }));

    const ws = MockWebSocket.instances[0];
    await waitFor(() => expect(ws.readyState).toBe(MockWebSocket.OPEN));

    // Live per-channel event
    ws.emit({
      type: 'scan',
      kind: 'channel',
      channel: '11A',
      freqHz: 216928000,
      services: [{ name: 'BBC Radio 1', sid: 'C221' }, { name: 'BBC Radio 2', sid: 'C222' }],
      done: 1,
      total: 38,
    });
    await screen.findByText('BBC Radio 1');

    // Scan finished with the full grouped results
    ws.emit({
      type: 'scan',
      kind: 'done',
      aborted: false,
      found: 2,
      total: 38,
      channels: [
        { channel: '11A', freqHz: 216928000, services: [{ name: 'BBC Radio 1', sid: 'C221' }, { name: 'BBC Radio 2', sid: 'C222' }] },
      ],
    });
    await screen.findByText('2 stations found');

    // Star only BBC Radio 1 (individual station, not the whole channel)
    await user.click(screen.getAllByTitle('Add to favourites')[0]);
    await waitFor(() => {
      const stations = document.querySelector('.col-right .stations');
      expect(stations.textContent).toContain('BBC Radio 1');
      expect(stations.textContent).not.toContain('BBC Radio 2');
    });

    // Starring again removes it from favourites
    await user.click(screen.getByTitle('Remove from favourites'));
    await waitFor(() => {
      const stations = document.querySelector('.col-right .stations');
      expect(stations.textContent).not.toContain('BBC Radio 1');
    });
  });

  it('keeps previous DAB scan results and asks before a new scan wipes them', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);
    await screen.findByText('Stations');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiver mode' }), 'dab');
    await screen.findByText('DAB band scan');

    // First scan completes with results
    await user.click(screen.getByRole('button', { name: 'Scan DAB band' }));
    const ws = MockWebSocket.instances[0];
    await waitFor(() => expect(ws.readyState).toBe(MockWebSocket.OPEN));
    ws.emit({
      type: 'scan',
      kind: 'done',
      aborted: false,
      found: 1,
      total: 38,
      channels: [
        { channel: '11A', freqHz: 216928000, services: [{ name: 'BBC Radio 1', sid: 'C221' }] },
      ],
    });
    await screen.findByText('1 stations found');

    // New scan must confirm before wiping the previous results
    await user.click(screen.getByRole('button', { name: 'Scan DAB band' }));
    await screen.findByText('Start a new DAB scan?');
    expect(screen.getByText('1 stations found')).toBeInTheDocument();

    // Cancel keeps the old results and sends no scan
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('1 stations found')).toBeInTheDocument();
    expect(ws.sent.filter((m) => m.op === 'scan' && m.mode === 'dab').length).toBe(1);

    // Confirming clears the results and starts a fresh sweep
    await user.click(screen.getByRole('button', { name: 'Scan DAB band' }));
    await user.click(screen.getByRole('button', { name: 'Scan again' }));
    await waitFor(() => expect(ws.sent.filter((m) => m.op === 'scan' && m.mode === 'dab').length).toBe(2));
    await waitFor(() => expect(screen.queryByText('1 stations found')).not.toBeInTheDocument());
  });

  it('highlights a clicked DAB scan station like a favourite and keeps its star', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);
    await screen.findByText('Stations');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiver mode' }), 'dab');
    await screen.findByText('DAB band scan');

    await user.click(screen.getByRole('button', { name: 'Scan DAB band' }));
    const ws = MockWebSocket.instances[0];
    await waitFor(() => expect(ws.readyState).toBe(MockWebSocket.OPEN));
    ws.emit({
      type: 'scan',
      kind: 'done',
      aborted: false,
      found: 2,
      total: 38,
      channels: [
        { channel: '11A', freqHz: 216928000, services: [{ name: 'BBC Radio 1', sid: 'C221' }, { name: 'BBC Radio 2', sid: 'C222' }] },
      ],
    });
    await screen.findByText('2 stations found');

    // Star BBC Radio 1, its star lights up
    await user.click(screen.getAllByTitle('Add to favourites')[0]);
    await waitFor(() => {
      const star = screen.getAllByTitle('Remove from favourites')[0];
      expect(star.classList.contains('active')).toBe(true);
    });

    // Clicking a result station tunes it and highlights it like a favourite
    await user.click(screen.getByRole('button', { name: /BBC Radio 2/ }));
    await waitFor(() => {
      const rows = document.querySelectorAll('.dab-scan-service');
      const activeRow = [...rows].find((r) => r.classList.contains('active'));
      expect(activeRow).toBeTruthy();
      expect(activeRow.textContent).toContain('BBC Radio 2');
    });
  });

  it('restores the last DAB scan results after a page refresh', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());

    // First session: run a scan that completes with results, which get saved.
    const first = render(<App />);
    await screen.findByText('Stations');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiver mode' }), 'dab');
    await screen.findByText('DAB band scan');
    await user.click(screen.getByRole('button', { name: 'Scan DAB band' }));
    const ws = MockWebSocket.instances[0];
    await waitFor(() => expect(ws.readyState).toBe(MockWebSocket.OPEN));
    ws.emit({
      type: 'scan',
      kind: 'done',
      aborted: false,
      found: 1,
      total: 38,
      channels: [
        { channel: '8B', freqHz: 197648000, services: [{ name: 'BBC Radio 3', sid: 'C423' }] },
      ],
    });
    await screen.findByText('1 stations found');
    await waitFor(() => expect(localStorage.getItem('sdr-alice-dab-scan')).toBeTruthy());
    first.unmount();

    // "Refresh": re-mount with the same user; the saved results come back.
    render(<App />);
    await screen.findByText('Stations');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiver mode' }), 'dab');
    await screen.findByText('1 stations found');
    expect(screen.getByText('BBC Radio 3')).toBeInTheDocument();
  });

  it('uses the real-time spectrum scope in NFM mode instead of the waterfall', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    const { container } = render(<App />);
    await screen.findByText('Stations');

    await selectDemod(user, 'NFM');
    await screen.findByText('NFM band scan');

    expect(container.querySelector('.waterfall-canvas .scope')).toBeTruthy();
    expect(container.querySelector('.waterfall-canvas .waterfall')).toBeFalsy();
  });

  it('uses the real-time spectrum scope in HF (AM) mode too', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    const { container } = render(<App />);
    await screen.findByText('Stations');

    await selectDemod(user, 'AM');
    await screen.findByText('Manual tuning · 0.1 MHz/step');

    expect(container.querySelector('.waterfall-canvas .scope')).toBeTruthy();
    expect(container.querySelector('.waterfall-canvas .waterfall')).toBeFalsy();
  });

  it('shows a centered digital tuned-frequency readout in NFM and HF modes', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    const { container } = render(<App />);
    await screen.findByText('Stations');

    await selectDemod(user, 'NFM');
    await screen.findByText('NFM band scan');
    let readout = container.querySelector('.tuned-freq');
    expect(readout).toBeTruthy();
    expect(readout.textContent).toBe('145.0000 MHz');

    // The tuning knob / scroll wheel steps the frequency and updates the readout.
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    await waitFor(() => expect(container.querySelector('.tuned-freq').textContent).toBe('144.9000 MHz'));

    await selectDemod(user, 'AM');
    await screen.findByText('Manual tuning · 0.1 MHz/step');
    expect(container.querySelector('.tuned-freq').textContent).toBe('7.1000 MHz');
  });

  it('tuning knob steps change the chosen frequency digit', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    const { container } = render(<App />);
    await screen.findByText('Stations');

    await selectDemod(user, 'NFM');
    await screen.findByText('NFM band scan');

    // 1 MHz step changes the units digit (145.0000 -> 144.0000).
    await user.click(screen.getByRole('button', { name: '1 MHz' }));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
    await waitFor(() => expect(container.querySelector('.tuned-freq').textContent).toBe('144.0000 MHz'));

    // 0.001 MHz step changes the thousandths digit (144.0000 -> 144.0010).
    await user.click(screen.getByRole('button', { name: '0.001 MHz' }));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    await waitFor(() => expect(container.querySelector('.tuned-freq').textContent).toBe('144.0010 MHz'));
  });

  it('selects the tuning step by clicking a digit on the frequency readout and highlights it', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    const { container } = render(<App />);
    await screen.findByText('Stations');

    await selectDemod(user, 'NFM');
    await screen.findByText('NFM band scan');

    const digits = () => container.querySelectorAll('.tuned-freq .tuned-digit');
    // "145.0000" -> digit spans 1,4,5,0,0,0,0; index 5 is the thousandths (0.001 MHz).
    await user.click(digits()[5]);
    expect(digits()[5].classList.contains('active')).toBe(true);

    // The knob now moves the thousandths digit.
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    await waitFor(() => expect(container.querySelector('.tuned-freq').textContent).toBe('145.0010 MHz'));
  });

  it('offers an RTTY demodulator and shows the decoded text', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);
    await screen.findByText('Stations');

    await selectDemod(user, 'AM');
    await screen.findByText('Manual tuning · 0.1 MHz/step');

    const rttyButton = screen.getByRole('button', { name: 'RTTY' });
    expect(rttyButton).toBeInTheDocument();

    // Selecting RTTY while playing switches the server demodulator.
    await user.click(screen.getByRole('button', { name: 'Play' }));
    const ws = MockWebSocket.instances[0];
    await waitFor(() => expect(ws.readyState).toBe(MockWebSocket.OPEN));
    await user.click(rttyButton);
    await waitFor(() => expect(ws.sent.some((m) => m.op === 'tune' && m.demod === 'rtty')).toBe(true));

    // Decoded RTTY text is displayed in its own panel.
    ws.emit({ type: 'rtty', text: 'CQ DE TEST' });
    await screen.findByText('RTTY decoded');
    expect(screen.getByText('CQ DE TEST')).toBeInTheDocument();
  });

  it('groups FM/NFM/AM/USB/LSB/CW/RTTY under the RF mode', async () => {
    vi.stubGlobal('fetch', authenticatedFetch());
    const { container } = render(<App />);
    await screen.findByText('Stations');

    const modeSelect = screen.getByRole('combobox', { name: 'Receiver mode' });
    expect([...modeSelect.options].map((o) => o.value)).toEqual(['rf', 'dab', 'meshtastic', 'adsb']);

    const buttons = [...container.querySelectorAll('.demod-buttons .demod-button')].map((b) => b.textContent);
    expect(buttons).toEqual(['FM', 'NFM', 'AM', 'USB', 'LSB', 'CW', 'RTTY']);
  });

  it('loads the station list for the selected demodulator', async () => {
    const user = userEvent.setup();
    const fetchMock = authenticatedFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByText('Stations');

    await user.click(screen.getByRole('button', { name: 'USB' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/presets?mode=usb')).toBe(true)
    );
  });

  it('saves a station under the current demodulator', async () => {
    const user = userEvent.setup();
    const fetchMock = authenticatedFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByText('Stations');

    await user.click(screen.getByRole('button', { name: 'USB' }));
    await user.type(screen.getByPlaceholderText('Station name'), '20m net');
    await user.click(screen.getByRole('button', { name: 'Save current' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, opts]) => url === '/api/presets?mode=usb' && opts && opts.method === 'PUT'
        )
      ).toBe(true)
    );
  });
});
