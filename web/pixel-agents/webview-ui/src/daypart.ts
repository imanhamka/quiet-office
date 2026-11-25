// quiet-office: day/night tint from the local clock. App.tsx paints the tint;
// the engine reads `document.documentElement.dataset.daypart === 'night'` for PC glow.

export type Daypart = 'day' | 'dusk' | 'night' | 'dawn';

const DAYPARTS: readonly Daypart[] = ['day', 'dusk', 'night', 'dawn'];

/** Dayparts that get the multiply tint. Colours: `.daypart-tint` in index.css
 *  (dusk #ffd8a8, night #4a5a9a, dawn #ffe2c4). */
export function isTinted(part: Daypart): boolean {
  return part !== 'day';
}

/** 07:00-18:29 day, 18:30-19:29 dusk, 19:30-06:29 night, 06:30-06:59 dawn. */
export function daypartAt(date: Date): Daypart {
  const m = date.getHours() * 60 + date.getMinutes();
  if (m >= 7 * 60 && m < 18 * 60 + 30) return 'day';
  if (m >= 18 * 60 + 30 && m < 19 * 60 + 30) return 'dusk';
  if (m >= 6 * 60 + 30 && m < 7 * 60) return 'dawn';
  return 'night';
}

/** `?daypart=night` (etc.) pins the value for testing; anything else -> null. */
export function forcedDaypart(search: string): Daypart | null {
  const v = new URLSearchParams(search).get('daypart');
  return v && (DAYPARTS as readonly string[]).includes(v) ? (v as Daypart) : null;
}

/** The daypart to show: a forced `day` / `night` option wins, then `?daypart=`, then the clock. */
export function resolveDaypart(option: 'auto' | 'day' | 'night', search: string, date: Date): Daypart {
  if (option !== 'auto') return option;
  return forcedDaypart(search) ?? daypartAt(date);
}
