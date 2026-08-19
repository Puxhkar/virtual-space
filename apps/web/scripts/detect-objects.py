#!/usr/bin/env python3
"""Finds the furniture in a tile sheet by connected transparency.

LimeZu packs objects as islands of opaque pixels separated by transparent
gutters, so a connected-component pass over the alpha channel recovers each
object's true footprint. That matters because measuring by eye is how a plant
ended up sealing a doorway three times: a sofa that looks three tiles wide is
2.6 tiles of pixels, and only the snapped box tells you it needs three.

Emits JSON: one entry per object with its tile rect, so naming is the only
human step left.
"""
import json
import sys
from collections import deque
from PIL import Image

TILE = 32
ALPHA = 24  # below this a pixel is background, not faint shadow


def detect(path, min_tiles=1, max_tiles=64):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    alpha = im.getchannel("A").load()
    seen = bytearray(w * h)
    objects = []

    for sy in range(h):
        for sx in range(w):
            if seen[sy * w + sx] or alpha[sx, sy] < ALPHA:
                continue
            # Flood fill this island, tracking its extent.
            x0 = x1 = sx
            y0 = y1 = sy
            q = deque([(sx, sy)])
            seen[sy * w + sx] = 1
            pixels = 0
            while q:
                x, y = q.popleft()
                pixels += 1
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
                for nx, ny in ((x+1,y), (x-1,y), (x,y+1), (x,y-1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny*w+nx] and alpha[nx,ny] >= ALPHA:
                        seen[ny*w+nx] = 1
                        q.append((nx, ny))

            # Snap outwards to whole tiles — an object occupies every tile it
            # touches, even by one pixel, or painting it would clip the edge.
            tx0, ty0 = x0 // TILE, y0 // TILE
            tx1, ty1 = x1 // TILE, y1 // TILE
            tw, th = tx1 - tx0 + 1, ty1 - ty0 + 1
            if tw * th < min_tiles or tw * th > max_tiles or pixels < 40:
                continue
            objects.append({
                "x": tx0, "y": ty0, "w": tw, "h": th,
                "pixels": pixels,
                "fill": round(pixels / (tw * th * TILE * TILE), 3),
            })

    # Merge objects that share tiles: two islands inside one tile footprint
    # (a lamp's base and its shade) are one piece of furniture.
    merged = []
    for o in sorted(objects, key=lambda o: (o["y"], o["x"])):
        hit = None
        for m in merged:
            if (o["x"] < m["x"] + m["w"] and m["x"] < o["x"] + o["w"]
                    and o["y"] < m["y"] + m["h"] and m["y"] < o["y"] + o["h"]):
                hit = m
                break
        if hit:
            nx0, ny0 = min(hit["x"], o["x"]), min(hit["y"], o["y"])
            nx1 = max(hit["x"] + hit["w"], o["x"] + o["w"])
            ny1 = max(hit["y"] + hit["h"], o["y"] + o["h"])
            hit.update(x=nx0, y=ny0, w=nx1-nx0, h=ny1-ny0, pixels=hit["pixels"] + o["pixels"])
        else:
            merged.append(dict(o))
    return merged


if __name__ == "__main__":
    out = {}
    for path in sys.argv[1:]:
        key = path.split("/")[-1].removesuffix(".png")
        found = detect(path)
        out[key] = found
        print(f"{key}: {len(found)} objects", file=sys.stderr)
    print(json.dumps(out))
