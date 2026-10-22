// Facts about the site that the scripts and the tests share, so each one is
// written down once.

import { existsSync, readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

/** The production origin, as canonical URLs, og:url and the sitemap spell it. */
export const ORIGIN = "https://zachgreen.codes";

/** A path with no page behind it: the server answers it with the styled 404 page and a 404 status. */
export const NOT_FOUND_PATH = "/nope";

/** The contact address: the footer's mailto link, and the only mailto the link check accepts. */
export const CONTACT_EMAIL = "zachjamesgreen@gmail.com";

/** The web font families the site is set in. */
export const FONT_FAMILIES = ["Calling Code", "MonoLisa"] as const;

const SITE = new URL("../../site/", import.meta.url);
const STYLESHEET = "css/site.css";

/** The url() sources of a stylesheet's @font-face rules, in order. local() sources aren't files, so they are left out. */
export function fontFaceUrls(css: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...source.matchAll(/@font-face\s*\{([^}]*)\}/g)].flatMap(([, body]) =>
    [...body!.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map(([, , url]) => url!),
  );
}

/**
 * Whether every font file that site/css/site.css's @font-face rules load is in
 * site/. The fonts are commercial and never committed, so CI has none of them,
 * and a check that needs them skips without them.
 */
export function haveFonts(): boolean {
  const urls = fontFaceUrls(readFileSync(new URL(STYLESHEET, SITE), "utf8"));
  if (urls.length === 0) throw new Error(`site/${STYLESHEET} has no @font-face url(), so there is nothing to look for`);
  return urls.every((url) => {
    // Resolved against the stylesheet, as a browser would; a same-origin path is a file under site/.
    const served = new URL(url, `${ORIGIN}/${STYLESHEET}`);
    return served.origin === ORIGIN && existsSync(new URL(`.${decodeURIComponent(served.pathname)}`, SITE));
  });
}

/** The families of the web fonts that have loaded on `page`, once layout has asked for its fonts and they have settled. */
export function loadedFamilies(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    // Layout first, so a face only the current media (print, say) uses has been requested too.
    document.documentElement.getBoundingClientRect();
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', ""));
  });
}

/** Throws unless every family in FONT_FAMILIES has loaded on `page`: an image or PDF made in fallback fonts is wrong. */
export async function requireWebFonts(page: Page): Promise<void> {
  const loaded = await loadedFamilies(page);
  const missing = FONT_FAMILIES.filter((family) => !loaded.includes(family));
  if (missing.length > 0) {
    throw new Error(`${missing.join(" and ")} did not load. Copy the font files into site/fonts/ first; they are never committed.`);
  }
}
