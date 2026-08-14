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

  it('updates the Frequency input when an FM scan hit is clicked', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', authenticatedFetch());
    render(<App />);

    const freqInput = await screen.findByPlaceholderText('95.1');
    expect(freqInput.value).toBe('95.1');

    await user.click(screen.getByRole('button', { name: 'Scan FM band' }));

    const ws = MockWebSocket.instances[0];
    await waitFor(() => expect(ws.readyState).toBe(MockWebSocket.OPEN));

    ws.emit({
      type: 'scan',
      kind: 'done',
      total: 2,
      hits: [
        { freq: 95100000, signal: 0.5 },
        { freq: 98500000, signal: 0.3 },
      ],
    });

    await screen.findByText('Found 2 stations');
    await user.click(screen.getByText('98.5 MHz'));

    await waitFor(() => expect(freqInput.value).toBe('98.5'));
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