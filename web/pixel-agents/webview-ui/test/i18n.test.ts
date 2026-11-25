// quiet-office: display language (en default, ms), locale shape, and pixel-font fit of the
// whiteboard and door-sign words.
import { describe, expect, it } from 'vitest';

import {
  langFromNavigator,
  parseLang,
  resolveLang,
  statusText,
  t,
  waitClock,
} from '../src/i18n/index.js';
import type { Locale } from '../src/i18n/locale.js';
import { en } from '../src/i18n/locales/en.js';
import { ms } from '../src/i18n/locales/ms.js';
import {
  boardLabel,
  buildDoorSign,
  buildEndOfDaySprite,
  buildWhiteboardSprite,
  fitsBoardLine,
  missingGlyphs,
  SIGN_W,
  textWidth,
} from '../src/office/engine/whiteboard.js';

const LOCALES: Array<[string, Locale]> = [
  ['en', en],
  ['ms', ms],
];

describe('locale files', () => {
  it('en and ms have the same keys, status keys and prefixes', () => {
    expect(Object.keys(ms).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ms.statusExact).sort()).toEqual(Object.keys(en.statusExact).sort());
    expect(Object.keys(ms.statusPrefixes).sort()).toEqual(Object.keys(en.statusPrefixes).sort());
  });

  it('every value is a non-empty string (pairs: two of them)', () => {
    for (const [, loc] of LOCALES) {
      for (const [key, value] of Object.entries(loc)) {
        if (typeof value === 'string') expect(value, key).not.toBe('');
        else if (Array.isArray(value)) {
          expect(value, key).toHaveLength(2);
          for (const v of value) expect(v, key).not.toBe('');
        } else for (const v of Object.values(value)) expect(v, key).not.toBe('');
      }
    }
  });
});

describe('pixel-font fit', () => {
  const boardPairs = ['boardActive', 'boardIdle', 'boardSub', 'boardSessions'] as const;

  it.each(LOCALES)('%s: every board and sign word has glyphs (upper case only)', (_, loc) => {
    const words = [
      ...boardPairs.flatMap((k) => loc[k]),
      loc.boardToday,
      loc.signBusy,
      loc.signFree,
    ];
    for (const w of words) {
      expect(missingGlyphs(w), w).toEqual([]);
      expect(w, w).toBe(w.toUpperCase());
    }
  });

  it.each(LOCALES)('%s: labels fit beside their counts (live up to 99, end of day up to 999)', (_, loc) => {
    const max = { boardActive: '99', boardIdle: '99', boardSub: '999', boardSessions: '999' };
    for (const k of boardPairs) {
      for (const num of ['0', '7', '42', '99', '999'].filter((n) => n.length <= max[k].length)) {
        expect(fitsBoardLine(boardLabel(loc[k], num), num), `${loc[k][1]} ${num}`).toBe(true);
      }
    }
    expect(fitsBoardLine(loc.boardToday, '')).toBe(true);
  });

  it.each(LOCALES)('%s: sign words fit the narrowest sign', (_, loc) => {
    // Lamp + text from x 8, 3 px of face, then the frame.
    for (const w of [loc.signBusy, loc.signFree]) expect(8 + textWidth(w) + 3).toBeLessThanOrEqual(SIGN_W);
  });

  it('drawn sprites differ by language and stay 32x32', () => {
    const counts = { active: 2, resting: 3, subagents: 1, alerts: 0 };
    const stats = { day: '2026-11-25', sessions: 4, subtasks: 9 };
    expect(buildWhiteboardSprite(counts, 'en')).not.toEqual(buildWhiteboardSprite(counts, 'ms'));
    expect(buildEndOfDaySprite(stats, 'en')).not.toEqual(buildEndOfDaySprite(stats, 'ms'));
    expect(buildDoorSign(null, SIGN_W, 'en')).not.toEqual(buildDoorSign(null, SIGN_W, 'ms'));
    for (const lang of ['en', 'ms'] as const) {
      const g = buildWhiteboardSprite(counts, lang);
      expect(g).toHaveLength(32);
      expect(g.every((row) => row.length === 32)).toBe(true);
    }
  });
});

describe('t()', () => {
  it('English', () => {
    expect(t('thinking', 'en')).toBe('Thinking');
    expect(t('toolError', 'en')).toBe('error');
    expect(t('boardActive', 'en')).toEqual(['ACTIVE', 'ACT']);
    expect(t('boardIdle', 'en')[0]).toBe('IDLE');
    expect(t('boardSub', 'en')[0]).toBe('SUB');
    expect(t('boardToday', 'en')).toBe('TODAY');
    expect(t('boardSessions', 'en')[0]).toBe('SESSIONS');
    expect(t('signBusy', 'en')).toBe('BUSY');
    expect(t('signFree', 'en')).toBe('FREE');
  });

  it('Malay', () => {
    expect(t('thinking', 'ms')).toBe('Berfikir');
    expect(t('toolError', 'ms')).toBe('ralat');
    expect(t('boardActive', 'ms')[0]).toBe('AKTIF');
    expect(t('boardIdle', 'ms')[0]).toBe('REHAT');
    expect(t('boardSub', 'ms')[0]).toBe('SUB');
    expect(t('boardToday', 'ms')).toBe('HARI INI');
    expect(t('boardSessions', 'ms')[0]).toBe('SESI');
    expect(t('signBusy', 'ms')).toBe('SIBUK');
    expect(t('signFree', 'ms')).toBe('KOSONG');
  });

  it('statuses and the wait clock per language', () => {
    expect(statusText('Reading routes.ts', 16, 'en')).toBe('Reading routes.ts');
    expect(statusText('Reading routes.ts', 16, 'ms')).toBe('Baca routes.ts');
    expect(statusText('Subtask: Explore', undefined, 'en')).toBe('Subtask: Explore');
    expect(statusText('Subtask: Explore', undefined, 'ms')).toBe('Subtugas: Explore');
    expect(waitClock(3 * 3_600_000, 'en')).toBe('3h+');
    expect(waitClock(3 * 3_600_000, 'ms')).toBe('3j+');
  });
});

describe('language choice', () => {
  it('parseLang takes en / ms only', () => {
    expect(parseLang('en')).toBe('en');
    expect(parseLang(' MS ')).toBe('ms');
    for (const bad of ['fr', 'auto', '', 'english', null, undefined, 1, {}]) {
      expect(parseLang(bad), String(bad)).toBeNull();
    }
  });

  it('navigator: ms* gives ms, anything else en', () => {
    for (const tag of ['ms', 'ms-MY', 'ms_BN', 'MS-my']) expect(langFromNavigator(tag), tag).toBe('ms');
    for (const tag of ['en-US', 'en', 'id-ID', 'msa', 'fr', '', undefined, null]) {
      expect(langFromNavigator(tag), String(tag)).toBe('en');
    }
  });

  it('precedence: setOptions > ?lang= > wallpaperConfig.lang > navigator', () => {
    const base = { option: null, url: null, config: null, navigator: 'ms-MY' } as const;
    expect(resolveLang(base)).toBe('ms');
    expect(resolveLang({ ...base, config: 'en' })).toBe('en');
    expect(resolveLang({ ...base, config: 'en', url: 'ms' })).toBe('ms');
    expect(resolveLang({ ...base, config: 'ms', url: 'ms', option: 'en' })).toBe('en');
    expect(resolveLang({ ...base, navigator: 'en-GB' })).toBe('en');
    expect(resolveLang({ ...base, navigator: undefined })).toBe('en');
  });
});
