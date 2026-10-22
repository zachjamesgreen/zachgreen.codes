// The HTTP behaviour zachgreen.codes must have, checked against a running nginx.
// `pnpm test:nginx` runs these against the repo config in Docker and `pnpm test:live`
// against production, so the two can't drift apart.
//
// Uses undici's own fetch and Agent (the pinned undici 8), not Node's global fetch,
// which bundles a different undici major.

import assert from "node:assert/strict";
import { lookup as dnsLookup } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

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

  const dispatcher = new Agent({
    connect: {
      rejectUnauthorized: !opts.insecureTls,
      ...(opts.resolveTo !== undefined && { lookup: pinnedLookup(new Set([apex, www.hostname]), opts.resolveTo) }),
    },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });

  async function get(origin: URL, path: string, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await fetch(new URL(path, origin), { dispatcher, redirect: "manual", headers });
    return { status: res.status, headers: res.headers, body: await res.text() };
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
    throw new Error(`${failures.length} of ${total} nginx checks failed against ${opts.base}:\n${failures.join("\n")}${notes}`);
  }
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
