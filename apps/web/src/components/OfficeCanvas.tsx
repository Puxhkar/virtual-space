"use client";

import { useEffect, useRef, useState } from "react";
import type { AssetManifest } from "@vo/shared";
import type { ProximityDecision, Zone } from "@vo/shared";
import type { RealtimeClient } from "@/game/realtime";

interface Props {
  manifest: AssetManifest;
  mapData: unknown;
  realtime?: RealtimeClient | undefined;
  onPeersChange?: (count: number) => void;
  onProximity?: ((decision: ProximityDecision) => void) | undefined;
  onZone?: ((zone: Zone | null) => void) | undefined;
  /** Receives the live scene once it exists, so the shell can drive it. */
  onScene?: ((scene: OfficeSceneHandle | null) => void) | undefined;
}

/** The parts of the scene the UI drives. Deliberately narrow. */
export interface OfficeSceneHandle {
  setSpeaking(userIds: readonly string[]): void;
  audibleCount(): number;
}

/**
 * Mounts the Phaser game.
 *
 * Phaser is imported dynamically because it touches `window` at module scope
 * and would break server rendering.
 */
export function OfficeCanvas({
  manifest,
  mapData,
  realtime,
  onPeersChange,
  onProximity,
  onZone,
  onScene,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let destroyed = false;
    let game: Phaser.Game | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    void (async () => {
      try {
        const [{ default: Phaser }, { OfficeScene }] = await Promise.all([
          import("phaser"),
          import("@/game/OfficeScene"),
        ]);
        if (destroyed) return;

        const scene = new OfficeScene({
          manifest,
          mapData,
          variantIndex: 0,
          realtime,
          onProximity,
          onZone,
        });

        game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: container,
          width: container.clientWidth,
          height: container.clientHeight,
          backgroundColor: "#101314",
          pixelArt: true,
          roundPixels: true,
          scale: {
            mode: Phaser.Scale.RESIZE,
            autoCenter: Phaser.Scale.CENTER_BOTH,
          },
          physics: {
            default: "arcade",
            arcade: { gravity: { x: 0, y: 0 }, debug: false },
          },
          scene,
        });

        onScene?.({
          setSpeaking: (ids) => scene.setSpeaking(ids),
          audibleCount: () => scene.audibleCount(),
        });

        if (onPeersChange) {
          // Polled rather than pushed: the count changes on several unrelated
          // events, and one cheap read a second is simpler than threading a
          // callback through every one of them.
          poll = setInterval(() => {
            if (!destroyed) onPeersChange(scene.remotes?.count() ?? 0);
          }, 1000);
        }
      } catch (error) {
        if (destroyed) return;
        setFailure(
          error instanceof Error ? error.message : "Could not start the office",
        );
      }
    })();

    return () => {
      destroyed = true;
      if (poll) clearInterval(poll);
      onScene?.(null);
      game?.destroy(true);
    };
  }, [
    manifest,
    mapData,
    realtime,
    onPeersChange,
    onProximity,
    onZone,
    onScene,
  ]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {failure && (
        <div className="absolute inset-0 grid place-items-center p-6">
          <div className="max-w-md rounded-lg border border-red-900 bg-red-950/60 p-4">
            <p className="font-medium text-red-200">The office did not load</p>
            <p className="mt-1 text-sm text-red-300/80">{failure}</p>
          </div>
        </div>
      )}
    </div>
  );
}
