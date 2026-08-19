#!/usr/bin/env python3
"""Renders objects matching a size range, across several sheets at once.

Hunting for "a big table" means looking at every sheet that might hold one.
Labels carry the sheet name so what comes out is a `sheet#index` reference the
layout compiler accepts directly.

  find-objects.py <tiles-dir> <objects.json> <out.png> <minW> <minH> <maxW> <maxH> [sheets...]
"""
import json, sys
from PIL import Image, ImageDraw

TILE = 32
tiles_dir, index_path, out = sys.argv[1:4]
minw, minh, maxw, maxh = map(int, sys.argv[4:8])
only = sys.argv[8:]

index = json.load(open(index_path))
picks = []
for key, objects in index.items():
    if only and key not in only:
        continue
    for i, o in enumerate(objects):
        if minw <= o["w"] <= maxw and minh <= o["h"] <= maxh:
            picks.append((key, i, o))

if not picks:
    sys.exit("nothing matched")

sheets = {k: Image.open(f"{tiles_dir}/{k}.png").convert("RGBA") for k, _, _ in picks}
SCALE, WIDTH, GUTTER, LABEL = 2, 1500, 14, 13

placed, cx, cy, row_h = [], GUTTER, GUTTER, 0
for key, i, o in picks:
    w, h = o["w"] * TILE * SCALE, o["h"] * TILE * SCALE + LABEL
    if cx + w > WIDTH - GUTTER and cx > GUTTER:
        cx, cy, row_h = GUTTER, cy + row_h + GUTTER, 0
    placed.append((key, i, o, cx, cy, w, h))
    cx += w + GUTTER
    row_h = max(row_h, h)

canvas = Image.new("RGB", (WIDTH, cy + row_h + GUTTER), (245, 245, 245))
d = ImageDraw.Draw(canvas)
for key, i, o, x, y, w, h in placed:
    crop = sheets[key].crop(
        (o["x"] * TILE, o["y"] * TILE, (o["x"] + o["w"]) * TILE, (o["y"] + o["h"]) * TILE)
    )
    bg = Image.new("RGBA", crop.size, (255, 255, 255, 255))
    bg.alpha_composite(crop)
    canvas.paste(
        bg.convert("RGB").resize((o["w"] * TILE * SCALE, o["h"] * TILE * SCALE), Image.NEAREST),
        (x, y + LABEL),
    )
    d.rectangle([x, y + LABEL, x + o["w"] * TILE * SCALE - 1, y + h - 1], outline=(200, 200, 205))
    d.text((x + 1, y + 1), f"{key}#{i} ({o['w']}x{o['h']})", fill=(160, 20, 70))

canvas.save(out)
print(f"{out}: {len(picks)} objects")
