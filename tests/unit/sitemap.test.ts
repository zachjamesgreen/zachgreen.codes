// The files that aren't pages (spec §8): sitemap.xml lists exactly the public
// pages in tests/helpers/pages.ts, robots.txt points at the sitemap, and the
// social preview image and icons have the sizes the platforms expect.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { ORIGIN } from "../../scripts/lib/site.ts";
import { PAGES } from "../helpers/pages.ts";

const read = (path: string) => readFile(new URL(`../../site/${path}`, import.meta.url));

/** Width and height from a PNG's IHDR chunk, which must come first, right after the 8-byte signature. */
function pngSize(png: Buffer, label: string): { width: number; height: number } {
  assert.ok(png.length >= 24, `${label} is too short to be a PNG`);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${label} has no PNG signature`);
  assert.equal(png.toString("latin1", 12, 16), "IHDR", `${label}'s first chunk is not IHDR`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("sitemap.xml", () => {
  it("is a urlset in the sitemap namespace", async () => {
    const xml = (await read("sitemap.xml")).toString("utf8");
    assert.match(xml, /<urlset\b[^>]*\sxmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  });

  it("lists every public page once, with its absolute URL, and nothing else", async () => {
    const xml = (await read("sitemap.xml")).toString("utf8");
    const locs = [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map(([, loc]) => loc);
    assert.deepEqual(locs.toSorted(), PAGES.map(({ path }) => ORIGIN + path).toSorted());
  });
});

describe("robots.txt", () => {
  it("points crawlers at the sitemap", async () => {
    const lines = (await read("robots.txt")).toString("utf8").split(/\r?\n/);
    assert.ok(lines.includes(`Sitemap: ${ORIGIN}/sitemap.xml`), "no `Sitemap: https://zachgreen.codes/sitemap.xml` line");
  });

  it("lets every crawler in", async () => {
    const lines = (await read("robots.txt")).toString("utf8").split(/\r?\n/);
    assert.ok(lines.includes("User-agent: *"));
    assert.ok(!lines.some((line) => /^Disallow:\s*\S/.test(line)), "robots.txt disallows something");
  });
});

describe("images", () => {
  it("og.png is 1200x630", async () => {
    assert.deepEqual(pngSize(await read("img/og.png"), "og.png"), { width: 1200, height: 630 });
  });

  it("favicon-32.png is 32x32", async () => {
    assert.deepEqual(pngSize(await read("favicon-32.png"), "favicon-32.png"), { width: 32, height: 32 });
  });

  it("apple-touch-icon.png is 180x180", async () => {
    assert.deepEqual(pngSize(await read("apple-touch-icon.png"), "apple-touch-icon.png"), { width: 180, height: 180 });
  });

  it("favicon.svg is a square SVG with a viewBox and no script", async () => {
    const svg = (await read("favicon.svg")).toString("utf8");
    assert.match(svg, /<svg\b[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const viewBox = /\sviewBox="0 0 (\d+) (\d+)"/.exec(svg);
    assert.ok(viewBox, "favicon.svg has no `viewBox=\"0 0 w h\"`");
    assert.equal(viewBox[1], viewBox[2], "favicon.svg is not square");
    assert.doesNotMatch(svg, /<script|<style|\sstyle=|\son\w+=/i, "an SVG served under `style-src 'self'` must not carry inline script or style");
  });

  it("favicon.svg is well-formed XML: no `--` inside a comment, which makes browsers show an error page", async () => {
    const svg = (await read("favicon.svg")).toString("utf8");
    for (const [, body] of svg.matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!body!.includes("--"), `a comment contains \`--\`: ${body!.slice(0, 40)}...`);
  });
});
