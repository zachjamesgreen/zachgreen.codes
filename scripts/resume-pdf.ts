// Prints the resume page to the PDF that /resume/ offers for download (spec
// §6.5). The page is the single source: Playwright's Chromium lays it out with
// css/print.css, in the site's own fonts, on US Letter. The PDF is committed,
// because the server has no build step.
//
//   pnpm resume:pdf      serves site/ on a free port and writes site/resume/zach-green-resume.pdf
//
// The fonts are never committed, so this runs where site/fonts/ exists (Zach's
// machine), not in CI. It refuses to write a PDF set in fallback fonts. CI
// checks that the committed PDF still has the page's words instead.

import { chromium } from "@playwright/test";

import { requireWebFonts } from "./lib/site.ts";
import { startServer } from "./serve.ts";

export const RESUME_PDF = "site/resume/zach-green-resume.pdf";

/** Prints `${baseUrl}/resume/` to `outFile` as a US Letter PDF. */
export async function renderResumePdf(baseUrl: string, outFile: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = new URL("/resume/", baseUrl).href;
    const response = await page.goto(url);
    if (!response?.ok()) throw new Error(`${url} answered ${response?.status()}`);

    // The PDF embeds the web fonts, never a fallback. The check lays the page out
    // for print first, so a face that only print.css uses has started loading too.
    await page.emulateMedia({ media: "print" });
    await requireWebFonts(page);

    // tagged: the PDF carries the page's structure for screen readers.
    await page.pdf({ path: outFile, format: "Letter", printBackground: true, preferCSSPageSize: true, tagged: true });
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const server = await startServer({ root: "site" });
  try {
    await renderResumePdf(server.url, RESUME_PDF);
    console.log(`Wrote ${RESUME_PDF}`);
  } finally {
    await server.close();
  }
}
