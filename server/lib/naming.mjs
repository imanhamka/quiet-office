import path from 'node:path';

export const NAME_MAX = 24;

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// CONTRACT.md v2 naming rule, before aliases.
export function baseName(session, homeDir) {
  const name = str(session.name);
  if (name && session.nameSource !== 'derived') return name;
  const tmux = str(session.tmux).split(':')[0].trim();
  if (tmux) return tmux;
  const cwd = str(session.cwd);
  if (cwd && path.resolve(cwd) !== path.resolve(homeDir)) {
    const b = path.basename(cwd);
    if (b) return b;
  }
  const sid = str(session.sessionId).replace(/[^A-Za-z0-9]/g, '');
  return `sesi-${sid.slice(0, 4) || 'xxxx'}`;
}

// Exact key wins, else the longest key that prefixes the name, else the cwd basename.
export function applyAlias(name, cwdBase, aliases) {
  if (!aliases || aliases.size === 0) return name;
  for (const candidate of [name, cwdBase]) {
    if (!candidate) continue;
    if (aliases.has(candidate)) return aliases.get(candidate);
    let best = '';
    for (const key of aliases.keys()) {
      if (key.length > best.length && candidate.startsWith(key)) best = key;
    }
    if (best) return aliases.get(best);
  }
  return name;
}

export function computeName(session, { homeDir, aliases } = {}) {
  const cwd = str(session.cwd);
  const raw = applyAlias(baseName(session, homeDir), cwd ? path.basename(cwd) : '', aliases);
  return raw.length > NAME_MAX ? raw.slice(0, NAME_MAX) : raw;
}
