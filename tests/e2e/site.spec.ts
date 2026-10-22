// The shared page shell and the site-wide rules, checked on every public page
// in PAGES and on the styled 404 page. A page in PAGES gets every check here,
// and tests/unit/pages.test.ts makes sure every page is in PAGES.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { codePointsOutside, MONOLISA_RANGES } from "../../scripts/font-metrics.ts";
import { CONTACT_EMAIL, FONT_FAMILIES, haveFonts, loadedFamilies, NOT_FOUND_PATH, ORIGIN } from "../../scripts/lib/site.ts";
import { AXE_TAGS } from "../helpers/axe.ts";
import { PAGES } from "../helpers/pages.ts";

const WIDTHS = [320, 768, 1280] as const;

/** Any unknown path gets the styled 404 page, with a 404 status. */
const NOT_FOUND = { path: NOT_FOUND_PATH, name: "404" } as const;

/** Every page that carries the shared header and footer. */
const ALL: readonly { path: string; name: string }[] = [...PAGES, NOT_FOUND];

// The fonts are never committed, so CI runs without them.
const HAVE_FONTS = haveFonts();
const FONT_FILE = /\/fonts\/[^/\s"]+\.woff2\b/;

/** Without the fonts, every font request fails: expected in CI, a bug anywhere else. */
const missingFont = (text: string) => !HAVE_FONTS && FONT_FILE.test(text);

/** The root's scroll and client widths: equal unless something sticks out sideways. */
const rootWidths = (page: Page) =>
  page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));

/** What every page shares, read once per page. */
async function survey(page: Page) {
  const pages = [];
  for (const { path } of ALL) {
    await page.goto(path);
    pages.push({
      path,
      title: await page.title(),
      description: await page.locator('meta[name="description"]').getAttribute("content"),
      stylesheets: await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")!)),
      // aria-current="page" marks the current page's link, so it's the one allowed difference.
      header: (await page.locator("body > header").evaluate((header) => header.outerHTML)).replace(/\s+aria-current="page"/g, ""),
      footer: (await page.locator("body > footer").evaluate((footer) => footer.outerHTML)).replace(/\s+aria-current="page"/g, ""),
    });
  }
  return pages;
}

test("every page has a non-empty title and meta description, and no two pages share either", async ({ page }) => {
  const pages = await survey(page);
  for (const { path, title, description } of pages) {
    expect(title.trim(), `${path} title`).not.toBe("");
    expect(description?.trim(), `${path} description`).toBeTruthy();
  }
  expect(new Set(pages.map(({ title }) => title)).size, "unique titles").toBe(pages.length);
  expect(new Set(pages.map(({ description }) => description)).size, "unique descriptions").toBe(pages.length);
});

test("every page has the same header and footer, apart from aria-current", async ({ page }) => {
  const [first, ...rest] = await survey(page);
  expect(first!.header).toContain('class="site-header"');
  expect(first!.footer).toContain('class="site-footer"');
  for (const { path, header, footer } of rest) {
    expect(header, `${path} header`).toBe(first!.header);
    expect(footer, `${path} footer`).toBe(first!.footer);
  }
});

test("every page loads site.css once, with the same ?v=N", async ({ page }) => {
  const pages = await survey(page);
  const versions = pages.map(({ path, stylesheets }) => {
    const site = stylesheets.filter((href) => href.startsWith("/css/site.css"));
    expect(site, path).toHaveLength(1);
    expect(site[0], path).toMatch(/^\/css\/site\.css\?v=\d+$/);
    return site[0];
  });
  expect(new Set(versions).size).toBe(1);
});

