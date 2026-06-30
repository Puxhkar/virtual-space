import { AssetManifestSchema, type AssetManifest } from "@vo/shared";

export const ASSET_ROOT = "/assets";

let cached: AssetManifest | undefined;

/**
 * Loads and validates the asset manifest.
 *
 * Validated rather than trusted: a manifest with the wrong tile size or a
 * missing direction would otherwise fail deep inside the renderer as a wrong
 * frame index, which is a miserable thing to debug.
 */
export async function loadManifest(): Promise<AssetManifest> {
  if (cached) return cached;

  const res = await fetch(`${ASSET_ROOT}/manifest.json`);
  if (!res.ok) {
    throw new Error(`Could not load asset manifest (${res.status})`);
  }

  const parsed = AssetManifestSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(
      `Asset manifest is invalid:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }

  const manifest = parsed.data;

  cached = manifest;
  return manifest;
}

export function assetUrl(file: string): string {
  return `${ASSET_ROOT}/${file}`;
}
