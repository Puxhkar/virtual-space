import { describe, expect, it } from "vitest";
import { REALTIME } from "@vo/shared";
import { validateMove } from "./movement.js";

const BOUNDS = { width: 640, height: 480 };
const at = (x: number, y: number) => ({ x, y });

describe("movement validation", () => {
  it("accepts a normal step", () => {
    // 100ms at full speed is 24px.
    expect(validateMove(at(100, 100), at(120, 100), 100, BOUNDS).ok).toBe(true);
  });

  it("accepts standing still", () => {
    expect(validateMove(at(100, 100), at(100, 100), 100, BOUNDS).ok).toBe(true);
  });

  it("rejects a teleport", () => {
    const check = validateMove(at(10, 10), at(600, 400), 100, BOUNDS);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("too_fast");
  });

  it("rejects a position outside the map", () => {
    const check = validateMove(at(10, 10), at(-5, 10), 100, BOUNDS);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("out_of_bounds");
  });

  it("tolerates jitter rather than punishing a laggy client", () => {
    // Slightly further than the elapsed time strictly allows. An honest client
    // on a bad connection produces this; rejecting it would make the avatar
    // rubber-band for people with poor wifi.
    const elapsed = 100;
    const exact = (REALTIME.MAX_SPEED_PX_PER_SEC * elapsed) / 1000;
    expect(
      validateMove(at(100, 100), at(100 + exact * 1.3, 100), elapsed, BOUNDS)
        .ok,
    ).toBe(true);
  });

  it("still rejects well beyond the tolerance", () => {
    const elapsed = 100;
    const exact = (REALTIME.MAX_SPEED_PX_PER_SEC * elapsed) / 1000;
    expect(
      validateMove(at(100, 100), at(100 + exact * 4, 100), elapsed, BOUNDS).ok,
    ).toBe(false);
  });

  it("a burst of events sharing one millisecond cannot buy free distance", () => {
    // Without a floor on elapsed time, a client could spam moves with
    // elapsed=0 and drift arbitrarily far.
    const check = validateMove(at(10, 10), at(400, 300), 0, BOUNDS);
    expect(check.ok).toBe(false);
  });
});
