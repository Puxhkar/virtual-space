/**
 * Generates the V1 office as Tiled-format JSON.
 *
 * The map is data, never code (CLAUDE.md §17). This script exists so the
 * starter office is reproducible; the output is a normal Tiled file and can be
 * opened and edited in Tiled from here on.
 *
 *   node scripts/generate-map.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "public", "maps", "office.json");

const W = 40;
const H = 30;
const TILE = 32;

/**
 * Tile indices in the LimeZu Room Builder atlas (76 columns, row-major).
 *
 * Every one of these came from `find-fill-tiles.py`, which reports the tiles
 * that are both seamless and near-uniform. Of 8,588 tiles in this atlas only
 * 81 qualify — picking one by eye is how a floor ends up rendering as stripes
 * or as a wall of window frames.
 */
const T = {
  FLOOR: 2467, // warm taupe carpet
  FLOOR_ALT: 1775, // teal, marks the standup room
  WALL: 4995, // dark slate with a subtle vertical texture
  RUG: 1407, // patterned square motif, marks the lounge
};

/**
 * Furniture, from the Generic theme sheet (16 columns).
 *
 * Most pieces span several tiles, so each entry records its size and the
 * atlas index of its top-left corner. `stamp` lays the block down.
 */
const FURNITURE_COLUMNS = 16;
const F = {
  CONFERENCE_TABLE: { i: 80, w: 4, h: 3 },
  DESK: { i: 256, w: 2, h: 1 }, // light wood
  DESK_ALT: { i: 258, w: 2, h: 1 }, // orange
  SOFA: { i: 117, w: 3, h: 1 },
  STOOL: { i: 304, w: 1, h: 1 },
  STOOL_PALE: { i: 305, w: 1, h: 1 },
  PALM: { i: 413, w: 1, h: 3 },
};

/** Tiled gids are 1-based; 0 means empty. */
const gid = (i) => i + 1;
/** Furniture lives in the second tileset, which starts after the first. */
const ROOMS_TILE_COUNT = 76 * 113;
const fgid = (i) => ROOMS_TILE_COUNT + 1 + i;
const EMPTY = 0;

const blank = () => new Array(W * H).fill(EMPTY);
const at = (x, y) => y * W + x;

/* ---------------- floor ---------------- */
const floor = blank();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) floor[at(x, y)] = gid(T.FLOOR);
}

// Standup room occupies the top-right corner.
const ROOM = { x: 26, y: 1, w: 12, h: 10 };

/** Everything from here east is kept clear as a walkway to the standup room. */
const AISLE_X = 19;
for (let y = ROOM.y; y < ROOM.y + ROOM.h; y++) {
  for (let x = ROOM.x; x < ROOM.x + ROOM.w; x++) {
    floor[at(x, y)] = gid(T.FLOOR_ALT);
  }
}

// A rug marking the social corner, bottom-left.
for (let y = 22; y < 27; y++) {
  for (let x = 3; x < 10; x++) floor[at(x, y)] = gid(T.RUG);
}

/* ---------------- walls ---------------- */
const walls = blank();

// Outer boundary.
for (let x = 0; x < W; x++) {
  walls[at(x, 0)] = gid(T.WALL);
  walls[at(x, H - 1)] = gid(T.WALL);
}
for (let y = 0; y < H; y++) {
  walls[at(0, y)] = gid(T.WALL);
  walls[at(W - 1, y)] = gid(T.WALL);
}

/*
 * Standup room: left wall and bottom wall, with a doorway in the left wall.
 *
 * Three tiles wide, not two. The avatar's collision body is shorter than its
 * sprite and sits at its feet, so a two-tile gap has a usable band narrower
 * than it looks — and ten people funnelling through it at the start of a
 * standup is exactly when that matters.
 */
const DOOR_Y = ROOM.y + 4;
const DOOR_HEIGHT = 3;
for (let y = ROOM.y; y < ROOM.y + ROOM.h; y++) {
  if (y >= DOOR_Y && y < DOOR_Y + DOOR_HEIGHT) continue;
  walls[at(ROOM.x - 1, y)] = gid(T.WALL);
}
for (let x = ROOM.x - 1; x < W; x++) {
  walls[at(x, ROOM.y + ROOM.h)] = gid(T.WALL);
}

/* ---------------- furniture ---------------- */
const furniture = blank();

/**
 * Lays a multi-tile object down with its top-left corner at (x, y).
 *
 * Furniture is not one tile: a conference table is 4x3. Stamping the block
 * keeps the map generator readable and makes it obvious when two pieces
 * would overlap.
 */
