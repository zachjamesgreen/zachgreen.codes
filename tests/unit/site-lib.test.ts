// scripts/lib/site.ts decides whether the checks that need the web fonts run, by
// reading the font files out of site.css. A parse that missed them would decide
// wrongly, so the parse is tested here.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { fontFaceUrls } from "../../scripts/lib/site.ts";

describe("fontFaceUrls", () => {
  it("returns the url() sources of @font-face rules and nothing else, in order", () => {
    const css = `
      /* @font-face { src: url("/fonts/commented-out.woff2"); } */
      @layer base {
        @font-face { font-family: A; src: url("/fonts/a.woff2") format("woff2"); }
      }
      body { background: url("/img/bg.png"); }
      @font-face { font-family: B; src: url('../fonts/b.woff2') format("woff2"), url(/fonts/b.woff) format("woff"); }
      @font-face { font-family: "A Fallback"; src: local("Menlo"), local("DejaVu Sans Mono"); }
    `;
    assert.deepEqual(fontFaceUrls(css), ["/fonts/a.woff2", "../fonts/b.woff2", "/fonts/b.woff"]);
  });

  it("finds site.css's font files, all of them woff2 files under /fonts/", async () => {
    const urls = fontFaceUrls(await readFile(new URL("../../site/css/site.css", import.meta.url), "utf8"));
    assert.ok(urls.length > 0, "site.css loads no font file");
    for (const url of urls) assert.match(url, /^\/fonts\/[^/]+\.woff2$/);
  });
});
