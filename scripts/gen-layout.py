#!/usr/bin/env python3
"""Generate the wallpaper office layout (default-layout-2.json).

33 x 16 tiles. Row 0 is void headroom for wall art. The page fits the office inside the screen's
safe area (menu bar and Dock excluded): on a 1600x900 pt screen that is about 1600x784 pt, and
16*16*3 = 768, so integer zoom 3 fits.

Plan (cols left to right):
  1..13   open plan: 9 desk stations (3 x 3), coffee station at the bottom, reception desk
          (chair 2,14 facing down, on the back row of a small desk at 2..3,14..15) beside the
          entrance (1,15).
  14      partition wall, doorway rows 4..6 into the lounge.
  15..31  rows 2..7: lounge (sofa set + 4-seat meeting table).
          row 8: wall with one door per team room.
          rows 9..15: ROOM 1 (cols 15..22) and ROOM 2 (cols 24..31), 6-seat table each.
Rooms are marked with area labels "ROOM 1" / "ROOM 2" (areaTiles): the engine finds rooms by
label and books them for a lead while it has sub-agents.

Look: modern/futuristic. Dark steel walls, smooth seamless floors (no tile grid: checker and grid
floors look busy behind desktop icons), one dark tint per zone, white desks, cyan sofas. Colours use the engine's Photoshop-style colorize (h, s, b, c).
"""
import json
import os
import sys

ASSETS = os.path.join(os.path.dirname(__file__), '..', 'web', 'pixel-agents', 'webview-ui', 'public', 'assets')
COLS, ROWS = 33, 16

# Tile type n uses floors/floor_{n-1}.png. 0 = wall, 255 = void.
VOID, WALL = 255, 0
PLAIN = 1

C_WALL = {'h': 222, 's': 32, 'b': -100, 'c': -40}
C_OPEN = {'h': 205, 's': 35, 'b': -84, 'c': 0}     # smooth dark navy
C_LOUNGE = {'h': 190, 's': 30, 'b': -80, 'c': 0}    # smooth dark teal
C_ROOM1 = {'h': 265, 's': 30, 'b': -82, 'c': 0}     # smooth dark violet
C_ROOM2 = {'h': 160, 's': 30, 'b': -82, 'c': 0}     # smooth dark emerald
F_DESK = {'h': 210, 's': 6, 'b': 30, 'c': 10, 'colorize': True}
F_TABLE = {'h': 210, 's': 8, 'b': 22, 'c': 10, 'colorize': True}
F_SEAT = {'h': 192, 's': 30, 'b': -30, 'c': 10, 'colorize': True}
F_SOFA = {'h': 190, 's': 55, 'b': -12, 'c': 5, 'colorize': True}

ROOMS = (  # label, first col, last col, door cols in the row-8 wall
    ('ROOM 1', 15, 22, (21, 22)),
    ('ROOM 2', 24, 31, (30, 31)),
)

tiles = [[VOID] * COLS for _ in range(ROWS)]
colours = [[None] * COLS for _ in range(ROWS)]
areas = [[None] * COLS for _ in range(ROWS)]

def set_tile(r, c, t, colour):
    tiles[r][c] = t
    colours[r][c] = colour

for r in range(1, ROWS):
    for c in range(COLS):
        if r == 1 or c in (0, 14, COLS - 1):
            set_tile(r, c, WALL, C_WALL)
        elif c < 14:
            set_tile(r, c, PLAIN, C_OPEN)
        elif r < 8:
            set_tile(r, c, PLAIN, C_LOUNGE)
        elif r == 8 or c == 23:
            set_tile(r, c, WALL, C_WALL)
        else:
            set_tile(r, c, PLAIN, C_ROOM1 if c < 23 else C_ROOM2)
for r in (4, 5, 6):  # doorway open plan -> lounge
    set_tile(r, 14, PLAIN, C_LOUNGE)
for label, c0, c1, door in ROOMS:
    for c in door:
        set_tile(8, c, PLAIN, C_LOUNGE)
    for r in range(9, ROWS):
        for c in range(c0, c1 + 1):
            areas[r][c] = label

furniture = []
def put(kind, row, col, color=None):
    item = {'uid': f'wp-{len(furniture) + 1:03d}', 'type': kind, 'col': col, 'row': row}
    if color:
        item['color'] = color
    furniture.append(item)

