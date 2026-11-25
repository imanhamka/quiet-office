import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server.mjs';

export const PROJECT = '-tmp-fixture-proj';

export async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'quiet-office-test-'));
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(home, 'projects', PROJECT), { recursive: true });
  return home;
}

export function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid;
}

export async function writeSession(home, file, data) {
  const p = path.join(home, 'sessions', file);
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, p);
}

export function transcriptPath(home, sessionId) {
  return path.join(home, 'projects', PROJECT, `${sessionId}.jsonl`);
}

export async function appendLines(file, records) {
  const text = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)) + '\n').join('');
  await fs.appendFile(file, text);
}

export const toolUse = (id, name, input, extra = {}) => ({
  type: 'assistant',
  ...extra,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

export const toolResult = (id, content = 'done', extra = {}, block = {}) => ({
  type: 'user',
  ...extra,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...block }] },
});

export const assistantUsage = (usage, extra = {}, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  ...extra,
  message: { model, role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage },
});

export const FAKE_HOME = '/home/demo';

export const configFile = (home) => path.join(home, 'config.json');

// Writes config.json with a fresh mtime so the store re-reads it on the next poll.
export async function writeConfig(home, data) {
  const p = configFile(home);
  await fs.writeFile(p, typeof data === 'string' ? data : JSON.stringify(data));
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6) + 1000);
  await fs.utimes(p, t, t);
}

export async function start(home, webDir = path.join(home, 'web'), tracker = {}) {
  const logs = [];
  const s = await startServer({
    port: 0,
    claudeDir: home,
    webDir,
    configFile: configFile(home),
    log: (l) => logs.push(l),
    tracker: { tickMs: 40, slowEvery: 1, transcriptSearchMs: 0, subagentIdleMs: 800, homeDir: FAKE_HOME, ...tracker },
  });
  s.logs = logs;
  return s;
}

export function request(port, { method = 'GET', path: p = '/', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { host: host ?? `127.0.0.1:${port}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export function sse(port) {
  const client = { raw: '', messages: [], req: null };
  client.ready = new Promise((resolve, reject) => {
    client.req = http.get(
      { host: '127.0.0.1', port, path: '/events', headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        client.res = res;
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          client.raw += chunk;
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of frame.split('\n')) {
              if (line.startsWith('data: ')) client.messages.push(JSON.parse(line.slice(6)));
            }
          }
        });
        resolve(res);
      },
    );
    client.req.on('error', reject);
  });
  client.close = () => client.req.destroy();
  client.since = (n) => client.messages.slice(n);
  return client;
}

export async function waitFor(fn, { timeout = 4000, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
