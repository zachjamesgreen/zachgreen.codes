import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { startServer } from "../../scripts/serve.ts";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// `fetch` normalizes `/../` and `%2e%2e` away before sending, which would hide
// the very requests these tests exist to send. node:http sends the path as given.
function get(base: string, path: string, method = "GET"): Promise<Reply> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("startServer", () => {
  // outer/
  //   package.json            <- the traversal target, a sibling of the root
  //   site/                   <- the served root
  //   fixtures/x.html
  let outer: string;
  let withFixtures: Awaited<ReturnType<typeof startServer>>;
  let withoutFixtures: Awaited<ReturnType<typeof startServer>>;

  before(async () => {
    outer = await mkdtemp(join(tmpdir(), "serve-test-"));
    const root = join(outer, "site");
    const fixtures = join(outer, "fixtures");
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "empty"));
    await mkdir(fixtures);
    await writeFile(join(outer, "package.json"), '{"name":"outside-root"}');
    await writeFile(join(root, "index.html"), "<h1>home</h1>");
    await writeFile(join(root, "a", "index.html"), "<h1>a</h1>");
    await writeFile(join(root, "404.html"), "<h1>custom not found</h1>");
    await writeFile(join(root, ".secret"), "top secret");
    await writeFile(join(root, "a", ".secret"), "top secret");
    await writeFile(join(root, "style.css"), "body{}");
    await writeFile(join(root, "doc.pdf"), "%PDF-1.7");
    await writeFile(join(root, "logo.svg"), "<svg/>");
    await writeFile(join(root, "pic.png"), "png");
    await writeFile(join(root, "font.woff2"), "woff2");
    await writeFile(join(root, "sitemap.xml"), "<urlset/>");
    await writeFile(join(root, "robots.txt"), "User-agent: *");
    await writeFile(join(root, "data.bin"), "bin");
    await writeFile(join(fixtures, "x.html"), "<h1>fixture</h1>");
    withFixtures = await startServer({ root, fixturesDir: fixtures });
    withoutFixtures = await startServer({ root });
  });

  after(async () => {
    await withFixtures.close();
    await withoutFixtures.close();
    await rm(outer, { recursive: true, force: true });
  });

  it("serves index.html at /", async () => {
    const res = await get(withoutFixtures.url, "/");
    assert.equal(res.status, 200);
    assert.equal(res.body, "<h1>home</h1>");
    assert.match(String(res.headers["content-type"]), /^text\/html/);
  });

  it("redirects a directory without a trailing slash with a 301", async () => {
    const res = await get(withoutFixtures.url, "/a");
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, "/a/");
  });

  it("keeps the query string when redirecting", async () => {
    const res = await get(withoutFixtures.url, "/a?v=2");
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, "/a/?v=2");
  });

  it("never redirects to a protocol-relative location", async () => {
    const res = await get(withoutFixtures.url, "//a");
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, "/a/");
  });

  it("serves a directory's index.html with a trailing slash", async () => {
    const res = await get(withoutFixtures.url, "/a/");
    assert.equal(res.status, 200);
    assert.equal(res.body, "<h1>a</h1>");
  });

  it("returns 404 with the body of 404.html for a missing path", async () => {
    const res = await get(withoutFixtures.url, "/missing");
    assert.equal(res.status, 404);
    assert.equal(res.body, "<h1>custom not found</h1>");
    assert.match(String(res.headers["content-type"]), /^text\/html/);
  });

  it("returns 404 for a directory that has no index.html", async () => {
    const res = await get(withoutFixtures.url, "/empty/");
    assert.equal(res.status, 404);
  });

  // Both files exist on disk, so these fail unless the dot rule refuses them.
  for (const path of ["/.secret", "/%2esecret", "/a/.secret"]) {
    it(`never serves the dotfile at ${path}`, async () => {
      const res = await get(withoutFixtures.url, path);
      assert.equal(res.status, 404);
      assert.doesNotMatch(res.body, /top secret/);
    });
  }

  it("rejects path traversal, plain or percent-encoded", async () => {
    for (const path of [
      "/../package.json",
      "/%2e%2e/package.json",
      "/%2E%2E/package.json",
      "/..%2fpackage.json",
      "/a/../../package.json",
    ]) {
      const res = await get(withoutFixtures.url, path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(res.body, /outside-root/, path);
    }
  });

  it("does not crash on a null byte or a malformed escape", async () => {
    assert.equal((await get(withoutFixtures.url, "/%00")).status, 404);
    assert.equal((await get(withoutFixtures.url, "/%E0%A4%A")).status, 400);
    assert.equal((await get(withoutFixtures.url, "/")).status, 200);
  });

  it("ignores the query string when locating a file", async () => {
    const res = await get(withoutFixtures.url, "/style.css?v=3");
    assert.equal(res.status, 200);
    assert.equal(res.body, "body{}");
  });

  it("maps file extensions to content types", async () => {
    const expected: Record<string, string> = {
      "/style.css": "text/css; charset=utf-8",
      "/doc.pdf": "application/pdf",
      "/logo.svg": "image/svg+xml",
      "/pic.png": "image/png",
      "/font.woff2": "font/woff2",
      "/sitemap.xml": "application/xml; charset=utf-8",
      "/robots.txt": "text/plain; charset=utf-8",
      "/data.bin": "application/octet-stream",
    };
    for (const [path, type] of Object.entries(expected)) {
      const res = await get(withoutFixtures.url, path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers["content-type"], type, path);
    }
  });

  it("answers HEAD with the headers of GET and no body", async () => {
    const res = await get(withoutFixtures.url, "/style.css", "HEAD");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(res.headers["content-length"], "6");
    assert.equal(res.body, "");
  });

  it("rejects methods other than GET and HEAD with 405", async () => {
    const res = await get(withoutFixtures.url, "/", "POST");
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, "GET, HEAD");
  });

  it("serves fixturesDir under /__fixtures__/ when it is set", async () => {
    const res = await get(withFixtures.url, "/__fixtures__/x.html");
    assert.equal(res.status, 200);
    assert.equal(res.body, "<h1>fixture</h1>");
  });

  it("returns 404 for /__fixtures__/ when fixturesDir is not set", async () => {
    const res = await get(withoutFixtures.url, "/__fixtures__/x.html");
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, /fixture<\/h1>/);
  });

  it("does not let /__fixtures__/ reach outside the fixtures directory", async () => {
    const res = await get(withFixtures.url, "/__fixtures__/../package.json");
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.body, /outside-root/);
  });
});
