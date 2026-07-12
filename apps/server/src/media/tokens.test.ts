import { describe, expect, it } from "vitest";
import { TokenVerifier } from "livekit-server-sdk";
import type { OfficeId, OrgId, UserId } from "@vo/shared";
import { mintOfficeToken, roomName } from "./tokens.js";
import { env } from "../env.js";
import type { Scope } from "../scope.js";

/**
 * Token tests.
 *
 * A LiveKit token is a signed JWT, so its grants can be verified offline with
 * the same secret that minted it — no LiveKit account required. What is being
 * checked is that a token never carries more authority than the caller has.
 */

const ORG_A = "11111111-1111-4111-8111-111111111111" as OrgId;
const ORG_B = "22222222-2222-4222-8222-222222222222" as OrgId;
const OFFICE = "33333333-3333-4333-8333-333333333333" as OfficeId;
const USER = "44444444-4444-4444-8444-444444444444" as UserId;

const scope: Scope = { orgId: ORG_A, userId: USER, role: "member" };

describe("room naming", () => {
  it("namespaces the room by organization", () => {
    expect(roomName(ORG_A, OFFICE)).toContain(ORG_A);
    expect(roomName(ORG_A, OFFICE)).toContain(OFFICE);
  });

  it("two organizations never share a room name", () => {
    // Even if an office id were somehow reused across tenants.
    expect(roomName(ORG_A, OFFICE)).not.toBe(roomName(ORG_B, OFFICE));
  });
});

describe("minting", () => {
  it("issues a token scoped to exactly one room", async () => {
    const creds = await mintOfficeToken(scope, OFFICE, "Ada");

    const verifier = new TokenVerifier(
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
    const claims = await verifier.verify(creds.token);

    expect(claims.sub).toBe(USER);
    expect(claims.video?.room).toBe(roomName(ORG_A, OFFICE));
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.canSubscribe).toBe(true);
  });

  it("does not let a client create, list or administer rooms", async () => {
    const creds = await mintOfficeToken(scope, OFFICE, "Ada");
    const verifier = new TokenVerifier(
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
    const claims = await verifier.verify(creds.token);

    expect(claims.video?.roomCreate).toBeFalsy();
    expect(claims.video?.roomList).toBeFalsy();
    expect(claims.video?.roomAdmin).toBeFalsy();
  });

  it("a token for one org does not grant the other org's room", async () => {
    const creds = await mintOfficeToken(scope, OFFICE, "Ada");
    const verifier = new TokenVerifier(
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
    const claims = await verifier.verify(creds.token);

    expect(claims.video?.room).not.toBe(roomName(ORG_B, OFFICE));
  });

  it("identity is the user id, not a display name", async () => {
    // Identity is how a participant maps back to a member. A display name is
    // user-supplied and not unique.
    const creds = await mintOfficeToken(scope, OFFICE, "Ada");
    expect(creds.identity).toBe(USER);
  });

  it("the token expires", async () => {
    const creds = await mintOfficeToken(scope, OFFICE, "Ada");
    const [, payload] = creds.token.split(".");
    const claims = JSON.parse(
      Buffer.from(payload!, "base64url").toString(),
    ) as { exp?: number };

    expect(claims.exp).toBeDefined();
    const secondsLeft = claims.exp! - Math.floor(Date.now() / 1000);
    expect(secondsLeft).toBeGreaterThan(0);
    // A long-lived media token is a long-lived credential.
    expect(secondsLeft).toBeLessThanOrEqual(15 * 60);
  });
});
