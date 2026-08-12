"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MapZoneInput } from "@vo/shared";
import { TILE, drawGid, preloadTilesets } from "@/lib/catalogue";
import { stampGidAt, stampKey, type Stamp } from "@/lib/objects";
import { ApiRequestError, api, getOffices, getOfficeMap } from "@/lib/api";
import { ensureActiveOrganization } from "@/lib/session";
import { TilePalette } from "./TilePalette";

/**
 * The office editor.
 *
 * A plain canvas rather than the game engine: an editor wants direct control
 * over drawing and hit-testing, and none of what Phaser provides — physics, a
 * camera, a frame loop — is useful here.
 *
 * Everything an admin changes is local until they publish, so a half-finished
 * layout is never what the team walks into.
 */

type Layer = "floor" | "walls" | "furniture";
type Tool = "paint" | "erase" | "zone" | "entrance";

const LAYERS: { key: Layer; label: string; hint: string }[] = [
  { key: "floor", label: "Floor", hint: "Walkable ground. Never blocks." },
  { key: "walls", label: "Walls", hint: "Blocks movement." },
  { key: "furniture", label: "Furniture", hint: "Blocks movement." },
];

const ZONE_KINDS: MapZoneInput["kind"][] = [
  "meeting",
  "booth",
  "desk",
  "quiet",
];

interface Loaded {
  officeId: string;
  width: number;
  height: number;
  layers: Record<Layer, number[]>;
  spawn: { x: number; y: number };
  zones: MapZoneInput[];
}

interface TiledLayer {
  name: string;
  type: string;
  data?: number[];
  objects?: {
    name?: string;
    type?: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    properties?: { name: string; value: unknown }[];
  }[];
}

