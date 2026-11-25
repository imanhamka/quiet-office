/**
 * quiet-office: sub-agents as workers, team rooms, lounge and decor (wallpaper mode).
 *
 * A lead with sub-agents books a room (team room A, then B, then the lounge table)
 * and sits at its head seat. Each sub-agent comes in at the entrance and takes a
 * free seat of its own: a room seat, then the open-plan desk nearest the room door;
 * with no room free, the desk nearest its lead. Cleared, it gives its seat up at
 * once, reports to its lead and leaves by the entrance. The room is held 20 s after
 * the last sub-agent, freed at once when the lead closes, and after a reconnect
 * unless the replay brings the sub-agents back.
 *
 * Fixture (24 x 18): rooms are the areaTiles labelled "ROOM 1"/"ROOM 2" (as in
 * default-layout-2.json); a wall along row 8 (cols 0..14) has one door gap per room.
 *   benches b1..b6: (2,2)(6,2)(10,2)(14,2)(2,6)(6,6)
 *   ROOM 1 (1..6, 9..14): table (2..4, 10..13); head a-top (3,9)↓, a-bot (3,14)↑,
 *     sides (1,11)(1,12)→ and (5,11)(5,12)←; door (5,8)
 *   ROOM 2 (8..13, 9..14): same shape shifted 7 columns; door (12,8)
 *   lounge table (16..20, 10..13): table (17..19, 10..13), chairs (16,11)→ (20,11)←
 *   sofa (16..17, 16); entrance (22,2)
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { afterEach, beforeAll, describe, test, vi } from 'vitest';

import { t } from '../src/i18n/index.js';
import { OfficeState, type WallpaperLayoutMeta } from '../src/office/engine/officeState.js';
import {
  boardLabel,
  buildDoorSign,
  buildWhiteboardSprite,
  fitsBoardLine,
  SIGN_H,
  SIGN_W,
  signText,
  textWidth,
} from '../src/office/engine/whiteboard.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import { WP_PC_SCREEN_OFF } from '../src/office/sprites/wallpaperPalette.js';
import type { Character, OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

function asset(
  id: string,
  category: string,
  footprintW: number,
  footprintH: number,
  extra: Partial<CatalogAsset> = {},
): CatalogAsset {
  return {
    id,
    label: id,
    category,
    width: footprintW * 16,
    height: footprintH * 16,
    footprintW,
    footprintH,
    isDesk: category === 'desks',
    ...extra,
  };
}

/** A PC screen colour (PC_FRONT_OFF.png) that the permission blink turns red. */
const SCREEN_OFF = WP_PC_SCREEN_OFF;

