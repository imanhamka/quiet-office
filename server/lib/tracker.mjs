import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { channelAllowed, channelTagAttrs } from './channel.mjs';
import { ConfigStore } from './config.mjs';
import { computeName } from './naming.mjs';
import { StartTimeGuard } from './procstart.mjs';
import { DayStats } from './stats.mjs';
import { formatToolStatus, isSubagentTool, READING_TOOLS, SUBAGENT_TOOLS, subtaskStatus } from './status.mjs';
import { TailReader } from './tail.mjs';

const CONTEXT_MAX_DEFAULT = 200_000;
const CONTEXT_MAX_1M = 1_000_000;
const FINISHED_CAP = 5000;
const ASYNC_LAUNCH_PREFIX = 'Async agent launched successfully.';
const SUBAGENT_FILE = /^agent-[A-Za-z0-9_-]+\.jsonl$/;
const INTERIM_NOTICE = /is waiting on its own background work|\bmay be interim\b/;

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

export function deriveMode(session) {
  const status = session.status;
  if (status === 'busy') return 'active';
  if (status === 'waiting') {
    const w = typeof session.waitingFor === 'string' ? session.waitingFor.trim().toLowerCase() : '';
    if (w.includes('permission') || w.startsWith('approve')) return 'permission';
    return 'input';
  }
  return 'idle';
}

function statusSince(session) {
  return Number.isFinite(session.statusUpdatedAt) && session.statusUpdatedAt > 0 ? session.statusUpdatedAt : undefined;
}

function usageTokens(u) {
  if (!u || typeof u !== 'object') return 0;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
}

// Candidate for the latest main-chain usage; parsed only when it is the newest in a batch.
function mayHaveUsage(line) {
  return line.includes('"usage":') && line.includes('"type":"assistant"');
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
    }
  }
  return '';
}

// Cheap pre-filter: skip JSON.parse for lines that cannot carry a tool event.
function mayMatter(line) {
  return line.includes('"tool_use') || line.includes('"tool_result') || line.includes('queue-operation');
}

