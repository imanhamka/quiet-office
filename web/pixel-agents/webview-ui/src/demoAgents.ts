// quiet-office: `?demo=1` — twelve fake agents (one with four sub-agents) through the real transport, for
// checks and screenshots without the wallpaper server. Combine with ?wallpaper=1 to see the wallpaper.
// Deterministic: fixed agents, tools and context; only waitingSince is relative to now.
// Every name here is made up: the demo never shows a real session.

import type { ServerMessage } from '../../core/src/messages.js';
import { sseTransport } from './transport/index.js';

type Mode = 'active' | 'permission' | 'input' | 'idle';

interface DemoAgent {
  id: number;
  dir: string;
  mode: Mode;
  tool?: { name: string; status: string };
  /** Share of a 200k context used. */
  ctx?: number;
  /** Seconds since the wait began (permission / input). */
  waitedSec?: number;
}

const CONTEXT_MAX = 200_000;

const SUBAGENTS: Array<{ type: string; status: string }> = [
  { type: 'Explore', status: 'Searching files' },
  { type: 'general-purpose', status: 'Editing main.tf' },
  { type: 'web-fetch', status: 'Fetching web content' },
  { type: 'Plan', status: 'Reading README.md' },
];
/** Index of the sub-agent that leaves after ~20 s (web-fetch). */
const SUB_LEAVES = 2;
/** The demo's reception agent (the server sends `wallpaperConfig.reception` from config.json). */
const RECEPTION = 'Relay';

const AGENTS: DemoAgent[] = [
  {
    id: 9001,
    dir: 'api-gateway',
    mode: 'active',
    tool: { name: 'Read', status: 'Reading routes.ts' },
    ctx: 0.3,
  },
  {
    id: 9002,
    dir: 'billing-service',
    mode: 'active',
    tool: { name: 'Edit', status: 'Editing invoiceScheduler.ts' },
    ctx: 0.7,
  },
  { id: 9003, dir: 'mobile-app', mode: 'active', tool: { name: 'Bash', status: 'Running command' } },
  {
    id: 9004,
    dir: 'acme-sso-server-laravel',
    mode: 'permission',
    tool: { name: 'Bash', status: 'Running command' },
    ctx: 0.9,
    waitedSec: 120,
  },
  { id: 9005, dir: 'docs-site', mode: 'input', waitedSec: 35 },
  { id: 9006, dir: 'infra', mode: 'active' },
  { id: 9007, dir: 'blog', mode: 'active' },
  { id: 9008, dir: 'dotfiles', mode: 'active', tool: { name: 'Grep', status: 'Searching code' } },
  { id: 9009, dir: 'notes-app', mode: 'idle' },
  // The server applies config.json aliases, so chat-relay arrives as its alias.
  { id: 9010, dir: RECEPTION, mode: 'idle' },
  { id: 9011, dir: 'alpha', mode: 'idle' },
  { id: 9012, dir: 'beta', mode: 'idle' },
];

export function runDemo(): void {
  const send = (msg: Record<string, unknown>) =>
    sseTransport?.deliver(msg as unknown as ServerMessage);
  send({ type: 'wallpaperConfig', reception: RECEPTION, lang: null });
  // Today's counts for the end-of-day whiteboard (the server derives them from file times).
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  send({ type: 'wallpaperStats', day, sessions: 12, subtasks: 31 });
  // Same capabilities the server sends, so Task/Agent spawn sub-agent characters.
  send({
    type: 'providerCapabilities',
    readingTools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
    subagentToolNames: ['Task', 'Agent'],
  });
  for (const a of AGENTS) {
    send({ type: 'agentCreated', id: a.id, directoryName: a.dir });
  }
  // Let the spawn effect play before the tools start.
  setTimeout(() => {
    const now = Date.now();
    for (const a of AGENTS) {
      const since = a.waitedSec !== undefined ? now - a.waitedSec * 1000 : undefined;
      if (a.ctx !== undefined) {
        send({
          type: 'agentContextUsage',
          id: a.id,
          contextTokens: Math.round(a.ctx * CONTEXT_MAX),
          maxContextTokens: CONTEXT_MAX,
        });
      }
      if (a.mode === 'idle') {
        send({ type: 'agentStatus', id: a.id, status: 'waiting' });
        continue;
      }
      if (a.mode === 'input') {
        send({
          type: 'agentStatus',
          id: a.id,
          status: 'waiting',
          awaitingInput: true,
          waitingSince: since,
        });
        continue;
      }
      send({ type: 'agentStatus', id: a.id, status: 'active' });
      if (a.tool) {
        send({
          type: 'agentToolStart',
          id: a.id,
          toolId: `demo-${String(a.id)}`,
          status: a.tool.status,
          toolName: a.tool.name,
        });
      }
      if (a.mode === 'permission') {
        send({ type: 'agentToolPermission', id: a.id, waitingSince: since });
      }
    }
    // infra runs four sub-agents, each on its own tool.
    for (const [i, sub] of SUBAGENTS.entries()) {
      const parentToolId = `demo-9006-sub${String(i)}`;
      send({
        type: 'agentToolStart',
        id: 9006,
        toolId: parentToolId,
        status: `Subtask: ${sub.type}`,
        toolName: 'Agent',
      });
      send({
        type: 'subagentToolStart',
        id: 9006,
        parentToolId,
        toolId: `${parentToolId}-t`,
        status: sub.status,
      });
    }
    // blog: a command that ended with an error, agent still mid-turn.
    send({
      type: 'agentToolStart',
      id: 9007,
      toolId: 'demo-9007',
      status: 'Running command',
      toolName: 'Bash',
    });
    send({ type: 'agentToolDone', id: 9007, toolId: 'demo-9007', error: true });
  }, 1500);
  // The web-fetch sub-agent finishes after ~20 s so the leave behaviour shows.
  setTimeout(() => {
    const parentToolId = `demo-9006-sub${String(SUB_LEAVES)}`;
    send({ type: 'subagentToolDone', id: 9006, parentToolId, toolId: `${parentToolId}-t` });
    send({ type: 'subagentClear', id: 9006, parentToolId });
    send({ type: 'agentToolDone', id: 9006, toolId: parentToolId });
  }, 21_500);
}
