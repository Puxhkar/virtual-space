import { beforeEach, describe, expect, it } from "vitest";
import {
  gauge,
  increment,
  observe,
  resetMetrics,
  snapshot,
} from "./metrics.js";

/**
 * Metrics are the thing you reach for when something is already wrong, so the
 * failure mode that matters most is the endpoint itself breaking.
 */

beforeEach(() => resetMetrics());

describe("counters and gauges", () => {
  it("counts", () => {
    increment("a");
    increment("a", 4);
    expect(snapshot().counters["a"]).toBe(5);
  });

  it("reads gauges on demand, not when registered", () => {
    let value = 1;
    gauge("live", () => value);
    value = 42;
    expect(snapshot().gauges["live"]).toBe(42);
  });

  it("a broken gauge does not take the endpoint down", () => {
    // The one endpoint you need when things are going wrong must not be the
    // one that throws.
    gauge("fine", () => 7);
    gauge("broken", () => {
      throw new Error("database is on fire");
    });

    const s = snapshot();
    expect(s.gauges["fine"]).toBe(7);
    expect(s.gauges["broken"]).toBe(-1);
  });
});

describe("latency", () => {
  it("reports percentiles", () => {
    for (let i = 1; i <= 100; i++) observe("d", i);
    const d = snapshot().latency["d"]!;

    expect(d.count).toBe(100);
    expect(d.p50).toBeGreaterThanOrEqual(50);
    expect(d.p95).toBeGreaterThanOrEqual(95);
    expect(d.p99).toBeGreaterThanOrEqual(99);
  });

  it("keeps sample memory bounded", () => {
    // A metrics registry that grows without bound is a memory leak wearing a
    // monitoring costume.
    for (let i = 0; i < 5_000; i++) observe("d", i);
    expect(snapshot().latency["d"]!.count).toBeLessThanOrEqual(512);
  });

  it("handles being asked before anything was recorded", () => {
    expect(snapshot().latency["never"]).toBeUndefined();
    expect(snapshot().counters).toEqual({});
  });
});

describe("process health", () => {
  it("reports uptime and memory", () => {
    const s = snapshot();
    expect(s.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(s.memoryMb).toBeGreaterThan(0);
  });
});
