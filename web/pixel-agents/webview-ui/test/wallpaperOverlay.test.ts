// quiet-office: translated labels, wait clock, label declutter, daypart, wait store.
import { describe, expect, it } from 'vitest';

import { daypartAt, forcedDaypart } from '../src/daypart.js';
import {
  clearAllWaiting,
  clearWaiting,
  isAwaitingInput,
  markWaiting,
  waitingSince,
} from '../src/hooks/waitingSince.js';
import { middleEllipsis, statusText, waitClock, waitClockBucket } from '../src/i18n/index.js';
import {
  estimateSize,
  GAUGE_HIGH,
  GAUGE_OK,
  GAUGE_WARN,
  gaugeColor,
  type LabelInput,
  placeLabels,
} from '../src/office/components/wallpaperLabels.js';

describe('statusText (ms)', () => {
  const bm = (status: string, maxArg?: number) => statusText(status, maxArg, 'ms');
  it.each([
    ['Reading server.ts', 'Baca server.ts'],
    ['Editing App.tsx', 'Sunting App.tsx'],
    ['Writing notes.md', 'Tulis notes.md'],
    ['Running command', 'Jalan arahan'],
    ['Searching code', 'Cari kod'],
    ['Searching files', 'Cari fail'],
    ['Fetching web content', 'Ambil laman web'],
    ['Searching the web', 'Cari di web'],
    ['Subtask: Explore', 'Subtugas: Explore'],
    ['Subtask: general-purpose', 'Subtugas: general-purpose'],
    ['Running subtask', 'Subtugas'],
    ['Waiting for your answer', 'Tunggu jawapan'],
    ['Planning', 'Merancang'],
    ['Updating todos', 'Kemas senarai tugas'],
    ['Using mcp__x__y', 'Guna mcp__x__y'],
    ['Needs approval', 'PERLU KELULUSAN'],
    ['Waiting for input', 'Tunggu arahan'],
    ['Idle', 'Rehat'],
  ])('%s -> %s', (en, ms) => {
    expect(bm(en)).toBe(ms);
  });

  it('passes unknown strings through', () => {
    expect(bm('Compacting')).toBe('Compacting');
    expect(bm('')).toBe('');
    expect(bm('Reading ')).toBe('Reading ');
  });

  it('shortens the argument when asked', () => {
    expect(bm('Editing useExtensionMessages.ts', 16)).toBe('Sunting useExten…ages.ts');
    expect(bm('Reading a.ts', 16)).toBe('Baca a.ts');
  });
});

describe('statusText (en)', () => {
  const en = (status: string, maxArg?: number) => statusText(status, maxArg, 'en');
  it.each([
    ['Reading server.ts', 'Reading server.ts'],
    ['Running command', 'Running command'],
    ['Subtask: Explore', 'Subtask: Explore'],
    ['Running subtask', 'Subtask'],
    ['Needs approval', 'NEEDS APPROVAL'],
    ['Waiting for input', 'Waiting for input'],
    ['Idle', 'Idle'],
  ])('%s -> %s', (wire, shown) => {
    expect(en(wire)).toBe(shown);
  });

  it('passes unknown strings through and shortens the argument', () => {
    expect(en('Compacting')).toBe('Compacting');
    expect(en('Editing useExtensionMessages.ts', 16)).toBe('Editing useExten…ages.ts');
  });
});

describe('middleEllipsis', () => {
  it('keeps short text', () => {
    expect(middleEllipsis('quiet-office')).toBe('quiet-office');
    expect(middleEllipsis('a'.repeat(16))).toBe('a'.repeat(16));
  });
  it('cuts the middle to 16 chars', () => {
    const out = middleEllipsis('acme-sso-server-laravel');
    expect(out).toBe('acme-sso…laravel');
    expect(out).toHaveLength(16);
  });
});

