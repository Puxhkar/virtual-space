#!/usr/bin/env node
/**
 * Compiles a layout description into a playable office.
 *
 *   node scripts/build-office.mjs layouts/head-office.json
 *
 * The description says what a floor plan says: how big the office is, where
 * the rooms are, which of them are private, and what furniture goes where —
 * furniture named from the generated object index rather than by raw tile
 * number. That is the whole point of the separation: a drawing can be turned
 * into one of these by hand, and everything after it is arithmetic that is
 * tested rather than eyeballed.
 *
 * Nothing is written until the result is proven walkable.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TILESETS } from "@vo/shared";
import {
  Grid,
  TILE,
  assertUsable,
  findObject,
  toTiled,
} from "./lib/layout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OFFICE_MAP_OUT
  ? resolve(process.env.OFFICE_MAP_OUT)
  : join(HERE, "..", "public", "maps", "office.json");

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: node scripts/build-office.mjs <layout.json>");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(resolve(specPath), "utf8"));

/** Named tiles, so a description never carries a bare number. */
const PALETTE = spec.palette ?? {};
const tile = (name) => {
  if (name === undefined || name === null) return 0;
  const value = PALETTE[name];
  if (value === undefined) {
    throw new Error(
      `"${name}" is not in the palette — add it, or use one of: ` +
        Object.keys(PALETTE).join(", "),
    );
  }
  return value;
};

const grid = new Grid(spec.width, spec.height);

// Ground first, so every later layer sits on something.
grid.fill("floor", 0, 0, spec.width, spec.height, tile(spec.floor));

const zones = [];

for (const room of spec.rooms ?? []) {
  const { x, y, w, h } = room;

  if (room.floor) grid.fill("floor", x, y, w, h, tile(room.floor));
  if (room.walls !== false) {
    grid.outline(x, y, w, h, tile(room.wall ?? spec.wall), room.doors ?? []);
  }

  for (const piece of room.furniture ?? []) {
    const object = findObject(piece.object);
    // Positions inside a room are relative to it, so moving a room moves its
    // contents — describing a plan means moving rooms around constantly.
    grid.stamp(piece.layer ?? "furniture", x + piece.x, y + piece.y, object);
  }

  if (room.private !== false && room.kind) {
    zones.push({
      name: room.name,
      kind: room.kind,
      // The zone is the room's interior; its walls are not part of it.
      x: x + 1,
      y: y + 1,
      width: Math.max(1, w - 2),
      height: Math.max(1, h - 2),
      capacity: room.capacity ?? null,
    });
  }
}

// Loose furniture, placed in absolute coordinates — plants in a corridor,
// a reception desk in the open floor.
for (const piece of spec.furniture ?? []) {
  grid.stamp(
    piece.layer ?? "furniture",
    piece.x,
    piece.y,
    findObject(piece.object),
  );
}

let reachable;
try {
  reachable = assertUsable(grid, spec.entrance, zones);
} catch (cause) {
  // The layout is wrong, not the program. A stack trace buries the one line
  // that says which room got sealed.
  console.error(
    `\n${specPath} cannot be used as an office:\n  ${cause.message}\n`,
  );
  process.exit(1);
}

const tilesets = TILESETS.map((t) => ({
  columns: t.columns,
  firstgid: t.firstGid,
  image: `../assets/${t.file}`,
  imageheight: t.rows * TILE,
  imagewidth: t.columns * TILE,
  margin: 0,
  name: t.key,
  spacing: 0,
  tilecount: t.columns * t.rows,
  tileheight: TILE,
  tilewidth: TILE,
}));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(toTiled(grid, spec.entrance, zones, tilesets), null, 2) + "\n",
);

console.log(`wrote ${OUT}`);
console.log(
  `  ${spec.width}x${spec.height} tiles, ${zones.length} rooms, ` +
    `${reachable} reachable tiles`,
);
