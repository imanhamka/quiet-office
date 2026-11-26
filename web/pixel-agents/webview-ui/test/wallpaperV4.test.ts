/**
 * quiet-office: CONTRACT v4 — host options (privacy, daypart, lang), today's stats on the
 * end-of-day whiteboard, "all done", and the reception agent (wallpaperConfig) with the
 * mail envelope.
 *
 * Fixture: the real wallpaper layout (public/assets/default-layout-2.json, from
 * scripts/gen-layout.py) with the real furniture catalog (manifest footprints, blank sprites).
 *   open plan: 9 benches at (3|7|11, 5|9|13) facing up; reception chair (2,14) facing down
 *   on the back row of a small desk (2..3, 14..15); entrance (1,15).
 *   lounge: sofas around a coffee table at (19,4); ROOM 1 / ROOM 2 below row 8.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, test, vi } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.js';
import { resolveDaypart } from '../src/daypart.js';
import { getLang, setConfigLang, t } from '../src/i18n/index.js';
import {
  type LabelInput,
  placeLabels,
  visibleLabels,
} from '../src/office/components/wallpaperLabels.js';
import {
  ALL_DONE_DIM_SEC,
  ALL_DONE_WORK_MS,
  MAIL_SEC,
  OfficeState,
  REPLAY_HOLD_MS,
} from '../src/office/engine/officeState.js';
import { ENVELOPE } from '../src/office/engine/wallpaperDecor.js';
import {
  buildDoorSign,
  buildEndOfDaySprite,
  buildWhiteboardSprite,
  endOfDayLines,
  fitsBoardLine,
  isEndOfDay,
} from '../src/office/engine/whiteboard.js';
import {
  buildDynamicCatalog,
  type LoadedAssetData,
} from '../src/office/layout/furnitureCatalog.js';
import { findPath, getWalkableTiles } from '../src/office/layout/tileMap.js';
import { WP_ALL_DONE_DIM } from '../src/office/sprites/wallpaperPalette.js';
import type { Character, OfficeLayout, SpriteData } from '../src/office/types.js';
import { CharacterState, Direction } from '../src/office/types.js';
import { getWallpaperOptions, setWallpaperOptions } from '../src/wallpaper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, '..', 'public', 'assets');
const LAYOUT = JSON.parse(
  fs.readFileSync(path.join(ASSETS, 'default-layout-2.json'), 'utf-8'),
) as OfficeLayout & { wallpaperReception: { col: number; row: number } };

beforeAll(() => {
  const catalog = buildFurnitureCatalog(ASSETS) as unknown as LoadedAssetData['catalog'];
  const blank = (w: number, h: number): SpriteData =>
    Array.from({ length: h }, () => new Array<string>(w).fill('black'));
  const sprites = Object.fromEntries(catalog.map((a) => [a.id, blank(a.width, a.height)]));
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
  // Config-level English, so results do not depend on the machine's language.
  setConfigLang('en');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  setWallpaperOptions({ privacy: false, daypart: 'auto', lang: 'auto' });
});

/** The demo's reception agent (config.json `reception.agent`). */
const RECEPTION = 'Relay';

/** The real office in wallpaper mode, with a controllable wall clock (ms). */
function office(reception: string | null = RECEPTION): { os: OfficeState; clock: { t: number } } {
  const os = new OfficeState(structuredClone(LAYOUT));
  os.wpMode = true;
  os.setReceptionAgent(reception);
  const clock = { t: 1_000_000 };
  os.wpNow = () => clock.t;
  return { os, clock };
}

function seatAt(os: OfficeState, col: number, row: number): string {
  const uid = os.getSeatAtTile(col, row);
  assert.ok(uid, `a seat at ${String(col)},${String(row)}`);
  return uid;
}

/** Advance `seconds` of frames, moving the wall clock along. */
function run(os: OfficeState, clock: { t: number }, seconds: number, dt = 0.1): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    clock.t += dt * 1000;
    os.update(dt);
  }
}

function at(ch: Character): string {
  return `${String(ch.tileCol)},${String(ch.tileRow)}`;
}

