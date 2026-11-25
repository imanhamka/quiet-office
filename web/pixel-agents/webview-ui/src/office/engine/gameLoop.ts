import { MAX_DELTA_TIME_SEC } from '../../constants.js';
// quiet-office: fps cap, pause/resume, frame listeners.
import {
  emitFrameRendered,
  getFpsCap,
  isLoopPaused,
  isWallpaper,
  registerLoop,
  WALLPAPER_IDLE_FPS,
} from '../../wallpaper.js';
import { createFrameRecorder } from './frameRecorder.js';

/** @internal */
export interface GameLoopCallbacks {
  update: (dt: number) => void;
  render: (ctx: CanvasRenderingContext2D) => void;
  /** quiet-office: true while something moves (walking, spawn effect); false drops to the idle fps. */
  isBusy?: () => boolean;
}

/** @internal */
export interface GameLoop {
  stop: () => void;
  /** Draw the current state now, without advancing it: resizing a canvas
   *  clears it, and the next frame would otherwise paint it blank. */
  redraw: () => void;
}

/** quiet-office: wake this many ms before a capped frame is due, then align on rAF. */
const WAKE_EARLY_MS = 6;
/** quiet-office: a frame up to this many ms early still counts as due (rAF jitter). */
const DUE_TOLERANCE_MS = 2;

export function startGameLoop(canvas: HTMLCanvasElement, callbacks: GameLoopCallbacks): GameLoop {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let lastTime = 0;
  let rafId = 0;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let suspended = false;
  // quiet-office: ms accumulated since the last update+render.
  let accMs = 0;
  // quiet-office: a frame identical to the last drawn one leaves the canvas alone.
  const recorder = isWallpaper ? createFrameRecorder() : null;
  const draw = (force: boolean) => {
    ctx.imageSmoothingEnabled = false;
    if (!recorder) {
      callbacks.render(ctx);
      return;
    }
    if (force) recorder.invalidate();
    recorder.begin();
    callbacks.render(recorder.ctx);
    recorder.commit(ctx);
  };

  const currentCap = (): number => {
    const cap = getFpsCap();
    if (cap <= 0) return 0;
    if (callbacks.isBusy && !callbacks.isBusy()) return Math.min(cap, WALLPAPER_IDLE_FPS);
    return cap;
  };

  const cancel = () => {
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  // quiet-office: uncapped = every rAF (upstream). Capped = sleep on a timer
  // until shortly before the frame is due, then one rAF for vsync alignment.
  const schedule = (waitMs: number) => {
    if (stopped || suspended) return;
    if (waitMs > WAKE_EARLY_MS) {
      timerId = setTimeout(() => {
        timerId = null;
        rafId = requestAnimationFrame(frame);
      }, waitMs - WAKE_EARLY_MS);
    } else {
      rafId = requestAnimationFrame(frame);
    }
  };

  const frame = (time: number) => {
    rafId = 0;
    if (stopped || suspended) return;
    const first = lastTime === 0;
    if (!first) accMs += time - lastTime;
    lastTime = time;

    const cap = currentCap();
    const intervalMs = cap > 0 ? 1000 / cap : 0;
    if (!first && cap > 0 && accMs + DUE_TOLERANCE_MS < intervalMs) {
      schedule(intervalMs - accMs);
      return;
    }

    const dt = Math.min(accMs / 1000, MAX_DELTA_TIME_SEC);
    accMs = 0;

    callbacks.update(dt);

    draw(false);
    emitFrameRendered();

    schedule(intervalMs);
  };

  const unregister = registerLoop({
    pause: () => {
      suspended = true;
      cancel();
    },
    resume: () => {
      if (stopped || !suspended) return;
      suspended = false;
      // Resume without a time jump: the first frame after a pause advances 0.
      lastTime = 0;
      accMs = 0;
      recorder?.invalidate();
      cancel();
      rafId = requestAnimationFrame(frame);
    },
  });

  suspended = isLoopPaused();
  if (!suspended) rafId = requestAnimationFrame(frame);

  return {
    stop: () => {
      stopped = true;
      cancel();
      unregister();
    },
    redraw: () => {
      if (stopped) return;
      draw(true);
      emitFrameRendered();
    },
  };
}