export function OfficeEditor() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [layer, setLayer] = useState<Layer>("floor");
  const [tool, setTool] = useState<Tool>("paint");
  const [gid, setGid] = useState<number | null>(null);
  /**
   * The selected piece of furniture, if any.
   *
   * A stamp and a single tile are mutually exclusive: choosing one clears the
   * other, so what a click will place is never ambiguous.
   */
  const [stamp, setStamp] = useState<{ key: string; value: Stamp } | null>(
    null,
  );
  const [zoom, setZoom] = useState(1);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);

  /*
   * Read-only view of the layout, for browser tests.
   *
   * The editor is a canvas, so without this a test can only diff screenshots —
   * which proves that something changed, not that a 3x2 sofa wrote six cells
   * rather than one. Mirrors the game's `window.__office` hook.
   */
  useEffect(() => {
    Object.defineProperty(window, "__editor", {
      configurable: true,
      get: () =>
        loaded && {
          width: loaded.width,
          height: loaded.height,
          layers: loaded.layers,
          zones: loaded.zones.length,
          stamp: stamp && { w: stamp.value.w, h: stamp.value.h },
        },
    });
  }, [loaded, stamp]);

  /* ---- load the current office ---- */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!(await ensureActiveOrganization())) {
          setError("You are not a member of any workspace yet.");
          return;
        }

        await preloadTilesets();
        const { offices } = await getOffices();
        const office = offices[0];
        if (!office) {
          setError("This workspace has no office yet.");
          return;
        }

        const { map } = await getOfficeMap(office.id);
        if (cancelled) return;

        const data = map.data as {
          width: number;
          height: number;
          layers: TiledLayer[];
        };
        const tileLayer = (name: string) =>
          data.layers.find((l) => l.name === name)?.data ??
          new Array<number>(data.width * data.height).fill(0);

        const objects =
          data.layers.find((l) => l.type === "objectgroup")?.objects ?? [];
        const spawnObj = objects.find((o) => o.type === "spawn");

        setLoaded({
          officeId: office.id,
          width: data.width,
          height: data.height,
          layers: {
            floor: [...tileLayer("floor")],
            walls: [...tileLayer("walls")],
            furniture: [...tileLayer("furniture")],
          },
          spawn: {
            x: Math.floor((spawnObj?.x ?? 0) / TILE),
            y: Math.floor((spawnObj?.y ?? 0) / TILE),
          },
          zones: objects
            .filter((o) => o.type === "zone")
            .map((o) => ({
              name: o.name ?? "Room",
              kind: String(
                o.properties?.find((p) => p.name === "kind")?.value ??
                  "meeting",
              ) as MapZoneInput["kind"],
              x: Math.floor(o.x / TILE),
              y: Math.floor(o.y / TILE),
              width: Math.max(1, Math.floor((o.width ?? TILE) / TILE)),
              height: Math.max(1, Math.floor((o.height ?? TILE) / TILE)),
              capacity:
                Number(
                  o.properties?.find((p) => p.name === "capacity")?.value ?? 0,
                ) || null,
            })),
        });
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof ApiRequestError
              ? cause.message
              : "Could not load the office.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- draw ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !loaded) return;

    const size = Math.round(TILE * zoom);
    canvas.width = loaded.width * size;
    canvas.height = loaded.height * size;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#14181a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const name of ["floor", "walls", "furniture"] as const) {
      const data = loaded.layers[name];
      // The layer being edited stays solid; the others dim, so it is obvious
      // which one a click will change.
      ctx.globalAlpha = name === layer ? 1 : 0.45;
      for (let i = 0; i < data.length; i++) {
        const value = data[i]!;
        if (value === 0) continue;
        drawGid(
          ctx,
          value,
          (i % loaded.width) * size,
          Math.floor(i / loaded.width) * size,
          size,
        );
      }
    }
    ctx.globalAlpha = 1;

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= loaded.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * size + 0.5, 0);
      ctx.lineTo(x * size + 0.5, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= loaded.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * size + 0.5);
      ctx.lineTo(canvas.width, y * size + 0.5);
      ctx.stroke();
    }

    // Zones
    for (const zone of loaded.zones) {
      ctx.fillStyle = "rgba(94,195,201,0.16)";
      ctx.strokeStyle = "rgba(94,195,201,0.85)";
      ctx.lineWidth = 2;
      ctx.fillRect(
        zone.x * size,
        zone.y * size,
        zone.width * size,
        zone.height * size,
      );
      ctx.strokeRect(
        zone.x * size,
        zone.y * size,
        zone.width * size,
        zone.height * size,
      );
      ctx.fillStyle = "#bff0f3";
      ctx.font = "11px ui-sans-serif, system-ui";
      ctx.fillText(zone.name, zone.x * size + 4, zone.y * size + 14);
    }

    // Entrance
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      loaded.spawn.x * size + 2,
      loaded.spawn.y * size + 2,
      size - 4,
      size - 4,
    );
    ctx.fillStyle = "#4ade80";
    ctx.font = "10px ui-sans-serif, system-ui";
    ctx.fillText(
      "in",
      loaded.spawn.x * size + 6,
      loaded.spawn.y * size + size - 6,
    );

    /*
     * Ghost of the object under the pointer.
     *
     * Furniture blocks movement, and a 3x2 sofa dropped a tile off is how a
     * walkway gets sealed. Showing the exact footprint before the click is
     * cheaper than discovering it at publish time.
     */
    if (tool === "paint" && stamp && hover) {
      ctx.globalAlpha = 0.55;
      for (let dy = 0; dy < stamp.value.h; dy++) {
        for (let dx = 0; dx < stamp.value.w; dx++) {
          const g = stampGidAt(stamp.value, dx, dy);
          if (g > 0)
            drawGid(ctx, g, (hover.x + dx) * size, (hover.y + dy) * size, size);
        }
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        hover.x * size,
        hover.y * size,
        stamp.value.w * size,
        stamp.value.h * size,
      );
    }

    // Pending zone rectangle
    if (tool === "zone" && dragStart && hover) {
      const x = Math.min(dragStart.x, hover.x);
      const y = Math.min(dragStart.y, hover.y);
      const w = Math.abs(hover.x - dragStart.x) + 1;
      const h = Math.abs(hover.y - dragStart.y) + 1;
      ctx.strokeStyle = "#fbbf24";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x * size, y * size, w * size, h * size);
      ctx.setLineDash([]);
    }
  }, [loaded, layer, zoom, tool, dragStart, hover, stamp]);

  /* ---- editing ---- */
  const cellAt = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!loaded) return null;
      const rect = e.currentTarget.getBoundingClientRect();
      const size = Math.round(TILE * zoom);
      const x = Math.floor((e.clientX - rect.left) / size);
      const y = Math.floor((e.clientY - rect.top) / size);
      if (x < 0 || y < 0 || x >= loaded.width || y >= loaded.height)
        return null;
      return { x, y };
    },
    [loaded, zoom],
  );

  const paint = useCallback(
    (x: number, y: number) => {
      setLoaded((current) => {
        if (!current) return current;
        const next = [...current.layers[layer]];

        const write = (cx: number, cy: number, value: number) => {
          // Silently clip at the edges rather than wrapping onto the next row,
          // which is what a raw index would do.
          if (cx < 0 || cy < 0 || cx >= current.width || cy >= current.height)
            return;
          next[cy * current.width + cx] = value;
        };

        if (tool === "erase") {
          write(x, y, 0);
        } else if (tool === "paint" && stamp) {
          /*
           * Anchored at the pointer's top-left, so what the preview outlines
           * is what lands. Cells the object does not cover are left alone —
           * an L-shaped desk must not blank the floor inside its corner.
           */
          for (let dy = 0; dy < stamp.value.h; dy++) {
            for (let dx = 0; dx < stamp.value.w; dx++) {
              const g = stampGidAt(stamp.value, dx, dy);
              if (g > 0) write(x + dx, y + dy, g);
            }
          }
        } else if (tool === "paint" && gid !== null) {
          write(x, y, gid);
        } else {
          return current;
        }

        return { ...current, layers: { ...current.layers, [layer]: next } };
      });
      setStatus(null);
    },
    [layer, tool, gid, stamp],
  );

  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cell = cellAt(e);
    if (!cell || !loaded) return;

    if (tool === "entrance") {
      setLoaded({ ...loaded, spawn: cell });
      return;
    }
    if (tool === "zone") {
      setDragStart(cell);
      return;
    }
    painting.current = true;
    paint(cell.x, cell.y);
  };

  const onUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    painting.current = false;
    const cell = cellAt(e);

    if (tool === "zone" && dragStart && cell && loaded) {
      const name = window.prompt("Name this room", "Meeting room")?.trim();
      setDragStart(null);
      if (!name) return;

      setLoaded({
        ...loaded,
        zones: [
          ...loaded.zones,
          {
            name,
            kind: "meeting",
            x: Math.min(dragStart.x, cell.x),
            y: Math.min(dragStart.y, cell.y),
            width: Math.abs(cell.x - dragStart.x) + 1,
            height: Math.abs(cell.y - dragStart.y) + 1,
            capacity: null,
          },
        ],
      });
    }
  };

  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    setError(null);
    setStatus(null);

    try {
      const result = await api<{ version: number }>(
        `/api/offices/${loaded.officeId}/map`,
        {
          method: "PUT",
          body: JSON.stringify({
            width: loaded.width,
            height: loaded.height,
            floor: loaded.layers.floor,
            walls: loaded.layers.walls,
            furniture: loaded.layers.furniture,
            spawn: loaded.spawn,
            zones: loaded.zones,
          }),
        },
      );
      setStatus(
        `Published version ${result.version}. Everyone will see it when they next open the office.`,
      );
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError ? cause.message : "Could not publish.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (error && !loaded) {
    return (
      <div className="grid h-dvh place-items-center p-6">
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="grid h-dvh place-items-center">
        <p className="text-sm text-neutral-500">Loading the office…</p>
      </div>
    );
  }

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-800 px-4 py-2">
        <h1 className="text-sm font-medium tracking-tight">Office layout</h1>

        <div className="flex items-center gap-1">
          {LAYERS.map((l) => (
            <button
              key={l.key}
              type="button"
              title={l.hint}
              aria-pressed={layer === l.key}
              onClick={() => setLayer(l.key)}
              className={`rounded-md border px-2 py-1 text-xs ${
                layer === l.key
                  ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                  : "border-neutral-800 text-neutral-400"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {(
            [
              ["paint", "Paint"],
              ["erase", "Erase"],
              ["zone", "Draw room"],
              ["entrance", "Set entrance"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tool === key}
              onClick={() => setTool(key)}
              className={`rounded-md border px-2 py-1 text-xs ${
                tool === key
                  ? "border-emerald-700 bg-emerald-950/60 text-emerald-200"
                  : "border-neutral-800 text-neutral-400"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          Zoom
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.25}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-24"
          />
        </label>

        <div className="ml-auto flex items-center gap-3">
          <a href="/" className="text-xs text-neutral-400 hover:underline">
            Back to office
          </a>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 disabled:opacity-60"
          >
            {saving ? "Publishing…" : "Publish"}
          </button>
        </div>
      </header>

      {(error || status) && (
        <div
          role="alert"
          className={`border-b px-4 py-2 text-sm ${
            error
              ? "border-red-900 bg-red-950/60 text-red-200"
              : "border-emerald-900 bg-emerald-950/50 text-emerald-200"
          }`}
        >
          {error ?? status}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <TilePalette
          selectedGid={gid}
          onSelectTile={(next) => {
            setGid(next);
            setStamp(null);
          }}
          selectedStamp={stamp?.key ?? null}
          onSelectStamp={(sheet, value) => {
            setStamp({ key: stampKey(sheet, value), value });
            setGid(null);
          }}
        />

        <div className="min-h-0 flex-1 overflow-auto bg-neutral-950 p-4">
          <canvas
            ref={canvasRef}
            onMouseDown={onDown}
            onMouseUp={onUp}
            onMouseLeave={() => {
              painting.current = false;
              setHover(null);
            }}
            onMouseMove={(e) => {
              const cell = cellAt(e);
              setHover(cell);
              // Dragging paints tiles continuously, but stamps place once per
              // click — dragging a sofa would otherwise smear a copy of it
              // across every cell the pointer crossed.
              if (painting.current && cell && !stamp) paint(cell.x, cell.y);
            }}
            className="cursor-crosshair"
          />
        </div>

        <aside className="w-60 shrink-0 space-y-3 overflow-auto border-l border-neutral-800 p-3">
          <div>
            <h2 className="text-xs font-medium text-neutral-300">Rooms</h2>
            <p className="mt-1 text-[11px] text-neutral-500">
              People inside a room hear each other, and nobody outside it.
            </p>
          </div>

          {loaded.zones.length === 0 && (
            <p className="text-[11px] text-neutral-600">
              None yet. Choose “Draw room” and drag a rectangle.
            </p>
          )}

          <ul className="space-y-2">
            {loaded.zones.map((zone, i) => (
              <li
                key={`${zone.name}-${i}`}
                className="rounded-md border border-neutral-800 p-2"
              >
                <input
                  value={zone.name}
                  aria-label="Room name"
                  onChange={(e) =>
                    setLoaded({
                      ...loaded,
                      zones: loaded.zones.map((z, j) =>
                        j === i ? { ...z, name: e.target.value } : z,
                      ),
                    })
                  }
                  className="w-full bg-transparent text-xs outline-none"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <select
                    value={zone.kind}
                    aria-label="Room type"
                    onChange={(e) =>
                      setLoaded({
                        ...loaded,
                        zones: loaded.zones.map((z, j) =>
                          j === i
                            ? {
                                ...z,
                                kind: e.target.value as MapZoneInput["kind"],
                              }
                            : z,
                        ),
                      })
                    }
                    className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-[11px]"
                  >
                    {ZONE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() =>
                      setLoaded({
                        ...loaded,
                        zones: loaded.zones.filter((_, j) => j !== i),
                      })
                    }
                    className="text-[11px] text-neutral-500 hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-neutral-600">
                  {zone.width}×{zone.height} tiles
                </p>
              </li>
            ))}
          </ul>

          <div className="border-t border-neutral-800 pt-3 text-[11px] text-neutral-500">
            <p>
              Entrance at ({loaded.spawn.x}, {loaded.spawn.y}). Office is{" "}
              {loaded.width}×{loaded.height} tiles.
            </p>
            <p className="mt-2">
              Publishing checks that every room can still be walked to. If a
              plant blocks a doorway you will be told which room, rather than
              finding out at standup.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