const hasSprite = (os: OfficeState, sprite: SpriteData) =>
  os.furniture.some((f) => f.sprite === sprite);
const dimmed = (os: OfficeState) => os.furniture.some((f) => f.sprite[0]?.[0] === WP_ALL_DONE_DIM);

// ── setOptions ───────────────────────────────────────────────────────────────

describe('setOptions', () => {
  test('defaults until called: privacy off, daypart auto, lang auto', () => {
    assert.deepEqual(getWallpaperOptions(), { privacy: false, daypart: 'auto', lang: null });
  });

  test('lang: en / ms force the language, auto clears it; anything else is ignored', () => {
    assert.equal(getLang(), 'en', 'config');
    for (const bad of [{ lang: 'MS' }, { lang: 'fr' }, { lang: ' ms' }, { lang: 1 }, { lang: null }]) {
      assert.equal(setWallpaperOptions(bad), false, JSON.stringify(bad));
    }
    assert.equal(setWallpaperOptions({ lang: 'ms' }), true);
    assert.equal(getWallpaperOptions().lang, 'ms');
    assert.equal(getLang(), 'ms', 'host option beats config');
    setConfigLang('en');
    assert.equal(getLang(), 'ms', 'a config change does not beat the option');
    assert.equal(setWallpaperOptions({ lang: 'auto' }), true);
    assert.equal(getWallpaperOptions().lang, null);
    assert.equal(getLang(), 'en', 'back to the config language');
  });

  test('lang: switching redraws the whiteboard and the door signs', () => {
    const { os, clock } = office();
    os.addAgent(1, undefined, undefined, seatAt(os, 3, 5), true, 'infra');
    os.addSubagent(1, 'tool-1');
    run(os, clock, 1);
    const roomW = 8 * 16 - 2; // ROOM 2 is free: its sign says FREE / KOSONG
    const counts = { active: 1, resting: 0, subagents: 1, alerts: 0 };
    const sprites = () => os.furniture.map((f) => JSON.stringify(f.sprite));
    assert.ok(sprites().includes(JSON.stringify(buildWhiteboardSprite(counts, 'en'))));
    assert.ok(sprites().includes(JSON.stringify(buildDoorSign(null, roomW, 'en'))));

    setWallpaperOptions({ lang: 'ms' });
    run(os, clock, 0.2);
    assert.ok(sprites().includes(JSON.stringify(buildWhiteboardSprite(counts, 'ms'))), 'AKTIF');
    assert.ok(sprites().includes(JSON.stringify(buildDoorSign(null, roomW, 'ms'))), 'KOSONG');
    assert.ok(!sprites().includes(JSON.stringify(buildDoorSign(null, roomW, 'en'))), 'no FREE');
  });

  test('takes booleans and the three daypart strings; ignores anything else', () => {
    for (const bad of [
      null,
      undefined,
      1,
      'privacy',
      [true],
      { privacy: 'true' },
      { privacy: 1 },
      { daypart: 'dusk' },
      { daypart: 'NIGHT' },
      { daypart: 2 },
      { other: true },
    ]) {
      assert.equal(setWallpaperOptions(bad), false, JSON.stringify(bad));
    }
    assert.deepEqual(getWallpaperOptions(), { privacy: false, daypart: 'auto', lang: null });

    assert.equal(setWallpaperOptions({ privacy: true, daypart: 'bogus' }), true);
    assert.deepEqual(
      getWallpaperOptions(),
      { privacy: true, daypart: 'auto', lang: null },
      'valid field kept, bad one dropped',
    );
    assert.equal(setWallpaperOptions({ daypart: 'night' }), true);
    assert.deepEqual(
      getWallpaperOptions(),
      { privacy: true, daypart: 'night', lang: null },
      'partial update',
    );
    assert.equal(setWallpaperOptions({ privacy: true, daypart: 'night' }), false, 'no change');
  });

  test('privacy: no overlay labels at all; placement otherwise unchanged', () => {
    const inputs: LabelInput[] = [
      {
        id: 1,
        kind: 'active',
        x: 100,
        bottom: 100,
        status: 'Reading a.ts',
        name: 'infra',
        gauge: true,
      },
      { id: -1, kind: 'sub', x: 300, bottom: 100, status: '↳ Searching files', name: '', gauge: false },
      { id: 2, kind: 'idle', x: 500, bottom: 100, status: null, name: 'notes', gauge: false },
    ];
    assert.deepEqual(visibleLabels(inputs, [], false), placeLabels(inputs, []));
    assert.equal(visibleLabels(inputs, [], false).filter((p) => !p.hidden).length, 3);
    assert.deepEqual(visibleLabels(inputs, [], true), []);
  });

  test('privacy: a booked door sign says BUSY, not the lead name; whiteboard stays', () => {
    const { os, clock } = office();
    os.addAgent(1, undefined, undefined, seatAt(os, 3, 5), true, 'infra');
    os.addSubagent(1, 'tool-1');
    run(os, clock, 1);
    const roomW = 8 * 16 - 2; // ROOM 1: cols 15..22
    const named = JSON.stringify(buildDoorSign('infra', roomW));
    const busy = JSON.stringify(buildDoorSign(t('signBusy'), roomW));
    const signs = () => os.furniture.map((f) => JSON.stringify(f.sprite));
    assert.ok(signs().includes(named), 'lead name before privacy');

    setWallpaperOptions({ privacy: true });
    run(os, clock, 0.2);
    assert.ok(signs().includes(busy), 'BUSY');
    assert.ok(!signs().includes(named), 'no name anywhere');
    assert.ok(
      signs().includes(JSON.stringify(buildDoorSign(null, roomW))),
      'the free room still says FREE',
    );
    const board = buildWhiteboardSprite({ active: 1, resting: 0, subagents: 1, alerts: 0 });
    assert.ok(signs().includes(JSON.stringify(board)), 'whiteboard counts stay');

    setWallpaperOptions({ privacy: false });
    run(os, clock, 0.2);
    assert.ok(signs().includes(named), 'name back');
  });
});

