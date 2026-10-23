// The HTTP behaviour zachgreen.codes and stats.zachgreen.codes must have, checked against
// a running nginx. `pnpm test:nginx` runs these against the repo config in Docker and
// `pnpm test:live` against production, so the two can't drift apart.
//
// Uses undici's own fetch and Agent (the pinned undici 8), not Node's global fetch,
// which bundles a different undici major.

import assert from "node:assert/strict";
import { lookup as dnsLookup } from "node:dns";
import { connect, isIP, type LookupFunction } from "node:net";

import { Agent, fetch, type Headers } from "undici";

export interface AssertionOptions {
  /** HTTPS origin of the apex host, e.g. "https://zachgreen.codes" or "https://zachgreen.codes:49153". */
  base: string;
  /**
   * Plain-HTTP origin of the apex host. Defaults to `base` with the http scheme and its
   * default port, which is right for production. The Docker test publishes ephemeral
   * ports, so it has to say where port 80 ended up.
   */
  httpBase?: string;
  /** Connect to this IP for the apex and www hosts instead of resolving them, like `curl --resolve`. */
  resolveTo?: string;
  /** Accept any TLS certificate. The Docker test's certificate is self-signed. */
  insecureTls?: boolean;
  /** Production has the brotli module; the stock nginx Docker image doesn't, so it serves gzip. */
  expectBrotli: boolean;
  /**
   * A .woff2 under /fonts/ to check the year-long immutable caching on, e.g.
   * "/fonts/callingcode-regular-webfont.woff2". The fonts are gitignored, so only a server
   * that has them can serve one. Without it that check is skipped, and runAssertions says so.
   */
  fontPath?: string;
}

// The policy the site is built for, written out here rather than read from the nginx
// config, so a change to either one fails until the other matches.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://stats.zachgreen.codes",
  "connect-src 'self' https://stats.zachgreen.codes",
  "img-src 'self' data:",
  "style-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=86400",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

// The brand link in the site header. nginx's built-in error pages have an <h1> too, so
// this is what tells the site's own 404 page apart from them.
const SITE_MARKER = 'class="site-brand"';

