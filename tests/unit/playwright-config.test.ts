// playwright.config.ts picks the e2e server's port from E2E_PORT, so several
// checkouts can run the e2e suite at once. The default, 4322, is not `pnpm dev`'s
// 4321, so the suite runs while the dev server is up. An empty or invalid value, as
// a CI template or a shell `export E2E_PORT=` leaves, must fall back to the default
// rather than become port 0.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** The config's baseURL and web server command, with E2E_PORT set to `port` (or unset for undefined). */
function loadConfig(port: string | undefined): { baseURL: string; command: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (port === undefined) delete env.E2E_PORT;
  else env.E2E_PORT = port;
  const script = `
    const { default: config } = await import("./playwright.config.ts");
    console.log(JSON.stringify({ baseURL: config.use.baseURL, command: config.webServer.command }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("playwright.config.ts port", () => {
  it("is 4322 when E2E_PORT is unset", () => {
    assert.equal(loadConfig(undefined).baseURL, "http://127.0.0.1:4322");
  });

  it("is 4322 when E2E_PORT is empty, not port 0", () => {
    const { baseURL, command } = loadConfig("");
    assert.equal(baseURL, "http://127.0.0.1:4322");
    assert.match(command, /--port 4322\b/);
  });

  it("is 4322 when E2E_PORT is not a number", () => {
    assert.equal(loadConfig("not-a-port").baseURL, "http://127.0.0.1:4322");
  });

  it("uses E2E_PORT when it is a port number", () => {
    const { baseURL, command } = loadConfig("4567");
    assert.equal(baseURL, "http://127.0.0.1:4567");
    assert.match(command, /--port 4567\b/);
  });
});
