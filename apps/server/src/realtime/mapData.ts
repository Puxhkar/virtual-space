import * as z from "zod";
import type { Vec2 } from "@vo/shared";

/**
 * The parts of a Tiled map the server needs.
 *
 * The server does not render, so it reads only the object layer — the spawn
 * point and the map's extent. Tile layers stay opaque and are handed to the
 * client untouched.
 *
 * Parsed rather than trusted: map JSON is customer-editable once offices are
 * customisable, which makes it an input surface (CLAUDE.md §12).
 */

const TiledObjectSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  x: z.number(),
  y: z.number(),
});

const TiledLayerSchema = z.object({
  name: z.string(),
  type: z.string(),
  objects: z.array(TiledObjectSchema).optional(),
});

const TiledMapSchema = z.object({
  width: z.int().min(1),
  height: z.int().min(1),
  tilewidth: z.int().min(1),
  tileheight: z.int().min(1),
  layers: z.array(TiledLayerSchema),
});

export interface MapInfo {
  spawn: Vec2;
  bounds: { width: number; height: number };
}

/** Used when a map has no object layer or fails to parse. */
const FALLBACK: MapInfo = {
  spawn: { x: 0, y: 0 },
  bounds: { width: 4096, height: 4096 },
};

export function readMapInfo(data: unknown): MapInfo {
  const parsed = TiledMapSchema.safeParse(data);
  if (!parsed.success) return FALLBACK;

  const map = parsed.data;
  const bounds = {
    width: map.width * map.tilewidth,
    height: map.height * map.tileheight,
  };

  const objects = map.layers.find((l) => l.type === "objectgroup")?.objects;
  const spawn = objects?.find((o) => o.name === "spawn" || o.type === "spawn");

  if (!spawn) return { spawn: centre(bounds), bounds };

  // Tiled object coordinates are the top-left of the tile; the avatar stands
  // at its centre.
  return {
    spawn: {
      x: spawn.x + map.tilewidth / 2,
      y: spawn.y + map.tileheight / 2,
    },
    bounds,
  };
}

function centre(bounds: { width: number; height: number }): Vec2 {
  return { x: bounds.width / 2, y: bounds.height / 2 };
}
