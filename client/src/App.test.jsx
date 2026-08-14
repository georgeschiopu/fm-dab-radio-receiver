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

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
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
    expect(screen.getByRole('heading', { name: 'SDR Receiver' })).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: 'NFM' }));
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
});