// ── daypart ──────────────────────────────────────────────────────────────────

describe('daypart option', () => {
  const noon = new Date(2026, 10, 25, 12, 0);
  const late = new Date(2026, 10, 25, 23, 0);
  test('day / night force it over the clock and over ?daypart=', () => {
    assert.equal(resolveDaypart('night', '', noon), 'night');
    assert.equal(resolveDaypart('day', '', late), 'day');
    assert.equal(resolveDaypart('day', '?daypart=night', late), 'day');
  });
  test('auto follows ?daypart=, then the clock', () => {
    assert.equal(resolveDaypart('auto', '?daypart=dusk', noon), 'dusk');
    assert.equal(resolveDaypart('auto', '', noon), 'day');
    assert.equal(resolveDaypart('auto', '', late), 'night');
  });
});

// ── "all done" ───────────────────────────────────────────────────────────────

describe('all done', () => {
  function team() {
    const { os, clock } = office();
    os.addAgent(1, undefined, undefined, seatAt(os, 3, 5), true, 'infra');
    os.addAgent(2, undefined, undefined, seatAt(os, 7, 5), true, 'blog');
    os.setAgentActive(1, true);
    os.setAgentActive(2, true);
    run(os, clock, 1);
    return { os, clock };
  }
  const finish = (os: OfficeState) => {
    os.setAgentActive(1, false);
    os.setAgentActive(2, false);
  };

  test('after 10 min of work, all idle: everyone stretches, walks to the lounge; light dims ~1 min', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { os, clock } = team();
    clock.t += ALL_DONE_WORK_MS;
    os.setAgentActive(2, false); // one done, the other still working
    run(os, clock, 1);
    assert.equal(os.isAllDoneDimmed(), false, 'not while someone works');
    os.setAgentActive(1, false);
    run(os, clock, 0.2);
    assert.ok(os.isAllDoneDimmed() && dimmed(os), 'dim on');
    const a = os.characters.get(1)!;
    const b = os.characters.get(2)!;
    assert.ok(os.isStretching(1) && os.isStretching(2));
    const dirs = new Set<Direction>();
    for (let i = 0; i < 15; i++) {
      run(os, clock, 0.1);
      dirs.add(a.dir);
    }
    assert.ok(dirs.size >= 3, 'turns round on the spot');
    run(os, clock, 1);
    assert.ok(!os.isStretching(1), 'stretch over');
    run(os, clock, 25);
    for (const ch of [a, b]) {
      assert.ok(
        ch.tileCol >= 15 && ch.tileRow >= 2 && ch.tileRow <= 7,
        `${at(ch)} is in the lounge`,
      );
    }
    run(os, clock, ALL_DONE_DIM_SEC - 25);
    assert.ok(!os.isAllDoneDimmed() && !dimmed(os), 'dim off after a minute');
  });

  test('under 10 min of work: nothing', () => {
    const { os, clock } = team();
    clock.t += ALL_DONE_WORK_MS - 60_000;
    finish(os);
    run(os, clock, 3);
    assert.equal(os.isAllDoneDimmed(), false);
    assert.ok(!os.isStretching(1));
  });

  test('the dim ends a minute later by the clock, even if the loop was paused (wallpaper covered)', () => {
    const { os, clock } = team();
    clock.t += ALL_DONE_WORK_MS;
    finish(os);
    run(os, clock, 0.2);
    assert.ok(os.isAllDoneDimmed() && dimmed(os));
    clock.t += (ALL_DONE_DIM_SEC + 5) * 1000; // covered: no updates for over a minute
    os.update(0.1); // the first frame after it shows again
    assert.ok(!os.isAllDoneDimmed() && !dimmed(os), 'not dim on the first visible frame');
  });

  test('once per work period: a short new period after it does not fire again', () => {
    const { os, clock } = team();
    clock.t += ALL_DONE_WORK_MS;
    finish(os);
    run(os, clock, 0.2);
    assert.ok(os.isAllDoneDimmed());
    run(os, clock, ALL_DONE_DIM_SEC + 1);
    assert.ok(!os.isAllDoneDimmed());
    os.setAgentActive(1, true);
    run(os, clock, 60);
    os.setAgentActive(1, false);
    run(os, clock, 1);
    assert.equal(os.isAllDoneDimmed(), false, 'a 1-min period is not a work period');
    run(os, clock, 1);
    assert.equal(os.isAllDoneDimmed(), false, 'still idle: no repeat');
  });

  test('not on a reconnect replay that leaves everyone idle', () => {
    const { os, clock } = team();
    clock.t += ALL_DONE_WORK_MS * 2;
    os.noteReplay(); // existingAgents
    finish(os); // resync: every agent at rest until the replay says otherwise
    run(os, clock, (REPLAY_HOLD_MS / 1000) * 2);
    assert.equal(os.isAllDoneDimmed(), false);
    assert.ok(!os.isStretching(1) && !os.isStretching(2));
  });

  test('not on startup: agents replayed active then idle', () => {
    const { os, clock } = office();
    os.noteReplay();
    os.addAgent(1, undefined, undefined, seatAt(os, 3, 5), true, 'infra'); // created active
    clock.t += ALL_DONE_WORK_MS; // a slow first frame
    os.setAgentActive(1, false); // the replayed status: idle
    run(os, clock, 10);
    assert.equal(os.isAllDoneDimmed(), false);
  });

  test('after a replay that keeps work going, a real finish still counts', () => {
    const { os, clock } = team();
    clock.t += ALL_DONE_WORK_MS;
    os.noteReplay();
    finish(os);
    os.setAgentActive(1, true); // replayed: still working
    run(os, clock, REPLAY_HOLD_MS / 1000 + 1);
    os.setAgentActive(1, false);
    run(os, clock, 0.2);
    assert.ok(os.isAllDoneDimmed());
  });

  test('a sub-agent still working keeps the period open', () => {
    const { os, clock } = team();
    os.addSubagent(1, 'tool-1');
    clock.t += ALL_DONE_WORK_MS;
    finish(os);
    run(os, clock, 2);
    assert.equal(os.isAllDoneDimmed(), false);
  });
});

