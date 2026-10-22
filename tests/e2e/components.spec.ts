// The design system (site/css/site.css) exercised through a test-only page
// that uses every component: tests/e2e/fixtures/components.html, served at
// /__fixtures__/ by the dev server.

import { existsSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

import { AXE_TAGS } from "../helpers/axe.ts";

const FIXTURE = "/__fixtures__/components.html";

const HAVE_FONTS = ["0-MonoLisaCode-normal.woff2", "callingcode-bold-webfont.woff2"].every((file) =>
  existsSync(new URL(`../../site/fonts/${file}`, import.meta.url)),
);

/** Computed values of the given (kebab-case) properties. */
function computed<const P extends string>(locator: Locator, ...properties: P[]): Promise<Record<P, string>> {
  return locator.evaluate(
    (element, names) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
    },
    properties,
  ) as Promise<Record<P, string>>;
}

/** The lengths in one computed box-shadow (x, y, blur, spread), with the color removed. */
function shadowLengths(shadow: string): number[] {
  expect(shadow, "a single shadow").not.toMatch(/,(?![^(]*\))/);
  const lengths = shadow.replace(/[a-z-]+\([^)]*\)/gi, " ").match(/-?\d*\.?\d+px/g) ?? [];
  return lengths.map((length) => parseFloat(length));
}

/** The x and y of a computed `translate`, which is "none" or "x" or "x y". */
function translation(value: string): [number, number] {
  if (value === "none") return [0, 0];
  const [x = 0, y = 0] = value.split(/\s+/).map((part) => parseFloat(part));
  return [x, y];
}

/** A computed `transition-duration` list such as "0.12s, 0.12s", in seconds. */
function seconds(list: string): number[] {
  return list.split(",").map((value) => (value.trim().endsWith("ms") ? parseFloat(value) / 1000 : parseFloat(value)));
}

