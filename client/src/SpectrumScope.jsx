import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Icom-style real-time spectrum scope with a waterfall. The spectrum trace is
// drawn as a bright line whose flat portion (the noise floor) sits 50% up from
// the bottom of the display; the area under the trace (above the baseline) is
// filled solid blue/navy. Signal strength in the trace is conveyed ONLY by its
// height (peaks) — the fill colour is uniform.
//
// The bottom half (below the baseline) is a scrolling waterfall: every new
// spectrum line is pushed in at the top and older lines shift down, so past
// activity stays visible as bright trails under the peaks.
const DB_MIN = -120;
const DB_STEP = 0.5; // dB per spectrum byte (matches spectrum.js)
const PEAK_SPAN = 40; // dB above the noise floor that reaches the top
const BASELINE_PCT = 0.5; // noise floor sits 50% up from the bottom
const RISE = 0.6; // trace rises fast toward a stronger signal
const FALL = 0.12; // trace falls slowly (smooth decay)
const FILL = 'rgb(0, 70, 160)';
const TRACE = 'rgb(235, 245, 255)';

// Blue waterfall palette: dark navy for the noise floor rising through blue and
// cyan to near-white for strong signals. The low/mid stops are kept fairly
// bright so even weak signals stand out from the navy background.
const WF_STOPS = [
  [0, 10, 40], // noise floor
  [0, 70, 160], // weak signals
  [0, 140, 235], // moderate
  [40, 205, 255], // strong
  [225, 250, 255], // very strong
];

// Gamma < 1 lifts weak signals (small dB above the floor) toward brighter
// colours, so they are not lost in the navy background.
const WF_GAMMA = 0.55;

function blueMap(t) {
  const f = Math.max(0, Math.min(1, t)) * (WF_STOPS.length - 1);
  const i = Math.min(WF_STOPS.length - 2, Math.floor(f));
  const frac = f - i;
  const a = WF_STOPS[i];
  const b = WF_STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * frac),
    Math.round(a[1] + (b[1] - a[1]) * frac),
    Math.round(a[2] + (b[2] - a[2]) * frac),
  ];
}

const SpectrumScope = forwardRef(function SpectrumScope({ bins = 256, height = 160 }, ref) {
  const canvasRef = useRef(null);
  const currentRef = useRef(null);
  const targetRef = useRef(null);
  const floorRef = useRef(DB_MIN);
  const historyRef = useRef(null); // ring buffer of recent spectrum lines (dB)
  const histPosRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bins;
    canvas.height = height;
    currentRef.current = new Float32Array(bins).fill(DB_MIN);
    targetRef.current = new Float32Array(bins).fill(DB_MIN);
    floorRef.current = DB_MIN;
    const wfH = Math.max(1, Math.round(height * BASELINE_PCT));
    historyRef.current = Array.from({ length: wfH }, () => new Float32Array(bins).fill(DB_MIN));
    histPosRef.current = 0;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const wfImg = ctx.createImageData(bins, wfH);

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
      // smooth it, so the baseline stays fixed at 50% up from the bottom while
      // the trace follows peaks.
      const sorted = Float32Array.from(cur).sort();
      const q = sorted[Math.floor(n * 0.25)];
      floorRef.current += (q - floorRef.current) * 0.1;
      const floor = floorRef.current;
      const baseY = h * (1 - BASELINE_PCT); // 50% up from the bottom

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

      // Solid blue/navy fill under the trace, down to the top of the waterfall.
      ctx.beginPath();
      ctx.moveTo(0, baseY);
      for (let x = 0; x < n; x++) ctx.lineTo(x * barW, ys[x]);
      ctx.lineTo(w, ys[n - 1]);
      ctx.lineTo(w, baseY);
      ctx.closePath();
      ctx.fillStyle = FILL;
      ctx.fill();

      // Waterfall: the bottom half shows the history of spectrum lines, the
      // newest at the top, older lines scrolling down. Blue intensity maps the
      // signal strength so past activity leaves visible trails.
      const history = historyRef.current;
      if (history && history.length && wfImg) {
        const cap = history.length;
        const data = wfImg.data;
        for (let r = 0; r < cap; r++) {
          const row = history[(histPosRef.current - 1 - r + cap * 2) % cap];
          const off = r * n * 4;
          for (let x = 0; x < n; x++) {
            const db = row ? row[x] : DB_MIN;
            let t = (db - floor) / PEAK_SPAN;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const [rr, gg, bb] = blueMap(Math.pow(t, WF_GAMMA));
            const o = off + x * 4;
            data[o] = rr;
            data[o + 1] = gg;
            data[o + 2] = bb;
            data[o + 3] = 255;
          }
        }
        ctx.putImageData(wfImg, 0, Math.round(baseY));
      }

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
        const history = historyRef.current;
        const cap = history ? history.length : 0;
        const row = cap ? history[histPosRef.current] : null;
        for (let x = 0; x < n; x++) {
          const db = (line[x] || 0) * DB_STEP + DB_MIN;
          tgt[x] = db;
          if (row) row[x] = db;
        }
        if (cap) histPosRef.current = (histPosRef.current + 1) % cap;
      },
      clear() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        currentRef.current = new Float32Array(bins).fill(DB_MIN);
        targetRef.current = new Float32Array(bins).fill(DB_MIN);
        floorRef.current = DB_MIN;
        const wfH = Math.max(1, Math.round(height * BASELINE_PCT));
        historyRef.current = Array.from({ length: wfH }, () => new Float32Array(bins).fill(DB_MIN));
        histPosRef.current = 0;
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
