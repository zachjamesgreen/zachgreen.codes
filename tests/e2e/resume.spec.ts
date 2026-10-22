// The resume page (spec §6.5) and the PDF generated from it. The shell and the
// site-wide rules are in site.spec.ts.
//
// The PDF is committed, and CI has no fonts, so the PDF checks compare words,
// not pixels or bytes: after editing the page, run `pnpm resume:pdf`.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { extractLinks } from "unpdf";

import { findForbidden } from "../../scripts/check-content.ts";
import { htmlWords, pdfFontNames, pdfWords, readPdf } from "../helpers/pdf-text.ts";

const PDF_URL = "/resume/zach-green-resume.pdf";
const PDF_FILE = fileURLToPath(new URL(`../../site${PDF_URL}`, import.meta.url));
const REGENERATE = "out of date: run pnpm resume:pdf";

/** Every job in spec §6.4, newest first. Turing is under education. */
const EXPERIENCE = [
  { start: "2021-12-06", title: "Web Developer", org: "Settlor" },
  { start: "2021-09", title: "Back End Software Engineer", org: "Fairwinds Ops" },
  { start: "2020-09", title: "Line Cook", org: "Bluegrass Lounge" },
  { start: "2019-01", title: "Sous Chef", org: "Blake Street Tavern" },
  { start: "2015-03", title: "Software Engineer", org: "ShipOffers" },
  { start: "2010-02", title: "Hospital Corpsman", org: "United States Navy" },
];

test.describe("resume page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/resume/");
  });

  test("names the title, Settlor, tagshelf, Turing and Denver", async ({ page }) => {
    const main = page.locator("main");
    for (const text of ["Web Developer", "Settlor", "tagshelf", "Turing", "Denver"]) await expect(main).toContainText(text);
  });

  test("lists every job in spec §6.4, newest first by <time datetime>", async ({ page }) => {
    const entries = page.locator("#experience .timeline > li");
    const starts = await entries.evaluateAll((items) => items.map((item) => item.querySelector("time")?.getAttribute("datetime") ?? ""));
    const times = starts.map((start) => Date.parse(start));
    expect(times.every(Number.isFinite), `datetimes ${starts.join(", ")}`).toBe(true);
    expect(times, "newest first").toEqual(times.toSorted((a, b) => b - a));
    expect(starts).toEqual(EXPERIENCE.map(({ start }) => start));
    for (const [i, { title, org }] of EXPERIENCE.entries()) {
      await expect(entries.nth(i).locator("h3")).toHaveText(title);
      await expect(entries.nth(i)).toContainText(org);
    }
  });

  test("has 2-4 Settlor highlights", async ({ page }) => {
    const highlights = await page.locator("#experience .timeline > li").first().locator("ul > li").count();
    expect(highlights).toBeGreaterThanOrEqual(2);
    expect(highlights).toBeLessThanOrEqual(4);
  });

  test("has tagshelf as the project, linking to its repo", async ({ page }) => {
    const project = page.locator("#project");
    await expect(project.locator("h3")).toHaveText("tagshelf");
    await expect(project.locator('a[href="https://github.com/zachjamesgreen/tagshelf"]')).toBeVisible();
  });

  test("has Turing under education", async ({ page }) => {
    const education = page.locator("#education");
    await expect(education).toContainText("Turing School of Software & Design");
    await expect(education).toContainText("Back-End Engineering");
    await expect(education.locator("time").first()).toHaveAttribute("datetime", "2021-02");
  });

  test("lists the current stack under skills", async ({ page }) => {
    const skills = page.locator("#skills");
    for (const skill of ["Python", "Flask", "FastAPI", "PostgreSQL", "Vue 3", "TypeScript", "Playwright", "Docker", "Kubernetes", "Go"]) {
      await expect(skills).toContainText(skill);
    }
  });

  test("has the site, email, GitHub and LinkedIn as links that show their address", async ({ page }) => {
    const main = page.locator("main");
    for (const [href, text] of [
      ["https://zachgreen.codes/", "zachgreen.codes"],
      ["mailto:zachjamesgreen@gmail.com", "zachjamesgreen@gmail.com"],
      ["https://github.com/zachjamesgreen", "github.com/zachjamesgreen"],
      ["https://www.linkedin.com/in/zachjamesgreen/", "linkedin.com/in/zachjamesgreen"],
    ]) {
      await expect(main.locator(`a[href="${href}"]`).first(), href).toHaveText(text!);
    }
  });

  test("links to the PDF with a download attribute, and the PDF is served", async ({ page }) => {
    const link = page.locator(`main a[href="${PDF_URL}"]`);
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("download");
    await expect(link).toBeVisible();
    const response = await page.request.get(PDF_URL);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
  });

  // The page doesn't scroll sideways (site.spec.ts), but a long address can
  // still poke out of its card into the border.
  test("at 320px, nothing inside a card sticks out past its padding", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/resume/");
    await page.evaluate(() => document.fonts.ready);
    const outside = await page.locator("main .card").evaluateAll((cards) =>
      cards.flatMap((card) => {
        const style = getComputedStyle(card);
        const box = card.getBoundingClientRect();
        const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
        const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
        return [...card.querySelectorAll("*")]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && (rect.left < left - 1 || rect.right > right + 1);
          })
          .map((element) => `${element.tagName.toLowerCase()}: ${element.textContent!.trim().slice(0, 40)}`);
      }),
    );
    expect(outside).toEqual([]);
  });

  test("printed, the header, nav, footer and the download link are hidden", async ({ page }) => {
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("body > header")).toBeHidden();
    await expect(page.locator(".site-nav")).toBeHidden();
    await expect(page.locator("body > footer")).toBeHidden();
    await expect(page.locator(`main a[href="${PDF_URL}"]`)).toBeHidden();
    await expect(page.locator("main h1")).toBeVisible();
  });
});

