#!/usr/bin/env python3
"""Renders a tileset region with a coordinate grid, so tiles can be named by eye.

Identifying furniture is a visual job: the pack ships raw sheets with no
metadata, so the only way to learn that a given 2x3 block is a wardrobe is to
look at it. This draws the tile grid and column/row numbers over a scaled crop
so a human (or a model) reading the image can write down exact coordinates.
"""
import sys
from PIL import Image, ImageDraw

path, x0, y0, w, h = sys.argv[1], *map(int, sys.argv[2:6])
scale = int(sys.argv[6]) if len(sys.argv) > 6 else 3
out = sys.argv[7] if len(sys.argv) > 7 else "contact.png"
TILE = 32

im = Image.open(path).convert("RGBA")
cols, rows = im.size[0] // TILE, im.size[1] // TILE
w, h = min(w, cols - x0), min(h, rows - y0)

crop = im.crop((x0 * TILE, y0 * TILE, (x0 + w) * TILE, (y0 + h) * TILE))
# Light ground: transparent pixels are the majority and must read as empty.
bg = Image.new("RGBA", crop.size, (232, 232, 232, 255))
bg.alpha_composite(crop)

PAD = 22  # room for the axis labels
canvas = Image.new("RGB", (w * TILE * scale + PAD, h * TILE * scale + PAD), (255, 255, 255))
canvas.paste(bg.convert("RGB").resize((w * TILE * scale, h * TILE * scale), Image.NEAREST), (PAD, PAD))

d = ImageDraw.Draw(canvas)
step = TILE * scale
for i in range(w + 1):
    d.line([(PAD + i * step, PAD), (PAD + i * step, PAD + h * step)], fill=(150, 160, 200), width=1)
    if i < w:
        d.text((PAD + i * step + 3, 6), str(x0 + i), fill=(20, 20, 20))
for j in range(h + 1):
    d.line([(PAD, PAD + j * step), (PAD + w * step, PAD + j * step)], fill=(150, 160, 200), width=1)
    if j < h:
        d.text((2, PAD + j * step + 3), str(y0 + j), fill=(20, 20, 20))

canvas.save(out)
print(f"{out}: {path.split('/')[-1]} cols {x0}..{x0+w-1}, rows {y0}..{y0+h-1} (sheet is {cols}x{rows})")
