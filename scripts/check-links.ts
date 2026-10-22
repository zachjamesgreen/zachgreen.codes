// Link check (spec §9). Starts the same static server as `pnpm dev` and has
// linkinator crawl every page it can reach from `/` and from the 404 page,
// checking internal links, in-page fragments and external links alike.
//
//   node scripts/check-links.ts
//
// Skipped on purpose:
//  - zachgreen.codes and stats.zachgreen.codes: canonical, og:url, og:image and
//    the analytics host point at the production site, which doesn't exist until
//    the first deploy. The live checks after deploy cover them.
//  - linkedin.com answers bots with 999, whatever the URL.

import { LinkChecker, LinkState, type LinkResult } from "linkinator";
import { startServer } from "./serve.ts";

const SKIP = [String.raw`^https://zachgreen\.codes`, String.raw`^https://stats\.zachgreen\.codes`, String.raw`linkedin\.com`];

// The 404 page is only reachable by a missing URL, so it is a crawl start of its own.
const ENTRY_POINTS = ["/", "/404.html"];

function describe(link: LinkResult): string {
  const from = link.parent === undefined ? "" : `  (linked from ${link.parent})`;
  return `[${link.status ?? "no response"}] ${link.url}${from}`;
}

const server = await startServer({ root: "site" });
const checker = new LinkChecker();
const results = new Map<string, LinkResult>();
let passed = true;

try {
  for (const entry of ENTRY_POINTS) {
    const outcome = await checker.check({
      path: new URL(entry, server.url).href,
      recurse: true,
      checkFragments: true,
      linksToSkip: SKIP,
      // A trailing-slash redirect on an internal link is a link we wrote wrong.
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
const skipped = links.filter((link) => link.state === LinkState.SKIPPED);
const checked = links.filter((link) => link.state === LinkState.OK);
const external = checked.filter((link) => !link.url.startsWith(server.url));

console.log(`Checked ${checked.length} links (${external.length} external), skipped ${skipped.length}, broken ${broken.length}.`);
for (const link of external) console.log(`  external ok: ${link.url}`);
for (const link of skipped) console.log(`  skipped: ${link.url}`);
for (const link of broken) console.error(`  BROKEN ${describe(link)}`);

if (!passed || broken.length > 0) process.exit(1);
