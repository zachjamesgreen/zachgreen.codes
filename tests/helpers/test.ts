// The `test` every e2e spec imports, instead of Playwright's own. It adds fixtures that
// run for every test, whether or not the test asks for them:
//   - the stats host is stubbed on the browser context (scripts/lib/site.ts: stubStats), so
//     no test ever sends Umami a page view. A test that wants the host to behave differently,
//     such as failing or hanging, routes it on its page: a page's routes run before the context's.
//   - `request`, Node's HTTP client, which routes can't stub, only talks to the local server.
// tests/unit/analytics.test.ts fails for a spec that imports `test` from @playwright/test, or
// makes a browser context of its own without stubbing the host in it.

import { test as base } from "@playwright/test";

import { stubStats } from "../../scripts/lib/site.ts";
import { localOnly } from "./local-only.ts";

export const test = base.extend<{ statsStub: void }>({
  statsStub: [
    async ({ context }, use) => {
      await stubStats(context);
      await use();
    },
    { auto: true },
  ],
  request: async ({ request, baseURL }, use) => {
    await use(localOnly(request, baseURL!));
  },
});

export { expect } from "@playwright/test";
