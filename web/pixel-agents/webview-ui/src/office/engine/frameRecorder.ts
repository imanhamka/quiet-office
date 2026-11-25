// quiet-office: skip frames that would draw exactly what the last one drew.
//
// The renderer draws into a recorder instead of the canvas. The recorder keeps every call and
// property write, and builds a signature from them. Images are compared by identity: the sprite
// and floor caches create a new canvas whenever content changes, never redraw one in place.
// Same signature = same pixels, so the canvas is left alone (no raster, no GPU composite).
// Otherwise the calls are replayed on the real context.

type Op = { set: string; value: unknown } | { call: string; args: unknown[] };

const imageIds = new WeakMap<object, number>();
let nextImageId = 1;

function imageId(img: object): number {
  let id = imageIds.get(img);
  if (id === undefined) {
    id = nextImageId++;
    imageIds.set(img, id);
  }
  return id;
}

function argKey(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null || v === undefined || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(argKey).join(',')}]`;
  if (typeof v === 'object') return `#${imageId(v)}`;
  return '?';
}

export interface FrameRecorder {
  /** Hand this to the renderer in place of the canvas context. */
  readonly ctx: CanvasRenderingContext2D;
  /** Starts a new frame: drops the calls recorded so far. */
  begin(): void;
  /** Replays the frame on `target` unless it matches the last replayed one. True when drawn. */
  commit(target: CanvasRenderingContext2D): boolean;
  /** Forces the next commit to draw (the canvas was resized or cleared). */
  invalidate(): void;
}

export function createFrameRecorder(): FrameRecorder {
  let ops: Op[] = [];
  let parts: string[] = [];
  let lastSig: string | null = null;

  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      return (...args: unknown[]) => {
        ops.push({ call: prop, args });
        parts.push(`${prop}(${args.map(argKey).join(',')})`);
        return undefined;
      };
    },
    set(_t, prop, value) {
      if (typeof prop !== 'string') return false;
      ops.push({ set: prop, value });
      parts.push(`${prop}=${argKey(value)}`);
      return true;
    },
  });

  return {
    ctx,
    begin() {
      ops = [];
      parts = [];
    },
    commit(target) {
      const sig = parts.join(';');
      if (sig === lastSig) return false;
      lastSig = sig;
      const t = target as unknown as Record<string, unknown>;
      for (const op of ops) {
        if ('set' in op) t[op.set] = op.value;
        else (t[op.call] as (...a: unknown[]) => unknown).apply(target, op.args);
      }
      return true;
    },
    invalidate() {
      lastSig = null;
    },
  };
}
