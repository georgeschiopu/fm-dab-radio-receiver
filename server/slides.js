import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// dablin (with the slideshow patch) writes each decoded MOT slideshow image to
// DAB_SLIDES_DIR as slide.jpg / slide.png, atomically renamed so readers never
// see a partially written file.
const SLIDES_DIR = process.env.DAB_SLIDES_DIR || '/tmp/dab-slides';
const POLL_MS = 1000;

const FILES = [
  ['slide.jpg', 'image/jpeg'],
  ['slide.png', 'image/png'],
];

export class SlideWatcher extends EventEmitter {
  constructor(dir = SLIDES_DIR) {
    super();
    this.dir = dir;
    this._timer = null;
    this._last = { name: null, mtimeMs: 0, size: 0 };
  }

  start() {
    if (this._timer) return;
    fs.mkdirSync(this.dir, { recursive: true });
    this._timer = setInterval(() => this._poll(), POLL_MS);
    this._poll();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  clear() {
    for (const [name] of FILES) {
      try {
        fs.unlinkSync(path.join(this.dir, name));
      } catch {
        /* not present */
      }
    }
    this._last = { name: null, mtimeMs: 0, size: 0 };
  }

  _poll() {
    for (const [name, mime] of FILES) {
      const file = path.join(this.dir, name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs === this._last.mtimeMs && st.size === this._last.size && name === this._last.name) {
        continue;
      }
      this._last = { name, mtimeMs: st.mtimeMs, size: st.size };
      try {
        const data = fs.readFileSync(file);
        this.emit('slide', { data, mime });
      } catch {
        /* file disappeared mid-read; retry next poll */
      }
      return;
    }
  }
}