for (const { path, name } of ALL) {
  const notFound = path === NOT_FOUND.path;

  test.describe(`${name} (${path})`, () => {
    test("loads with no console errors, page errors or failed requests", async ({ page }) => {
      const problems: string[] = [];
      let documentUrl = "";
      // Chromium and WebKit log the 404 page's own status as a console error.
      const expected = (text: string, url: string) => missingFont(`${text} ${url}`) || (notFound && url === documentUrl && /\b404\b/.test(text));
      page.on("console", (message) => {
        if (message.type() === "error" && !expected(message.text(), message.location().url)) problems.push(`console: ${message.text()}`);
      });
      page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
      page.on("requestfailed", (request) => {
        if (!missingFont(request.url())) problems.push(`failed: ${request.url()} ${request.failure()?.errorText}`);
      });
      page.on("response", (response) => {
        const url = response.url();
        const fine = response.status() < 400 || missingFont(url) || (notFound && url === documentUrl);
        if (!fine) problems.push(`${response.status()}: ${url}`);
      });

      documentUrl = new URL(path, test.info().project.use.baseURL).href;
      const response = await page.goto(path);
      expect(response!.status()).toBe(notFound ? 404 : 200);
      await loadedFamilies(page);
      expect(problems).toEqual([]);
    });

    for (const width of [320, 1280]) {
      test(`no axe violations at WCAG 2.2 AA, ${width}px wide`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target.join(" ")) }))).toEqual([]);
      });
    }

    test("nothing overflows sideways at 320, 768 or 1280px (screenshots attached)", async ({ page }, testInfo) => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await loadedFamilies(page);
        const { scrollWidth, clientWidth } = await rootWidths(page);
        expect.soft(scrollWidth, `${width}px`).toBeLessThanOrEqual(clientWidth);
        await testInfo.attach(`${name}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      }
    });

    // MonoLisa is wider than the fallback fonts, so fitting in them proves nothing here.
    test("with the web fonts loaded, nothing overflows sideways at 320px", async ({ page }) => {
      test.skip(!HAVE_FONTS, "needs the web fonts in site/fonts/");
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(path);
      expect(await loadedFamilies(page)).toEqual(expect.arrayContaining([...FONT_FAMILIES]));
      const { scrollWidth, clientWidth } = await rootWidths(page);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    });

    test("has exactly one h1", async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("h1")).toHaveCount(1);
    });

    test(notFound ? "has no canonical link" : `has the canonical link ${ORIGIN}${path}`, async ({ page }) => {
      await page.goto(path);
      const canonical = page.locator('link[rel="canonical"]');
      if (notFound) await expect(canonical).toHaveCount(0);
      else await expect(canonical).toHaveAttribute("href", `${ORIGIN}${path}`);
    });

    test('aria-current="page" marks exactly the header links to this page', async ({ page }) => {
      await page.goto(path);
      const links = await page
        .locator("body > header a")
        .evaluateAll((anchors) => anchors.map((a) => ({ href: a.getAttribute("href"), current: a.getAttribute("aria-current") })));
      for (const { href, current } of links) expect(current, `${href}`).toBe(href === path ? "page" : null);
    });

    // The CSP is `style-src 'self'` with no inline scripts (deploy/nginx/snippets/security-headers.conf).
    test("has no inline styles or scripts", async ({ page }) => {
      await page.goto(path);
      const inline = await page.evaluate(() => ({
        styleAttributes: [...document.querySelectorAll("[style]")].map((element) => element.outerHTML.slice(0, 80)),
        styleElements: document.querySelectorAll("style").length,
        inlineScripts: [...document.querySelectorAll("script:not([src])")].map((script) => script.outerHTML.slice(0, 80)),
        handlers: [...document.querySelectorAll("*")].flatMap((element) =>
          [...element.attributes].filter(({ name }) => name.startsWith("on")).map(({ name }) => `${element.tagName.toLowerCase()}[${name}]`),
        ),
        scriptUrls: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")!).filter((href) => /^\s*javascript:/i.test(href)),
      }));
      expect(inline).toEqual({ styleAttributes: [], styleElements: 0, inlineScripts: [], handlers: [], scriptUrls: [] });
    });

    // MonoLisa's files hold only MONOLISA_RANGES; anything else would quietly
    // render in the fallback font. The terminal snapshot is exempt.
    test("text set in MonoLisa uses only characters MonoLisa has", async ({ page }) => {
      await page.goto(path);
      const texts = await page.evaluate(() => {
        const found: { where: string; text: string }[] = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const element = node.parentElement!;
          if (!node.textContent!.trim() || element.closest(".tui-frame")) continue;
          if (!getComputedStyle(element).fontFamily.replace(/^["']/, "").startsWith("MonoLisa")) continue;
          found.push({ where: `${element.tagName.toLowerCase()}${element.className ? `.${element.className}` : ""}`, text: node.textContent! });
        }
        return found;
      });
      expect(texts.length, "some text is set in MonoLisa").toBeGreaterThan(0);
      const misses = texts.flatMap(({ where, text }) => {
        // codePointsOutside skips whitespace, but a no-break space isn't in MonoLisa either.
        const spaces = [...text].filter((char) => /\s/u.test(char) && !/[ \t\n\r]/.test(char)).map((char) => char.codePointAt(0)!);
        const outside = [...codePointsOutside(text, MONOLISA_RANGES), ...spaces];
        const characters = outside.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${String.fromCodePoint(cp)}`);
        return outside.length > 0 ? [{ where, text: text.trim().slice(0, 60), characters }] : [];
      });
      expect(misses).toEqual([]);
    });

    // A mailto link, lightly obfuscated against scrapers.
    test("the footer email is a mailto link whose address is entity-encoded in the source", async ({ page }) => {
      const source = await (await page.request.get(path)).text();
      expect(source).not.toMatch(/zachjamesgreen@|@gmail|gmail\.com/);
      await page.goto(path);
      const email = page.locator('body > footer a[href^="mailto:"]');
      await expect(email).toHaveAttribute("href", `mailto:${CONTACT_EMAIL}`);
      await expect(email).toHaveText(CONTACT_EMAIL);
    });

    // A linked card's ::after stretches its link over the whole card, so it can cover
    // the card's other controls.
    test("nothing inside a linked card is covered by its stretched link", async ({ page }) => {
      await page.goto(path);
      const covered = await page.locator(".card:has(.card__link) :is(a[href], button)").evaluateAll((controls) =>
        controls
          .filter((control) => {
            control.scrollIntoView({ block: "center" });
            const box = control.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return !hit || !(hit === control || control.contains(hit));
          })
          .map((control) => control.outerHTML.slice(0, 80)),
      );
      expect(covered).toEqual([]);
    });

    // A keyboard-only visitor.
    test("keyboard: the first Tab shows the skip link, Enter moves focus to main, and every control shows a focus outline", async ({
      page,
    }) => {
      await page.goto(path);
      await page.keyboard.press("Tab");
      const skip = page.locator(".skip-link");
      await expect(skip).toBeFocused();
      const box = (await skip.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.width).toBeGreaterThan(1);
      expect(box.height).toBeGreaterThan(1);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await page.keyboard.press("Enter");
      await expect(page.locator("main#main")).toBeFocused();

      await page.goto(path);
      const FOCUSABLE = "a[href], button, [tabindex='0']";
      const focusable = await page.locator(FOCUSABLE).count();
      const outlines: { element: string; style: string; width: number; color: string }[] = [];
      for (let i = 0; i < focusable; i++) {
        await page.keyboard.press("Tab");
        outlines.push(
          await page.evaluate((selector) => {
            const element = document.activeElement!;
            const style = getComputedStyle(element);
            // The same link can appear twice (nav and hero), so its place in the document identifies it.
            const index = [...document.querySelectorAll(selector)].indexOf(element);
            const text = element.textContent!.trim().slice(0, 30);
            return {
              element: `#${index} ${element.tagName.toLowerCase()}[href=${element.getAttribute("href")}] ${text}`,
              style: style.outlineStyle,
              width: parseFloat(style.outlineWidth),
              color: style.outlineColor,
            };
          }, FOCUSABLE),
        );
      }
      expect(outlines.map(({ element }) => element).filter((element) => element.startsWith("#-1")), "focus left the links and buttons").toEqual([]);
      expect(new Set(outlines.map(({ element }) => element)).size, "Tab reached every link and button").toBe(focusable);
      for (const { element, style, width, color } of outlines) {
        expect(style, element).not.toBe("none");
        expect(width, element).toBeGreaterThanOrEqual(3);
        expect(color, element).not.toMatch(/^(transparent|rgba\(.*,\s*0\))$/);
      }
    });
  });
}

// JavaScript off, or blocked. The site has none of its own, so
// every page and every header link must work without it.
test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  for (const { path, name } of ALL) {
    test(`${name} (${path}) renders its h1, and every header link loads its page`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      const links = page.locator("body > header a:not(.skip-link)");
      const count = await links.count();
      expect(count).toBeGreaterThanOrEqual(4);

      for (let i = 0; i < count; i++) {
        await page.goto(path);
        const link = links.nth(i);
        const target = new URL((await link.getAttribute("href"))!, page.url());
        const here = new URL(page.url());
        const sameDocument = target.hash !== "" && target.pathname === here.pathname;
        const targetDocument = new URL(target.pathname, target).href;
        const navigation = sameDocument
          ? undefined
          : page.waitForResponse((response) => response.request().isNavigationRequest() && response.url() === targetDocument);

        await link.click();
        await expect(page).toHaveURL(target.href);
        if (navigation) expect((await navigation).status(), target.pathname).toBe(200);
        await expect(page.locator("h1")).toBeVisible();
        if (target.hash) await expect(page.locator(target.hash)).toBeInViewport();
      }
    });
  }
});