describe('waitClock', () => {
  it('shows m:ss under 5 minutes', () => {
    expect(waitClock(0)).toBe('0:00');
    expect(waitClock(9_999)).toBe('0:09');
    expect(waitClock(120_000)).toBe('2:00');
    expect(waitClock(299_999)).toBe('4:59');
  });
  it('goes coarse from 5 minutes', () => {
    expect(waitClock(300_000)).toBe('5m+');
    expect(waitClock(59 * 60_000 + 59_000)).toBe('59m+');
    expect(waitClock(2 * 3_600_000, 'en')).toBe('2h+');
    expect(waitClock(2 * 3_600_000, 'ms')).toBe('2j+');
  });
  it('clamps negative (clock skew) to zero', () => {
    expect(waitClock(-5_000)).toBe('0:00');
  });
  it('buckets per second, then per minute', () => {
    expect(waitClockBucket(1_000)).not.toBe(waitClockBucket(2_000));
    expect(waitClockBucket(1_000)).toBe(waitClockBucket(1_900));
    expect(waitClockBucket(301_000)).toBe(waitClockBucket(359_000));
    expect(waitClockBucket(359_000)).not.toBe(waitClockBucket(360_000));
  });
});

function lab(over: Partial<LabelInput> & { id: number }): LabelInput {
  return {
    kind: 'active',
    x: 100,
    bottom: 200,
    status: 'Reading server.ts',
    name: 'ejen',
    gauge: false,
    ...over,
  };
}

describe('placeLabels', () => {
  it('orders permission > input > active > idle, then id', () => {
    const out = placeLabels([
      lab({ id: 1, kind: 'idle', status: null, x: 0 }),
      lab({ id: 2, kind: 'active', x: 400 }),
      lab({ id: 3, kind: 'input', x: 800 }),
      lab({ id: 4, kind: 'permission', x: 1200 }),
    ]);
    expect(out.map((p) => p.id)).toEqual([4, 3, 2, 1]);
    expect(out.every((p) => p.dy === 0 && !p.hidden)).toBe(true);
  });

  it('nudges an overlapping label up by its own height', () => {
    const [a, b] = placeLabels([lab({ id: 1 }), lab({ id: 2, x: 110 })]);
    expect(a.dy).toBe(0);
    expect(b.dy).toBeLessThan(0);
    expect(b.showStatus).toBe(true);
  });

  it('drops the status line when nudging is not enough', () => {
    const out = placeLabels([
      lab({ id: 1, kind: 'permission' }),
      lab({ id: 2, kind: 'permission', bottom: 160 }),
      lab({ id: 3, kind: 'active', x: 105, bottom: 200 }),
    ]);
    const third = out.find((p) => p.id === 3);
    expect(third?.hidden).toBe(false);
    expect(third?.showStatus).toBe(false);
  });

  it('hides an idle label that overlaps after the nudge', () => {
    const out = placeLabels([
      lab({ id: 1, kind: 'active' }),
      lab({ id: 2, kind: 'active', bottom: 158 }),
      lab({ id: 3, kind: 'idle', status: null, name: 'nota' }),
    ]);
    expect(out.find((p) => p.id === 3)?.hidden).toBe(true);
  });
});

describe('placeLabels door-sign obstacles', () => {
  const overlaps = (a: { l: number; r: number; t: number; b: number }, b: typeof a) =>
    a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

  it('slides a label aside, keeping its status line, instead of covering a sign', () => {
    const input = lab({ id: 1, kind: 'active', x: 100, bottom: 100 });
    const size = estimateSize(input.status, input.name, input.gauge);
    // A sign under the label's right half.
    const sign = { l: 110, r: 200, t: 80, b: 95 };
    const [p] = placeLabels([input], [sign]);
    expect(p.dy).toBe(0);
    expect(p.showStatus).toBe(true);
    expect(p.dx).toBeLessThan(0);
    const box = { l: 100 + p.dx - size.w / 2, r: 100 + p.dx + size.w / 2, t: 100 - size.h, b: 100 };
    expect(overlaps(box, sign)).toBe(false);
  });

  it('labels clear of every sign are untouched', () => {
    const [p] = placeLabels([lab({ id: 1, x: 100, bottom: 100 })], [{ l: 400, r: 480, t: 80, b: 95 }]);
    expect(p).toMatchObject({ dx: 0, dy: 0, showStatus: true, hidden: false });
  });

  it('a sub-agent tag that cannot clear a wide sign hides rather than cover it', () => {
    const out = placeLabels(
      [lab({ id: 2, kind: 'sub', status: '↳ Cari fail', name: '', statusFont: 16, x: 100, bottom: 100 })],
      [{ l: -400, r: 600, t: 0, b: 200 }],
    );
    expect(out[0].hidden).toBe(true);
  });
});