// ── End-of-day whiteboard ────────────────────────────────────────────────────

describe('end-of-day whiteboard', () => {
  test('window: 18:30 until 06:00 local', () => {
    const t = (h: number, m: number) => isEndOfDay(new Date(2026, 10, 25, h, m));
    assert.equal(t(18, 29), false);
    assert.equal(t(18, 30), true);
    assert.equal(t(23, 59), true);
    assert.equal(t(0, 0), true);
    assert.equal(t(5, 59), true);
    assert.equal(t(6, 0), false);
    assert.equal(t(12, 0), false);
  });

  test('TODAY / SESSIONS n / SUB n (HARI INI / SESI n / SUB n) fit the 28 px text area, up to 999', () => {
    const stats = { day: '2026-11-25', sessions: 1234, subtasks: 999 };
    assert.deepEqual(endOfDayLines(stats, 'ms'), ['HARI INI', 'SESI 999', 'SUB 999']);
    assert.deepEqual(endOfDayLines(stats, 'en'), ['TODAY', 'SESS 999', 'SUB 999']);
    assert.deepEqual(endOfDayLines({ ...stats, sessions: 7 }, 'en')[1], 'SESS 7', 'SESSIONS never fits');
    for (const lang of ['en', 'ms'] as const) {
      for (const l of endOfDayLines(stats, lang).slice(1)) {
        const [label, num] = l.split(' ');
        assert.ok(fitsBoardLine(label, num), `${lang}: ${l}`);
      }
      assert.ok(fitsBoardLine(t('boardToday', lang), ''), t('boardToday', lang));
      const g = buildEndOfDaySprite({ day: '2026-11-25', sessions: 7, subtasks: 12 }, lang);
      assert.equal(g.length, 32);
      assert.ok(g.every((row) => row.length === 32));
    }
  });

  /** Furniture instances follow the layout order (every type is in the catalog). */
  // Found by position: os.furniture also holds decor instances, so its order is not the layout's.
  function board(os: OfficeState): SpriteData {
    const wb = os.layout.furniture.find((f) => f.type === 'WHITEBOARD')!;
    const inst = os.furniture.filter((f) => f.x === wb.col * 16 && f.y === wb.row * 16);
    assert.equal(inst.length, 1, 'one instance at the whiteboard tile');
    return inst[0].sprite;
  }

  test('evening + stats: the day board; daytime or no stats: live counts; redraw only on change', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 25, 20, 0));
    const { os, clock } = office();
    os.addAgent(1, undefined, undefined, seatAt(os, 3, 5), true, 'infra');
    run(os, clock, 1);
    const live = buildWhiteboardSprite({ active: 1, resting: 0, subagents: 0, alerts: 0 });
    assert.deepEqual(board(os), live, 'no stats yet: live counts');

    os.setWallpaperStats({ day: '2026-11-25', sessions: 'x', subtasks: 2 }); // invalid: ignored
    os.setWallpaperStats({ day: '2026-11-25', sessions: -1, subtasks: 2 });
    assert.equal(os.getWallpaperStats(), null);
    os.setWallpaperStats({ type: 'wallpaperStats', day: '2026-11-25', sessions: 5, subtasks: 9 });
    run(os, clock, 1);
    const evening = board(os);
    assert.deepEqual(evening, buildEndOfDaySprite({ day: '2026-11-25', sessions: 5, subtasks: 9 }));
    os.setWallpaperStats({ day: '2026-11-25', sessions: 5, subtasks: 9 });
    run(os, clock, 1);
    assert.equal(board(os), evening, 'same values: same sprite object (no redraw)');
    os.setWallpaperStats({ day: '2026-11-25', sessions: 6, subtasks: 9 });
    run(os, clock, 1);
    assert.deepEqual(
      board(os),
      buildEndOfDaySprite({ day: '2026-11-25', sessions: 6, subtasks: 9 }),
    );

    vi.setSystemTime(new Date(2026, 10, 26, 6, 0));
    run(os, clock, 1);
    assert.deepEqual(board(os), live, '06:00: back to the live counts');
  });
});