# Open plan: desk 3x2, PC on the desk, bench two rows below facing the desk.
for row in (3, 7, 11):
    for col in (2, 6, 10):
        put('DESK_FRONT', row, col, F_DESK)
        put('PC_FRONT_OFF', row, col + 1)
        put('CUSHIONED_BENCH', row + 2, col + 1, F_SEAT)

# Lounge meeting table: 3x4 table, PCs on its sides, 4 side chairs.
def table(row, col):
    put('TABLE_FRONT', row, col, F_TABLE)
    for dr in (0, 2):
        put('PC_SIDE', row + dr, col)
        put('PC_SIDE:left', row + dr, col + 2)
        put('WOODEN_CHAIR_SIDE', row + dr, col - 1, F_SEAT)
        put('WOODEN_CHAIR_SIDE:left', row + dr, col + 3, F_SEAT)
table(3, 26)

# Team-room table: 4 side chairs plus one at each end (6 seats). Wooden chairs are 1x2 with the
# seat on the lower tile: the top chair's seat is the table's background row (facing down), the
# bottom chair's seat is the row below the table (facing up).
def room_table(row, col):
    put('TABLE_FRONT', row, col, F_TABLE)
    for dr in (0, 2):
        put('WOODEN_CHAIR_SIDE', row + dr, col - 1, F_SEAT)
        put('WOODEN_CHAIR_SIDE:left', row + dr, col + 3, F_SEAT)
    put('WOODEN_CHAIR_FRONT', row - 1, col + 1, F_SEAT)
    put('WOODEN_CHAIR_BACK', row + 3, col + 1, F_SEAT)
room_table(10, 17)
room_table(10, 26)
put('PLANT', 14, 15)
put('PLANT_2', 14, 24)

# Lounge sofa set.
put('SOFA_FRONT', 3, 19, F_SOFA)
put('SOFA_SIDE', 4, 18, F_SOFA)
put('COFFEE_TABLE', 4, 19, F_TABLE)
put('SOFA_SIDE:left', 4, 21, F_SOFA)
put('COFFEE', 5, 19)
put('SOFA_BACK', 6, 19, F_SOFA)
put('PLANT_2', 1, 15)
put('PLANT', 1, 31)

# Open-plan extras: coffee station, bin, plant.
put('SMALL_TABLE_FRONT', 14, 6, F_TABLE)
put('COFFEE', 15, 6)
put('BIN', 15, 12)
put('PLANT_2', 14, 13)

# Reception desk, beside the entrance: a chair facing down on the small desk's back row
# (as the team-room head chairs sit on their table's back row). Col 1 stays clear from the
# entrance up.
# Who sits there comes from config.json (reception.agent) via the server, never from the layout.
RECEPTION = {'col': 2, 'row': 14}
put('CUSHIONED_CHAIR_FRONT', RECEPTION['row'], RECEPTION['col'], F_SEAT)
put('SMALL_TABLE_FRONT', RECEPTION['row'], RECEPTION['col'], F_DESK)

# Wall art on the top wall (row 0 sits on wall row 1).
put('HANGING_PLANT', 0, 1)
put('WHITEBOARD', 0, 5)
put('CLOCK', 0, 9)
put('HANGING_PLANT', 0, 12)
put('SMALL_PAINTING', 0, 17)
put('LARGE_PAINTING', 0, 22)
put('SMALL_PAINTING_2', 0, 29)

flat = [t for row in tiles for t in row]
layout = {
    'version': 1,
    'cols': COLS,
    'rows': ROWS,
    'layoutRevision': 3,
    'tiles': flat,
    'tileColors': [c for row in colours for c in row],
    'furniture': furniture,
    'areas': [{'label': 'ROOM 1', 'color': '#9f7fdf'}, {'label': 'ROOM 2', 'color': '#5fbf9f'}],
    'areaTiles': [a for row in areas for a in row],
    # quiet-office: where sub-agents walk in and out (open plan, bottom-left).
    'wallpaperEntrance': {'col': 1, 'row': 15},
    # quiet-office: the reception seat (chair tile); the configured reception agent sits there.
    'wallpaperReception': RECEPTION,
}
out = os.path.join(ASSETS, 'default-layout-2.json')
json.dump(layout, open(out, 'w'))
seats = sum(f['type'].startswith(('CUSHIONED_BENCH', 'WOODEN_CHAIR', 'CUSHIONED_CHAIR')) for f in furniture)
print(f'wrote {out}: {COLS}x{ROWS}, {len(furniture)} furniture, {seats} seats', file=sys.stderr)
