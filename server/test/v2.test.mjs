import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { computeName } from '../lib/naming.mjs';
import {
  appendLines,
  assistantUsage,
  FAKE_HOME,
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
  writeConfig,
  writeSession,
} from './helpers.mjs';

const SECRET = 'SECRET_PROMPT_91c2 do not leak';
const DESC = 'DESC_TEXT_44 investigate thing';

function sess(sessionId, extra = {}) {
  return { pid: process.pid, sessionId, cwd: `${FAKE_HOME}/work/proj-a`, name: 'proj-a-12', nameSource: 'derived', status: 'busy', updatedAt: 1, ...extra };
}

const usage = (input, cacheRead, cacheCreate, output = 10) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
  output_tokens: output,
  iterations: [{ input_tokens: 999999, cache_read_input_tokens: 999999 }],
});

describe('naming rule', () => {
  const home = FAKE_HOME;
  const aliases = new Map([
    ['chat-relay', 'Relay'],
    ['proj', 'Short'],
    ['proj-long', 'Longer'],
  ]);

  test('nameSource, tmux, cwd basename, sesi- fallback', () => {
    assert.equal(computeName({ name: 'Renamed', nameSource: 'user', tmux: 'lab:@0.%0', cwd: `${home}/a` }, { homeDir: home }), 'Renamed');
    assert.equal(computeName({ name: 'x-42', nameSource: 'derived', tmux: 'demo-lab:@0.%0', cwd: home }, { homeDir: home }), 'demo-lab');
    assert.equal(computeName({ name: 'x-42', nameSource: 'derived', tmux: ':@0.%0', cwd: `${home}/code/site` }, { homeDir: home }), 'site');
    assert.equal(computeName({ name: 'x-42', nameSource: 'derived', cwd: `${home}/` , sessionId: 'ab-cdef' }, { homeDir: home }), 'sesi-abcd');
    assert.equal(computeName({ nameSource: 'derived', sessionId: '9f3e1111' }, { homeDir: home }), 'sesi-9f3e');
    assert.equal(computeName({ name: 'Legacy name', cwd: `${home}/z` }, { homeDir: home }), 'Legacy name');
  });

  test('aliases: exact, longest prefix, cwd basename; applied last', () => {
    const o = { homeDir: home, aliases };
    assert.equal(computeName({ nameSource: 'derived', cwd: `${home}/chat-relay` }, o), 'Relay');
    assert.equal(computeName({ name: 'chat-relay-b2', nameSource: 'user', cwd: home }, o), 'Relay');
    assert.equal(computeName({ nameSource: 'derived', cwd: '/w/proj-long-2' }, o), 'Longer');
    assert.equal(computeName({ nameSource: 'derived', cwd: '/w/proj-x' }, o), 'Short');
    assert.equal(computeName({ name: 'Mine', nameSource: 'user', cwd: '/w/chat-relay' }, o), 'Relay');
    assert.equal(computeName({ nameSource: 'derived', cwd: '/w/other' }, o), 'other');
  });

  test('derived -> user rename re-announces under a new id', async () => {
    const dir = await makeHome();
    await writeConfig(dir, { aliases: { 'chat-relay': 'Relay' } });
    await writeSession(dir, '1.json', sess('s-rename', { cwd: `${FAKE_HOME}/chat-relay`, name: 'chat-relay-b2' }));
    await writeSession(dir, '2.json', sess('s-tmux', { cwd: FAKE_HOME, tmux: 'demo-lab:@0.%0' }));
    await writeSession(dir, '3.json', sess('7c1d-home', { cwd: FAKE_HOME }));
    const srv = await start(dir);
    try {
      const c = sse(srv.port);
      await c.ready;
      await waitFor(() => c.messages.filter((m) => m.type === 'agentCreated').length === 3, { label: 'snapshot' });
      const names = Object.values(c.messages.find((m) => m.type === 'existingAgents').directoryNames).sort();
      assert.deepEqual(names, ['Relay', 'demo-lab', 'sesi-7c1d']);
      const old = c.messages.find((m) => m.type === 'agentCreated' && m.directoryName === 'Relay').id;

      const n = c.messages.length;
      await writeSession(dir, '1.json', sess('s-rename', { cwd: '/w/x', name: 'Kerja Baru', nameSource: 'user', updatedAt: 2 }));
      await waitFor(() => c.since(n).some((m) => m.type === 'agentCreated'), { label: 'recreate' });
      const d = c.since(n);
      assert.deepEqual(d.slice(0, 2), [
        { type: 'agentToolsClear', id: old },
        { type: 'agentClosed', id: old },
      ]);
      const created = d.find((m) => m.type === 'agentCreated');
      assert.equal(created.directoryName, 'Kerja Baru');
      assert.notEqual(created.id, old);
      assert.ok(created.id > 3);
      await sleep(150);
      assert.equal(c.since(n).filter((m) => m.type === 'agentCreated').length, 1, 'renamed once only');
      c.close();
    } finally {
      await srv.stop();
    }
  });
});