test.describe("resume PDF", () => {
  test("exists, has one or two pages, and has no phone number or internal name", async () => {
    expect(existsSync(PDF_FILE), `${PDF_FILE} is missing: run pnpm resume:pdf`).toBe(true);
    const { pages, text } = await readPdf(PDF_FILE);
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pages).toBeLessThanOrEqual(2);
    expect(findForbidden(text)).toEqual([]);
  });

  // Spec §5.4: the PDF is set in the site's own fonts, so it must be generated
  // where site/fonts/ exists. The web fonts carry no usable names, so the check
  // is that no embedded font is one of the local faces site.css falls back to
  // (Menlo, DejaVu Sans Mono, Liberation Mono, Courier New).
  test("is set in the web fonts, not in a fallback font", async () => {
    const css = await readFile(new URL("../../site/css/site.css", import.meta.url), "utf8");
    const fallbacks = new Set([...css.matchAll(/local\("([^"]+)"\)/g)].map(([, name]) => name!.split(/[\s-]/)[0]!));
    expect(fallbacks.size).toBeGreaterThan(0);
    const fonts = await pdfFontNames(PDF_FILE);
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.filter((font) => [...fallbacks].some((fallback) => font.startsWith(fallback))), REGENERATE).toEqual([]);
  });

  // The PDF is printed from a local server, so a relative link would point at it.
  test("links only to public addresses, including every contact link", async () => {
    const { links } = await extractLinks(new Uint8Array(await readFile(PDF_FILE)));
    expect(links.filter((href) => !/^(https:\/\/|mailto:)/.test(href))).toEqual([]);
    expect(links).toEqual(
      expect.arrayContaining([
        "https://zachgreen.codes/",
        "mailto:zachjamesgreen@gmail.com",
        "https://github.com/zachjamesgreen",
        "https://www.linkedin.com/in/zachjamesgreen/",
      ]),
    );
  });

  // Résumé parsers and copy-paste read the text in the order it was painted,
  // and positioned boxes paint after the rest of the page.
  test("reads in the page's order, name first", async () => {
    const { text } = await readPdf(PDF_FILE);
    const order = ["Zach Green", "Experience", "Web Developer", "Hospital Corpsman", "Project", "tagshelf", "Skills", "Education", "Back-End Engineering"];
    let from = 0;
    for (const heading of order) {
      const at = text.indexOf(heading, from);
      expect(at, `"${heading}" after ${JSON.stringify(text.slice(Math.max(0, from - 40), from))}`).toBeGreaterThanOrEqual(0);
      from = at + heading.length;
    }
  });

  test("has the same words as the printed page", async ({ page }) => {
    await page.goto("/resume/");
    await page.emulateMedia({ media: "print" });
    const printed = htmlWords(await page.locator("main").innerText());
    expect(printed.length).toBeGreaterThan(100);
    expect((await pdfWords(PDF_FILE)).toSorted(), REGENERATE).toEqual(printed.toSorted());
  });
});
