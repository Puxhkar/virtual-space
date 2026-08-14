import { and, eq } from "drizzle-orm";
import {
  EDITOR_LIMITS,
  TILESETS,
  findLayoutProblems,
  type MapZoneInput,
  type OfficeId,
  type SaveMapInput,
} from "@vo/shared";
import type { Db } from "./client.js";
import type { Scope } from "../scope.js";
import { maps, offices, zones } from "./schema.js";

/**
 * Saving an edited office.
 *
 * The client sends layers, a spawn point and zones — never a whole Tiled
 * document. The server builds the document, so a malformed or hostile editor
 * cannot inject arbitrary structure into a file every member of the
 * organization then loads (CLAUDE.md §12).
 */

const TILE = 32;

export class MapValidationError extends Error {}

/**
 * Rejects a map nobody could use.
 *
 * A saved office that traps people is worse than a rejected save: the person
 * who broke it has already moved on, and the people who cannot reach the
 * standup have no idea why.
 */
function validate(input: SaveMapInput): void {
  const expected = input.width * input.height;
  for (const [name, layer] of [
    ["floor", input.floor],
    ["walls", input.walls],
    ["furniture", input.furniture],
  ] as const) {
    if (layer.length !== expected) {
      throw new MapValidationError(
        `The ${name} layer does not match the map size.`,
      );
    }
  }

  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < input.width && y < input.height;

  if (!inside(input.spawn.x, input.spawn.y)) {
    throw new MapValidationError("The entrance is outside the office.");
  }

  const at = (x: number, y: number) => y * input.width + x;
  const blocked = (x: number, y: number) =>
    !inside(x, y) ||
    input.walls[at(x, y)] !== 0 ||
    input.furniture[at(x, y)] !== 0;

  if (blocked(input.spawn.x, input.spawn.y)) {
    throw new MapValidationError(
      "The entrance is inside a wall or a piece of furniture.",
    );
  }

  for (const zone of input.zones) {
    if (
      !inside(zone.x, zone.y) ||
      !inside(zone.x + zone.width - 1, zone.y + zone.height - 1)
    ) {
      throw new MapValidationError(
        `"${zone.name}" extends outside the office.`,
      );
    }
  }

  /*
   * Every room must be walkable from the entrance, with somewhere to stand.
   *
   * The rule lives in the shared package because three places need the same
   * answer: this endpoint, the map generator, and the editor's preview. It is
   * tested there against the failures that produced it — three separate times
   * a single plant sealed a doorway, invisible in the map file.
   */
  const problems = findLayoutProblems(
    {
      width: input.width,
      height: input.height,
      walls: input.walls,
      furniture: input.furniture,
    },
    input.spawn,
    input.zones,
  );
  if (problems.length > 0) {
    throw new MapValidationError(problems.map((p) => p.reason).join(" "));
  }
}

/**
 * The tileset list every saved map carries.
 *
 * Taken from the shared catalogue rather than from the request: the client
 * says which tiles it used, never which sheets exist.
 */
const TILED_TILESETS = TILESETS.map((entry) => ({
  columns: entry.columns,
  firstgid: entry.firstGid,
  image: `../assets/${entry.file}`,
  imageheight: entry.rows * TILE,
  imagewidth: entry.columns * TILE,
  margin: 0,
  name: entry.key,
  spacing: 0,
  tilecount: entry.columns * entry.rows,
  tileheight: TILE,
  tilewidth: TILE,
}));

/** Builds the Tiled document the renderer expects. */
function toTiledMap(input: SaveMapInput) {
  const layer = (id: number, name: string, data: number[]) => ({
    data,
    height: input.height,
    id,
    name,
    opacity: 1,
    type: "tilelayer",
    visible: true,
    width: input.width,
    x: 0,
    y: 0,
  });

  return {
    compressionlevel: -1,
    height: input.height,
    infinite: false,
    layers: [
      layer(1, "floor", input.floor),
      layer(2, "walls", input.walls),
      layer(3, "furniture", input.furniture),
      {
        draworder: "topdown",
        id: 4,
        name: "objects",
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
        objects: [
          {
            id: 1,
            name: "spawn",
            type: "spawn",
            x: input.spawn.x * TILE,
            y: input.spawn.y * TILE,
            width: TILE,
            height: TILE,
            rotation: 0,
            visible: true,
            point: true,
            properties: [],
          },
          ...input.zones.map((zone, i) => ({
            id: i + 2,
            name: zone.name,
            type: "zone",
            x: zone.x * TILE,
            y: zone.y * TILE,
            width: zone.width * TILE,
            height: zone.height * TILE,
            rotation: 0,
            visible: true,
            properties: [
              { name: "kind", type: "string", value: zone.kind },
              { name: "capacity", type: "int", value: zone.capacity ?? 0 },
            ],
          })),
        ],
      },
    ],
    nextlayerid: 5,
    nextobjectid: input.zones.length + 2,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.10.2",
    tileheight: TILE,
    tilesets: TILED_TILESETS,
    tilewidth: TILE,
    type: "map",
    version: "1.10",
    width: input.width,
  };
}

/**
 * Publishes an edited office as a new map version.
 *
 * A new version rather than an in-place edit, so the realtime layer's
 * version-keyed cache picks it up without invalidation, and so a bad layout
 * can be traced (decision 030).
 */
export async function saveOfficeMap(
  db: Db,
  scope: Scope,
  officeId: OfficeId,
  input: SaveMapInput,
): Promise<{ version: number; zones: MapZoneInput[] }> {
  validate(input);

  const [office] = await db
    .select()
    .from(offices)
    .where(and(eq(offices.id, officeId), eq(offices.orgId, scope.orgId)))
    .limit(1);

  if (!office) throw new MapValidationError("That office does not exist.");

  const [current] = await db
    .select()
    .from(maps)
    .where(eq(maps.id, office.mapId))
    .limit(1);

  const version = (current?.version ?? 0) + 1;

  await db
    .update(maps)
    .set({ data: toTiledMap(input), tileSize: TILE, version })
    .where(eq(maps.id, office.mapId));

  await db
    .update(offices)
    .set({ mapVersion: version })
    .where(eq(offices.id, officeId));

  /*
   * Zones are replaced wholesale rather than merged: one removed in the
   * editor must disappear from the office, and matching them up by name
   * would break the moment someone renames a room.
   */
  await db.delete(zones).where(eq(zones.officeId, officeId));

  for (const zone of input.zones) {
    await db.insert(zones).values({
      orgId: scope.orgId,
      officeId,
      name: zone.name,
      kind: zone.kind,
      bounds: {
        x: zone.x * TILE,
        y: zone.y * TILE,
        width: zone.width * TILE,
        height: zone.height * TILE,
      },
      capacity: zone.capacity,
    });
  }

  return { version, zones: input.zones };
}

export { EDITOR_LIMITS };
