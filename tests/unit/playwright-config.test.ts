// playwright.config.ts picks the e2e server's port from E2E_PORT, so several
// checkouts can run the e2e suite at once. The default, 4322, is not `pnpm dev`'s
// 4321, so the suite runs while the dev server is up. An empty or invalid value, as
// a CI template or a shell `export E2E_PORT=` leaves, must fall back to the default
// rather than become port 0.
//
// It also sends every browser in the suite through a proxy that refuses, with the loopback
// exempt, so a request that gets past Playwright's routes (a download in Chromium and WebKit, and
// the TLS connection WebKit makes to the host of every https page it routes) fails closed instead
// of reaching the network. The tests below pin that.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

interface Loaded {
  baseURL: string;
  command: string;
  proxy: { server: string; bypass?: string } | undefined;
}

/** The config's baseURL, proxy and web server command, with E2E_PORT set to `port` (or unset for undefined). */
function loadConfig(port: string | undefined): Loaded {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (port === undefined) delete env.E2E_PORT;
  else env.E2E_PORT = port;
  const script = `
    const { default: config } = await import("./playwright.config.ts");
    console.log(JSON.stringify({ baseURL: config.use.baseURL, command: config.webServer.command, proxy: config.use.proxy }));
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

describe("playwright.config.ts proxy", () => {
  const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  const { baseURL, proxy } = loadConfig(undefined);

  it("is set, so every test's browser has one", () => {
    assert.ok(proxy, "use.proxy is not set");
  });

  it("is on the loopback, so nothing is sent beyond the machine to be refused", () => {
    const { protocol, hostname } = new URL(proxy!.server);
    assert.equal(protocol, "http:");
    assert.ok(LOOPBACK.has(hostname), `the proxy is at ${hostname}`);
  });

  it("exempts the loopback and nothing else, and the local server is on it", () => {
    const bypass = (proxy!.bypass ?? "").split(",").map((entry) => entry.trim());
    assert.ok(bypass.length > 0 && bypass.every(Boolean), `bypass is "${proxy!.bypass}"`);
    assert.deepEqual(
      bypass.filter((entry) => !LOOPBACK.has(entry)),
      [],
      "bypass exempts something that isn't the loopback, which the suite would then reach for real",
    );
    assert.ok(bypass.includes(new URL(baseURL).hostname), `the local server, ${baseURL}, isn't exempt, so no test could load a page`);
  });

  it("refuses: nothing listens at its port, so a request through it fails", async () => {
    const { hostname, port } = new URL(proxy!.server);
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: hostname, port: Number(port) });
      socket.once("connect", () => (socket.destroy(), resolve("accepted")));
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    });
    assert.equal(outcome, "ECONNREFUSED", `something answers on ${hostname}:${port}: pick a port nothing listens on`);
  });
});