interface Reply {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Runs every check, then throws one error listing all the failures, so a broken config
 * shows everything that's wrong with it in one run.
 */
export async function runAssertions(opts: AssertionOptions): Promise<void> {
  const https = new URL(opts.base);
  const apex = https.hostname;
  const http = new URL(opts.httpBase ?? opts.base);
  if (opts.httpBase === undefined) {
    http.protocol = "http:";
    http.port = "";
  }
  const www = new URL(https);
  www.hostname = `www.${apex}`;

  const dispatcher = agent(opts, [apex, www.hostname]);

  async function get(origin: URL, path: string, headers: Record<string, string> = {}): Promise<Reply> {
    return send(dispatcher, new URL(path, origin), { headers });
  }

  function assertRedirect(reply: Reply, location: string): void {
    assert.equal(reply.status, 301, "status");
    assert.equal(reply.headers.get("location"), location, "Location");
  }

  function assertSecurityHeaders(reply: Reply): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(reply.headers.get(name), value, name);
    }
  }

  /** `path` is a 404 whose body is the site's own 404 page, byte for byte. */
  async function assertSiteNotFound(path: string): Promise<Reply> {
    const page = await get(https, "/404.html");
    assert.equal(page.status, 200, "/404.html status");
    assert.ok(page.body.includes(SITE_MARKER), `/404.html has no ${SITE_MARKER}: it isn't the site's page`);
    const reply = await get(https, path);
    assert.equal(reply.status, 404, "status");
    assert.ok(reply.body.includes(SITE_MARKER), `the body has no ${SITE_MARKER} (its <h1> is "${h1(reply.body)}")`);
    assert.ok(reply.body === page.body, "the body isn't /404.html");
    return reply;
  }

  const checks: Record<string, () => Promise<void>> = {
    "http://apex/x 301s to https://apex/x": async () => {
      assertRedirect(await get(http, "/x"), `https://${apex}/x`);
    },
    "http://www/x 301s to https://apex/x": async () => {
      const wwwHttp = new URL(http);
      wwwHttp.hostname = www.hostname;
      assertRedirect(await get(wwwHttp, "/x"), `https://${apex}/x`);
    },
    "https://www/about/ 301s to https://apex/about/, with the security headers": async () => {
      const reply = await get(www, "/about/");
      assertRedirect(reply, `https://${apex}/about/`);
      // HSTS has to reach browsers on www too.
      assertSecurityHeaders(reply);
    },
    "/ is 200 with the security headers and no-cache": async () => {
      const reply = await get(https, "/");
      assert.equal(reply.status, 200, "status");
      assertSecurityHeaders(reply);
      assert.equal(reply.headers.get("cache-control"), "no-cache", "Cache-Control");
      // no-cache means "revalidate", which needs a validator to be cheap.
      assert.ok(reply.headers.get("etag"), "ETag is missing");
    },
    "/settlor 301s to /settlor/": async () => {
      assertRedirect(await get(https, "/settlor"), `https://${apex}/settlor/`);
    },
    "an unknown path is a 404 showing the site's 404 page": async () => {
      const reply = await assertSiteNotFound("/nope");
      // `always` is what puts the headers on error responses too.
      assertSecurityHeaders(reply);
    },
    "a directory without index.html is a 404 showing the site's 404 page, not a 403": async () => {
      await assertSiteNotFound("/css/");
    },
    "/.git/HEAD is a 404": async () => {
      assert.equal((await get(https, "/.git/HEAD")).status, 404);
    },
    "/docs/ is a 404": async () => {
      assert.equal((await get(https, "/docs/")).status, 404);
    },
    "CSS is compressed and cached for a day": async () => {
      const reply = await get(https, "/css/site.css", { "accept-encoding": "br, gzip" });
      assert.equal(reply.status, 200, "status");
      assert.equal(reply.headers.get("content-encoding"), opts.expectBrotli ? "br" : "gzip", "Content-Encoding");
      assert.equal(reply.headers.get("cache-control"), "public, max-age=86400", "Cache-Control");
    },
    "the resume PDF is served as application/pdf": async () => {
      const reply = await get(https, "/resume/zach-green-resume.pdf");
      assert.equal(reply.status, 200, "status");
      assert.equal(reply.headers.get("content-type"), "application/pdf", "Content-Type");
      assert.equal(reply.headers.get("cache-control"), "public, max-age=3600", "Cache-Control");
    },
  };

  const skipped: string[] = [];
  const fontCheck = "a font is served as font/woff2 and cached for a year, immutable";
  const { fontPath } = opts;
  if (fontPath === undefined) {
    skipped.push(`${fontCheck} (no fontPath given)`);
  } else {
    checks[fontCheck] = async () => {
      const reply = await get(https, fontPath);
      assert.equal(reply.status, 200, `status of ${fontPath}`);
      assert.equal(reply.headers.get("content-type"), "font/woff2", "Content-Type");
      assert.equal(reply.headers.get("cache-control"), "public, max-age=31536000, immutable", "Cache-Control");
    };
  }
  await runChecks(opts.base, checks, skipped, dispatcher);
}

export interface StatsAssertionOptions {
  /** HTTPS origin of the stats host, e.g. "https://stats.zachgreen.codes" or "https://stats.zachgreen.codes:49153". */
  base: string;
  /** Plain-HTTP origin of the stats host, when it isn't `base` on the default port (the Docker test). */
  httpBase?: string;
  /** Connect to this IP for the stats host instead of resolving it, like `curl --resolve`. */
  resolveTo?: string;
  /** Accept any TLS certificate. The Docker test's certificate is self-signed. */
  insecureTls?: boolean;
  /**
   * The upstream is the Docker test's stub, which answers any other path with the request
   * headers it got, as JSON, so the proxy headers can be checked. In production the upstream
   * is Umami, which doesn't, so that check is skipped there.
   */
  echoUpstream?: boolean;
  /**
   * The upstream is the Docker test's stub, which accepts a /api/send that carries the STUB_HANG_HEADER header and
   * never answers it, so the check that nginx cuts a stuck Umami off within seconds can run. Production's Umami
   * can't be made to hang, so that check is skipped there.
   */
  silentUpstream?: boolean;
  /**
   * A public hostname of the server, e.g. "zachgreen.codes", whose port 3000 must not accept a
   * connection from here: Umami listens on the server's loopback only. Without it that check
   * is skipped, and runStatsAssertions says so.
   */
  privatePortHost?: string;
}

// What nginx adds to every stats.zachgreen.codes HTTPS response. Umami sends its own CSP,
// which the dashboard needs, so nginx adds none, and none of the site's.
const STATS_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=86400",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** The request header that makes the Docker test's stub upstream hold a /api/send open without answering. */
export const STUB_HANG_HEADER = "x-stub-hang";

/** The most the tracker may wait on nginx for its beacon to be answered, when Umami never answers. */
const BEACON_DEADLINE_SECONDS = 5;

// nginx's limit on the login: 5 a minute, plus a burst of 3, so 7 in a row can't all pass.
const LOGIN_ATTEMPTS = 7;
const BOGUS_LOGIN = JSON.stringify({ username: "nginx-check", password: "not-the-password" });

