// Compares the resume PDF with the resume page by their words (spec §6.5).
// Bytes and layout differ between renders and between machines with and
// without the fonts, so the check is a bag of words: the same words, the same
// number of times, in any order.

import { readFile } from "node:fs/promises";

import { extractText } from "unpdf";

/**
 * The words in `text`: NFKC-normalized (a ligature such as "ﬁ" becomes "fi"),
 * lowercased, and split on anything that isn't a letter or a digit.
 */
function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/** The number of pages in a PDF, and all of its text. */
export async function readPdf(file: string): Promise<{ pages: number; text: string }> {
  const { totalPages, text } = await extractText(new Uint8Array(await readFile(file)), { mergePages: true });
  return { pages: totalPages, text };
}

/** The words of a PDF's text. */
export async function pdfWords(file: string): Promise<string[]> {
  return words((await readPdf(file)).text);
}

/**
 * The names of the fonts a PDF embeds, without the subset tag (`ABCDEF+`) and
 * with `#xx` escapes decoded. Chromium writes them in plain font descriptors.
 */
export async function pdfFontNames(file: string): Promise<string[]> {
  const pdf = (await readFile(file)).toString("latin1");
  const names = [...pdf.matchAll(/\/FontName\s*\/([^\s/<>[\]()]+)/g)].map(([, name]) =>
    name!.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/^[A-Z]{6}\+/, ""),
  );
  return [...new Set(names)];
}

/** The words of a page's text, such as the `innerText` of its `<main>`. */
export function htmlWords(text: string): string[] {
  return words(text);
}
