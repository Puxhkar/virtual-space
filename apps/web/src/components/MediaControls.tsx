"use client";

import { useCallback, useEffect, useState } from "react";
import { MediaClient, type MediaState } from "@/media/MediaClient";

/**
 * Microphone, camera and screen share.
 *
 * Every control shows its current state rather than only its action, because
 * "am I muted right now" is the question people actually have (CLAUDE.md §20).
 * When the server has no media credentials the whole strip is replaced with an
 * explanation instead of buttons that would fail on click.
 */

interface Props {
  media: MediaClient | null;
  state: MediaState;
  unavailableReason?: string | undefined;
}

export function MediaControls({ media, state, unavailableReason }: Props) {
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<{
    microphones: MediaDeviceInfo[];
    cameras: MediaDeviceInfo[];
  }>({ microphones: [], cameras: [] });

  /*
   * Device labels are only populated after permission has been granted, so
   * the list is refreshed once the microphone is on rather than at mount —
   * before that every entry reads "Microphone 1".
   */
  const refreshDevices = useCallback(async () => {
    setDevices(await MediaClient.listDevices());
  }, []);

  useEffect(() => {
    if (mic || camera) void refreshDevices();
  }, [mic, camera, refreshDevices]);

  if (unavailableReason) {
    return (
      <span className="text-xs text-neutral-500">{unavailableReason}</span>
    );
  }

  const ready = media !== null && state === "connected";

  async function toggle(
    kind: "mic" | "camera" | "screen",
    next: boolean,
  ): Promise<void> {
    if (!media) return;
    setBusy(true);
    try {
      if (kind === "mic") {
        await media.setMicrophoneEnabled(next);
        setMic(media.isMicrophoneEnabled);
      } else if (kind === "camera") {
        await media.setCameraEnabled(next);
        setCamera(media.isCameraEnabled);
      } else {
        await media.setScreenShareEnabled(next);
        setScreen(next);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Toggle
        label={mic ? "Mute" : "Unmute"}
        active={mic}
        disabled={!ready || busy}
        onClick={() => void toggle("mic", !mic)}
      >
        {mic ? "Mic on" : "Mic off"}
      </Toggle>

      <Toggle
        label={camera ? "Turn camera off" : "Turn camera on"}
        active={camera}
        disabled={!ready || busy}
        onClick={() => void toggle("camera", !camera)}
      >
        {camera ? "Camera on" : "Camera off"}
      </Toggle>

      <Toggle
        label={screen ? "Stop sharing" : "Share screen"}
        active={screen}
        disabled={!ready || busy}
        onClick={() => void toggle("screen", !screen)}
      >
        {screen ? "Sharing" : "Share"}
      </Toggle>

      {devices.microphones.length > 1 && (
        <DevicePicker
          label="Microphone"
          devices={devices.microphones}
          disabled={!ready || busy}
          onSelect={(id) => void media?.selectMicrophone(id)}
        />
      )}

      {devices.cameras.length > 1 && (
        <DevicePicker
          label="Camera"
          devices={devices.cameras}
          disabled={!ready || busy}
          onSelect={(id) => void media?.selectCamera(id)}
        />
      )}
    </div>
  );
}

/**
 * Shown only when there is a choice to make.
 *
 * One microphone is not a decision, and a dropdown with a single entry is
 * noise that trains people to ignore the controls.
 */
function DevicePicker({
  label,
  devices,
  disabled,
  onSelect,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  disabled: boolean;
  onSelect: (deviceId: string) => void;
}) {
  return (
    <select
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onSelect(e.target.value)}
      className="max-w-32 truncate rounded-md border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-400 disabled:opacity-40"
    >
      {devices.map((device) => (
        <option key={device.deviceId} value={device.deviceId}>
          {device.label || label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
        active
          ? "border-emerald-700 bg-emerald-950/60 text-emerald-200"
          : "border-neutral-700 bg-neutral-900 text-neutral-400"
      }`}
    >
      {children}
    </button>
  );
}
