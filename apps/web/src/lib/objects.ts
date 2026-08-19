import { ASSET_ROOT } from "@/game/manifest";

/**
 * Furniture, as whole objects rather than loose tiles.
 *
 * A wardrobe is 2x3 tiles and a conference table 5x3; placing one a tile at a
 * time means doing that arithmetic by hand, and getting it wrong leaves a
 * clipped desk or a sealed doorway. The index is generated from the sheets
 * themselves (scripts/generate-objects.mjs), so a footprint is measured, never
 * guessed.
 *
 * It is fetched rather than imported: 3,751 objects is a large constant to put
 * in the bundle for a page most people never open.
 */

export interface Stamp {
  /** Position in its sheet, in tiles — the stable identity of an object. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row-major global ids covering the footprint. */
  gids: number[];
}

export type ObjectIndex = Record<string, Stamp[]>;

let cache: Promise<ObjectIndex> | null = null;

export function loadObjects(): Promise<ObjectIndex> {
  cache ??= fetch(`${ASSET_ROOT}/limezu/objects.json`)
    .then((r) => (r.ok ? (r.json() as Promise<ObjectIndex>) : {}))
    // A missing index must not stop the editor opening — tile painting still
    // works, there are simply no objects to stamp.
    .catch(() => ({}) as ObjectIndex);
  return cache;
}

/** The gid to write at one cell of a stamp, or 0 where it covers nothing. */
export function stampGidAt(stamp: Stamp, dx: number, dy: number): number {
  return stamp.gids[dy * stamp.w + dx] ?? 0;
}

export function stampKey(sheet: string, stamp: Stamp): string {
  return `${sheet}:${stamp.x},${stamp.y}`;
}
