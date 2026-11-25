// quiet-office: label declutter for 15-20 agents. Pure geometry so it is unit-tested;
// ToolOverlay feeds it screen positions and renders what it returns.

/** `sub` = a sub-agent's one-line tag: below active leads, above idle ones. */
export type LabelKind = 'permission' | 'input' | 'active' | 'sub' | 'idle';

const PRIORITY: Record<LabelKind, number> = {
  permission: 0,
  input: 1,
  active: 2,
  sub: 3,
  idle: 4,
};

export const STATUS_FONT_PX = 22;
export const NAME_FONT_PX = 16;
export const SUB_FONT_PX = 16;
export const TINY_FONT_PX = 12;
/** FS Pixel Sans advance measured ~7.2px per char at 22px (0.33 em); 0.4 em keeps a margin. */
const CHAR_W_PER_FONT_PX = 0.4;
/** px-8 + 2px borders each side. */
const PAD_X = 20;
/** pt-2 + pb-4 + 2px borders each side. */
const PAD_Y = 10;
export const GAUGE_H_PX = 3;
export const GAUGE_GAP_PX = 2;

export interface LabelInput {
  id: number;
  kind: LabelKind;
  /** Screen x of the label centre. */
  x: number;
  /** Screen y of the label's bottom edge (it grows upward). */
  bottom: number;
  /** Status line incl. any timer; null for idle (name only). */
  status: string | null;
  name: string;
  gauge: boolean;
  /** Defaults: STATUS_FONT_PX / NAME_FONT_PX. */
  statusFont?: number;
  nameFont?: number;
}

export interface LabelPlacement {
  id: number;
  /** Horizontal nudge in px, to clear an obstacle such as a door sign (0 otherwise). */
  dx: number;
  /** Vertical nudge in px (0 or minus the label height). */
  dy: number;
  showStatus: boolean;
  hidden: boolean;
}

/** Screen rectangle in px. Obstacles (door signs) are boxes labels must not cover. */
export interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** Gap kept between a label slid aside and the obstacle it clears. */
const SLIDE_GAP_PX = 2;

export function estimateSize(
  status: string | null,
  name: string,
  gauge: boolean,
  statusFont = STATUS_FONT_PX,
  nameFont = NAME_FONT_PX,
): { w: number; h: number } {
  let w = name.length * nameFont * CHAR_W_PER_FONT_PX;
  let h = name ? nameFont : 0;
  if (status) {
    w = Math.max(w, status.length * statusFont * CHAR_W_PER_FONT_PX);
    h += statusFont;
  }
  if (gauge) h += GAUGE_H_PX + GAUGE_GAP_PX;
  return { w: w + PAD_X, h: h + PAD_Y };
}

function boxAt(x: number, bottom: number, size: { w: number; h: number }): Box {
  return { l: x - size.w / 2, r: x + size.w / 2, t: bottom - size.h, b: bottom };
}

function hits(a: Box, placed: Box[]): boolean {
  for (const p of placed) {
    if (a.l < p.r && a.r > p.l && a.t < p.b && a.b > p.t) return true;
  }
  return false;
}

/** Sideways nudges (smallest first) that move `box` clear of every obstacle it overlaps,
 *  each at most `maxShift`. Empty when it overlaps none. */
function slides(box: Box, obstacles: Box[], maxShift: number): number[] {
  const hit = obstacles.filter((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t);
  if (hit.length === 0) return [];
  const left = Math.min(...hit.map((o) => o.l)) - SLIDE_GAP_PX - box.r;
  const right = Math.max(...hit.map((o) => o.r)) + SLIDE_GAP_PX - box.l;
  return [left, right].filter((d) => Math.abs(d) <= maxShift).sort((a, b) => Math.abs(a) - Math.abs(b));
}

/** Labels in render order (priority, then id), with any nudge, dropped status, or hide.
 *  No label covers an obstacle unless it is an attention/active label with nowhere else to go. */
export function placeLabels(inputs: LabelInput[], obstacles: Box[] = []): LabelPlacement[] {
  const order = [...inputs].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.id - b.id);
  const placed: Box[] = [...obstacles];
  const out: LabelPlacement[] = [];
  for (const lab of order) {
    const full = estimateSize(lab.status, lab.name, lab.gauge, lab.statusFont, lab.nameFont);
    // Idle names and sub-agent tags are one line already: they hide instead of shrinking.
    const hides = lab.kind === 'idle' || lab.kind === 'sub';
    const showStatus = lab.status !== null;
    // Slid aside (still beside its owner) beats lifted above it: a lifted label over a door
    // sign would still cover the sign, and the slide keeps the status line.
    const aside = slides(boxAt(lab.x, lab.bottom, full), obstacles, full.w * 0.75);
    const tries: Array<{ dx: number; dy: number; size: { w: number; h: number }; showStatus: boolean }> = [
      { dx: 0, dy: 0, size: full, showStatus },
      ...aside.map((dx) => ({ dx, dy: 0, size: full, showStatus })),
      { dx: 0, dy: -full.h, size: full, showStatus },
    ];
    if (lab.status !== null && !hides) {
      const compact = estimateSize(null, lab.name, lab.gauge, lab.statusFont, lab.nameFont);
      tries.push({ dx: 0, dy: 0, size: compact, showStatus: false });
    }
    let chosen: (typeof tries)[number] | null = null;
    for (const t of tries) {
      const box = boxAt(lab.x + t.dx, lab.bottom + t.dy, t.size);
      if (!hits(box, placed)) {
        chosen = t;
        placed.push(box);
        break;
      }
    }
    if (!chosen) {
      if (hides) {
        out.push({ id: lab.id, dx: 0, dy: 0, showStatus: false, hidden: true });
        continue;
      }
      // Attention and active agents always keep a (compact) label, even over another.
      chosen = tries[tries.length - 1];
      placed.push(boxAt(lab.x + chosen.dx, lab.bottom + chosen.dy, chosen.size));
    }
    out.push({ id: lab.id, dx: chosen.dx, dy: chosen.dy, showStatus: chosen.showStatus, hidden: false });
  }
  return out;
}

/** The labels to draw: none at all in privacy mode (every label shows a name or a status),
 *  else placeLabels' result. Bubbles (icons only) are drawn either way. */
export function visibleLabels(
  inputs: LabelInput[],
  obstacles: Box[],
  privacy: boolean,
): LabelPlacement[] {
  return privacy ? [] : placeLabels(inputs, obstacles);
}

/** Gauge colour by share of context used: green < 60%, amber < 85%, red >= 85%. */
export const GAUGE_OK = 'var(--pixel-wp-gauge-ok)';
export const GAUGE_WARN = 'var(--pixel-wp-gauge-warn)';
export const GAUGE_HIGH = 'var(--pixel-wp-gauge-high)';

export function gaugeColor(used: number): string {
  if (used >= 0.85) return GAUGE_HIGH;
  if (used >= 0.6) return GAUGE_WARN;
  return GAUGE_OK;
}
