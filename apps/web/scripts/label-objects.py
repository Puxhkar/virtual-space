#!/usr/bin/env python3
"""Draws detected object boxes with index numbers over a sheet.

The companion to detect-objects.py: detection finds the footprints, this makes
them readable so each one can be given a name.
"""
import json, sys
from PIL import Image, ImageDraw

TILE = 32
sheet, raw, key, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
scale = int(sys.argv[5]) if len(sys.argv) > 5 else 3
lo = int(sys.argv[6]) if len(sys.argv) > 6 else 0
hi = int(sys.argv[7]) if len(sys.argv) > 7 else 10**9

objs = [o for o in json.load(open(raw))[key]]
sel = [(i, o) for i, o in enumerate(objs) if lo <= i < hi]
im = Image.open(sheet).convert("RGBA")

y0 = min(o["y"] for _, o in sel)
y1 = max(o["y"] + o["h"] for _, o in sel)
x1 = im.size[0] // TILE

crop = im.crop((0, y0 * TILE, x1 * TILE, y1 * TILE))
bg = Image.new("RGBA", crop.size, (240, 240, 240, 255))
bg.alpha_composite(crop)
canvas = bg.convert("RGB").resize((crop.size[0] * scale, crop.size[1] * scale), Image.NEAREST)
d = ImageDraw.Draw(canvas)

for i, o in sel:
    bx = o["x"] * TILE * scale
    by = (o["y"] - y0) * TILE * scale
    bw, bh = o["w"] * TILE * scale, o["h"] * TILE * scale
    d.rectangle([bx, by, bx + bw - 1, by + bh - 1], outline=(220, 30, 90), width=2)
    label = f"{i}"
    d.rectangle([bx, by, bx + 9 * len(label) + 6, by + 15], fill=(220, 30, 90))
    d.text((bx + 3, by + 2), label, fill=(255, 255, 255))

canvas.save(out)
print(f"{out}: {key} objects {sel[0][0]}..{sel[-1][0]}, sheet rows {y0}..{y1}")
