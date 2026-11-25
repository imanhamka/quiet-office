import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { channelAllowed, channelTagAttrs } from '../lib/channel.mjs';
import { ConfigStore, configPath, defaultConfig, parseConfig } from '../lib/config.mjs';
import { SECURITY_HEADERS } from '../lib/http.mjs';
import { defaultStartTimeReader, recordedStart, StartTimeGuard } from '../lib/procstart.mjs';
import { claudeConfigDir, startServer } from '../server.mjs';
import {
  appendLines,
  assistantUsage,
  configFile,
  FAKE_HOME,
  makeHome,
  request,
  sleep,
  sse,
  start,
  transcriptPath,
  waitFor,
  writeConfig,
  writeSession,
} from './helpers.mjs';

const SECRET = 'SECRET_BODY_5d1e source="plugin:chat:chat" hello';
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

function sess(sessionId, extra = {}) {
  return { pid: process.pid, sessionId, cwd: `${FAKE_HOME}/${sessionId}`, name: 'x-1', nameSource: 'derived', status: 'busy', updatedAt: 1, ...extra };
}

const channel = (source, n) => `<channel source="${source}" chat_id="c" message_id="m${n}" user="u">${SECRET} ${n}</channel>`;
const enqueue = (content) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: 't', sessionId: 's', content });
const mails = (c) => c.messages.filter((m) => m.type === 'wallpaperMail');

