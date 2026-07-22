import type { MiddlewareHandler } from "hono";
import { ApiError } from "./errors.js";
import type { App } from "./middleware.js";

/**
 * Rate limiting.
 *
 * A fixed-window counter in memory, which is the right shape for one server
 * process (CLAUDE.md §7). It moves behind the same kind of boundary as the
 * presence store when a second instance exists — until then a shared Redis
 * counter would be a second datastore for no benefit.
 *
 * Keyed by authenticated user where there is one, and by IP otherwise. Keying
 * everything by IP would let one person behind a shared office NAT exhaust the
 * budget for their whole team.
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** Distinguishes one limiter's buckets from another's. */
  name: string;
}

const buckets = new Map<string, Window>();

/** Drops expired windows so the map cannot grow without bound. */
function sweep(now: number): void {
  for (const [key, window] of buckets) {
    if (window.resetAt <= now) buckets.delete(key);
  }
}

let lastSweep = 0;

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<App> {
  return async (c, next) => {
    const now = Date.now();

    // Sweeping on a timer would keep the process alive; sweeping here costs
    // one pass a minute under any real load.
    if (now - lastSweep > 60_000) {
      sweep(now);
      lastSweep = now;
    }

    const identity =
      c.get("userId") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const key = `${options.name}:${identity}`;

    const window = buckets.get(key);
    if (!window || window.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    } else if (window.count >= options.limit) {
      const retryAfter = Math.ceil((window.resetAt - now) / 1000);
      c.header("retry-after", String(retryAfter));
      throw new ApiError(
        "rate_limited",
        `Too many requests. Try again in ${retryAfter} seconds.`,
      );
    } else {
      window.count += 1;
    }

    await next();
  };
}

/** Test seam. Rate limit state is process-global by design. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}
