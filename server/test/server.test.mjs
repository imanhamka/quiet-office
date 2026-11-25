import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  appendLines,
  deadPid,
  makeHome,
  PROJECT,
  request,
  sleep,
  sse,
  start,
  toolResult,
  toolUse,
  transcriptPath,
  waitFor,
  writeSession,
} from './helpers.mjs';

const SECRET = 'SECRET_CMD_7f3a rm -rf /very/private';
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const SUB_SPAWN = 'toolu_spawn_1';

function session(extra = {}) {
  return { pid: process.pid, sessionId: SID, cwd: '/home/demo/projects/my-cool-project', name: '', status: 'busy', kind: 'interactive', updatedAt: 1, ...extra };
}

describe('tracker + SSE', () => {
  let home;
  let srv;
  let tfile;

  before(async () => {
    home = await makeHome();
    tfile = transcriptPath(home, SID);
    await appendLines(tfile, [
      { type: 'summary', foo: 1 },
      'this is { not json',
      toolUse('toolu_bash_done', 'Bash', { command: SECRET }),
      toolResult('toolu_bash_done', `output of ${SECRET}`),
      toolUse('toolu_read_open', 'Read', { file_path: '/home/demo/projects/my-cool-project/src/server.ts' }),
      toolUse('toolu_side', 'Grep', { pattern: 'x' }, { isSidechain: true }),
      { type: 'weird-new-type', message: { content: [{ type: 'tool_use', id: 'nope', name: 'Read' }] } },
    ]);
    await writeSession(home, '111.json', session());
    await writeSession(home, '999.json', session({ pid: deadPid(), sessionId: 'dead-session' }));
    await fs.writeFile(path.join(home, 'sessions', '111.abc.key'), 'garbage');
    srv = await start(home);
  });

  after(async () => {
    await srv.stop();
  });

  test('snapshot on connect, then deltas; privacy holds', async () => {
    const c = sse(srv.port);
    const res = await c.ready;
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['access-control-allow-origin'], undefined);

    await waitFor(() => c.messages.some((m) => m.type === 'agentToolStart'), { label: 'snapshot' });
    const types = c.messages.map((m) => m.type);
    assert.deepEqual(c.messages[0], { type: 'wallpaperConfig', reception: null, lang: null });
    assert.equal(types[1], 'providerCapabilities');
    assert.deepEqual(c.messages[1].readingTools, ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
    assert.equal(types[2], 'existingAgents');
    assert.deepEqual(c.messages[2].agents, [1]);
    assert.deepEqual(c.messages[2].directoryNames, { 1: 'my-cool-project' });
    const created = c.messages.filter((m) => m.type === 'agentCreated');
    assert.deepEqual(created, [{ type: 'agentCreated', id: 1, directoryName: 'my-cool-project', isExternal: true }]);
    assert.deepEqual(c.messages.find((m) => m.type === 'agentStatus'), { type: 'agentStatus', id: 1, status: 'active' });
    const starts = c.messages.filter((m) => m.type === 'agentToolStart');
    assert.deepEqual(starts, [
      { type: 'agentToolStart', id: 1, toolId: 'toolu_read_open', status: 'Reading server.ts', toolName: 'Read' },
    ]);

    // Delta: Bash start + done.
    let n = c.messages.length;
    await appendLines(tfile, [toolUse('toolu_bash2', 'Bash', { command: SECRET })]);
    await waitFor(() => c.since(n).some((m) => m.type === 'agentToolStart'), { label: 'bash start' });
    assert.deepEqual(c.since(n)[0], { type: 'agentToolStart', id: 1, toolId: 'toolu_bash2', status: 'Running command', toolName: 'Bash' });
    n = c.messages.length;
    await appendLines(tfile, [toolResult('toolu_bash2', SECRET)]);
    await waitFor(() => c.since(n).some((m) => m.type === 'agentToolDone'), { label: 'bash done' });
    assert.deepEqual(c.since(n)[0], { type: 'agentToolDone', id: 1, toolId: 'toolu_bash2' });

    // Partial line is buffered until its newline lands.
    n = c.messages.length;
    const line = JSON.stringify(toolUse('toolu_partial', 'Edit', { file_path: '/p/q/app.tsx', old_string: SECRET }));
    await fs.appendFile(tfile, line.slice(0, 40));
    await sleep(200);
    assert.equal(c.since(n).length, 0);
    await fs.appendFile(tfile, line.slice(40) + '\n');
    await waitFor(() => c.since(n).some((m) => m.toolId === 'toolu_partial'), { label: 'partial' });
    assert.equal(c.since(n)[0].status, 'Editing app.tsx');

    // Permission prompt, then back to busy.
    n = c.messages.length;
    await writeSession(home, '111.json', session({ status: 'waiting', waitingFor: 'permission prompt', updatedAt: 2 }));
    await waitFor(() => c.since(n).some((m) => m.type === 'agentToolPermission'), { label: 'permission' });
    n = c.messages.length;
    await writeSession(home, '111.json', session({ status: 'busy', updatedAt: 3 }));
    await waitFor(() => c.since(n).some((m) => m.type === 'agentStatus'), { label: 'busy again' });
    assert.deepEqual(c.since(n).map((m) => m.type), ['agentToolPermissionClear', 'agentStatus']);

    // Input needed.
    n = c.messages.length;
    await writeSession(home, '111.json', session({ status: 'waiting', waitingFor: 'input needed', updatedAt: 4 }));
    await waitFor(() => c.since(n).length > 0, { label: 'input' });
    assert.deepEqual(c.since(n)[0], { type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: true });

    // Idle clears stale tools.
    n = c.messages.length;
    await writeSession(home, '111.json', session({ status: 'idle', updatedAt: 5 }));
    await waitFor(() => c.since(n).length >= 2, { label: 'idle' });
    assert.deepEqual(c.since(n), [
      { type: 'agentToolsClear', id: 1 },
      { type: 'agentStatus', id: 1, status: 'waiting' },
    ]);
    const state = JSON.parse((await request(srv.port, { path: '/state' })).body);
    assert.equal(state.agents[0].tools.length, 0);

    await writeSession(home, '111.json', session({ status: 'busy', updatedAt: 6 }));
    await sleep(150);

    assert.ok(!c.raw.includes('SECRET_CMD'), 'Bash command text leaked into SSE');
    assert.ok(!c.messages.some((m) => m.id !== 1 && typeof m.id === 'number'), 'dead pid session leaked');
    c.close();
  });

  test('sub-agent lifecycle', async () => {
    const c = sse(srv.port);
    await c.ready;
    await waitFor(() => c.messages.some((m) => m.type === 'agentCreated'), { label: 'snapshot' });
    let n = c.messages.length;
    await appendLines(tfile, [toolUse(SUB_SPAWN, 'Agent', { description: 'Investigate the flaky tests in ci', prompt: SECRET, subagent_type: 'Explore' })]);
    await waitFor(() => c.since(n).some((m) => m.toolId === SUB_SPAWN), { label: 'spawn start' });
    assert.deepEqual(c.since(n).find((m) => m.toolId === SUB_SPAWN), {
      type: 'agentToolStart',
      id: 1,
      toolId: SUB_SPAWN,
      status: 'Subtask: Explore',
      toolName: 'Agent',
    });

    const subDir = path.join(home, 'projects', PROJECT, SID, 'subagents');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'x', toolUseId: SUB_SPAWN, spawnDepth: 1 }));
    const subFile = path.join(subDir, 'agent-abc123.jsonl');
    n = c.messages.length;
    await appendLines(subFile, [toolUse('toolu_sub_grep', 'Grep', { pattern: SECRET }, { isSidechain: true })]);
    await waitFor(() => c.since(n).some((m) => m.type === 'subagentToolStart'), { label: 'sub start' });
    assert.deepEqual(c.since(n).find((m) => m.type === 'subagentToolStart'), {
      type: 'subagentToolStart',
      id: 1,
      parentToolId: SUB_SPAWN,
      toolId: 'toolu_sub_grep',
      status: 'Searching code',
    });
    n = c.messages.length;
    await appendLines(subFile, [toolResult('toolu_sub_grep', SECRET, { isSidechain: true })]);
    await waitFor(() => c.since(n).some((m) => m.type === 'subagentToolDone'), { label: 'sub done' });

    // Late joiner sees the live sub-agent tool state in its snapshot.
    await appendLines(subFile, [toolUse('toolu_sub_read', 'Read', { file_path: '/a/b/notes.md' }, { isSidechain: true })]);
    await waitFor(() => c.messages.some((m) => m.toolId === 'toolu_sub_read'), { label: 'sub read' });
    const late = sse(srv.port);
    await late.ready;
    await waitFor(() => late.messages.some((m) => m.type === 'subagentToolStart'), { label: 'late snapshot' });
    assert.ok(late.messages.some((m) => m.type === 'agentToolStart' && m.toolId === SUB_SPAWN));
    late.close();

    n = c.messages.length;
    await appendLines(tfile, [toolResult(SUB_SPAWN, [{ type: 'text', text: 'final report' }])]);
    await waitFor(() => c.since(n).some((m) => m.type === 'subagentClear'), { label: 'sub clear' });
    assert.deepEqual(c.since(n).find((m) => m.type === 'subagentClear'), { type: 'subagentClear', id: 1, parentToolId: SUB_SPAWN });
    assert.ok(c.since(n).some((m) => m.type === 'agentToolDone' && m.toolId === SUB_SPAWN));

    // Background spawn: launch result keeps the sub; idle timeout clears it.
    n = c.messages.length;
    await appendLines(tfile, [toolUse('toolu_bg', 'Agent', { description: 'bg job', run_in_background: true })]);
    await waitFor(() => c.since(n).some((m) => m.toolId === 'toolu_bg'), { label: 'bg start' });
    assert.equal(c.since(n).find((m) => m.toolId === 'toolu_bg').runInBackground, true);
    await appendLines(tfile, [toolResult('toolu_bg', 'Async agent launched successfully.\nagentId: zz')]);
    await fs.writeFile(path.join(subDir, 'agent-bg1.meta.json'), JSON.stringify({ toolUseId: 'toolu_bg' }));
    const bgFile = path.join(subDir, 'agent-bg1.jsonl');
    await appendLines(bgFile, [toolUse('toolu_bg_bash', 'Bash', { command: SECRET })]);
    await waitFor(() => c.messages.some((m) => m.type === 'subagentToolStart' && m.parentToolId === 'toolu_bg'), { label: 'bg sub start' });
    assert.ok(!c.messages.some((m) => m.type === 'subagentClear' && m.parentToolId === 'toolu_bg'));
    await waitFor(() => c.messages.some((m) => m.type === 'subagentClear' && m.parentToolId === 'toolu_bg'), { label: 'bg idle clear', timeout: 4000 });

    assert.ok(!c.raw.includes('SECRET_CMD'), 'secret leaked');
    assert.ok(!c.raw.includes('Investigate') && !c.raw.includes('bg job'), 'sub-agent description leaked');
    c.close();
  });

  test('session removal closes the agent', async () => {
    const c = sse(srv.port);
    await c.ready;
    await waitFor(() => c.messages.some((m) => m.type === 'agentCreated'), { label: 'snapshot' });
    const n = c.messages.length;
    await fs.rm(path.join(home, 'sessions', '111.json'));
    await waitFor(() => c.since(n).some((m) => m.type === 'agentClosed'), { label: 'closed' });
    assert.deepEqual(c.since(n), [
      { type: 'agentToolsClear', id: 1 },
      { type: 'agentClosed', id: 1 },
    ]);
    // Same session back keeps its id.
    await writeSession(home, '111.json', session({ updatedAt: 9 }));
    await waitFor(() => c.since(n).some((m) => m.type === 'agentCreated'), { label: 'recreated' });
    assert.equal(c.since(n).find((m) => m.type === 'agentCreated').id, 1);
    assert.ok(srv.logs.some((l) => l.includes('agent created #1')));
    assert.ok(srv.logs.some((l) => l.includes('agent closed #1')));
    c.close();
  });
});

