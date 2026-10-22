// Checks production with the same assertions `pnpm test:nginx` runs against the repo's
// config in Docker, plus the two things only the server has: the brotli module and the
// fonts. It hits the live site, so it isn't part of `pnpm check` or CI. Run it after a
// deploy with `pnpm test:live`; BASE_URL points it at another origin.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { fontFaceUrls, ORIGIN } from "../../scripts/lib/site.ts";
import { runAssertions } from "../nginx/assertions.ts";

const base = process.env.BASE_URL || ORIGIN;

// The font the year-long immutable caching is checked on. The fonts are never committed,
// so only a server they have been copied to (scripts/deploy.sh) can serve one.
const FONT_PATH = "/fonts/callingcode-regular-webfont.woff2";

test(`${base} passes the nginx checks, with brotli and a font`, async () => {
  // A renamed font would otherwise show up as a confusing 404 below.
  const css = await readFile(new URL("../../site/css/site.css", import.meta.url), "utf8");
  assert.ok(fontFaceUrls(css).includes(FONT_PATH), `site/css/site.css no longer loads ${FONT_PATH}: update FONT_PATH in this file`);

  await runAssertions({ base, expectBrotli: true, fontPath: FONT_PATH });
});
