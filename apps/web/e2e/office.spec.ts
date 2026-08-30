import { expect, test, type Page } from "@playwright/test";
import { PROXIMITY } from "@vo/shared";

/**
 * End-to-end acceptance.
 *
 * These drive real browsers against the real API. A canvas has no DOM to
 * assert against, so the scene publishes the local player's position on
 * `window.__office` — without it a test can only check that a canvas element
 * exists, which stays true when the scene is broken.
 */

const SEEDED = [
  { email: "ada@example.com", password: "development-password-123" },
  { email: "grace@example.com", password: "development-password-123" },
];

interface OfficeHook {
  x: number;
  y: number;
  facing: string;
  peers: number;
  zone: string | null;
  audible: number;
  /** Where the avatar collides — its feet. Navigation must use this. */
  body: { x: number; y: number };
  zones: { id: string; name: string; centre: { x: number; y: number } }[];
  /** Row-strings of the collision grid; "1" is solid. */
  grid?: {
    width: number;
    height: number;
    tileSize: number;
    blocked: string[];
  };
}

/**
 * Where a named zone is, read from the running map.
 *
 * Navigating by hardcoded coordinates broke the moment the tile size changed
 * from 16 to 32, and would break again on any map edit.
 */
async function zoneCentre(page: Page, name: string) {
  const centre = await page.evaluate((wanted) => {
    const zone = window.__office?.zones.find((z) => z.name === wanted);
    return zone ? zone.centre : null;
  }, name);
  if (!centre) throw new Error(`no zone named "${name}" in this office`);
  return centre;
}

declare global {
  interface Window {
    __office?: OfficeHook;
  }
}

async function signInAndEnter(page: Page, who: (typeof SEEDED)[number]) {
  await page.goto("/");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForFunction(() => window.__office !== undefined, undefined, {
    timeout: 30_000,
  });
}

const position = (page: Page) =>
  page.evaluate(() => {
    const o = window.__office;
    if (!o) throw new Error("scene did not expose __office");
    return { x: o.x, y: o.y, peers: o.peers, zone: o.zone };
  });

/** Where the avatar's feet are — the position the walls act on. */
const feet = (page: Page) =>
  page.evaluate(() => {
    const o = window.__office;
    if (!o) throw new Error("scene did not expose __office");
    return { x: o.body.x, y: o.body.y };
  });

/**
 * Walks to a world coordinate, following a route the avatar can actually take.
 *
 * Steering axis-by-axis cannot enter a room: it walks to the wall beside the
 * door and presses into it. The old version papered over that by sidestepping
 * after a few stalls, which worked only because the first office had wide
 * openings roughly in line with everything.
 *
 * The office is editable now, so no test can assume a layout. This reads the
 * collision grid from the running map, breadth-first searches a route, and
 * walks it corner to corner. Four-way, matching how the avatar moves — a
 * diagonal gap between two desks is not a route.
 *
 * It steers on measured position rather than fixed key-press durations, so the
 * movement speed is not baked into every test.
 */
