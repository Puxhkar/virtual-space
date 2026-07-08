import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 3100;
const API_PORT = 4000;
const BASE_URL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  /*
   * Traces, screenshots and the HTML report go outside the repository.
   *
   * This project lives in an iCloud-synced folder, so every artefact a failed
   * run writes is queued for upload. Seventy-eight megabytes of traces pushed
   * `fileproviderd` to 100% CPU and the machine into swap, which made the
   * suite take twenty minutes and fail seven tests that were not broken.
   * Keeping generated output out of the synced tree removes the whole class.
   */
  outputDir: process.env["CI"] ? "test-results" : "/tmp/vo-e2e/results",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"]
    ? "list"
    : [
        ["list"],
        // Same reason as outputDir: the HTML report bundles a trace viewer,
        // which is thousands of files iCloud would try to sync.
        ["html", { open: "never", outputFolder: "/tmp/vo-e2e/report" }],
      ],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone", "camera"],
        launchOptions: {
          // Synthetic devices, auto-granted. Media tests must not depend on
          // the machine having a webcam, or on someone clicking a permission
          // prompt.
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            // Chrome throttles requestAnimationFrame in backgrounded
            // renderers, which stalls Phaser's update loop. With ten browsers
            // open only one can be foreground, so without these the load test
            // measures Chrome's throttling rather than our server.
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @vo/server dev",
      url: `http://localhost:${API_PORT}/healthz`,
      cwd: "../..",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "pnpm dev",
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