describe('initial tail window', () => {
  test('tools before the 256KB window are not shown; idle session shows no tools', async () => {
    const home = await makeHome();
    const sid = 'bbbbbbbb-0000';
    const f = transcriptPath(home, sid);
    await appendLines(f, [toolUse('toolu_old', 'Read', { file_path: '/old.txt' })]);
    await fs.appendFile(f, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } }) + '\n');
    await appendLines(f, [toolUse('toolu_new', 'Grep', { pattern: 'a' })]);
    await writeSession(home, '1.json', { pid: process.pid, sessionId: sid, cwd: '/w/proj', name: 'A very long session name that exceeds', status: 'busy' });
    await writeSession(home, '2.json', { pid: process.pid, sessionId: 'cccc-idle', cwd: '/w/other', status: 'idle' });
    await appendLines(transcriptPath(home, 'cccc-idle'), [toolUse('toolu_stale', 'Read', { file_path: '/s.txt' })]);
    const srv = await start(home);
    try {
      const st = JSON.parse((await request(srv.port, { path: '/state' })).body);
      const busy = st.agents.find((a) => a.name.startsWith('A very'));
      assert.equal(busy.name, 'A very long session name');
      assert.deepEqual(busy.tools.map((t) => t.toolId), ['toolu_new']);
      const idle = st.agents.find((a) => a.name === 'other');
      assert.equal(idle.mode, 'idle');
      assert.equal(idle.tools.length, 0);
    } finally {
      await srv.stop();
    }
  });
});

