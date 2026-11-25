// quiet-office: display language for the wallpaper (English default, Malay). The wire stays
// English (the server sends English status strings); text is translated only when drawn.
//
// Language, first match wins:
//   1. the host's `__wallpaper.setOptions({ lang })`
//   2. the page URL's `?lang=`
//   3. the server's `wallpaperConfig.lang` (config.json)
//   4. navigator.language: `ms*` gives Malay, anything else English

import type { Locale } from './locale.js';
import { en } from './locales/en.js';
import { ms } from './locales/ms.js';

export type Lang = 'en' | 'ms';
export type { Locale };

const LOCALES: Record<Lang, Locale> = { en, ms };

/** `en` or `ms` (any case, trimmed); anything else is null. */
export function parseLang(raw: unknown): Lang | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return v === 'en' || v === 'ms' ? v : null;
}

/** Browser language tag to a supported language: `ms`, `ms-MY` ... give `ms`, else `en`. */
export function langFromNavigator(tag: string | undefined | null): Lang {
  return typeof tag === 'string' && /^ms(?:$|[-_])/i.test(tag.trim()) ? 'ms' : 'en';
}

export interface LangSources {
  option: Lang | null;
  url: Lang | null;
  config: Lang | null;
  navigator: string | undefined | null;
}

/** The precedence above, as a pure function. */
export function resolveLang(s: LangSources): Lang {
  return s.option ?? s.url ?? s.config ?? langFromNavigator(s.navigator);
}

const sources: LangSources = {
  option: null,
  url:
    typeof window !== 'undefined'
      ? parseLang(new URLSearchParams(window.location.search).get('lang'))
      : null,
  config: null,
  navigator: typeof navigator !== 'undefined' ? navigator.language : null,
};
let current: Lang = resolveLang(sources);
const listeners = new Set<(lang: Lang) => void>();

function update(): void {
  const next = resolveLang(sources);
  if (next === current) return;
  current = next;
  for (const cb of listeners) cb(next);
}

export function getLang(): Lang {
  return current;
}

export function onLangChange(cb: (lang: Lang) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Host override (`setOptions({ lang })`); null clears it. */
export function setOptionLang(lang: Lang | null): void {
  sources.option = lang;
  update();
}

/** `wallpaperConfig.lang` from the server: `en` / `ms`, anything else (null = auto) clears it. */
export function setConfigLang(raw: unknown): void {
  sources.config = parseLang(raw);
  update();
}

/** A locale entry in `lang` (default: the current language). */
export function t<K extends keyof Locale>(key: K, lang: Lang = current): Locale[K] {
  return LOCALES[lang][key];
}

/** Display text for an English wire status. Unknown strings pass through unchanged.
 *  `maxArg` middle-ellipsizes the file basename / tool name after the verb. */
export function statusText(status: string, maxArg?: number, lang: Lang = current): string {
  const loc = LOCALES[lang];
  const exact = loc.statusExact[status];
  if (exact !== undefined) return exact;
  if (status.startsWith('Subtask:')) return `${loc.subtaskPrefix}${status.slice('Subtask:'.length)}`;
  for (const [wire, shown] of Object.entries(loc.statusPrefixes)) {
    if (status.startsWith(wire) && status.length > wire.length) {
      const arg = status.slice(wire.length);
      return shown + (maxArg ? middleEllipsis(arg, maxArg) : arg);
    }
  }
  return status;
}

/** Shorten to `max` chars by cutting the middle: `billing-service-api` -> `billing-…ice-api`. */
export function middleEllipsis(text: string, max = 16): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

/** Waits of 5 min or more switch to coarse minutes. */
export const WAIT_COARSE_SEC = 300;

/** `m:ss` under 5 min, then `5m+`, `6m+`, ... and `1h+` (`1j+` in Malay) past an hour. */
export function waitClock(elapsedMs: number, lang: Lang = current): string {
  const sec = Math.max(0, Math.floor(elapsedMs / 1000));
  if (sec < WAIT_COARSE_SEC) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m)}:${String(s).padStart(2, '0')}`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) return `${String(min)}m+`;
  return `${String(Math.floor(min / 60))}${LOCALES[lang].hourSuffix}+`;
}

/** Value that changes exactly when `waitClock` output changes (overlay re-render key). */
export function waitClockBucket(elapsedMs: number): number {
  const sec = Math.max(0, Math.floor(elapsedMs / 1000));
  return sec < WAIT_COARSE_SEC ? sec : WAIT_COARSE_SEC + Math.floor(sec / 60);
}