function parseLine(line) {
  if (!mayMatter(line)) return null;
  try {
    const rec = JSON.parse(line);
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

async function readMeta(file) {
  try {
    const st = await fs.stat(file);
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data && typeof data === 'object' ? { data, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

function addCapped(set, value) {
  set.delete(value);
  set.add(value);
  if (set.size > FINISHED_CAP) set.delete(set.values().next().value);
}

export class Tracker {
  constructor(opts = {}) {
    this.claudeDir = opts.claudeDir;
    this.emit = opts.emit || (() => {});
    this.log = opts.log || ((...a) => console.log(...a));
    this.tickMs = opts.tickMs ?? 750;
    this.slowEvery = opts.slowEvery ?? 2;
    this.tailBytes = opts.tailBytes ?? 256 * 1024;
    this.subagentIdleMs = opts.subagentIdleMs ?? 60_000;
    this.subagentMaxAgeMs = opts.subagentMaxAgeMs ?? 10 * 60_000;
    this.transcriptSearchMs = opts.transcriptSearchMs ?? 2000;
    this.now = opts.now || Date.now;
    this.isAlive = opts.isAlive || isPidAlive;
    this.homeDir = opts.homeDir || os.homedir();
    // Explicit contextMax (env QUIET_OFFICE_CONTEXT_MAX) wins over config.json.
    this.contextMaxOverride = Number.isFinite(opts.contextMax) && opts.contextMax > 0 ? opts.contextMax : undefined;
    this.config = new ConfigStore(opts.configFile ?? null);
    this.configKey = JSON.stringify(this.config.message());
    this.startGuard = new StartTimeGuard({
      platform: opts.platform,
      readStartTimes: opts.readStartTimes,
      now: this.now,
      onReused: (pid) => this.log(`[quiet-office] session pid ${pid} skipped: the pid now belongs to another process`),
    });

    this.agents = new Map(); // sessionId -> agent
    this.ids = new Map(); // sessionId -> stable small integer
    this.nextId = 1;
    this.tickCount = 0;
    this.running = false;
    this.timer = null;
    this.errorsSeen = new Set();
    this.stats = new DayStats({
      projectsDir: this.projectsDir,
      now: this.now,
      scanMs: opts.statsScanMs ?? 60_000,
      onChange: (msg) => this.emit(msg),
      logError: (where, err) => this.logError(where, err),
    });
  }

  get sessionsDir() {
    return path.join(this.claudeDir, 'sessions');
  }

  get projectsDir() {
    return path.join(this.claudeDir, 'projects');
  }

  get contextMax() {
    return this.contextMaxOverride ?? this.config.config.contextMax ?? CONTEXT_MAX_DEFAULT;
  }

  async start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    await this.stats.scan().catch((err) => this.logError('stats scan', err));
    return this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One error line per distinct (where, code) so a broken file cannot flood stdout.
  logError(where, err) {
    const key = `${where}:${err && err.code ? err.code : err && err.message}`;
    if (this.errorsSeen.has(key)) return;
    this.errorsSeen.add(key);
    this.log(`[quiet-office] error ${where}: ${err && err.code ? err.code : err && err.message}`);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const slow = this.tickCount % this.slowEvery === 0;
      this.tickCount++;
      this.stats.tick();
      if (slow) await this.pollSessions();
      for (const agent of this.agents.values()) {
        await this.pollTranscript(agent);
        if (slow) {
          await this.discoverSubagents(agent);
          await this.checkMeta(agent);
        }
        await this.pollSubagents(agent);
      }
    } catch (err) {
      this.logError('tick', err);
    } finally {
      this.running = false;
    }
  }

  send(agent, msg) {
    if (agent.announced) this.emit(msg);
  }

  // ── sessions ────────────────────────────────────────────────────────────

  async readSessions() {
    let names;
    try {
      names = await fs.readdir(this.sessionsDir);
    } catch (err) {
      if (err.code !== 'ENOENT') this.logError('sessions dir', err);
      return new Map();
    }
    const alive = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let s;
      try {
        s = JSON.parse(await fs.readFile(path.join(this.sessionsDir, name), 'utf8'));
      } catch {
        continue; // mid-write or removed between readdir and read
      }
      if (!s || typeof s.sessionId !== 'string' || !s.sessionId) continue;
      if (this.isAlive(s.pid)) alive.push(s);
    }
    const live = new Map();
    for (const s of await this.startGuard.filter(alive)) {
      const prev = live.get(s.sessionId);
      if (prev && (prev.updatedAt || 0) >= (s.updatedAt || 0)) continue;
      live.set(s.sessionId, s);
    }
    return live;
  }

  async pollSessions() {
    await this.config.refresh();
    const configMsg = this.config.message();
    const configKey = JSON.stringify(configMsg);
    if (configKey !== this.configKey) {
      this.configKey = configKey;
      this.emit(configMsg);
    }
    const live = await this.readSessions();
    for (const [sessionId, agent] of this.agents) {
      if (!live.has(sessionId)) this.closeAgent(agent);
    }
    for (const [sessionId, session] of live) {
      const agent = this.agents.get(sessionId);
      if (agent) {
        this.maybeRename(agent, session);
        agent.statusSince = statusSince(session);
        this.applyMode(agent, deriveMode(session));
      } else {
        await this.createAgent(session);
      }
    }
  }

  nameFor(session) {
    return computeName(session, { homeDir: this.homeDir, aliases: this.config.aliases });
  }

  // directoryName is fixed at agentCreated, so a rename re-announces the
  // session under a new id. Derived names stay put unless the aliases changed.
  maybeRename(agent, session) {
    const aliasChanged = agent.aliasGen !== this.config.aliasGen;
    agent.aliasGen = this.config.aliasGen;
    if (session.nameSource === 'derived' && !aliasChanged) return;
    const name = this.nameFor(session);
    if (name === agent.name) return;
    const prev = agent.name;
    if (agent.announced) {
      this.emit({ type: 'agentToolsClear', id: agent.id });
      this.emit({ type: 'agentClosed', id: agent.id });
    }
    agent.id = this.nextId++;
    this.ids.set(agent.sessionId, agent.id);
    agent.name = name;
    this.log(`[quiet-office] agent renamed #${agent.id} ${prev} -> ${name}`);
    if (agent.announced) for (const msg of this.agentMessages(agent)) this.emit(msg);
  }

  async createAgent(session) {
    let id = this.ids.get(session.sessionId);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(session.sessionId, id);
    }
    const agent = {
      id,
      sessionId: session.sessionId,
      name: this.nameFor(session),
      aliasGen: this.config.aliasGen,
      mode: deriveMode(session),
      statusSince: statusSince(session),
      ctx: null, // { tokens, max } from the latest main-chain usage
      ctxKey: '',
      ctx1m: false,
      announced: false,
      tools: new Map(), // toolId -> { status, toolName, runInBackground }
      finished: new Set(), // tool ids whose result was seen
      asyncSpawns: new Set(), // spawn tool ids launched in background
      transcript: null,
      reader: null,
      nextSearchAt: 0,
      subs: new Map(), // file -> sub
      skippedSubs: new Map(), // file -> next recheck time
    };
    this.agents.set(agent.sessionId, agent);
    await this.findTranscript(agent);
    if (agent.reader) await this.readMain(agent);
    if (agent.mode === 'idle') this.dropTools(agent);
    agent.announced = true;
    this.log(`[quiet-office] agent created #${id} ${agent.name}`);
    for (const msg of this.agentMessages(agent)) this.emit(msg);
  }

  closeAgent(agent) {
    this.agents.delete(agent.sessionId);
    if (!agent.announced) return;
    this.emit({ type: 'agentToolsClear', id: agent.id });
    this.emit({ type: 'agentClosed', id: agent.id });
    this.log(`[quiet-office] agent closed #${agent.id} ${agent.name}`);
  }

  applyMode(agent, mode) {
    if (agent.mode === mode) return;
    const prev = agent.mode;
    agent.mode = mode;
    if (prev === 'permission') this.send(agent, { type: 'agentToolPermissionClear', id: agent.id });
    switch (mode) {
      case 'active':
        this.send(agent, { type: 'agentStatus', id: agent.id, status: 'active' });
        break;
      case 'idle':
        this.dropTools(agent);
        this.send(agent, { type: 'agentToolsClear', id: agent.id });
        this.send(agent, this.statusMessage(agent));
        break;
      case 'permission':
        this.send(agent, this.permissionMessage(agent));
        break;
      case 'input':
        this.send(agent, this.statusMessage(agent));
        break;
    }
  }

  statusMessage(agent) {
    const msg = { type: 'agentStatus', id: agent.id, status: agent.mode === 'idle' || agent.mode === 'input' ? 'waiting' : 'active' };
    if (agent.mode === 'input') msg.awaitingInput = true;
    if (msg.status === 'waiting' && agent.statusSince !== undefined) msg.waitingSince = agent.statusSince;
    return msg;
  }

  permissionMessage(agent) {
    const msg = { type: 'agentToolPermission', id: agent.id };
    if (agent.statusSince !== undefined) msg.waitingSince = agent.statusSince;
    return msg;
  }

  // Mirrors the webview's agentToolsClear: tools go, foreground sub-agents go,
  // background sub-agents survive the parent's turn end.
  dropTools(agent) {
    agent.tools.clear();
    for (const sub of agent.subs.values()) {
      if (sub.state === 'live' && !agent.asyncSpawns.has(sub.parentToolId)) {
        sub.state = 'idle';
        sub.tools.clear();
      }
    }
  }

  // ── main transcript ─────────────────────────────────────────────────────

  async findTranscript(agent) {
    if (agent.transcript) return;
    const now = this.now();
    if (now < agent.nextSearchAt) return;
    agent.nextSearchAt = now + this.transcriptSearchMs;
    let dirs;
    try {
      dirs = await fs.readdir(this.projectsDir);
    } catch (err) {
      if (err.code !== 'ENOENT') this.logError('projects dir', err);
      return;
    }
    const want = `${agent.sessionId}.jsonl`;
    for (const d of dirs) {
      const p = path.join(this.projectsDir, d, want);
      try {
        const st = await fs.stat(p);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      agent.transcript = p;
      agent.reader = new TailReader(p, { tailBytes: this.tailBytes });
      return;
    }
  }

  async pollTranscript(agent) {
    if (!agent.reader) {
      await this.findTranscript(agent);
      if (!agent.reader) return;
      // First sight after announce: parse the tail silently, then publish open tools.
      agent.announced = false;
      await this.readMain(agent);
      agent.announced = true;
      if (agent.mode === 'idle') {
        this.dropTools(agent);
      } else {
        for (const msg of this.toolMessages(agent)) this.emit(msg);
      }
      const ctx = this.contextMessage(agent);
      if (ctx) this.emit(ctx);
      return;
    }
    await this.readMain(agent);
  }

  async readMain(agent) {
    let lines;
    try {
      lines = await agent.reader.poll();
    } catch (err) {
      if (err.code === 'ENOENT') {
        agent.reader = null;
        agent.transcript = null;
        return;
      }
      this.logError('transcript read', err);
      return;
    }
    this.stats.noteSession(agent.sessionId, agent.reader.mtimeMs);
    let usageAt = -1;
    for (let i = 0; i < lines.length; i++) {
      if (mayHaveUsage(lines[i])) usageAt = i;
      try {
        this.onMainLine(agent, lines[i]);
      } catch (err) {
        this.logError('transcript line', err);
      }
    }
    if (usageAt >= 0) this.scanUsage(agent, lines, usageAt);
  }

  // Newest main-chain assistant usage in this batch. Older candidates are only
  // parsed when a newer one turns out not to qualify.
  scanUsage(agent, lines, from) {
    for (let i = from; i >= 0; i--) {
      if (!mayHaveUsage(lines[i])) continue;
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!rec || rec.type !== 'assistant' || rec.isSidechain === true) continue;
      const m = rec.message;
      const u = m && m.usage;
      if (!u || typeof u !== 'object') continue;
      const tokens = usageTokens(u);
      if (tokens === 0 && !(Number.isFinite(u.output_tokens) && u.output_tokens > 0)) continue; // synthetic all-zero record
      const model = `${typeof m.model === 'string' ? m.model : ''} ${typeof rec.requestedModel === 'string' ? rec.requestedModel : ''}`;
      this.setContext(agent, tokens, model.includes('[1m]'));
      return;
    }
  }

  setContext(agent, tokens, is1m) {
    if (is1m || tokens > this.contextMax) agent.ctx1m = true;
    const max = agent.ctx1m ? Math.max(this.contextMax, CONTEXT_MAX_1M) : this.contextMax;
    agent.ctx = { tokens, max };
    const key = `${max}:${Math.floor((tokens * 100) / max)}`;
    if (key === agent.ctxKey) return;
    agent.ctxKey = key;
    this.send(agent, this.contextMessage(agent));
  }

  contextMessage(agent) {
    if (!agent.ctx) return null;
    return { type: 'agentContextUsage', id: agent.id, contextTokens: agent.ctx.tokens, maxContextTokens: agent.ctx.max };
  }

  onMainLine(agent, line) {
    const rec = parseLine(line);
    if (!rec || rec.isSidechain === true) return;
    const content = rec.message && rec.message.content;
    if (rec.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_use' && typeof block.id === 'string') this.startTool(agent, block);
      }
    } else if (rec.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          this.finishTool(agent, block.tool_use_id, block.content, block.is_error === true);
        }
      }
    } else if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string') {
      // Each inbound channel message (e.g. a chat channel plugin) is enqueued exactly once, whether
      // it is then delivered as a user turn or mid-turn. Only the id goes on the wire.
      const attrs = channelTagAttrs(rec.content);
      if (attrs) {
        if (this.isReceptionMail(agent, attrs.get('source'))) this.send(agent, { type: 'wallpaperMail', id: agent.id });
        return;
      }
      // Background sub-agent completion notices.
      for (const notice of rec.content.split('<task-notification>')) {
        if (INTERIM_NOTICE.test(notice)) continue;
        for (const m of notice.matchAll(/<tool-use-id>(.*?)<\/tool-use-id>/g)) this.finishSpawn(agent, m[1]);
      }
    }
  }

  // Mail goes to the configured reception agent only, for the configured channels (any when empty).
  isReceptionMail(agent, source) {
    const { agent: want, channels } = this.config.reception;
    if (!want || agent.name.toLowerCase() !== want.toLowerCase()) return false;
    return channelAllowed(source, channels);
  }

  startTool(agent, block) {
    if (agent.tools.has(block.id) || agent.finished.has(block.id)) return;
    const toolName = typeof block.name === 'string' ? block.name : '';
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    const runInBackground = isSubagentTool(toolName) && input.run_in_background === true;
    if (runInBackground) agent.asyncSpawns.add(block.id);
    const typed = isSubagentTool(toolName) && typeof input.subagent_type === 'string' && input.subagent_type.trim() !== '';
    const tool = { status: formatToolStatus(toolName, input), toolName, runInBackground, typed };
    agent.tools.set(block.id, tool);
    this.send(agent, this.toolStartMessage(agent, block.id, tool));
  }

  finishTool(agent, toolId, content, isError = false) {
    addCapped(agent.finished, toolId);
    const tool = agent.tools.get(toolId);
    if (tool) {
      agent.tools.delete(toolId);
      const msg = { type: 'agentToolDone', id: agent.id, toolId };
      if (isError) msg.error = true;
      this.send(agent, msg);
    }
    if (resultText(content).trimStart().startsWith(ASYNC_LAUNCH_PREFIX)) {
      agent.asyncSpawns.add(toolId);
      return;
    }
    if (agent.asyncSpawns.has(toolId)) return;
    this.clearSubsFor(agent, toolId, 'done');
  }

  finishSpawn(agent, toolId) {
    agent.asyncSpawns.delete(toolId);
    addCapped(agent.finished, toolId);
    if (agent.tools.delete(toolId)) this.send(agent, { type: 'agentToolDone', id: agent.id, toolId });
    this.clearSubsFor(agent, toolId, 'done');
  }

  clearSubsFor(agent, parentToolId, state) {
    for (const sub of agent.subs.values()) {
      if (sub.parentToolId === parentToolId) this.clearSub(agent, sub, state);
    }
  }

  clearSub(agent, sub, state) {
    const wasLive = sub.state === 'live';
    sub.state = state;
    sub.tools.clear();
    if (state === 'done') sub.reader = null;
    if (wasLive && !sub.silent) this.send(agent, { type: 'subagentClear', id: agent.id, parentToolId: sub.parentToolId });
  }

  // ── sub-agents ──────────────────────────────────────────────────────────

  async discoverSubagents(agent) {
    if (!agent.transcript) return;
    const dir = path.join(path.dirname(agent.transcript), agent.sessionId, 'subagents');
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') this.logError('subagents dir', err);
      return;
    }
    const now = this.now();
    for (const name of names) {
      if (!SUBAGENT_FILE.test(name)) continue;
      const file = path.join(dir, name);
      if (agent.subs.has(file)) continue;
      const recheck = agent.skippedSubs.get(file);
      if (recheck !== undefined && now < recheck) continue;
      let st;
      try {
        st = await fs.stat(file);
      } catch {
        continue;
      }
      this.stats.noteSubagent(file, st);
      if (now - st.mtimeMs > this.subagentMaxAgeMs) {
        agent.skippedSubs.set(file, now + 30_000);
        continue;
      }
      const metaFile = file.replace(/\.jsonl$/, '.meta.json');
      const meta = await readMeta(metaFile);
      if (!meta) continue; // meta may land slightly after the transcript; retry next poll
      agent.skippedSubs.delete(file);
      const parentToolId = typeof meta.data.toolUseId === 'string' ? meta.data.toolUseId : '';
      const sub = {
        file,
        metaFile,
        metaMtime: meta.mtimeMs,
        parentToolId,
        state: 'live',
        tools: new Map(),
        reader: new TailReader(file, { tailBytes: this.tailBytes }),
        lastMtime: st.mtimeMs,
        silent: false,
      };
      agent.subs.set(file, sub);
      this.labelSpawn(agent, parentToolId, meta.data.agentType);
      if (
        !parentToolId ||
        meta.data.finished === true ||
        (agent.finished.has(parentToolId) && !agent.asyncSpawns.has(parentToolId))
      ) {
        sub.state = 'done';
        sub.reader = null;
        continue;
      }
      // Parse the tail silently, then publish its open tools.
      sub.silent = true;
      await this.readSub(agent, sub);
      sub.silent = false;
      if (sub.state === 'done') continue;
      if (now - sub.lastMtime > this.subagentIdleMs) {
        sub.state = 'idle';
        sub.tools.clear();
        continue;
      }
      for (const [toolId, status] of sub.tools) {
        this.send(agent, { type: 'subagentToolStart', id: agent.id, parentToolId, toolId, status });
      }
    }
  }

  // The spawn's own input names the agent type when the model passed one;
  // otherwise the meta file does, a little later. Snapshots pick it up.
  labelSpawn(agent, parentToolId, agentType) {
    const tool = agent.tools.get(parentToolId);
    if (!tool || tool.typed || typeof agentType !== 'string' || !agentType.trim()) return;
    tool.status = subtaskStatus(agentType);
    tool.typed = true;
  }

  // Re-read a sub-agent's meta when it changes: `finished: true` is the done signal.
  async checkMeta(agent) {
    for (const sub of agent.subs.values()) {
      if (sub.state === 'done') continue;
      let mtimeMs;
      try {
        mtimeMs = (await fs.stat(sub.metaFile)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs === sub.metaMtime) continue;
      const meta = await readMeta(sub.metaFile);
      if (!meta) continue;
      sub.metaMtime = meta.mtimeMs;
      this.labelSpawn(agent, sub.parentToolId, meta.data.agentType);
      if (meta.data.finished === true) this.clearSub(agent, sub, 'done');
    }
  }

  async pollSubagents(agent) {
    const now = this.now();
    for (const sub of agent.subs.values()) {
      if (sub.state === 'done' || !sub.reader) continue;
      const before = sub.reader.mtimeMs;
      await this.readSub(agent, sub);
      if (!sub.reader) continue;
      if (sub.reader.mtimeMs !== before) sub.lastMtime = sub.reader.mtimeMs;
      if (sub.state === 'live' && now - sub.lastMtime > this.subagentIdleMs) {
        this.clearSub(agent, sub, 'idle');
      }
    }
  }

  async readSub(agent, sub) {
    let lines;
    try {
      lines = await sub.reader.poll();
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.clearSub(agent, sub, 'done');
        return;
      }
      this.logError('subagent read', err);
      return;
    }
    for (const line of lines) {
      try {
        this.onSubLine(agent, sub, line);
      } catch (err) {
        this.logError('subagent line', err);
      }
    }
  }

  onSubLine(agent, sub, line) {
    const rec = parseLine(line);
    if (!rec) return;
    const content = rec.message && rec.message.content;
    if (!Array.isArray(content)) return;
    const quiet = sub.silent === true;
    if (rec.type === 'assistant') {
      for (const block of content) {
        if (!block || block.type !== 'tool_use' || typeof block.id !== 'string') continue;
        if (sub.tools.has(block.id)) continue;
        // A timed-out sub that starts working again comes back; the webview recreates it lazily.
        if (!quiet && sub.state === 'idle') sub.state = 'live';
        const status = formatToolStatus(block.name, block.input);
        sub.tools.set(block.id, status);
        if (!quiet) {
          this.send(agent, { type: 'subagentToolStart', id: agent.id, parentToolId: sub.parentToolId, toolId: block.id, status });
        }
      }
    } else if (rec.type === 'user') {
      for (const block of content) {
        if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const toolId = block.tool_use_id;
        if (sub.tools.delete(toolId) && !quiet) {
          this.send(agent, { type: 'subagentToolDone', id: agent.id, parentToolId: sub.parentToolId, toolId });
        }
        // Nested spawn finished inside this sub-agent.
        if (!resultText(block.content).trimStart().startsWith(ASYNC_LAUNCH_PREFIX)) {
          for (const other of agent.subs.values()) {
            if (other !== sub && other.parentToolId === toolId) this.clearSub(agent, other, 'done');
          }
        }
      }
    }
  }

  // ── snapshot ────────────────────────────────────────────────────────────

  toolStartMessage(agent, toolId, tool) {
    const msg = { type: 'agentToolStart', id: agent.id, toolId, status: tool.status, toolName: tool.toolName };
    if (agent.mode === 'permission') msg.permissionActive = true;
    if (tool.runInBackground) msg.runInBackground = true;
    return msg;
  }

  toolMessages(agent) {
    const out = [];
    for (const [toolId, tool] of agent.tools) out.push(this.toolStartMessage(agent, toolId, tool));
    for (const sub of agent.subs.values()) {
      if (sub.state !== 'live') continue;
      for (const [toolId, status] of sub.tools) {
        out.push({ type: 'subagentToolStart', id: agent.id, parentToolId: sub.parentToolId, toolId, status });
      }
    }
    return out;
  }

  agentMessages(agent) {
    const id = agent.id;
    const out = [{ type: 'agentCreated', id, directoryName: agent.name, isExternal: true }, this.statusMessage(agent)];
    out.push(...this.toolMessages(agent));
    if (agent.mode === 'permission') out.push(this.permissionMessage(agent));
    const ctx = this.contextMessage(agent);
    if (ctx) out.push(ctx);
    return out;
  }

  announcedAgents() {
    return [...this.agents.values()].filter((a) => a.announced).sort((a, b) => a.id - b.id);
  }

  snapshot() {
    const agents = this.announcedAgents();
    const directoryNames = {};
    const externalAgents = {};
    for (const a of agents) {
      directoryNames[a.id] = a.name;
      externalAgents[a.id] = true;
    }
    const out = [
      this.config.message(),
      { type: 'providerCapabilities', readingTools: [...READING_TOOLS], subagentToolNames: [...SUBAGENT_TOOLS] },
      { type: 'existingAgents', agents: agents.map((a) => a.id), agentMeta: {}, directoryNames, externalAgents },
    ];
    for (const a of agents) out.push(...this.agentMessages(a));
    out.push(this.stats.message());
    return out;
  }

  debugState() {
    return {
      agents: this.announcedAgents().map((a) => ({
        id: a.id,
        name: a.name,
        mode: a.mode,
        // ms epoch the current wait started (permission/input only), for the host's menu.
        waitingSince: (a.mode === 'permission' || a.mode === 'input') && a.statusSince !== undefined ? a.statusSince : null,
        transcriptFound: !!a.transcript,
        context: a.ctx ? { ...a.ctx } : null,
        tools: [...a.tools].map(([toolId, t]) => ({ toolId, toolName: t.toolName, status: t.status, runInBackground: t.runInBackground })),
        subagents: [...a.subs.values()]
          .filter((s) => s.state === 'live')
          .map((s) => ({ parentToolId: s.parentToolId, tools: [...s.tools].map(([toolId, status]) => ({ toolId, status })) })),
      })),
      today: this.stats.today(),
    };
  }
}
