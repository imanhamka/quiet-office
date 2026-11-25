import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { dayBounds, DayStats } from '../lib/stats.mjs';
import { appendLines, FAKE_HOME, makeHome, PROJECT, request, sleep, sse, start, transcriptPath, waitFor, writeConfig, writeSession } from './helpers.mjs';

const SECRET = 'SECRET_MAIL_7f3a hello from someone';
const DAY = 24 * 3600 * 1000;

function sess(sessionId, extra = {}) {
  return { pid: process.pid, sessionId, cwd: `${FAKE_HOME}/chat-relay`, name: 'x-1', nameSource: 'derived', status: 'busy', updatedAt: 1, ...extra };
}

const channelText = (n) => `<channel source="plugin:chat:chat" chat_id="c" message_id="m${n}" user="u" ts="t">${SECRET} ${n}</channel>`;
const enqueue = (content) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: 't', sessionId: 's', content });
const channelUser = (n) => ({
  type: 'user',
  isMeta: true,
  isSidechain: false,
  origin: { kind: 'channel', server: 'plugin:chat:chat' },
  message: { role: 'user', content: channelText(n) },
});
const queuedCommand = (n) => ({
  type: 'attachment',
  attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'channel' }, prompt: channelText(n) },
});

async function subagent(home, sessionId, agentId, meta = {}) {
  const dir = path.join(home, 'projects', PROJECT, sessionId, 'subagents');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  await fs.writeFile(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId: `toolu_${agentId}`, ...meta }));
  await fs.writeFile(file, '{"type":"user","message":{"role":"user","content":"x"}}\n');
  return file;
}

describe('today stats', () => {
  test('dayBounds uses local time', () => {
    const t = new Date(2026, 0, 31, 23, 59, 59).getTime();
    const b = dayBounds(t);
    assert.equal(b.day, '2026-01-31');
    assert.equal(b.start, new Date(2026, 0, 31).getTime());
    assert.equal(b.end, new Date(2026, 1, 1).getTime());
  });

  test('counts sessions and sub-agents from file times, rolls over at local midnight', async () => {
    const home = await makeHome();
    const real = Date.now();
    let clock = real;
    await fs.writeFile(transcriptPath(home, 'sa'), '{}\n');
    await fs.writeFile(transcriptPath(home, 'sb'), '{}\n');
    await fs.writeFile(transcriptPath(home, 'old'), '{}\n');
    await fs.utimes(transcriptPath(home, 'old'), new Date(real - 2 * DAY), new Date(real - 2 * DAY));
    await subagent(home, 'sa', 'a1');
    const oldSub = await subagent(home, 'sb', 'b1');
    await fs.utimes(oldSub, new Date(real - 2 * DAY), new Date(real - 2 * DAY)); // started before today
    await fs.writeFile(path.join(home, 'projects', PROJECT, 'notes.txt'), 'x');

    const seen = [];
    const stats = new DayStats({ projectsDir: path.join(home, 'projects'), now: () => clock, onChange: (m) => seen.push(m) });
    await stats.scan();
    const today = dayBounds(real);
    assert.deepEqual(stats.message(), { type: 'wallpaperStats', day: today.day, sessions: 2, subtasks: 1 });
    assert.equal(seen.length, 1);

    // Rescans only every scanMs; a second call with nothing new emits nothing.
    await stats.scan();
    assert.equal(seen.length, 1);

    // Incremental notes from the tracker count once.
    stats.noteSession('live', real);
    stats.noteSession('live', real);
    stats.noteSession('stale', real - 2 * DAY);
    assert.equal(stats.today().sessions, 3);
    assert.equal(seen.length, 2);

    // Local midnight: counts reset, then only files touched on the new day count.
    clock = today.end + 5000;
    stats.tick();
    await waitFor(() => !stats.scanning, { label: 'scan done' });
    const tomorrow = dayBounds(clock);
    assert.notEqual(tomorrow.day, today.day);
    assert.deepEqual(seen.at(-1), { type: 'wallpaperStats', day: tomorrow.day, sessions: 0, subtasks: 0 });
    await fs.utimes(transcriptPath(home, 'sa'), new Date(clock), new Date(clock + 1000));
    stats.nextScanAt = 0;
    await stats.scan();
    assert.deepEqual(stats.message(), { type: 'wallpaperStats', day: tomorrow.day, sessions: 1, subtasks: 0 });
  });

  test('server: /state.today, wallpaperStats after the snapshot, live updates, survives restart', async () => {
    const home = await makeHome();
    await fs.writeFile(transcriptPath(home, 'hist1'), '{}\n'); // ended session, active today
    await subagent(home, 'hist1', 'h1');
    await writeSession(home, 's1.json', sess('live1'));
    await appendLines(transcriptPath(home, 'live1'), [{ type: 'user', message: { role: 'user', content: 'hi' } }]);

    let srv = await start(home, undefined, { statsScanMs: 60_000 });
    let c;
    try {
      const st = JSON.parse((await request(srv.port, { path: '/state' })).body);
      assert.equal(st.today.day, dayBounds(Date.now()).day);
      assert.deepEqual({ sessions: st.today.sessions, subtasks: st.today.subtasks }, { sessions: 2, subtasks: 1 });

      c = sse(srv.port);
      await c.ready;
      await waitFor(() => c.messages.some((m) => m.type === 'wallpaperStats'), { label: 'stats on connect' });
      const types = c.messages.map((m) => m.type);
      assert.ok(types.indexOf('wallpaperStats') > types.indexOf('agentCreated'));
      assert.deepEqual(c.messages.find((m) => m.type === 'wallpaperStats'), { type: 'wallpaperStats', day: st.today.day, sessions: 2, subtasks: 1 });

      // A sub-agent of a live session counts on discovery, without waiting for the 60 s scan.
      const n = c.messages.length;
      await subagent(home, 'live1', 'l1');
      await waitFor(() => c.since(n).some((m) => m.type === 'wallpaperStats'), { label: 'subtask update' });
      assert.deepEqual(c.since(n).filter((m) => m.type === 'wallpaperStats'), [{ type: 'wallpaperStats', day: st.today.day, sessions: 2, subtasks: 2 }]);
    } finally {
      c?.close();
      await srv.stop();
    }

    srv = await start(home);
    try {
      const st = JSON.parse((await request(srv.port, { path: '/state' })).body);
      assert.deepEqual({ sessions: st.today.sessions, subtasks: st.today.subtasks }, { sessions: 2, subtasks: 2 });
    } finally {
      await srv.stop();
    }
  });

  test('server: a session that ends without the tracker seeing it is picked up by the periodic scan', async () => {
    const home = await makeHome();
    const srv = await start(home, undefined, { statsScanMs: 50 });
    const c = sse(srv.port);
    try {
      await c.ready;
      await waitFor(() => c.messages.some((m) => m.type === 'wallpaperStats'), { label: 'stats on connect' });
      assert.equal(c.messages.find((m) => m.type === 'wallpaperStats').sessions, 0);
      await fs.writeFile(transcriptPath(home, 'headless'), '{}\n');
      await waitFor(() => c.messages.some((m) => m.type === 'wallpaperStats' && m.sessions === 1), { label: 'scan update' });
    } finally {
      c.close();
      await srv.stop();
    }
  });
});

