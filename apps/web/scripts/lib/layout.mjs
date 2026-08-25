/**
 * Turns a layout description into a validated Tiled map.
 *
 * The description is what a floor plan looks like as data: rooms with sizes
 * and doorways, furniture named by the object index rather than by raw tile
 * number. That separation is the point — a person (or a drawing) describes
 * *what goes where*, and the arithmetic that turns a 2x3 wardrobe into six
 * global ids happens once, here, where it is tested.
 *
 * Nothing is emitted until the result is proven walkable. A sealed doorway is
 * invisible in a map file and obvious only when someone is trapped behind it.
 */
import { readFileSync } from "node:fs";
import { findLayoutProblems, isBlocked, reachableFrom } from "@vo/shared";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TILE = 32;

const assets = join(HERE, "..", "..", "public", "assets");
export const OBJECTS = JSON.parse(
  readFileSync(join(assets, "limezu", "objects.json"), "utf8"),
);

/** `sheet#index` into the generated object index. */
export function findObject(ref) {
  const [sheet, index] = String(ref).split("#");
  const list = OBJECTS[sheet];
  if (!list) throw new Error(`no sheet "${sheet}" in the object index`);
  const object = list[Number(index)];
  if (!object) {
    throw new Error(
      `sheet "${sheet}" has ${list.length} objects; #${index} is out of range`,
    );
  }
  return object;
}

export class Grid {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.floor = new Array(width * height).fill(0);
    this.walls = new Array(width * height).fill(0);
    this.furniture = new Array(width * height).fill(0);
  }

  at(x, y) {
    return y * this.width + x;
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(layer, x, y, gid) {
    if (this.inside(x, y)) this[layer][this.at(x, y)] = gid;
  }

  fill(layer, x, y, w, h, gid) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) this.set(layer, x + dx, y + dy, gid);
    }
  }

  /** Lays an object down at its measured footprint, top-left anchored. */
  stamp(layer, x, y, object) {
    for (let dy = 0; dy < object.h; dy++) {
      for (let dx = 0; dx < object.w; dx++) {
        const gid = object.gids[dy * object.w + dx];
        // Cells the object does not cover are left alone, so an L-shaped desk
        // does not blank the floor inside its corner.
        if (gid > 0) this.set(layer, x + dx, y + dy, gid);
      }
    }
  }

  /** A rectangle of wall with the given openings left out. */
  outline(x, y, w, h, gid, doors = []) {
    const isDoor = (cx, cy) =>
      doors.some(
        (d) =>
          cx >= d.x &&
          cx < d.x + (d.w ?? 1) &&
          cy >= d.y &&
          cy < d.y + (d.h ?? 1),
      );
    for (let dx = 0; dx < w; dx++) {
      if (!isDoor(x + dx, y)) this.set("walls", x + dx, y, gid);
      if (!isDoor(x + dx, y + h - 1)) this.set("walls", x + dx, y + h - 1, gid);
    }
    for (let dy = 0; dy < h; dy++) {
      if (!isDoor(x, y + dy)) this.set("walls", x, y + dy, gid);
      if (!isDoor(x + w - 1, y + dy)) this.set("walls", x + w - 1, y + dy, gid);
    }
  }
}

/**
 * Refuses a layout nobody could use.
 *
 * Furniture blocks movement, so a plant one tile out of place seals a room —
 * which happened three times while laying out the starter office, each time
 * invisible until someone walked into it. Naming the room that got sealed is
 * the difference between a fixable error and a mystery.
 */
export function assertUsable(grid, spawn, zones) {
  const problems = findLayoutProblems(grid, spawn, zones);
  if (problems.length > 0) {
    throw new Error(problems.map((p) => p.reason).join("\n  "));
  }
  return reachableFrom(grid, spawn.x, spawn.y).size;
}

/** Re-exported so callers need only one import. */
export { isBlocked };

const px = (n) => n * TILE;

export function toTiled(grid, spawn, zones, tilesets) {
  const layer = (id, name, data) => ({
    data,
    height: grid.height,
    id,
    name,
    opacity: 1,
    type: "tilelayer",
    visible: true,
    width: grid.width,
    x: 0,
    y: 0,
  });

  return {
    compressionlevel: -1,
    height: grid.height,
    infinite: false,
    layers: [
      layer(1, "floor", grid.floor),
      layer(2, "walls", grid.walls),
      layer(3, "furniture", grid.furniture),
      {
        draworder: "topdown",
        id: 4,
        name: "objects",
        objects: [
          {
            height: TILE,
            id: 1,
            name: "spawn",
            rotation: 0,
            type: "spawn",
            visible: true,
            width: TILE,
            x: px(spawn.x),
            y: px(spawn.y),
          },
          ...zones.map((zone, i) => ({
            height: px(zone.height),
            id: 2 + i,
            name: zone.name,
            properties: [
              { name: "kind", type: "string", value: zone.kind },
              ...(zone.capacity
                ? [{ name: "capacity", type: "int", value: zone.capacity }]
                : []),
            ],
            rotation: 0,
            type: "zone",
            visible: true,
            width: px(zone.width),
            x: px(zone.x),
            y: px(zone.y),
          })),
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 5,
    nextobjectid: 2 + zones.length,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.11.2",
    tileheight: TILE,
    tilesets,
    tilewidth: TILE,
    type: "map",
    version: "1.10",
    width: grid.width,
  };
}
