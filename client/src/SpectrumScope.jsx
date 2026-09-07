import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Icom-style real-time spectrum scope. The spectrum trace is drawn as a bright
// line whose flat portion (the noise floor) sits ~25% up from the bottom of the
// display; the area under the trace is filled solid blue/navy. Signal strength
// is conveyed ONLY by the height of the trace (peaks) — the fill colour is
// uniform, so a peak means a signal, never a colour change.
const DB_MIN = -120;
const DB_STEP = 0.5; // dB per spectrum byte (matches spectrum.js)
const PEAK_SPAN = 40; // dB above the noise floor that reaches the top
const BASELINE_PCT = 0.25; // noise floor sits 25% up from the bottom
const RISE = 0.6; // trace rises fast toward a stronger signal
const FALL = 0.12; // trace falls slowly (smooth decay)
const FILL = 'rgb(0, 70, 160)';
const TRACE = 'rgb(235, 245, 255)';

const SpectrumScope = forwardRef(function SpectrumScope({ bins = 256, height = 160 }, ref) {
  const canvasRef = useRef(null);
  const currentRef = useRef(null);
  const targetRef = useRef(null);
  const floorRef = useRef(DB_MIN);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bins;
    canvas.height = height;
    currentRef.current = new Float32Array(bins).fill(DB_MIN);
    targetRef.current = new Float32Array(bins).fill(DB_MIN);
    floorRef.current = DB_MIN;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cur = currentRef.current;
      const tgt = targetRef.current;
      if (!cur || !tgt) return;
      const w = canvas.width;
      const h = canvas.height;
      const n = cur.length;

      // Ease each bin toward the newest spectrum line (fast rise, slow decay).
      for (let x = 0; x < n; x++) {
        const diff = tgt[x] - cur[x];
        cur[x] += diff > 0 ? diff * RISE : diff * FALL;
      }

      // Track the noise floor (a low percentile of the displayed spectrum) and
      // smooth it, so the baseline stays fixed at 25% up from the bottom while
      // the trace follows peaks.
      const sorted = Float32Array.from(cur).sort();
      const q = sorted[Math.floor(n * 0.25)];
      floorRef.current += (q - floorRef.current) * 0.1;
      const floor = floorRef.current;
      const baseY = h * (1 - BASELINE_PCT); // 25% up from the bottom

      // Map each bin to a trace Y: noise sits on the baseline, signals rise.
      const ys = new Float32Array(n);
      for (let x = 0; x < n; x++) {
        const db = cur[x];
        let y;
        if (db <= floor) y = baseY;
        else {
          const t = Math.min(1, (db - floor) / PEAK_SPAN);
          y = baseY * (1 - t);
        }
        ys[x] = Math.max(0, Math.min(h, y));
      }

      ctx.clearRect(0, 0, w, h);
      const barW = Math.ceil(w / Math.max(1, n));

      // Solid blue/navy fill from the bottom up to the trace.
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x < n; x++) ctx.lineTo(x * barW, ys[x]);
      ctx.lineTo(w, ys[n - 1]);
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = FILL;
      ctx.fill();

      // Bright trace line along the top edge of the fill.
      ctx.beginPath();
      ctx.moveTo(0, ys[0]);
      for (let x = 1; x < n; x++) ctx.lineTo(x * barW, ys[x]);
      ctx.strokeStyle = TRACE;
      ctx.lineWidth = 1;
      ctx.stroke();
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
          tgt[x] = (line[x] || 0) * DB_STEP + DB_MIN;
        }
      },
      clear() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        currentRef.current = new Float32Array(bins).fill(DB_MIN);
        targetRef.current = new Float32Array(bins).fill(DB_MIN);
        floorRef.current = DB_MIN;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      },
    }),
    [bins, height]
  );

  return <canvas ref={canvasRef} className="scope" />;
});

export default SpectrumScope;
