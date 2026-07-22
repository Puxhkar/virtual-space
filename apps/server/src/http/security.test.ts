import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { resetRateLimits } from "./rateLimit.js";

/**
 * Security behaviour that is easy to lose in a refactor.
 *
 * Headers and rate limits are the kind of thing that gets dropped when
 * middleware is reordered, and nothing else fails when they do (CLAUDE.md §22).
 */

const app = createApp();
const call = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

beforeEach(() => {
  resetRateLimits();
});

describe("response headers", () => {
  it("refuses to be framed or sniffed", async () => {
    const res = await call("/healthz");

    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("denies powerful browser features on the API origin", async () => {
    const res = await call("/healthz");
    const policy = res.headers.get("permissions-policy") ?? "";

    // The API has no use for a camera. The frontend origin sets its own.
    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
  });

  it("does not send HSTS in development", async () => {
    // Pinning localhost to https for two years would be a bad afternoon.
    const res = await call("/healthz");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("stamps a request id that can be correlated with logs", async () => {
    const res = await call("/healthz");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("honours a caller-supplied request id", async () => {
    const res = await call("/healthz", {
      headers: { "x-request-id": "trace-me" },
    });
    expect(res.headers.get("x-request-id")).toBe("trace-me");
  });
});

describe("metrics endpoint", () => {
  it("serves a snapshot without a session", async () => {
    // A monitor should not need to sign in, and in production this port is
    // not exposed publicly.
    const res = await call("/metrics");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      counters: Record<string, number>;
      uptimeSeconds: number;
    };
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.counters["http.requests.total"]).toBeGreaterThan(0);
  });

  it("is never cached", async () => {
    const res = await call("/metrics");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("counts errors by kind", async () => {
    await call("/api/me"); // unauthenticated
    const res = await call("/metrics");
    const body = (await res.json()) as { counters: Record<string, number> };

    expect(body.counters["http.errors.unauthenticated"]).toBeGreaterThan(0);
    expect(body.counters["http.status.4xx"]).toBeGreaterThan(0);
  });
});

describe("rate limiting", () => {
  it("does not throttle routine session checks", async () => {
    // get-session is polled by every client. Limiting it as if it were a
    // credential endpoint locks a whole office out from behind one NAT.
    for (let i = 0; i < 80; i++) {
      const res = await call("/api/auth/get-session", {
        headers: { "x-forwarded-for": "203.0.113.99" },
      });
      expect(res.status).not.toBe(429);
    }
  });

  it("throttles repeated sign-in attempts", async () => {
    // The only endpoint worth brute-forcing.
    const attempt = () =>
      call("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.7",
        },
        body: JSON.stringify({
          email: "nobody@example.test",
          password: "wrong-password-here",
        }),
      });

    let limited: Response | undefined;
    for (let i = 0; i < 120; i++) {
      const res = await attempt();
      if (res.status === 429) {
        limited = res;
        break;
      }
    }

    expect(limited, "sign-in was never rate limited").toBeDefined();
    expect(limited!.headers.get("retry-after")).toBeTruthy();

    const body = (await limited!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("limits one caller without affecting another", async () => {
    // Keying everything by a single bucket would let one person lock out a
    // whole office behind a shared NAT.
    const from = (ip: string) =>
      call("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({
          email: "nobody@example.test",
          password: "wrong-password-here",
        }),
      });

    for (let i = 0; i < 120; i++) {
      const res = await from("198.51.100.1");
      if (res.status === 429) break;
    }

    const other = await from("198.51.100.2");
    expect(other.status).not.toBe(429);
  });

  it("health checks are never rate limited", async () => {
    // A load balancer polls this constantly; throttling it would take the
    // service out of rotation exactly when it is busiest.
    for (let i = 0; i < 50; i++) {
      const res = await call("/healthz");
      expect(res.status).toBe(200);
    }
  });
});
