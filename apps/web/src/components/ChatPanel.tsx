"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MESSAGE_MAX_LENGTH, type Channel, type ChatMessage } from "@vo/shared";
import { getChannels, getMessages } from "@/lib/api";
import type { RealtimeClient } from "@/game/realtime";

/**
 * Chat.
 *
 * History is fetched over REST and new messages arrive on the socket, which is
 * the same split as everywhere else: the past is a request, the present is an
 * event (CLAUDE.md §15).
 *
 * The panel is collapsible because the office is the product and chat is
 * beside it, not on top of it.
 */

interface Props {
  realtime: RealtimeClient;
  selfUserId: string;
}

export function ChatPanel({ realtime, selfUserId }: Props) {
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<Channel | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = active?.id ?? null;

  /* ---- load the channel list once ---- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { channels: found } = await getChannels();
        if (cancelled) return;
        setChannels(found);
        setActive((current) => current ?? found[0] ?? null);
      } catch {
        if (!cancelled) setError("Could not load channels.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- load history when the channel changes ---- */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const { messages } = await getMessages(active.id);
        if (cancelled) return;
        // The API returns newest first; render oldest first.
        setHistory([...messages].reverse());
        setError(null);
      } catch {
        if (!cancelled) setError("Could not load messages.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active]);

  /* ---- live messages ---- */
  useEffect(() => {
    realtime.attach({
      onMessage: (message) => {
        // Only append to the channel being viewed; everything else becomes an
        // unread badge rather than a surprise scroll.
        if (message.channelId === activeIdRef.current) {
          setHistory((current) =>
            current.some((m) => m.id === message.id)
              ? current
              : [...current, message],
          );
        } else {
          setChannels((current) =>
            current.map((c) =>
              c.id === message.channelId ? { ...c, unread: c.unread + 1 } : c,
            ),
          );
        }
      },
    });
  }, [realtime]);

  /* ---- keep the newest message in view ---- */
  useEffect(() => {
    const list = listRef.current;
    if (!list || !open) return;
    list.scrollTop = list.scrollHeight;
  }, [history, open]);

  /* ---- reading clears the badge ---- */
  useEffect(() => {
    if (!open || !active) return;
    realtime.markRead(active.id);
    setChannels((current) =>
      current.map((c) => (c.id === active.id ? { ...c, unread: 0 } : c)),
    );
  }, [open, active, history.length, realtime]);

  const send = useCallback(() => {
    const body = draft.trim();
    if (!body || !active) return;
    realtime.sendMessage(active.id, body);
    setDraft("");
  }, [draft, active, realtime]);

  const unreadTotal = channels.reduce((sum, c) => sum + c.unread, 0);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute bottom-4 right-4 flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900/90 px-3 py-2 text-xs text-neutral-300 shadow-lg backdrop-blur"
      >
        Chat
        {unreadTotal > 0 && (
          <span className="rounded-full bg-emerald-500 px-1.5 text-[10px] font-medium text-neutral-950">
            {unreadTotal}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="absolute bottom-0 right-0 top-0 flex w-80 flex-col border-l border-neutral-800 bg-neutral-950/95 backdrop-blur">
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <select
          value={active?.id ?? ""}
          onChange={(e) =>
            setActive(channels.find((c) => c.id === e.target.value) ?? null)
          }
          aria-label="Channel"
          className="bg-transparent text-sm font-medium outline-none"
        >
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              #{channel.name ?? "direct"}
              {channel.unread > 0 ? ` (${channel.unread})` : ""}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close chat"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Close
        </button>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {loading && <p className="text-xs text-neutral-500">Loading…</p>}

        {!loading && history.length === 0 && !error && (
          <p className="text-xs text-neutral-500">
            Nothing here yet. Say something.
          </p>
        )}

        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}

        <ol className="space-y-2">
          {history.map((message) => (
            <li key={message.id} className="text-sm">
              <span
                className={
                  message.authorId === selfUserId
                    ? "text-emerald-300"
                    : "text-neutral-400"
                }
              >
                {message.authorName}
              </span>{" "}
              <span className="text-[10px] text-neutral-600">
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <p className="whitespace-pre-wrap break-words text-neutral-200">
                {message.deletedAt ? (
                  <em className="text-neutral-600">Message deleted</em>
                ) : (
                  message.body
                )}
              </p>
            </li>
          ))}
        </ol>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-neutral-800 p-2"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, shift+enter is a newline — the convention people
            // already have in their fingers.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
            // The canvas listens for arrow keys; typing must not walk.
            e.stopPropagation();
          }}
          rows={2}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder="Message"
          aria-label="Message"
          className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm outline-none focus-visible:border-neutral-500"
        />
      </form>
    </aside>
  );
}
