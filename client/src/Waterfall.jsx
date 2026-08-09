import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// server encodes db = index * 0.5 - 120 (spectrum.js: DB_MIN=-120, DB_STEP=0.5)
const DB_LO = -80; // noise floor -> dark
const DB_HI = -10; // strong signal -> hot

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

const Waterfall = forwardRef(function Waterfall({ bins = 256, height = 150 }, ref) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    canvas.width = bins;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
      const range = DB_HI - DB_LO;
      for (let x = 0; x < len; x++) {
        const db = (line[x] || 0) * 0.5 - 120;
        const t = (db - DB_LO) / range;
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
    },
  }), []);

  return <canvas ref={canvasRef} className="waterfall" />;
});

export default Waterfall;