describe('v2 wire additions', () => {
  test('context usage, tool error, waitingSince', async () => {
    const dir = await makeHome();
    const sid = 'ctx-0001';
    const f = transcriptPath(dir, sid);
    await appendLines(f, [
      assistantUsage(usage(2, 30000, 1000)),
      assistantUsage(usage(0, 0, 0, 0), {}, '<synthetic>'),
      assistantUsage(usage(1, 90000, 0), { isSidechain: true }),
      toolResult('toolu_x', 'r', {}, { toolUseResult: { usage: usage(5, 5, 5) } }),
    ]);
    await writeSession(dir, '1.json', sess(sid, { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: 1795000000000 }));
    const srv = await start(dir);
    try {
      const c = sse(srv.port);
      await c.ready;
      await waitFor(() => c.messages.some((m) => m.type === 'agentContextUsage'), { label: 'snapshot ctx' });
      assert.deepEqual(c.messages.find((m) => m.type === 'agentStatus'), {
        type: 'agentStatus',
        id: 1,
        status: 'waiting',
        awaitingInput: true,
        waitingSince: 1795000000000,
      });
      assert.deepEqual(c.messages.find((m) => m.type === 'agentContextUsage'), {
        type: 'agentContextUsage',
        id: 1,
        contextTokens: 31002,
        maxContextTokens: 200000,
      });

      // Same 1% bucket: no message. New bucket: message.
      let n = c.messages.length;
      await appendLines(f, [assistantUsage(usage(2, 31000, 0))]);
      await sleep(200);
      assert.equal(c.since(n).filter((m) => m.type === 'agentContextUsage').length, 0);
      await appendLines(f, [assistantUsage(usage(2, 50000, 0)), assistantUsage(usage(2, 60000, 0))]);
      await waitFor(() => c.since(n).some((m) => m.type === 'agentContextUsage'), { label: 'ctx delta' });
      assert.deepEqual(c.since(n).filter((m) => m.type === 'agentContextUsage'), [
        { type: 'agentContextUsage', id: 1, contextTokens: 60002, maxContextTokens: 200000 },
      ]);

      // Past 200k means a 1M window; it stays 1M after compaction.
      n = c.messages.length;
      await appendLines(f, [assistantUsage(usage(2, 250000, 0))]);
      await waitFor(() => c.since(n).some((m) => m.type === 'agentContextUsage'), { label: 'ctx 1m' });
      assert.equal(c.since(n).find((m) => m.type === 'agentContextUsage').maxContextTokens, 1000000);
      n = c.messages.length;
      await appendLines(f, [assistantUsage(usage(2, 40000, 0))]);
      await waitFor(() => c.since(n).some((m) => m.type === 'agentContextUsage'), { label: 'ctx after compact' });
      assert.deepEqual(c.since(n).find((m) => m.type === 'agentContextUsage'), {
        type: 'agentContextUsage',
        id: 1,
        contextTokens: 40002,
        maxContextTokens: 1000000,
      });

      // Tool error flag, boolean only.
      await writeSession(dir, '1.json', sess(sid, { status: 'busy', updatedAt: 2, statusUpdatedAt: 1795000001000 }));
      await appendLines(f, [toolUse('toolu_e', 'Bash', { command: SECRET }), toolUse('toolu_ok', 'Read', { file_path: '/a/b.txt' })]);
      await waitFor(() => c.messages.some((m) => m.toolId === 'toolu_ok'), { label: 'tool starts' });
      n = c.messages.length;
      await appendLines(f, [toolResult('toolu_e', `Exit code 1 ${SECRET}`, {}, { is_error: true }), toolResult('toolu_ok', 'fine')]);
      await waitFor(() => c.since(n).filter((m) => m.type === 'agentToolDone').length === 2, { label: 'tool done' });
      assert.deepEqual(c.since(n).filter((m) => m.type === 'agentToolDone'), [
        { type: 'agentToolDone', id: 1, toolId: 'toolu_e', error: true },
        { type: 'agentToolDone', id: 1, toolId: 'toolu_ok' },
      ]);

      // Permission carries waitingSince; idle waiting too.
      n = c.messages.length;
      await writeSession(dir, '1.json', sess(sid, { status: 'waiting', waitingFor: 'approve Bash', updatedAt: 3, statusUpdatedAt: 1795000002000 }));
      await waitFor(() => c.since(n).some((m) => m.type === 'agentToolPermission'), { label: 'permission' });
      assert.deepEqual(c.since(n).find((m) => m.type === 'agentToolPermission'), { type: 'agentToolPermission', id: 1, waitingSince: 1795000002000 });
      // /state (read by the host's menu bar item) carries the wait start too.
      const waitingState = JSON.parse((await request(srv.port, { path: '/state' })).body);
      assert.equal(waitingState.agents[0].mode, 'permission');
      assert.equal(waitingState.agents[0].waitingSince, 1795000002000);
      n = c.messages.length;
      await writeSession(dir, '1.json', sess(sid, { status: 'idle', updatedAt: 4, statusUpdatedAt: 1795000003000 }));
      await waitFor(() => c.since(n).some((m) => m.type === 'agentStatus'), { label: 'idle' });
      assert.deepEqual(c.since(n).find((m) => m.type === 'agentStatus'), { type: 'agentStatus', id: 1, status: 'waiting', waitingSince: 1795000003000 });

      const st = JSON.parse((await request(srv.port, { path: '/state' })).body);
      assert.deepEqual(st.agents[0].context, { tokens: 40002, max: 1000000 });
      assert.equal(st.agents[0].waitingSince, null, 'no wait start once idle');
      assert.ok(!c.raw.includes('SECRET_PROMPT'), 'tool text leaked');
      c.close();
    } finally {
      await srv.stop();
    }
  });

  test('explicit contextMax and [1m] model', async () => {
    const dir = await makeHome();
    await appendLines(transcriptPath(dir, 'm1'), [assistantUsage(usage(0, 1000, 0))]);
    await appendLines(transcriptPath(dir, 'm2'), [assistantUsage(usage(0, 1000, 0), {}, 'claude-opus-5-5[1m]')]);
    await writeSession(dir, '1.json', sess('m1'));
    await writeSession(dir, '2.json', sess('m2', { cwd: '/w/b' }));
    const srv = await start(dir, undefined, { contextMax: 100000 });
    try {
      const st = JSON.parse((await request(srv.port, { path: '/state' })).body);
      const byName = Object.fromEntries(st.agents.map((a) => [a.name, a.context]));
      assert.deepEqual(byName['proj-a'], { tokens: 1000, max: 100000 });
      assert.deepEqual(byName.b, { tokens: 1000, max: 1000000 });
    } finally {
      await srv.stop();
    }
  });

  test('sub-agent label from meta, meta.finished clears, no description/prompt on the wire', async () => {
    const dir = await makeHome();
    const sid = 'sub-0001';
    const f = transcriptPath(dir, sid);
    await writeSession(dir, '1.json', sess(sid));
    const srv = await start(dir, undefined, { subagentIdleMs: 60_000 });
    try {
      const c = sse(srv.port);
      await c.ready;
      await waitFor(() => c.messages.some((m) => m.type === 'agentCreated'), { label: 'snapshot' });
      let n = c.messages.length;
      await appendLines(f, [toolUse('toolu_sp', 'Agent', { description: DESC, prompt: SECRET })]);
      await waitFor(() => c.since(n).some((m) => m.toolId === 'toolu_sp'), { label: 'spawn' });
      assert.equal(c.since(n).find((m) => m.toolId === 'toolu_sp').status, 'Subtask: agent');

      const subDir = path.join(dir, 'projects', PROJECT, sid, 'subagents');
      await fs.mkdir(subDir, { recursive: true });
      const metaFile = path.join(subDir, 'agent-s1.meta.json');
      await fs.writeFile(metaFile, JSON.stringify({ agentType: 'web-fetch', description: DESC, toolUseId: 'toolu_sp' }));
      await appendLines(path.join(subDir, 'agent-s1.jsonl'), [toolUse('toolu_in', 'Grep', { pattern: SECRET }, { isSidechain: true })]);
      await waitFor(() => c.messages.some((m) => m.type === 'subagentToolStart'), { label: 'sub start' });

      const late = sse(srv.port);
      await late.ready;
      await waitFor(() => late.messages.some((m) => m.toolId === 'toolu_sp'), { label: 'late' });
      assert.equal(late.messages.find((m) => m.toolId === 'toolu_sp').status, 'Subtask: web-fetch');
      late.close();

      n = c.messages.length;
      await fs.writeFile(metaFile, JSON.stringify({ agentType: 'web-fetch', description: DESC, toolUseId: 'toolu_sp', finished: true }));
      await fs.utimes(metaFile, new Date(), new Date(Date.now() + 5000));
      await waitFor(() => c.since(n).some((m) => m.type === 'subagentClear'), { label: 'meta finished' });
      assert.deepEqual(c.since(n).find((m) => m.type === 'subagentClear'), { type: 'subagentClear', id: 1, parentToolId: 'toolu_sp' });

      assert.ok(!c.raw.includes('DESC_TEXT') && !late.raw.includes('DESC_TEXT'), 'description leaked');
      assert.ok(!c.raw.includes('SECRET_PROMPT') && !late.raw.includes('SECRET_PROMPT'), 'prompt leaked');
      c.close();
    } finally {
      await srv.stop();
    }
  });
});
