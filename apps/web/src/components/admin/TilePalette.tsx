"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogueEntry } from "@vo/shared";
import { TILE, catalogue, tilesetImage } from "@/lib/catalogue";
import { loadObjects, stampKey, type Stamp } from "@/lib/objects";

/**
 * The whole art library, browsable two ways.
 *
 * Tiles are the raw 32px cells — right for floors and walls, which tile
 * continuously. Objects are whole pieces of furniture with their measured
 * footprints, which is what you actually want for a desk or a sofa: a wardrobe
 * is 2x3 and placing it a tile at a time means doing that arithmetic yourself.
 *
 * Both draw to a canvas rather than producing DOM nodes — twenty-seven
 * thousand tiles as `<img>` elements makes scrolling unusable.
 */

interface Props {
  selectedGid: number | null;
  onSelectTile: (gid: number) => void;
  selectedStamp: string | null;
  onSelectStamp: (sheet: string, stamp: Stamp) => void;
}

/** How large a tile appears in the tile grid. */
const CELL = 34;
/** Pixels per tile when drawing an object thumbnail. */
const OBJECT_SCALE = 24;
const GUTTER = 10;

type Mode = "tiles" | "objects";

export function TilePalette({
  selectedGid,
  onSelectTile,
  selectedStamp,
  onSelectStamp,
}: Props) {
  const [entry, setEntry] = useState<CatalogueEntry>(catalogue[0]!);
  /*
   * What the person last chose, which is not always what is shown.
   *
   * Structural sheets tile continuously and have no objects, so they are
   * clamped to tiles below. Storing the preference rather than the effective
   * mode means passing through walls-and-floors does not silently leave every
   * later sheet stuck on single tiles.
   */
  const [preferred, setPreferred] = useState<Mode>("objects");
  const [query, setQuery] = useState("");
  const [objects, setObjects] = useState<Stamp[]>([]);
  const tilesRef = useRef<HTMLCanvasElement>(null);
  const objectsRef = useRef<HTMLCanvasElement>(null);
  /** Hit regions for the object canvas, rebuilt on every layout. */
  const hits = useRef<
    { x: number; y: number; w: number; h: number; stamp: Stamp }[]
  >([]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? catalogue.filter((c) => c.name.toLowerCase().includes(q))
      : catalogue;
  }, [query]);

  const mode: Mode = entry.structural ? "tiles" : preferred;

  useEffect(() => {
    let live = true;
    loadObjects().then((index) => {
      if (live) setObjects(index[entry.key] ?? []);
    });
    return () => {
      live = false;
    };
  }, [entry]);

  /* ---- the raw tile grid ---- */
  useEffect(() => {
    const canvas = tilesRef.current;
    if (!canvas || mode !== "tiles") return;

    const { columns, rows } = entry;
    canvas.width = columns * CELL;
    canvas.height = rows * CELL;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const draw = () => {
      const img = tilesetImage(entry);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Checkerboard, so transparent tiles are visible rather than invisible.
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
          ctx.fillStyle = (x + y) % 2 ? "#1b2022" : "#20262a";
          ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }

      if (img.complete && img.naturalWidth > 0) {
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < columns; x++) {
            ctx.drawImage(
              img,
              x * TILE,
              y * TILE,
              TILE,
              TILE,
              x * CELL + 1,
              y * CELL + 1,
              CELL - 2,
              CELL - 2,
            );
          }
        }
      }

      if (selectedGid !== null) {
        const index = selectedGid - entry.firstGid;
        if (index >= 0 && index < columns * rows) {
          const x = (index % columns) * CELL;
          const y = Math.floor(index / columns) * CELL;
          ctx.strokeStyle = "#4ade80";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
        }
      }
    };

    draw();
    const img = tilesetImage(entry);
    if (!img.complete) img.addEventListener("load", draw, { once: true });
  }, [entry, selectedGid, mode]);

  /* ---- objects, flowed into rows ---- */
  useEffect(() => {
    const canvas = objectsRef.current;
    if (!canvas || mode !== "objects") return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Shelf packing: fill a row, wrap when the next object will not fit.
    const width = 272;
    const placed: typeof hits.current = [];
    let cx = GUTTER;
    let cy = GUTTER;
    let rowHeight = 0;

    for (const stamp of objects) {
      const w = stamp.w * OBJECT_SCALE;
      const h = stamp.h * OBJECT_SCALE;
      if (cx + w > width - GUTTER && cx > GUTTER) {
        cx = GUTTER;
        cy += rowHeight + GUTTER;
        rowHeight = 0;
      }
      placed.push({ x: cx, y: cy, w, h, stamp });
      cx += w + GUTTER;
      rowHeight = Math.max(rowHeight, h);
    }

    hits.current = placed;
    canvas.width = width;
    canvas.height = cy + rowHeight + GUTTER;

    const draw = () => {
      const img = tilesetImage(entry);
      ctx.fillStyle = "#16191b";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!img.complete || img.naturalWidth === 0) return;

      for (const p of placed) {
        const selected = selectedStamp === stampKey(entry.key, p.stamp);
        ctx.fillStyle = selected ? "#14532d" : "#22282c";
        ctx.fillRect(p.x - 3, p.y - 3, p.w + 6, p.h + 6);

        ctx.drawImage(
          img,
          p.stamp.x * TILE,
          p.stamp.y * TILE,
          p.stamp.w * TILE,
          p.stamp.h * TILE,
          p.x,
          p.y,
          p.w,
          p.h,
        );

        if (selected) {
          ctx.strokeStyle = "#4ade80";
          ctx.lineWidth = 2;
          ctx.strokeRect(p.x - 3, p.y - 3, p.w + 6, p.h + 6);
        }
      }
    };

    draw();
    const img = tilesetImage(entry);
    if (!img.complete) img.addEventListener("load", draw, { once: true });
  }, [entry, objects, selectedStamp, mode]);

  return (
    <div className="flex h-full w-72 flex-col border-r border-neutral-800">
      <div className="space-y-2 border-b border-neutral-800 p-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sets"
          aria-label="Search tile sets"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs outline-none focus-visible:border-neutral-500"
        />

        <select
          value={entry.key}
          onChange={(e) =>
            setEntry(catalogue.find((c) => c.key === e.target.value) ?? entry)
          }
          aria-label="Tile set"
          className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-xs outline-none"
        >
          {shown.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name} ({c.columns * c.rows})
            </option>
          ))}
        </select>

        <div className="flex gap-1" role="group" aria-label="Palette mode">
          {(
            [
              [
                "objects",
                `Objects${objects.length ? ` (${objects.length})` : ""}`,
              ],
              ["tiles", "Tiles"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              disabled={key === "objects" && entry.structural}
              aria-pressed={mode === key}
              onClick={() => setPreferred(key)}
              className={`flex-1 rounded-md px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
                mode === key
                  ? "bg-neutral-200 text-neutral-900"
                  : "bg-neutral-900 text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <p className="text-[11px] text-neutral-500">
          {mode === "objects"
            ? "Whole pieces of furniture. Click one, then click the map to place it."
            : entry.structural
              ? "Walls, floors, doors and stairs. Click a tile, then paint."
              : "Single tiles. Click one, then paint."}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {mode === "tiles" ? (
          <canvas
            ref={tilesRef}
            aria-label="Tiles"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = Math.floor((e.clientX - rect.left) / CELL);
              const y = Math.floor((e.clientY - rect.top) / CELL);
              if (x < 0 || y < 0 || x >= entry.columns || y >= entry.rows)
                return;
              onSelectTile(entry.firstGid + y * entry.columns + x);
            }}
            className="cursor-crosshair"
          />
        ) : (
          <canvas
            ref={objectsRef}
            aria-label="Objects"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const px = e.clientX - rect.left;
              const py = e.clientY - rect.top;
              const hit = hits.current.find(
                (p) =>
                  px >= p.x - 3 &&
                  px <= p.x + p.w + 3 &&
                  py >= p.y - 3 &&
                  py <= p.y + p.h + 3,
              );
              if (hit) onSelectStamp(entry.key, hit.stamp);
            }}
            className="cursor-crosshair"
          />
        )}
      </div>
    </div>
  );
}