function stamp(layer, x, y, piece) {
  for (let dy = 0; dy < piece.h; dy++) {
    for (let dx = 0; dx < piece.w; dx++) {
      const src = piece.i + dy * FURNITURE_COLUMNS + dx;
      layer[at(x + dx, y + dy)] = fgid(src);
    }
  }
}

/*
 * Desk pods, west of the aisle.
 *
 * Everything east of AISLE_X is left clear so there is an unobstructed walk
 * from the entrance to the standup doorway. The first layout put a stool in
 * the spawn column, which meant a person walked into furniture on their first
 * step — obvious in play, invisible in the map file.
 */
for (const [row, desk] of [
  [6, F.DESK],
  [10, F.DESK_ALT],
  [16, F.DESK],
  [20, F.DESK_ALT],
]) {
  for (let x = 4; x + 2 < AISLE_X; x += 5) {
    stamp(furniture, x, row, desk);
    furniture[at(x + 2, row)] = fgid(F.STOOL.i);
  }
}

// The standup room: a conference table with stools down both long sides.
stamp(furniture, ROOM.x + 4, ROOM.y + 3, F.CONFERENCE_TABLE);
for (let dy = 0; dy < 3; dy++) {
  furniture[at(ROOM.x + 3, ROOM.y + 3 + dy)] = fgid(F.STOOL.i);
  furniture[at(ROOM.x + 8, ROOM.y + 3 + dy)] = fgid(F.STOOL_PALE.i);
}

// The lounge gets a sofa on its rug, against the far side so the rug is
// still walkable.
stamp(furniture, 4, 23, F.SOFA);

// Plants. Kept clear of the doorway — furniture collides, so a decorative
// tile beside a door silently seals the room.
// Palms are three tiles tall and placed by their top row. Kept out of the
// aisle and clear of the doorway — furniture collides, so a decorative tile
// beside a door silently seals the room.
/*
 * Kept inside the desk area and along the far edges, never in a walkway.
 * Three palms in a row ended up blocking the route to the lounge and the
 * aisle in turn — decoration is the easiest thing to place and the easiest
 * to trap someone with.
 */
for (const [x, y] of [
  [2, 2],
  [2, 12],
  [11, 2],
  [11, 12],
  [30, 26],
  [36, 26],
]) {
  stamp(furniture, x, y, F.PALM);
}

/* ---------------- objects ---------------- */
const px = (n) => n * TILE;

const objects = [
  {
    id: 1,
    name: "spawn",
    type: "spawn",
    // In the aisle, so the first step is never into a desk.
    x: px(AISLE_X + 1),
    y: px(24),
    width: TILE,
    height: TILE,
    rotation: 0,
    visible: true,
    point: true,
    properties: [],
  },
  {
    id: 2,
    name: "Standup Room",
    type: "zone",
    x: px(ROOM.x),
    y: px(ROOM.y),
    width: px(ROOM.w),
    height: px(ROOM.h),
    rotation: 0,
    visible: true,
    properties: [
      { name: "kind", type: "string", value: "meeting" },
      { name: "capacity", type: "int", value: 0 },
    ],
  },
  {
    id: 3,
    name: "Lounge",
    type: "zone",
    x: px(3),
    y: px(22),
    width: px(7),
    height: px(5),
    rotation: 0,
    visible: true,
    properties: [
      { name: "kind", type: "string", value: "booth" },
      { name: "capacity", type: "int", value: 4 },
    ],
  },
];

/* ---------------- assemble ---------------- */
const layer = (id, name, data) => ({
  data,
  height: H,
  id,
  name,
  opacity: 1,
  type: "tilelayer",
  visible: true,
  width: W,
  x: 0,
  y: 0,
});

