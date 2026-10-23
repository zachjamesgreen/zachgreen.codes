// Wording the owner took off the site. Every page in PAGES, its title and
// descriptions, the resume PDF and the social-image source must stay free of
// it, so a removed phrase can't come back through a page nobody was looking at.
// No page may carry an unfinished TODO(zach) note either, in its text or its source.
// The Settlor page's own wording is in settlor.spec.ts.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { readPdf } from "../helpers/pdf-text.ts";
import { PAGES } from "../helpers/pages.ts";
import { expect, test } from "../helpers/test.ts";

const PDF_FILE = fileURLToPath(new URL("../../site/resume/zach-green-resume.pdf", import.meta.url));
const OG_SOURCE = fileURLToPath(new URL("../../scripts/og.html", import.meta.url));

/** An unfinished note to the owner, which must not ship on any page. */
const PLACEHOLDER = "TODO(zach)";

/** What may not appear: a length of service, a version-pinned Pydantic or Vue, and pytest. */
const GONE = [/nearly five years/i, /pydantic v2/i, /\bvue\s?[23]\b/i, /\bpytest\b/i] as const;

/** `text` with its whitespace runs (line breaks included) collapsed to one space, so a phrase can't hide across a wrap. */
const flat = (text: string | null) => (text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

/** The patterns that match in `text`, as their sources. */
const found = (text: string) => GONE.filter((pattern) => pattern.test(flat(text))).map((pattern) => pattern.source);

test("the guard patterns catch the spellings they exist for", () => {
  for (const bad of ["Nearly five years", "nearly five years so far", "nearly\nfive years", "Pydantic v2", "Pydantic V2-native", "Vue 3", "Vue 2", "Vue3", "vue2", "pytest"]) {
    expect(found(bad), bad).not.toEqual([]);
  }
  for (const fine of ["Vue", "the current Vue", "Pydantic", "Python 3.14", "Vite 7", "Vuex", "pytester", "a few years", "Five workstreams"]) {
    expect(found(fine), fine).toEqual([]);
  }
});

/** The text a visitor and a crawler get from a page's head and body. */
async function copyOf(page: Page) {
  return {
    body: flat(await page.locator("body").textContent()),
    title: flat(await page.title()),
    description: flat(await page.locator('head > meta[name="description"]').getAttribute("content")),
    ogDescription: flat(await page.locator('head > meta[property="og:description"]').getAttribute("content")),
  };
}

for (const { path, name } of PAGES) {
  test(`${name} (${path}) has none of the removed wording in its body, title, description or og:description`, async ({ page }) => {
    await page.goto(path);
    const copy = await copyOf(page);
    // A page that failed to load would pass the checks below without saying anything.
    expect(copy.body.length, `${path} body is nearly empty`).toBeGreaterThan(200);
    for (const [part, text] of Object.entries(copy)) expect(text, `${path} ${part} is empty`).not.toBe("");
    for (const [part, text] of Object.entries(copy)) expect(found(text), `${path} ${part}`).toEqual([]);
  });

  test(`${name} (${path}) has no ${PLACEHOLDER} note, in its text or its source`, async ({ page }) => {
    await page.goto(path);
    expect(flat(await page.locator("body").textContent()), `${path} text`).not.toContain(PLACEHOLDER);
    expect(await page.content(), `${path} source`).not.toContain(PLACEHOLDER);
  });
}

test("the resume PDF has none of the removed wording", async () => {
  const { text } = await readPdf(PDF_FILE);
  expect(flat(text).length, "PDF text is empty").toBeGreaterThan(500);
  expect(found(text)).toEqual([]);
});

test("the social image's source has none of the removed wording", async ({ page }) => {
  await page.setContent(await readFile(OG_SOURCE, "utf8"));
  const text = flat(await page.locator("body").textContent());
  expect(text).toContain("Full-stack developer at Settlor");
  expect(found(text)).toEqual([]);
});
