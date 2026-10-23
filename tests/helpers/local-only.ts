// The e2e `request` fixture is Node's HTTP client, not the browser: Playwright's routes never see it, so
// the stats stub (scripts/lib/site.ts: stubStats) doesn't cover it. tests/helpers/test.ts wraps it with this,
// so a spec can't use it to reach anything but the local server.

import type { APIRequestContext } from "@playwright/test";

const METHODS = new Set(["fetch", "get", "post", "put", "patch", "delete", "head"]);

/** `request`, except that it throws before sending to any origin other than `baseURL`'s. */
export function localOnly(request: APIRequestContext, baseURL: string): APIRequestContext {
  const local = new URL(baseURL).origin;
  return new Proxy(request, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || !METHODS.has(property) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const [url] = args;
        const origin = typeof url === "string" ? new URL(url, baseURL).origin : undefined;
        if (origin !== undefined && origin !== local) throw new Error(`the e2e request fixture only talks to ${local}, not ${origin}`);
        return value.apply(target, args);
      };
    },
  });
}
