// quiet-office: colours of the generated wallpaper sprites (whiteboard scoreboard, door
// signs, alert rings, red PC screen, night glow, wall clock, room tint). Sprite art colours
// live under office/sprites, where the no-inline-colors rule is off.

// ── Whiteboard scoreboard ────────────────────────────────────────────────────
export const WP_BOARD_FRAME = '#4a4e4d';
export const WP_BOARD_RIM_TOP = '#d6d7d8';
export const WP_BOARD_RIM = '#b9bcbd';
export const WP_BOARD_SURFACE = '#efebe8';
export const WP_BOARD_TRAY = '#e9ecee';
export const WP_BOARD_MARKER_RED = '#d23b3b';
export const WP_BOARD_MARKER_BLUE = '#3b5fd2';
export const WP_INK_ACTIVE = '#1d6b38';
export const WP_INK_RESTING = '#253f7a';
export const WP_INK_SUB = '#3a3a44';
export const WP_INK_ALERT = '#c01f2a';

// ── Team-room door sign ──────────────────────────────────────────────────────
export const WP_SIGN_FRAME = '#20232b';
export const WP_SIGN_FACE = '#2e323d';
export const WP_SIGN_LAMP_BUSY = '#ff3b30';
export const WP_SIGN_LAMP_FREE = '#34d36a';
export const WP_SIGN_TEXT_BUSY = '#ffd27a';
export const WP_SIGN_TEXT_FREE = '#8ff0ae';

/** Booked team-room floor: one flat warm lift, no pattern. */
export const WP_ROOM_TINT = 'rgba(255,170,90,0.08)';

// ── Alert rings ──────────────────────────────────────────────────────────────
export const WP_RING_PERMISSION_RED = '#ff2b2b';
export const WP_RING_PERMISSION_WHITE = '#ffffff';
export const WP_RING_INPUT = '#ffad1f';

// ── Red PC screen (permission alert) ─────────────────────────────────────────
/** PC_FRONT_OFF screen colour. */
export const WP_PC_SCREEN_OFF = '#391624';
/** PC screen colours (off and the three on frames) → alarm red, by brightness. */
export const WP_PC_SCREEN_TO_RED: Readonly<Record<string, string>> = {
  [WP_PC_SCREEN_OFF]: '#5e0d16',
  '#41604f': '#5e0d16',
  '#535568': '#b3202a',
  '#4a655d': '#b3202a',
  '#548e61': '#d9343a',
  '#60c677': '#ff6a5c',
};

// ── Night PC glow ────────────────────────────────────────────────────────────
export const WP_NIGHT_GLOW_CORE = 'rgba(150,255,175,0.38)';
export const WP_NIGHT_GLOW_EDGE = 'rgba(120,235,160,0.26)';

// ── Wall clock ───────────────────────────────────────────────────────────────
/** Face pixels of the CLOCK sprite (the hands are drawn only over these). */
export const WP_CLOCK_FACE_COLORS: readonly string[] = ['#ededed', '#ececee', '#73787e'];
export const WP_CLOCK_OLD_HAND = '#73787e';
export const WP_CLOCK_FACE_FILL = '#ededed';
export const WP_CLOCK_HOUR_HAND = '#262d31';
export const WP_CLOCK_MINUTE_HAND = '#55606a';

// ── "all done" (everyone finished) ───────────────────────────────────────────
/** The office light dims for a minute: one flat translucent layer over the floor. */
export const WP_ALL_DONE_DIM = 'rgba(8,12,28,0.22)';

// ── Reception mail envelope ──────────────────────────────────────────────────
export const WP_MAIL_PAPER = '#f6f1e4';
export const WP_MAIL_EDGE = '#8a93a6';
export const WP_MAIL_SEAL = '#d23b3b';
