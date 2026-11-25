import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

// Claude Code records its own process start time in the session file so a reused pid can be told
// apart (read from the 2.1.332 bundle):
//   - procStart (macOS, Linux): `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`, e.g. "Fri Nov 13 09:10:38 2026".
//   - procStartFt (Windows): Bun's windowsProcessCreationTime(pid), a number as a string. Unit unconfirmed:
//     FILETIME (100 ns since 1601) is assumed; ms, us and ns since 1970 are accepted too.
// A recorded value that parses to none of these gives no verdict, and the session is kept.

const TOLERANCE_MS = 5000;
const RETRY_MS = 30_000;
const READ_TIMEOUT_MS = 5000;
const FILETIME_EPOCH_MS = 11_644_473_600_000;
const MS_MIN = Date.UTC(2000, 0, 1);
const MS_MAX = Date.UTC(2100, 0, 1);
// /proc reports starttime in USER_HZ, which the kernel ABI fixes at 100 on mainstream architectures.
const USER_HZ = 100;
const PID_MAX = 2 ** 31 - 1;

const inRange = (ms) => Number.isFinite(ms) && ms >= MS_MIN && ms < MS_MAX;

function fromNumber(n, platform) {
  for (const ms of [n, n / 1e3, (n / 1e4) - FILETIME_EPOCH_MS, n / 1e6]) {
    if (inRange(ms)) return { ms };
  }
  // A small integer on Linux is a raw /proc starttime in clock ticks.
  if (platform === 'linux' && Number.isSafeInteger(n) && n >= 0 && n < MS_MIN) return { ticks: n };
  return undefined;
}

// The start time the session file recorded: { ms } (epoch ms), { ticks } (Linux /proc), or undefined.
export function recordedStart(session, platform = process.platform) {
  const raw = platform === 'win32' ? (session.procStartFt ?? session.procStart) : (session.procStart ?? session.procStartFt);
  if (typeof raw === 'number') return fromNumber(raw, platform);
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return fromNumber(Number(s), platform);
  const ms = Date.parse(`${s.replace(/\s+/g, ' ')} UTC`);
  return inRange(ms) ? { ms } : undefined;
}

const validPid = (pid) => Number.isInteger(pid) && pid > 0 && pid <= PID_MAX;

let bootMs;

async function linuxBootMs() {
  if (bootMs === undefined) {
    try {
      const m = /^btime (\d+)$/m.exec(await fs.readFile('/proc/stat', 'utf8'));
      bootMs = m ? Number(m[1]) * 1000 : null;
    } catch {
      bootMs = null;
    }
  }
  return bootMs;
}

// Linux: no process spawn. starttime is field 22 of /proc/<pid>/stat (the 20th after the `)` of comm).
export async function readLinuxStartTimes(pids) {
  const boot = await linuxBootMs();
  const out = new Map();
  for (const pid of pids) {
    if (!validPid(pid)) continue;
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      if (!Number.isSafeInteger(ticks)) continue;
      out.set(pid, { ticks, ms: boot ? boot + (ticks * 1000) / USER_HZ : undefined });
    } catch {
      // gone, or not readable: no verdict
    }
  }
  return out;
}

function run(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, ...opts }, (_err, stdout) => resolve(String(stdout || '')));
  });
}

// macOS and other BSDs: one `ps` spawn for the whole batch, same format Claude Code records.
export async function readPsStartTimes(pids) {
  const list = pids.filter(validPid);
  const out = new Map();
  if (list.length === 0) return out;
  const stdout = await run('/bin/ps', ['-o', 'pid=,lstart=', '-p', list.join(',')], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const ms = Date.parse(`${m[2].replace(/\s+/g, ' ')} UTC`);
    if (inRange(ms)) out.set(Number(m[1]), { ms });
  }
  return out;
}

// Windows: one PowerShell spawn for the whole batch. StartTime is unreadable for some processes of
// other users; those give no verdict.
export async function readWindowsStartTimes(pids) {
  const list = pids.filter(validPid);
  const out = new Map();
  if (list.length === 0) return out;
  const script =
    `Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `try { $t = $_.StartTime; if ($t) { [string]$_.Id + '=' + [string]$t.ToFileTimeUtc() } } catch {} }`;
  const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+)=(\d+)$/.exec(line.trim());
    if (!m) continue;
    const ms = Number(m[2]) / 1e4 - FILETIME_EPOCH_MS;
    if (inRange(ms)) out.set(Number(m[1]), { ms });
  }
  return out;
}

export function defaultStartTimeReader(platform = process.platform) {
  if (platform === 'linux') return readLinuxStartTimes;
  if (platform === 'win32') return readWindowsStartTimes;
  return readPsStartTimes;
}

function compare(rec, actual, toleranceMs) {
  if (!actual) return 'unknown';
  if (rec.ticks !== undefined) {
    if (actual.ticks === undefined) return 'unknown';
    return actual.ticks === rec.ticks ? 'same' : 'reused';
  }
  if (!Number.isFinite(actual.ms)) return 'unknown';
  return Math.abs(actual.ms - rec.ms) <= toleranceMs ? 'same' : 'reused';
}

// Drops sessions whose pid is alive but belongs to a newer process (pid reuse after a crash).
// One verdict per (pid, recorded start), kept while the session stays listed with a live pid,
// so a process is read once, not every poll. A failed read is retried after retryMs.
export class StartTimeGuard {
  constructor({ platform = process.platform, readStartTimes, now = Date.now, toleranceMs = TOLERANCE_MS, retryMs = RETRY_MS, onReused } = {}) {
    this.platform = platform;
    this.read = readStartTimes || defaultStartTimeReader(platform);
    this.now = now;
    this.toleranceMs = toleranceMs;
    this.retryMs = retryMs;
    this.onReused = onReused || (() => {});
    this.cache = new Map(); // `${pid}|${raw}` -> { verdict, at }
  }

  // sessions: records whose pid is alive. Returns the ones not shown to be a reused pid.
  async filter(sessions) {
    const keep = [];
    const seen = new Set();
    const pending = [];
    const now = this.now();
    for (const s of sessions) {
      const rec = recordedStart(s, this.platform);
      if (!rec) {
        keep.push(s);
        continue;
      }
      const key = `${s.pid}|${s.procStartFt ?? ''}|${s.procStart ?? ''}`;
      seen.add(key);
      const hit = this.cache.get(key);
      if (hit && (hit.verdict !== 'unknown' || now - hit.at < this.retryMs)) {
        if (hit.verdict !== 'reused') keep.push(s);
        continue;
      }
      pending.push({ s, rec, key });
    }
    if (pending.length > 0) {
      let actual;
      try {
        actual = await this.read([...new Set(pending.map((p) => p.s.pid))]);
      } catch {
        actual = new Map();
      }
      for (const { s, rec, key } of pending) {
        const verdict = compare(rec, actual && actual.get(s.pid), this.toleranceMs);
        this.cache.set(key, { verdict, at: now });
        if (verdict === 'reused') this.onReused(s.pid);
        else keep.push(s);
      }
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return keep;
  }
}
