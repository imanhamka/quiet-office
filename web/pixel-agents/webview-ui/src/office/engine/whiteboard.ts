// quiet-office: the whiteboard scoreboard. A 3x5 pixel font drawn into a 32x32
// SpriteData that replaces the WHITEBOARD furniture sprite. officeState rebuilds it
// only when a count changes, and the sprite cache turns it into one canvas per zoom.

import { type Lang, t } from '../../i18n/index.js';
import {
  WP_BOARD_FRAME as FRAME,
  WP_BOARD_MARKER_BLUE as MARKER_BLUE,
  WP_BOARD_MARKER_RED as MARKER_RED,
  WP_BOARD_RIM as RIM,
  WP_BOARD_RIM_TOP as RIM_TOP,
  WP_BOARD_SURFACE as SURFACE,
  WP_BOARD_TRAY as TRAY,
  WP_INK_ACTIVE as INK_ACTIVE,
  WP_INK_ALERT as INK_ALERT,
  WP_INK_RESTING as INK_RESTING,
  WP_INK_SUB as INK_SUB,
  WP_SIGN_FACE as SIGN_FACE,
  WP_SIGN_FRAME as SIGN_FRAME,
  WP_SIGN_LAMP_BUSY as LAMP_BUSY,
  WP_SIGN_LAMP_FREE as LAMP_FREE,
  WP_SIGN_TEXT_BUSY as TEXT_BUSY,
  WP_SIGN_TEXT_FREE as TEXT_FREE,
} from '../sprites/wallpaperPalette.js';
import type { SpriteData } from '../types.js';

/** Glyphs: 5 rows each, '#' = ink. Width is the row length (I and ! are 1 wide). */
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['#', '#', '#', '#', '#'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '!': ['#', '#', '#', '.', '#'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  '-': ['...', '...', '###', '...', '...'],
  ':': ['.', '#', '.', '#', '.'],
  '.': ['.', '.', '.', '.', '#'],
  ' ': ['.', '.', '.', '.', '.'],
};

const GLYPH_H = 5;

/** Characters of `text` the 3x5 font has no glyph for (they would draw as '?'). */
export function missingGlyphs(text: string): string[] {
  return [...new Set([...text].filter((ch) => !GLYPHS[ch]))];
}

/** Pixel width of `text` in the 3x5 font, 1 px between glyphs. Unknown characters draw as '?'. */
export function textWidth(text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += (GLYPHS[text[i]] ?? GLYPHS['?'])[0].length;
    if (i > 0) w += 1;
  }
  return w;
}

/** Paint `text` into `grid` with its top-left at (x, y). Pixels outside the grid are dropped. */
export function drawText(grid: SpriteData, text: string, x: number, y: number, color: string): void {
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS[ch] ?? GLYPHS['?'];
    for (let r = 0; r < GLYPH_H; r++) {
      const row = grid[y + r];
      if (!row) continue;
      for (let c = 0; c < g[r].length; c++) {
        if (g[r][c] === '#' && cx + c >= 0 && cx + c < row.length) row[cx + c] = color;
      }
    }
    cx += g[0].length + 1;
  }
}

export interface ScoreCounts {
  active: number;
  resting: number;
  subagents: number;
  /** Agents (sub-agents included) waiting for a permission answer or for input. */
  alerts: number;
}

export function sameCounts(a: ScoreCounts | null, b: ScoreCounts): boolean {
  return (
    !!a &&
    a.active === b.active &&
    a.resting === b.resting &&
    a.subagents === b.subagents &&
    a.alerts === b.alerts
  );
}

const SIZE = 32;

/** Board area (inclusive): frame x 0..31, y 2..27; writable surface x 1..30, y 4..24.
 *  Text runs x 2..29 (28 px): label left, count right, at least LABEL_GAP px between. */
const SURFACE_X0 = 1;
const SURFACE_X1 = 30;
const SURFACE_Y0 = 4;
const SURFACE_Y1 = 24;
const TEXT_LEFT = 2;
const TEXT_RIGHT = 29;
const LINE_Y = [6, 12, 18];
const LABEL_GAP = 2;

/** The full label when it fits beside `num`, else the short one. */
export function boardLabel(labels: readonly [string, string], num: string): string {
  const room = TEXT_RIGHT + 1 - TEXT_LEFT - textWidth(num) - LABEL_GAP;
  return textWidth(labels[0]) <= room ? labels[0] : labels[1];
}

/** Whether `label` and `num` share one board line with the gap kept. */
export function fitsBoardLine(label: string, num: string): boolean {
  return textWidth(label) + LABEL_GAP + textWidth(num) <= TEXT_RIGHT + 1 - TEXT_LEFT;
}

function blankBoard(): SpriteData {
  const g: SpriteData = [];
  for (let y = 0; y < SIZE; y++) g.push(new Array<string>(SIZE).fill(''));
  for (let x = 0; x < SIZE; x++) {
    g[2][x] = FRAME;
    g[27][x] = FRAME;
  }
  for (let y = 2; y <= 27; y++) {
    g[y][0] = FRAME;
    g[y][SIZE - 1] = FRAME;
  }
  for (let x = 1; x < SIZE - 1; x++) {
    g[3][x] = x === 1 || x === SIZE - 2 ? RIM : RIM_TOP;
    g[25][x] = FRAME;
    g[26][x] = TRAY;
  }
  for (let y = SURFACE_Y0; y <= SURFACE_Y1; y++) {
    for (let x = SURFACE_X0; x <= SURFACE_X1; x++) g[y][x] = SURFACE;
  }
  // Two markers on the tray.
  g[26][22] = MARKER_RED;
  g[26][23] = MARKER_RED;
  g[26][25] = MARKER_BLUE;
  g[26][26] = MARKER_BLUE;
  return g;
}

