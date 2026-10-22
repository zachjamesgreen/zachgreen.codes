// The site-wide e2e checks, the meta checks and the sitemap test all walk PAGES in
// tests/helpers/pages.ts, so a page missing from it would silently skip all of them.
// This ties PAGES to the pages that exist: every site/**/index.html, by the URL path
// it is served at.

import assert from "node:assert/strict";
import { glob } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PAGES } from "../helpers/pages.ts";

const SITE = fileURLToPath(new URL("../../site/", import.meta.url));

/** The URL path a site/ index.html is served at: "index.html" is "/", "a/b/index.html" is "/a/b/". */
const pathOf = (file: string) => {
  const dir = dirname(file);
  return dir === "." ? "/" : `/${dir.split(sep).join("/")}/`;
};

describe("PAGES", () => {
  it("lists exactly the pages in site/: one entry per index.html, and none without one", async () => {
    const onDisk = [];
    for await (const file of glob("**/index.html", { cwd: SITE })) onDisk.push(pathOf(file));
    assert.ok(onDisk.length > 0, `no index.html under ${SITE}`);
    assert.deepEqual(PAGES.map(({ path }) => path).toSorted(), onDisk.toSorted());
  });
});