/**
 * The HTTP behaviour stats.zachgreen.codes (Umami behind nginx) must have. Like
 * runAssertions, it runs every check, then throws one error listing all the failures.
 */
export async function runStatsAssertions(opts: StatsAssertionOptions): Promise<void> {
  const https = new URL(opts.base);
  const host = https.hostname;
  const http = new URL(opts.httpBase ?? opts.base);
  if (opts.httpBase === undefined) {
    http.protocol = "http:";
    http.port = "";
  }
  const dispatcher = agent(opts, [host]);

  const get = (origin: URL, path: string, headers: Record<string, string> = {}) => send(dispatcher, new URL(path, origin), { headers });
  const post = (path: string, body: string) =>
    send(dispatcher, new URL(path, https), { method: "POST", body, headers: { "content-type": "application/json", origin: "https://zachgreen.codes" } });

  function assertStatsHeaders(reply: Reply): void {
    for (const [name, value] of Object.entries(STATS_SECURITY_HEADERS)) {
      assert.equal(reply.headers.get(name), value, name);
    }
    assert.notEqual(reply.headers.get("content-security-policy"), CSP, "the site's CSP is on the stats host");
    assert.equal(reply.headers.get("x-powered-by"), null, "X-Powered-By");
  }

  // The site tells visitors its page views are counted cookie-free (the footer), so the two things the
  // tracker talks to must never set one.
  function assertNoCookie(reply: Reply): void {
    assert.equal(reply.headers.get("set-cookie"), null, "Set-Cookie");
  }

  const checks: Record<string, () => Promise<void>> = {
    "http://stats/x 301s to https://stats/x": async () => {
      const reply = await get(http, "/x");
      assert.equal(reply.status, 301, "status");
      assert.equal(reply.headers.get("location"), `https://${host}/x`, "Location");
    },
    "/ has the security headers, and not the site's CSP": async () => {
      const reply = await get(https, "/");
      assert.ok(reply.status < 500, `status ${reply.status}`);
      assertStatsHeaders(reply);
    },
    "/insights is the tracker: 200, JavaScript, loadable from any origin, and sets no cookie": async () => {
      const reply = await get(https, "/insights");
      assert.equal(reply.status, 200, "status");
      assert.match(reply.headers.get("content-type") ?? "", /^(?:application|text)\/javascript\b/, "Content-Type");
      assert.equal(reply.headers.get("access-control-allow-origin"), "*", "Access-Control-Allow-Origin");
      assertStatsHeaders(reply);
      assertNoCookie(reply);
    },
    "/login is 200": async () => {
      const reply = await get(https, "/login");
      assert.equal(reply.status, 200, "status");
      assertStatsHeaders(reply);
    },
    "/api/send, the tracker's beacon, isn't rate-limited, keeps Umami's CORS headers, has the security headers and sets no cookie": async () => {
      for (let i = 1; i <= 10; i++) {
        const reply = await post("/api/send", "{}");
        assert.notEqual(reply.status, 429, `POST ${i} was rate-limited`);
        assert.equal(reply.headers.get("access-control-allow-origin"), "*", `Access-Control-Allow-Origin on POST ${i}`);
        assertStatsHeaders(reply);
        assertNoCookie(reply);
      }
    },
    [`${LOGIN_ATTEMPTS} rapid POSTs to /api/auth/login get at least one 429, all with the security headers`]: async () => {
      const statuses: number[] = [];
      for (let i = 0; i < LOGIN_ATTEMPTS; i++) {
        const reply = await post("/api/auth/login", BOGUS_LOGIN);
        statuses.push(reply.status);
        assertStatsHeaders(reply);
      }
      assert.ok(statuses.includes(429), `no 429 in ${statuses.join(", ")}`);
      assert.notEqual(statuses[0], 429, "the first attempt was already limited");
    },
  };

  const skipped: string[] = [];
  const echoCheck = "the upstream gets Host, X-Real-IP, X-Forwarded-For and X-Forwarded-Proto from nginx, not from the client";
  if (opts.echoUpstream) {
    // /api/send has a location of its own, so it is checked as well as a path that falls to the default one.
    for (const path of ["/echo", "/api/send"]) {
      checks[`${echoCheck} (${path})`] = async () => {
        const forged = "203.0.113.9";
        const reply = await get(https, path, { "x-real-ip": forged, "x-forwarded-for": forged, "x-forwarded-proto": "http" });
        assert.equal(reply.status, 200, "status");
        const seen = JSON.parse(reply.body) as Record<string, string>;
        assert.equal(seen.host, host, "Host");
        assert.ok(isIP(seen.xRealIp ?? "") !== 0, `X-Real-IP "${seen.xRealIp}" isn't an address`);
        assert.notEqual(seen.xRealIp, forged, "X-Real-IP came from the client");
        assert.equal(seen.xForwardedFor, seen.xRealIp, "X-Forwarded-For isn't the client's address alone");
        assert.equal(seen.xForwardedProto, "https", "X-Forwarded-Proto");
      };
    }
  } else {
    skipped.push(`${echoCheck} (no echoing upstream)`);
  }
  // The tracker holds a click on a tracked link until its beacon is answered, with no timeout of its own.
  const silentCheck = `/api/send answers 504 within ${BEACON_DEADLINE_SECONDS} seconds when Umami never answers, with the security headers`;
  if (opts.silentUpstream) {
    checks[silentCheck] = async () => {
      const started = performance.now();
      const reply = await send(dispatcher, new URL("/api/send", https), {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", origin: "https://zachgreen.codes", [STUB_HANG_HEADER]: "1" },
      });
      const seconds = (performance.now() - started) / 1000;
      assert.equal(reply.status, 504, "status");
      assert.ok(seconds < BEACON_DEADLINE_SECONDS, `the 504 took ${seconds.toFixed(1)} seconds`);
      assertStatsHeaders(reply);
    };
  } else {
    skipped.push(`${silentCheck} (no silent upstream)`);
  }
  const portCheck = "port 3000 isn't reachable from outside the server";
  const { privatePortHost } = opts;
  if (privatePortHost === undefined) {
    skipped.push(`${portCheck} (no privatePortHost given)`);
  } else {
    checks[portCheck] = async () => {
      const outcome = await tcpOutcome(privatePortHost, 3000, 3000);
      assert.notEqual(outcome, "open", `TCP to ${privatePortHost}:3000 connected`);
    };
  }

  await runChecks(opts.base, checks, skipped, dispatcher);
}

