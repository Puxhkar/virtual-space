import * as z from "zod";
import { FacingSchema, type Facing } from "./geometry.js";

/**
 * The asset manifest.
 *
 * Nothing in game code names an image file, hardcodes a tile size, or knows
 * how a sprite sheet is laid out. All of it comes from here, so replacing the
 * art pack is a manifest edit plus a re-slice (decision 006).
 *
 * The shape is deliberately general: the first pack had square 16x16
 * characters in a [left, down, up, right] atlas; the second has 32x64
 * characters in [right, up, left, down] with a six-frame walk. Both are
 * described by the same fields.
 */

export const TilesetRefSchema = z.object({
  key: z.string().min(1),
  /** Path relative to the asset root. */
  file: z.string().min(1),
  tileWidth: z.int().min(1),
  tileHeight: z.int().min(1),
  /** Border around the whole atlas, in pixels. */
  margin: z.int().min(0),
  /** Gap between adjacent tiles. Non-zero prevents texture bleeding. */
  spacing: z.int().min(0),
  columns: z.int().min(1),
  /**
   * First global id for this tileset within a map.
   *
   * Tiled numbers tiles across all tilesets in one map, so a second tileset
   * starts where the first left off. Keeping it here means the map generator
   * and the renderer cannot disagree about it.
   */
  firstGid: z.int().min(1),
});
export type TilesetRef = z.infer<typeof TilesetRefSchema>;

/** A run of consecutive frames on one row, for one facing. */
export const AnimationRunSchema = z.object({
  /** Column of the first frame, relative to the variant's row. */
  column: z.int().min(0),
  length: z.int().min(1),
});
export type AnimationRun = z.infer<typeof AnimationRunSchema>;

const ByFacingSchema = z.object({
  up: AnimationRunSchema,
  down: AnimationRunSchema,
  left: AnimationRunSchema,
  right: AnimationRunSchema,
});

export const CharacterVariantSchema = z.object({
  key: z.string().min(1),
  /** Atlas row for this variant. */
  row: z.int().min(0),
});
export type CharacterVariant = z.infer<typeof CharacterVariantSchema>;

export const CharacterSetSchema = z.object({
  key: z.string().min(1),
  file: z.string().min(1),
  /** Sprites are often taller than they are wide — a body plus a head. */
  frameWidth: z.int().min(1),
  frameHeight: z.int().min(1),
  /** Columns in the atlas. Turns (row, column) into a flat frame index. */
  columns: z.int().min(1),
  /**
   * Where the sprite's feet sit inside its frame, from the top.
   *
   * A 32x64 sprite stands on the bottom of its frame, so the avatar's map
   * position is not its frame centre. Without this the character floats half
   * a tile above the floor.
   */
  footOffsetY: z.int().min(0),
  idle: ByFacingSchema,
  walk: ByFacingSchema,
  variants: z.array(CharacterVariantSchema).min(1),
});
export type CharacterSet = z.infer<typeof CharacterSetSchema>;

export const AssetManifestSchema = z.object({
  /** Square tile size in pixels. */
  tileSize: z.int().min(1),
  /**
   * Characters only.
   *
   * Tilesets are NOT here — they come from the shared catalogue, which both
   * the renderer and the editor read. Having two lists meant the editor could
   * publish a map referencing sheets the renderer had never registered, and
   * the office simply failed to load.
   */
  characters: CharacterSetSchema,
  /**
   * Licence attribution, shown in the product.
   *
   * Required by CC-BY packs. The field is not optional so a pack that needs
   * credit cannot be shipped without it.
   */
  credits: z.array(z.string()).min(1),
});
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

/** Frame index for one animation frame of one variant facing one way. */
export function characterFrameIndex(
  set: CharacterSet,
  variantIndex: number,
  facing: Facing,
  frame: number,
  animation: "idle" | "walk" = "walk",
): number | undefined {
  const variant = set.variants[variantIndex];
  if (!variant) return undefined;

  const run = set[animation][facing];
  const column = run.column + (frame % run.length);
  return variant.row * set.columns + column;
}

/** Every frame of one variant's walk cycle, in order. */
export function walkCycleFrames(
  set: CharacterSet,
  variantIndex: number,
  facing: Facing,
): number[] {
  const run = set.walk[facing];
  const frames: number[] = [];

  for (let f = 0; f < run.length; f++) {
    const index = characterFrameIndex(set, variantIndex, facing, f, "walk");
    if (index !== undefined) frames.push(index);
  }
  return frames;
}

/** The single frame shown when standing still. */
export function idleFrame(
  set: CharacterSet,
  variantIndex: number,
  facing: Facing,
): number {
  return characterFrameIndex(set, variantIndex, facing, 0, "idle") ?? 0;
}

export const FACINGS: readonly Facing[] = ["up", "down", "left", "right"];
export { FacingSchema };
