#!/usr/bin/env python3
"""
Lists the tiles in an atlas that are safe to use as a room fill.

Most tiles in a tileset are edge or corner pieces of a 3x3 border set.
Painting one of those across a floor produces a grid of stripes rather than a
surface -- which is the bug this script exists to prevent. Only 37 of the
Kenney urban atlas's 486 tiles are true fills.

A tile qualifies when it is fully opaque and its left edge matches its right
and its top matches its bottom, so tiling it leaves no seam.

    python3 scripts/find-fill-tiles.py
"""
import sys
from pathlib import Path
from PIL import Image

# Defaults to the pack in use; pass a path and tile size to inspect another.
#   python3 scripts/find-fill-tiles.py <atlas.png> [tileSize]
DEFAULT = Path(__file__).parent.parent / "public/assets/limezu/tiles.png"
ATLAS = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
TS = int(sys.argv[2]) if len(sys.argv) > 2 else 32

img = Image.open(ATLAS).convert("RGBA")
px = img.load()
COLS, ROWS = img.width // TS, img.height // TS
print(f"{ATLAS.name}: {img.width}x{img.height} = {COLS}x{ROWS} tiles of {TS}px\n")


def origin(t):
    return (t % COLS) * TS, (t // COLS) * TS


def is_fill(t):
    ox, oy = origin(t)
    for y in range(TS):
        for x in range(TS):
            if px[ox + x, oy + y][3] != 255:
                return False
    for i in range(TS):
        if px[ox, oy + i] != px[ox + TS - 1, oy + i]:
            return False
        if px[ox + i, oy] != px[ox + i, oy + TS - 1]:
            return False
    return True


def structure(t):
    """How much internal detail a tile has.

    Seamless is not the same as "reads as a floor" -- a window pane tiles
    cleanly too, and painting one across a room renders a wall of glass. A
    floor is visually near-uniform, so count distinct colours and measure the
    spread; anything busy is decoration, whatever region it sits in.
    """
    ox, oy = origin(t)
    colours = set()
    lo, hi = 255, 0
    for y in range(TS):
        for x in range(TS):
            r, g, b, _ = px[ox + x, oy + y]
            colours.add((r, g, b))
            lum = (r + g + b) // 3
            lo, hi = min(lo, lum), max(hi, lum)
    return len(colours), hi - lo


def average(t):
    ox, oy = origin(t)
    n = TS * TS
    r = g = b = 0
    for y in range(TS):
        for x in range(TS):
            p = px[ox + x, oy + y]
            r, g, b = r + p[0], g + p[1], b + p[2]
    return r // n, g // n, b // n


# Thresholds picked by inspecting the tiles either side of them: a plain
# floor has a handful of shades and gentle contrast; a window has dozens of
# colours and a hard bright-to-dark edge. Detailed art needs a looser bound
# than a minimal pack, so this scales with tile size.
MAX_COLOURS = 8 if TS <= 16 else 18
MAX_CONTRAST = 60 if TS <= 16 else 90

fills = [t for t in range(COLS * ROWS) if is_fill(t)]
plain, busy = [], []
for t in fills:
    n_colours, contrast = structure(t)
    (plain if n_colours <= MAX_COLOURS and contrast <= MAX_CONTRAST else busy).append(
        (t, n_colours, contrast)
    )

print(f"{len(fills)} of {COLS * ROWS} tiles tile seamlessly.\n")
print(f"SAFE AS A FLOOR OR WALL ({len(plain)}) -- seamless and near-uniform:\n")
for t, n, c in plain:
    print(f"  {t:4d}  rgb{average(t)}  {n} colours, contrast {c}")

print(f"\nSEAMLESS BUT BUSY ({len(busy)}) -- windows, grates, patterned panels.")
print("They repeat without a seam but read as objects, not as a surface.")