/** An undici Agent for `opts`, sending `hosts` to opts.resolveTo when that is set. */
function agent(opts: { resolveTo?: string; insecureTls?: boolean }, hosts: string[]): Agent {
  return new Agent({
    connect: {
      rejectUnauthorized: !opts.insecureTls,
      ...(opts.resolveTo !== undefined && { lookup: pinnedLookup(new Set(hosts), opts.resolveTo) }),
    },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });
}

/** One request, redirects not followed, the body read in full. */
async function send(dispatcher: Agent, url: URL, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  const res = await fetch(url, { dispatcher, redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/** Runs every check, closes the dispatcher, then throws one error that lists all the failures. */
async function runChecks(base: string, checks: Record<string, () => Promise<void>>, skipped: string[], dispatcher: Agent): Promise<void> {
  // Never skip quietly.
  for (const name of skipped) console.warn(`nginx check skipped: ${name}`);

  const failures: string[] = [];
  try {
    for (const [name, check] of Object.entries(checks)) {
      try {
        await check();
      } catch (error) {
        failures.push(`- ${name}\n    ${describe(error).replaceAll("\n", "\n    ")}`);
      }
    }
  } finally {
    await dispatcher.close();
  }

  if (failures.length > 0) {
    const total = Object.keys(checks).length;
    const notes = skipped.map((name) => `\n(skipped: ${name})`).join("");
    throw new Error(`${failures.length} of ${total} nginx checks failed against ${base}:\n${failures.join("\n")}${notes}`);
  }
}

/** How a TCP connection to host:port ends within `timeoutMs`: "open", "timed out", or "failed (<code>)". */
function tcpOutcome(host: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (outcome: string) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => done("timed out"));
    socket.once("connect", () => done("open"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(`failed (${error.code ?? error.message})`));
  });
}

/** A `lookup` that sends `hosts` to `address` and resolves everything else normally. */
function pinnedLookup(hosts: ReadonlySet<string>, address: string): LookupFunction {
  const family = isIP(address);
  if (family === 0) throw new TypeError(`resolveTo must be an IP address, got "${address}"`);
  return (hostname, options, callback) => {
    if (!hosts.has(hostname)) {
      dnsLookup(hostname, options, callback);
    } else if (options.all) {
      // net.connect asks for every address when it races IPv4 and IPv6 (autoSelectFamily).
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

/** The message plus its causes: undici reports every network problem as just "fetch failed". */
function describe(error: unknown): string {
  const messages: string[] = [];
  for (let e = error; e !== undefined; e = e instanceof Error ? e.cause : undefined) {
    messages.push(e instanceof Error ? e.message : String(e));
  }
  return messages.join("\ncaused by: ");
}

function h1(html: string): string | undefined {
  const inner = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  return inner?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
