import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NAME_MAX } from './naming.mjs';

const MAX_BYTES = 1024 * 1024;

// macOS + Linux: ${XDG_CONFIG_HOME:-~/.config}/quiet-office/config.json. Windows: %APPDATA%\quiet-office\config.json.
export function configPath({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA && path.win32.isAbsolute(env.APPDATA) ? env.APPDATA : path.win32.join(homeDir, 'AppData', 'Roaming');
    return path.win32.join(appData, 'quiet-office', 'config.json');
  }
  const xdg = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(homeDir, '.config');
  return path.posix.join(xdg, 'quiet-office', 'config.json');
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function defaultConfig() {
  return { lang: null, aliases: new Map(), reception: { agent: null, channels: [] }, contextMax: undefined };
}

// Unparseable JSON or a non-object = all defaults. A field of the wrong type = that field's default.
// `privacy` is read by the hosts only.
export function parseConfig(text) {
  const out = defaultConfig();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isObject(data)) return out;
  if (data.lang === 'en' || data.lang === 'ms') out.lang = data.lang;
  if (isObject(data.aliases)) {
    for (const [k, v] of Object.entries(data.aliases)) {
      const key = k.trim();
      const val = str(v);
      if (key && val) out.aliases.set(key, val);
    }
  }
  if (isObject(data.reception)) {
    // Display names are cut to NAME_MAX, so the configured name is cut the same way to still match.
    const agent = str(data.reception.agent).slice(0, NAME_MAX);
    if (agent) out.reception.agent = agent;
    if (Array.isArray(data.reception.channels)) {
      out.reception.channels = [...new Set(data.reception.channels.map(str).filter(Boolean))];
    }
  }
  if (Number.isFinite(data.contextMax) && data.contextMax > 0) out.contextMax = Math.floor(data.contextMax);
  return out;
}

function sameAliases(a, b) {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

// Optional config.json, never written. Missing, unreadable or invalid = defaults. Re-read when mtime or size changes.
export class ConfigStore {
  constructor(file) {
    this.file = file;
    this.stamp = null;
    this.config = defaultConfig();
    this.aliasGen = 0;
  }

  get aliases() {
    return this.config.aliases;
  }

  get reception() {
    return this.config.reception;
  }

  message() {
    return { type: 'wallpaperConfig', reception: this.config.reception.agent, lang: this.config.lang };
  }

  async refresh() {
    if (!this.file) return;
    let st = null;
    try {
      st = await fs.stat(this.file);
    } catch {
      st = null;
    }
    const stamp = st ? `${st.mtimeMs}:${st.size}` : 'none';
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    let next = defaultConfig();
    if (st && st.isFile() && st.size <= MAX_BYTES) {
      try {
        next = parseConfig(await fs.readFile(this.file, 'utf8'));
      } catch {
        next = defaultConfig();
      }
    }
    if (!sameAliases(next.aliases, this.config.aliases)) this.aliasGen++;
    this.config = next;
  }
}
