import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// server encodes db = index * 0.5 - 120 (spectrum.js: DB_MIN=-120, DB_STEP=0.5)
const DB_LO = -80; // noise floor -> dark
const DB_HI = -10; // strong signal -> hot
const DB_FLOOR = -120;
const RISE = 0.6; // approach factor when signal goes up (fast)
const FALL = 0.12; // approach factor when signal falls (slow, smooth decay)
const PEAK_DECAY = 0.25; // dB dropped per animation frame for the peak-hold line

const STOPS = [
  [0, 0, 0],
  [0, 0, 120],
  [0, 0, 255],
  [0, 200, 255],
  [0, 255, 0],
  [255, 255, 0],
  [255, 120, 0],
  [255, 0, 0],
  [255, 255, 255],
];

function colorMap(t) {
  const f = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(f));
  const frac = f - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

// Real-time spectrum analyzer with a requestAnimationFrame animation loop.
// Spectrum lines arrive at ~20/s from the server; instead of redrawing only on
// arrival (which freezes between updates and stutters on chunk jitter), we run
// at 60fps and ease each bar toward the latest measurement. Rising edges are
// fast, falling edges decay smoothly, and a slow-decaying peak-hold line
// persists above the bars.
const SpectrumAnalyzer = forwardRef(function SpectrumAnalyzer({ bins = 256, height = 150 }, ref) {
  const canvasRef = useRef(null);
  const currentRef = useRef(null);
  const targetRef = useRef(null);
  const peaksRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    canvas.width = bins;
    canvas.height = height;
    currentRef.current = new Float32Array(bins).fill(DB_FLOOR);
    targetRef.current = new Float32Array(bins).fill(DB_FLOOR);
    peaksRef.current = new Float32Array(bins).fill(-Infinity);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cur = currentRef.current;
      const tgt = targetRef.current;
      const peaks = peaksRef.current;
      if (!cur || !tgt || !peaks) return;
      const w = canvas.width;
      const h = canvas.height;
      const n = cur.length;
      const barW = Math.ceil(w / Math.max(1, n));
      const range = DB_HI - DB_LO;

      for (let x = 0; x < n; x++) {
        const diff = tgt[x] - cur[x];
        cur[x] += diff > 0 ? diff * RISE : diff * FALL;
        if (tgt[x] > peaks[x]) peaks[x] = tgt[x];
        peaks[x] -= PEAK_DECAY;
      }

      ctx.clearRect(0, 0, w, h);

      for (let x = 0; x < n; x++) {
        const t = (cur[x] - DB_LO) / range;
        const clamped = Math.max(0, Math.min(1, t));
        const [r, g, b] = colorMap(clamped);
        const barH = clamped * h;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x * barW, h - barH, barW, barH);

        if (peaks[x] > DB_LO) {
          const py = h - Math.min(1, (peaks[x] - DB_LO) / range) * h;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x * barW, py - 1, barW, 2);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bins, height]);

  useImperativeHandle(
    ref,
    () => ({
      push(line) {
        const tgt = targetRef.current;
        if (!tgt) return;
        const n = Math.min(line.length, tgt.length);
        for (let x = 0; x < n; x++) {
          tgt[x] = (line[x] || 0) * 0.5 - 120;
        }
      },
      clear() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        currentRef.current = new Float32Array(bins).fill(DB_FLOOR);
        targetRef.current = new Float32Array(bins).fill(DB_FLOOR);
        peaksRef.current = new Float32Array(bins).fill(-Infinity);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      },
    }),
    [bins, height]
  );

  return <canvas ref={canvasRef} className="spectrum" />;
});

export default SpectrumAnalyzer;
