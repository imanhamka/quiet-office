import fs from 'node:fs/promises';

const NL = 0x0a;
const MAX_READ_PER_POLL = 4 * 1024 * 1024;
const MAX_PARTIAL = 64 * 1024 * 1024;

// Incremental reader for append-only JSONL files. Never reads a whole file:
// the first poll starts at max(0, size - tailBytes) and drops the partial line.
export class TailReader {
  constructor(file, { tailBytes = 256 * 1024 } = {}) {
    this.file = file;
    this.tailBytes = tailBytes;
    this.offset = null;
    this.rest = null;
    this.skipFirst = false;
    this.mtimeMs = 0;
    this.size = 0;
  }

  #reset(size) {
    const start = Math.max(0, size - this.tailBytes);
    this.offset = start;
    this.skipFirst = start > 0;
    this.rest = null;
  }

  // Returns complete lines appended since the last poll. Throws on stat/read errors.
  async poll() {
    const st = await fs.stat(this.file);
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    if (this.offset === null || st.size < this.offset) this.#reset(st.size);
    if (st.size === this.offset) return [];

    const len = Math.min(st.size - this.offset, MAX_READ_PER_POLL);
    const buf = Buffer.allocUnsafe(len);
    const fh = await fs.open(this.file, 'r');
    let bytesRead = 0;
    try {
      while (bytesRead < len) {
        const r = await fh.read(buf, bytesRead, len - bytesRead, this.offset + bytesRead);
        if (r.bytesRead === 0) break;
        bytesRead += r.bytesRead;
      }
    } finally {
      await fh.close();
    }
    this.offset += bytesRead;
    const chunk = bytesRead === len ? buf : buf.subarray(0, bytesRead);
    const data = this.rest ? Buffer.concat([this.rest, chunk]) : chunk;

    const lines = [];
    let start = 0;
    let idx;
    while ((idx = data.indexOf(NL, start)) !== -1) {
      if (this.skipFirst) {
        this.skipFirst = false;
      } else if (idx > start) {
        lines.push(data.toString('utf8', start, idx).replace(/\r$/, ''));
      }
      start = idx + 1;
    }
    if (start < data.length) {
      const tail = data.subarray(start);
      if (tail.length > MAX_PARTIAL) {
        this.rest = null;
        this.skipFirst = true;
      } else {
        this.rest = Buffer.from(tail);
      }
    } else {
      this.rest = null;
    }
    return lines;
  }
}
