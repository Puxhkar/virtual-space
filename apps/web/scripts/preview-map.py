#!/usr/bin/env python3
"""Renders a compiled map to a PNG.

A map that validates is not necessarily a map anyone wants to work in. The
compiler proves every room is reachable; only looking at it shows whether the
desks line up, the rugs sit under the sofas, and the place reads as an office.
"""
import json, sys
from PIL import Image, ImageDraw

map_path = sys.argv[1]
out = sys.argv[2]
scale = int(sys.argv[3]) if len(sys.argv) > 3 else 1
doc = json.load(open(map_path))
TILE = doc["tilewidth"]
W, H = doc["width"], doc["height"]

sheets, ranges = {}, []
for ts in doc["tilesets"]:
    path = "public/" + ts["image"].replace("../", "")
    sheets[ts["name"]] = Image.open(path).convert("RGBA")
    ranges.append((ts["firstgid"], ts["firstgid"] + ts["tilecount"], ts["name"], ts["columns"]))
ranges.sort(reverse=True)

canvas = Image.new("RGBA", (W * TILE, H * TILE), (20, 24, 26, 255))
for layer in doc["layers"]:
    if layer["type"] != "tilelayer":
        continue
    for i, gid in enumerate(layer["data"]):
        if gid <= 0:
            continue
        for first, last, name, cols in ranges:
            if first <= gid < last:
                idx = gid - first
                sx, sy = (idx % cols) * TILE, (idx // cols) * TILE
                canvas.alpha_composite(
                    sheets[name].crop((sx, sy, sx + TILE, sy + TILE)),
                    ((i % W) * TILE, (i // W) * TILE),
                )
                break

d = ImageDraw.Draw(canvas)
for obj in next(l for l in doc["layers"] if l["type"] == "objectgroup")["objects"]:
    if obj["type"] == "zone":
        d.rectangle(
            [obj["x"], obj["y"], obj["x"] + obj["width"] - 1, obj["y"] + obj["height"] - 1],
            outline=(94, 195, 201, 220), width=2,
        )
        d.text((obj["x"] + 4, obj["y"] + 4), obj["name"], fill=(200, 245, 250))
    else:
        d.rectangle([obj["x"] + 2, obj["y"] + 2, obj["x"] + TILE - 3, obj["y"] + TILE - 3],
                    outline=(74, 222, 128), width=2)
        d.text((obj["x"] + 4, obj["y"] + TILE - 12), "in", fill=(74, 222, 128))

if scale != 1:
    canvas = canvas.resize((canvas.width * scale, canvas.height * scale), Image.NEAREST)
canvas.convert("RGB").save(out)
print(f"{out}: {W}x{H} tiles")
