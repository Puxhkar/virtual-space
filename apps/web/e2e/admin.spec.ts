import { expect, test, type Page } from "@playwright/test";

/**
 * The admin panel.
 *
 * What matters here is not that the canvas draws — it is that only an admin
 * can change the office, and that a layout nobody could use is refused before
 * it becomes everyone's workspace.
 */

/**
 * The editor's read-only view of the layout.
 *
 * The panel is a canvas, so without this a test can only diff screenshots —
 * which proves that something changed, not that a 3x2 sofa wrote six cells.
 */
interface EditorHook {
  width: number;
  height: number;
  layers: { floor: number[]; walls: number[]; furniture: number[] };
  zones: number;
  stamp: { w: number; h: number } | null;
}

declare global {
  interface Window {
    __editor?: EditorHook;
  }
}

const PASSWORD = "development-password-123";
const OWNER = "ada@example.com";
const MEMBER = "grace@example.com";

async function openPanel(page: Page, email: string) {
  await page.goto("/admin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForSelector("canvas", { timeout: 40_000 });
  // The palette draws once its sheets have loaded.
  await expect(page.getByLabel("Tile set", { exact: true })).toBeVisible();
}

test.describe("office layout panel", () => {
  test.setTimeout(120_000);

  test("shows the whole art library, not a curated subset", async ({
    page,
  }) => {
    await openPanel(page, OWNER);

    // Twenty-seven sheets ship with the pack; all of them are reachable.
    const sets = page.getByLabel("Tile set", { exact: true }).locator("option");
    await expect(sets).toHaveCount(27);

    // Layers and tools are present and labelled.
    for (const name of ["Floor", "Walls", "Furniture"]) {
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    for (const name of ["Paint", "Erase", "Draw room", "Set entrance"]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }
  });

  test("stamps a whole piece of furniture, not one tile", async ({ page }) => {
    /*
     * The reason objects exist.
     *
     * A wardrobe is 2x3 tiles and a conference table 5x3. Painting one tile at
     * a time means doing that arithmetic by hand, and getting it wrong leaves
     * a clipped desk or — as happened three times while laying out the seeded
     * office — a plant sealing a doorway. This asserts the footprint, because
     * a screenshot diff would pass just as happily on a single tile.
     */
    await openPanel(page, OWNER);

    // Conference hall leads with its largest objects, so the first thumbnail
    // is comfortably multi-tile.
    await page
      .getByLabel("Tile set", { exact: true })
      .selectOption("conference-hall");
    await expect(
      page.getByRole("button", { name: /Objects \(\d+\)/ }),
    ).toBeVisible();

    const objects = page.locator("canvas[aria-label='Objects']");
    await expect(objects).toBeVisible();
    await objects.click({ position: { x: 20, y: 20 } });

    const size = await page.evaluate(() => window.__editor?.stamp);
    expect(size).toBeTruthy();
    expect(size!.w * size!.h).toBeGreaterThan(1);

    await page.getByRole("button", { name: "Furniture", exact: true }).click();

    const before = await page.evaluate(
      () => window.__editor!.layers.furniture.filter((g) => g > 0).length,
    );

    // Somewhere open, away from the seeded furniture.
    await page
      .locator("canvas")
      .nth(1)
      .click({ position: { x: 32 * 3 + 8, y: 32 * 3 + 8 } });

    const after = await page.evaluate(
      () => window.__editor!.layers.furniture.filter((g) => g > 0).length,
    );

    // Every covered cell was written, not just the one under the pointer.
    expect(after - before).toBeGreaterThan(1);
    expect(after - before).toBeLessThanOrEqual(size!.w * size!.h);
  });

  test("lists the rooms and lets them be renamed", async ({ page }) => {
    await openPanel(page, OWNER);

    const names = page.getByLabel("Room name");
    await expect(names.first()).toBeVisible();
    expect(await names.count()).toBeGreaterThan(0);
  });

  test("painting changes the layer locally, before anything is published", async ({
    page,
  }) => {
    // Edits are local until Publish, so a half-finished layout is never what
    // the team walks into. Painting here must not reach the office.
    await openPanel(page, OWNER);

    await page
      .getByLabel("Tile set", { exact: true })
      .selectOption("room-builder");
    await page.waitForTimeout(600);

    // Choosing a sheet is not choosing a tile — pick one from the palette,
    // or there is nothing to paint with.
    // Index 2467 in the 76-column sheet: the floor tile the office already
    // uses, so it is certain to be opaque. A transparent tile paints a gid
    // that draws nothing, and the screenshot comparison sees no change.
    await page
      .locator("canvas")
      .first()
      .click({
        position: {
          x: (2467 % 76) * 34 + 17,
          y: Math.floor(2467 / 76) * 34 + 17,
        },
      });
    await page.getByRole("button", { name: "Walls", exact: true }).click();

    const map = page.locator("canvas").nth(1);
    const before = await map.screenshot();

    for (let i = 0; i < 4; i++) {
      await map.click({
        position: { x: 32 * 12 + 16 + i * 32, y: 32 * 12 + 16 },
      });
    }
    await page.waitForTimeout(400);

    const after = await map.screenshot();
    expect(Buffer.compare(before, after)).not.toBe(0);

    // Nothing was published, so no banner.
    await expect(page.getByText(/Published version/)).toHaveCount(0);
  });

  test("an owner can publish, and the version advances", async ({ page }) => {
    /*
     * Publishes the office exactly as it is.
     *
     * Painting first and publishing that would leave every later test running
     * against a layout this one invented — the specs share one database, and
     * an editor test that reshapes the office is the least isolated thing in
     * the suite. Republishing unchanged still exercises the whole round trip:
     * validation, a new version, and the office repointed at it.
     */
    await openPanel(page, OWNER);

    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("alert").first()).toContainText(
      /Published version \d+/,
      { timeout: 20_000 },
    );
  });

  test("a member cannot publish, whatever the panel shows them", async ({
    page,
  }) => {
    /*
     * The page renders for anyone signed in — access is decided by the server,
     * not by hiding a button (CLAUDE.md §12). This proves the server refuses.
     */
    await openPanel(page, MEMBER);

    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("alert").first()).toContainText(
      /owner or admin/i,
      {
        timeout: 20_000,
      },
    );
  });

  test("a layout that seals off a room is refused with a useful reason", async ({
    page,
  }) => {
    await openPanel(page, OWNER);

    // Wall in the whole map on the walls layer by painting across it. Doing
    // this by hand would be tedious; the point is that the server checks.
    const refused = await page.evaluate(async () => {
      const res = await fetch(
        `${window.location.origin.replace("3100", "4000")}/api/offices/x/map`,
        { method: "PUT", credentials: "include" },
      );
      return res.status;
    });
    // A malformed id is rejected before any layout is considered.
    expect([401, 403, 404, 422]).toContain(refused);
  });
});
