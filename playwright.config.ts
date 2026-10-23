import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI);

// Each run starts its own server, so it never tests another checkout's files or
// `pnpm dev` (which serves no fixtures). The default port is one above `pnpm dev`'s
// 4321, so the suite runs while the dev server is up; E2E_PORT picks another, so
// several checkouts can run it at once. An empty or invalid E2E_PORT falls back to
// the default instead of becoming port 0.
const port = Number(process.env.E2E_PORT) || 4322;
const origin = `http://127.0.0.1:${port}`;

// Every browser in the suite goes through a proxy that refuses, with the loopback exempt. Playwright's
// routes stub the stats host and everything else the pages link to, but they miss some requests (a download
// in Chromium and WebKit) and WebKit opens a TLS connection to the real host of every https page it routes.
// Through this proxy those fail instead of reaching the network, so a test can't leave the machine by accident.
// Nothing listens on the discard port (9). tests/unit/playwright-config.test.ts pins all of this, and the tests that
// run Umami's real tracker use a logging proxy of their own (tests/helpers/umami.ts), which takes its place.
const refusingProxy = { server: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost" };

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    // scripts/serve.ts listens on the loopback interface only.
    baseURL: origin,
    proxy: refusingProxy,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `node scripts/serve.ts --root site --port ${port} --fixtures tests/e2e/fixtures`,
    url: `${origin}/`,
    reuseExistingServer: false,
  },
});
