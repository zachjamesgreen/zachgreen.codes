// The harness for running Umami's real tracker in a browser test, without a request leaving the
// machine. tests/e2e/analytics.spec.ts has the tests; this has everything they stand on:
//   - the tracker itself, served from tests/e2e/fixtures/ in place of the stats host's script, and
//     the stats host's /api/send answered, failed or held by the test (runTracker);
//   - the site as the tracker counts it: the production hostname, served by the local server under
//     the production CSP (serveAsProduction), with the places the site links to stubbed;
//   - what a click on each kind of tracked link must end in (LINKS), and a way to watch clicks
//     without letting a download or a new tab through (watchClicks);
//   - a proxy that fails closed (trackerTest): everything a route misses is refused and recorded,
//     and a test in the block fails if anything got that far.
//
// Playwright's routes don't see everything. Verified with a local server standing in for the network:
//   - Chromium and WebKit fetch a download (an <a download> link) outside page and context routes, so a
//     real click on the PDF link would request the real site;
//   - a click that opens a new tab (Ctrl-click) does reach the context's routes, but not the page's;
//   - WebKit opens a TLS connection to the real host of every https page it is given a route for, and
//     sends no request over it. Serving the site as http://zachgreen.codes keeps that off the real site.
// So routes go on the context, tests block the clicks that would download or open a tab, and the proxy
// catches anything left. It refuses what it gets, so nothing reaches the network either way.

import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type { BrowserContext, Page, Route } from "@playwright/test";

import { ORIGIN, productionCsp, STATS_ORIGIN } from "../../scripts/lib/site.ts";
import { expect, test } from "./test.ts";

export const PDF_PATH = "/resume/zach-green-resume.pdf";
export const PROFILE = "zachjamesgreen";

/** Every event name the site may carry, one per kind of link worth counting. */
export const EVENTS = ["resume-pdf-download", "outbound-github", "outbound-linkedin", "email-click", "outbound-tagshelf-repo"] as const;

/**
 * The site as the real tracker counts it. The tracker counts visits to the production hostname only
 * (data-domains), so the pages are served under that name; over plain http, so that WebKit doesn't open a
 * TLS connection to the real server (see the top of this file).
 */
export const PRODUCTION = `http://${new URL(ORIGIN).hostname}`;

const FIXTURES = new URL("../e2e/fixtures/", import.meta.url);
const TRACKER_FIXTURE = fileURLToPath(new URL(readdirSync(FIXTURES).find((file) => /^umami-tracker-.+\.js$/.test(file))!, FIXTURES));

/** What the tracker posts to /api/send, reduced to what the tests read. */
export interface Beacon {
  type: string;
  /** The event's name; a page view has none. */
  name?: string;
  hostname: string;
  url: string;
}

/** How the stats host answers /api/send. */
export type Answer =
  | "ok" // 200 with the JSON Umami sends
  | "abort" // the connection fails
  | "bad-gateway" // nginx's reply when Umami is down: 502 and an HTML page
  | "hang"; // nothing, ever: nginx waits on an Umami that doesn't answer

/**
 * Loads Umami's tracker from the fixture and answers its beacon as `answer` says. Returns every beacon the
 * tracker posted, in order, and `release`, which ends the requests a "hang" is holding the way nginx does
 * after its timeout. `context` must also be serving the site as the production hostname, or the tracker
 * counts nothing (serveAsProduction). Routes are on the context, so a tab the page opens has them too.
 */
