// Renders the live SSTV image decoded by the server (RGBA pixels) and lets the
// operator export the current frame as a JPEG.
import { useEffect, useRef } from 'react';

export default function SstvImage({ frame, mode }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!frame || !canvasRef.current) return;
    const { width, height, pixels } = frame;
    const canvas = canvasRef.current;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    img.data.set(pixels.subarray(0, img.data.length));
    ctx.putImageData(img, 0, 0);
  }, [frame]);

  const saveJpeg = () => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/jpeg', 0.92);
    link.download = `sstv-${mode ? mode.toLowerCase().replace(/\s+/g, '-') : 'image'}-${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <div className="sstv-image-panel">
      <div className="sstv-image-title">
        {mode ? `SSTV · ${mode}` : 'SSTV image'}
      </div>
      <canvas
        ref={canvasRef}
        className="sstv-image-canvas"
        width={320}
        height={240}
      />
      <button className="sstv-image-save" onClick={saveJpeg} disabled={!frame}>
        Save as JPEG
      </button>
    </div>
  );
}
