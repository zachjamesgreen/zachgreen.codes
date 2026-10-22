// The Settlor page. The shell and the site-wide rules are in
// site.spec.ts, and scripts/check-content.ts keeps Settlor's internal names off
// every page.

import { expect, test, type Page } from "@playwright/test";

/** The five workstreams, strongest first. */
const WORKSTREAMS = [
  { name: "platform modernization", heading: /platform.*modernization/i },
  { name: "remote print service", heading: /remote print service/i },
  { name: "Vue 3 component library", heading: /Vue 3 component library/i },
  { name: "public API", heading: /public API/i },
  { name: "AI and developer tooling", heading: /AI and developer tooling/i },
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

  for (const { name, heading } of WORKSTREAMS) {
    test(`the ${name} section runs problem, what Zach did, stack, scale`, async ({ page }) => {
      const section = workstream(page, heading);
      await expect(section).toHaveCount(1);
      const labels = (await section.locator("dt").allTextContents()).map((label) => label.trim());
      expect(labels).toEqual([
        expect.stringMatching(/problem/i),
        expect.stringMatching(/^what I\b/i),
        expect.stringMatching(/^stack$/i),
        expect.stringMatching(/^scale$/i),
      ]);
    });

    test(`the ${name} section lists its stack as tags`, async ({ page }) => {
      const stack = workstream(page, heading)
        .locator("dl > div")
        .filter({ has: page.locator("dt", { hasText: /^stack$/i }) });
      await expect(stack.locator("dd .tag-list > .tag").first()).toBeVisible();
    });
  }

  // What the service does is known; why it has to run on site isn't, so the page
  // mustn't claim a reason.
  test("the print service section doesn't claim a cloud app can't reach office printers", async ({ page }) => {
    const section = workstream(page, /remote print service/i);
    await expect(section).toHaveCount(1);
    await expect(section).not.toContainText(/can(no|')t reach/i);
  });

  test("the AI section says the work is in progress", async ({ page }) => {
    await expect(workstream(page, /AI and developer tooling/i)).toContainText("in progress");
  });

  test("there are no screenshots or other images", async ({ page }) => {
    await expect(page.locator("img, picture, video")).toHaveCount(0);
  });
});
