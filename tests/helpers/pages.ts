import { NOT_FOUND_PATH } from "../../scripts/lib/site.ts";

// Every public page, shared by the e2e, meta and sitemap tests. A new page goes
// here too: tests/unit/pages.test.ts fails while site/ and this list disagree.
export const PAGES = [
  { path: "/", name: "home" },
  { path: "/settlor/", name: "settlor" },
  { path: "/tagshelf/", name: "tagshelf" },
  { path: "/about/", name: "about" },
  { path: "/resume/", name: "resume" },
] as const;

/** Any unknown path gets the styled 404 page, with a 404 status. It is not in the sitemap, so not in PAGES. */
export const NOT_FOUND = { path: NOT_FOUND_PATH, name: "404" } as const;

/** Every page that carries the shared head, header and footer: PAGES and the 404 page. */
export const ALL_PAGES: readonly { path: string; name: string }[] = [...PAGES, NOT_FOUND];