export async function runTracker(context: BrowserContext, answer: Answer) {
  const beacons: Beacon[] = [];
  const held: Route[] = [];
  await context.route(`${STATS_ORIGIN}/insights`, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", path: TRACKER_FIXTURE }),
  );
  await context.route(`${STATS_ORIGIN}/api/send`, async (route) => {
    // The page is on another origin and the tracker sends its own headers, so the browser asks first.
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" };
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });

    const { type, payload } = request.postDataJSON();
    beacons.push({ type, name: payload.name, hostname: payload.hostname, url: payload.url });
    switch (answer) {
      case "ok":
        return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ cache: "stub" }) });
      case "abort":
        return route.abort();
      case "bad-gateway":
        return route.fulfill({ status: 502, headers: cors, contentType: "text/html", body: "<html><h1>502 Bad Gateway</h1></html>" });
      case "hang":
        held.push(route);
        return;
    }
  });
  const release = () =>
    Promise.all(
      held.splice(0).map((route) => route.fulfill({ status: 504, contentType: "text/html", body: "<html><h1>504 Gateway Time-out</h1></html>" })),
    );
  return { beacons, release };
}

/**
 * Makes PRODUCTION answer from the local server, with the CSP nginx sends, and the places the site links to
 * answer with a blank page. No request leaves the machine.
 */
export async function serveAsProduction(context: BrowserContext, baseURL: string): Promise<void> {
  const csp = productionCsp();
  await context.route(`${PRODUCTION}/**`, async (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    // Redirects are the page's to follow: the browser resolves a relative Location against PRODUCTION.
    const response = await context.request.fetch(new URL(pathname + search, baseURL).href, { method: request.method(), maxRedirects: 0 });
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });
  await stubDestinations(context);
}

/** Answers github.com and linkedin.com with a blank page. */
export async function stubDestinations(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/(github\.com|www\.linkedin\.com)\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>stub</title><p>${route.request().url()}</p>` }),
  );
}

/**
 * Records, as the page sees it, whether each click had its default prevented by the time it reached the
 * document's bubble phase: the tracker's capture-phase listener has run by then, so `true` means the tracker
 * took the click over, and `false` means it left it to the browser. With `block`, the click is then stopped
 * for good: no download and no new tab, so nothing goes to a network that routes can't see. Survives
 * navigations, which a variable in the page wouldn't.
 */
export async function watchClicks(page: Page, { block }: { block: boolean }): Promise<boolean[]> {
  const clicks: boolean[] = [];
  await page.exposeFunction("recordClick", (defaultPrevented: boolean) => clicks.push(defaultPrevented));
  await page.addInitScript((blocking) => {
    document.addEventListener("click", (event) => {
      (window as unknown as { recordClick(prevented: boolean): void }).recordClick(event.defaultPrevented);
      if (blocking) event.preventDefault();
    });
  }, block);
  return clicks;
}

/** A link the real tracker is run on, and what a click on it must end in. */
export interface Link {
  /** What the link is, for the test's name. */
  kind: string;
  event: (typeof EVENTS)[number];
  path: string;
  selector: string;
  /** Whether the tracker takes a click on it over, and so navigates itself: not for a target="_blank" link. */
  takenOver: boolean;
  /**
   * Starts watching for the click to end where the link points, and resolves when it does, within `timeout`.
   * `clicks` is watchClicks's record. A taken-over link ends at its destination (a mailto link goes nowhere the
   * page can see: Chromium and WebKit report the attempt as a request, Firefox shows nothing). The PDF link isn't
   * taken over, so it ends as the browser's own click: not prevented, which is when it would download.
   */
  arrives: (page: Page, timeout: number, clicks: boolean[]) => Promise<unknown>;
}

const navigatesTo = (url: string) => (page: Page, timeout: number) => page.waitForURL(url, { timeout });

export const LINKS: readonly Link[] = [
  {
    kind: "PDF link",
    event: "resume-pdf-download",
    path: "/resume/",
    selector: `main a[href="${PDF_PATH}"]`,
    takenOver: false,
    arrives: (_page, timeout, clicks) => expect.poll(() => clicks, { timeout }).toEqual([false]),
  },
  {
    kind: "GitHub profile link",
    event: "outbound-github",
    path: "/about/",
    selector: `footer a[href="https://github.com/${PROFILE}"]`,
    takenOver: true,
    arrives: navigatesTo(`https://github.com/${PROFILE}`),
  },
  {
    kind: "LinkedIn link",
    event: "outbound-linkedin",
    path: "/about/",
    selector: `footer a[href="https://www.linkedin.com/in/${PROFILE}/"]`,
    takenOver: true,
    arrives: navigatesTo(`https://www.linkedin.com/in/${PROFILE}/`),
  },
  {
    kind: "tagshelf repository link",
    event: "outbound-tagshelf-repo",
    path: "/tagshelf/",
    selector: `main a[href="https://github.com/${PROFILE}/tagshelf"]`,
    takenOver: true,
    arrives: navigatesTo(`https://github.com/${PROFILE}/tagshelf`),
  },
  {
    kind: "mailto link",
    event: "email-click",
    path: "/about/",
    selector: 'footer a[href^="mailto:"]',
    takenOver: true,
    arrives: (page, timeout) =>
      page.context().browser()!.browserType().name() === "firefox"
        ? Promise.resolve()
        : page.waitForRequest((request) => request.url().startsWith("mailto:"), { timeout }),
  },
];