describe('placeLabels sub-agent tags', () => {
  it('rank below active leads and above idle', () => {
    const out = placeLabels([
      lab({ id: 1, kind: 'idle', status: null, x: 0 }),
      lab({ id: 2, kind: 'sub', status: '↳ Cari fail', statusFont: 16, nameFont: 12, x: 400 }),
      lab({ id: 3, kind: 'active', x: 800 }),
    ]);
    expect(out.map((p) => p.id)).toEqual([3, 2, 1]);
  });
  it('hide instead of dropping their only line', () => {
    const out = placeLabels([
      lab({ id: 1, kind: 'active' }),
      lab({ id: 2, kind: 'active', bottom: 158 }),
      lab({ id: 3, kind: 'sub', status: '↳ Cari fail', name: '', statusFont: 16 }),
    ]);
    expect(out.find((p) => p.id === 3)).toMatchObject({ hidden: true, showStatus: false });
  });
});

describe('gaugeColor', () => {
  it('green < 60%, amber < 85%, red >= 85%', () => {
    expect(gaugeColor(0.3)).toBe(GAUGE_OK);
    expect(gaugeColor(0.6)).toBe(GAUGE_WARN);
    expect(gaugeColor(0.849)).toBe(GAUGE_WARN);
    expect(gaugeColor(0.85)).toBe(GAUGE_HIGH);
  });
});

describe('daypart', () => {
  const at = (h: number, m: number) => daypartAt(new Date(2026, 10, 25, h, m));
  it('follows the local clock boundaries', () => {
    expect(at(7, 0)).toBe('day');
    expect(at(18, 29)).toBe('day');
    expect(at(18, 30)).toBe('dusk');
    expect(at(19, 29)).toBe('dusk');
    expect(at(19, 30)).toBe('night');
    expect(at(0, 0)).toBe('night');
    expect(at(6, 29)).toBe('night');
    expect(at(6, 30)).toBe('dawn');
    expect(at(6, 59)).toBe('dawn');
  });
  it('reads ?daypart= for testing', () => {
    expect(forcedDaypart('?wallpaper=1&daypart=night')).toBe('night');
    expect(forcedDaypart('?daypart=noon')).toBeNull();
    expect(forcedDaypart('')).toBeNull();
  });
});

describe('waitingSince store', () => {
  it('prefers the server time and keeps the first sighting otherwise', () => {
    clearAllWaiting();
    markWaiting(1, 'permission', undefined, 5_000);
    markWaiting(1, 'permission', undefined, 9_000);
    expect(waitingSince(1, 'permission')).toBe(5_000);
    markWaiting(1, 'permission', 1_000, 9_000);
    expect(waitingSince(1, 'permission')).toBe(1_000);
    // A future server time is clamped to now.
    markWaiting(2, 'input', 50_000, 10_000);
    expect(waitingSince(2, 'input')).toBe(10_000);
    expect(isAwaitingInput(2)).toBe(true);
    clearWaiting(2, 'input');
    expect(isAwaitingInput(2)).toBe(false);
    clearWaiting(1);
    expect(waitingSince(1, 'permission')).toBeUndefined();
  });
});