for (const width of [1280, 320]) {
  test(`no axe violations at WCAG 2.2 AA, ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(FIXTURE);
    const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target.join(" ")) }))).toEqual([]);
  });
}

test(".btn has square corners and a hard shadow with no blur", async ({ page }) => {
  await page.goto(FIXTURE);
  const buttons = await page.locator(".btn").all();
  expect(buttons.length).toBeGreaterThanOrEqual(3);
  for (const button of buttons) {
    const style = await computed(
      button,
      "border-top-left-radius",
      "border-top-right-radius",
      "border-bottom-right-radius",
      "border-bottom-left-radius",
      "box-shadow",
    );
    expect(style["border-top-left-radius"]).toBe("0px");
    expect(style["border-top-right-radius"]).toBe("0px");
    expect(style["border-bottom-right-radius"]).toBe("0px");
    expect(style["border-bottom-left-radius"]).toBe("0px");
    const [x, y, blur] = shadowLengths(style["box-shadow"]);
    expect(blur).toBe(0);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
  }
});

test("hover and press move .btn toward its shadow by exactly as much as the shadow shrinks", async ({ page }) => {
  // Reduced motion removes the transition, so each state can be read at once.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(FIXTURE);
  const button = page.locator("button.btn");
  const state = async () => {
    const style = await computed(button, "translate", "box-shadow");
    const [shadowX, shadowY] = shadowLengths(style["box-shadow"]);
    const [moveX, moveY] = translation(style.translate);
    return { shadowX: shadowX!, shadowY: shadowY!, moveX, moveY };
  };

  const rest = await state();
  expect(rest.moveX).toBe(0);
  expect(rest.moveY).toBe(0);

  await button.hover();
  const hover = await state();
  expect(hover.shadowX).toBeLessThan(rest.shadowX);
  expect(hover.moveX).toBeCloseTo(rest.shadowX - hover.shadowX);
  expect(hover.moveY).toBeCloseTo(rest.shadowY - hover.shadowY);

  await page.mouse.down();
  const pressed = await state();
  expect(pressed.shadowX).toBe(0);
  expect(pressed.moveX).toBeCloseTo(rest.shadowX);
  expect(pressed.moveY).toBeCloseTo(rest.shadowY);
  await page.mouse.up();
});

// Review Focus 5.
test("with reduced motion nothing animates; without it, .btn's press is animated", async ({ page }) => {
  await page.goto(FIXTURE);
  const button = page.locator(".btn").first();

  await page.emulateMedia({ reducedMotion: "no-preference" });
  const animated = seconds((await computed(button, "transition-duration"))["transition-duration"]);
  expect(Math.min(...animated)).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(seconds((await computed(button, "transition-duration"))["transition-duration"]).every((s) => s === 0)).toBe(true);
  const moving = await page.evaluate(() =>
    [...document.querySelectorAll("*")].flatMap((element) => {
      const style = getComputedStyle(element);
      const durations = `${style.transitionDuration}, ${style.animationDuration}`.split(",").map((value) => parseFloat(value));
      return durations.some((duration) => duration > 0) ? [`${element.tagName.toLowerCase()}.${element.className}`] : [];
    }),
  );
  expect(moving).toEqual([]);
});

test("cross-document view transitions are declared only for no-preference on motion", async ({ page }) => {
  await page.goto(FIXTURE);
  const rules = await page.evaluate(() => {
    if (!("CSSViewTransitionRule" in window)) return undefined;
    const found: { navigation: string; conditions: string[] }[] = [];
    const walk = (list: CSSRuleList, conditions: string[]) => {
      for (const rule of list) {
        if (rule instanceof CSSViewTransitionRule) found.push({ navigation: rule.navigation, conditions });
        else if (rule instanceof CSSMediaRule) walk(rule.cssRules, [...conditions, rule.conditionText]);
        else if (rule instanceof CSSGroupingRule) walk(rule.cssRules, conditions);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules, []);
    return found;
  });
  test.skip(rules === undefined, "this engine does not support @view-transition");
  expect(rules).toEqual([{ navigation: "auto", conditions: ["(prefers-reduced-motion: no-preference)"] }]);
});

test("every link, button and scrollable region shows a 3px focus outline when tabbed to", async ({ page }) => {
  await page.goto(FIXTURE);
  const focusable = await page.locator("a[href], button, [tabindex='0']").count();
  const outlines: { element: string; style: string; width: number }[] = [];
  for (let i = 0; i < focusable; i++) {
    await page.keyboard.press("Tab");
    outlines.push(
      await page.evaluate(() => {
        const element = document.activeElement!;
        const style = getComputedStyle(element);
        return {
          element: `${element.tagName.toLowerCase()}.${element.className} ${element.textContent!.trim().slice(0, 30)}`,
          style: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
        };
      }),
    );
  }
  expect(new Set(outlines.map(({ element }) => element)).size, "Tab reached every focusable element").toBe(focusable);
  expect(outlines.filter(({ element }) => element.includes("btn")).length).toBeGreaterThanOrEqual(3);
  for (const { element, style, width } of outlines) {
    expect(style, element).not.toBe("none");
    expect(width, element).toBeGreaterThanOrEqual(3);
  }
});

test("the skip link is hidden until the first Tab, then shows inside the viewport", async ({ page }) => {
  await page.goto(FIXTURE);
  const skip = page.locator(".skip-link");
  expect((await skip.boundingBox())!.width).toBeLessThanOrEqual(1);

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  const box = (await skip.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.width).toBeGreaterThan(40);
  expect(box.height).toBeGreaterThan(20);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
});

test("the current page's nav link looks different from the others", async ({ page }) => {
  await page.goto(FIXTURE);
  const current = await computed(page.locator('.site-nav a[aria-current="page"]'), "background-color", "color");
  const other = await computed(page.locator(".site-nav a:not([aria-current])").first(), "background-color", "color");
  expect(current["background-color"]).not.toBe(other["background-color"]);
  expect(current.color).not.toBe(other.color);
});

test("each card takes its shadow and heading color from data-accent", async ({ page }) => {
  await page.goto(FIXTURE);
  for (const accent of ["yellow", "pink", "blue"]) {
    const card = page.locator(`.card-grid .card[data-accent="${accent}"]`).first();
    const expected = await page.evaluate((name) => {
      const probe = document.createElement("i");
      probe.style.color = `var(--accent-${name})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, accent);
    const { "box-shadow": shadow } = await computed(card, "box-shadow");
    expect(shadow, `${accent} card shadow`).toContain(expected);
    expect((await computed(card.locator("h3"), "color")).color, `${accent} card heading`).toBe(expected);
  }
});

