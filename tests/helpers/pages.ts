// Every public page, shared by the e2e, meta and sitemap tests. A new page goes
// here too: tests/unit/pages.test.ts fails while site/ and this list disagree.
export const PAGES = [
  { path: "/", name: "home" },
  { path: "/settlor/", name: "settlor" },
  { path: "/tagshelf/", name: "tagshelf" },
  { path: "/about/", name: "about" },
  { path: "/resume/", name: "resume" },
] as const;
