import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// server encodes db = index * 0.5 - 120 (spectrum.js: DB_MIN=-120, DB_STEP=0.5)
// The color scale is anchored to the measured noise floor instead of fixed dB
// limits: the low end is placed a few dB below the floor so the quiet band is
// always navy, whatever the mode. HF/AM noise sits higher than VHF/UHF NFM, so
// a fixed -80..-10 window made the AM waterfall render light-green; tracking
// the floor keeps every mode looking the same.
const SPAN = 70; // dB between the navy background and full-scale hot
const FLOOR_PAD = 8; // dB below the measured floor where the scale starts
const DB_FLOOR_START = -80; // initial floor until lines arrive

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

const Waterfall = forwardRef(function Waterfall(
  { bins = 256, height = 150, span = 0, centerHz = null, freqHz = null, visibleSpan = 0 },
  ref
) {
  const canvasRef = useRef(null);
  const floorRef = useRef(DB_FLOOR_START);
  const dbBufRef = useRef(null);
  const sortedRef = useRef(null);
  // Pan/zoom settings are read by push(), so keep the live values in refs.
  const panRef = useRef({ span, centerHz, freqHz, visibleSpan });
  panRef.current = { span, centerHz, freqHz, visibleSpan };

  useEffect(() => {
    const canvas = canvasRef.current;
    canvas.width = bins;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    dbBufRef.current = new Float32Array(bins);
    sortedRef.current = new Float32Array(bins);
    floorRef.current = DB_FLOOR_START;
  }, [bins, height]);

  useImperativeHandle(ref, () => ({
    push(line) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(
        canvas,
        0, 1, canvas.width, canvas.height - 1,
        0, 0, canvas.width, canvas.height - 1
      );
      const row = ctx.getImageData(0, canvas.height - 1, canvas.width, 1);
      const d = row.data;
      const len = Math.min(line.length, canvas.width);

      // When pan/zoom is active, sample a sub-window of the captured band
      // centered on the tuned channel so the marker stays fixed in the middle
      // while the waterfall pans as you tune. The tuner is parked during
      // digital tuning, so this is pure client-side resampling of the already
      // received band line.
      const { span, centerHz, freqHz, visibleSpan } = panRef.current;
      let srcOf;
      if (span && centerHz != null && freqHz != null && visibleSpan > 0) {
        const binHz = span / len;
        const offsetBins = (freqHz - centerHz) / binHz;
        const visibleBins = visibleSpan / binHz;
        srcOf = (x) => len / 2 + offsetBins - visibleBins / 2 + x * (visibleBins / len);
      } else {
        srcOf = (x) => x;
      }

      const dbBuf = dbBufRef.current;
      const sorted = sortedRef.current;
      for (let x = 0; x < len; x++) {
        const src = srcOf(x);
        let db;
        if (src >= 0 && src < len) {
          const i0 = Math.floor(src);
          const i1 = Math.min(len - 1, i0 + 1);
          const frac = src - i0;
          const v0 = (line[i0] || 0) * 0.5 - 120;
          const v1 = (line[i1] || 0) * 0.5 - 120;
          db = v0 + (v1 - v0) * frac;
        } else {
          db = -120;
        }
        dbBuf[x] = db;
        sorted[x] = db;
      }
      sorted.sort();
      const q25 = sorted[Math.floor(len * 0.25)];
      floorRef.current += (q25 - floorRef.current) * 0.1;
      const dbLo = floorRef.current - FLOOR_PAD;
      const dbHi = dbLo + SPAN;

      for (let x = 0; x < len; x++) {
        const t = (dbBuf[x] - dbLo) / (dbHi - dbLo);
        const [r, g, b] = colorMap(t);
        const o = x * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
      ctx.putImageData(row, 0, canvas.height - 1);
    },
    clear() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      floorRef.current = DB_FLOOR_START;
    },
  }), []);

  return <canvas ref={canvasRef} className="waterfall" />;
});

export default Waterfall;
