// quiet-office: desktop-wallpaper mode (`?wallpaper=1`) and the dev-only demo (`?demo=1`).
// Kept in one module so the upstream files only carry small, marked hooks into it.

import { type Lang, parseLang, setOptionLang } from './i18n/index.js';
import { type OfficeLayout, TILE_SIZE, TileType } from './office/types.js';

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;

/** Canvas-only, read-only, no sound, capped fps. */
export const isWallpaper = params?.get('wallpaper') === '1';
/** Inject fake agents through the transport (for checks without the server). */
export const isDemo = params?.get('demo') === '1';

export const WALLPAPER_DEFAULT_FPS = 12;
export const WALLPAPER_IDLE_FPS = 10;

/** Device pixel ratio for the office canvas and its overlays: 1 in wallpaper mode
 *  (CSS `image-rendering: pixelated` doubles pixels exactly on a Retina panel). */
export function canvasDpr(): number {
  if (isWallpaper) return 1;
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
}

// ── Loop control (pause/resume) ──────────────────────────────────────────────

interface LoopControl {
  pause(): void;
  resume(): void;
}

const loops = new Set<LoopControl>();
let paused = false;
let hostPaused = false;
/** Busy fps; 0 = uncapped (upstream behaviour, outside wallpaper mode). */
let fpsCap = isWallpaper ? WALLPAPER_DEFAULT_FPS : 0;

export function getFpsCap(): number {
  return fpsCap;
}

export function isLoopPaused(): boolean {
  return paused;
}

/** gameLoop.ts registers each running loop here. Returns the unregister. */
export function registerLoop(loop: LoopControl): () => void {
  loops.add(loop);
  return () => {
    loops.delete(loop);
  };
}

function applyPaused(next: boolean): void {
  if (next === paused) return;
  paused = next;
  // quiet-office: freeze CSS animations (label status-dot pulse) too, else WebKit keeps restyling while paused.
  document.documentElement.classList.toggle('wp-paused', paused);
  for (const l of loops) {
    if (paused) l.pause();
    else l.resume();
  }
}

function syncPaused(): void {
  applyPaused(hostPaused || document.visibilityState === 'hidden');
}

// ── Frame listeners (ToolOverlay re-renders on the capped loop) ──────────────

const frameListeners = new Set<() => void>();

export function onFrameRendered(cb: () => void): () => void {
  frameListeners.add(cb);
  return () => {
    frameListeners.delete(cb);
  };
}

export function emitFrameRendered(): void {
  for (const cb of frameListeners) cb();
}

// ── Fit: largest integer zoom that shows the whole office, centred ───────────

/** Zoom and pan (device px) that fit the layout's non-void tiles in the window. */
export function fitOffice(
  layout: OfficeLayout,
  viewW: number,
  viewH: number,
  safe: Insets = ZERO_INSETS,
): { zoom: number; pan: { x: number; y: number } } {
  // Fit inside the safe area; ignore insets that would leave less than half the view.
  const useSafe = viewW - safe.left - safe.right >= viewW / 2 && viewH - safe.top - safe.bottom >= viewH / 2;
  const s = useSafe ? safe : ZERO_INSETS;
  const fitW = viewW - s.left - s.right;
  const fitH = viewH - s.top - s.bottom;
  // Offset of the safe area's centre from the view centre.
  const shiftX = (s.left - s.right) / 2;
  const shiftY = (s.top - s.bottom) / 2;
  const { cols, rows, tiles } = layout;
  let minC = cols;
  let maxC = -1;
  let minR = rows;
  let maxR = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (tiles[r * cols + c] === TileType.VOID) continue;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }
  if (maxC < 0) {
    minC = 0;
    maxC = cols - 1;
    minR = 0;
    maxR = rows - 1;
  }
  // Wall sprites are 2 tiles tall: the top wall row overhangs one tile upward.
  minR = Math.max(0, minR - 1);
  const boxW = (maxC - minC + 1) * TILE_SIZE;
  const boxH = (maxR - minR + 1) * TILE_SIZE;
  const zoom = Math.max(1, Math.floor(Math.min(fitW / boxW, fitH / boxH)));
  // mapOffset centres the full grid; shift so the box centre lands on the view centre.
  const boxCx = (minC * TILE_SIZE + boxW / 2) * zoom;
  const boxCy = (minR * TILE_SIZE + boxH / 2) * zoom;
  return {
    zoom,
    pan: {
      x: Math.round((cols * TILE_SIZE * zoom) / 2 - boxCx + shiftX),
      y: Math.round((rows * TILE_SIZE * zoom) / 2 - boxCy + shiftY),
    },
  };
}