beforeAll(() => {
  const chair = { groupId: 'WOODEN_CHAIR' };
  const catalog = [
    asset('CUSHIONED_BENCH', 'chairs', 1, 1),
    asset('TABLE_FRONT', 'desks', 3, 4),
    asset('WOODEN_CHAIR_FRONT', 'chairs', 1, 1, { ...chair, orientation: 'front' }),
    asset('WOODEN_CHAIR_BACK', 'chairs', 1, 1, { ...chair, orientation: 'back' }),
    asset('WOODEN_CHAIR_SIDE', 'chairs', 1, 1, { ...chair, orientation: 'side', mirrorSide: true }),
    asset('SOFA_FRONT', 'chairs', 2, 1, { groupId: 'SOFA', orientation: 'front' }),
    asset('DESK', 'desks', 1, 1),
    asset('PC_FRONT_OFF', 'electronics', 1, 2, {
      groupId: 'PC',
      canPlaceOnSurfaces: true,
      backgroundTiles: 1,
      orientation: 'front',
      state: 'off',
    }),
  ];
  const sprites = Object.fromEntries(
    catalog.map((a) => [a.id, a.id === 'PC_FRONT_OFF' ? [[SCREEN_OFF]] : [['black']]]),
  );
  assert.ok(buildDynamicCatalog({ catalog, sprites }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BENCHES = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

function roomFurniture(p: string, c: number): PlacedFurniture[] {
  return [
    { uid: `${p}-table`, type: 'TABLE_FRONT', col: c + 1, row: 10 },
    { uid: `${p}-top`, type: 'WOODEN_CHAIR_FRONT', col: c + 2, row: 9 },
    { uid: `${p}-bot`, type: 'WOODEN_CHAIR_BACK', col: c + 2, row: 14 },
    { uid: `${p}-l1`, type: 'WOODEN_CHAIR_SIDE', col: c, row: 11 },
    { uid: `${p}-l2`, type: 'WOODEN_CHAIR_SIDE', col: c, row: 12 },
    { uid: `${p}-r1`, type: 'WOODEN_CHAIR_SIDE:left', col: c + 4, row: 11 },
    { uid: `${p}-r2`, type: 'WOODEN_CHAIR_SIDE:left', col: c + 4, row: 12 },
  ];
}

const FURNITURE: PlacedFurniture[] = [
  { uid: 'b1', type: 'CUSHIONED_BENCH', col: 2, row: 2 },
  { uid: 'b2', type: 'CUSHIONED_BENCH', col: 6, row: 2 },
  { uid: 'b3', type: 'CUSHIONED_BENCH', col: 10, row: 2 },
  { uid: 'b4', type: 'CUSHIONED_BENCH', col: 14, row: 2 },
  { uid: 'b5', type: 'CUSHIONED_BENCH', col: 2, row: 6 },
  { uid: 'b6', type: 'CUSHIONED_BENCH', col: 6, row: 6 },
  ...roomFurniture('a', 1),
  ...roomFurniture('b', 8),
  { uid: 'lounge-table', type: 'TABLE_FRONT', col: 17, row: 10 },
  { uid: 'm1', type: 'WOODEN_CHAIR_SIDE', col: 16, row: 11 },
  { uid: 'm2', type: 'WOODEN_CHAIR_SIDE:left', col: 20, row: 11 },
  { uid: 'sofa', type: 'SOFA_FRONT', col: 16, row: 16 },
];

const COLS = 24;
const ROWS = 18;

function office(withRooms = true): OfficeState {
  const tiles = new Array<TileType>(COLS * ROWS).fill(TileType.FLOOR_1);
  const areaTiles = new Array<string | null>(COLS * ROWS).fill(null);
  if (withRooms) {
    for (let c = 0; c <= 14; c++) if (c !== 5 && c !== 12) tiles[8 * COLS + c] = TileType.WALL;
    for (let r = 9; r <= 14; r++) {
      for (let c = 1; c <= 6; c++) areaTiles[r * COLS + c] = 'ROOM 1';
      for (let c = 8; c <= 13; c++) areaTiles[r * COLS + c] = 'ROOM 2';
    }
  }
  const layout = {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles,
    furniture: FURNITURE,
    ...(withRooms
      ? {
          areas: [
            { label: 'ROOM 1', color: 'violet' },
            { label: 'ROOM 2', color: 'seagreen' },
          ],
          areaTiles,
        }
      : { wallpaperRooms: [] }),
    wallpaperEntrance: { col: 22, row: 2 },
  } as OfficeLayout & WallpaperLayoutMeta;
  const os = new OfficeState(layout);
  os.wpMode = true;
  os.addAgent(1, undefined, undefined, 'b1', true);
  return os;
}

function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) os.update(1 / 30);
}

function subs(os: OfficeState, n: number, leadId = 1, from = 0): Character[] {
  const out: Character[] = [];
  for (let i = from; i < from + n; i++) {
    const id = os.addSubagent(leadId, `tool-${String(i)}`);
    const ch = os.characters.get(id)!;
    ch.isActive = true;
    out.push(ch);
  }
  return out;
}

function at(ch: Character): string {
  return `${String(ch.tileCol)},${String(ch.tileRow)}`;
}

function roomOf(os: OfficeState, leadId: number): string | null {
  return os.getRoomStates().find((r) => r.leadId === leadId)?.id ?? null;
}

const ROOM_A_SUB_SEATS = ['a-bot', 'a-l1', 'a-l2', 'a-r1', 'a-r2'];

describe('wallpaper team rooms', () => {
  test('booking order: room A, room B, the lounge table, then own desks near the lead', () => {
    const os = office();
    for (const [id, seat] of [
      [2, 'b2'],
      [3, 'b3'],
      [4, 'b4'],
    ] as const) {
      os.addAgent(id, undefined, undefined, seat, true);
    }
    const s1 = subs(os, 1, 1)[0];
    const s2 = subs(os, 1, 2)[0];
    const s3 = subs(os, 1, 3)[0];
    const s4 = subs(os, 2, 4);
    assert.equal(roomOf(os, 1), 'ROOM 1');
    assert.equal(roomOf(os, 2), 'ROOM 2');
    assert.equal(roomOf(os, 3), 'lounge');
    assert.equal(roomOf(os, 4), null, 'no room left');
    assert.ok(ROOM_A_SUB_SEATS.includes(s1.seatId!));
    assert.ok(s2.seatId!.startsWith('b-') && s2.seatId !== 'b-top');
    assert.ok(s3.seatId === 'm1' || s3.seatId === 'm2', 'a lounge chair');
    // Lead 4 (b4 at 14,2): the free benches are b5 (2,6) and b6 (6,6); b6 is nearer.
    assert.deepEqual(
      s4.map((c) => c.seatId),
      ['b6', 'b5'],
    );
  });

  test('the lead walks to its head seat; its own desk stays reserved', () => {
    const os = office();
    const lead = os.characters.get(1)!;
    subs(os, 2);
    run(os, 20);
    assert.equal(at(lead), '3,9', 'at the head seat');
    assert.equal(lead.state, CharacterState.TYPE);
    assert.equal(lead.seatId, 'b1', 'still owns its desk');
    assert.ok(os.seats.get('b1')!.assigned);
  });

  test('overflow: more sub-agents than room seats go to the desks nearest the room door', () => {
    const os = office();
    const team = subs(os, 7);
    assert.deepEqual(new Set(team.slice(0, 5).map((c) => c.seatId)), new Set(ROOM_A_SUB_SEATS));
    // Door (5,8): b6 (6,6) is 3 away, b5 (2,6) is 5.
    assert.deepEqual(
      team.slice(5).map((c) => c.seatId),
      ['b6', 'b5'],
    );
    run(os, 25);
    const tiles = [...os.characters.values()].map(at);
    assert.equal(new Set(tiles).size, tiles.length, 'never stacked');
  });

  test('a sub-agent that arrived before its lead moves into the room once the lead is there', () => {
    const os = office();
    const early = os.characters.get(os.addSubagent(7, 'tool-early'))!;
    assert.equal(roomOf(os, 7), null);
    os.addAgent(7, undefined, undefined, 'b4', true);
    run(os, 1.5);
    assert.equal(roomOf(os, 7), 'ROOM 1');
    assert.ok(ROOM_A_SUB_SEATS.includes(early.seatId!), String(early.seatId));
  });

  test('door signs hang centred over each door, inside the room span', () => {
    const os = office();
    run(os, 0.5);
    const signs = os.furniture.filter((f) => f.sprite.length === SIGN_H && f.sprite[0].length === SIGN_W);
    // Doors (5,8) and (12,8), one tile wide: the 40 px sign is centred over the tile.
    const lefts = signs.map((f) => f.x).sort((a, b) => a - b);
    assert.deepEqual(lefts, [5 * 16 + 8 - SIGN_W / 2, 12 * 16 + 8 - SIGN_W / 2]);
    assert.ok(lefts[0] >= 1 * 16 && lefts[1] + SIGN_W <= 14 * 16, 'inside the room columns');
  });

  test('a booked door sign shows the whole lead name and stays inside the room', () => {
    const os = office();
    os.characters.get(1)!.agentName = 'quiet-office';
    subs(os, 1);
    run(os, 1);
    assert.equal(roomOf(os, 1), 'ROOM 1');
    const signs = os.furniture.filter((f) => f.sprite.length === SIGN_H && f.sprite[0].length >= SIGN_W);
    const busy = signs.find((f) => f.sprite[0].length > SIGN_W);
    assert.ok(busy, 'the booked sign grows past the minimum width');
    // ROOM 1 spans cols 1..6: x 17..111 inside its walls.
    const minX = 1 * 16 + 1;
    const maxX = 7 * 16 - 1;
    assert.deepEqual(busy.sprite, buildDoorSign('quiet-office', maxX - minX));
    assert.equal(busy.sprite[0].length, 8 + textWidth('QUIET-OFFICE') + 3);
    assert.ok(busy.x >= minX && busy.x + busy.sprite[0].length <= maxX, `x=${String(busy.x)}`);
  });

  test('sign text: whole name when it fits, else cut with ".."', () => {
    assert.equal(signText('quiet-office', 200), 'QUIET-OFFICE');
    assert.equal(signText('Relay', 200), 'RELAY');
    assert.equal(signText('my_chat relay', 200), 'MY-CHAT RELAY');
    const long = signText('acme-sso-laravel-integration-module-extra', 60);
    assert.ok(long.endsWith('..'), long);
    assert.ok(textWidth(long) <= 60, String(textWidth(long)));
    assert.equal(buildDoorSign(null)[0].length, SIGN_W);
    const wide = buildDoorSign('acme-sso-laravel-integration-module-extra', 94);
    // Cut to whole glyphs: never wider than the room allows, at most one glyph short of it.
    assert.ok(wide[0].length <= 94 && wide[0].length >= 94 - 4, String(wide[0].length));
  });

  test('without rooms: each sub takes its own desk, nearest the lead first', () => {
    const os = office(false);
    const all = subs(os, 6);
    const seats = all.map((c) => c.seatId);
    // b2 (6,2) and b5 (2,6) are 4 from b1 (2,2); the other benches are 8 or more.
    assert.deepEqual(new Set(seats.slice(0, 2)), new Set(['b2', 'b5']));
    assert.deepEqual(new Set(seats.slice(0, 5)), new Set(BENCHES.slice(1)));
    // Room chairs are no one's desk: with an empty room list, a sixth sub has no seat.
    assert.equal(seats[5], null);
  });

  test('clear: the room is held 20 s, then freed and the lead walks back to its desk', () => {
    const os = office();
    const lead = os.characters.get(1)!;
    const [a, b] = subs(os, 2);
    run(os, 20);
    os.removeSubagent(1, 'tool-0');
    os.removeSubagent(1, 'tool-1');
    assert.equal(a.seatId, null);
    assert.equal(b.seatId, null);
    run(os, 15);
    assert.equal(roomOf(os, 1), 'ROOM 1', 'held');
    // A quick follow-up fan-out reuses the room.
    const [c] = subs(os, 1, 1, 2);
    assert.ok(ROOM_A_SUB_SEATS.includes(c.seatId!));
    os.removeSubagent(1, 'tool-2');
    run(os, 15);
    assert.equal(roomOf(os, 1), 'ROOM 1', 'the hold restarted with the last clear');
    run(os, 10);
    assert.equal(roomOf(os, 1), null, 'freed');
    assert.equal(os.seats.get('a-top')!.assigned, false);
    run(os, 20);
    assert.equal(at(lead), '2,2', 'back at its own desk');
    assert.ok(!os.characters.has(a.id) && !os.characters.has(b.id), 'the subs left');
  });

  test('closing the lead frees its room and every seat at once', () => {
    const os = office();
    const team = subs(os, 3);
    const held = team.map((c) => c.seatId!);
    os.removeAllSubagents(1);
    os.removeAgent(1);
    assert.equal(roomOf(os, 1), null);
    assert.ok(held.every((uid) => !os.seats.get(uid)!.assigned));
    assert.equal(os.seats.get('a-top')!.assigned, false);
  });

  test('reconnect: the replay keeps room and seats; without it the room is freed', () => {
    const os = office();
    const team = subs(os, 2);
    run(os, 15);
    const held = team.map((c) => c.seatId);
    os.detachSubagentsForResync();
    assert.ok(held.every((uid) => !os.seats.get(uid!)!.assigned));
    const again = [os.addSubagent(1, 'tool-0'), os.addSubagent(1, 'tool-1')].map(
      (id) => os.characters.get(id)!.seatId,
    );
    assert.deepEqual(again, held);
    run(os, 5);
    assert.equal(roomOf(os, 1), 'ROOM 1');

    const os2 = office();
    subs(os2, 2);
    os2.detachSubagentsForResync();
    run(os2, 3);
    assert.equal(roomOf(os2, 1), null);
  });
});

describe('wallpaper sub-agents', () => {
  test('a sub-agent spawns at the entrance, walks to its seat and sits', () => {
    const os = office();
    const [a] = subs(os, 1);
    assert.equal(at(a), '22,2');
    run(os, 25);
    const seat = os.seats.get(a.seatId!)!;
    assert.equal(at(a), `${String(seat.seatCol)},${String(seat.seatRow)}`);
    assert.equal(a.state, CharacterState.TYPE);
  });

  test('clear: the seat is free at once, the sub reports and leaves by the entrance', () => {
    const os = office();
    const [a] = subs(os, 1);
    run(os, 25);
    const seatUid = a.seatId!;
    os.removeSubagent(1, 'tool-0');
    assert.equal(os.seats.get(seatUid)!.assigned, false);
    assert.equal(a.seatId, null);
    assert.equal(a.matrixEffect, null, 'walks out instead of vanishing on the spot');
    run(os, 40);
    assert.ok(!os.characters.has(a.id), 'gone after the walk out');
  });
});

describe('wallpaper lounge', () => {
  test('an idle agent sits on a sofa, then goes back to its desk when work starts', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const os = office();
    const lead = os.characters.get(1)!;
    os.setAgentActive(1, false);
    run(os, 30);
    assert.equal(lead.tileRow, 16, 'on the sofa row');
    assert.ok(lead.tileCol === 16 || lead.tileCol === 17, `at ${at(lead)}`);
    assert.equal(lead.state, CharacterState.TYPE, 'sitting');

    os.setAgentActive(1, true);
    run(os, 20);
    assert.equal(at(lead), '2,2', 'back at its own seat');
    assert.equal(lead.state, CharacterState.TYPE);
  });
});

describe('wallpaper decor', () => {
  test('the whiteboard text fits the 32x32 board in both languages', () => {
    // Label left, number right-aligned, at least 2 px apart, inside the 28 px text area.
    for (const lang of ['en', 'ms'] as const) {
      for (const key of ['boardActive', 'boardIdle', 'boardSub'] as const) {
        for (const num of ['0', '9', '99']) {
          const label = boardLabel(t(key, lang), num);
          assert.ok(fitsBoardLine(label, num), `${lang} ${label} ${num}`);
        }
      }
      const g = buildWhiteboardSprite({ active: 15, resting: 12, subagents: 3, alerts: 0 }, lang);
      assert.equal(g.length, 32);
      assert.ok(g.every((row) => row.length === 32));
    }
    assert.equal(boardLabel(t('boardActive', 'en'), '3'), 'ACTIVE');
    assert.equal(boardLabel(t('boardActive', 'en'), '15'), 'ACT', 'ACTIVE 15 has no 2 px gap');
    assert.equal(boardLabel(t('boardIdle', 'ms'), '99'), 'REHAT');
  });

  test('a permission prompt blinks its desk PC red', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 6,
      rows: 5,
      tiles: new Array<TileType>(30).fill(TileType.FLOOR_1),
      furniture: [
        { uid: 'desk', type: 'DESK', col: 2, row: 1 },
        { uid: 'pc', type: 'PC_FRONT_OFF', col: 2, row: 0 },
        { uid: 'seat', type: 'CUSHIONED_BENCH', col: 2, row: 2 },
      ],
    };
    const os = new OfficeState(layout);
    os.wpMode = true;
    assert.equal(os.seatWorkstations.get('seat'), 'pc');
    os.addAgent(1, undefined, undefined, 'seat', true);
    os.showPermissionBubble(1);
    const screens = new Set<string>();
    for (let t = 0; t < 2; t += 0.1) {
      os.update(0.1);
      screens.add(os.furniture[1].sprite[0][0]);
    }
    assert.ok(screens.has(SCREEN_OFF) && screens.size === 2, [...screens].join(' '));
    os.clearPermissionBubble(1);
    run(os, 1);
    assert.equal(os.furniture[1].sprite[0][0], SCREEN_OFF);
  });
});
