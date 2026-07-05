"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetManifest, ProximityDecision, Zone } from "@vo/shared";
import { authClient, useSession } from "@/lib/auth-client";
import {
  ApiRequestError,
  getMediaStatus,
  getMediaToken,
  getOffices,
  getOfficeMap,
} from "@/lib/api";
import { loadManifest } from "@/game/manifest";
import { ensureActiveOrganization } from "@/lib/session";
import { RealtimeClient, type ConnectionStatus } from "@/game/realtime";
import {
  MediaClient,
  type MediaState,
  type VideoFeed,
} from "@/media/MediaClient";
import { ChatPanel } from "./ChatPanel";
import { MediaControls } from "./MediaControls";
import { VideoTiles } from "./VideoTiles";
import { OfficeCanvas, type OfficeSceneHandle } from "./OfficeCanvas";
import { SignIn } from "./SignIn";

/**
 * Everything between "signed in" and "standing in the office".
 *
 * Each step can fail differently and each failure needs a different response
 * from the user, so they are separate states rather than one boolean
 * (CLAUDE.md §21).
 */

interface Loaded {
  manifest: AssetManifest;
  mapData: unknown;
  officeName: string;
  realtime: RealtimeClient;
  media: MediaClient | null;
  /** Set when the server has no LiveKit credentials. */
  mediaUnavailable: string | undefined;
}

