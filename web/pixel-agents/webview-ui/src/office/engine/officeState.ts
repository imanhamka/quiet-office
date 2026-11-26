import { chooseLook } from '../../../../core/src/paletteUtils.js';
import {
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  FURNITURE_ANIM_INTERVAL_SEC,
  GREETER_ID,
  GREETER_TILE_MARGIN,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  MAX_PET_ID_LENGTH,
  PET_HIT_HALF_WIDTH,
  PET_HIT_HEIGHT,
  WAITING_BUBBLE_DURATION_SEC,
} from '../../constants.js';
import { getLang, type Lang, t } from '../../i18n/index.js';
import { getWallpaperOptions, isWallpaper } from '../../wallpaper.js';
import { contextUsedShare } from '../contextGauge.js';
import { getAnimationFrames, getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import { pairWorkstations } from '../layout/workstations.js';
import { getPetCount, getPetName } from '../sprites/petSpriteData.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import { WP_ALL_DONE_DIM, WP_ROOM_TINT } from '../sprites/wallpaperPalette.js';
import type {
  Character,
  FurnitureInstance,
  OfficeLayout,
  Pet,
  PlacedFurniture,
  PlacedPet,
  Seat,
  SpriteData,
  TileType as TileTypeVal,
} from '../types.js';
import { CharacterState, Direction, PetState, TILE_SIZE, TileType } from '../types.js';
import { tickBlink } from './blink.js';
import {
  createCharacter,
  restInChair,
  updateCharacter,
  updateHelper,
  updateWorker,
  walkPath,
} from './characters.js';
import { advanceMatrixEffect, startMatrixEffect } from './matrixEffectState.js';
import { createPet, updatePet } from './petEntity.js';
import { anchorTile, closestFreeSeat } from './seatPlacement.js';
// quiet-office: decor sprites and the whiteboard scoreboard
import {
  buildClockSprite,
  decorBlinkOn,
  ENVELOPE,
  ENVELOPE_H,
  ENVELOPE_W,
  GLOW_H,
  GLOW_W,
  isNight,
  NIGHT_GLOW,
  redScreenSprite,
  setDecorBlink,
} from './wallpaperDecor.js';
import {
  buildDoorSign,
  buildEndOfDaySprite,
  buildWhiteboardSprite,
  type DayStats,
  isEndOfDay,
  sameCounts,
  type ScoreCounts,
  SIGN_H,
} from './whiteboard.js';

/** Whether a character sits in a chair: helpers stand by their lead, and a
 *  departing character is leaving. */
function takesSeat(ch: Character): boolean {
  return !ch.isSubagent && ch.matrixEffect !== 'despawn';
}

type Tile = { col: number; row: number };

// quiet-office: lounge, sub-agent desks and decor (see the "quiet-office" section).
/** A place in the lounge: a sofa seat (sit) or a tile beside lounge furniture (stand). */
interface LoungeSpot {
  col: number;
  row: number;
  dir: Direction;
  seatUid?: string;
}
interface LoungeVisit extends LoungeSpot {
  arrived: boolean;
}
/** A finished sub-agent on its way out: report at the lead's desk, then the door. */
interface Leaver {
  phase: 'report' | 'wait' | 'door';
  leadId: number;
  timer: number;
  tried: boolean;
}
interface WpGeometry {
  /** Furniture uid → index in the furniture instances. */
  index: Map<string, number>;
  whiteboardUid: string | null;
  clockUid: string | null;
  sofaSpots: LoungeSpot[];
  standSpots: LoungeSpot[];
  /** Seats of the lounge table(s) (the sub-agent fallback after desks), and the
   *  open-plan desk seats (every other seat outside rooms and sofas). */
  meetingSeats: string[];
  deskSeats: string[];
  /** Doorway tiles in a partition wall, middle first. */
  doors: Tile[];
  /** Team rooms (area-labelled tables) in label order, then the lounge table. */
  rooms: WpRoom[];
}
/** A room a lead books while it has sub-agents: seats[0] is the lead's (head) seat. */
interface WpRoom {
  id: string;
  /** A team room (door sign, floor tint); false for the lounge table. */
  team: boolean;
  seats: string[];
  /** Where overflow sub-agents are seated nearest to. */
  door: Tile;
  /** Door sign: centred on `cx` (world px, middle of the door gap) and kept within
   *  minX..maxX (the room's columns); `y` is its top, `row` its wall row. Null for the lounge. */
  sign: { cx: number; minX: number; maxX: number; y: number; row: number } | null;
  /** Room floor in tiles, for the occupied tint; null for the lounge. */
  rect: { col: number; row: number; w: number; h: number } | null;
}
interface RoomBooking {
  leadId: number;
  /** wpTime at which the room is given up (no sub-agents left), or null while in use. */
  releaseAt: number | null;
}
/** quiet-office layout metadata (top-level fields of the layout JSON). Bounds are
 *  inclusive tiles; a room's seats are the seats inside its bounds. */
export interface WallpaperRoomMeta {
  id: string;
  label?: string;
  kind: 'team' | 'lounge-table' | string;
  bounds: { c0: number; r0: number; c1: number; r1: number };
  door?: Tile;
  sign?: Tile;
  headSeat?: Tile;
}
export interface WallpaperLayoutMeta {
  wallpaperRooms?: WallpaperRoomMeta[];
  wallpaperEntrance?: Tile;
  /** The reception chair's seat tile. Who sits there comes from the server
   *  (`wallpaperConfig.reception`), never from the layout. */
  wallpaperReception?: Tile;
}

/** Exported room occupancy (getRoomStates). */
export interface RoomState {
  id: string;
  leadId: number | null;
  leadName: string | null;
  seatsUsed: number;
  seatsTotal: number;
}
/** Share of idle wanders that head for the lounge. */
const LOUNGE_CHANCE = 0.4;
/** Share of lounge visits that take a free sofa seat over a standing spot. */
const LOUNGE_SOFA_CHANCE = 0.6;
const LOUNGE_DWELL_MIN_SEC = 60;
const LOUNGE_DWELL_MAX_SEC = 180;
/** How long a finished sub-agent stands at its lead's desk to report. */
const REPORT_SEC = 2;
/** How often a sub-agent without a seat looks for one again. */
const SEAT_RETRY_SEC = 4;
/** A room stays booked this long after its last sub-agent clears (a quick follow-up
 *  fan-out reuses it instead of everyone walking back and forth). */
const ROOM_HOLD_SEC = 20;
/** After a reconnect resync, a room whose sub-agents the replay does not bring back is freed. */
const ROOM_RESYNC_HOLD_SEC = 2;
/** How often sub-agents are checked against their lead's room (late booking, seat moves). */
const TEAM_CHECK_SEC = 1;
/** Permission blink: PC screen and ring toggle this often. */
const ALERT_BLINK_SEC = 0.5;
/** "all done": someone must have worked this long without a break before all went idle. */
export const ALL_DONE_WORK_MS = 10 * 60_000;
/** A snapshot replay (startup, reconnect) settles within this; idling inside it is not "done". */
export const REPLAY_HOLD_MS = 5_000;
/** An all-done seen while the page was paused plays only if it is this recent. */
const ALL_DONE_STALE_MS = 60_000;
/** How long the office light stays dimmed after "all done". */
export const ALL_DONE_DIM_SEC = 60;
/** The stretch before walking to the lounge: a turn on the spot with one hop. */
const STRETCH_STEP_SEC = 0.3;
const STRETCH_DIRS: readonly Direction[] = [
  Direction.DOWN,
  Direction.LEFT,
  Direction.UP,
  Direction.RIGHT,
  Direction.DOWN,
];
const STRETCH_HOP_PX = 2;
/** The reception envelope shows this long. A status change does not clear it: the message
 * itself starts the agent's turn, so clearing on that would hide it within a second. */
export const MAIL_SEC = 30;

function baseType(type: string): string {
  const i = type.indexOf(':');
  return i < 0 ? type : type.slice(0, i);
}

function footprint(col: number, row: number, w: number, h: number): Tile[] {
  const out: Tile[] = [];
  for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) out.push({ col: col + dc, row: row + dr });
  return out;
}

const DIR_STEPS: Array<{ dc: number; dr: number; dir: Direction }> = [
  { dc: 0, dr: -1, dir: Direction.UP },
  { dc: 0, dr: 1, dir: Direction.DOWN },
  { dc: -1, dr: 0, dir: Direction.LEFT },
  { dc: 1, dr: 0, dir: Direction.RIGHT },
];

