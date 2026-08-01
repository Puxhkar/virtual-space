import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * The V1 acceptance test: ten people in one office at once.
 *
 * Real browsers with real sessions, not synthetic sockets, because the things
 * most likely to break under load are the ones a socket harness skips — auth,
 * membership checks, media tokens, and the browser's own frame budget.
 *
 * Slow by design. It is the test that decides whether a standup works.
 */

const PASSWORD = "development-password-123";
const TEAM = [
  "ada",
  "grace",
  "alan",
  "edsger",
  "barbara",
  "donald",
  "margaret",
  "linus",
  "katherine",
  "tim",
].map((n) => `${n}@example.com`);

interface Client {
  context: BrowserContext;
  page: Page;
  email: string;
  errors: string[];
}

const office = (page: Page) =>
  page.evaluate(() => {
    const o = window.__office;
    if (!o) throw new Error("scene not ready");
    return { x: o.x, y: o.y, peers: o.peers, zone: o.zone };
  });

/** Where a named zone is, read from the running map rather than hardcoded. */
async function zoneCentre(page: Page, name: string) {
  const centre = await page.evaluate((wanted) => {
    const zone = window.__office?.zones.find((z) => z.name === wanted);
    return zone ? zone.centre : null;
  }, name);
  if (!centre) throw new Error(`no zone named "${name}" in this office`);
  return centre;
}

test.describe("ten people", () => {
  // Ten browsers, sign-in, media handshakes and thirty seconds of movement.
  test.setTimeout(300_000);

  test("a full team can be in the office together", async ({ browser }) => {
    const clients: Client[] = [];

    try {
      for (const email of TEAM) {
        const context = await browser.newContext({
          permissions: ["microphone", "camera"],
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));

        await page.goto("/");
        await page.getByLabel("Email").fill(email);
        await page.getByLabel("Password").fill(PASSWORD);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForFunction(() => window.__office !== undefined, null, {
          timeout: 60_000,
        });

        clients.push({ context, page, email, errors });
      }

      expect(clients).toHaveLength(10);

      // Everyone sees the other nine. This is the check that catches a
      // roster that silently drops people as the office fills.
      for (const client of clients) {
        await expect
          .poll(async () => (await office(client.page)).peers, {
            timeout: 60_000,
            message: `${client.email} did not see the whole team`,
          })
          .toBe(9);
      }

      /*
       * Everyone moves at once: the worst case for the movement broadcast,
       * which is O(people x people) per tick.
       *
       * Each client holds one heading for the whole burst. Cycling through
       * all four directions — as this did originally — returns a client to
       * roughly where it started, so the "did everyone move" assertion below
       * was passing only when collisions happened to make the round trip
       * asymmetric.
       */
      const directions = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"];
      const before = await Promise.all(clients.map((c) => office(c.page)));

      await Promise.all(
        clients.map(async (client, i) => {
          const key = directions[i % directions.length]!;
          for (let step = 0; step < 8; step++) {
            await client.page.keyboard.down(key);
            await client.page.waitForTimeout(200);
            await client.page.keyboard.up(key);
          }
        }),
      );

      // Everyone actually moved — a client whose socket died would sit still.
      const after = await Promise.all(clients.map((c) => office(c.page)));
      for (let i = 0; i < clients.length; i++) {
        const moved =
          Math.abs(after[i]!.x - before[i]!.x) +
          Math.abs(after[i]!.y - before[i]!.y);
        expect(moved, `${clients[i]!.email} stopped moving`).toBeGreaterThan(5);
      }

      // Still everyone, after all that movement.
      for (const client of clients) {
        await expect
          .poll(async () => (await office(client.page)).peers, {
            timeout: 30_000,
            message: `${client.email} lost people during movement`,
          })
          .toBe(9);
      }

      const errors = clients.flatMap((c) => c.errors);
      expect(errors, "clients logged errors").toEqual([]);
    } finally {
      await Promise.all(
        clients.map((c) => c.context.close().catch(() => undefined)),
      );
    }
  });

  test("the whole team fits in the standup room", async ({ browser }) => {
    // The specific thing V1 exists for. Zone capacity, presence and the
    // doorway all have to hold with ten people going through at once.
    const clients: Client[] = [];

    try {
      for (const email of TEAM) {
        const context = await browser.newContext({
          permissions: ["microphone", "camera"],
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));

        await page.goto("/");
        await page.getByLabel("Email").fill(email);
        await page.getByLabel("Password").fill(PASSWORD);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForFunction(() => window.__office !== undefined, null, {
          timeout: 60_000,
        });
        clients.push({ context, page, email, errors });
      }

      /*
       * Walk everyone in, and keep trying.
       *
       * A single pass was flaky at ten browsers: a starved renderer can stall
       * for several consecutive steps, and the walk helper cannot tell that
       * apart from a wall. A person in that situation simply keeps walking,
       * so the test does too — up to a point, after which it reports exactly
       * who was left outside and where.
       */
      const room = await zoneCentre(clients[0]!.page, "Standup Room");

      await Promise.all(
        clients.map(async (client) => {
          for (let attempt = 0; attempt < 4; attempt++) {
            if ((await office(client.page)).zone !== null) return;
            await walkTo(client.page, { y: room.y }, 10);
            await walkTo(client.page, { x: room.x });
          }
        }),
      );

      /*
       * Polled on the scene's own state rather than on the header text.
       * Asserting text here was flaky: with ten browsers, one renderer can be
       * mid-React-render when its turn comes, and a snapshot assertion catches
       * it between states. The zone itself is the acceptance criterion; that
       * it reaches the header is covered by the single-user zone test.
       */
      const stranded: string[] = [];
      for (const client of clients) {
        const where = await office(client.page);
        if (where.zone === null) {
          stranded.push(`${client.email} at (${where.x}, ${where.y})`);
        }
      }
      expect(stranded, "people left outside the standup").toEqual([]);

      // And the label does reach the UI, checked once.
      await expect(clients[0]!.page.getByText("In Standup Room")).toBeVisible({
        timeout: 15_000,
      });

      const errors = clients.flatMap((c) => c.errors);
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(
        clients.map((c) => c.context.close().catch(() => undefined)),
      );
    }
  });
});

async function walkTo(
  page: Page,
  target: { x?: number; y?: number },
  tolerance = 10,
) {
  for (const axis of ["y", "x"] as const) {
    const goal = target[axis];
    if (goal === undefined) continue;

    let stalls = 0;
    for (let step = 0; step < 120; step++) {
      const pos = await office(page);
      const delta = goal - pos[axis];
      if (Math.abs(delta) <= tolerance) break;

      const key =
        axis === "x"
          ? delta > 0
            ? "ArrowRight"
            : "ArrowLeft"
          : delta > 0
            ? "ArrowDown"
            : "ArrowUp";

      await page.keyboard.down(key);
      await page.waitForTimeout(70);
      await page.keyboard.up(key);

      const moved = await office(page);
      // Under load a starved renderer misses frames, so a stalled step is not
      // evidence of a wall. The caller retries, so giving up early here is
      // cheap and pressing on forever is not.
      if (Math.abs(moved[axis] - pos[axis]) < 0.5) {
        if (++stalls >= 5) break;
      } else {
        stalls = 0;
      }
    }
  }
}