// ── Page setup ───────────────────────────────────────────────────────────────

// ── Safe area (menu bar / Dock) ──────────────────────────────────────────────
// The host passes the screen's safe-area insets in points (`?inset=top,right,bottom,left`)
// and updates them with `__wallpaper.setInsets()` when the Dock moves or resizes. The office
// is fitted inside the safe area; the strips behind the menu bar and Dock stay dark.

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

function parseInsets(raw: string | null | undefined): Insets {
  const n = (raw ?? '').split(',').map((v) => Math.max(0, Math.round(Number(v)) || 0));
  if (n.length !== 4) return ZERO_INSETS;
  return { top: n[0], right: n[1], bottom: n[2], left: n[3] };
}

let insets: Insets = parseInsets(params?.get('inset'));
const insetListeners = new Set<(i: Insets) => void>();

export function getInsets(): Insets {
  return insets;
}

export function onInsetsChange(cb: (i: Insets) => void): () => void {
  insetListeners.add(cb);
  return () => {
    insetListeners.delete(cb);
  };
}

function setInsets(next: Insets): void {
  if (
    next.top === insets.top &&
    next.right === insets.right &&
    next.bottom === insets.bottom &&
    next.left === insets.left
  ) {
    return;
  }
  insets = next;
  for (const cb of insetListeners) cb(next);
}

// ── Host options (CONTRACT v4) ───────────────────────────────────────────────
// `__wallpaper.setOptions({ privacy, daypart, lang })`. Each field is taken only when it has the
// right type and value; anything else (other keys, strings for booleans) is ignored.

export type DaypartOption = 'auto' | 'day' | 'night';

export interface WallpaperOptions {
  /** No names or status text anywhere: no overlay labels, door signs say BUSY. */
  privacy: boolean;
  /** `auto` follows the clock (or `?daypart=`); `day` / `night` force it. */
  daypart: DaypartOption;
  /** `en` / `ms` force the display language; null (`'auto'` from the host) leaves it to
   *  `?lang=`, the server config, then the browser language. */
  lang: Lang | null;
}

const DAYPART_OPTIONS: readonly string[] = ['auto', 'day', 'night'];

let options: WallpaperOptions = { privacy: false, daypart: 'auto', lang: null };
const optionListeners = new Set<(o: WallpaperOptions) => void>();

export function getWallpaperOptions(): WallpaperOptions {
  return options;
}

export function onOptionsChange(cb: (o: WallpaperOptions) => void): () => void {
  optionListeners.add(cb);
  return () => {
    optionListeners.delete(cb);
  };
}

/** Apply the valid fields of `raw`. Returns true when an option changed. */
export function setWallpaperOptions(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  const next: WallpaperOptions = { ...options };
  if (typeof r.privacy === 'boolean') next.privacy = r.privacy;
  if (typeof r.daypart === 'string' && DAYPART_OPTIONS.includes(r.daypart)) {
    next.daypart = r.daypart as DaypartOption;
  }
  if (r.lang === 'auto') next.lang = null;
  else if (typeof r.lang === 'string' && parseLang(r.lang) === r.lang) next.lang = r.lang as Lang;
  if (
    next.privacy === options.privacy &&
    next.daypart === options.daypart &&
    next.lang === options.lang
  ) {
    return false;
  }
  options = next;
  setOptionLang(next.lang);
  for (const cb of optionListeners) cb(next);
  return true;
}

declare global {
  interface Window {
    __wallpaper?: {
      pause(): void;
      resume(fps: number): void;
      setInsets(top: number, right: number, bottom: number, left: number): void;
      setOptions(raw: unknown): void;
    };
  }
}

/** Call once before render. No-op outside wallpaper mode. */
export function installWallpaper(): void {
  if (!isWallpaper) return;
  document.documentElement.classList.add('wallpaper');
  window.__wallpaper = {
    pause() {
      hostPaused = true;
      syncPaused();
    },
    resume(fps: number) {
      if (Number.isFinite(fps) && fps > 0) fpsCap = Math.min(60, Math.max(1, Math.round(fps)));
      hostPaused = false;
      syncPaused();
    },
    setInsets(top: number, right: number, bottom: number, left: number) {
      setInsets(parseInsets([top, right, bottom, left].join(',')));
    },
    setOptions(raw: unknown) {
      setWallpaperOptions(raw);
    },
  };
  document.addEventListener('visibilitychange', syncPaused);
  // Read-only wallpaper: swallow input before React sees it.
  for (const type of ['keydown', 'keyup', 'wheel', 'contextmenu']) {
    window.addEventListener(
      type,
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true, passive: false },
    );
  }
}
