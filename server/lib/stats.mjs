import fs from 'node:fs/promises';
import path from 'node:path';

const SUBAGENT_FILE = /^agent-[A-Za-z0-9_-]+\.jsonl$/;

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

// Local-time day key and [start, end) bounds in ms epoch.
export function dayBounds(ms) {
  const d = new Date(ms);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, start, end };
}

// Creation time of a sub-agent transcript. birthtime is 0 where the filesystem lacks it.
export function createdMs(st) {
  return st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
}

// Today's counts, derived from file timestamps so a restart loses nothing:
// sessions = <project>/<sessionId>.jsonl modified today,
// subtasks = <project>/<sessionId>/subagents/agent-*.jsonl created today.
// The tracker reports what it already sees; a full scan runs every scanMs.
export class DayStats {
  constructor({ projectsDir, now = Date.now, scanMs = 60_000, onChange = () => {}, logError = () => {} }) {
    this.projectsDir = projectsDir;
    this.now = now;
    this.scanMs = scanMs;
    this.onChange = onChange;
    this.logError = logError;
    this.scanning = false;
    this.#reset(now());
  }

  #reset(ms) {
    Object.assign(this, dayBounds(ms));
    this.sessions = new Set(); // sessionIds active today
    this.subtasks = new Set(); // sub-agent transcript paths created today
    this.subCreated = new Map(); // sub-agent path -> created ms (does not change)
    this.nextScanAt = 0;
  }

  isToday(ms) {
    return ms >= this.start && ms < this.end;
  }

  message() {
    return { type: 'wallpaperStats', day: this.day, sessions: this.sessions.size, subtasks: this.subtasks.size };
  }

  today() {
    return { day: this.day, sessions: this.sessions.size, subtasks: this.subtasks.size };
  }

  // Called every tick. Rolls over at local midnight and starts a scan when due.
  tick() {
    const now = this.now();
    if (now >= this.end || now < this.start) {
      this.#reset(now);
      this.onChange(this.message());
    }
    if (now >= this.nextScanAt && !this.scanning) {
      this.scan().catch((err) => this.logError('stats scan', err));
    }
  }

  noteSession(sessionId, mtimeMs) {
    if (!this.isToday(mtimeMs) || this.sessions.has(sessionId)) return;
    this.sessions.add(sessionId);
    this.onChange(this.message());
  }

  noteSubagent(file, st) {
    const created = createdMs(st);
    this.subCreated.set(file, created);
    if (!this.isToday(created) || this.subtasks.has(file)) return;
    this.subtasks.add(file);
    this.onChange(this.message());
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    const day = this.day;
    this.nextScanAt = this.now() + this.scanMs;
    const before = `${this.sessions.size}:${this.subtasks.size}`;
    try {
      let projects;
      try {
        projects = await fs.readdir(this.projectsDir, { withFileTypes: true });
      } catch (err) {
        if (err.code !== 'ENOENT') this.logError('stats projects dir', err);
        return;
      }
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        await this.#scanProject(path.join(this.projectsDir, p.name));
        if (this.day !== day) return; // rolled over mid-scan; the next scan recounts
      }
    } finally {
      this.scanning = false;
    }
    if (`${this.sessions.size}:${this.subtasks.size}` !== before) this.onChange(this.message());
  }

  async #scanProject(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sessionId = e.name.slice(0, -'.jsonl'.length);
      if (!this.sessions.has(sessionId)) {
        let st;
        try {
          st = await fs.stat(path.join(dir, e.name));
        } catch {
          continue;
        }
        if (!this.isToday(st.mtimeMs)) continue;
        this.sessions.add(sessionId);
      }
      // A sub-agent started today writes to its parent's transcript today too.
      await this.#scanSubagents(path.join(dir, sessionId, 'subagents'));
    }
  }

  async #scanSubagents(dir) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!SUBAGENT_FILE.test(name)) continue;
      const file = path.join(dir, name);
      let created = this.subCreated.get(file);
      if (created === undefined) {
        try {
          created = createdMs(await fs.stat(file));
        } catch {
          continue;
        }
        this.subCreated.set(file, created);
      }
      if (this.isToday(created)) this.subtasks.add(file);
    }
  }
}
