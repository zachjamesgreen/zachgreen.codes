// Link check (spec §9). Starts the same static server as `pnpm dev` and has
// linkinator crawl every page it can reach from `/` and from the 404 page,
// checking internal links, in-page fragments and external links alike. On top
// of what linkinator does, it fails when
//  - an internal link redirects (usually a missing trailing slash). External
//    redirects, such as GitHub renaming a repo, are allowed.
//  - a mailto: link isn't the contact address, or the pages have none.
//    linkinator skips mailto: links, so nothing else would catch a typo.
//
//   node scripts/check-links.ts
//
// Skipped on purpose:
//  - zachgreen.codes and stats.zachgreen.codes: canonical, og:url, og:image and
//    the analytics host point at the production site, which doesn't exist until
//    the first deploy. The live checks after deploy cover them.
//  - linkedin.com answers bots with 999, whatever the URL.

import { LinkChecker, LinkState, type LinkResult, type RedirectInfo } from "linkinator";
import { CONTACT_EMAIL } from "./lib/site.ts";
import { startServer } from "./serve.ts";

const SKIP = [String.raw`^https://zachgreen\.codes`, String.raw`^https://stats\.zachgreen\.codes`, String.raw`linkedin\.com`];

// The 404 page is only reachable by a missing URL, so it is a crawl start of its own.
const ENTRY_POINTS = ["/", "/404.html"];

function describe(link: LinkResult): string {
  const from = link.parent === undefined ? "" : `  (linked from ${link.parent})`;
  return `[${link.status ?? "no response"}] ${link.url}${from}`;
}

/** The address of a mailto: URL, decoded. The HTML's entities are already gone by the time linkinator reports it. */
function mailtoAddress(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

const server = await startServer({ root: "site" });
const checker = new LinkChecker();
const results = new Map<string, LinkResult>();
const internalRedirects = new Map<string, RedirectInfo>();
let passed = true;

checker.on("redirect", (redirect) => {
  if (redirect.url.startsWith(`${server.url}/`)) internalRedirects.set(redirect.url, redirect);
});

try {
  for (const entry of ENTRY_POINTS) {
    const outcome = await checker.check({
      path: new URL(entry, server.url).href,
      recurse: true,
      checkFragments: true,
      linksToSkip: SKIP,
      // "warn" follows redirects and reports them; "error" would also fail external ones.
      redirects: "warn",
      timeout: 30_000,
      retry: true,
      retryErrors: true,
      retryErrorsCount: 3,
      retryErrorsJitter: 500,
    });
    passed &&= outcome.passed;
    for (const link of outcome.links) results.set(`${link.state}\0${link.url}\0${link.parent ?? ""}`, link);
  }
} finally {
  await server.close();
}

const links = [...results.values()];
const broken = links.filter((link) => link.state === LinkState.BROKEN);
const mailto = links.filter((link) => link.url.startsWith("mailto:"));
const skipped = links.filter((link) => link.state === LinkState.SKIPPED && !link.url.startsWith("mailto:"));
const checked = links.filter((link) => link.state === LinkState.OK);
const external = checked.filter((link) => !link.url.startsWith(server.url));

const wrongAddress = mailto.filter((link) => mailtoAddress(link.url) !== CONTACT_EMAIL);

console.log(
  `Checked ${checked.length} links (${external.length} external), ${mailto.length} mailto, skipped ${skipped.length}, broken ${broken.length}.`,
);
for (const link of external) console.log(`  external ok: ${link.url}`);
for (const link of skipped) console.log(`  skipped: ${link.url}`);
for (const link of broken) console.error(`  BROKEN ${describe(link)}`);

const problems: string[] = [];
for (const { url, targetUrl } of internalRedirects.values()) {
  const parents = [...new Set(links.filter((link) => link.url === url).map((link) => link.parent))].join(", ");
  problems.push(`REDIRECT ${url} -> ${targetUrl ?? "?"}  (linked from ${parents || "?"}); link to the final URL`);
}
for (const link of wrongAddress) {
  problems.push(`MAILTO ${link.url} is not ${CONTACT_EMAIL}  (linked from ${link.parent ?? "?"})`);
}
if (mailto.length === 0) problems.push(`MAILTO no mailto: link found, expected ${CONTACT_EMAIL} on the pages`);
for (const problem of problems) console.error(`  ${problem}`);

if (!passed || broken.length > 0 || problems.length > 0) process.exit(1);
