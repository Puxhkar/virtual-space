"use client";

import { useEffect, useRef } from "react";
import type { RemoteTrack } from "livekit-client";
import type { VideoFeed } from "@/media/MediaClient";

/**
 * Video for the people near you.
 *
 * Which feeds arrive here is decided entirely by proximity — this component
 * renders whatever it is given and never subscribes to anything itself. That
 * keeps the rule "who can I see" in one tested place rather than split between
 * the engine and the view.
 *
 * A screen share takes the large slot, because someone sharing is almost
 * always the thing you are meant to be looking at.
 */

interface Props {
  feeds: VideoFeed[];
  speaking: ReadonlySet<string>;
}

export function VideoTiles({ feeds, speaking }: Props) {
  if (feeds.length === 0) return null;

  const share = feeds.find((f) => f.source === "screen");
  const cameras = feeds.filter((f) => f.source === "camera");

  return (
    <div className="pointer-events-none absolute left-3 top-3 flex max-w-[min(52%,640px)] flex-col gap-2">
      {share && (
        <Tile
          feed={share}
          speaking={speaking.has(share.userId)}
          className="aspect-video w-full"
          label={`${share.name} is sharing`}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {cameras.map((feed) => (
          <Tile
            key={`${feed.userId}:${feed.source}`}
            feed={feed}
            speaking={speaking.has(feed.userId)}
            className="h-24 w-32"
            label={feed.name}
          />
        ))}
      </div>
    </div>
  );
}

function Tile({
  feed,
  speaking,
  className,
  label,
}: {
  feed: VideoFeed;
  speaking: boolean;
  className: string;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const track = feed.track as RemoteTrack;
    track.attach(element);

    // Detaching matters: an orphaned attachment keeps decoding video for
    // someone who has walked away.
    return () => {
      track.detach(element);
    };
  }, [feed.track]);

  return (
    <figure
      className={`relative overflow-hidden rounded-lg border bg-neutral-950 shadow-lg transition-colors ${className} ${
        speaking ? "border-emerald-400" : "border-neutral-700"
      }`}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        // Remote audio is played by the proximity layer at a distance-based
        // volume; letting the video element play it too would double it.
        muted
        className="h-full w-full object-cover"
      />
      <figcaption className="absolute bottom-0 left-0 right-0 truncate bg-neutral-950/70 px-1.5 py-0.5 text-[10px] text-neutral-300">
        {label}
      </figcaption>
    </figure>
  );
}
