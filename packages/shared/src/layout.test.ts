import { describe, expect, it } from "vitest";
import {
  findLayoutProblems,
  isBlocked,
  reachableFrom,
  usableTiles,
  type LayoutGrid,
} from "./layout.js";

/**
 * These are the rules that a plant kept breaking.
 *
 * Three times while laying out the starter office a single decorative tile
 * sealed a doorway — each time invisible in the map file, each time found only
 * by walking into it. Every case below is one of those failures, written down.
 */

const WALL = 4995;
const PLANT = 8000;

/** Builds a grid from ASCII: `#` wall, `p` furniture, `.` open. */
function grid(rows: string[]): LayoutGrid {
  const width = rows[0]!.length;
  const walls: number[] = [];
  const furniture: number[] = [];
  for (const row of rows) {
    for (const ch of row) {
      walls.push(ch === "#" ? WALL : 0);
      furniture.push(ch === "p" ? PLANT : 0);
    }
  }
  return { width, height: rows.length, walls, furniture };
}

describe("isBlocked", () => {
  const g = grid(["...", ".#.", ".p."]);

  it("treats walls and furniture alike — both stop an avatar", () => {
    expect(isBlocked(g, 1, 1)).toBe(true);
    expect(isBlocked(g, 1, 2)).toBe(true);
    expect(isBlocked(g, 0, 0)).toBe(false);
  });

  it("treats outside the map as solid, so a flood fill cannot escape", () => {
    expect(isBlocked(g, -1, 0)).toBe(true);
    expect(isBlocked(g, 0, 3)).toBe(true);
  });
});

describe("reachableFrom", () => {
  it("refuses an entrance placed inside a solid tile", () => {
    expect(() => reachableFrom(grid([".#."]), 1, 0)).toThrow(
      /entrance at \(1, 0\) is inside a solid tile/,
    );
  });

  it("does not squeeze through a diagonal gap", () => {
    /*
     * The avatar moves four ways, so the open corner between two blocks is
     * not a route. An eight-way fill would call this office connected and
     * publish a room nobody can enter.
     */
    const g = grid([".#", "#."]);
    const seen = reachableFrom(g, 0, 0);
    expect(seen.size).toBe(1);
    expect(seen.has(3)).toBe(false);
  });

  it("finds every tile of an open room", () => {
    expect(reachableFrom(grid(["...", "...", "..."]), 0, 0).size).toBe(9);
  });
});

describe("findLayoutProblems", () => {
  const room = { name: "Standup", x: 3, y: 0, width: 2, height: 3 };

  it("passes a room with a doorway", () => {
    //                 0    1    2    3    4
    const g = grid(["..#..", "....." /* doorway at (2,1) */, "..#.."]);
    expect(findLayoutProblems(g, { x: 0, y: 1 }, [room])).toEqual([]);
  });

  it("names the room a plant has sealed", () => {
    // The exact failure from the starter office: the walls are fine, and one
    // piece of furniture in the doorway is what shuts the room.
    const g = grid(["..#..", "..p..", "..#.."]);
    const problems = findLayoutProblems(g, { x: 0, y: 1 }, [room]);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.zone).toBe("Standup");
    expect(problems[0]!.usable).toBe(0);
    expect(problems[0]!.reason).toMatch(/blocking its doorway/);
  });

  it("rejects a room furnished down to a single tile", () => {
    // Reachable, but there is nowhere to stand once you are in — a doorway
    // with a name, not a room.
    const g = grid(["..#pp", "....p", "..#pp"]);
    const problems = findLayoutProblems(g, { x: 0, y: 1 }, [room]);

    expect(problems).toHaveLength(1);
    expect(problems[0]!.usable).toBe(1);
    expect(problems[0]!.reason).toMatch(/furnished shut/);
  });

  it("reports every sealed room, not just the first", () => {
    // Fixing a layout one error per run is miserable when a single misplaced
    // wall has cut off several rooms at once.
    const g = grid(["#.#.#", "#.#.#", "#.#.#"]);
    const problems = findLayoutProblems(g, { x: 1, y: 0 }, [
      { name: "Left", x: 0, y: 0, width: 1, height: 3 },
      { name: "Right", x: 4, y: 0, width: 1, height: 3 },
    ]);

    expect(problems.map((p) => p.zone)).toEqual(["Left", "Right"]);
  });
});

describe("usableTiles", () => {
  it("counts only the floor you can actually reach", () => {
    // Half the room is walled off from the entrance; only the near half counts.
    const g = grid([".....", "..#..", "....."]);
    const reachable = reachableFrom(g, 0, 0);
    expect(
      usableTiles(g, reachable, {
        name: "All",
        x: 0,
        y: 0,
        width: 5,
        height: 3,
      }),
    ).toBe(14);
  });
});