async function walkTo(
  page: Page,
  target: { x?: number; y?: number },
  tolerance = 12,
) {
  const route = await page.evaluate(
    ({ target, tolerance }) => {
      const o = window.__office;
      if (!o?.grid) return null;
      const { width, height, tileSize, blocked } = o.grid;

      const solid = (x: number, y: number) =>
        x < 0 || y < 0 || x >= width || y >= height || blocked[y]![x] === "1";

      // From the feet, not the sprite centre. The body sits most of a tile
      // lower, so routing from `o.y` starts a tile above where the avatar
      // actually stands and the first leg walks straight into a wall.
      const start = [
        Math.floor(o.body.x / tileSize),
        Math.floor(o.body.y / tileSize),
      ] as const;
      const goal = [
        Math.floor((target.x ?? o.body.x) / tileSize),
        Math.floor((target.y ?? o.body.y) / tileSize),
      ] as const;

      const key = (x: number, y: number) => y * width + x;
      const from = new Map<number, number>();
      const seen = new Set([key(...start)]);
      const queue: [number, number][] = [[start[0], start[1]]];
      /*
       * Search the whole reachable area, then walk to the reachable tile
       * nearest the target rather than insisting on the target itself.
       *
       * A room's centre is usually its conference table, and a table is
       * solid — demanding that exact tile finds no route at all and the
       * avatar never leaves reception. "Walk to the standup room" means get
       * into it, not stand on one particular square of it.
       */
      let best = key(start[0], start[1]);
      let bestDistance = Infinity;

      while (queue.length > 0) {
        const [x, y] = queue.shift()!;
        const distance = Math.abs(x - goal[0]) + Math.abs(y - goal[1]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = key(x, y);
        }
        if (distance === 0) break;

        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx!;
          const ny = y + dy!;
          if (solid(nx, ny) || seen.has(key(nx, ny))) continue;
          seen.add(key(nx, ny));
          from.set(key(nx, ny), key(x, y));
          queue.push([nx, ny]);
        }
      }

      // Walk the parents back, then keep only the corners — a straight run
      // needs one waypoint, not forty.
      const path: [number, number][] = [];
      let cur = best;
      const startKey = key(...start);
      while (cur !== startKey) {
        path.push([cur % width, Math.floor(cur / width)]);
        const prev = from.get(cur);
        if (prev === undefined) break;
        cur = prev;
      }
      path.reverse();

      const corners: { x: number; y: number }[] = [];
      for (let i = 0; i < path.length; i++) {
        const prev = path[i - 1];
        const next = path[i + 1];
        const turning =
          !prev ||
          !next ||
          next[0] - path[i]![0] !== path[i]![0] - prev[0] ||
          next[1] - path[i]![1] !== path[i]![1] - prev[1];
        if (turning) {
          corners.push({
            x: path[i]![0] * tileSize + tileSize / 2,
            y: path[i]![1] * tileSize + tileSize / 2,
          });
        }
      }
      return corners;
    },
    { target, tolerance },
  );

  // No grid (an older scene) or no route: fall back to steering straight at
  // the target, which is still right for a short hop across open floor.
  const legs = route?.length
    ? route
    : [{ x: target.x ?? NaN, y: target.y ?? NaN }];

  for (const [index, leg] of legs.entries()) {
    /*
     * Corners are hit tightly; only the destination gets the caller's slack.
     *
     * A tolerance is "close enough to have arrived", and applying it to every
     * waypoint means turning up to a tile early — which clips the door frame
     * and wedges the avatar in the wall beside the opening.
     */
    const slack = index === legs.length - 1 ? tolerance : 8;

    for (const axis of ["x", "y"] as const) {
      const goal = leg[axis];
      if (!Number.isFinite(goal)) continue;

      // One position read per step, not two: every read is a round trip to
      // the browser, and a two-client media test spends its whole budget on
      // them before it ever gets to assert anything.
      let pos = await feet(page);
      /*
       * How many fruitless presses before giving up on this leg.
       *
       * One is too few. With two browser contexts publishing to LiveKit the
       * page can miss a frame entirely, so a short press moves nobody and a
       * single-strike rule abandons a route the avatar could have walked.
       */
      let idle = 0;

      for (let step = 0; step < 24; step++) {
        const delta = goal - pos[axis];
        if (Math.abs(delta) <= slack) break;

        const key =
          axis === "x"
            ? delta > 0
              ? "ArrowRight"
              : "ArrowLeft"
            : delta > 0
              ? "ArrowDown"
              : "ArrowUp";

        /*
         * Hold proportional to the distance left.
         *
         * The route is already known to be clear, so a long leg can be walked
         * in one press instead of a dozen — the cap only exists to keep an
         * overshoot small enough for the next press to correct.
         */
        // The floor is well above one frame, for the same reason.
        const hold = Math.min(700, Math.max(120, Math.abs(delta) / 0.24));
        await page.keyboard.down(key);
        await page.waitForTimeout(hold);
        await page.keyboard.up(key);

        const moved = await feet(page);
        if (Math.abs(moved[axis] - pos[axis]) < 0.5) {
          // Genuinely wedged against something the route did not predict; the
          // next leg will steer out of it rather than pressing here forever.
          if (++idle >= 3) break;
        } else {
          idle = 0;
        }
        pos = moved;
      }
    }
  }
}

