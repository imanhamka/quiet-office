import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { createFrameRecorder } from '../src/office/engine/frameRecorder.js';

/** A fake context that logs what reaches it. */
function target() {
  const log: string[] = [];
  const t = {
    log,
    set fillStyle(v: string) {
      log.push(`fillStyle=${v}`);
    },
    fillRect(...a: number[]) {
      log.push(`fillRect(${a.join(',')})`);
    },
    drawImage(img: { name: string }, x: number, y: number) {
      log.push(`drawImage(${img.name},${x},${y})`);
    },
    clearRect(...a: number[]) {
      log.push(`clearRect(${a.join(',')})`);
    },
  };
  return t as unknown as CanvasRenderingContext2D & { log: string[] };
}

function frame(c: CanvasRenderingContext2D, img: object, x: number) {
  c.clearRect(0, 0, 10, 10);
  c.fillStyle = 'teal';
  c.fillRect(1, 2, 3, 4);
  c.drawImage(img as CanvasImageSource, x, 0);
}

describe('frameRecorder', () => {
  test('replays the calls in order on the real context', () => {
    const r = createFrameRecorder();
    const t = target();
    const img = { name: 'a' };
    r.begin();
    frame(r.ctx, img, 5);
    assert.equal(r.commit(t), true);
    assert.deepEqual(t.log, ['clearRect(0,0,10,10)', 'fillStyle=teal', 'fillRect(1,2,3,4)', 'drawImage(a,5,0)']);
  });

  test('an identical frame leaves the canvas alone', () => {
    const r = createFrameRecorder();
    const t = target();
    const img = { name: 'a' };
    r.begin();
    frame(r.ctx, img, 5);
    r.commit(t);
    t.log.length = 0;
    r.begin();
    frame(r.ctx, img, 5);
    assert.equal(r.commit(t), false);
    assert.deepEqual(t.log, []);
  });

  test('a moved sprite or a new image (same shape) draws again', () => {
    const r = createFrameRecorder();
    const t = target();
    const a = { name: 'a' };
    r.begin();
    frame(r.ctx, a, 5);
    r.commit(t);
    r.begin();
    frame(r.ctx, a, 6);
    assert.equal(r.commit(t), true, 'moved');
    r.begin();
    frame(r.ctx, { name: 'a' }, 6);
    assert.equal(r.commit(t), true, 'another image object with the same name');
  });

  test('invalidate forces the next frame to draw', () => {
    const r = createFrameRecorder();
    const t = target();
    const img = { name: 'a' };
    r.begin();
    frame(r.ctx, img, 5);
    r.commit(t);
    r.invalidate();
    r.begin();
    frame(r.ctx, img, 5);
    assert.equal(r.commit(t), true);
  });
});
