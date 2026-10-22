// The Settlor page. The shell and the site-wide rules are in
// site.spec.ts, and scripts/check-content.ts keeps Settlor's internal names off
// every page.

import { expect, test, type Page } from "@playwright/test";

/** The five workstreams, strongest first. The AI work is in progress, so it has no scale yet. */
const WORKSTREAMS = [
  { name: "platform modernization", heading: /platform.*modernization/i, hasScale: true },
  { name: "remote print service", heading: /remote print service/i, hasScale: true },
  { name: "Vue component library", heading: /Vue component library/i, hasScale: true },
  { name: "public API", heading: /public API/i, hasScale: true },
  { name: "AI and developer tooling", heading: /AI and developer tooling/i, hasScale: false },
] as const;

/** Tag texts and sentences the owner took off the page; none may come back. */
const GONE_TAGS = ["Vue 2", "Vue 3", "Pydantic v2", "pytest"] as const;
const GONE_PHRASES = [
  "nearly five years",
  "Here's the stack",
  "mid-move",
  "This page has no code and no screenshots",
  "Commit counts are approximate",
] as const;

/** The section that a workstream's h2 heads. */
const workstream = (page: Page, heading: RegExp) => page.locator("main section").filter({ has: page.locator("h2", { hasText: heading }) });

test.describe("settlor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/settlor/");
  });

  test("the h1 names Settlor", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Settlor");
  });

  test("the page gives Zach's title and when he started", async ({ page }) => {
    const main = page.locator("main");
    await expect(main).toContainText("Web Developer");
    await expect(main).toContainText(/\bDec(ember)? 2021\b/);
  });

  test("the h2s cover the five workstreams, strongest first", async ({ page }) => {
    const headings = await page.locator("main h2").allTextContents();
    const positions = WORKSTREAMS.map(({ heading }) => headings.findIndex((text) => heading.test(text)));
    expect(positions, `h2s: ${headings.join(" | ")}`).not.toContain(-1);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  });

  for (const { name, heading, hasScale } of WORKSTREAMS) {
    test(`the ${name} section runs problem, what Zach did, stack${hasScale ? ", scale" : " (no scale yet)"}`, async ({ page }) => {
      const section = workstream(page, heading);
      await expect(section).toHaveCount(1);
      const labels = (await section.locator("dt").allTextContents()).map((label) => label.trim());
      expect(labels).toEqual([
        expect.stringMatching(/problem/i),
        expect.stringMatching(/^what I\b/i),
        expect.stringMatching(/^stack$/i),
        ...(hasScale ? [expect.stringMatching(/^scale$/i)] : []),
      ]);
    });

    test(`the ${name} section lists its stack as tags`, async ({ page }) => {
      const stack = workstream(page, heading)
        .locator("dl > div")
        .filter({ has: page.locator("dt", { hasText: /^stack$/i }) });
      await expect(stack.locator("dd .tag-list > .tag").first()).toBeVisible();
    });
  }

  // The page gives one reason for running on site, that clients control which
  // printers are connected, and mustn't claim a different one.
  test("the print service section doesn't claim a cloud app can't reach office printers", async ({ page }) => {
    const section = workstream(page, /remote print service/i);
    await expect(section).toHaveCount(1);
    await expect(section).not.toContainText(/can(no|')t reach/i);
  });

  test("the AI section says the work is in progress", async ({ page }) => {
    await expect(workstream(page, /AI and developer tooling/i)).toContainText("in progress");
  });

  test("no unfinished placeholder is left on the page", async ({ page }) => {
    await expect(page.locator("body")).not.toContainText("TODO(zach)");
    expect(await page.content()).not.toContain("TODO(zach)");
  });

  test("no tag names an old or pinned version", async ({ page }) => {
    const tags = (await page.locator(".tag").allTextContents()).map((tag) => tag.trim());
    for (const gone of GONE_TAGS) expect(tags, `tags: ${tags.join(" | ")}`).not.toContain(gone);
  });

  test("the page doesn't name Vue 2, Vue 3 or Pydantic v2 anywhere, tags or prose", async ({ page }) => {
    const main = page.locator("main");
    await expect(main).not.toContainText(/\bVue [23]\b/);
    await expect(main).not.toContainText(/\bPydantic v2\b/i);
    expect(await page.locator('meta[name="description"]').getAttribute("content")).not.toMatch(/\bVue [23]\b/);
  });

  test("the frontend tag list names Vue once, with no duplicate tags", async ({ page }) => {
    const frontend = page
      .locator("main > section")
      .first()
      .locator("dl > div")
      .filter({ has: page.locator("dt", { hasText: /^frontend$/i }) });
    const tags = (await frontend.locator(".tag").allTextContents()).map((tag) => tag.trim());
    expect(tags.filter((tag) => tag === "Vue")).toHaveLength(1);
    expect(new Set(tags).size, `tags: ${tags.join(" | ")}`).toBe(tags.length);
  });

  test("the sentences the owner removed are gone", async ({ page }) => {
    for (const phrase of GONE_PHRASES) await expect(page.locator("main")).not.toContainText(phrase);
  });

  test("there are no screenshots or other images", async ({ page }) => {
    await expect(page.locator("img, picture, video")).toHaveCount(0);
  });
});