const map = {
  compressionlevel: -1,
  height: H,
  infinite: false,
  layers: [
    layer(1, "floor", floor),
    layer(2, "walls", walls),
    layer(3, "furniture", furniture),
    {
      draworder: "topdown",
      id: 4,
      name: "objects",
      objects,
      opacity: 1,
      type: "objectgroup",
      visible: true,
      x: 0,
      y: 0,
    },
  ],
  nextlayerid: 5,
  nextobjectid: objects.length + 1,
  orientation: "orthogonal",
  renderorder: "right-down",
  tiledversion: "1.10.2",
  tileheight: TILE,
  // Every sheet in the library, so a map edited in the admin panel can
  // reference any of them without the renderer having to be changed.
  tilesets: [
    {
      columns: 76,
      firstgid: 1,
      image: "../assets/limezu/tiles/room-builder.png",
      imageheight: 3616,
      imagewidth: 2432,
      margin: 0,
      name: "room-builder",
      spacing: 0,
      tilecount: 8588,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 8589,
      image: "../assets/limezu/tiles/generic.png",
      imageheight: 2496,
      imagewidth: 512,
      margin: 0,
      name: "generic",
      spacing: 0,
      tilecount: 1248,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 9837,
      image: "../assets/limezu/tiles/living-room.png",
      imageheight: 1440,
      imagewidth: 512,
      margin: 0,
      name: "living-room",
      spacing: 0,
      tilecount: 720,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 10557,
      image: "../assets/limezu/tiles/bathroom.png",
      imageheight: 1792,
      imagewidth: 512,
      margin: 0,
      name: "bathroom",
      spacing: 0,
      tilecount: 896,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 11453,
      image: "../assets/limezu/tiles/bedroom.png",
      imageheight: 3424,
      imagewidth: 512,
      margin: 0,
      name: "bedroom",
      spacing: 0,
      tilecount: 1712,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 13165,
      image: "../assets/limezu/tiles/classroom-library.png",
      imageheight: 1088,
      imagewidth: 512,
      margin: 0,
      name: "classroom-library",
      spacing: 0,
      tilecount: 544,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 13709,
      image: "../assets/limezu/tiles/music-sport.png",
      imageheight: 1536,
      imagewidth: 512,
      margin: 0,
      name: "music-sport",
      spacing: 0,
      tilecount: 768,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 14477,
      image: "../assets/limezu/tiles/art.png",
      imageheight: 224,
      imagewidth: 512,
      margin: 0,
      name: "art",
      spacing: 0,
      tilecount: 112,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 14589,
      image: "../assets/limezu/tiles/gym.png",
      imageheight: 1056,
      imagewidth: 512,
      margin: 0,
      name: "gym",
      spacing: 0,
      tilecount: 528,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 15117,
      image: "../assets/limezu/tiles/fishing.png",
      imageheight: 864,
      imagewidth: 512,
      margin: 0,
      name: "fishing",
      spacing: 0,
      tilecount: 432,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 12,
      firstgid: 15549,
      image: "../assets/limezu/tiles/birthday-party.png",
      imageheight: 224,
      imagewidth: 384,
      margin: 0,
      name: "birthday-party",
      spacing: 0,
      tilecount: 84,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 15633,
      image: "../assets/limezu/tiles/halloween.png",
      imageheight: 1952,
      imagewidth: 512,
      margin: 0,
      name: "halloween",
      spacing: 0,
      tilecount: 976,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 16609,
      image: "../assets/limezu/tiles/kitchen.png",
      imageheight: 1568,
      imagewidth: 512,
      margin: 0,
      name: "kitchen",
      spacing: 0,
      tilecount: 784,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 17393,
      image: "../assets/limezu/tiles/conference-hall.png",
      imageheight: 384,
      imagewidth: 512,
      margin: 0,
      name: "conference-hall",
      spacing: 0,
      tilecount: 192,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 17585,
      image: "../assets/limezu/tiles/basement.png",
      imageheight: 1600,
      imagewidth: 512,
      margin: 0,
      name: "basement",
      spacing: 0,
      tilecount: 800,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 18385,
      image: "../assets/limezu/tiles/christmas.png",
      imageheight: 544,
      imagewidth: 512,
      margin: 0,
      name: "christmas",
      spacing: 0,
      tilecount: 272,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 18657,
      image: "../assets/limezu/tiles/grocery-store.png",
      imageheight: 2496,
      imagewidth: 512,
      margin: 0,
      name: "grocery-store",
      spacing: 0,
      tilecount: 1248,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 19905,
      image: "../assets/limezu/tiles/upstairs-system.png",
      imageheight: 864,
      imagewidth: 512,
      margin: 0,
      name: "upstairs-system",
      spacing: 0,
      tilecount: 432,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 20337,
      image: "../assets/limezu/tiles/jail.png",
      imageheight: 1440,
      imagewidth: 512,
      margin: 0,
      name: "jail",
      spacing: 0,
      tilecount: 720,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 21057,
      image: "../assets/limezu/tiles/hospital.png",
      imageheight: 3520,
      imagewidth: 512,
      margin: 0,
      name: "hospital",
      spacing: 0,
      tilecount: 1760,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 22817,
      image: "../assets/limezu/tiles/japanese-interiors.png",
      imageheight: 1024,
      imagewidth: 512,
      margin: 0,
      name: "japanese-interiors",
      spacing: 0,
      tilecount: 512,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 23329,
      image: "../assets/limezu/tiles/clothing-store.png",
      imageheight: 2144,
      imagewidth: 512,
      margin: 0,
      name: "clothing-store",
      spacing: 0,
      tilecount: 1072,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 24401,
      image: "../assets/limezu/tiles/museum.png",
      imageheight: 3904,
      imagewidth: 512,
      margin: 0,
      name: "museum",
      spacing: 0,
      tilecount: 1952,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 26353,
      image: "../assets/limezu/tiles/tv-film-studio.png",
      imageheight: 448,
      imagewidth: 512,
      margin: 0,
      name: "tv-film-studio",
      spacing: 0,
      tilecount: 224,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 26577,
      image: "../assets/limezu/tiles/ice-cream-shop.png",
      imageheight: 544,
      imagewidth: 512,
      margin: 0,
      name: "ice-cream-shop",
      spacing: 0,
      tilecount: 272,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 26849,
      image: "../assets/limezu/tiles/shooting-range.png",
      imageheight: 160,
      imagewidth: 512,
      margin: 0,
      name: "shooting-range",
      spacing: 0,
      tilecount: 80,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 16,
      firstgid: 26929,
      image: "../assets/limezu/tiles/condominium.png",
      imageheight: 608,
      imagewidth: 512,
      margin: 0,
      name: "condominium",
      spacing: 0,
      tilecount: 304,
      tileheight: TILE,
      tilewidth: TILE,
    },
  ],
  tilewidth: TILE,
  type: "map",
  version: "1.10",
  width: W,
};