function facingToward(from: Tile, to: Tile): Direction {
  const dc = to.col - from.col;
  const dr = to.row - from.row;
  if (Math.abs(dc) >= Math.abs(dr) && dc !== 0) return dc > 0 ? Direction.RIGHT : Direction.LEFT;
  return dr > 0 ? Direction.DOWN : Direction.UP;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Score by steps from `from` (Manhattan distance). */
function manhattanFrom(from: Tile): (tile: Tile) => number {
  return (tile) => Math.abs(tile.col - from.col) + Math.abs(tile.row - from.row);
}

/** Score by rings around `home`: the 8 tiles around it before any 2 away, so
 *  helpers surround their lead instead of lining up beside it (a diagonal
 *  neighbour and a tile 2 straight away are equally far in steps). */
function ringsAround(home: Tile): (tile: Tile) => number {
  return (tile) => {
    const dc = Math.abs(tile.col - home.col);
    const dr = Math.abs(tile.row - home.row);
    return Math.max(dc, dr) * 1000 + dc + dr;
  };
}

export class OfficeState {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  /** Seat uid → the uid of the PC that seat works at (workstations.ts). */
  seatWorkstations: Map<string, string> = new Map();
  /** The PCs lit in the current furniture instances. */
  private litPcs: ReadonlySet<string> = new Set();
  blockedTiles: Set<string>;
  furniture: FurnitureInstance[];
  walkableTiles: Array<{ col: number; row: number }>;
  characters: Map<number, Character> = new Map();
  pets: Pet[] = [];
  /** Accumulated time for furniture animation frame cycling */
  furnitureAnimTimer = 0;
  private _selectedAgentId: number | null = null;
  private readonly selectionListeners = new Set<(id: number | null) => void>();
  get selectedAgentId(): number | null {
    return this._selectedAgentId;
  }
  set selectedAgentId(id: number | null) {
    if (this._selectedAgentId === id) return;
    this._selectedAgentId = id;
    for (const listener of this.selectionListeners) listener(id);
  }
  /** Observe selectedAgentId changes. React (the card bars) subscribes so
   *  imperative canvas selection can drive card highlights — everything else
   *  about selection stays out of React state. Returns the unsubscribe. */
  subscribeSelection(listener: (id: number | null) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }
  cameraFollowId: number | null = null;
  hoveredAgentId: number | null = null;
  hoveredTile: { col: number; row: number } | null = null;
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  private nextSubagentId = -1;
  /** Where each sub-agent stood when a resync detached it ("parentId:toolId" →
   *  spot). A sub the resync replay re-creates returns there without a spawn
   *  effect; one it doesn't was stale and stays gone. */
  private resyncSubagentSpots = new Map<
    string,
    {
      x: number;
      y: number;
      tileCol: number;
      tileRow: number;
      dir: Character['dir'];
      /** quiet-office: the seat it held, retaken when still free */
      seatId?: string | null;
    }
  >();

  /** quiet-office: lounge visits, sub-agent desks, leavers and decor. On in
   *  wallpaper mode; tests switch it on per instance. */
  wpMode = isWallpaper;
  private wpGeo: WpGeometry | null = null;
  private wpGeoSeats: Map<string, Seat> | null = null;
  private wpLounge = new Map<number, LoungeVisit>();
  /** Sub-agents with no seat free: the spot each stands at instead. */
  private wpSubSpots = new Map<number, LoungeSpot>();
  private wpLeaving = new Map<number, Leaver>();
  /** Seconds until a seatless sub-agent looks for a free seat again. */
  private wpSeatRetry = new Map<number, number>();
  /** Room id → booking, and lead id → room id. */
  private wpBookings = new Map<string, RoomBooking>();
  private wpLeadRoom = new Map<number, string>();
  /** Seconds the office has run (room hold timers). */
  private wpTime = 0;
  private wpSigns = new Map<string, SpriteData>();
  private wpSignRects: ReadonlyArray<{ x: number; y: number; w: number; h: number }> = [];
  private wpTeamCheck = 0;
  private wpTints = new Map<string, SpriteData>();
  private wpCounts: ScoreCounts | null = null;
  private wpBoard: SpriteData | null = null;
  private wpClockMinute = -1;
  private wpClock: SpriteData | null = null;
  /** What the whiteboard shows: 'c' (live counts) or 'e|sessions|subtasks' (end of day). */
  private wpBoardKey = '';
  private wpStats: DayStats | null = null;
  private wpEveningMinute = -1;
  private wpEvening = false;
  private wpPrivacy = false;
  private wpLang: Lang = getLang();
  private wpSignLang: Lang = getLang();
  /** Display name of the agent that always sits at reception (`wallpaperConfig`), or null. */
  private wpReceptionAgent: string | null = null;
  /** Wall clock for the work period (tests replace it). */
  wpNow: () => number = () => Date.now();
  /** Start of the current work period (someone working), or null. */
  private wpWorkStart: number | null = null;
  private wpLastBusyAt = -Infinity;
  private wpReplayUntil = -Infinity;
  private wpAllDonePending: number | null = null;
  /** Agents stretching before the walk to the lounge ("all done"). */
  private wpStretch = new Map<number, { timer: number }>();
  /** Wall-clock time (wpNow, ms) at which the dim ends, or null. Wall clock, not wpTime: the
   *  loop stops while the wallpaper is covered, and the dim must not outlast its minute. */
  private wpDimUntil: number | null = null;
  private wpDim: { sprite: SpriteData; x: number; y: number } | null = null;
  private wpRecCache: { seats: Map<string, Seat>; layout: OfficeLayout; uid: string | null } | null = null;
  /** The envelope at reception: whose, and until when (wpTime). */
  private wpMail: { id: number; until: number } | null = null;

  /**
   * directoryName → list of Area labels that Directory belongs to.
   * Populated by useExtensionMessages on `areaMappingsLoaded`. Consulted by
   * `findFreeSeat()` to bias new agents toward seats inside their Directory's Area.
   */
  areaMappings: Record<string, string[]> = {};

  /**
   * The first-run consent greeter, deliberately NOT in `characters`.
   *
   * `characters` means "agents": everything that iterates it — seat
   * assignment, palette diversity, the wander FSM, hit-testing, the seat
   * payload the webview persists — is asking an agent question the greeter has
   * no answer to. Holding it here instead of tagging it with a flag makes
   * every one of those loops correct by default, rather than correct as long
   * as each remembers an `isGreeter` guard. It is drawn because
   * `getCharacters()` appends it, and that is the only place it joins the
   * others.
   */
  greeter: Character | null = null;

  /** World-space point the camera drifts to while the greeter is up
   *  (the bubble overlay recomputes it every frame: the combined center of the
   *  character and its speech bubble). An explicit cameraFollowId outranks it. */
  greeterCameraTarget: { x: number; y: number } | null = null;
  /** Latched by a manual pan during the ask: the user took the camera, so the
   *  overlay's per-frame updates stop re-centering. Reset on spawn/despawn. */
  private greeterCameraCancelled = false;

  setAreaMappings(mappings: Record<string, string[]>): void {
    this.areaMappings = mappings;
  }

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.seatWorkstations = pairWorkstations(this.seats, this.layout.furniture, getCatalogEntry);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    // Pets are built last because they need walkableTiles populated for spawn.
    this.rebuildPetsFromLayout(this.layout);
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.seatWorkstations = pairWorkstations(this.seats, layout.furniture, getCatalogEntry);
    this.blockedTiles = getBlockedTiles(layout.furniture);
    // quiet-office: walkable tiles first — the furniture rebuild's decor reads them.
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    this.rebuildFurnitureInstances();

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        // Clear path since tile coords changed
        ch.path = [];
        ch.moveProgress = 0;
      }
    }

    // Shift pet positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const pet of this.pets) {
        pet.tileCol += shift.col;
        pet.tileRow += shift.row;
        pet.x += shift.col * TILE_SIZE;
        pet.y += shift.row * TILE_SIZE;
        pet.path = [];
        pet.moveProgress = 0;
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          // Snap character to seat position
          ch.tileCol = seat.seatCol;
          ch.tileRow = seat.seatRow;
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
          ch.x = cx;
          ch.y = cy;
          ch.dir = seat.facingDir;
          continue;
        }
      }
      ch.seatId = null; // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId || !takesSeat(ch)) continue;
      const seatId = this.findFreeSeat(ch.directoryName);
      if (seatId) {
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        const seat = this.seats.get(seatId)!;
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue; // seated characters are fine
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch);
      }
    }

    // Relocate any pets that ended up outside bounds or on non-walkable tiles
    for (const pet of this.pets) {
      if (
        pet.tileCol < 0 ||
        pet.tileCol >= layout.cols ||
        pet.tileRow < 0 ||
        pet.tileRow >= layout.rows ||
        !isWalkable(pet.tileCol, pet.tileRow, this.tileMap, this.blockedTiles)
      ) {
        if (this.walkableTiles.length > 0) {
          const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
          pet.tileCol = spawn.col;
          pet.tileRow = spawn.row;
          pet.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
          pet.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
          pet.path = [];
          pet.moveProgress = 0;
          pet.state = PetState.IDLE;
          pet.frame = 0;
          pet.frameTimer = 0;
          pet.followTargetId = null;
        }
      }
    }

    // Reconcile pets against the layout roster (handles editor add/remove)
    this.rebuildPetsFromLayout(layout);
    // quiet-office: keep the reception chair reserved; the dim layer follows the new size.
    this.wpDim = null;
    if (this.wpMode) this.wpReserveReception();
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return;
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  getLayout(): OfficeLayout {
    return this.layout;
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return null;
    return `${seat.seatCol},${seat.seatRow}`;
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch);
    if (key) this.blockedTiles.delete(key);
    const result = fn();
    if (key) this.blockedTiles.add(key);
    return result;
  }

  /** Find the area label assigned to a seat's tile, or null. Public for e2e
   *  observability (getAgentSeats hook reads a seated agent's area). */
  seatZone(uid: string): string | null {
    const seat = this.seats.get(uid);
    if (!seat) return null;
    const tiles = this.layout.areaTiles;
    if (!tiles || tiles.length === 0) return null;
    const idx = seat.seatRow * this.layout.cols + seat.seatCol;
    if (idx < 0 || idx >= tiles.length) return null;
    return tiles[idx] ?? null;
  }

  /**
   * Random-pick a seat from a candidate list, biased toward seats that have a
   * PC of their own (see workstations.ts). Returns null when the list is empty.
   */
  private pickFromSeats(seatUids: string[]): string | null {
    if (seatUids.length === 0) return null;
    const pcSeats: string[] = [];
    const otherSeats: string[] = [];
    for (const uid of seatUids) {
      const seat = this.seats.get(uid);
      if (!seat) continue;
      if (this.seatWorkstations.has(uid)) {
        pcSeats.push(uid);
      } else {
        otherSeats.push(uid);
      }
    }
    if (pcSeats.length > 0) return pcSeats[Math.floor(Math.random() * pcSeats.length)];
    if (otherSeats.length > 0) return otherSeats[Math.floor(Math.random() * otherSeats.length)];
    return null;
  }

  /**
   * 3-stage seat picker for top-level agents.
   *
   *   Stage 1: If `directoryName` is given and `areaMappings[directoryName]` lists
   *            Area labels, prefer free seats whose tile is labeled with one
   *            of those areas.
   *   Stage 2: Prefer free seats whose tile has NO area label (unzoned).
   *   Stage 3: Any free seat.
   *
   * Each stage routes through `pickFromSeats` for the PC-bias rule. Returns
   * null only when every seat is already occupied. Passing `undefined`
   * preserves pre-Areas single-stage behavior (skips Stage 1; Stage 2 picks
   * unzoned seats from a layout without `areaTiles`, which is every seat).
   */
  private findFreeSeat(directoryName?: string): string | null {
    const freeSeats: string[] = [];
    // quiet-office: the reception chair is kept for the reception agent.
    const reception = this.wpMode ? this.wpReceptionUid() : null;
    for (const [uid, seat] of this.seats) {
      if (!seat.assigned && uid !== reception) freeSeats.push(uid);
    }
    if (freeSeats.length === 0) return null;

    const areaLabels = directoryName ? this.areaMappings[directoryName] : undefined;

    // Stage 1 — in-area seats for the Directory's mapped Area labels.
    if (areaLabels && areaLabels.length > 0) {
      const wanted = new Set(areaLabels);
      const inArea = freeSeats.filter((uid) => {
        const label = this.seatZone(uid);
        return label !== null && wanted.has(label);
      });
      const pick = this.pickFromSeats(inArea);
      if (pick) return pick;
    }

    // Stage 2 — unzoned seats (no area label, or layout has no areas at all).
    const unzoned = freeSeats.filter((uid) => this.seatZone(uid) === null);
    const pick2 = this.pickFromSeats(unzoned);
    if (pick2) return pick2;

    // Stage 3 — any free seat.
    return this.pickFromSeats(freeSeats);
  }

  /** The way a lead's sub-agents face: its seat's way (how it sits to work),
   *  or, seatless, its own. Not its walking direction while it wanders, or
   *  its helpers would spin with every step. */
  private helperFacing(lead: Character | undefined): Direction | null {
    if (!lead) return null;
    const seat = lead.seatId ? this.seats.get(lead.seatId) : undefined;
    return seat ? seat.facingDir : lead.dir;
  }

  /** Tiles taken, as `col,row` keys: every character's tile, except
   *  character `except`'s; with `destinations`, the tile each is walking to
   *  too; and `plus`, when given. */
  private takenTiles(opts: { except?: number; destinations?: boolean; plus?: Tile }): Set<string> {
    const taken = new Set<string>();
    if (opts.plus) taken.add(`${opts.plus.col},${opts.plus.row}`);
    for (const ch of this.characters.values()) {
      if (ch.id === opts.except) continue;
      taken.add(`${ch.tileCol},${ch.tileRow}`);
      if (!opts.destinations) continue;
      const end = ch.path[ch.path.length - 1];
      if (end) taken.add(`${end.col},${end.row}`);
    }
    return taken;
  }

  /** The walkable tile not in `taken` with the lowest `score`, or null. The
   *  first one found wins a tie. */
  private closestTile(taken: Set<string>, score: (tile: Tile) => number): Tile | null {
    let best: Tile | null = null;
    let bestScore = Infinity;
    for (const tile of this.walkableTiles) {
      if (taken.has(`${tile.col},${tile.row}`)) continue;
      const d = score(tile);
      if (d < bestScore) {
        best = tile;
        bestScore = d;
      }
    }
    return best;
  }

  /** Closest walkable tile to (col,row) not occupied by another character, or null. */
  private closestFreeWalkableTile(col: number, row: number): Tile | null {
    return this.closestTile(this.takenTiles({}), manhattanFrom({ col, row }));
  }

  /** The free walkable tile closest to `home` (the lead's seat) for helper
   *  `ch`: not `home` itself, and not one another character stands on or is
   *  walking to. */
  private helperSpot(ch: Character, home: Tile): Tile | null {
    return this.closestTile(
      this.takenTiles({ except: ch.id, destinations: true, plus: home }),
      ringsAround(home),
    );
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredRepeat?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    directoryName?: string,
    nearAgentId?: number,
  ): void {
    if (this.characters.has(id)) return;

    let palette: number;
    let repeat: number;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      repeat = preferredRepeat ?? 0;
    } else {
      // The server gave no look (core chooseLook: a random character, a repeat
      // only once the whole cast is in).
      const worn = [...this.characters.values()].filter((ch) => !ch.isSubagent);
      ({ palette, repeat } = chooseLook({ paletteCount: getLoadedCharacterCount(), worn }));
    }

    // Try preferred seat first, then (for teammates) the seat closest to the
    // anchor agent, then any free seat. anchorTile resolves to the anchor's SEAT
    // (stable from creation) rather than its live tile, so a teammate placed while
    // the lead is still walking to its seat still clusters around the final seat.
    const anchor = nearAgentId !== undefined ? this.characters.get(nearAgentId) : undefined;
    const anchorAt = anchorTile(anchor, this.seats);
    // quiet-office: the reception agent always takes the reception chair.
    let seatId: string | null = this.wpMode ? this.wpReceptionSeatFor(directoryName) : null;
    if (!seatId && preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!;
      if (!seat.assigned) {
        seatId = preferredSeatId;
      }
    }
    if (!seatId && anchorAt) {
      seatId = closestFreeSeat(this.seats, anchorAt.col, anchorAt.row);
    }
    if (!seatId) {
      seatId = this.findFreeSeat(directoryName);
    }

    let ch: Character;
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, seatId, seat, repeat);
    } else {
      // No seats — teammates spawn beside their anchor, others at a random walkable tile
      let spawn = anchorAt ? this.closestFreeWalkableTile(anchorAt.col, anchorAt.row) : null;
      if (!spawn) {
        spawn =
          this.walkableTiles.length > 0
            ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
            : { col: 1, row: 1 };
      }
      ch = createCharacter(id, palette, null, null, repeat);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }

    if (directoryName) {
      ch.directoryName = directoryName;
    }
    if (!skipSpawnEffect) {
      startMatrixEffect(ch, 'spawn');
    }
    this.characters.set(id, ch);
  }

  // ── Greeter ───────────────────────────────────────────────────
  // The Intro is diegetic: a character (Suit, by id: see greeterPalette) stands near the office's
  // bottom-left corner and "speaks" the tour through a DOM bubble
  // (IntroBubble). It is not an agent — see the `greeter` field.

  /** Spawn the greeter near the office's bottom-left corner: target tile
   *  GREETER_TILE_MARGIN in from the left and bottom edges, falling
   *  back to the closest walkable tile when the target is a seat, furniture,
   *  a wall, or VOID (seat tiles are in blockedTiles, so closestFreeWalkableTile
   *  covers every one of those). Idempotent; a remount mid-despawn (StrictMode)
   *  revives it. */
  spawnGreeter(): void {
    this.greeterCameraCancelled = false;
    if (this.greeter) {
      if (this.greeter.matrixEffect === 'despawn') startMatrixEffect(this.greeter, 'spawn');
      return;
    }
    const spawn = this.closestFreeWalkableTile(
      GREETER_TILE_MARGIN,
      this.layout.rows - 1 - GREETER_TILE_MARGIN,
    );
    if (!spawn) return; // no walkable tile — IntroBubble falls back to a fixed panel
    const ch = createCharacter(GREETER_ID, 0, null, null, 0);
    ch.isGreeter = true;
    ch.state = CharacterState.IDLE;
    ch.isActive = false;
    ch.dir = Direction.DOWN;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    startMatrixEffect(ch, 'spawn');
    this.greeter = ch;
  }

  /** Dress the greeter as a cast character (IntroBubble picks which). */
  setGreeterPalette(palette: number): void {
    if (this.greeter) this.greeter.palette = palette;
  }

  /** Start the greeter's despawn effect and release the greeter camera. The
   *  character is dropped once the effect finishes (see update()).
   *  Idempotent — every close path (answer, Escape, hooksStatus) funnels here. */
  despawnGreeter(): void {
    this.greeterCameraTarget = null;
    this.greeterCameraCancelled = false;
    if (!this.greeter || this.greeter.matrixEffect === 'despawn') return;
    startMatrixEffect(this.greeter, 'despawn');
  }

  /** Per-frame update from the bubble overlay; ignored once the user panned. */
  setGreeterCameraTarget(p: { x: number; y: number }): void {
    if (!this.greeterCameraCancelled) this.greeterCameraTarget = p;
  }

  /** Manual pan during the ask: stop re-centering until the next spawn. */
  cancelGreeterCamera(): void {
    this.greeterCameraTarget = null;
    this.greeterCameraCancelled = true;
  }

  /** Every manual pan (mouse, wheel, touch) takes the camera back from both
   *  automatic drivers: character follow and the greeter's ask. */
  breakCameraFollow(): void {
    this.cameraFollowId = null;
    this.cancelGreeterCamera();
  }

  /** Select an agent's character and have the camera follow it — what a card
   *  tap does to the office. No-op for an agent with no character. */
  selectAndFollow(id: number): void {
    if (!this.characters.has(id)) return;
    this.selectedAgentId = id;
    this.cameraFollowId = id;
  }

  /** The agent that owns `id`'s terminal: a sub-agent's parent, else itself. */
  terminalOwnerOf(id: number): number {
    return this.subagentMeta.get(id)?.parentAgentId ?? id;
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn') return; // already despawning
    // quiet-office: a closing lead gives its team room up too.
    const bookedRoom = this.wpLeadRoom.get(id);
    if (bookedRoom) this.wpReleaseRoom(bookedRoom);
    this.wpLounge.delete(id);
    this.wpStretch.delete(id);
    if (this.wpMail?.id === id) this.wpMail = null;
    // Give the seat up at once: a departing character holds none, so nothing
    // (a layout rebuild included) can mark it taken again during the effect.
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
      ch.seatId = null;
    }
    this.forgetSelection(id);
    // Start despawn animation instead of immediate delete
    startMatrixEffect(ch, 'despawn');
    ch.bubbleType = null;
  }

  /** Stop selecting and following a character that is leaving. */
  private forgetSelection(id: number): void {
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid;
    }
    return null;
  }

  /** Give an agent the server's look and seat (a reconnect's snapshot). The
   *  seat is taken only when it exists and no one else sits there. */
  syncAgent(agentId: number, palette?: number, repeat?: number, seatId?: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    if (palette !== undefined) {
      ch.palette = palette;
      ch.repeat = repeat ?? 0;
    }
    if (seatId !== undefined && seatId !== ch.seatId) {
      const seat = this.seats.get(seatId);
      if (seat && !seat.assigned) this.reassignSeat(agentId, seatId);
    }
  }

  /** Give an agent a new look (its character moved in the list); its sub-agents wear it too. */
  setAgentLook(agentId: number, palette: number, repeat: number): void {
    for (const ch of this.characters.values()) {
      if (ch.id === agentId || (ch.isSubagent && ch.parentAgentId === agentId)) {
        ch.palette = palette;
        ch.repeat = repeat;
      }
    }
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    // Assign new seat
    const seat = this.seats.get(seatId);
    if (!seat || seat.assigned) return;
    seat.assigned = true;
    ch.seatId = seatId;
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat or no path — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /**
   * Move a just-linked teammate to the free seat closest to its lead, so teams
   * cluster. Only moves when that seat is strictly closer than the teammate's
   * current one — a teammate created as a plain external agent (seated by an
   * arbitrary findFreeSeat) and tagged as a teammate only after tag discovery
   * would otherwise keep its arbitrary seat, unlike an inline teammate seated
   * next to the lead at creation.
   */
  private reseatNextToLead(teammateId: number, leadId: number): void {
    const teammate = this.characters.get(teammateId);
    const lead = this.characters.get(leadId);
    if (!teammate || !lead) return;
    const anchorAt = anchorTile(lead, this.seats);
    if (!anchorAt) return;
    const target = closestFreeSeat(this.seats, anchorAt.col, anchorAt.row);
    if (!target || target === teammate.seatId) return;
    const targetSeat = this.seats.get(target)!;
    const targetDist =
      Math.abs(targetSeat.seatCol - anchorAt.col) + Math.abs(targetSeat.seatRow - anchorAt.row);
    const currentSeat = teammate.seatId ? this.seats.get(teammate.seatId) : undefined;
    const currentDist = currentSeat
      ? Math.abs(currentSeat.seatCol - anchorAt.col) + Math.abs(currentSeat.seatRow - anchorAt.row)
      : Infinity;
    if (targetDist < currentDist) {
      this.reassignSeat(teammateId, target);
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || !ch.seatId) return;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return;
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch);
      if (!key || key !== `${col},${row}`) return false;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles),
    );
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const palette = parentCh ? parentCh.palette : 0;
    const repeat = parentCh ? parentCh.repeat : 0;

    // Spawn on the free walkable tile closest to the parent's seat (or to the
    // parent, when it has none) — where the helper will stay.
    const home = anchorTile(parentCh, this.seats) ?? { col: 0, row: 0 };
    let spawn = home;
    if (this.walkableTiles.length > 0) {
      spawn =
        this.closestTile(this.takenTiles({ plus: home }), ringsAround(home)) ??
        this.walkableTiles[0];
    }

    // quiet-office: a sub-agent comes in through the door, not out of its lead.
    if (this.wpMode) spawn = this.wpDoorTile() ?? spawn;

    const ch = createCharacter(id, palette, null, null, repeat);
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    // Face the same direction as the parent agent
    ch.dir = this.helperFacing(parentCh) ?? ch.dir;
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    const spot = this.resyncSubagentSpots.get(key);
    if (spot) {
      // Re-created by a resync replay: it never left, so no spawn effect.
      this.resyncSubagentSpots.delete(key);
      Object.assign(ch, spot);
      ch.seatId = null;
    } else {
      startMatrixEffect(ch, 'spawn');
    }
    this.characters.set(id, ch);
    // quiet-office: the lead books a team room; the sub takes its own seat there
    // (or a fallback place), then walks to it.
    if (this.wpMode) {
      ch.state = CharacterState.IDLE;
      this.wpEnsureRoom(parentAgentId);
      this.wpPlaceSubagent(ch, home, spot?.seatId ?? null);
    }

    this.subagentIdMap.set(key, id);
    this.subagentMeta.set(id, { parentAgentId, parentToolId });
    return id;
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) return;

    const ch = this.characters.get(id);
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key);
        this.subagentMeta.delete(id);
        return;
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      // Start despawn animation — keep character in map for rendering
      // quiet-office: or stand up, report to the lead, and leave by the door.
      if (this.wpMode) this.wpStartLeaving(ch, parentAgentId);
      else startMatrixEffect(ch, 'despawn');
      ch.bubbleType = null;
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key);
    this.subagentMeta.delete(id);
    this.forgetSelection(id);
  }

  /**
   * Drop every sub-agent at once, without despawn effects, ahead of a resync
   * snapshot. The snapshot replays the spawns that are still live, and each
   * comes back on the spot it left (see addSubagent); the rest were missed
   * clears and don't return.
   */
  detachSubagentsForResync(): void {
    this.resyncSubagentSpots.clear();
    for (const [key, id] of this.subagentIdMap) {
      const ch = this.characters.get(id);
      if (ch && ch.matrixEffect !== 'despawn') {
        const { x, y, tileCol, tileRow, dir, seatId } = ch;
        this.resyncSubagentSpots.set(key, { x, y, tileCol, tileRow, dir, seatId });
      }
      if (ch?.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      this.wpSubSpots.delete(id); // quiet-office
      this.characters.delete(id);
      this.forgetSelection(id);
    }
    this.subagentIdMap.clear();
    this.subagentMeta.clear();
    // quiet-office: rooms whose sub-agents the replay does not bring back are freed soon.
    for (const b of this.wpBookings.values()) b.releaseAt = this.wpTime + ROOM_RESYNC_HOLD_SEC;
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    // quiet-office: the lead is closing — its room is free at once.
    const bookedRoom = this.wpLeadRoom.get(parentAgentId);
    if (bookedRoom) this.wpReleaseRoom(bookedRoom);
    const toRemove: string[] = [];
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id);
            toRemove.push(key);
            continue;
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId);
            if (seat) seat.assigned = false;
          }
          // Start despawn animation
          // quiet-office: or walk out (its lead is usually closing: straight to the door)
          if (this.wpMode) this.wpStartLeaving(ch, parentAgentId);
          else startMatrixEffect(ch, 'despawn');
          ch.bubbleType = null;
        }
        this.subagentMeta.delete(id);
        this.forgetSelection(id);
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key);
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null;
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id);
    if (ch) {
      const turnEnded = !active && ch.isActive;
      ch.isActive = active;
      // Only a turn that just ended stands the agent up: one already at rest
      // (restored, or told again on a reconnect) keeps resting.
      if (turnEnded) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1;
        ch.path = [];
        ch.moveProgress = 0;
      }
      this.rebuildFurnitureInstances();
      if (this.wpMode) this.wpTrackWork(); // quiet-office
    }
  }

  /** Start an agent at rest: not working, and seated for a usual rest when it has a chair
   *  (then it gets up and wanders); without one it stands at once. */
  restAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.isActive = false;
    if (ch.seatId && ch.state === CharacterState.TYPE) restInChair(ch);
    else ch.seatTimer = 0;
    this.rebuildFurnitureInstances();
  }

  /**
   * The PCs whose seat has an agent working at it: active, sitting in that
   * seat and typing. Walking to the seat, resting there between turns, or
   * standing beside it does not count.
   */
  private litWorkstations(): Set<string> {
    const lit = new Set<string>();
    for (const ch of this.characters.values()) {
      // quiet-office: a seated sub-agent works until it is cleared, between tools too.
      const working = ch.isActive || (this.wpMode && ch.isSubagent && !this.wpLeaving.has(ch.id));
      if (!working || !ch.seatId || ch.state !== CharacterState.TYPE || ch.matrixEffect) {
        continue;
      }
      const seat = this.seats.get(ch.seatId);
      if (!seat || ch.tileCol !== seat.seatCol || ch.tileRow !== seat.seatRow) continue;
      const pc = this.seatWorkstations.get(ch.seatId);
      if (pc) lit.add(pc);
    }
    return lit;
  }

  /** Rebuild furniture instances with auto-state applied (a working agent's PC turns ON) */
  private rebuildFurnitureInstances(lit = this.litWorkstations()): void {
    this.litPcs = lit;
    if (lit.size === 0) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture);
      if (this.wpMode) this.wpDecorate(); // quiet-office
      return;
    }

    // Build modified furniture list with auto-state and animation applied
    const animFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      if (!lit.has(item.uid)) return item;
      let onType = getOnStateType(item.type);
      if (onType === item.type) return item;
      // Check if the on-state type has animation frames
      const frames = getAnimationFrames(onType);
      if (frames && frames.length > 1) onType = frames[animFrame % frames.length];
      return { ...item, type: onType };
    });

    this.furniture = layoutToFurnitureInstances(modifiedFurniture);
    if (this.wpMode) this.wpDecorate(); // quiet-office
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.currentTool = tool;
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'permission';
      ch.bubbleTimer = 0;
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  showWaitingBubble(id: number, awaitingInput = false): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.bubbleType = 'waiting';
      ch.waitingAwaitingInput = awaitingInput;
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || !ch.bubbleType) return;
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    } else if (ch.bubbleType === 'waiting') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
    }
  }

  // ── Pets ──────────────────────────────────────────────────────

  /**
   * Add a pet to the live runtime. Spawns at a uniformly-random walkable tile.
   * Mirror in `this.layout.pets` so debounced saveLayout serialises the roster.
   * Bounds-checks petType against the loaded sprite count to defend against stale layouts.
   */
  addPet(placedPet: PlacedPet): void {
    // Defensive guards (upstream 5e6c0a0)
    if (
      typeof placedPet.id !== 'string' ||
      placedPet.id.length === 0 ||
      placedPet.id.length > MAX_PET_ID_LENGTH
    ) {
      return;
    }
    if (
      !Number.isInteger(placedPet.petType) ||
      placedPet.petType < 0 ||
      placedPet.petType >= getPetCount()
    ) {
      return;
    }
    if (this.pets.some((p) => p.id === placedPet.id)) return; // de-dupe
    if (this.walkableTiles.length === 0) return; // no spawn space — silently drop

    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    const pet = createPet(placedPet.id, placedPet.petType, spawn.col, spawn.row);
    pet.name = getPetName(placedPet.petType);
    this.pets.push(pet);
    this.syncLayoutPets();
  }

  /** Remove a pet by id. Idempotent. */
  removePet(id: string): void {
    const before = this.pets.length;
    this.pets = this.pets.filter((p) => p.id !== id);
    if (this.pets.length !== before) {
      this.syncLayoutPets();
    }
  }

  /** Shallow snapshot for external consumers (renderer, hooks). */
  getPets(): Pet[] {
    return this.pets.slice();
  }

  /** Unique petType values currently placed. Used by the Pets toolbar to mark active rows. */
  getActivePetTypes(): number[] {
    const seen = new Set<number>();
    for (const p of this.pets) seen.add(p.petType);
    return Array.from(seen);
  }

  /**
   * Hit-test pets at a pixel world position. Sorts back-to-front (largest y wins on tie)
   * so the visually-frontmost pet receives the click.
   * Returns the pet id or null.
   */
  getPetAt(worldX: number, worldY: number): string | null {
    const ordered = this.pets.slice().sort((a, b) => b.y - a.y);
    for (const pet of ordered) {
      const left = pet.x - PET_HIT_HALF_WIDTH;
      const right = pet.x + PET_HIT_HALF_WIDTH;
      const top = pet.y - PET_HIT_HEIGHT;
      const bottom = pet.y;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return pet.id;
      }
    }
    return null;
  }

  /** Show the heart bubble on a pet for WAITING_BUBBLE_DURATION_SEC. */
  showPetBubble(petId: string): void {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet) return;
    pet.bubbleType = 'heart';
    pet.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
  }

  /** Dismiss the heart bubble on click; collapses timer to a fast fade. */
  dismissPetBubble(petId: string): void {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet || !pet.bubbleType) return;
    pet.bubbleTimer = Math.min(pet.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
  }

  /**
   * Reconcile `this.pets` to match the layout's placed-pet roster.
   * - Pets in layout but not in runtime → spawn via addPet().
   * - Pets in runtime but not in layout → remove.
   * - Pets in both → keep existing runtime state (position, FSM).
   *
   * Called from constructor and rebuildFromLayout. Always runs AFTER walkableTiles
   * is populated.
   */
  private rebuildPetsFromLayout(layout: OfficeLayout): void {
    const placed = layout.pets ?? [];
    const placedIds = new Set(placed.map((p) => p.id));

    // 1. Remove pets no longer in layout
    this.pets = this.pets.filter((p) => placedIds.has(p.id));

    // 2. Add pets that exist in layout but not in runtime
    const existingIds = new Set(this.pets.map((p) => p.id));
    for (const p of placed) {
      if (existingIds.has(p.id)) continue;
      this.addPet(p); // pushes onto this.pets, calls syncLayoutPets()
    }
    // syncLayoutPets() inside addPet keeps this.layout.pets coherent; one final
    // sync handles the removal-only branch where addPet was never called.
    this.syncLayoutPets();
  }

  /**
   * Re-export the current pet roster into `this.layout.pets`. Called only from
   * mutating methods (addPet / removePet / rebuildPetsFromLayout) — NEVER from
   * getLayout(), which runs on every render frame.
   */
  private syncLayoutPets(): void {
    this.layout.pets = this.pets.map((p) => ({ id: p.id, petType: p.petType }));
  }

  setTeamInfo(
    id: number,
    teamName?: string,
    agentName?: string,
    isTeamLead?: boolean,
    leadAgentId?: number,
    teamUsesTmux?: boolean,
  ): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    const wasUnlinked = ch.leadAgentId === undefined;
    ch.teamName = teamName;
    ch.agentName = agentName;
    ch.isTeamLead = isTeamLead;
    ch.leadAgentId = leadAgentId;
    if (teamUsesTmux !== undefined) {
      ch.teamUsesTmux = teamUsesTmux;
    }
    // A teammate is not a headless agent: clicking it focuses its lead's terminal.
    // Adopted sessions are marked headless at creation and only later discovered
    // to be teammates, so drop the mark once the link lands.
    if (leadAgentId !== undefined) {
      ch.isHeadless = false;
    }
    // A teammate discovered only after its plain external session was adopted is
    // linked here, not at creation, so it never went through the seat-next-to-lead
    // path addAgent runs for inline teammates. Cluster it now, once, on first link.
    if (wasUnlinked && leadAgentId !== undefined && !isTeamLead) {
      this.reseatNextToLead(id, leadAgentId);
    }
  }

  /** Mark an agent as headless (adopted, no terminal to focus). */
  setHeadless(id: number, headless: boolean): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.isHeadless = headless;
  }

  setAgentContext(id: number, contextTokens: number, maxContextTokens: number): void {
    const ch = this.characters.get(id);
    if (!ch || contextUsedShare(contextTokens, maxContextTokens) === null) return;
    ch.contextTokens = contextTokens;
    ch.maxContextTokens = maxContextTokens;
    ch.contextReported = true;
  }

  update(dt: number): void {
    // quiet-office: scoreboard, clock and blink phase; picked up by the furniture rebuild below.
    if (this.wpMode) {
      this.wpTime += dt;
      this.wpReserveReception();
      this.wpTickRooms();
      this.wpCheckTeams(dt);
      this.wpTickAllDone();
      this.wpTickMail();
      this.wpTickDecor();
    }
    // Furniture animation cycling
    const prevFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    this.furnitureAnimTimer += dt;
    const newFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    if (newFrame !== prevFrame) {
      this.rebuildFurnitureInstances();
    }

    // The greeter materializes and dematerializes like anyone else, but runs
    // no FSM — it stands where it spawned for as long as the ask is up.
    if (this.greeter) tickBlink(this.greeter, dt, false);
    if (this.greeter && advanceMatrixEffect(this.greeter, dt) === 'despawned') {
      this.greeter = null;
    }

    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      tickBlink(ch, dt, ch.state === CharacterState.TYPE);
      const effect = advanceMatrixEffect(ch, dt);
      if (effect !== 'none') {
        if (effect === 'despawned') toDelete.push(ch.id);
        continue; // skip normal FSM while the effect is (or just was) active
      }

      if (this.wpMode && ch.isSubagent && this.wpUpdateSubagent(ch, dt)) {
        // quiet-office: handled (own seat, fallback spot, or leaving)
      } else if (ch.isSubagent) {
        const lead = ch.parentAgentId !== null ? this.characters.get(ch.parentAgentId) : undefined;
        // Helpers gather around the lead's seat, not the lead: an idle lead
        // wanders, and its helpers should not trail it around the office.
        const home = anchorTile(lead, this.seats) ?? null;
        updateHelper(
          ch,
          dt,
          home,
          this.helperFacing(lead),
          () => (home ? this.helperSpot(ch, home) : null),
          this.tileMap,
          this.blockedTiles,
        );
      } else if (this.wpMode && this.wpLeadRoom.has(ch.id)) {
        this.wpUpdateLead(ch, dt); // quiet-office: in its team room
      } else if (this.wpMode && this.wpStretch.has(ch.id)) {
        this.wpUpdateStretch(ch, dt); // quiet-office: "all done"
      } else if (this.wpMode && this.wpAtReception(ch)) {
        this.wpUpdateReception(ch, dt); // quiet-office: always at reception
      } else {
        if (this.wpMode) this.wpLoungeStep(ch, dt); // quiet-office
        // Temporarily unblock own seat so character can pathfind to it
        this.withOwnSeatUnblocked(ch, () =>
          updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles),
        );
      }

      // Tick bubble timer for waiting bubbles
      if (ch.bubbleType === 'waiting') {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
      }
    }
    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id);
      // quiet-office
      this.wpLounge.delete(id);
      this.wpSubSpots.delete(id);
      this.wpLeaving.delete(id);
      this.wpSeatRetry.delete(id);
      this.wpStretch.delete(id);
    }

    // A PC turns on when its agent sits down to work, not when the turn starts.
    const lit = this.litWorkstations();
    if (!sameSet(lit, this.litPcs)) this.rebuildFurnitureInstances(lit);

    // ── Pet FSM ────────────────────────────────────────────────
    for (const pet of this.pets) {
      updatePet(pet, dt, this.walkableTiles, this.characters, this.tileMap, this.blockedTiles);

      // Tick heart bubble timer (mirrors character waiting-bubble pattern)
      if (pet.bubbleType) {
        pet.bubbleTimer -= dt;
        if (pet.bubbleTimer <= 0) {
          pet.bubbleType = null;
          pet.bubbleTimer = 0;
        }
      }
    }
  }

  // ── quiet-office ─────────────────────────────────────────────
  // Lounge visits for idle agents, a desk of its own for every sub-agent (and a
  // walk out when it is done), and the decor: scoreboard, clock, alert blink,
  // night glow. Only with wpMode (wallpaper mode).

  /** Places derived from the layout, recomputed when the seats are rebuilt. */
  private wpGeometry(): WpGeometry {
    if (this.wpGeo && this.wpGeoSeats === this.seats) return this.wpGeo;
    const index = new Map<string, number>();
    let whiteboardUid: string | null = null;
    let clockUid: string | null = null;
    const sofaUids: string[] = [];
    const loungeTiles: Tile[] = [];
    const tableTiles = new Set<string>();
    let i = 0;
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry) continue;
      index.set(item.uid, i++);
      const base = baseType(item.type);
      if (base === 'WHITEBOARD' && !whiteboardUid) whiteboardUid = item.uid;
      if (base === 'CLOCK' && !clockUid) clockUid = item.uid;
      const tiles = footprint(item.col, item.row, entry.footprintW, entry.footprintH);
      if (base.startsWith('SOFA_')) sofaUids.push(item.uid);
      if (base.startsWith('SOFA_') || base === 'COFFEE_TABLE' || base === 'COFFEE') {
        loungeTiles.push(...tiles);
      }
      if (base.startsWith('TABLE')) for (const t of tiles) tableTiles.add(`${t.col},${t.row}`);
    }

    const sofaSpots: LoungeSpot[] = [];
    const others: Seat[] = [];
    for (const seat of this.seats.values()) {
      if (sofaUids.some((u) => seat.uid === u || seat.uid.startsWith(`${u}:`))) {
        sofaSpots.push({ col: seat.seatCol, row: seat.seatRow, dir: seat.facingDir, seatUid: seat.uid });
      } else {
        others.push(seat);
      }
    }
    const atTable = (seat: Seat) => {
      const step = DIR_STEPS.find((d) => d.dir === seat.facingDir)!;
      return tableTiles.has(`${seat.seatCol + step.dc},${seat.seatRow + step.dr}`);
    };
    const rooms = this.wpFindRooms(others, atTable);
    const inRoom = new Set(rooms.flatMap((r) => r.seats));
    const meetingSeats = rooms.filter((r) => !r.team).flatMap((r) => r.seats);
    const reception = this.wpReceptionUid();
    const deskSeats = others
      .filter((seat) => !inRoom.has(seat.uid) && !atTable(seat) && seat.uid !== reception)
      .map((seat) => seat.uid);

    const standSpots: LoungeSpot[] = [];
    const seen = new Set<string>();
    for (const t of loungeTiles) {
      for (const d of DIR_STEPS) {
        const col = t.col - d.dc;
        const row = t.row - d.dr;
        const key = `${col},${row}`;
        if (seen.has(key) || !isWalkable(col, row, this.tileMap, this.blockedTiles)) continue;
        seen.add(key);
        standSpots.push({ col, row, dir: d.dir });
      }
    }

    this.wpGeo = {
      index,
      whiteboardUid,
      clockUid,
      sofaSpots,
      standSpots,
      meetingSeats,
      deskSeats,
      doors: this.wpFindDoors(),
      rooms,
    };
    this.wpGeoSeats = this.seats;
    return this.wpGeo;
  }

  /**
   * Rooms from the layout's `wallpaperRooms` metadata (team rooms in listed order,
   * then lounge tables; an empty list means no rooms). Without the field: every labelled area with seats is a team room
   * (label order) and the table-facing seats outside them form the lounge table.
   * A room's head seat is `headSeat`, else its top chair facing down onto the table.
   */
  private wpFindRooms(seats: Seat[], atTable: (seat: Seat) => boolean): WpRoom[] {
    const meta = (this.layout as OfficeLayout & WallpaperLayoutMeta).wallpaperRooms;
    /** signSpan: door width in tiles; the sign is centred over that many tiles from `sign`. */
    const groups: Array<{ meta: WallpaperRoomMeta; seats: Seat[]; signSpan?: number }> = [];
    if (Array.isArray(meta)) {
      for (const m of meta) {
        const b = m.bounds;
        if (!b) continue;
        const inside = seats.filter(
          (s) => s.seatCol >= b.c0 && s.seatCol <= b.c1 && s.seatRow >= b.r0 && s.seatRow <= b.r1,
        );
        groups.push({ meta: m, seats: inside });
      }
    } else {
      const cols = this.layout.cols;
      const tiles = this.layout.areaTiles ?? [];
      const labels = (this.layout.areas ?? []).map((a) => a.label).sort();
      const zoned = new Set<string>();
      for (const label of labels) {
        let c0 = Infinity;
        let c1 = -1;
        let r0 = Infinity;
        let r1 = -1;
        tiles.forEach((t, i) => {
          if (t !== label) return;
          c0 = Math.min(c0, i % cols);
          c1 = Math.max(c1, i % cols);
          r0 = Math.min(r0, Math.floor(i / cols));
          r1 = Math.max(r1, Math.floor(i / cols));
        });
        const inside = seats.filter((s) => this.seatZone(s.uid) === label);
        for (const s of inside) zoned.add(s.uid);
        // The door: the floor gap in the wall row above the room. The sign hangs
        // centred over it (beside the door it would sit under the lead's name label).
        const wallRow = r0 - 1;
        const gap: number[] = [];
        for (let c = c0; c <= c1; c++) {
          const t = this.tileMap[wallRow]?.[c];
          if (t !== undefined && t !== TileType.WALL && t !== TileType.VOID) gap.push(c);
        }
        const door: Tile | undefined = gap.length > 0 ? { col: gap[0], row: wallRow } : undefined;
        const sign: Tile | undefined = door;
        const signSpan = Math.max(1, gap.length);
        groups.push({
          meta: { id: label, kind: 'team', bounds: { c0, r0, c1, r1 }, door, sign },
          seats: inside,
          signSpan,
        });
      }
      const lounge = seats.filter((s) => !zoned.has(s.uid) && atTable(s));
      if (lounge.length > 0) {
        groups.push({ meta: { id: 'lounge', kind: 'lounge-table', bounds: { c0: 0, r0: 0, c1: 0, r1: 0 } }, seats: lounge });
      }
    }

    const rooms: WpRoom[] = [];
    for (const { meta: m, seats: inside, signSpan = 1 } of groups) {
      if (inside.length < 2) continue;
      const head =
        (m.headSeat && inside.find((s) => s.seatCol === m.headSeat!.col && s.seatRow === m.headSeat!.row)) ||
        [...inside].sort(
          (a, b) =>
            Number(b.facingDir === Direction.DOWN) - Number(a.facingDir === Direction.DOWN) ||
            a.seatRow - b.seatRow ||
            a.seatCol - b.seatCol,
        )[0];
      const team = m.kind === 'team';
      rooms.push({
        id: m.id,
        team,
        seats: [head.uid, ...inside.filter((s) => s !== head).map((s) => s.uid)],
        door: m.door ?? { col: head.seatCol, row: head.seatRow },
        sign:
          team && m.sign
            ? {
                cx: m.sign.col * TILE_SIZE + (signSpan * TILE_SIZE) / 2,
                minX: m.bounds.c0 * TILE_SIZE + 1,
                maxX: (m.bounds.c1 + 1) * TILE_SIZE - 1,
                // Hangs from the top of the door opening.
                y: m.sign.row * TILE_SIZE - SIGN_H + 4,
                row: m.sign.row,
              }
            : null,
        rect: team
          ? { col: m.bounds.c0, row: m.bounds.r0, w: m.bounds.c1 - m.bounds.c0 + 1, h: m.bounds.r1 - m.bounds.r0 + 1 }
          : null,
      });
    }
    // Team rooms are booked first.
    return [...rooms.filter((r) => r.team), ...rooms.filter((r) => !r.team)];
  }

  /** Floor tiles in a partition wall (a wall column with floor on both sides, above
   *  and below the gap), middle first. Falls back to the bottom-centre floor tile. */
  private wpFindDoors(): Tile[] {
    const entrance = (this.layout as OfficeLayout & WallpaperLayoutMeta).wallpaperEntrance;
    if (entrance && isWalkable(entrance.col, entrance.row, this.tileMap, this.blockedTiles)) {
      // Spread arrivals over the entrance and its free neighbours.
      const out: Tile[] = [entrance];
      for (const d of DIR_STEPS) {
        const t = { col: entrance.col + d.dc, row: entrance.row + d.dr };
        if (isWalkable(t.col, t.row, this.tileMap, this.blockedTiles)) out.push(t);
      }
      return out;
    }
    const map = this.tileMap;
    const rows = map.length;
    const cols = rows > 0 ? map[0].length : 0;
    const floor = (c: number, r: number) =>
      r >= 0 && r < rows && c >= 0 && c < cols && map[r][c] !== TileType.WALL && map[r][c] !== TileType.VOID;
    const partition = (c: number, r: number) =>
      map[r]?.[c] === TileType.WALL && floor(c - 1, r) && floor(c + 1, r);
    const doors: Tile[] = [];
    for (let c = 1; c < cols - 1; c++) {
      for (let r = 0; r < rows; r++) {
        if (!floor(c, r) || !isWalkable(c, r, map, this.blockedTiles)) continue;
        let above = false;
        let below = false;
        for (let k = r - 1; k >= 0 && !above; k--) above = partition(c, k);
        for (let k = r + 1; k < rows && !below; k++) below = partition(c, k);
        if (above && below) doors.push({ col: c, row: r });
      }
    }
    if (doors.length > 0) {
      const mc = doors.reduce((a, d) => a + d.col, 0) / doors.length;
      const mr = doors.reduce((a, d) => a + d.row, 0) / doors.length;
      doors.sort((a, b) => Math.abs(a.col - mc) + Math.abs(a.row - mr) - (Math.abs(b.col - mc) + Math.abs(b.row - mr)));
      return doors;
    }
    const fallback = this.closestTile(new Set(), manhattanFrom({ col: Math.floor(cols / 2), row: rows - 1 }));
    return fallback ? [fallback] : [];
  }

  /** A free door tile (no one on it or walking to it), else the walkable tile closest to the door. */
  private wpDoorTile(): Tile | null {
    const doors = this.wpGeometry().doors;
    if (doors.length === 0) return null;
    const taken = this.takenTiles({ destinations: true });
    return doors.find((d) => !taken.has(`${d.col},${d.row}`)) ?? this.closestTile(taken, manhattanFrom(doors[0]));
  }

  // ── Sub-agents ────────────────────────────────────────────────

  /**
   * The free seat for a sub-agent: `preferred` when still free; with a booked room,
   * a room seat, then the open-plan desk nearest the room door; otherwise the desk
   * seat nearest `home` (its lead's seat), then a lounge-table seat (unless another
   * lead booked that table).
   */
  private wpFreeSubSeat(ch: Character, home: Tile | null, preferred: string | null): string | null {
    const taken = this.takenTiles({ except: ch.id, destinations: true });
    const free = (uid: string) => {
      const seat = this.seats.get(uid);
      return !!seat && !seat.assigned && !taken.has(`${seat.seatCol},${seat.seatRow}`);
    };
    if (preferred && free(preferred)) return preferred;
    const geo = this.wpGeometry();
    const roomId = ch.parentAgentId !== null ? this.wpLeadRoom.get(ch.parentAgentId) : undefined;
    const room = roomId ? geo.rooms.find((r) => r.id === roomId) : undefined;
    let from = home ?? { col: ch.tileCol, row: ch.tileRow };
    const groups: string[][] = [geo.deskSeats];
    if (room) {
      const inRoom = room.seats.slice(1).find(free);
      if (inRoom) return inRoom;
      from = room.door;
    }
    const loungeBooked = geo.rooms.some((r) => !r.team && this.wpBookings.has(r.id) && r.id !== roomId);
    if (!loungeBooked) groups.push(geo.meetingSeats);
    for (const group of groups) {
      let best: string | null = null;
      let bestD = Infinity;
      for (const uid of group) {
        if (!free(uid)) continue;
        const seat = this.seats.get(uid)!;
        const d = Math.abs(seat.seatCol - from.col) + Math.abs(seat.seatRow - from.row);
        if (d < bestD) {
          best = uid;
          bestD = d;
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Give a sub-agent its own seat, else a free standing spot in the lounge; with
   *  neither it keeps the upstream behaviour (stands near its lead). */
  private wpPlaceSubagent(ch: Character, home: Tile | null, preferred: string | null): void {
    const seatUid = this.wpFreeSubSeat(ch, home, preferred);
    if (seatUid) {
      this.seats.get(seatUid)!.assigned = true;
      ch.seatId = seatUid;
      this.wpSubSpots.delete(ch.id);
      this.wpSeatRetry.delete(ch.id);
      ch.wanderTimer = 0;
      return;
    }
    if (this.wpSubSpots.has(ch.id)) return;
    const taken = this.takenTiles({ except: ch.id, destinations: true });
    for (const v of this.wpSubSpots.values()) taken.add(`${v.col},${v.row}`);
    const spot = this.wpGeometry().standSpots.find((s) => !taken.has(`${s.col},${s.row}`));
    if (spot) this.wpSubSpots.set(ch.id, spot);
  }

  /** One frame of a wallpaper sub-agent. False = not handled (use updateHelper). */
  private wpUpdateSubagent(ch: Character, dt: number): boolean {
    if (this.wpLeaving.has(ch.id)) {
      this.wpUpdateLeaver(ch, dt);
      return true;
    }
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (!seat) {
        ch.seatId = null;
        return false;
      }
      const key = `${seat.seatCol},${seat.seatRow}`;
      const had = this.blockedTiles.delete(key);
      updateWorker(
        ch,
        dt,
        { col: seat.seatCol, row: seat.seatRow, dir: seat.facingDir, sit: true },
        this.tileMap,
        this.blockedTiles,
      );
      if (had) this.blockedTiles.add(key);
      return true;
    }
    // No seat yet: look again now and then (one may have freed up).
    const retry = (this.wpSeatRetry.get(ch.id) ?? SEAT_RETRY_SEC) - dt;
    this.wpSeatRetry.set(ch.id, retry);
    if (retry <= 0 && ch.moveProgress === 0) {
      this.wpSeatRetry.set(ch.id, SEAT_RETRY_SEC);
      const lead = ch.parentAgentId !== null ? this.characters.get(ch.parentAgentId) : undefined;
      this.wpPlaceSubagent(ch, anchorTile(lead, this.seats) ?? null, null);
      if (ch.seatId) return true;
    }
    const spot = this.wpSubSpots.get(ch.id);
    if (!spot) return false;
    updateWorker(ch, dt, { ...spot, sit: false }, this.tileMap, this.blockedTiles);
    return true;
  }

  /** Done: give the seat up now, then report at the lead's desk and leave by the door. */
  private wpStartLeaving(ch: Character, leadId: number): void {
    if (ch.matrixEffect === 'spawn') {
      startMatrixEffect(ch, 'despawn');
      return;
    }
    ch.seatId = null;
    ch.isActive = false;
    ch.currentTool = null;
    ch.path = ch.moveProgress > 0 && ch.path.length > 0 ? [ch.path[0]] : [];
    this.wpSubSpots.delete(ch.id);
    this.wpSeatRetry.delete(ch.id);
    this.wpLeaving.set(ch.id, { phase: 'report', leadId, timer: 0, tried: false });
  }

  private wpWalkTo(ch: Character, to: Tile): boolean {
    const path = findPath(ch.tileCol, ch.tileRow, to.col, to.row, this.tileMap, this.blockedTiles);
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  private wpUpdateLeaver(ch: Character, dt: number): void {
    const lv = this.wpLeaving.get(ch.id)!;
    if (walkPath(ch, dt)) return;
    if (lv.phase === 'report') {
      const lead = this.characters.get(lv.leadId);
      const home = lead && lead.matrixEffect !== 'despawn' ? this.wpLeadHome(lead) : null;
      if (!home) {
        lv.phase = 'door';
        lv.tried = false;
      } else if (Math.abs(ch.tileCol - home.col) + Math.abs(ch.tileRow - home.row) <= 2 || lv.tried) {
        lv.phase = 'wait';
        lv.timer = REPORT_SEC;
        ch.dir = facingToward({ col: ch.tileCol, row: ch.tileRow }, home);
      } else {
        lv.tried = true;
        const spot = this.closestTile(
          this.takenTiles({ except: ch.id, destinations: true, plus: home }),
          manhattanFrom(home),
        );
        if (!spot || !this.wpWalkTo(ch, spot)) {
          lv.phase = 'door';
          lv.tried = false;
        }
      }
      return;
    }
    if (lv.phase === 'wait') {
      lv.timer -= dt;
      if (lv.timer <= 0) {
        lv.phase = 'door';
        lv.tried = false;
      }
      return;
    }
    // Door: walk there once, then dematerialize (also when the door is unreachable).
    if (!lv.tried) {
      lv.tried = true;
      const door = this.wpGeometry().doors[0];
      if (door && this.wpWalkTo(ch, door)) return;
    }
    this.wpLeaving.delete(ch.id);
    startMatrixEffect(ch, 'despawn');
  }

  // ── Team rooms ────────────────────────────────────────────────

  /** A lead with sub-agents books the first free room (team rooms, then the lounge
   *  table) and moves to its head seat; its own desk stays reserved for it. A lead
   *  that already has one keeps it (a follow-up fan-out cancels the release hold). */
  private wpEnsureRoom(leadId: number): void {
    const booked = this.wpLeadRoom.get(leadId);
    if (booked) {
      const b = this.wpBookings.get(booked);
      if (b) b.releaseAt = null;
      return;
    }
    const lead = this.characters.get(leadId);
    if (!lead || lead.isSubagent || lead.matrixEffect === 'despawn') return;
    const taken = this.takenTiles({ except: leadId, destinations: true });
    for (const room of this.wpGeometry().rooms) {
      if (this.wpBookings.has(room.id)) continue;
      const head = this.seats.get(room.seats[0]);
      if (!head || head.assigned || taken.has(`${head.seatCol},${head.seatRow}`)) continue;
      head.assigned = true;
      this.wpBookings.set(room.id, { leadId, releaseAt: null });
      this.wpLeadRoom.set(leadId, room.id);
      this.wpLounge.delete(leadId);
      lead.wanderTimer = 0;
      if (lead.moveProgress === 0) lead.path = [];
      return;
    }
  }

  /** Free a room now: its head seat, and the lead walks back to its own desk. */
  private wpReleaseRoom(roomId: string): void {
    const b = this.wpBookings.get(roomId);
    if (!b) return;
    this.wpBookings.delete(roomId);
    this.wpLeadRoom.delete(b.leadId);
    const room = this.wpGeometry().rooms.find((r) => r.id === roomId);
    const head = room ? this.seats.get(room.seats[0]) : undefined;
    if (head) head.assigned = false;
    const lead = this.characters.get(b.leadId);
    if (!lead || lead.matrixEffect === 'despawn') return;
    lead.wanderCount = 0;
    if (lead.moveProgress > 0) return; // mid-step: the FSM takes over from the next tile
    lead.path = [];
    lead.state = CharacterState.IDLE;
    lead.frame = 0;
    lead.frameTimer = 0;
    if (lead.seatId) this.sendToSeat(lead.id);
  }

  /** Hold or free each booked room: held while the lead has sub-agents, freed
   *  ROOM_HOLD_SEC after the last one left, or at once when the lead is gone. */
  private wpTickRooms(): void {
    const rooms = this.wpGeometry().rooms;
    for (const [roomId, b] of this.wpBookings) {
      const lead = this.characters.get(b.leadId);
      const room = rooms.find((r) => r.id === roomId);
      if (!lead || lead.matrixEffect === 'despawn' || !room) {
        this.wpReleaseRoom(roomId);
        continue;
      }
      // A layout rebuild clears every seat's mark: the head seat stays the lead's.
      const head = this.seats.get(room.seats[0]);
      if (head) head.assigned = true;
      let team = false;
      for (const ch of this.characters.values()) {
        if (
          ch.isSubagent &&
          ch.parentAgentId === b.leadId &&
          ch.matrixEffect !== 'despawn' &&
          !this.wpLeaving.has(ch.id)
        ) {
          team = true;
          break;
        }
      }
      if (team) {
        b.releaseAt = null;
      } else if (b.releaseAt === null) {
        b.releaseAt = this.wpTime + ROOM_HOLD_SEC;
      } else if (this.wpTime >= b.releaseAt) {
        this.wpReleaseRoom(roomId);
      }
    }
  }

  /**
   * Every TEAM_CHECK_SEC: a lead with sub-agents but no room books one (its subs
   * may have arrived before it, or before the layout), and a sub-agent outside its
   * lead's room moves to a free seat there.
   */
  private wpCheckTeams(dt: number): void {
    this.wpTeamCheck -= dt;
    if (this.wpTeamCheck > 0) return;
    this.wpTeamCheck = TEAM_CHECK_SEC;
    this.wpCheckReception();
    const rooms = this.wpGeometry().rooms;
    for (const ch of this.characters.values()) {
      if (!ch.isSubagent || ch.parentAgentId === null || ch.matrixEffect || this.wpLeaving.has(ch.id)) continue;
      if (!this.characters.has(ch.parentAgentId)) continue;
      if (!this.wpLeadRoom.has(ch.parentAgentId)) this.wpEnsureRoom(ch.parentAgentId);
      const room = rooms.find((r) => r.id === this.wpLeadRoom.get(ch.parentAgentId!));
      if (!room || (ch.seatId && room.seats.includes(ch.seatId))) continue;
      const taken = this.takenTiles({ except: ch.id, destinations: true });
      const uid = room.seats.slice(1).find((u) => {
        const seat = this.seats.get(u);
        return !!seat && !seat.assigned && !taken.has(`${seat.seatCol},${seat.seatRow}`);
      });
      if (!uid) continue;
      if (ch.seatId) {
        const old = this.seats.get(ch.seatId);
        if (old) old.assigned = false;
      }
      this.seats.get(uid)!.assigned = true;
      ch.seatId = uid;
      this.wpSubSpots.delete(ch.id);
      this.wpSeatRetry.delete(ch.id);
      ch.wanderTimer = 0;
    }
  }

  /** One frame of a lead in its room: walk to the head seat and work there. */
  private wpUpdateLead(ch: Character, dt: number): void {
    const room = this.wpGeometry().rooms.find((r) => r.id === this.wpLeadRoom.get(ch.id));
    const head = room ? this.seats.get(room.seats[0]) : undefined;
    if (!head) {
      const id = this.wpLeadRoom.get(ch.id);
      if (id) this.wpReleaseRoom(id);
      return;
    }
    const key = `${head.seatCol},${head.seatRow}`;
    const had = this.blockedTiles.delete(key);
    updateWorker(
      ch,
      dt,
      { col: head.seatCol, row: head.seatRow, dir: head.facingDir, sit: true },
      this.tileMap,
      this.blockedTiles,
    );
    if (had) this.blockedTiles.add(key);
  }

  /** Where a lead works: its room's head seat while booked, else its own seat. */
  private wpLeadHome(lead: Character): Tile | null {
    const roomId = this.wpLeadRoom.get(lead.id);
    const room = roomId ? this.wpGeometry().rooms.find((r) => r.id === roomId) : undefined;
    const head = room ? this.seats.get(room.seats[0]) : undefined;
    if (head) return { col: head.seatCol, row: head.seatRow };
    return anchorTile(lead, this.seats) ?? null;
  }

  /** quiet-office: room occupancy for overlays. seatsUsed counts the lead and the
   *  sub-agents seated (or walking to a seat) in the room. */
  getRoomStates(): RoomState[] {
    if (!this.wpMode) return [];
    const out: RoomState[] = [];
    for (const room of this.wpGeometry().rooms) {
      const b = this.wpBookings.get(room.id);
      const lead = b ? this.characters.get(b.leadId) : undefined;
      const inRoom = new Set(room.seats);
      let used = b ? 1 : 0;
      for (const ch of this.characters.values()) {
        if (ch.isSubagent && ch.seatId && inRoom.has(ch.seatId)) used++;
      }
      out.push({
        id: room.id,
        leadId: b ? b.leadId : null,
        leadName: lead ? this.wpDisplayName(lead) : null,
        seatsUsed: used,
        seatsTotal: room.seats.length,
      });
    }
    return out;
  }

  /** Door signs drawn this frame, in world px: overlay labels keep clear of them. */
  getSignRects(): ReadonlyArray<{ x: number; y: number; w: number; h: number }> {
    return this.wpSignRects;
  }

  private wpDisplayName(ch: Character): string {
    return ch.agentName || ch.directoryName || `#${String(ch.id)}`;
  }

  // ── Lounge ────────────────────────────────────────────────────

  private wpPickLoungeSpot(ch: Character): LoungeSpot | null {
    const geo = this.wpGeometry();
    const taken = this.takenTiles({ except: ch.id, destinations: true });
    for (const v of this.wpLounge.values()) taken.add(`${v.col},${v.row}`);
    for (const v of this.wpSubSpots.values()) taken.add(`${v.col},${v.row}`);
    const open = (s: LoungeSpot) => !taken.has(`${s.col},${s.row}`);
    const sofas = geo.sofaSpots.filter((s) => open(s) && !this.seats.get(s.seatUid!)?.assigned);
    const stands = geo.standSpots.filter(open);
    const pool =
      sofas.length > 0 && (stands.length === 0 || Math.random() < LOUNGE_SOFA_CHANCE) ? sofas : stands;
    return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  /**
   * An idle agent, before its FSM runs: most wanders go to the lounge, where it
   * sits on a sofa or stands by the coffee for a while, then heads back to its
   * own seat for the usual rest. Work, a permission prompt or a question to
   * answer ends the visit (the FSM walks it back to its desk).
   */
  private wpLoungeStep(ch: Character, dt: number): void {
    const visit = this.wpLounge.get(ch.id);
    const idle =
      !ch.isActive &&
      ch.bubbleType !== 'permission' &&
      !ch.waitingAwaitingInput &&
      ch.matrixEffect === null;
    if (!idle) {
      if (visit) {
        this.wpLounge.delete(ch.id);
        if (ch.state === CharacterState.TYPE && visit.arrived) {
          ch.state = CharacterState.IDLE; // off the sofa; the FSM paths to the desk
          ch.frame = 0;
          ch.frameTimer = 0;
        }
      }
      return;
    }

    if (visit) {
      if (!visit.arrived) {
        if (ch.state === CharacterState.WALK) return;
        if (ch.tileCol !== visit.col || ch.tileRow !== visit.row) {
          this.wpLounge.delete(ch.id);
          return;
        }
        visit.arrived = true;
        ch.dir = visit.dir;
        ch.frame = 0;
        ch.frameTimer = 0;
        const dwell = randomBetween(LOUNGE_DWELL_MIN_SEC, LOUNGE_DWELL_MAX_SEC);
        if (visit.seatUid) {
          ch.state = CharacterState.TYPE;
          ch.seatTimer = dwell;
        } else {
          ch.state = CharacterState.IDLE;
          ch.wanderTimer = dwell;
        }
        return;
      }
      if (ch.tileCol !== visit.col || ch.tileRow !== visit.row || ch.state === CharacterState.WALK) {
        this.wpLounge.delete(ch.id);
        return;
      }
      if (ch.state !== CharacterState.IDLE) return; // still on the sofa
      // Dwell over (stood up from the sofa, or done standing): back to the desk to rest.
      if (visit.seatUid || ch.wanderTimer - dt <= 0) {
        ch.wanderCount = ch.wanderLimit;
        ch.wanderTimer = Math.min(ch.wanderTimer, randomBetween(0.5, 2));
        this.wpLounge.delete(ch.id);
      }
      return;
    }

    if (ch.state !== CharacterState.IDLE || ch.wanderTimer - dt > 0) return;
    if (ch.wanderCount >= ch.wanderLimit && ch.seatId) return; // resting time: the FSM goes home
    if (Math.random() >= LOUNGE_CHANCE) return;
    const spot = this.wpPickLoungeSpot(ch);
    if (!spot) return;
    const key = `${spot.col},${spot.row}`;
    const had = spot.seatUid ? this.blockedTiles.delete(key) : false;
    const ok = this.wpWalkTo(ch, spot);
    if (had) this.blockedTiles.add(key);
    if (!ok) return;
    ch.wanderCount++;
    ch.wanderTimer = randomBetween(2, 5);
    this.wpLounge.set(ch.id, { ...spot, arrived: false });
  }

  // ── Decor ─────────────────────────────────────────────────────

  /** Scoreboard counts, the clock's minute and the blink phase. Sprites are rebuilt
   *  only when what they show changes. */
  private wpTickDecor(): void {
    setDecorBlink(Math.floor(this.furnitureAnimTimer / ALERT_BLINK_SEC) % 2 === 0);

    const counts: ScoreCounts = { active: 0, resting: 0, subagents: 0, alerts: 0 };
    for (const ch of this.characters.values()) {
      if (ch.matrixEffect === 'despawn' || this.wpLeaving.has(ch.id)) continue;
      if (ch.bubbleType === 'permission' || (!ch.isActive && ch.waitingAwaitingInput)) counts.alerts++;
      if (ch.isSubagent) counts.subagents++;
      else if (ch.isActive) counts.active++;
      else counts.resting++;
    }
    const minute = Math.floor(Date.now() / 60000);
    if (minute !== this.wpEveningMinute) {
      this.wpEveningMinute = minute;
      this.wpEvening = isEndOfDay(new Date());
    }
    const lang = getLang();
    if (lang !== this.wpLang) {
      this.wpLang = lang;
      this.wpBoardKey = ''; // board words change language
    }
    const stats = this.wpEvening ? this.wpStats : null;
    if (stats) {
      const key = `e|${String(stats.sessions)}|${String(stats.subtasks)}`;
      if (key !== this.wpBoardKey) {
        this.wpBoardKey = key;
        this.wpBoard = buildEndOfDaySprite(stats, lang);
      }
    } else if (this.wpBoardKey !== 'c' || !sameCounts(this.wpCounts, counts)) {
      this.wpBoardKey = 'c';
      this.wpCounts = counts;
      this.wpBoard = buildWhiteboardSprite(counts, lang);
    }

    const privacy = getWallpaperOptions().privacy;
    if (privacy !== this.wpPrivacy || lang !== this.wpSignLang) {
      this.wpPrivacy = privacy;
      this.wpSignLang = lang;
      this.rebuildFurnitureInstances(); // door signs: lead name <-> BUSY, FREE in the new language
    }

    if (minute !== this.wpClockMinute) {
      const base = getCatalogEntry('CLOCK')?.sprite;
      if (base) {
        const now = new Date();
        this.wpClockMinute = minute;
        this.wpClock = buildClockSprite(base, now.getHours(), now.getMinutes());
      }
    }
  }

  /** Swap the decor sprites into the freshly built furniture instances. */
  private wpDecorate(): void {
    const geo = this.wpGeometry();
    const at = (uid: string | null) => {
      const i = uid ? geo.index.get(uid) : undefined;
      return i === undefined ? undefined : this.furniture[i];
    };
    const board = at(geo.whiteboardUid);
    if (board && this.wpBoard) board.sprite = this.wpBoard;
    const clock = at(geo.clockUid);
    if (clock && this.wpClock) clock.sprite = this.wpClock;

    if (decorBlinkOn()) {
      for (const ch of this.characters.values()) {
        if (ch.bubbleType !== 'permission' || !ch.seatId || ch.matrixEffect) continue;
        const pc = at(this.seatWorkstations.get(ch.seatId) ?? null);
        if (pc) pc.sprite = redScreenSprite(pc.sprite);
      }
    }

    // Team rooms: a door sign each (lamp + lead name, or FREE) and a warm floor tint while booked.
    const signRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    this.wpSignRects = signRects;
    for (const room of geo.rooms) {
      if (!room.team) continue;
      const b = this.wpBookings.get(room.id);
      const lead = b ? this.characters.get(b.leadId) : undefined;
      if (room.sign) {
        const lang = getLang();
        const text = lead ? (getWallpaperOptions().privacy ? t('signBusy', lang) : this.wpDisplayName(lead)) : null;
        const key = `${room.id}|${lang}|${text ?? ''}`;
        let sprite = this.wpSigns.get(key);
        if (!sprite) {
          sprite = buildDoorSign(text, room.sign.maxX - room.sign.minX, lang);
          for (const k of this.wpSigns.keys()) if (k.startsWith(`${room.id}|`)) this.wpSigns.delete(k);
          this.wpSigns.set(key, sprite);
        }
        const { cx, minX, maxX } = room.sign;
        const w = sprite[0].length;
        const x = Math.max(minX, Math.min(maxX - w, Math.round(cx - w / 2)));
        signRects.push({ x, y: room.sign.y, w, h: sprite.length });
        this.furniture.push({
          sprite,
          x,
          y: room.sign.y,
          zY: (room.sign.row + 1) * TILE_SIZE + 0.1,
        });
      }
      if (b && room.rect) {
        let tint = this.wpTints.get(room.id);
        if (!tint) {
          const w = room.rect.w * TILE_SIZE;
          tint = Array.from({ length: room.rect.h * TILE_SIZE }, () => new Array<string>(w).fill(WP_ROOM_TINT));
          this.wpTints.set(room.id, tint);
        }
        this.furniture.push({
          sprite: tint,
          x: room.rect.col * TILE_SIZE,
          y: room.rect.row * TILE_SIZE,
          zY: -1,
        });
      }
    }

    if (this.wpMail) {
      const spot = this.wpMailSpot();
      if (spot) this.furniture.push({ sprite: ENVELOPE, x: spot.x, y: spot.y, zY: spot.zY });
    }
    if (this.wpDimUntil !== null) {
      const dim = this.wpDimLayer();
      this.furniture.push({ sprite: dim.sprite, x: dim.x, y: dim.y, zY: Number.MAX_SAFE_INTEGER });
    }

    if (this.litPcs.size > 0 && isNight()) {
      for (const uid of this.litPcs) {
        const pc = at(uid);
        if (!pc) continue;
        this.furniture.push({
          sprite: NIGHT_GLOW,
          // Centred on the desk front below the screen: the light falls on desk and chair.
          x: pc.x + 8 - GLOW_W / 2,
          y: pc.y + 22 - GLOW_H / 2,
          zY: pc.zY - 0.25,
        });
      }
    }
  }

  // ── Today's stats (CONTRACT v4 wallpaperStats) ──────────────────

  /** Latest `wallpaperStats`. Ignored unless day is a string and both counts are numbers >= 0. */
  setWallpaperStats(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (typeof r.day !== 'string' || !count(r.sessions) || !count(r.subtasks)) return;
    this.wpStats = { day: r.day, sessions: r.sessions as number, subtasks: r.subtasks as number };
  }

  getWallpaperStats(): DayStats | null {
    return this.wpStats;
  }

  // ── Reception ─────────────────────────────────────────────────

  private wpReceptionMeta(): Tile | null {
    const meta = (this.layout as OfficeLayout & WallpaperLayoutMeta).wallpaperReception;
    return meta && Number.isInteger(meta.col) && Number.isInteger(meta.row) ? meta : null;
  }

  /** The reception chair's seat uid, or null when the layout has none. Cached per seat map
   *  (it is read for every character on every frame). */
  private wpReceptionUid(): string | null {
    if (this.wpRecCache?.seats === this.seats && this.wpRecCache.layout === this.layout) {
      return this.wpRecCache.uid;
    }
    const meta = this.wpReceptionMeta();
    const uid = meta ? this.getSeatAtTile(meta.col, meta.row) : null;
    this.wpRecCache = { seats: this.seats, layout: this.layout, uid };
    return uid;
  }

  /** Whether `name` is the reception agent's (case-insensitive). Never true with no reception agent. */
  private wpIsReceptionName(name: string | undefined): boolean {
    const want = this.wpReceptionAgent;
    if (!want || !name || !this.wpReceptionMeta()) return false;
    return name.trim().toLowerCase() === want.toLowerCase();
  }

  /** The reception agent's display name (`wallpaperConfig.reception`), or null. */
  getReceptionAgentName(): string | null {
    return this.wpReceptionAgent;
  }

  /** `wallpaperConfig.reception`: a non-empty string names the reception agent, anything else
   *  leaves the desk empty. An occupant that is no longer the reception agent moves to a free seat;
   *  a newly named one already in the office walks over (wpCheckReception). */
  setReceptionAgent(raw: unknown): void {
    const next = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : null;
    if (next === this.wpReceptionAgent) return;
    this.wpReceptionAgent = next;
    const id = this.getReceptionAgentId();
    const ch = id !== null ? this.characters.get(id) : undefined;
    if (!ch || this.wpIsReceptionName(this.wpDisplayName(ch))) return;
    if (this.wpMail?.id === ch.id) this.wpClearMail();
    const seatId = this.findFreeSeat(ch.directoryName);
    if (seatId) this.reassignSeat(ch.id, seatId);
    else ch.seatId = null;
    this.wpReserveReception(); // reassignSeat released the chair: it stays reserved
  }

  /** The reception seat for a new agent called `name`: when it is the reception agent and
   *  no one holds the seat yet. */
  private wpReceptionSeatFor(name: string | undefined): string | null {
    if (!this.wpIsReceptionName(name)) return null;
    const uid = this.wpReceptionUid();
    if (!uid) return null;
    for (const ch of this.characters.values()) if (ch.seatId === uid) return null;
    return uid;
  }

  /** The reception chair counts as taken, so no one else is ever seated there. */
  private wpReserveReception(): void {
    const uid = this.wpReceptionUid();
    const seat = uid ? this.seats.get(uid) : undefined;
    if (seat) seat.assigned = true;
  }

  private wpAtReception(ch: Character): boolean {
    return !ch.isSubagent && ch.seatId !== null && ch.seatId === this.wpReceptionUid();
  }

  /** The agent sitting at reception (by seat), or null. */
  getReceptionAgentId(): number | null {
    const uid = this.wpReceptionUid();
    if (!uid) return null;
    for (const ch of this.characters.values()) if (ch.seatId === uid && !ch.isSubagent) return ch.id;
    return null;
  }

  /** A reception agent seated elsewhere (named later, or the seat was taken) moves to reception. */
  private wpCheckReception(): void {
    const uid = this.wpReceptionUid();
    if (!uid || this.getReceptionAgentId() !== null) return;
    for (const ch of this.characters.values()) {
      if (ch.isSubagent || ch.matrixEffect === 'despawn' || !this.wpIsReceptionName(this.wpDisplayName(ch))) continue;
      if (ch.seatId) {
        const old = this.seats.get(ch.seatId);
        if (old) old.assigned = false;
      }
      ch.seatId = uid;
      this.wpLounge.delete(ch.id);
      if (ch.moveProgress === 0) ch.path = [];
      ch.wanderTimer = 0;
      return;
    }
  }

  /** One frame of the reception agent: walk to the chair and sit there, working or not. */
  private wpUpdateReception(ch: Character, dt: number): void {
    const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
    if (!seat) return;
    const key = `${seat.seatCol},${seat.seatRow}`;
    const had = this.blockedTiles.delete(key);
    updateWorker(ch, dt, { col: seat.seatCol, row: seat.seatRow, dir: seat.facingDir, sit: true }, this.tileMap, this.blockedTiles);
    if (had) this.blockedTiles.add(key);
  }

  /** `wallpaperMail`: an envelope at reception when the reception agent gets a message. */
  receiveMail(id: number): void {
    if (!this.wpMode || !Number.isInteger(id)) return;
    const ch = this.characters.get(id);
    if (!ch || ch.isSubagent || !this.wpIsReceptionName(this.wpDisplayName(ch)) || !this.wpReceptionUid()) return;
    this.wpMail = { id, until: this.wpTime + MAIL_SEC };
    this.rebuildFurnitureInstances();
  }

  /** The agent whose envelope shows, or null. */
  getMailAgentId(): number | null {
    return this.wpMail?.id ?? null;
  }

  private wpClearMail(): void {
    if (!this.wpMail) return;
    this.wpMail = null;
    this.rebuildFurnitureInstances();
  }

  private wpTickMail(): void {
    if (this.wpMail && this.wpTime >= this.wpMail.until) this.wpClearMail();
  }

  /** Where the envelope goes: on the reception desk (the desk under or in front of the chair),
   *  right-hand side; else floating beside the chair. */
  private wpMailSpot(): { x: number; y: number; zY: number } | null {
    const uid = this.wpReceptionUid();
    const seat = uid ? this.seats.get(uid) : undefined;
    if (!seat) return null;
    const step = DIR_STEPS.find((d) => d.dir === seat.facingDir)!;
    const tiles = [
      { col: seat.seatCol, row: seat.seatRow },
      { col: seat.seatCol + step.dc, row: seat.seatRow + step.dr },
    ];
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry?.isDesk) continue;
      const inside = tiles.some(
        (t) =>
          t.col >= item.col &&
          t.col < item.col + entry.footprintW &&
          t.row >= item.row &&
          t.row < item.row + entry.footprintH,
      );
      if (!inside) continue;
      // Lying on the desk top: its first opaque sprite row, right-hand side.
      const surface = Math.max(0, entry.sprite.findIndex((row) => row.some((p) => p !== '')));
      const right = (item.col + entry.footprintW) * TILE_SIZE;
      const top = item.row * TILE_SIZE + surface + 2;
      return { x: right - ENVELOPE_W - 3, y: top, zY: (item.row + entry.footprintH) * TILE_SIZE + 0.5 };
    }
    return {
      x: seat.seatCol * TILE_SIZE + TILE_SIZE - 2,
      y: seat.seatRow * TILE_SIZE - ENVELOPE_H - 6,
      zY: (seat.seatRow + 1) * TILE_SIZE + 0.5,
    };
  }

  // ── "all done" ──────────────────────────────────────────────

  /** A snapshot replay starts (existingAgents): idling while it settles is not "done". */
  noteReplay(): void {
    this.wpReplayUntil = this.wpNow() + REPLAY_HOLD_MS;
  }

  /** Someone is working: an agent active or waiting on a permission, or a sub-agent still in. */
  private wpIsBusy(): boolean {
    for (const ch of this.characters.values()) {
      if (ch.matrixEffect === 'despawn') continue;
      if (ch.isSubagent) {
        if (!this.wpLeaving.has(ch.id)) return true;
      } else if (ch.isActive || ch.bubbleType === 'permission') {
        return true;
      }
    }
    return false;
  }

  /**
   * Work period bookkeeping, on every status change and frame. A period runs while someone
   * works; when it ends after ALL_DONE_WORK_MS, "all done" is due (once: the next period
   * starts afresh). An end inside a replay, or whose last work was seen before the replay
   * settled, closes the period without it.
   */
  private wpTrackWork(): void {
    const now = this.wpNow();
    if (this.wpIsBusy()) {
      if (this.wpWorkStart === null) this.wpWorkStart = now;
      this.wpLastBusyAt = now;
      return;
    }
    if (this.wpWorkStart === null || now < this.wpReplayUntil) return;
    const start = this.wpWorkStart;
    this.wpWorkStart = null;
    if (this.wpLastBusyAt < this.wpReplayUntil) return;
    if (now - start >= ALL_DONE_WORK_MS) this.wpAllDonePending = now;
  }

  private wpTickAllDone(): void {
    this.wpTrackWork();
    if (this.wpAllDonePending !== null) {
      const recent = this.wpNow() - this.wpAllDonePending <= ALL_DONE_STALE_MS;
      this.wpAllDonePending = null;
      if (recent) this.wpStartAllDone();
    }
    if (this.wpDimUntil !== null && this.wpNow() >= this.wpDimUntil) {
      this.wpDimUntil = null;
      this.rebuildFurnitureInstances();
    }
  }

  /** Whether the "all done" dim is on. */
  isAllDoneDimmed(): boolean {
    return this.wpDimUntil !== null;
  }

  /** Every idle agent stands up and stretches, then heads for the lounge; the light dims. */
  private wpStartAllDone(): void {
    for (const ch of this.characters.values()) {
      if (ch.isSubagent || ch.matrixEffect || ch.isActive || ch.bubbleType === 'permission') continue;
      if (this.wpLeadRoom.has(ch.id)) continue;
      this.wpLounge.delete(ch.id);
      ch.path = ch.moveProgress > 0 && ch.path.length > 0 ? [ch.path[0]] : [];
      this.wpStretch.set(ch.id, { timer: 0 });
    }
    this.wpDimUntil = this.wpNow() + ALL_DONE_DIM_SEC * 1000;
    this.rebuildFurnitureInstances();
  }

  /** Agents stretching right now (tests and overlays). */
  isStretching(id: number): boolean {
    return this.wpStretch.has(id);
  }

  /** One frame of the stretch: finish the step under way, stand, turn round with a hop,
   *  then walk to a lounge spot (the reception agent sits back down instead). */
  private wpUpdateStretch(ch: Character, dt: number): void {
    const st = this.wpStretch.get(ch.id)!;
    const center = { x: ch.tileCol * TILE_SIZE + TILE_SIZE / 2, y: ch.tileRow * TILE_SIZE + TILE_SIZE / 2 };
    const done = () => {
      ch.y = center.y;
      this.wpStretch.delete(ch.id);
    };
    if (ch.isActive || ch.bubbleType === 'permission') {
      done(); // work came back: the usual FSM takes it to its desk
      return;
    }
    if (walkPath(ch, dt)) return;
    st.timer += dt;
    const step = Math.floor(st.timer / STRETCH_STEP_SEC);
    if (step < STRETCH_DIRS.length) {
      ch.dir = STRETCH_DIRS[step];
      ch.y = center.y - (step === 2 ? STRETCH_HOP_PX : 0);
      return;
    }
    done();
    ch.frame = 0;
    ch.frameTimer = 0;
    if (this.wpAtReception(ch)) return;
    const spot = this.wpPickLoungeSpot(ch);
    if (!spot) return;
    const key = `${spot.col},${spot.row}`;
    const had = spot.seatUid ? this.blockedTiles.delete(key) : false;
    const ok = this.withOwnSeatUnblocked(ch, () => this.wpWalkTo(ch, spot));
    if (had) this.blockedTiles.add(key);
    if (!ok) return;
    ch.wanderTimer = randomBetween(2, 5);
    this.wpLounge.set(ch.id, { ...spot, arrived: false });
  }

  /** One flat translucent layer over the office (walls' overhang included). */
  private wpDimLayer(): { sprite: SpriteData; x: number; y: number } {
    if (this.wpDim) return this.wpDim;
    const { cols, rows, tiles } = this.layout;
    let minR = rows;
    let maxR = -1;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === TileType.VOID) continue;
      const r = Math.floor(i / cols);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
    if (maxR < 0) {
      minR = 0;
      maxR = rows - 1;
    }
    minR = Math.max(0, minR - 1);
    const w = cols * TILE_SIZE;
    const h = (maxR - minR + 1) * TILE_SIZE;
    const sprite = Array.from({ length: h }, () => new Array<string>(w).fill(WP_ALL_DONE_DIM));
    this.wpDim = { sprite, x: 0, y: minR * TILE_SIZE };
    return this.wpDim;
  }

  /** The `saveAgentSeats` payload: palette, hue and seat for every agent worth
   *  restoring. Sub-agents are excluded because they are derived state the
   *  runtime re-materializes, and the greeter never reaches here at all —
   *  it is not in `characters`. */
  getPersistableSeats(): Record<
    number,
    { palette: number; repeat: number; seatId: string | null }
  > {
    const seats: Record<number, { palette: number; repeat: number; seatId: string | null }> = {};
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      seats[ch.id] = { palette: ch.palette, repeat: ch.repeat, seatId: ch.seatId };
    }
    return seats;
  }

  /** Everything the renderer draws: the agents plus, while the first-run ask
   *  is up, the consent greeter. This is the ONE place the greeter joins the
   *  agents — every other consumer reads `characters` and gets agents only. */
  getCharacters(): Character[] {
    const chars = Array.from(this.characters.values());
    if (this.greeter) chars.push(this.greeter);
    return chars;
  }

  /** Get character at pixel position (for hit testing). Returns id or null.
   *  Agents only: clicks pass straight through the consent greeter, which is
   *  a prop, not something to select or follow. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = Array.from(this.characters.values()).sort((a, b) => b.y - a.y);
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue;
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - CHARACTER_HIT_HEIGHT;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }
}
