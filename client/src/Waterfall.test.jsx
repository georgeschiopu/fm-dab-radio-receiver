import { describe, it, expect } from 'vitest';
import { createRef } from 'react';
import { render } from '@testing-library/react';
import Waterfall from './Waterfall.jsx';

// @vitest-environment jsdom

describe('Waterfall', () => {
  it('renders a canvas sized to bins x height', () => {
    const { container } = render(<Waterfall bins={64} height={80} />);
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(80);
    expect(canvas.className).toBe('waterfall');
  });

  it('exposes push and clear without throwing', () => {
    const ref = createRef();
    render(<Waterfall ref={ref} bins={64} height={80} />);
    expect(ref.current).toBeTruthy();

    const line = new Uint8Array(64);
    for (let i = 0; i < 64; i++) line[i] = i * 2;
    expect(() => ref.current.push(line)).not.toThrow();
    expect(() => ref.current.clear()).not.toThrow();
  });
});