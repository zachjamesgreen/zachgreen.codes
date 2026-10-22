// The home page (spec §6.6) and the 404 page. The shell and the site-wide
// rules are in site.spec.ts.

import { expect, test } from "@playwright/test";

import { CONTACT_EMAIL, NOT_FOUND_PATH } from "../../scripts/lib/site.ts";

const ACCENTS = /^(yellow|pink|blue)$/;

test.describe("home", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("the hero names Zach, his role and Settlor", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Zach Green");
    const hero = page.locator(".hero");
    await expect(hero).toContainText(/full-stack developer/i);
    await expect(hero).toContainText("Settlor");
  });

  test("the hero has the See my work and Resume buttons and a GitHub link", async ({ page }) => {
    const hero = page.locator(".hero");
    const work = hero.getByRole("link", { name: "See my work", exact: true });
    await expect(work).toHaveClass(/\bbtn\b/);
    await expect(work).toHaveAttribute("href", "#work");
    const resume = hero.getByRole("link", { name: "Resume", exact: true });
    await expect(resume).toHaveClass(/\bbtn\b/);
    await expect(resume).toHaveAttribute("href", "/resume/");
    await expect(hero.getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://github.com/zachjamesgreen");
  });

  test("See my work scrolls to the work section", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.locator(".hero").getByRole("link", { name: "See my work" }).click();
    await expect(page).toHaveURL(/\/#work$/);
    await expect(page.locator("#work h2")).toBeInViewport();
  });

  test("#work has a Settlor card and a tagshelf card, each with its own accent, a summary and 3-4 tags", async ({ page }) => {
    const cards = page.locator("#work .card");
    await expect(cards).toHaveCount(2);
    const accents = [];
    for (const target of ["/settlor/", "/tagshelf/"]) {
      const card = cards.filter({ has: page.locator(`a.card__link[href="${target}"]`) });
      await expect(card, target).toHaveCount(1);
      const accent = await card.getAttribute("data-accent");
      expect(accent, target).toMatch(ACCENTS);
      accents.push(accent);
      await expect(card.locator("p:not(.card__meta)"), target).toHaveCount(1);
      await expect(card.locator("p:not(.card__meta)"), target).not.toBeEmpty();
      const tags = await card.locator(".tag").count();
      expect(tags, target).toBeGreaterThanOrEqual(3);
      expect(tags, target).toBeLessThanOrEqual(4);
    }
    expect(accents[0]).not.toBe(accents[1]);
  });

  // Only identical copies are set aside on their own; other duplicates go to a person in the TUI.
  // The meta descriptions never said "duplicates aside": they are checked so they never start to.
  test("the tagshelf card says identical copies, not duplicates, are set aside; the meta descriptions are regression guards", async ({
    page,
  }) => {
    const summary = page
      .locator("#work .card")
      .filter({ has: page.locator('a.card__link[href="/tagshelf/"]') })
      .locator("p:not(.card__meta)");
    await expect(summary).toContainText("identical copies");
    await expect(summary).not.toContainText("duplicates aside");
    for (const meta of ['meta[name="description"]', 'meta[property="og:description"]']) {
      await expect(page.locator(meta), meta).not.toHaveAttribute("content", /duplicates aside/);
    }
  });

  test("clicking anywhere on a work card opens its page", async ({ page }) => {
    for (const target of ["/settlor/", "/tagshelf/"]) {
      await page.goto("/");
      const card = page.locator("#work .card").filter({ has: page.locator(`a.card__link[href="${target}"]`) });
      // The tags, not the title: the stretched link has to carry the click.
      const tags = card.locator(".tag-list");
      await tags.scrollIntoViewIfNeeded();
      const box = (await tags.boundingBox())!;
      await page.mouse.click(box.x + 4, box.y + box.height / 2);
      await expect(page).toHaveURL(new RegExp(`${target}$`));
    }
  });

  test("the about blurb links to /about/", async ({ page }) => {
    const about = page.locator("#about");
    await expect(about.locator("p").first()).not.toBeEmpty();
    await expect(about.locator('a[href="/about/"]')).toBeVisible();
  });

  test("the contact section links to GitHub, LinkedIn and email", async ({ page }) => {
    const contact = page.locator("#contact");
    await expect(contact.locator('a[href="https://github.com/zachjamesgreen"]')).toBeVisible();
    await expect(contact.locator('a[href="https://www.linkedin.com/in/zachjamesgreen/"]')).toBeVisible();
    await expect(contact.locator(`a[href="mailto:${CONTACT_EMAIL}"]`)).toBeVisible();
  });
});

test("an unknown URL gets a 404 status and the styled 404 page, with the shared header and a link home", async ({ page }) => {
  const response = await page.goto(NOT_FOUND_PATH);
  expect(response!.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText(/not found/i);
  await expect(page.locator("body > header.site-header")).toBeVisible();
  await expect(page.locator('main a[href="/"]')).toBeVisible();
});