export function OfficeShell() {
  const { data: session, isPending, refetch } = useSession();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState(0);
  const [mediaState, setMediaState] = useState<MediaState>("idle");
  const [zone, setZone] = useState<Zone | null>(null);
  const [feeds, setFeeds] = useState<VideoFeed[]>([]);
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set());
  const [audible, setAudible] = useState(0);
  const sceneRef = useRef<OfficeSceneHandle | null>(null);

  /**
   * Loads the office and opens the socket.
   *
   * One effect owns the whole lifecycle, including teardown. Splitting the
   * connect and the cleanup across two effects meant React StrictMode's
   * double-mount disconnected the socket on the simulated unmount while
   * `loaded` survived, so nothing ever reconnected — the status badge sat on
   * "Disconnected" while the office looked fine.
   */
  useEffect(() => {
    if (!session) return;

    let cancelled = false;
    let client: RealtimeClient | undefined;
    let media: MediaClient | undefined;

    void (async () => {
      try {
        if (!(await ensureActiveOrganization())) {
          if (!cancelled)
            setError("You are not a member of any workspace yet.");
          return;
        }
        if (cancelled) return;

        const { offices } = await getOffices();
        if (cancelled) return;

        const office = offices[0];
        if (!office) {
          setError("This workspace has no office yet.");
          return;
        }

        const [{ map }, manifest] = await Promise.all([
          getOfficeMap(office.id),
          loadManifest(),
        ]);
        if (cancelled) return;

        client = new RealtimeClient(office.id);
        client.attach({
          onStatusChange: setStatus,
          onError: (e) => setError(e.message),
        });
        client.connect();

        /*
         * Media is optional. Without LiveKit credentials the office still
         * works and the controls explain why they are absent, rather than
         * failing when someone clicks them (CLAUDE.md §21).
         */
        let mediaUnavailable: string | undefined;
        const { enabled } = await getMediaStatus(office.id).catch(() => ({
          enabled: false,
        }));

        if (!enabled) {
          mediaUnavailable = "Voice and video are not configured";
        } else {
          media = new MediaClient();
          media.attach({
            onStateChange: setMediaState,
            onDeviceError: setError,
            // Pushed straight into the scene rather than through React state:
            // speakers change several times a second and re-rendering the
            // whole shell for a ring on a sprite would be wasteful.
            onSpeakingChange: (ids) => {
              sceneRef.current?.setSpeaking(ids);
              setSpeaking(new Set(ids));
            },
            onVideoChange: setFeeds,
          });
          try {
            const credentials = await getMediaToken(office.id);
            if (!cancelled) await media.connect(credentials);
          } catch {
            mediaUnavailable = "Voice and video could not connect";
            media = undefined;
          }
        }
        if (cancelled) return;

        // Published for end-to-end tests; see MediaClient.inspect().
        const connectedMedia = media;
        (window as unknown as { __media?: unknown }).__media = connectedMedia
          ? () => connectedMedia.inspect()
          : undefined;

        setError(null);
        setLoaded({
          manifest,
          mapData: map.data,
          officeName: office.name,
          realtime: client,
          media: media ?? null,
          mediaUnavailable,
        });
      } catch (cause) {
        if (cancelled) return;
        setError(
          cause instanceof ApiRequestError
            ? cause.message
            : "Could not load the office.",
        );
      }
    })();

    return () => {
      cancelled = true;
      client?.disconnect();
      void media?.disconnect();
      setLoaded(null);
      setPeers(0);
      setZone(null);
      setFeeds([]);
      setSpeaking(new Set());
      setMediaState("idle");
    };
  }, [session]);

  /*
   * Stable across renders. An inline arrow here would be a new function every
   * render, and it is a dependency of the canvas effect — which would destroy
   * and rebuild the whole Phaser game on each render.
   */
  const media = loaded?.media ?? null;

  // Polled once a second: it changes as people walk, and a callback per
  // proximity tick would re-render the shell eight times a second.
  useEffect(() => {
    const timer = setInterval(
      () => setAudible(sceneRef.current?.audibleCount() ?? 0),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  const handleScene = useCallback((scene: OfficeSceneHandle | null) => {
    sceneRef.current = scene;
  }, []);

  const handleProximity = useCallback(
    (decision: ProximityDecision) => media?.applyDecision(decision),
    [media],
  );

  if (isPending) {
    return (
      <div className="grid h-dvh place-items-center">
        <p className="text-sm text-neutral-500">Checking your session…</p>
      </div>
    );
  }

  if (!session) return <SignIn onSignedIn={() => void refetch()} />;

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-neutral-800 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-medium tracking-tight">
            {loaded?.officeName ?? "Virtual Office"}
          </h1>
          <span className="text-xs text-neutral-500">
            {zone
              ? `In ${zone.name}`
              : peers === 0
                ? "You are the only one here"
                : `${peers} ${peers === 1 ? "other person" : "others"} here`}
          </span>

          {/* Who can hear you is the question people are least sure about. */}
          {audible > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-950/60 px-2 py-0.5 text-xs text-emerald-300">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"
              />
              {audible === 1
                ? "1 person can hear you"
                : `${audible} people can hear you`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <MediaControls
            media={media}
            state={mediaState}
            unavailableReason={loaded?.mediaUnavailable}
          />
          <ConnectionBadge status={status} />
          <a
            href="/admin"
            className="text-xs text-neutral-400 underline-offset-2 hover:underline"
          >
            Edit office
          </a>
          <button
            onClick={() => void authClient.signOut().then(() => refetch())}
            className="text-xs text-neutral-400 underline-offset-2 hover:underline"
          >
            Sign out
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="border-b border-red-900 bg-red-950/60 px-4 py-2 text-sm text-red-200"
        >
          {error}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {loaded ? (
          <OfficeCanvas
            manifest={loaded.manifest}
            mapData={loaded.mapData}
            realtime={loaded.realtime}
            onPeersChange={setPeers}
            onProximity={handleProximity}
            onZone={setZone}
            onScene={handleScene}
          />
        ) : (
          !error && (
            <div className="grid h-full place-items-center">
              <p className="text-sm text-neutral-500">Loading the office…</p>
            </div>
          )
        )}

        {loaded && <VideoTiles feeds={feeds} speaking={speaking} />}

        {/*
          Attribution is required by the art licence (CC-BY), so it is
          rendered from the manifest rather than written by hand — a pack
          swap cannot leave a stale or missing credit behind.
        */}
        {loaded && (
          <p className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-neutral-500/70">
            {loaded.manifest.credits.join(" · ")}
          </p>
        )}

        {loaded && session?.user?.id && (
          <ChatPanel realtime={loaded.realtime} selfUserId={session.user.id} />
        )}
      </div>
    </main>
  );
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  failed: "Connection lost",
};

const STATUS_DOT: Record<ConnectionStatus, string> = {
  connecting: "bg-amber-400",
  connected: "bg-emerald-400",
  reconnecting: "bg-amber-400 animate-pulse motion-reduce:animate-none",
  disconnected: "bg-neutral-500",
  failed: "bg-red-400",
};

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-400">
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}
