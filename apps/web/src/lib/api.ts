import { API_URL } from "./env";

/**
 * Typed fetch against the API.
 *
 * Always sends credentials, because the session is a cookie on a different
 * origin in development. Errors come back in the API's one error shape, so
 * callers get a message that is safe to show a user.
 */

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch {
    // A network failure is not a server error, and saying "500" would be a lie.
    throw new ApiRequestError(
      "offline",
      "Could not reach the server. Check your connection.",
      0,
    );
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiRequestError(
      body?.error?.code ?? "internal",
      body?.error?.message ?? "Something went wrong.",
      res.status,
    );
  }

  return res.json() as Promise<T>;
}

export interface Me {
  user: { id: string; name: string; email: string; image: string | null };
  activeOrgId: string | null;
  organizations: { orgId: string; name: string; slug: string; role: string }[];
}

export interface OfficeSummary {
  id: string;
  name: string;
  mapId: string;
  mapVersion: number;
}

export interface OfficeMapResponse {
  map: {
    mapId: string;
    name: string;
    version: number;
    tileSize: number;
    data: unknown;
  };
}

export const getMe = () => api<Me>("/api/me");
export const getOffices = () =>
  api<{ offices: OfficeSummary[] }>("/api/offices");
export const getOfficeMap = (officeId: string) =>
  api<OfficeMapResponse>(`/api/offices/${officeId}/map`);

export interface MediaCredentialsResponse {
  url: string;
  token: string;
  room: string;
  identity: string;
}

export const getMediaStatus = (officeId: string) =>
  api<{ enabled: boolean }>(`/api/offices/${officeId}/media-status`);

export const getMediaToken = (officeId: string) =>
  api<MediaCredentialsResponse>(`/api/offices/${officeId}/token`, {
    method: "POST",
  });

import type { Channel, ChatMessage } from "@vo/shared";

export const getChannels = () => api<{ channels: Channel[] }>("/api/channels");

export const getMessages = (channelId: string, before?: string) =>
  api<{ messages: ChatMessage[]; nextBefore: string | null }>(
    `/api/channels/${channelId}/messages` +
      (before ? `?before=${encodeURIComponent(before)}` : ""),
  );