/** The three kinds of link, one of each, that the failure tests click: an internal PDF, an outbound link, a mailto. */
export const FAILURE_LINKS = LINKS.filter(({ event }) => ["resume-pdf-download", "outbound-github", "email-click"].includes(event));

// ---------------------------------------------------------------------------------------
// The proxy that fails closed
// ---------------------------------------------------------------------------------------

/** What the proxy got: `GET http://host/path` for plain http, `CONNECT host:port` for a tunnel (https). */
export interface EscapeProxy {
  /** The proxy's URL, for a browser context's `proxy.server`. */
  url: string;
  /** Everything it got since the last `take`. */
  take(): string[];
  close(): Promise<void>;
}

/** A proxy on the loopback that refuses every request and tunnel with a 502, and keeps a log of them. */
export async function startEscapeProxy(): Promise<EscapeProxy> {
  const log: string[] = [];
  const server: Server = createServer((request, response) => {
    log.push(`${request.method} ${request.url}`);
    response.writeHead(502, { "content-type": "text/plain" }).end("refused by the test's proxy\n");
  });
  server.on("connect", (request, socket) => {
    log.push(`CONNECT ${request.url}`);
    // The browser may reset the tunnel it asked for. Node hands this socket over unguarded, and an unhandled
    // 'error' on it would be thrown in the worker, to fail whichever test happens to be running.
    socket.on("error", () => undefined);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    take: () => log.splice(0),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The https hosts a test routes. WebKit connects to them anyway, and sends nothing (see the top of this file). */
const ROUTED_HTTPS_HOSTS = [new URL(STATS_ORIGIN).host, "github.com", "www.linkedin.com"].map((host) => `${host}:443`);

/** What the proxy got that a route should have answered: all of it, except WebKit's connections to routed hosts. */
export function escapes(log: string[], browserName: string): string[] {
  return log.filter((entry) => !(browserName === "webkit" && ROUTED_HTTPS_HOSTS.some((host) => entry === `CONNECT ${host}`)));
}

/**
 * `test`, for the tests that run the real tracker. Every browser context in them has a proxy that refuses and
 * logs everything not on this machine (the local server is exempt), and a test fails if the log holds
 * anything a route should have answered. A test that means to escape the routes, to see the proxy catch it,
 * takes the log itself, and so owns it.
 */
export const trackerTest = test.extend<{ escaped: void }, { escapeProxy: EscapeProxy }>({
  escapeProxy: [
    async ({}, use) => {
      const proxy = await startEscapeProxy();
      await use(proxy);
      await proxy.close();
    },
    { scope: "worker" },
  ],
  proxy: async ({ escapeProxy }, use) => {
    await use({ server: escapeProxy.url, bypass: "127.0.0.1,localhost" });
  },
  escaped: [
    async ({ escapeProxy, browserName }, use) => {
      escapeProxy.take();
      await use();
      expect(escapes(escapeProxy.take(), browserName), "reached the proxy, which refused them: a route missed these").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
