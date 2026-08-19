#!/usr/bin/env python3
"""Renders a sheet's objects packed and numbered, in object-index order.

The companion to generate-objects.mjs. Detection finds the footprints and
sorts them largest-first; this draws them in that same order with their index
labelled, so a layout description can reference `sheet#index` and mean exactly
the thing that was looked at.

Reading indices off the sheet's own layout does not work — the index order is
by size, not position.

  catalogue-sheet.py <tiles-dir> <objects.json> <sheet-key> <out.png> [scale] [lo] [hi]
"""
import json
import sys
from PIL import Image, ImageDraw

TILE = 32
tiles_dir, index_path, key, out = sys.argv[1:5]
scale = int(sys.argv[5]) if len(sys.argv) > 5 else 2
lo = int(sys.argv[6]) if len(sys.argv) > 6 else 0
hi = int(sys.argv[7]) if len(sys.argv) > 7 else 10**9

index = json.load(open(index_path))
objects = [(i, o) for i, o in enumerate(index[key]) if lo <= i < hi]
if not objects:
    sys.exit(f"no objects in range for {key}")

sheet = Image.open(f"{tiles_dir}/{key}.png").convert("RGBA")

WIDTH = 1500
GUTTER = 14
LABEL = 13

# Shelf packing, same as the editor palette: fill a row, wrap when full.
placed = []
cx, cy, row_h = GUTTER, GUTTER, 0
for i, o in objects:
    w, h = o["w"] * TILE * scale, o["h"] * TILE * scale + LABEL
    if cx + w > WIDTH - GUTTER and cx > GUTTER:
        cx, cy = GUTTER, cy + row_h + GUTTER
        row_h = 0
    placed.append((i, o, cx, cy, w, h))
    cx += w + GUTTER
    row_h = max(row_h, h)

canvas = Image.new("RGB", (WIDTH, cy + row_h + GUTTER), (245, 245, 245))
d = ImageDraw.Draw(canvas)

for i, o, x, y, w, h in placed:
    crop = sheet.crop(
        (o["x"] * TILE, o["y"] * TILE, (o["x"] + o["w"]) * TILE, (o["y"] + o["h"]) * TILE)
    )
    bg = Image.new("RGBA", crop.size, (255, 255, 255, 255))
    bg.alpha_composite(crop)
    canvas.paste(
        bg.convert("RGB").resize((o["w"] * TILE * scale, o["h"] * TILE * scale), Image.NEAREST),
        (x, y + LABEL),
    )
    d.rectangle([x, y + LABEL, x + o["w"] * TILE * scale - 1, y + h - 1], outline=(200, 200, 205))
    d.text((x + 1, y + 1), f"{i} ({o['w']}x{o['h']})", fill=(160, 20, 70))

canvas.save(out)
print(f"{out}: {key} #{objects[0][0]}..#{objects[-1][0]} of {len(index[key])}")
