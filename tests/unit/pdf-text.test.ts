import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { htmlWords } from "../helpers/pdf-text.ts";

describe("htmlWords", () => {
  it("lowercases and splits on anything that isn't a letter or a digit", () => {
    assert.deepEqual(htmlWords("Web Developer, Settlor: Dec 2021 - present"), ["web", "developer", "settlor", "dec", "2021", "present"]);
  });

  it("splits an email address and a URL into their parts", () => {
    assert.deepEqual(htmlWords("zachjamesgreen@gmail.com github.com/zachjamesgreen"), [
      "zachjamesgreen",
      "gmail",
      "com",
      "github",
      "com",
      "zachjamesgreen",
    ]);
  });

  it("applies NFKC, so a PDF's ligature glyphs read as their letters", () => {
    assert.deepEqual(htmlWords("ﬁle ﬂow Ｖｕｅ ３"), ["file", "flow", "vue", "3"]);
  });

  it("keeps non-ASCII letters, and drops the empty strings around separators", () => {
    assert.deepEqual(htmlWords("  -- Café, ok?\n\n"), ["café", "ok"]);
    assert.deepEqual(htmlWords(""), []);
  });
});