// ── Reception ────────────────────────────────────────────────────────────────

describe('reception', () => {
  const R = LAYOUT.wallpaperReception;

  test('layout: reception metadata, 9 open desks kept, every floor tile reachable from the entrance', () => {
    assert.deepEqual(R, { col: 2, row: 14 }, 'no agent name in the layout');
    const { os } = office();
    const seat = os.seats.get(seatAt(os, R.col, R.row))!;
    assert.equal(seat.facingDir, Direction.DOWN);
    const benches = os.layout.furniture.filter((f) => f.type === 'CUSHIONED_BENCH');
    assert.equal(benches.length, 9);
    const walkable = getWalkableTiles(os.tileMap, os.blockedTiles);
    const entrance = (
      os.layout as OfficeLayout & { wallpaperEntrance: { col: number; row: number } }
    ).wallpaperEntrance;
    for (const t of walkable) {
      if (t.col === entrance.col && t.row === entrance.row) continue;
      assert.ok(
        findPath(entrance.col, entrance.row, t.col, t.row, os.tileMap, os.blockedTiles).length > 0,
        `${String(t.col)},${String(t.row)} reachable`,
      );
    }
    // The reception agent can reach its chair from the entrance.
    os.blockedTiles.delete(`${String(R.col)},${String(R.row)}`);
    assert.ok(
      findPath(entrance.col, entrance.row, R.col, R.row, os.tileMap, os.blockedTiles).length > 0,
    );
  });

  test('the reception agent (any case) sits at reception; nobody else ever does', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { os, clock } = office();
    for (let id = 1; id <= 12; id++)
      os.addAgent(id, undefined, undefined, undefined, true, `agent-${String(id)}`);
    os.addAgent(20, undefined, undefined, seatAt(os, 3, 5), true, 'RELAY');
    const j = os.characters.get(20)!;
    assert.equal(j.seatId, seatAt(os, R.col, R.row), 'reception beats the requested seat');
    assert.equal(os.getReceptionAgentId(), 20);
    for (let id = 1; id <= 12; id++) assert.notEqual(os.characters.get(id)!.seatId, j.seatId);

    os.setAgentActive(20, false);
    run(os, clock, 200);
    assert.equal(
      at(j),
      `${String(R.col)},${String(R.row)}`,
      'idle: stays seated, no lounge, no wander',
    );
    assert.equal(j.state, CharacterState.TYPE);
    assert.equal(j.dir, Direction.DOWN);
  });

  test('a later reception agent moves to reception; a second one does not', () => {
    const { os, clock } = office();
    os.addAgent(1, undefined, undefined, seatAt(os, 7, 9), true, 'notes');
    const ch = os.characters.get(1)!;
    ch.directoryName = 'Relay'; // renamed (alias applied late)
    os.addAgent(2, undefined, undefined, seatAt(os, 11, 9), true, 'relay');
    run(os, clock, 30);
    const holders = [1, 2].filter(
      (id) => os.characters.get(id)!.seatId === seatAt(os, R.col, R.row),
    );
    assert.equal(holders.length, 1, 'one reception agent');
    assert.equal(at(os.characters.get(holders[0])!), `${String(R.col)},${String(R.row)}`);
  });

  test('with sub-agents the reception agent leads a team room, then comes back to reception', () => {
    const { os, clock } = office();
    os.addAgent(20, undefined, undefined, undefined, true, RECEPTION);
    const j = os.characters.get(20)!;
    const sub = os.addSubagent(20, 'tool-1');
    os.characters.get(sub)!.isActive = true;
    run(os, clock, 30);
    assert.ok(j.tileRow >= 9 && j.tileCol >= 15, `in a team room at ${at(j)}`);
    os.removeSubagent(20, 'tool-1');
    run(os, clock, 60);
    assert.equal(at(j), `${String(R.col)},${String(R.row)}`, 'back at reception');
  });

  test('mail: envelope for 30 s even when its status changes; others ignored; shown in privacy', () => {
    const { os, clock } = office();
    os.addAgent(20, undefined, undefined, undefined, true, RECEPTION);
    os.addAgent(1, undefined, undefined, seatAt(os, 3, 5), true, 'infra');
    os.setAgentActive(20, false);
    run(os, clock, 1);

    os.receiveMail(1);
    assert.equal(os.getMailAgentId(), null, 'not the reception agent');
    os.receiveMail(20);
    assert.ok(hasSprite(os, ENVELOPE));
    run(os, clock, MAIL_SEC - 1);
    assert.ok(hasSprite(os, ENVELOPE), 'still there at 29 s');
    run(os, clock, 1.5);
    assert.ok(!hasSprite(os, ENVELOPE), 'gone after 30 s');

    setWallpaperOptions({ privacy: true });
    os.receiveMail(20);
    run(os, clock, 1);
    assert.ok(hasSprite(os, ENVELOPE), 'privacy keeps the envelope');
    os.setAgentActive(20, true); // the message starts its turn
    run(os, clock, 10);
    assert.ok(hasSprite(os, ENVELOPE), 'a status change keeps the envelope');
    run(os, clock, MAIL_SEC);
    assert.ok(!hasSprite(os, ENVELOPE), 'gone after 30 s');
    assert.equal(os.getMailAgentId(), null);
  });

  test('no reception agent (null): the desk stays empty, no envelope', () => {
    const { os, clock } = office(null);
    os.addAgent(20, undefined, undefined, undefined, true, RECEPTION);
    run(os, clock, 5);
    assert.equal(os.getReceptionAgentName(), null);
    assert.equal(os.getReceptionAgentId(), null);
    assert.notEqual(os.characters.get(20)!.seatId, seatAt(os, R.col, R.row));
    os.receiveMail(20);
    assert.equal(os.getMailAgentId(), null);
  });

  test('setReceptionAgent: only a non-empty string names one', () => {
    const { os } = office(null);
    for (const bad of [undefined, null, '', '   ', 5, {}, ['Relay']]) {
      os.setReceptionAgent(bad);
      assert.equal(os.getReceptionAgentName(), null, JSON.stringify(bad));
    }
    os.setReceptionAgent('  Relay ');
    assert.equal(os.getReceptionAgentName(), 'Relay');
  });

  test('wallpaperConfig change: a newly named agent walks over; unnamed, it gives the chair up', () => {
    const { os, clock } = office(null);
    os.addAgent(20, undefined, undefined, seatAt(os, 3, 5), true, RECEPTION);
    const ch = os.characters.get(20)!;
    run(os, clock, 2);
    assert.equal(ch.seatId, seatAt(os, 3, 5));

    os.setReceptionAgent(RECEPTION);
    run(os, clock, 30);
    assert.equal(os.getReceptionAgentId(), 20);
    assert.equal(at(ch), `${String(R.col)},${String(R.row)}`);

    os.receiveMail(20);
    assert.equal(os.getMailAgentId(), 20);
    os.setReceptionAgent(null);
    assert.equal(os.getMailAgentId(), null, 'the envelope goes with the name');
    assert.ok(ch.seatId && ch.seatId !== seatAt(os, R.col, R.row), 'a desk of its own');
    run(os, clock, 30);
    assert.equal(os.getReceptionAgentId(), null);
    assert.notEqual(at(ch), `${String(R.col)},${String(R.row)}`);
  });

  test('the envelope sits on the reception desk', () => {
    const { os } = office();
    os.addAgent(20, undefined, undefined, undefined, true, RECEPTION);
    os.receiveMail(20);
    const env = os.furniture.find((f) => f.sprite === ENVELOPE)!;
    // Desk: cols 2..3, rows 14..15 (x 32..63, y 224..255).
    assert.ok(env.x >= 32 && env.x + ENVELOPE[0].length <= 64, `x ${String(env.x)}`);
    assert.ok(env.y >= 224 && env.y + ENVELOPE.length <= 256, `y ${String(env.y)}`);
  });
});
