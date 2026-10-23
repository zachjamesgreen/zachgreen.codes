// Umami's tracker is the one script on the site, and it lives on another host. These tests
// keep three promises about it:
//   - the tag every page carries is written down once (scripts/lib/site.ts), and is the
//     one the CSP allows;
//   - nothing automated ever reaches the stats host: every browser test, script and
//     Lighthouse run has it stubbed or blocked, and a new spec can't skip that by importing
//     Playwright's `test` directly;
//   - the tracker the e2e tests run is the version the server runs, and it still keeps the
//     promise on the pages: no cookie, and storage only to read the opt-out flag.

import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parse } from "yaml";

import { ORIGIN, productionCsp, STATS_ORIGIN, stubStats, TRACKER_TAG, UMAMI_WEBSITE_ID } from "../../scripts/lib/site.ts";
import { localOnly } from "../helpers/local-only.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, ROOT), "utf8");

/** Every file matching `pattern` under the repo, as a path relative to it. */
async function files(pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const file of glob(pattern, { cwd: ROOT.pathname })) found.push(file);
  return found.toSorted();
}

describe("the tracker tag", () => {
  it("is the one script tag the brief gives, built from the shared constants", () => {
    assert.equal(
      TRACKER_TAG,
      '<script defer src="https://stats.zachgreen.codes/insights" data-website-id="46dfc462-2f24-41e2-a49c-1f11c482fc26" data-domains="zachgreen.codes"></script>',
    );
  });

  it("has a UUID for a website ID, and a bare https origin on the apex's own domain for the stats host", () => {
    assert.match(UMAMI_WEBSITE_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(STATS_ORIGIN, `https://stats.${new URL(ORIGIN).hostname}`);
  });

  it("is on a host the site's CSP allows scripts and requests from, and the CSP allows no inline script", async () => {
    const csp = productionCsp();
    const directive = (name: string) => csp.split(";").map((part) => part.trim().split(/\s+/)).find(([key]) => key === name)?.slice(1) ?? [];
    assert.ok(directive("script-src").includes(STATS_ORIGIN), "script-src must allow the stats host, for the script");
    assert.ok(directive("connect-src").includes(STATS_ORIGIN), "connect-src must allow the stats host, for /api/send");
    assert.deepEqual(
      directive("script-src").filter((source) => /unsafe|data:|blob:|\*/.test(source)),
      [],
    );
  });
});

describe("stubStats", () => {
  it("routes every URL on the stats host, and answers each with an empty script", async () => {
    const routed: { pattern: string; handler: (route: unknown) => unknown }[] = [];
    await stubStats({ route: async (pattern: string, handler: (route: unknown) => unknown) => void routed.push({ pattern, handler }) } as never);
    assert.equal(routed.length, 1);
    assert.equal(routed[0]!.pattern, `${STATS_ORIGIN}/**`);

    const answers: unknown[] = [];
    await routed[0]!.handler({ fulfill: async (answer: unknown) => void answers.push(answer) });
    assert.deepEqual(answers, [{ status: 200, contentType: "application/javascript", body: "" }]);
  });
});

describe("the stats host is out of reach of every automated run", () => {
  it("is stubbed by the one test every e2e spec imports, for every test, whether or not the test asks", async () => {
    const helper = await read("tests/helpers/test.ts");
    assert.ok(/\bstubStats\(/.test(helper), "tests/helpers/test.ts must call stubStats");
    assert.ok(/\bauto:\s*true\b/.test(helper), "the stub must be an auto fixture, so no test has to ask for it");
    assert.ok(/export\s+const\s+test\b/.test(helper), "tests/helpers/test.ts must export the extended `test`");
  });

  it("is never bypassed: no e2e spec or helper takes `test` or a browser from @playwright/test itself", async () => {
    const specs = await files("tests/e2e/**/*.spec.ts");
    assert.ok(specs.length >= 10, `found only ${specs.join(", ")}`);
    // The helpers build on tests/helpers/test.ts: only that one extends Playwright's own.
    const helpers = (await files("tests/helpers/*.ts")).filter((helper) => helper !== "tests/helpers/test.ts");
    const bypasses: string[] = [];
    for (const file of [...specs, ...helpers]) {
      const source = await read(file);
      const fromPlaywright = [...source.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+["']@playwright\/test["']/g)];
      for (const [, typeOnly, clause] of fromPlaywright) {
        if (typeOnly) continue;
        // A namespace or default import hands over everything, `test` included.
        if (!clause!.startsWith("{")) bypasses.push(`${file}: ${clause}`);
        else {
          const names = clause!
            .slice(1, -1)
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== "" && !name.startsWith("type "))
            .map((name) => name.split(/\s+as\s+/)[0]!);
          for (const name of names) {
            if (["test", "chromium", "firefox", "webkit", "_electron", "_android", "default"].includes(name)) bypasses.push(`${file}: ${name}`);
          }
        }
      }
      if (/\brequire\(\s*["']@playwright\/test|import\(\s*["']@playwright\/test/.test(source)) bypasses.push(`${file}: dynamic import`);
      // A context or page made by hand isn't the `context` fixture, so it has no stub unless the file adds one.
      if (/\.(?:newContext|newPage|launch|launchPersistentContext|connect)\(/.test(source) && !/\bstubStats\(/.test(source)) {
        bypasses.push(`${file}: makes a browser context or page of its own, and never calls stubStats`);
      }
    }
    for (const spec of specs) {
      if (!/from\s+["']\.\.\/helpers\/(?:test|umami)\.ts["']/.test(await read(spec))) bypasses.push(`${spec}: does not import ../helpers/test.ts`);
    }
    assert.deepEqual(bypasses, []);
  });

  // A route can't stub `request`: it is Node's HTTP client, not the browser. So tests/helpers/test.ts makes it local.
  it("is not reachable through the `request` fixture, which only talks to the local server", async () => {
    assert.ok(/\brequest:\s*async[\s\S]*\blocalOnly\(/.test(await read("tests/helpers/test.ts")), "tests/helpers/test.ts must wrap `request` with localOnly");

    const sent: unknown[][] = [];
    const request = localOnly({ get: (...args: unknown[]) => sent.push(args), fetch: (...args: unknown[]) => sent.push(args), dispose: () => undefined } as never, "http://127.0.0.1:4322");
    request.get("/about/");
    request.get("http://127.0.0.1:4322/robots.txt");
    assert.equal(sent.length, 2, "the local server must stay reachable");
    for (const url of [`${STATS_ORIGIN}/insights`, "https://zachgreen.codes/", "http://127.0.0.1:9999/"]) {
      assert.throws(() => request.get(url), /only talks to http:\/\/127\.0\.0\.1:4322/, url);
      assert.throws(() => request.fetch(url), /only talks to/, url);
    }
    assert.equal(sent.length, 2, "nothing else was sent");
  });

  it("is stubbed by every script that drives a browser", async () => {
    const drivers: string[] = [];
    for (const script of await files("scripts/*.ts")) {
      const source = await read(script);
      if (/\.(?:launch|connect)\(|\.newPage\(|\.newContext\(/.test(source)) drivers.push(script);
    }
    assert.deepEqual(drivers, ["scripts/og-image.ts", "scripts/resume-pdf.ts"], "a new browser script: add it here, and have it call stubStats");
    for (const script of drivers) assert.ok(/\bstubStats\(/.test(await read(script)), `${script} drives a browser, so it must stub the stats host`);
  });

  it("is blocked in the Lighthouse runs, as the fonts are", async () => {
    const config = JSON.parse(await read("lighthouserc.json"));
    const patterns: string[] = config.ci.collect.settings.blockedUrlPatterns;
    const matches = (pattern: string, url: string) => new RegExp(`^${pattern.split("*").map(RegExp.escape).join(".*")}$`).test(url);
    for (const url of [`${STATS_ORIGIN}/insights`, `${STATS_ORIGIN}/api/send`]) {
      assert.ok(patterns.some((pattern) => matches(pattern, url)), `no pattern in ${patterns.join(" ")} covers ${url}`);
    }
    assert.ok(patterns.includes("*/fonts/*"), "the fonts stay blocked");
  });

  it("is the only external script any page loads, so the link check's skip of that host covers them all", async () => {
    const pages = await files("site/**/*.html");
    assert.ok(pages.length >= 6);
    for (const page of pages) {
      const sources = [...(await read(page)).matchAll(/<script\b[^>]*\ssrc="([^"]*)"/g)].map(([, src]) => src);
      assert.deepEqual(sources, [`${STATS_ORIGIN}/insights`], page);
    }
  });
});

describe("tests/e2e/fixtures/umami-tracker-<version>.js", () => {
  async function fixture() {
    const [path, ...others] = await files("tests/e2e/fixtures/umami-tracker-*.js");
    assert.ok(path, "no tests/e2e/fixtures/umami-tracker-<version>.js");
    assert.deepEqual(others, [], "keep one tracker fixture: the version the server runs");
    return { path, source: await read(path) };
  }

  it("is the version of the Umami image the server runs", async () => {
    const compose = parse(await read("deploy/umami/compose.yaml")) as { services: { umami: { image: string } } };
    const version = /^ghcr\.io\/umami-software\/umami:(\d+\.\d+\.\d+)@sha256:/.exec(compose.services.umami.image)?.[1];
    assert.ok(version, `cannot read the version from ${compose.services.umami.image}`);
    const { path, source } = await fixture();
    assert.equal(path, `tests/e2e/fixtures/umami-tracker-${version}.js`, "the image changed: refresh the fixture (README, Stats, Updates)");
    const header = source.slice(0, source.indexOf("*/"));
    assert.match(header, new RegExp(`Umami ${RegExp.escape(version)} browser tracker`));
    assert.match(header, new RegExp(`github\\.com/umami-software/umami/blob/v${RegExp.escape(version)}/src/tracker/index\\.ts`));
    assert.match(header, /License: MIT/);
  });

  it("is the tracker itself: it reads the tag's attributes and posts events to /api/send", async () => {
    const { source } = await fixture();
    for (const needle of ["data-umami-event", "/api/send", '"website-id"', '"domains"']) {
      assert.ok(source.includes(needle), `the fixture has no ${needle}: is it Umami's tracker?`);
    }
  });

  // What the footer says. A newer tracker that stored anything more must fail here, not on the page.
  it("sets no cookie and writes no storage: it only reads the opt-out flag", async () => {
    const { source } = await fixture();
    const code = source.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
    for (const forbidden of ["cookie", "setItem", "sessionStorage", "indexedDB", "openDatabase", "caches", "sendBeacon", "XMLHttpRequest"]) {
      assert.ok(!code.includes(forbidden), `the tracker now uses ${forbidden}: the footer's "cookie-free" no longer holds`);
    }
    assert.deepEqual([...code.matchAll(/\b(\w*[sS]torage)\b[^;,]{0,40}/g)].map(([, name]) => name).filter((name) => name !== "localStorage"), []);
    assert.deepEqual([...code.matchAll(/getItem\(([^)]*)\)/g)].map(([, key]) => key), ['"umami.disabled"']);
    assert.ok(code.includes('"omit"'), "requests are sent without credentials, so the browser keeps no cookie from the reply either");
  });
});

describe("deploy/nginx/stats.zachgreen.codes.conf", () => {
  // The tracker holds a click on a tracked link until its beacon is answered and has no timeout of its own, so
  // how long nginx waits on a stuck Umami is how long a visitor can wait. pnpm test:nginx proves it in Docker.
  it("gives up on a stuck Umami for /api/send within seconds, and sets no header of its own there", async () => {
    const conf = (await read("deploy/nginx/stats.zachgreen.codes.conf")).replace(/^\s*#.*$/gm, "");
    const block = /location = \/api\/send \{([^}]*)\}/.exec(conf)?.[1];
    assert.ok(block, "no `location = /api/send` in the stats vhost");
    const directives = block
      .split(";")
      .map((directive) => directive.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    assert.deepEqual(directives.toSorted(), [
      "proxy_connect_timeout 2s",
      "proxy_pass http://127.0.0.1:3000",
      "proxy_read_timeout 3s",
      "proxy_send_timeout 3s",
    ]);
    // A location that sets one makes nginx drop every inherited one (the vhost's comment says so), and the rate
    // limit is the login's alone.
    assert.doesNotMatch(block, /add_header|proxy_set_header|proxy_hide_header|limit_req/);
  });
});