test("nothing overflows the page at 320px, and the terminal frame scrolls inside itself", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(FIXTURE);
  await page.evaluate(() => document.fonts.ready);
  const root = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);

  const frame = await page.locator(".tui-frame").evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(frame.overflowX).toBe("auto");
  expect(frame.scrollWidth).toBeGreaterThan(frame.clientWidth);
});

test("screenshots at 1280 and 320px, kept as artifacts", async ({ page }, testInfo) => {
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(FIXTURE);
    await page.evaluate(() => document.fonts.ready);
    await testInfo.attach(`components-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
});

// The fallback faces are sized to the web fonts (spec §5.3), so swapping the
// real fonts in should not move anything. Needs the fonts, so CI skips it.
test("the fallback faces take up the same space as the web fonts", async ({ browser }) => {
  test.skip(!HAVE_FONTS, "needs the web fonts in site/fonts/");
  const SHRINK_WRAPPED = [".site-brand", ".site-nav ul", ".btn", ".tag", ".card__meta"];
  const BLOCKS = ["h1", ".card h3", ".prose", ".timeline", ".tui-frame", ".site-footer"];

  const measure = async (blockFonts: boolean) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    if (blockFonts) await page.route("**/fonts/**", (route) => route.abort());
    await page.goto(FIXTURE);
    const result = await page.evaluate(
      async ([inline, blocks]) => {
        await document.fonts.ready;
        const box = (selector: string) => {
          const element = document.querySelector(selector)!;
          // An inline element's width is the width of its text.
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        };
        return {
          loaded: [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', "")),
          inline: Object.fromEntries(inline!.map((selector) => [selector, box(selector)])),
          blocks: Object.fromEntries(blocks!.map((selector) => [selector, box(selector)])),
          frameText: document.querySelector(".tui-frame")!.scrollWidth,
          pageHeight: document.documentElement.scrollHeight,
        };
      },
      [SHRINK_WRAPPED, BLOCKS],
    );
    await context.close();
    return result;
  };

  const fallback = await measure(true);
  const real = await measure(false);
  expect(fallback.loaded).not.toContain("MonoLisa");
  expect(fallback.loaded).not.toContain("Calling Code");
  expect(real.loaded).toEqual(expect.arrayContaining(["MonoLisa", "Calling Code"]));

  for (const selector of SHRINK_WRAPPED) {
    const [a, b] = [real.inline[selector]!, fallback.inline[selector]!];
    expect.soft(Math.abs(a.width - b.width), `${selector} width ${a.width} vs ${b.width}`).toBeLessThanOrEqual(Math.max(1, a.width * 0.01));
    expect.soft(Math.abs(a.height - b.height), `${selector} height ${a.height} vs ${b.height}`).toBeLessThanOrEqual(1);
  }
  for (const selector of BLOCKS) {
    const [a, b] = [real.blocks[selector]!, fallback.blocks[selector]!];
    expect.soft(Math.abs(a.height - b.height), `${selector} height ${a.height} vs ${b.height}`).toBeLessThanOrEqual(1);
  }
  expect.soft(Math.abs(real.frameText - fallback.frameText), "terminal text width").toBeLessThanOrEqual(real.frameText * 0.01);
  expect(Math.abs(real.pageHeight - fallback.pageHeight), "page height").toBeLessThanOrEqual(2);
});
