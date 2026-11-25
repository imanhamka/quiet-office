// quiet-office: the shape every locale file fills. en.ts and ms.ts must stay identical in shape;
// test/i18n.test.ts checks the keys, and the board/sign words against the pixel font.

export interface Locale {
  /** Active agent with no tool yet. */
  thinking: string;
  /** Appended as ` · <toolError>` when the last tool ended with an error. */
  toolError: string;
  /** Unit after whole hours in the wait clock (`2h+`). */
  hourSuffix: string;
  /** Prefix of a sub-agent status, replacing the wire's `Subtask:`. */
  subtaskPrefix: string;
  /** Wire status (exact match) to display text. */
  statusExact: Record<string, string>;
  /** Wire status verb prefix to display prefix; the rest (a file or tool name) is kept. */
  statusPrefixes: Record<string, string>;

  // Whiteboard and door signs: drawn in the 3x5 pixel font, upper case only.
  // A label pair is [full, short]: the short one is drawn when the full one and the
  // count do not fit the 28 px line of the 32x32 board.
  boardActive: [string, string];
  boardIdle: [string, string];
  boardSub: [string, string];
  boardSessions: [string, string];
  /** End-of-day board title, centred. */
  boardToday: string;
  /** Door sign of a booked team room in privacy mode (no lead name). */
  signBusy: string;
  /** Door sign of a free team room. */
  signFree: string;
}
