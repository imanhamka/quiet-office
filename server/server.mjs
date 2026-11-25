#!/usr/bin/env node
// Data server for the Quiet Office wallpaper. Read-only view of the Claude Code config dir
// (sessions + transcripts), served as pixel-agents ServerMessages over SSE.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configPath } from './lib/config.mjs';
import { createHttpServer } from './lib/http.mjs';
import { Tracker } from './lib/tracker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Same rule as Claude Code: $CLAUDE_CONFIG_DIR, else ~/.claude. CLAUDE_HOME is a fallback alias.
export function claudeConfigDir(env = process.env, homeDir = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(homeDir, '.claude');
}

export async function startServer(opts = {}) {
  const env = opts.env || process.env;
  const port = opts.port ?? Number(env.QUIET_OFFICE_PORT || 47100);
  const claudeDir = opts.claudeDir || claudeConfigDir(env);
  const webDir = opts.webDir || env.QUIET_OFFICE_WEB_DIR || path.resolve(here, '..', 'web', 'dist');
  const configFile = opts.configFile !== undefined ? opts.configFile : configPath({ env });
  const log = opts.log || ((line) => console.log(line));

  let http;
  const contextMax = Number(env.QUIET_OFFICE_CONTEXT_MAX) || undefined;
  const tracker = new Tracker({ contextMax, configFile, ...opts.tracker, claudeDir, log, emit: (msg) => http.broadcast(msg) });
  http = createHttpServer({ tracker, webDir, log });
  const actualPort = await http.listen(port, '127.0.0.1');
  await tracker.start();

  return {
    port: actualPort,
    tracker,
    http,
    async stop() {
      tracker.stop();
      await http.close();
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.on('uncaughtException', (err) => console.log(`[quiet-office] error uncaught: ${err && err.stack}`));
  process.on('unhandledRejection', (err) => console.log(`[quiet-office] error unhandled: ${err && err.stack}`));
  startServer()
    .then((s) => {
      console.log(`[quiet-office] listening on 127.0.0.1:${s.port}`);
      const shutdown = () => s.stop().finally(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.log(`[quiet-office] error startup: ${err && err.message}`);
      process.exit(1);
    });
}
