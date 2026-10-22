// Head metadata, icons and the crawler files (spec §8, "Meta"): Open Graph and
// Twitter tags on every page, a theme-color that matches the page background,
// and icon links that resolve. Titles, descriptions and the shared shell are in
// site.spec.ts.

import { expect, test, type Page } from "@playwright/test";
import { formatHex, parse } from "culori";

import { NOT_FOUND_PATH, ORIGIN } from "../../scripts/lib/site.ts";
import { PAGES } from "../helpers/pages.ts";

const OG_IMAGE = `${ORIGIN}/img/og.png`;

/** Any unknown path gets the styled 404 page, which is not in the sitemap. */
const NOT_FOUND = { path: NOT_FOUND_PATH, name: "404" } as const;

const meta = (page: Page, selector: string) => page.locator(`head > meta[${selector}]`).getAttribute("content");

/** The hex form of a CSS color string, so oklch() and #rrggbb can be compared. */
function hexOf(css: string | null, label: string): string {
  const color = css === null ? undefined : parse(css.trim());
  expect(color, `${label}: culori cannot parse ${JSON.stringify(css)}`).toBeTruthy();
  return formatHex(color!);
}

for (const { path, name } of PAGES) {
  test.describe(`${name} (${path})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(path);
    });

    test("has Open Graph and Twitter tags, with og:url equal to the canonical", async ({ page }) => {
      const canonical = await page.locator('head > link[rel="canonical"]').getAttribute("href");
      expect(canonical).toBe(ORIGIN + path);
      expect(await meta(page, 'property="og:title"')).toBe(await page.title());
      expect(await meta(page, 'property="og:description"')).toBe(await meta(page, 'name="description"'));
      expect(await meta(page, 'property="og:url"')).toBe(canonical);
      expect(await meta(page, 'property="og:image"')).toBe(OG_IMAGE);
      expect(await meta(page, 'name="twitter:card"')).toBe("summary_large_image");
    });

    test("theme-color is the page background", async ({ page }) => {
      const background = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg"));
      expect(hexOf(await meta(page, 'name="theme-color"'), "theme-color")).toBe(hexOf(background, "--bg"));
    });
  });
}

for (const { path, name } of [...PAGES, NOT_FOUND]) {
  test(`${name} (${path}) links an SVG icon, a 32px PNG icon and an apple-touch-icon, and each one loads`, async ({ page, request }) => {
    await page.goto(path);
    const icons = await page.locator('head > link[rel~="icon"], head > link[rel="apple-touch-icon"]').evaluateAll((links) =>
      links.map((link) => ({
        rel: link.getAttribute("rel")!,
        href: link.getAttribute("href")!,
        type: link.getAttribute("type"),
        sizes: link.getAttribute("sizes"),
      })),
    );
    expect(icons.map(({ rel, href }) => `${rel} ${href}`).sort()).toEqual(
      ["apple-touch-icon /apple-touch-icon.png", "icon /favicon-32.png", "icon /favicon.svg"].sort(),
    );

    const svg = icons.find(({ href }) => href === "/favicon.svg")!;
    expect(svg.type).toBe("image/svg+xml");
    expect(svg.sizes).toBe("any");
    const png = icons.find(({ href }) => href === "/favicon-32.png")!;
    expect(png.type).toBe("image/png");
    expect(png.sizes).toBe("32x32");

    for (const { href, type } of icons) {
      const response = await request.get(href);
      expect(response.status(), href).toBe(200);
      expect(response.headers()["content-type"], href).toContain(type ?? "image/png");
      // A malformed image is still a 200, so decode it the way the browser does for an icon.
      const decoded = await page.evaluate(
        (src) =>
          new Promise<boolean>((resolve) => {
            const image = new Image();
            image.src = src;
            image.decode().then(
              () => resolve(true),
              () => resolve(false),
            );
          }),
        href,
      );
      expect(decoded, `${href} decodes as an image`).toBe(true);
    }
  });
}

test("the 404 page has no canonical URL and no Open Graph tags", async ({ page }) => {
  await page.goto(NOT_FOUND.path);
  await expect(page.locator('head > link[rel="canonical"], head > meta[property^="og:"]')).toHaveCount(0);
});

test("the social image, robots.txt and sitemap.xml are served", async ({ request }) => {
  const image = await request.get("/img/og.png");
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toBe("image/png");

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("xml");
});
