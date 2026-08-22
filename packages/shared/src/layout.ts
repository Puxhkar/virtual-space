/**
 * Layout rules: what makes an office usable.
 *
 * Furniture blocks movement, so a plant one tile out of place seals a meeting
 * room. That is invisible in a map file and obvious only when somebody is
 * trapped behind it — it happened three times while laying out the starter
 * office. The rule lives here, shared, because three places need it: the
 * generator that builds a map, the editor that previews one, and the server
 * that refuses to publish one.
 */

export interface LayoutGrid {
  width: number;
  height: number;
  /** Row-major global ids. Zero is empty. */
  walls: readonly number[];
  furniture: readonly number[];
}

export interface LayoutZone {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function tileIndex(grid: { width: number }, x: number, y: number) {
  return y * grid.width + x;
}

export function isInside(grid: LayoutGrid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

/** Whether an avatar is stopped by this cell. */
export function isBlocked(grid: LayoutGrid, x: number, y: number): boolean {
  if (!isInside(grid, x, y)) return true;
  const i = tileIndex(grid, x, y);
  return grid.walls[i] !== 0 || grid.furniture[i] !== 0;
}

/**
 * Every tile reachable on foot from a starting cell.
 *
 * Four-way, because that is how the avatar moves — an eight-way flood fill
 * would call a diagonal gap between two desks walkable when it is not.
 */
export function reachableFrom(
  grid: LayoutGrid,
  sx: number,
  sy: number,
): Set<number> {
  if (isBlocked(grid, sx, sy)) {
    throw new Error(`the entrance at (${sx}, ${sy}) is inside a solid tile`);
  }

  const seen = new Set([tileIndex(grid, sx, sy)]);
  const queue: [number, number][] = [[sx, sy]];

  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (isBlocked(grid, nx, ny)) continue;
      const key = tileIndex(grid, nx, ny);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

/** How many tiles of a zone can actually be stood on, coming from the entrance. */
export function usableTiles(
  grid: LayoutGrid,
  reachable: ReadonlySet<number>,
  zone: LayoutZone,
): number {
  let open = 0;
  for (let y = zone.y; y < zone.y + zone.height; y++) {
    for (let x = zone.x; x < zone.x + zone.width; x++) {
      if (reachable.has(tileIndex(grid, x, y))) open++;
    }
  }
  return open;
}

/**
 * A room needs enough floor for the people it is meant to hold.
 *
 * One reachable tile is not a room — it is a doorway somebody furnished shut.
 */
export const MIN_USABLE_TILES = 2;

export interface LayoutProblem {
  zone: string;
  usable: number;
  reason: string;
}

/**
 * Reports every unusable room rather than throwing on the first.
 *
 * Fixing a layout one error per run is miserable when a misplaced wall has
 * sealed four rooms at once.
 */
export function findLayoutProblems(
  grid: LayoutGrid,
  spawn: { x: number; y: number },
  zones: readonly LayoutZone[],
): LayoutProblem[] {
  const reachable = reachableFrom(grid, spawn.x, spawn.y);
  const problems: LayoutProblem[] = [];

  for (const zone of zones) {
    const usable = usableTiles(grid, reachable, zone);
    if (usable === 0) {
      problems.push({
        zone: zone.name,
        usable,
        reason: `"${zone.name}" cannot be reached from the entrance — something is blocking its doorway`,
      });
    } else if (usable < MIN_USABLE_TILES) {
      problems.push({
        zone: zone.name,
        usable,
        reason: `"${zone.name}" has only ${usable} usable tile — it is furnished shut`,
      });
    }
  }
  return problems;
}