describe('wallpaperMail', () => {
  test('once per new inbound channel message, live only, no text on the wire', async () => {
    const home = await makeHome();
    await writeConfig(home, { aliases: { 'chat-relay': 'Relay' }, reception: { agent: 'relay' } });
    const tp = transcriptPath(home, 'relay');
    // History from before the server started: never replayed.
    await appendLines(tp, [enqueue(channelText(1)), channelUser(1), enqueue(channelText(2)), queuedCommand(2)]);
    await writeSession(home, 's1.json', sess('relay'));
    const srv = await start(home);
    const c = sse(srv.port);
    let c2;
    try {
      await c.ready;
      await waitFor(() => c.messages.some((m) => m.type === 'agentCreated'), { label: 'agent' });
      await sleep(150);
      assert.equal(c.messages.filter((m) => m.type === 'wallpaperMail').length, 0);

      // New message: enqueue, then its delivery as a user turn. One mail.
      await appendLines(tp, [enqueue(channelText(3)), channelUser(3)]);
      await waitFor(() => c.messages.some((m) => m.type === 'wallpaperMail'), { label: 'mail' });
      await sleep(150);
      // Mid-turn delivery (queued_command) and a typed prompt queued while busy: no extra mail.
      await appendLines(tp, [queuedCommand(3), enqueue('please also check the logs')]);
      await sleep(200);
      assert.deepEqual(c.messages.filter((m) => m.type === 'wallpaperMail'), [{ type: 'wallpaperMail', id: 1 }]);

      // Two more messages: two more mails.
      await appendLines(tp, [enqueue(channelText(4)), enqueue(`  ${channelText(5)}`)]);
      await waitFor(() => c.messages.filter((m) => m.type === 'wallpaperMail').length === 3, { label: 'two more mails' });

      // A client connecting later gets no mail replay.
      c2 = sse(srv.port);
      await c2.ready;
      await waitFor(() => c2.messages.some((m) => m.type === 'wallpaperStats'), { label: 'snapshot' });
      await sleep(100);
      assert.equal(c2.messages.filter((m) => m.type === 'wallpaperMail').length, 0);

      assert.ok(!c.raw.includes('SECRET_MAIL'));
      assert.ok(!(await request(srv.port, { path: '/state' })).body.includes('SECRET_MAIL'));
      assert.ok(!srv.logs.join('\n').includes('SECRET_MAIL'));
    } finally {
      c.close();
      c2?.close();
      await srv.stop();
    }
  });

  test('a transcript found after the agent appears is read silently (no mail for its tail)', async () => {
    const home = await makeHome();
    await writeConfig(home, { aliases: { 'chat-relay': 'Relay' }, reception: { agent: 'Relay' } });
    await writeSession(home, 's1.json', sess('late'));
    const srv = await start(home);
    const c = sse(srv.port);
    try {
      await c.ready;
      await waitFor(() => c.messages.some((m) => m.type === 'agentCreated'), { label: 'agent' });
      await appendLines(transcriptPath(home, 'late'), [enqueue(channelText(1))]);
      await waitFor(() => srv.tracker.agents.get('late')?.reader, { label: 'transcript found' });
      await sleep(150);
      assert.equal(c.messages.filter((m) => m.type === 'wallpaperMail').length, 0);
      await appendLines(transcriptPath(home, 'late'), [enqueue(channelText(2))]);
      await waitFor(() => c.messages.some((m) => m.type === 'wallpaperMail'), { label: 'mail' });
    } finally {
      c.close();
      await srv.stop();
    }
  });
});