/** Label left, number right-aligned, so the three counts line up. */
function line(
  g: SpriteData,
  y: number,
  labels: readonly [string, string],
  n: number,
  color: string,
): void {
  const num = String(Math.min(99, Math.max(0, n)));
  drawText(g, boardLabel(labels, num), TEXT_LEFT, y, color);
  drawText(g, num, TEXT_RIGHT + 1 - textWidth(num), y, color);
}

/** Today's totals (CONTRACT v4 `wallpaperStats`). */
export interface DayStats {
  day: string;
  sessions: number;
  subtasks: number;
}

/** End-of-day board window: 18:30 local until 06:00. */
export function isEndOfDay(date: Date): boolean {
  const m = date.getHours() * 60 + date.getMinutes();
  return m >= 18 * 60 + 30 || m < 6 * 60;
}

/** The three lines of the end-of-day board (title, sessions, sub-agents). Numbers are capped at 999. */
export function endOfDayLines(stats: DayStats, lang?: Lang): [string, string, string] {
  const n = (v: number) => String(Math.min(999, Math.max(0, Math.floor(v))));
  const sessions = n(stats.sessions);
  const subtasks = n(stats.subtasks);
  return [
    t('boardToday', lang),
    `${boardLabel(t('boardSessions', lang), sessions)} ${sessions}`,
    `${boardLabel(t('boardSub', lang), subtasks)} ${subtasks}`,
  ];
}

/** The 32x32 end-of-day board: the title ("TODAY") centred, then today's sessions and sub-agents. */
export function buildEndOfDaySprite(stats: DayStats, lang?: Lang): SpriteData {
  const g = blankBoard();
  const title = t('boardToday', lang);
  const mid = Math.floor((TEXT_LEFT + TEXT_RIGHT + 1 - textWidth(title)) / 2);
  drawText(g, title, mid, LINE_Y[0], INK_RESTING);
  const n = (v: number) => Math.min(999, Math.max(0, Math.floor(v)));
  const right = (y: number, labels: readonly [string, string], v: number, color: string) => {
    const num = String(n(v));
    drawText(g, boardLabel(labels, num), TEXT_LEFT, y, color);
    drawText(g, num, TEXT_RIGHT + 1 - textWidth(num), y, color);
  };
  right(LINE_Y[1], t('boardSessions', lang), stats.sessions, INK_ACTIVE);
  right(LINE_Y[2], t('boardSub', lang), stats.subtasks, INK_SUB);
  return g;
}

const ALERT_LABEL: [string, string] = ['!', '!'];

/** The 32x32 scoreboard sprite for `counts`. */
export function buildWhiteboardSprite(counts: ScoreCounts, lang?: Lang): SpriteData {
  const g = blankBoard();
  line(g, LINE_Y[0], t('boardActive', lang), counts.active, INK_ACTIVE);
  line(g, LINE_Y[1], t('boardIdle', lang), counts.resting, INK_RESTING);
  if (counts.alerts > 0) line(g, LINE_Y[2], ALERT_LABEL, counts.alerts, INK_ALERT);
  else line(g, LINE_Y[2], t('boardSub', lang), counts.subagents, INK_SUB);
  return g;
}

// ── Team-room door sign ──────────────────────────────────────────────────────

export const SIGN_W = 40; // minimum width; a booked sign grows to fit the lead's name
export const SIGN_H = 11;
/** Text starts after the lamp; SIGN_PAD_R px of face after it, then the frame. */
const SIGN_TEXT_X = 8;
const SIGN_PAD_R = 3;
const ELLIPSIS = '..';

/** Upper-case `name` in the 3x5 font's alphabet (others become '-'). The whole name when it
 *  fits `maxPx`, else as many characters as fit followed by "..". */
export function signText(name: string, maxPx: number): string {
  let full = '';
  for (const ch of name.trim().toUpperCase()) {
    full += GLYPHS[ch] && ch !== '?' && ch !== '.' ? ch : '-';
  }
  full = full.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (textWidth(full) <= maxPx) return full;
  let text = '';
  for (const c of full) {
    if (textWidth(text + c + ELLIPSIS) > maxPx) break;
    text += c;
  }
  return text.replace(/-+$/, '') + ELLIPSIS;
}

/** Door sign, SIGN_H tall: red lamp + the lead's name (or BUSY) while booked, green lamp + FREE
 *  when free. At least SIGN_W wide; a long name widens it up to `maxW` px, then is cut with "..". */
export function buildDoorSign(leadName: string | null, maxW = SIGN_W, lang?: Lang): SpriteData {
  const busy = leadName !== null;
  const limit = Math.max(SIGN_W, Math.floor(maxW));
  const text = busy ? signText(leadName, limit - SIGN_TEXT_X - SIGN_PAD_R) : t('signFree', lang);
  const w = Math.min(limit, Math.max(SIGN_W, SIGN_TEXT_X + textWidth(text) + SIGN_PAD_R));
  const g: SpriteData = [];
  for (let y = 0; y < SIGN_H; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      const edge = y === 0 || y === SIGN_H - 1 || x === 0 || x === w - 1;
      row.push(edge ? SIGN_FRAME : SIGN_FACE);
    }
    g.push(row);
  }
  const lamp = busy ? LAMP_BUSY : LAMP_FREE;
  for (let y = 4; y <= 6; y++) for (let x = 3; x <= 5; x++) g[y][x] = lamp;
  drawText(g, text, SIGN_TEXT_X, 3, busy ? TEXT_BUSY : TEXT_FREE);
  return g;
}
