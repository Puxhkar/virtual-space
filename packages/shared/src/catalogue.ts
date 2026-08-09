import * as z from "zod";

/**
 * The tile catalogue.
 *
 * Everything the art pack ships, not a curated subset — the point of the
 * editor is that an admin can reach the whole library rather than whatever a
 * developer thought to expose.
 *
 * Global ids run consecutively across tilesets so a single map layer can mix
 * a wall from one sheet with a desk from another.
 */

export const CatalogueEntrySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  file: z.string().min(1),
  columns: z.int().min(1),
  rows: z.int().min(1),
  firstGid: z.int().min(1),
  /** Walls and floors, as opposed to furniture. Listed first in the palette. */
  structural: z.boolean(),
});
export type CatalogueEntry = z.infer<typeof CatalogueEntrySchema>;

export const CatalogueSchema = z.array(CatalogueEntrySchema).min(1);
export type Catalogue = z.infer<typeof CatalogueSchema>;

/** Which tileset a global id belongs to, and its index within that sheet. */
export function resolveGid(
  catalogue: Catalogue,
  gid: number,
): { entry: CatalogueEntry; index: number } | undefined {
  if (gid <= 0) return undefined;

  for (let i = catalogue.length - 1; i >= 0; i--) {
    const entry = catalogue[i]!;
    if (gid >= entry.firstGid) {
      const index = gid - entry.firstGid;
      return index < entry.columns * entry.rows ? { entry, index } : undefined;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Saving a map                                                        */
/* ------------------------------------------------------------------ */

/**
 * What the editor sends back.
 *
 * Deliberately not the whole Tiled document: the server rebuilds that from
 * these parts, so a malformed or hostile client cannot inject arbitrary
 * structure into a file every member of the organization then loads
 * (CLAUDE.md §12).
 */

export const EDITOR_LIMITS = {
  MIN_SIZE: 10,
  MAX_SIZE: 120,
  MAX_ZONES: 32,
} as const;

export const MapZoneInputSchema = z.object({
  name: z.string().trim().min(1).max(48),
  kind: z.enum(["meeting", "booth", "desk", "quiet"]),
  /** In tiles, not pixels. */
  x: z.int().min(0),
  y: z.int().min(0),
  width: z.int().min(1),
  height: z.int().min(1),
  /** null means unlimited. */
  capacity: z.int().min(1).max(100).nullable(),
});
export type MapZoneInput = z.infer<typeof MapZoneInputSchema>;

export const SaveMapInputSchema = z.object({
  width: z.int().min(EDITOR_LIMITS.MIN_SIZE).max(EDITOR_LIMITS.MAX_SIZE),
  height: z.int().min(EDITOR_LIMITS.MIN_SIZE).max(EDITOR_LIMITS.MAX_SIZE),
  /** Global ids, row-major, 0 for empty. One array per layer. */
  floor: z.array(z.int().min(0)),
  walls: z.array(z.int().min(0)),
  furniture: z.array(z.int().min(0)),
  spawn: z.object({ x: z.int().min(0), y: z.int().min(0) }),
  zones: z.array(MapZoneInputSchema).max(EDITOR_LIMITS.MAX_ZONES),
});
export type SaveMapInput = z.infer<typeof SaveMapInputSchema>;
