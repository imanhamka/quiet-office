// quiet-office: when each agent started waiting on the user (CONTRACT v2 `waitingSince`).
// Kept outside OfficeState (engine-owned). The message hook writes it; ToolOverlay reads it.
// No value from the server -> the time this client first saw the wait.

export type WaitKind = 'permission' | 'input';

const since: Record<WaitKind, Map<number, number>> = {
  permission: new Map(),
  input: new Map(),
};

function validMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Record a wait. A server time always wins; a missing one keeps any earlier sighting. */
export function markWaiting(
  id: number,
  kind: WaitKind,
  serverMs?: unknown,
  now = Date.now(),
): void {
  const map = since[kind];
  if (validMs(serverMs)) map.set(id, Math.min(serverMs, now));
  else if (!map.has(id)) map.set(id, now);
}

export function clearWaiting(id: number, kind?: WaitKind): void {
  if (kind) since[kind].delete(id);
  else {
    since.permission.delete(id);
    since.input.delete(id);
  }
}

export function clearAllWaiting(): void {
  since.permission.clear();
  since.input.clear();
}

export function waitingSince(id: number, kind: WaitKind): number | undefined {
  return since[kind].get(id);
}

/** True while the hook has an input wait open for the agent (its bubble lasts only 2 s). */
export function isAwaitingInput(id: number): boolean {
  return since.input.has(id);
}
