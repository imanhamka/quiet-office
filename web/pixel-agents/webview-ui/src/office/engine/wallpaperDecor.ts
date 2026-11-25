// quiet-office: generated sprites for the wallpaper's office decor. Every function
// returns a stable SpriteData object for the same input, so getCachedSprite keeps one
// canvas per zoom and the renderer pays one drawImage per item per frame.

import {
  WP_CLOCK_FACE_COLORS,
  WP_CLOCK_FACE_FILL as CLOCK_FACE_FILL,
  WP_CLOCK_HOUR_HAND as HOUR_HAND,
  WP_CLOCK_MINUTE_HAND as MINUTE_HAND,
  WP_CLOCK_OLD_HAND as CLOCK_OLD_HAND,
  WP_MAIL_EDGE,
  WP_MAIL_PAPER,
  WP_MAIL_SEAL,
  WP_NIGHT_GLOW_CORE,
  WP_NIGHT_GLOW_EDGE,
  WP_PC_SCREEN_TO_RED,
  WP_RING_INPUT,
  WP_RING_PERMISSION_RED,
  WP_RING_PERMISSION_WHITE,
} from '../sprites/wallpaperPalette.js';
import type { SpriteData } from '../types.js';

// ── Alert rings (drawn under a character's feet) ─────────────────────────────

const RING_SHAPE = [
  '...######...',
  '.##......##.',
  '#..........#',
  '.##......##.',
  '...######...',
];
export const RING_W = RING_SHAPE[0].length;
export const RING_H = RING_SHAPE.length;

function ring(color: string): SpriteData {
  return RING_SHAPE.map((row) => [...row].map((p) => (p === '#' ? color : '')));
}

/** Permission ring: red and white, alternating with the blink phase. */
export const RING_PERMISSION_RED = ring(WP_RING_PERMISSION_RED);
export const RING_PERMISSION_WHITE = ring(WP_RING_PERMISSION_WHITE);
/** Waiting-for-input ring: steady amber. */
export const RING_INPUT = ring(WP_RING_INPUT);

let blinkOn = false;

/** Blink phase shared by the permission ring and the red PC screen (officeState sets it). */
export function setDecorBlink(on: boolean): void {
  blinkOn = on;
}

export function decorBlinkOn(): boolean {
  return blinkOn;
}

// ── Red PC screen (permission alert) ─────────────────────────────────────────

const SCREEN_TO_RED = WP_PC_SCREEN_TO_RED;

const redCache = new WeakMap<SpriteData, SpriteData>();

/** `sprite` with its screen pixels recoloured red. Sprites without a screen come back as is. */
export function redScreenSprite(sprite: SpriteData): SpriteData {
  const hit = redCache.get(sprite);
  if (hit) return hit;
  let changed = false;
  const out = sprite.map((row) =>
    row.map((c) => {
      const red = c ? SCREEN_TO_RED[c.slice(0, 7).toLowerCase()] : undefined;
      if (!red) return c;
      changed = true;
      return red;
    }),
  );
  const result = changed ? out : sprite;
  redCache.set(sprite, result);
  return result;
}

// ── Night glow under lit PCs ─────────────────────────────────────────────────

export const GLOW_W = 40;
export const GLOW_H = 24;

/** Ordered-dither soft glow: dense near the centre, sparse at the rim. Pixel art, no blur. */
function buildGlow(): SpriteData {
  const g: SpriteData = [];
  const cx = (GLOW_W - 1) / 2;
  const cy = (GLOW_H - 1) / 2;
  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  for (let y = 0; y < GLOW_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < GLOW_W; x++) {
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      // Coverage falls from ~70% in the middle to 0 at the rim.
      const coverage = Math.max(0, 0.7 * (1 - d));
      const threshold = (bayer[y % 4][x % 4] + 0.5) / 16;
      row.push(coverage > threshold ? (d < 0.45 ? WP_NIGHT_GLOW_CORE : WP_NIGHT_GLOW_EDGE) : '');
    }
    g.push(row);
  }
  return g;
}

export const NIGHT_GLOW = buildGlow();

export function isNight(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.daypart === 'night';
}

// ── Wall clock ───────────────────────────────────────────────────────────────

/** Face pixels of the CLOCK sprite (the hands are drawn only over these). */
const CLOCK_FACE = new Set(WP_CLOCK_FACE_COLORS);
/** Pivot in sprite pixels (centre of pixel 7,16: the face centre of CLOCK.png). */
const PIVOT_X = 7.5;
const PIVOT_Y = 16.5;

function hand(g: SpriteData, base: SpriteData, angle: number, length: number, color: string): void {
  for (let t = 0; t <= length; t += 0.25) {
    const x = Math.floor(PIVOT_X + t * Math.sin(angle));
    const y = Math.floor(PIVOT_Y - t * Math.cos(angle));
    const src = base[y]?.[x];
    if (src && CLOCK_FACE.has(src.slice(0, 7).toLowerCase())) g[y][x] = color;
  }
}

/** The CLOCK sprite with its painted hands replaced by hands for `hours:minutes`. */
export function buildClockSprite(base: SpriteData, hours: number, minutes: number): SpriteData {
  const g = base.map((row) =>
    row.map((c) => (c && c.slice(0, 7).toLowerCase() === CLOCK_OLD_HAND ? CLOCK_FACE_FILL : c)),
  );
  const minAngle = (minutes / 60) * Math.PI * 2;
  const hourAngle = (((hours % 12) + minutes / 60) / 12) * Math.PI * 2;
  hand(g, base, minAngle, 3.6, MINUTE_HAND);
  hand(g, base, hourAngle, 2.3, HOUR_HAND);
  g[Math.floor(PIVOT_Y)][Math.floor(PIVOT_X)] = HOUR_HAND;
  return g;
}

// ── Reception mail envelope ──────────────────────────────────────────────────

const ENVELOPE_SHAPE = [
  '#########',
  '##.....##',
  '#.#...#.#',
  '#..#.#..#',
  '#...o...#',
  '#.......#',
  '#########',
];
export const ENVELOPE_W = ENVELOPE_SHAPE[0].length;
export const ENVELOPE_H = ENVELOPE_SHAPE.length;

/** A closed envelope with a red seal: shown at reception when a channel message comes in. */
export const ENVELOPE: SpriteData = ENVELOPE_SHAPE.map((row) =>
  [...row].map((p) => (p === '#' ? WP_MAIL_EDGE : p === 'o' ? WP_MAIL_SEAL : WP_MAIL_PAPER)),
);