test.describe("signing in", () => {
  test("bad credentials say so without leaking whether the email exists", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Scoped to the form: Next's route announcer is also role="alert".
    await expect(page.locator("form").getByRole("alert")).toContainText(
      "do not match",
    );
  });

  test("a seeded user reaches the office", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await signInAndEnter(page, SEEDED[0]!);

    await expect(page.locator("canvas")).toBeVisible();
    // Exact: getByText does substring matching, and "Disconnected" contains
    // "Connected" — this assertion passed against a broken socket until it
    // was pinned down.
    await expect(page.getByText("Connected", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(errors).toEqual([]);
  });
});

test.describe("moving around", () => {
  test.beforeEach(async ({ page }) => {
    await signInAndEnter(page, SEEDED[0]!);
  });

  test("holding a direction moves the avatar", async ({ page }) => {
    const before = await position(page);

    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(600);
    await page.keyboard.up("ArrowRight");
    await page.waitForTimeout(200);

    expect((await position(page)).x).toBeGreaterThan(before.x + 10);
  });

  test("walls stop the avatar", async ({ page }) => {
    await page.keyboard.down("ArrowLeft");
    await page.waitForTimeout(2500);
    await page.keyboard.up("ArrowLeft");
    await page.waitForTimeout(200);

    expect((await position(page)).x).toBeGreaterThan(8);
  });

  test("the standup room doorway is passable", async ({ page }) => {
    /*
     * A doorway the avatar's body cannot fit through would be invisible in a
     * screenshot and fatal to the standup.
     *
     * Asked by name, not by coordinate: this test used to hardcode the pixel
     * position of the old office's doorway, so redesigning the office sent it
     * walking into a wall. Anyone can move this room from the admin panel.
     */
    const room = await zoneCentre(page, "Standup Room");
    await walkTo(page, { x: room.x, y: room.y }, 24);

    expect(await page.evaluate(() => window.__office?.zone)).not.toBeNull();
    await expect(page.getByText("In Standup Room")).toBeVisible({
      timeout: 10_000,
    });
  });
});

test.describe("two people in one office", () => {
  test("each sees the other, and sees them move", async ({ browser }) => {
    // Separate contexts, so these are genuinely two sessions rather than two
    // tabs sharing one cookie jar.
    const one = await browser.newContext();
    const two = await browser.newContext();
    const ada = await one.newPage();
    const grace = await two.newPage();

    try {
      await signInAndEnter(ada, SEEDED[0]!);
      await signInAndEnter(grace, SEEDED[1]!);

      await expect
        .poll(async () => (await position(ada)).peers, { timeout: 20_000 })
        .toBe(1);
      await expect
        .poll(async () => (await position(grace)).peers, { timeout: 20_000 })
        .toBe(1);

      // Grace walks; Ada's client must receive it.
      const graceBefore = await position(grace);
      await grace.keyboard.down("ArrowRight");
      await grace.waitForTimeout(900);
      await grace.keyboard.up("ArrowRight");

      await expect
        .poll(async () => (await position(grace)).x, { timeout: 10_000 })
        .toBeGreaterThan(graceBefore.x + 20);

      // Ada still has exactly one peer — Grace moved, she did not duplicate.
      expect((await position(ada)).peers).toBe(1);

      // And when Grace leaves, Ada is alone again.
      await two.close();
      await expect
        .poll(async () => (await position(ada)).peers, { timeout: 20_000 })
        .toBe(0);
    } finally {
      await one.close().catch(() => {});
      await two.close().catch(() => {});
    }
  });
});

