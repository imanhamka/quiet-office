import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TailReader } from '../lib/tail.mjs';

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiet-office-tail-'));
  return path.join(dir, 'f.jsonl');
}

test('starts near the end and drops the first partial line', async () => {
  const f = await tmpFile();
  await fs.writeFile(f, 'a'.repeat(100) + '\nline2\nline3\n');
  const r = new TailReader(f, { tailBytes: 20 });
  assert.deepEqual(await r.poll(), ['line2', 'line3']);
  assert.deepEqual(await r.poll(), []);
});

test('reads from 0 when file is smaller than the tail window', async () => {
  const f = await tmpFile();
  await fs.writeFile(f, 'one\ntwo\n');
  const r = new TailReader(f, { tailBytes: 1024 });
  assert.deepEqual(await r.poll(), ['one', 'two']);
});

test('buffers partial trailing lines incl. split UTF-8', async () => {
  const f = await tmpFile();
  const full = Buffer.from('{"x":"é漢"}\n');
  await fs.writeFile(f, full.subarray(0, 8));
  const r = new TailReader(f, { tailBytes: 1024 });
  assert.deepEqual(await r.poll(), []);
  await fs.appendFile(f, full.subarray(8));
  assert.deepEqual(await r.poll(), ['{"x":"é漢"}']);
});

test('truncation resets to the tail window', async () => {
  const f = await tmpFile();
  await fs.writeFile(f, 'aaaa\nbbbb\ncccc\n');
  const r = new TailReader(f, { tailBytes: 1024 });
  assert.equal((await r.poll()).length, 3);
  await fs.writeFile(f, 'zz\n');
  assert.deepEqual(await r.poll(), ['zz']);
});
