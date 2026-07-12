import { AccessToken } from "livekit-server-sdk";
import type { OfficeId, OrgId, UserId } from "@vo/shared";
import { env, livekitConfigured } from "../env.js";
import { ApiError } from "../http/errors.js";
import type { Scope } from "../scope.js";

/**
 * LiveKit access tokens.
 *
 * The API secret never leaves the server (CLAUDE.md §12). A token is minted
 * per join, short-lived, and its grants are derived from verified membership —
 * never from anything the caller sent.
 *
 * Everyone in an office shares one room. Proximity is expressed by which
 * tracks a client subscribes to, not by which room it is in, so walking across
 * the office never renegotiates a connection (decision: plan phase 09).
 */

/** Long enough to survive a slow page load, short enough to be worth stealing. */
const TTL = "10m";

export interface MediaCredentials {
  url: string;
  token: string;
  room: string;
  identity: string;
}

/**
 * Room name for an office.
 *
 * Namespaced by organization so two tenants can never collide on a room, even
 * if an office id were somehow reused.
 */
export function roomName(orgId: OrgId, officeId: OfficeId): string {
  return `org_${orgId}_office_${officeId}`;
}

export function mediaEnabled(): boolean {
  return livekitConfigured;
}

export async function mintOfficeToken(
  scope: Scope,
  officeId: OfficeId,
  displayName: string,
): Promise<MediaCredentials> {
  if (!mediaEnabled()) {
    throw new ApiError(
      "internal",
      "Voice and video are not configured on this server.",
    );
  }

  const room = roomName(scope.orgId, officeId);

  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    // Identity is the user id, so a participant is traceable to a member and
    // a second tab cannot masquerade as a different person.
    identity: scope.userId,
    name: displayName,
    ttl: TTL,
  });

  token.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    // Used for lightweight signalling between clients, e.g. a raised hand.
    canPublishData: true,
    // Clients must not be able to create or name rooms themselves.
    roomCreate: false,
    roomList: false,
    roomAdmin: false,
  });

  return {
    url: env.LIVEKIT_URL,
    token: await token.toJwt(),
    room,
    identity: scope.userId as UserId,
  };
}
