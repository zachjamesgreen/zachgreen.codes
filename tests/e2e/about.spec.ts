// The About page (spec §6.4): the backstory as an intro and a timeline. The
// shell and the site-wide rules are in site.spec.ts.

import { expect, test } from "@playwright/test";

/** The timeline in order: where each entry starts (its first <time>), and what it must name. */
const ENTRIES = [
  { start: "2010-02", names: [/Navy/, /Hospital Corpsman/] },
  { start: "2015-03", names: [/ShipOffers/] },
  { start: "2019-01", names: [/Blake Street Tavern/] },
  { start: "2020-09", names: [/Bluegrass Lounge/] },
  { start: "2021-02", names: [/Turing School/] },
  { start: "2021-09", names: [/Fairwinds Ops/] },
  { start: "2021-12-06", names: [/Settlor/] },
] as const;

test.describe("about", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/about/");
  });

  test("the timeline has one entry per job or school, with the start dates in ascending order", async ({ page }) => {
    const items = page.locator(".timeline > li");
    await expect(items).toHaveCount(ENTRIES.length);
    const starts = await items.evaluateAll((entries) => entries.map((entry) => entry.querySelector("time")?.getAttribute("datetime")));
    expect(starts).toEqual(ENTRIES.map(({ start }) => start));
    expect([...starts].sort()).toEqual(starts);
  });

  test("each timeline entry names its place and role, in order", async ({ page }) => {
    const items = page.locator(".timeline > li");
    for (const [index, { names }] of ENTRIES.entries()) {
      for (const name of names) await expect(items.nth(index), `entry ${index + 1}`).toContainText(name);
    }
  });

  test("each timeline entry has a role heading, a place and a line about the work", async ({ page }) => {
    const items = page.locator(".timeline > li");
    for (let index = 0; index < ENTRIES.length; index++) {
      const item = items.nth(index);
      await expect(item.locator("h3"), `entry ${index + 1} role`).toHaveCount(1);
      await expect(item.locator("h3"), `entry ${index + 1} role`).not.toBeEmpty();
      await expect(item.locator("p.muted"), `entry ${index + 1} place`).toHaveCount(1);
      await expect(item.locator("p:not(.timeline__when):not(.muted)").first(), `entry ${index + 1} text`).not.toBeEmpty();
    }
  });

  test("ShipOffers runs from March 2015 to October 2016", async ({ page }) => {
    const item = page.locator(".timeline > li").filter({ hasText: "ShipOffers" });
    await expect(item.locator("time")).toHaveCount(2);
    await expect(item.locator("time").nth(0)).toHaveAttribute("datetime", "2015-03");
    await expect(item.locator("time").nth(1)).toHaveAttribute("datetime", "2016-10");
    await expect(item.locator(".timeline__when")).toHaveText("Mar 2015 to Oct 2016");
  });

  test("Settlor is the current job, from December 6, 2021", async ({ page }) => {
    const item = page.locator(".timeline > li").last();
    await expect(item.locator("time")).toHaveCount(1);
    await expect(item.locator("time")).toHaveAttribute("datetime", "2021-12-06");
    await expect(item.locator(".timeline__when")).toHaveText(/to now$/);
  });

  test("the page mentions Denver", async ({ page }) => {
    await expect(page.locator("main")).toContainText("Denver");
  });

  test("the intro connects triage and the kitchen to engineering", async ({ page }) => {
    const intro = page.locator("main > section").first();
    await expect(intro.locator("h1")).toHaveCount(1);
    await expect(intro).toContainText(/triage/i);
    await expect(intro).toContainText(/kitchen/i);
    await expect(intro).toContainText(/engineer|code|software/i);
  });

  test("the gap years are not discussed: no 2017 or 2018 anywhere, in the text or the source", async ({ page, request }) => {
    const GAP = /\b(2017|2018)\b/;
    expect(await page.locator("body").innerText()).not.toMatch(GAP);
    expect(await (await request.get("/about/")).text()).not.toMatch(GAP);
  });

  test("the Settlor entry links to the Settlor page", async ({ page }) => {
    await expect(page.locator(".timeline > li").last().locator('a[href="/settlor/"]')).toBeVisible();
  });
});
