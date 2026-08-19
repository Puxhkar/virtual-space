#!/usr/bin/env node
/**
 * Builds the object index: every piece of furniture in the pack, with its
 * true tile footprint.
 *
 * The pack ships raw sheets and no metadata, so a tile is just a number —
 * nothing knows that #2467 is a floor and #14203 is a wardrobe. Painting one
 * tile at a time cannot place a 2x3 wardrobe without the person doing the
 * arithmetic, which is how a plant ended up sealing a doorway three times.
 *
 * detect-objects.py recovers the footprints from the alpha channel; this wraps
 * them in gids and writes the index the editor stamps from. Structural sheets
 * (walls, floors) are skipped: they tile continuously, so "objects" there are
 * meaningless.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TILESETS } from "@vo/shared";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "public", "assets");
const props = TILESETS.filter((t) => !t.structural);

const raw = JSON.parse(
  execFileSync(
    "python3",
    [
      join(here, "detect-objects.py"),
      ...props.map((t) => join(assets, t.file)),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ),
);

/** Objects wider or taller than this are sheet artefacts, not furniture. */
const MAX_SPAN = 14;

const index = {};
let total = 0;

for (const entry of props) {
  const key = entry.file
    .split("/")
    .pop()
    .replace(/\.png$/, "");
  const found = (raw[key] ?? [])
    .filter((o) => o.w <= MAX_SPAN && o.h <= MAX_SPAN)
    // Largest first: the useful furniture leads, single tiles trail.
    .sort((a, b) => b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x)
    .map((o) => ({
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      // Row-major gids, 0 where the object does not cover that cell.
      gids: Array.from({ length: o.h }, (_, dy) =>
        Array.from(
          { length: o.w },
          (_, dx) => entry.firstGid + (o.y + dy) * entry.columns + (o.x + dx),
        ),
      ).flat(),
    }));

  if (found.length > 0) index[entry.key] = found;
  total += found.length;
}

const out = join(assets, "limezu", "objects.json");
writeFileSync(out, JSON.stringify(index));
console.log(
  `wrote ${out}\n  ${total} objects across ${Object.keys(index).length} sheets`,
);
