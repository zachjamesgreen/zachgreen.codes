// Renders the site's raster images (spec §8): the 1200x630 social preview from
// scripts/og.html, and the PNG icons from site/favicon.svg. The PNGs are
// committed, because the server has no build step.
//
//   pnpm og:image      writes site/img/og.png, site/favicon-32.png and site/apple-touch-icon.png
//
// og.html is served beside the site, so it sets itself in the real site.css and
// fonts. The fonts are never committed, so this runs where site/fonts/ exists
// (Zach's machine), not in CI. It refuses to write a preview set in fallback
// fonts.

import { chromium, type Browser } from "@playwright/test";

import { startServer } from "./serve.ts";

export const OG_IMAGE = "site/img/og.png";
export const ICONS = [
  { file: "site/favicon-32.png", size: 32 },
  { file: "site/apple-touch-icon.png", size: 180 },
] as const;

/** The web fonts the preview must be set in (spec §5.4). */
const FAMILIES = ["Calling Code", "MonoLisa"];

/** Screenshots `${baseUrl}/__fixtures__/og.html` at 1200x630 into `outFile`. */
export async function renderOgImage(browser: Browser, baseUrl: string, outFile: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  try {
    const url = new URL("/__fixtures__/og.html", baseUrl).href;
    const response = await page.goto(url);
    if (!response?.ok()) throw new Error(`${url} answered ${response?.status()}`);

    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', ""));
    });
    const missing = FAMILIES.filter((family) => !loaded.includes(family));
    if (missing.length > 0) {
      throw new Error(`${missing.join(" and ")} did not load. Copy the font files into site/fonts/ first (spec §5.4).`);
    }

    await page.screenshot({ path: outFile, type: "png" });
  } finally {
    await page.close();
  }
}

/** Screenshots `${baseUrl}/favicon.svg` into a square PNG of `size` pixels. */
export async function renderIcon(browser: Browser, baseUrl: string, outFile: string, size: number): Promise<void> {
  // The SVG has a viewBox and no width or height, so as a document it scales to the viewport.
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  try {
    const url = new URL("/favicon.svg", baseUrl).href;
    const response = await page.goto(url);
    if (!response?.ok()) throw new Error(`${url} answered ${response?.status()}`);
    await page.screenshot({ path: outFile, type: "png" });
  } finally {
    await page.close();
  }
}

if (import.meta.main) {
  // scripts/ goes out under /__fixtures__/, where og.html is; site/ is the root.
  const server = await startServer({ root: "site", fixturesDir: "scripts" });
  const browser = await chromium.launch();
  try {
    await renderOgImage(browser, server.url, OG_IMAGE);
    console.log(`Wrote ${OG_IMAGE}`);
    for (const { file, size } of ICONS) {
      await renderIcon(browser, server.url, file, size);
      console.log(`Wrote ${file}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
}