describe('http', () => {
  let home;
  let srv;
  before(async () => {
    home = await makeHome();
    const web = path.join(home, 'web');
    await fs.mkdir(path.join(web, 'assets'), { recursive: true });
    await fs.writeFile(path.join(web, 'index.html'), '<!doctype html><title>t</title>');
    await fs.writeFile(path.join(web, 'assets', 'app.js'), 'console.log(1)');
    await fs.writeFile(path.join(web, 'assets', 'a.png'), Buffer.from([0x89, 0x50]));
    await fs.writeFile(path.join(home, 'outside.txt'), 'outside');
    srv = await start(home, web);
  });
  after(() => srv.stop());

  test('healthz', async () => {
    const r = await request(srv.port, { path: '/healthz' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'ok');
    assert.equal((await request(srv.port, { path: '/healthz', host: `localhost:${srv.port}` })).status, 200);
  });

  test('Host header check', async () => {
    for (const host of ['evil.com', `evil.com:${srv.port}`, '127.0.0.1', `127.0.0.1:${srv.port + 1}`, `[::1]:${srv.port}`]) {
      const r = await request(srv.port, { path: '/healthz', host });
      assert.equal(r.status, 403, `host ${host}`);
    }
    assert.equal((await request(srv.port, { path: '/events', host: 'evil.com' })).status, 403);
    // HTTP/1.0 request with no Host header at all.
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect(srv.port, '127.0.0.1', () => sock.end('GET /healthz HTTP/1.0\r\n\r\n'));
      let out = '';
      sock.on('data', (d) => (out += d));
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.[01] 403/);
  });

  test('method check', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const r = await request(srv.port, { method, path: '/healthz' });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    const h = await request(srv.port, { method: 'HEAD', path: '/' });
    assert.equal(h.status, 200);
    assert.equal(h.body, '');
  });

  test('static files with content types', async () => {
    const idx = await request(srv.port, { path: '/?wallpaper=1&screen=0' });
    assert.equal(idx.status, 200);
    assert.equal(idx.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(idx.body, /doctype/);
    assert.equal((await request(srv.port, { path: '/assets/app.js' })).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await request(srv.port, { path: '/assets/a.png' })).headers['content-type'], 'image/png');
    assert.equal((await request(srv.port, { path: '/missing.js' })).status, 404);
    assert.equal((await request(srv.port, { path: '/assets' })).status, 404);
  });

  test('path traversal is 404', async () => {
    for (const p of ['/../outside.txt', '/..%2foutside.txt', '/%2e%2e/outside.txt', '/assets/../../outside.txt', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/../../../../etc/passwd', '/%00', '/%E0%A4%A']) {
      const r = await request(srv.port, { path: p });
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes('outside') && !r.body.includes('root:'), p);
    }
  });
});
