import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI);

// Several checkouts (git worktrees) can run the e2e suite at once, each on its
// own port. Each run always starts its own server, so it never tests another
// checkout's files, or `pnpm dev` (which serves no fixtures).
// An empty or invalid E2E_PORT falls back to the default instead of becoming port 0.
const port = Number(process.env.E2E_PORT) || 4321;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    // scripts/serve.ts listens on the loopback interface only.
    baseURL: origin,
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
