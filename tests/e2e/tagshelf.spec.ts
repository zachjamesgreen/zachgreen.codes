// The tagshelf project page. The shell and the site-wide rules are
// in site.spec.ts.

import { expect, test } from "../helpers/test.ts";

const REPO = "https://github.com/zachjamesgreen/tagshelf";

test.describe("tagshelf", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tagshelf/");
  });

  test("the terminal UI is a labelled, focusable region of real text", async ({ page }) => {
    const frame = page.locator("pre.tui-frame");
    await expect(frame).toHaveCount(1);
    // ARIA prohibits aria-label on a bare <pre>, so it is a group; it scrolls, so the keyboard can reach it.
    await expect(frame).toHaveAttribute("role", "group");
    await expect(frame).toHaveAttribute("aria-label", /tagshelf terminal UI/);
    await expect(frame).toHaveAttribute("tabindex", "0");
    await expect(frame).toContainText("Duplicates");
  });

  test("at 320px the page does not scroll sideways, but the terminal UI scrolls inside its frame", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/tagshelf/");
    await page.evaluate(() => document.fonts.ready);

    const root = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);

    const frame = await page.locator("pre.tui-frame").evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(frame.overflowX).toBe("auto");
    expect(frame.scrollWidth).toBeGreaterThan(frame.clientWidth);
  });

  test("links to the repo and to its releases", async ({ page }) => {
    const main = page.locator("main");
    await expect(main.locator(`a[href="${REPO}"]`).first()).toBeVisible();
    await expect(main.locator(`a[href="${REPO}/releases"]`).first()).toBeVisible();
  });

  test("covers undo, dry run, MusicBrainz and Windows plus Linux", async ({ page }) => {
    const main = page.locator("main");
    await expect(main).toContainText(/undo/i);
    await expect(main).toContainText(/dry run/i);
    await expect(main).toContainText("MusicBrainz");
    await expect(main).toContainText("Windows");
    await expect(main).toContainText("Linux");
  });

  // The release ships windows-amd64, linux-amd64 and linux-arm64: no Windows on arm64.
  test("names the builds exactly, with no claim of a Windows arm64 build", async ({ page }) => {
    const text = await page.locator("main").innerText();
    expect(text).toContain("Windows (amd64) and Linux (amd64 and arm64)");
    // "Windows ... arm64" with no "(" in between would put arm64 on Windows too.
    expect(text).not.toMatch(/Windows[^.(]*arm64/);
  });

  // Only identical copies are set aside on their own; other duplicates go to a person in the TUI.
  test("says identical copies, not duplicates, are set aside, in the lead and in both descriptions", async ({ page }) => {
    await expect(page.locator(".lead")).toContainText("identical copies");
    await expect(page.locator(".lead")).not.toContainText("duplicates aside");
    for (const meta of ['meta[name="description"]', 'meta[property="og:description"]']) {
      await expect(page.locator(meta), meta).toHaveAttribute("content", /sets identical copies aside/);
      await expect(page.locator(meta), meta).not.toHaveAttribute("content", /duplicates aside/);
    }
  });

  test("the why section keeps Zach's own words", async ({ page }) => {
    const why = page.locator("section", { has: page.getByRole("heading", { level: 2, name: /why/i }) });
    await expect(why).toHaveCount(1);
    await expect(why).toContainText("any music player");
  });

  test("the earlier music players are mentioned as text, with no links to those repos", async ({ page }) => {
    const why = page.locator("section", { has: page.getByRole("heading", { level: 2, name: /why/i }) });
    await expect(why).toContainText("player-api");
    await expect(why).toContainText("go-player");
    await expect(why.locator("a")).toHaveCount(0);
    const hrefs = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")!));
    expect(hrefs.filter((href) => /player-api|go-player/.test(href))).toEqual([]);
  });
});