// `LC_ALL=C TZ=UTC ps -o lstart=` format, which Claude Code writes as procStart.
function lstart(ms) {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${time} ${d.getUTCFullYear()}`;
}

describe('Claude config dir', () => {
  test('CLAUDE_CONFIG_DIR, then CLAUDE_HOME, then ~/.claude', () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/a', CLAUDE_HOME: '/b' }, '/h'), '/a');
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '', CLAUDE_HOME: '/b' }, '/h'), '/b');
    assert.equal(claudeConfigDir({}, '/h'), path.join('/h', '.claude'));
  });

  test('server reads sessions from $CLAUDE_CONFIG_DIR and config.json from the XDG/APPDATA path', async () => {
    const home = await makeHome();
    const xdg = await fs.mkdtemp(path.join(os.tmpdir(), 'quiet-office-xdg-'));
    await fs.mkdir(path.join(xdg, 'quiet-office'));
    await fs.writeFile(path.join(xdg, 'quiet-office', 'config.json'), JSON.stringify({ lang: 'ms', contextMax: 300000 }));
    await appendLines(transcriptPath(home, 'cfg1'), [assistantUsage({ input_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 })]);
    await writeSession(home, '1.json', sess('cfg1'));
    const env = { CLAUDE_CONFIG_DIR: home, CLAUDE_HOME: '/nonexistent', XDG_CONFIG_HOME: xdg, APPDATA: xdg };
    const opts = { port: 0, webDir: path.join(home, 'web'), log: () => {}, tracker: { tickMs: 40, slowEvery: 1, transcriptSearchMs: 0, homeDir: FAKE_HOME } };
    let srv = await startServer({ ...opts, env });
    try {
      const st = JSON.parse((await request(srv.port, { path: '/state' })).body);
      assert.deepEqual(st.agents.map((a) => a.name), ['cfg1']);
      assert.deepEqual(st.agents[0].context, { tokens: 1000, max: 300000 });
      const c = sse(srv.port);
      await c.ready;
      await waitFor(() => c.messages.length > 0, { label: 'snapshot' });
      assert.deepEqual(c.messages[0], { type: 'wallpaperConfig', reception: null, lang: 'ms' });
      c.close();
    } finally {
      await srv.stop();
    }
    // QUIET_OFFICE_CONTEXT_MAX wins over config.json.
    srv = await startServer({ ...opts, env: { ...env, QUIET_OFFICE_CONTEXT_MAX: '150000' } });
    try {
      const st = JSON.parse((await request(srv.port, { path: '/state' })).body);
      assert.deepEqual(st.agents[0].context, { tokens: 1000, max: 150000 });
    } finally {
      await srv.stop();
    }
  });
});

describe('config.json', () => {
  test('path per OS', () => {
    assert.equal(configPath({ platform: 'darwin', env: {}, homeDir: '/home/demo' }), '/home/demo/.config/quiet-office/config.json');
    assert.equal(configPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/cfg' }, homeDir: '/home/demo' }), '/x/cfg/quiet-office/config.json');
    assert.equal(configPath({ platform: 'linux', env: { XDG_CONFIG_HOME: 'relative' }, homeDir: '/home/demo' }), '/home/demo/.config/quiet-office/config.json');
    assert.equal(configPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' }, homeDir: 'C:\\Users\\demo' }), 'C:\\Users\\demo\\AppData\\Roaming\\quiet-office\\config.json');
    assert.equal(configPath({ platform: 'win32', env: {}, homeDir: 'C:\\Users\\demo' }), 'C:\\Users\\demo\\AppData\\Roaming\\quiet-office\\config.json');
  });

  test('parse: fields, wrong types fall back per field, invalid file = defaults', () => {
    const c = parseConfig(
      JSON.stringify({
        lang: 'ms',
        aliases: { 'chat-relay': ' Relay ', bad: 5, '': 'x' },
        reception: { agent: '  A reception agent name longer than the limit  ', channels: ['chat', ' chat ', 7, '', 'plugin:other:other'] },
        privacy: { default: true },
        contextMax: 500000.7,
      }),
    );
    assert.equal(c.lang, 'ms');
    assert.deepEqual([...c.aliases], [['chat-relay', 'Relay']]);
    assert.deepEqual(c.reception, { agent: 'A reception agent name l', channels: ['chat', 'plugin:other:other'] });
    assert.equal(c.contextMax, 500000);

    assert.equal(parseConfig(JSON.stringify({ lang: 'auto' })).lang, null);
    assert.equal(parseConfig(JSON.stringify({ lang: 'fr' })).lang, null);
    const wrong = parseConfig(JSON.stringify({ lang: 'en', aliases: ['x'], reception: { agent: 3, channels: 'chat' }, contextMax: -1 }));
    assert.deepEqual({ ...wrong, aliases: [...wrong.aliases] }, { lang: 'en', aliases: [], reception: { agent: null, channels: [] }, contextMax: undefined });
    for (const bad of ['{ not json', '[]', 'null', '"str"', '']) {
      assert.deepEqual(parseConfig(bad), defaultConfig(), bad);
    }
  });

  test('store: missing, reload on change, aliasGen only moves when aliases change, never written', async () => {
    const home = await makeHome();
    const file = configFile(home);
    const store = new ConfigStore(file);
    await store.refresh();
    assert.deepEqual(store.message(), { type: 'wallpaperConfig', reception: null, lang: null });
    await writeConfig(home, { aliases: { a: 'A' }, reception: { agent: 'A' }, lang: 'en' });
    await store.refresh();
    assert.deepEqual(store.message(), { type: 'wallpaperConfig', reception: 'A', lang: 'en' });
    assert.equal(store.aliasGen, 1);
    await writeConfig(home, { aliases: { a: 'A' }, lang: 'ms' });
    await store.refresh();
    assert.equal(store.aliasGen, 1);
    assert.deepEqual(store.message(), { type: 'wallpaperConfig', reception: null, lang: 'ms' });
    await writeConfig(home, '{ broken');
    await store.refresh();
    assert.deepEqual(store.message(), { type: 'wallpaperConfig', reception: null, lang: null });
    assert.equal(store.aliasGen, 2);
    await fs.rm(file);
    await store.refresh();
    assert.deepEqual(await fs.readdir(home).then((n) => n.includes('config.json')), false);
  });

  test('server: wallpaperConfig first in the snapshot, then on change only; aliases rename live', async () => {
    const home = await makeHome();
    await writeSession(home, '1.json', sess('chat-relay'));
    const srv = await start(home);
    const c = sse(srv.port);
    try {
      await c.ready;
      await waitFor(() => c.messages.some((m) => m.type === 'agentCreated'), { label: 'snapshot' });
      assert.deepEqual(c.messages[0], { type: 'wallpaperConfig', reception: null, lang: null });
      const types = c.messages.map((m) => m.type);
      assert.ok(types.indexOf('wallpaperConfig') < types.indexOf('existingAgents'));

      let n = c.messages.length;
      await writeConfig(home, { lang: 'en', reception: { agent: 'Relay' }, aliases: { 'chat-relay': 'Relay' } });
      await waitFor(() => c.since(n).some((m) => m.type === 'wallpaperConfig'), { label: 'config change' });
      await waitFor(() => c.since(n).some((m) => m.type === 'agentCreated'), { label: 'alias rename' });
      assert.deepEqual(c.since(n).filter((m) => m.type === 'wallpaperConfig'), [{ type: 'wallpaperConfig', reception: 'Relay', lang: 'en' }]);
      assert.equal(c.since(n).find((m) => m.type === 'agentCreated').directoryName, 'Relay');

      // Rewrite with the same wire values: no message.
      n = c.messages.length;
      await writeConfig(home, { lang: 'en', reception: { agent: 'Relay', channels: ['chat'] }, aliases: { 'chat-relay': 'Relay' } });
      await sleep(200);
      assert.equal(c.since(n).length, 0);

      // Invalid file: back to defaults.
      await writeConfig(home, '{ nope');
      await waitFor(() => c.since(n).some((m) => m.type === 'wallpaperConfig'), { label: 'invalid' });
      assert.deepEqual(c.since(n).find((m) => m.type === 'wallpaperConfig'), { type: 'wallpaperConfig', reception: null, lang: null });

      const late = sse(srv.port);
      await late.ready;
      await waitFor(() => late.messages.length > 0, { label: 'late' });
      assert.deepEqual(late.messages[0], { type: 'wallpaperConfig', reception: null, lang: null });
      late.close();
    } finally {
      c.close();
      await srv.stop();
    }
  });
});

describe('reception mail', () => {
  test('channel tag attributes are parsed structurally, body ignored', () => {
    assert.deepEqual(
      [...channelTagAttrs(`  <channel source="plugin:chat:chat" chat_id='c 1' flag user="a &amp; b">body source="evil"</channel>`)],
      [['source', 'plugin:chat:chat'], ['chat_id', 'c 1'], ['flag', ''], ['user', 'a & b']],
    );
    assert.deepEqual([...channelTagAttrs('<channel>x</channel>')], []);
    assert.equal(channelTagAttrs('<channelx source="a">'), null);
    assert.equal(channelTagAttrs('<channel source=plain>'), null);
    assert.equal(channelTagAttrs('<channel source="unterminated'), null);
    assert.equal(channelTagAttrs('hello <channel source="a">'), null);
    assert.equal(channelTagAttrs(`<channel ${'a="b" '.repeat(1000)}>`), null, 'tag longer than the scan cap');
    assert.equal(channelTagAttrs(42), null);
  });

  test('channels filter', () => {
    assert.equal(channelAllowed('plugin:chat:chat', []), true);
    assert.equal(channelAllowed(undefined, []), true);
    assert.equal(channelAllowed('plugin:chat:chat', ['chat']), true);
    assert.equal(channelAllowed('plugin:chat:chat', ['PLUGIN:chat:chat']), true);
    assert.equal(channelAllowed('plugin:chat:chat', ['other', 'plugin:x:y']), false);
    assert.equal(channelAllowed('plugin:chat:chat', ['hat']), false);
    assert.equal(channelAllowed(undefined, ['chat']), false);
  });

  test('mail only for the reception agent and allowed channels; no text on the wire or in logs', async () => {
    const home = await makeHome();
    await writeSession(home, '1.json', sess('chat-relay'));
    await writeSession(home, '2.json', sess('billing-service'));
    await appendLines(transcriptPath(home, 'chat-relay'), [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
    await appendLines(transcriptPath(home, 'billing-service'), [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
    const srv = await start(home);
    const c = sse(srv.port);
    try {
      await c.ready;
      await waitFor(() => c.messages.filter((m) => m.type === 'agentCreated').length === 2, { label: 'agents' });
      const idOf = (name) => c.messages.find((m) => m.type === 'agentCreated' && m.directoryName === name).id;

      // No reception agent configured: no mail at all.
      await appendLines(transcriptPath(home, 'chat-relay'), [enqueue(channel('plugin:chat:chat', 1))]);
      await sleep(200);
      assert.equal(mails(c).length, 0);

      await writeConfig(home, { aliases: { 'chat-relay': 'Relay' }, reception: { agent: 'relay', channels: ['chat'] } });
      await waitFor(() => c.messages.some((m) => m.type === 'agentCreated' && m.directoryName === 'Relay'), { label: 'alias' });
      const relay = idOf('Relay');
      await appendLines(transcriptPath(home, 'chat-relay'), [enqueue(channel('plugin:chat:chat', 2))]);
      await waitFor(() => mails(c).length === 1, { label: 'mail' });
      assert.deepEqual(mails(c), [{ type: 'wallpaperMail', id: relay }]);

      // Other channel, other agent: nothing.
      await appendLines(transcriptPath(home, 'chat-relay'), [enqueue(channel('plugin:other:other', 3))]);
      await appendLines(transcriptPath(home, 'billing-service'), [enqueue(channel('plugin:chat:chat', 4))]);
      await sleep(250);
      assert.equal(mails(c).length, 1);

      // Empty channels list = any channel.
      await writeConfig(home, { aliases: { 'chat-relay': 'Relay' }, reception: { agent: 'Relay' } });
      await sleep(150);
      await appendLines(transcriptPath(home, 'chat-relay'), [enqueue(channel('plugin:other:other', 5))]);
      await waitFor(() => mails(c).length === 2, { label: 'any channel' });
      assert.equal(mails(c).length, 2);

      assert.ok(!c.raw.includes('SECRET_BODY'));
      assert.ok(!srv.logs.join('\n').includes('SECRET_BODY'));
      assert.ok(!(await request(srv.port, { path: '/state' })).body.includes('SECRET_BODY'));
    } finally {
      c.close();
      await srv.stop();
    }
  });
});

describe('security headers', () => {
  test('on every response', async () => {
    const home = await makeHome();
    const web = path.join(home, 'web');
    await fs.mkdir(web, { recursive: true });
    await fs.writeFile(path.join(web, 'index.html'), '<!doctype html><title>t</title>');
    const srv = await start(home, web);
    try {
      const check = (h, label) => {
        assert.equal(h['content-security-policy'], CSP, label);
        assert.equal(h['cross-origin-resource-policy'], 'same-origin', label);
        assert.equal(h['referrer-policy'], 'no-referrer', label);
        assert.equal(h['x-content-type-options'], 'nosniff', label);
        assert.equal(h['access-control-allow-origin'], undefined, label);
      };
      const cases = [
        [{ path: '/' }, 200],
        [{ path: '/', method: 'HEAD' }, 200],
        [{ path: '/healthz' }, 200],
        [{ path: '/state' }, 200],
        [{ path: '/missing' }, 404],
        [{ path: '/', method: 'POST' }, 405],
        [{ path: '/', host: 'evil.com' }, 403],
      ];
      for (const [req, status] of cases) {
        const r = await request(srv.port, req);
        assert.equal(r.status, status, JSON.stringify(req));
        check(r.headers, JSON.stringify(req));
      }
      const c = sse(srv.port);
      check((await c.ready).headers, '/events');
      c.close();
      assert.equal(SECURITY_HEADERS['Content-Security-Policy'], CSP);
    } finally {
      await srv.stop();
    }
  });
});

describe('ghost guard (pid reuse)', () => {
  const T = Date.UTC(2026, 10, 13, 9, 10, 38);

  test('recorded start formats', () => {
    assert.deepEqual(recordedStart({ procStart: 'Fri Nov 13 09:10:38 2026' }, 'darwin'), { ms: T });
    assert.deepEqual(recordedStart({ procStart: 'Thu Nov  5 01:02:03 2026' }, 'linux'), { ms: Date.UTC(2026, 10, 5, 1, 2, 3) });
    const ft = String((T + 11_644_473_600_000) * 1e4);
    assert.deepEqual(recordedStart({ procStartFt: ft }, 'win32'), { ms: T });
    assert.deepEqual(recordedStart({ procStartFt: String(T * 1e6) }, 'win32'), { ms: T });
    assert.deepEqual(recordedStart({ procStartFt: String(T) }, 'win32'), { ms: T });
    // Windows prefers procStartFt; other OSes prefer procStart.
    assert.deepEqual(recordedStart({ procStart: 'Fri Nov 13 09:10:38 2026', procStartFt: String(T + 5e6) }, 'win32'), { ms: T + 5e6 });
    assert.deepEqual(recordedStart({ procStart: 'Fri Nov 13 09:10:38 2026', procStartFt: String(T + 5e6) }, 'darwin'), { ms: T });
    assert.deepEqual(recordedStart({ procStart: '123456' }, 'linux'), { ticks: 123456 });
    assert.equal(recordedStart({ procStart: '123456' }, 'darwin'), undefined);
    for (const bad of [undefined, '', 'yesterday', 'Fri Nov 13 09:10:38 1970', {}, null]) {
      assert.equal(recordedStart({ procStart: bad }, 'darwin'), undefined, String(bad));
    }
  });

  test('verdicts, one read per pid, retry after a failed read, prune when gone', async () => {
    let clock = 1000;
    const calls = [];
    const times = new Map([
      [11, { ms: T + 1200 }],
      [12, { ms: T + 3600_000 }],
    ]);
    const guard = new StartTimeGuard({
      platform: 'darwin',
      now: () => clock,
      retryMs: 500,
      readStartTimes: async (pids) => {
        calls.push(pids);
        return new Map(pids.filter((p) => times.has(p)).map((p) => [p, times.get(p)]));
      },
    });
    const rec = 'Fri Nov 13 09:10:38 2026';
    const same = { pid: 11, procStart: rec, sessionId: 'same' };
    const reused = { pid: 12, procStart: rec, sessionId: 'reused' };
    const unknown = { pid: 13, procStart: rec, sessionId: 'unknown' };
    const none = { pid: 14, sessionId: 'none' };
    const ids = async (list) => (await guard.filter(list)).map((s) => s.sessionId).sort();

    assert.deepEqual(await ids([same, reused, unknown, none]), ['none', 'same', 'unknown']);
    assert.deepEqual(calls, [[11, 12, 13]]);
    assert.deepEqual(await ids([same, reused, unknown, none]), ['none', 'same', 'unknown']);
    assert.equal(calls.length, 1, 'cached');
    clock += 600;
    times.set(13, { ms: T - 60_000 });
    assert.deepEqual(await ids([same, reused, unknown, none]), ['none', 'same']);
    assert.deepEqual(calls[1], [13], 'only the failed read is retried');
    // The reused pid leaves the list (dead), then a new Claude session takes it: read again.
    await guard.filter([same]);
    assert.deepEqual(await ids([same, { pid: 12, procStart: 'Fri Nov 13 10:10:38 2026', sessionId: 'new' }]), ['new', 'same']);
    assert.deepEqual(calls.at(-1), [12]);
    // A reader that throws gives no verdict.
    const broken = new StartTimeGuard({ platform: 'darwin', readStartTimes: async () => { throw new Error('x'); } });
    assert.deepEqual((await broken.filter([reused])).map((s) => s.sessionId), ['reused']);
  });

  test('Linux tick values compare exactly', async () => {
    const guard = new StartTimeGuard({ platform: 'linux', readStartTimes: async () => new Map([[5, { ticks: 777, ms: T }]]) });
    assert.equal((await guard.filter([{ pid: 5, procStart: '777' }])).length, 1);
    const guard2 = new StartTimeGuard({ platform: 'linux', readStartTimes: async () => new Map([[5, { ticks: 778, ms: T }]]) });
    assert.equal((await guard2.filter([{ pid: 5, procStart: '777' }])).length, 0);
  });

  test('tracker: a live pid with a different start time is not an agent', async () => {
    const home = await makeHome();
    const now = Date.now();
    const calls = [];
    const readStartTimes = async (pids) => {
      calls.push(pids);
      return new Map(pids.map((p) => [p, { ms: now }]));
    };
    await writeSession(home, '1.json', sess('alpha', { procStart: lstart(now) }));
    await writeSession(home, '2.json', sess('beta', { procStart: lstart(now - 3600_000) }));
    await writeSession(home, '3.json', sess('notes-app'));
    const srv = await start(home, undefined, { readStartTimes, platform: 'darwin' });
    try {
      await sleep(200);
      const st = JSON.parse((await request(srv.port, { path: '/state' })).body);
      assert.deepEqual(st.agents.map((a) => a.name).sort(), ['alpha', 'notes-app']);
      assert.equal(calls.length, 1, 'one read for the batch, then cached');
      assert.ok(srv.logs.some((l) => l.startsWith('[quiet-office] session pid ')));
    } finally {
      await srv.stop();
    }
  });

  test('real reader on this OS reads our own start time, as Claude Code records it', async () => {
    const reader = defaultStartTimeReader();
    const started = Date.now() - process.uptime() * 1000;
    const got = (await reader([process.pid])).get(process.pid);
    assert.ok(got && Number.isFinite(got.ms), `no start time for pid ${process.pid} on ${process.platform}`);
    assert.ok(Math.abs(got.ms - started) < 10_000, `start ${got.ms} vs ${started}`);
    const guard = new StartTimeGuard();
    assert.equal((await guard.filter([{ pid: process.pid, procStart: lstart(started), procStartFt: String(Math.round((started + 11_644_473_600_000) * 1e4)) }])).length, 1);
    assert.equal((await new StartTimeGuard().filter([{ pid: process.pid, procStart: lstart(started - 86_400_000), procStartFt: String(Math.round((started - 86_400_000 + 11_644_473_600_000) * 1e4)) }])).length, 0);
  });
});
