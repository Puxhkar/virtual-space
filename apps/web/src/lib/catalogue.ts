import {
  TILESETS,
  resolveGid,
  type Catalogue,
  type CatalogueEntry,
} from "@vo/shared";
import { ASSET_ROOT } from "@/game/manifest";

/**
 * Tileset images for the editor.
 *
 * The catalogue itself is a compile-time constant shared with the server;
 * only the images are fetched. They are cached because the palette switches
 * sheets constantly and a 27-sheet library is several megabytes.
 */

export const TILE = 32;
export const catalogue: Catalogue = TILESETS;

const images = new Map<string, HTMLImageElement>();

export function tilesetImage(entry: CatalogueEntry): HTMLImageElement {
  const cached = images.get(entry.key);
  if (cached) return cached;

  const img = new Image();
  img.src = `${ASSET_ROOT}/${entry.file}`;
  images.set(entry.key, img);
  return img;
}

/**
 * Resolves every image up front so the first paint is not half-empty.
 *
 * Never rejects and never hangs. An earlier version checked `complete` and
 * *then* attached a load handler, so an image that finished between those two
 * lines resolved neither — with 27 sheets that happened often enough to leave
 * the editor stuck on "Loading" with nothing in the console.
 */
export async function preloadTilesets(): Promise<void> {
  await Promise.all(
    catalogue.map(
      (entry) =>
        new Promise<void>((resolve) => {
          const img = tilesetImage(entry);
          let settled = false;
          const done = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };

          img.addEventListener("load", done, { once: true });
          // A missing sheet must not stop the editor opening; it simply draws
          // nothing for those tiles.
          img.addEventListener("error", done, { once: true });

          // Re-checked after attaching, closing the race.
          if (img.complete) done();

          // And a hard ceiling, so one wedged request cannot hold the panel.
          setTimeout(done, 10_000);
        }),
    ),
  );
}

/** Where a global id sits inside its sheet, in pixels. */
export function gidSource(
  gid: number,
): { image: HTMLImageElement; sx: number; sy: number } | undefined {
  const found = resolveGid(catalogue, gid);
  if (!found) return undefined;

  const { entry, index } = found;
  return {
    image: tilesetImage(entry),
    sx: (index % entry.columns) * TILE,
    sy: Math.floor(index / entry.columns) * TILE,
  };
}

/** Draws one tile onto a context, if its sheet has loaded. */
export function drawGid(
  ctx: CanvasRenderingContext2D,
  gid: number,
  dx: number,
  dy: number,
  size = TILE,
): void {
  if (gid <= 0) return;
  const src = gidSource(gid);
  if (!src?.image.complete || src.image.naturalWidth === 0) return;

  ctx.drawImage(src.image, src.sx, src.sy, TILE, TILE, dx, dy, size, size);
}