test.describe("media", () => {
  test("controls explain themselves when the server has no credentials", async ({
    page,
  }) => {
    // Without LiveKit keys the office must still work. Buttons that fail on
    // click would be worse than an honest explanation.
    await signInAndEnter(page, SEEDED[0]!);

    const configured = await page
      .getByRole("button", { name: /Unmute|Mute/ })
      .count();

    if (configured > 0) {
      await expect(
        page.getByRole("button", { name: /Unmute|Mute/ }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByText("Voice and video are not configured"),
      ).toBeVisible();
    }
  });
});

test.describe("zones", () => {
  test("entering the standup room is announced", async ({ page }) => {
    await signInAndEnter(page, SEEDED[0]!);

    // Header shows peers until you are in a room, then names the room.
    await expect(page.getByText(/only one here|others? here/)).toBeVisible();

    const entrance = await position(page);
    const room = await zoneCentre(page, "Standup Room");
    await walkTo(page, { x: room.x, y: room.y }, 40);

    await expect(page.getByText("In Standup Room")).toBeVisible({
      timeout: 10_000,
    });

    // And leaving it clears the label. Back to where they came in, which is
    // reception — somewhere known to be outside every room, rather than an
    // offset from the room that might land in a wall or still be inside it.
    await walkTo(page, { x: entrance.x, y: entrance.y }, 40);
    await expect
      .poll(async () => (await position(page)).zone, { timeout: 20_000 })
      .toBeNull();
    await expect(page.getByText("In Standup Room")).toBeHidden();
  });
});

interface MediaHook {
  connected: boolean;
  participants: string[];
  subscribedAudio: string[];
  subscribedVideo: string[];
  desiredAudio: string[];
  volumes: Record<string, number>;
}

declare global {
  interface Window {
    __media?: () => MediaHook;
  }
}

/**
 * Moves `who` the shortest distance that puts them more than `minDistance`
 * from `other`, and returns the separation actually achieved.
 *
 * Walking a fixed number of key presses assumes open floor in that direction:
 * from reception, nine presses to the right cover 230px before hitting the
 * quiet room wall, well inside the 400px cutoff, so the subscription correctly
 * stayed open and the test read it as a proximity bug.
 *
 * Naming a far room instead is no better — the boardroom is only 342px from
 * reception. So the destination is computed: breadth-first from where they
 * stand, take the first reachable tile far enough away. Nearest by path, so
 * the walk is as short as the requirement allows.
 */
/** How close to a destination counts as arrived. */
const ARRIVAL_SLACK = 40;

async function separate(who: Page, other: Page, minDistance: number) {
  const from = await position(other);

  /*
   * Aim well past the requirement.
   *
   * Arriving is "within ARRIVAL_SLACK of the destination", so a destination
   * exactly at the cutoff can be reached from the near side and land short —
   * 427px away, stopped 40px early, measured 395px against a 400px bar.
   */
  const searchDistance = minDistance + ARRIVAL_SLACK * 3;

  const target = await who.evaluate(
    ({ from, searchDistance }) => {
      const o = window.__office;
      if (!o?.grid) return null;
      const { width, height, tileSize, blocked } = o.grid;

      const solid = (x: number, y: number) =>
        x < 0 || y < 0 || x >= width || y >= height || blocked[y]![x] === "1";

      const start: [number, number] = [
        Math.floor(o.body.x / tileSize),
        Math.floor(o.body.y / tileSize),
      ];
      const seen = new Set([start[1] * width + start[0]]);
      const queue: [number, number][] = [start];

      while (queue.length > 0) {
        const [x, y] = queue.shift()!;
        const wx = x * tileSize + tileSize / 2;
        const wy = y * tileSize + tileSize / 2;
        if (Math.hypot(wx - from.x, wy - from.y) > searchDistance) {
          return { x: wx, y: wy };
        }
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx!;
          const ny = y + dy!;
          if (solid(nx, ny) || seen.has(ny * width + nx)) continue;
          seen.add(ny * width + nx);
          queue.push([nx, ny]);
        }
      }
      return null;
    },
    { from, searchDistance },
  );

  if (!target) {
    throw new Error(
      `nowhere in this office is more than ${searchDistance}px from the other person`,
    );
  }
  await walkTo(who, target, ARRIVAL_SLACK);

  const [a, b] = await Promise.all([position(who), position(other)]);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Brings `who` back to within earshot of `other`. */
async function rejoin(who: Page, other: Page) {
  const target = await position(other);
  await walkTo(who, { x: target.x, y: target.y }, ARRIVAL_SLACK);

  const [a, b] = await Promise.all([position(who), position(other)]);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const media = (page: Page) =>
  page.evaluate(() => (window.__media ? window.__media() : null));

test.describe("proximity voice", () => {
  // Skipped unless the server has real LiveKit credentials; there is no way
  // to fake an SFU, and a mocked one would prove nothing about subscriptions.
  test("audio follows distance", async ({ browser }) => {
    const one = await browser.newContext({
      permissions: ["microphone", "camera"],
    });
    const two = await browser.newContext({
      permissions: ["microphone", "camera"],
    });
    const ada = await one.newPage();
    const grace = await two.newPage();

    try {
      await signInAndEnter(ada, SEEDED[0]!);
      await signInAndEnter(grace, SEEDED[1]!);

      const state = await media(ada);
      test.skip(state === null, "LiveKit is not configured on this server");

      await expect.poll(async () => (await media(ada))?.connected).toBe(true);

      // Turn the microphone on while already standing nearby. This is the
      // case that was broken: the proximity decision had already been made,
      // so nothing re-subscribed when the track appeared.
      await grace.getByRole("button", { name: /Unmute|Mic off/ }).click();

      await expect
        .poll(async () => (await media(ada))?.subscribedAudio.length, {
          timeout: 20_000,
        })
        .toBe(1);

      // Walk out of earshot, and prove she got there — a test that asserts
      // "no longer audible" without checking the distance is really asserting
      // that the walk worked.
      const apart = await separate(
        grace,
        ada,
        PROXIMITY.AUDIO_UNSUBSCRIBE_RADIUS,
      );
      expect(apart).toBeGreaterThan(PROXIMITY.AUDIO_UNSUBSCRIBE_RADIUS);

      await expect
        .poll(async () => (await media(ada))?.subscribedAudio.length, {
          timeout: 20_000,
        })
        .toBe(0);

      // And back into it.
      const near = await rejoin(grace, ada);
      expect(near).toBeLessThan(PROXIMITY.AUDIO_SUBSCRIBE_RADIUS);

      await expect
        .poll(async () => (await media(ada))?.subscribedAudio.length, {
          timeout: 20_000,
        })
        .toBe(1);

      // Volume is a function of distance, not a constant.
      const volumes = Object.values((await media(ada))!.volumes);
      expect(volumes[0]).toBeGreaterThan(0);
      expect(volumes[0]).toBeLessThanOrEqual(1);
    } finally {
      await one.close().catch(() => {});
      await two.close().catch(() => {});
    }
  });
});

test.describe("zone privacy", () => {
  test("a booth conversation is not overheard from the floor", async ({
    browser,
  }) => {
    // The behaviour the whole product is for. Verified against a real SFU,
    // because "did the track actually get unsubscribed" is not observable
    // any other way.
    const one = await browser.newContext({
      permissions: ["microphone", "camera"],
    });
    const two = await browser.newContext({
      permissions: ["microphone", "camera"],
    });
    const ada = await one.newPage();
    const alan = await two.newPage();

    try {
      await signInAndEnter(ada, SEEDED[0]!);
      await signInAndEnter(alan, { ...SEEDED[0]!, email: "alan@example.com" });

      test.skip((await media(ada)) === null, "LiveKit is not configured");

      for (const page of [ada, alan]) {
        await page.getByRole("button", { name: /Unmute|Mic off/ }).click();
      }

      // Standing together in the open, they can hear each other.
      await expect
        .poll(async () => (await media(ada))?.desiredAudio.length, {
          timeout: 20_000,
        })
        .toBe(1);

      // Alan steps into the Focus booth. Ada is left outside it, on the open floor.
      const booth = await zoneCentre(alan, "Focus booth");
      await walkTo(alan, { x: booth.x, y: booth.y }, 40);

      await expect(alan.getByText("In Focus booth")).toBeVisible({
        timeout: 10_000,
      });
      await expect
        .poll(async () => (await media(ada))?.desiredAudio.length, {
          timeout: 20_000,
        })
        .toBe(0);

      // Ada follows him in, and the conversation is shared again.
      await walkTo(ada, { x: booth.x, y: booth.y }, 40);

      await expect(ada.getByText("In Focus booth")).toBeVisible({
        timeout: 10_000,
      });
      await expect
        .poll(async () => (await media(ada))?.desiredAudio.length, {
          timeout: 20_000,
        })
        .toBe(1);
    } finally {
      await one.close().catch(() => {});
      await two.close().catch(() => {});
    }
  });
});

test.describe("chat", () => {
  test("a message reaches the other person, and history survives a reload", async ({
    browser,
  }) => {
    const one = await browser.newContext({
      permissions: ["microphone", "camera"],
    });
    const two = await browser.newContext({
      permissions: ["microphone", "camera"],
    });
    const ada = await one.newPage();
    const grace = await two.newPage();

    try {
      await signInAndEnter(ada, SEEDED[0]!);
      await signInAndEnter(grace, SEEDED[1]!);

      await ada.getByRole("button", { name: /^Chat/ }).click();
      await grace.getByRole("button", { name: /^Chat/ }).click();

      // The seeded channel has something in it, so the panel is never a
      // blank box on first run.
      await expect(ada.getByText(/Standup in the room/)).toBeVisible();

      const said = `coffee at ${Date.now()}`;
      await grace.getByLabel("Message").fill(said);
      await grace.getByLabel("Message").press("Enter");

      await expect(ada.getByText(said)).toBeVisible({ timeout: 15_000 });

      // Sent messages clear the box rather than leaving the text behind.
      await expect(grace.getByLabel("Message")).toHaveValue("");

      // And it is persisted, not just broadcast.
      await ada.reload();
      await ada.waitForFunction(() => window.__office !== undefined, null, {
        timeout: 30_000,
      });
      await ada.getByRole("button", { name: /^Chat/ }).click();
      await expect(ada.getByText(said)).toBeVisible({ timeout: 15_000 });
    } finally {
      await one.close().catch(() => {});
      await two.close().catch(() => {});
    }
  });

  test("typing does not walk the avatar", async ({ page }) => {
    // The canvas listens for arrow keys. Typing in chat must not move you.
    await signInAndEnter(page, SEEDED[0]!);
    await page.getByRole("button", { name: /^Chat/ }).click();

    const before = await position(page);
    await page.getByLabel("Message").click();
    await page.keyboard.type("left right up down");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(400);

    const after = await position(page);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  });
});

test.describe("proximity video", () => {
  test("a nearby camera appears, and disappears when they walk away", async ({
    browser,
  }) => {
    const one = await browser.newContext({
      permissions: ["microphone", "camera"],
    });
    const two = await browser.newContext({
      permissions: ["microphone", "camera"],
    });
    const ada = await one.newPage();
    const grace = await two.newPage();

    try {
      await signInAndEnter(ada, SEEDED[0]!);
      await signInAndEnter(grace, SEEDED[1]!);

      test.skip((await media(ada)) === null, "LiveKit is not configured");

      await grace
        .getByRole("button", { name: /Turn camera on|Camera off/ })
        .click();

      // Standing together: her camera is subscribed and rendered.
      await expect
        .poll(async () => (await media(ada))?.subscribedVideo.length, {
          timeout: 25_000,
        })
        .toBe(1);
      await expect(ada.locator("figure")).toHaveCount(1, { timeout: 15_000 });

      // Walk out of camera range — which is tighter than audio range.
      for (let i = 0; i < 8; i++) {
        await grace.keyboard.down("ArrowRight");
        await grace.waitForTimeout(300);
        await grace.keyboard.up("ArrowRight");
      }

      await expect
        .poll(async () => (await media(ada))?.subscribedVideo.length, {
          timeout: 25_000,
        })
        .toBe(0);
      // The tile goes with it — an orphaned element would keep decoding video
      // for someone who has walked away.
      await expect(ada.locator("figure")).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await one.close().catch(() => {});
      await two.close().catch(() => {});
    }
  });
});