/* ---------------- validate ---------------- */

/**
 * Every zone must be walkable from the spawn point.
 *
 * A decorative tile placed one square from a doorway seals the room, and
 * nothing about the map file looks wrong when it happens — it surfaces as a
 * player who cannot reach the standup. Flood fill catches it at generation
 * time instead of in a browser.
 */
function assertZonesReachable() {
  const blocked = (x, y) =>
    x < 0 ||
    y < 0 ||
    x >= W ||
    y >= H ||
    walls[at(x, y)] !== EMPTY ||
    furniture[at(x, y)] !== EMPTY;

  const spawnObj = objects.find((o) => o.type === "spawn");
  const start = [Math.floor(spawnObj.x / TILE), Math.floor(spawnObj.y / TILE)];
  if (blocked(start[0], start[1])) {
    throw new Error(`spawn point at tile ${start} is inside a solid tile`);
  }

  const seen = new Set([start[1] * W + start[0]]);
  const queue = [start];
  while (queue.length > 0) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      const key = ny * W + nx;
      if (seen.has(key) || blocked(nx, ny)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }

  for (const zone of objects.filter((o) => o.type === "zone")) {
    const tiles = [];
    for (let y = zone.y / TILE; y < (zone.y + zone.height) / TILE; y++) {
      for (let x = zone.x / TILE; x < (zone.x + zone.width) / TILE; x++) {
        if (seen.has(y * W + x)) tiles.push([x, y]);
      }
    }
    if (tiles.length === 0) {
      throw new Error(
        `zone "${zone.name}" is unreachable from the spawn point — ` +
          `check for furniture blocking its doorway`,
      );
    }
  }

  return seen.size;
}

/**
 * The aisle must stay walkable end to end.
 *
 * A single decorative tile in the walkway is enough to trap someone between
 * their desk and the standup room, and nothing about the map file shows it.
 * A palm at (24, 25) did exactly that — placed one row outside the aisle on
 * paper, but the avatar's collision body sits half a tile below its centre,
 * so it blocked the corridor in practice.
 */
function assertAisleClear() {
  const blocked = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = AISLE_X; x <= ROOM.x - 2; x++) {
      if (walls[at(x, y)] !== EMPTY || furniture[at(x, y)] !== EMPTY) {
        blocked.push(`(${x}, ${y})`);
      }
    }
  }
  if (blocked.length > 0) {
    throw new Error(
      `the aisle (x ${AISLE_X}..${ROOM.x - 2}) must stay clear, but ` +
        `${blocked.length} tile(s) are occupied: ${blocked.slice(0, 5).join(", ")}`,
    );
  }
}

/**
 * The floor along the bottom must stay walkable, so the lounge is reachable
 * from the entrance without threading between furniture.
 */
function assertConcourseClear() {
  const blocked = [];
  for (let y = 23; y <= 26; y++) {
    for (let x = 10; x < ROOM.x; x++) {
      if (walls[at(x, y)] !== EMPTY || furniture[at(x, y)] !== EMPTY) {
        blocked.push(`(${x}, ${y})`);
      }
    }
  }
  if (blocked.length > 0) {
    throw new Error(
      `the concourse (y 23..26) must stay clear, but ` +
        `${blocked.length} tile(s) are occupied: ${blocked.slice(0, 5).join(", ")}`,
    );
  }
}

assertAisleClear();
assertConcourseClear();
const reachable = assertZonesReachable();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(map, null, 1));
console.log(
  `wrote ${OUT}\n  ${W}x${H} tiles (${W * TILE}x${H * TILE}px), ` +
    `${map.layers.length} layers, ${objects.length} objects, ` +
    `${reachable} reachable tiles, all zones reachable`,
);
