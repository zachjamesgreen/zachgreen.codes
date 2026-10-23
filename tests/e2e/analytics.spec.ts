// Umami: the tracker tag in every page's <head>, the click events on the links worth
// counting, and the privacy line in the footer.
//
// Nothing here reaches the stats host, or any host outside the machine. tests/helpers/test.ts
// stubs the stats host for every test; the blocked-tracker tests route it to a failure; and the
// real-tracker tests (tests/helpers/umami.ts has the harness) serve Umami's own script from
// tests/e2e/fixtures/, answer its beacon themselves, and run behind a proxy that refuses and
// records whatever the routes miss. The tracker only counts visits to zachgreen.codes
// (data-domains), so those tests have the local server answer under that name, with the
// production CSP.
//
// What the real tracker does with a click (Umami 3.4.0, src/tracker/index.ts): a click on a
// link with data-umami-event is cancelled, the event is sent, and only when that request has
// settled does the tracker set location.href itself. That is why the tests below fail the
// request in each way. A click with a modifier key, and a target="_blank" link, are left to
// the browser: the resume PDF link is one, so that its `download` attribute still applies,
// which the tracker's own navigation would not honor. The tracker installs its click listener
// only if it is going to count: on another hostname, or with the opt-out flag set, links are
// fully native.

import type { Page, Request } from "@playwright/test";

import { missingFont, NOT_FOUND_PATH, ORIGIN, STATS_ORIGIN, TRACKER_TAG, UMAMI_WEBSITE_ID } from "../../scripts/lib/site.ts";
import { ALL_PAGES } from "../helpers/pages.ts";
import { expect, test } from "../helpers/test.ts";
import {
  escapes,
  EVENTS,
  FAILURE_LINKS,
  LINKS,
  PDF_PATH,
  PRODUCTION,
  PROFILE,
  runTracker,
  serveAsProduction,
  stubDestinations,
  trackerTest,
  watchClicks,
} from "../helpers/umami.ts";

const PRIVACY_LINE = "Page views are counted with self-hosted, cookie-free analytics (Umami).";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The event a link to `href` must carry, or undefined when its destination isn't one of the counted ones. */
function eventFor(href: string): (typeof EVENTS)[number] | undefined {
  const url = new URL(href, ORIGIN);
  if (url.protocol === "mailto:") return "email-click";
  if (url.origin === ORIGIN) return url.pathname === PDF_PATH ? "resume-pdf-download" : undefined;
  const [first, second, third] = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "github.com" && first === PROFILE) {
    if (second === undefined) return "outbound-github";
    return second === "tagshelf" ? "outbound-tagshelf-repo" : undefined;
  }
  if (/^(www\.)?linkedin\.com$/.test(url.hostname) && first === "in" && second === PROFILE) {
    return third === undefined ? "outbound-linkedin" : undefined;
  }
  return undefined;
}

// The rules above are this file's own, so they are checked once, against known links.
test("the link rules know the five destinations, and nothing else", () => {
  expect(
    [
      PDF_PATH,
      `${ORIGIN}${PDF_PATH}`,
      `https://github.com/${PROFILE}`,
      `https://github.com/${PROFILE}/tagshelf`,
      `https://github.com/${PROFILE}/tagshelf/releases`,
      `https://www.linkedin.com/in/${PROFILE}/`,
      "mailto:someone@example.com",
    ].map(eventFor),
  ).toEqual([
    "resume-pdf-download",
    "resume-pdf-download",
    "outbound-github",
    "outbound-tagshelf-repo",
    "outbound-tagshelf-repo",
    "outbound-linkedin",
    "email-click",
  ]);
  expect(["/about/", "#work", `${ORIGIN}/`, "https://github.com/someone-else", "https://example.com/"].map(eventFor)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

// ---------------------------------------------------------------------------------------
// The markup
// ---------------------------------------------------------------------------------------

for (const { path, name } of ALL_PAGES) {
  test.describe(`${name} (${path})`, () => {
    test("has exactly one script, the tracker, last in <head>, and the page source carries its tag verbatim", async ({ page }) => {
      const source = await (await page.request.get(path)).text();
      expect(source.split(TRACKER_TAG)).toHaveLength(2);

      await page.goto(path);
      const scripts = await page.locator("script").evaluateAll((elements) =>
        elements.map((element) => ({
          parent: element.parentElement!.tagName,
          last: element === element.parentElement!.lastElementChild,
          attributes: Object.fromEntries([...element.attributes].map(({ name, value }) => [name, value])),
        })),
      );
      expect(scripts).toEqual([
        {
          parent: "HEAD",
          last: true,
          attributes: { defer: "", src: `${STATS_ORIGIN}/insights`, "data-website-id": UMAMI_WEBSITE_ID, "data-domains": new URL(ORIGIN).hostname },
        },
      ]);
      expect(scripts[0]!.attributes["data-website-id"]).toMatch(UUID);
    });

    test("every link to a counted destination has its event, and no other link has one", async ({ page }) => {
      await page.goto(path);
      const links = await page
        .locator("a[href]")
        .evaluateAll((anchors) => anchors.map((anchor) => ({ href: anchor.getAttribute("href")!, event: anchor.getAttribute("data-umami-event") })));
      expect(links.length).toBeGreaterThan(4);
      const actual = links.map(({ href, event }) => ({ href, event: event ?? undefined }));
      expect(actual).toEqual(links.map(({ href }) => ({ href, event: eventFor(href) })));
    });

    // The tracker cancels a plain click and navigates itself, which drops `download` and waits on its beacon. A
    // target="_blank" link it leaves alone. So the PDF link has both attributes, and no other link has either.
    test("only the PDF link opens in a new tab and downloads; every other link stays in this tab", async ({ page }) => {
      await page.goto(path);
      const links = await page.locator("a[href]").evaluateAll((anchors) =>
        anchors.map((anchor) => ({
          href: anchor.getAttribute("href")!,
          target: anchor.getAttribute("target"),
          download: anchor.hasAttribute("download"),
        })),
      );
      const pdf = (href: string) => eventFor(href) === "resume-pdf-download";
      expect(links).toEqual(links.map(({ href }) => ({ href, target: pdf(href) ? "_blank" : null, download: pdf(href) })));
    });

    test("carries no other Umami attribute, and no event name but the five", async ({ page }) => {
      await page.goto(path);
      const umami = await page.evaluate(() =>
        [...document.querySelectorAll("*")].flatMap((element) =>
          element
            .getAttributeNames()
            .filter((attribute) => attribute.startsWith("data-umami"))
            .map((attribute) => ({ element: element.tagName.toLowerCase(), attribute, value: element.getAttribute(attribute)! })),
        ),
      );
      expect(umami.length).toBeGreaterThan(0);
      for (const { element, attribute, value } of umami) {
        expect({ element, attribute }, value).toEqual({ element: "a", attribute: "data-umami-event" });
        expect(EVENTS, value).toContain(value);
      }
    });

    test("the footer says how page views are counted, in ASCII", async ({ page }) => {
      await page.goto(path);
      const lines = page.locator("body > footer p", { hasText: PRIVACY_LINE });
      await expect(lines).toHaveCount(1);
      // The text the page holds, byte for byte: MonoLisa has no glyph for anything outside ASCII.
      const text = await lines.evaluate((paragraph) => paragraph.textContent);
      expect(text).toBe(PRIVACY_LINE);
      expect(text).toMatch(/^[\x20-\x7e]+$/);
    });
  });
}

test("every event is on at least one link, so none of the five is a dead name", async ({ page }) => {
  const used = new Set<string>();
  for (const { path } of ALL_PAGES) {
    await page.goto(path);
    const tagged = page.locator("[data-umami-event]");
    for (const event of await tagged.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-umami-event")!))) used.add(event);
  }
  expect([...used].toSorted()).toEqual([...EVENTS].toSorted());
});

// tests/helpers/test.ts stubs the stats host for every test. The unit tests check that every spec uses it;
// this checks that it works: the tag's request is answered by the stub with an empty script, nothing else.
test("the stats host is stubbed in every test: the tracker's request gets an empty script", async ({ page }) => {
  const [response] = await Promise.all([page.waitForResponse(`${STATS_ORIGIN}/insights`), page.goto("/")]);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/javascript");
  expect(await response.text()).toBe("");
});

// ---------------------------------------------------------------------------------------
// With the tracker blocked: nothing on the site depends on it
// ---------------------------------------------------------------------------------------

test.describe("with the stats host unreachable", () => {
  for (const { path, name } of ALL_PAGES) {
    const notFound = path === NOT_FOUND_PATH;

    test(`${name} (${path}) has no console error but the blocked request, and an internal link still navigates`, async ({ page }) => {
      await page.route(`${STATS_ORIGIN}/**`, (route) => route.abort());
      const documentUrl = new URL(path, test.info().project.use.baseURL).href;
      const problems: string[] = [];
      const failed: string[] = [];
      page.on("console", (message) => {
        const { url } = message.location();
        const text = `${message.text()} ${url}`;
        // Chromium and WebKit log the 404 page's own status as a console error.
        const own404 = notFound && url === documentUrl && /\b404\b/.test(text);
        const expected = url.startsWith(STATS_ORIGIN) || text.includes(STATS_ORIGIN) || missingFont(text) || own404;
        if (message.type() === "error" && !expected) problems.push(`console: ${message.text()} (${url})`);
      });
      page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
      page.on("requestfailed", (request) => {
        if (!missingFont(request.url())) failed.push(request.url());
      });

      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      expect(problems).toEqual([]);
      expect(failed, "only the tracker script failed").toEqual([`${STATS_ORIGIN}/insights`]);

      const target = path === "/about/" ? "/resume/" : "/about/";
      await page.locator(`body > header nav a[href="${target}"]`).click();
      await expect(page).toHaveURL(target);
      await expect(page.locator("h1")).toBeVisible();
    });
  }

  // Served by the local server, and downloaded from it: nothing here leaves the machine.
  test("the PDF link still downloads the PDF", async ({ page }) => {
    await page.route(`${STATS_ORIGIN}/**`, (route) => route.abort());
    await page.goto("/resume/");
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`main a[href="${PDF_PATH}"]`).click()]);
    expect(download.suggestedFilename()).toBe("zach-green-resume.pdf");
  });
});

// ---------------------------------------------------------------------------------------
// With Umami's real tracker
// ---------------------------------------------------------------------------------------

/** Page errors, and console errors the `expected` URL doesn't account for. */
function problemsOn(page: Page, expectedUrl?: string): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    const { url } = message.location();
    if (message.type() !== "error" || missingFont(`${message.text()} ${url}`) || url === expectedUrl) return;
    problems.push(`console: ${message.text()} (${url})`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  return problems;
}

/** How long a click may take to go where it points, when the stats host fails. */
const BOUND = 3_000;

/** How long a click is watched, while the stats host hangs, to see that it goes nowhere. */
const HOLD = 1_500;

trackerTest.describe("with Umami's tracker, on zachgreen.codes", () => {
  trackerTest.beforeEach(async ({ context, baseURL }) => {
    await serveAsProduction(context, baseURL!);
  });

  trackerTest("counts the page view, as zachgreen.codes, with no cookie, no storage and no CSP violation", async ({ page, context }) => {
    const problems = problemsOn(page);
    await page.addInitScript(() => {
      const violations: string[] = [];
      (window as unknown as { violations: string[] }).violations = violations;
      document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));
    });
    const { beacons } = await runTracker(context, "ok");

    await page.goto(`${PRODUCTION}/about/`);
    await expect.poll(() => beacons).toEqual([{ type: "event", name: undefined, hostname: new URL(ORIGIN).hostname, url: `${PRODUCTION}/about/` }]);

    // "Cookie-free", as the footer says: none set, nothing stored.
    expect(await context.cookies()).toEqual([]);
    const stored = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      cookie: document.cookie,
      violations: (window as unknown as { violations: string[] }).violations,
    }));
    expect(stored).toEqual({ local: [], session: [], cookie: "", violations: [] });
    expect(problems).toEqual([]);
  });

  // The tracker asks fetch for no credentials, so a cookie the browser holds for the stats host stays home.
  trackerTest("the beacon carries no Cookie header, though the browser holds a cookie for the stats host", async ({ page, context }) => {
    await context.addCookies([{ name: "probe", value: "1", domain: new URL(STATS_ORIGIN).hostname, path: "/", secure: true, sameSite: "None" }]);
    const { beacons } = await runTracker(context, "ok");
    const posts: Request[] = [];
    page.on("request", (request) => request.url() === `${STATS_ORIGIN}/api/send` && request.method() === "POST" && posts.push(request));
    // A control: a request that does ask for credentials shows the route that same cookie. Without one, a missing
    // header would prove nothing: WebKit doesn't show a routed request's cookies.
    const control: { cookie: string | null } = { cookie: null };
    await context.route(`${STATS_ORIGIN}/control`, async (route) => {
      control.cookie = await route.request().headerValue("cookie");
      await route.fulfill({ status: 200, body: "" });
    });

    await page.goto(`${PRODUCTION}/about/`);
    await expect.poll(() => beacons.length).toBe(1);
    await page.evaluate((url) => fetch(url, { credentials: "include" }).catch(() => undefined), `${STATS_ORIGIN}/control`);
    trackerTest.skip(control.cookie === null, "this browser shows a routed request no Cookie header, even one that sends it");

    expect(control.cookie).toBe("probe=1");
    expect(await posts[0]!.headerValue("cookie")).toBeNull();
  });

  for (const link of LINKS) {
    trackerTest(`${link.kind}: sends ${link.event} and then goes where it points`, async ({ page, context }) => {
      const problems = problemsOn(page);
      const clicks = await watchClicks(page, { block: true });
      const { beacons } = await runTracker(context, "ok");
      await page.goto(`${PRODUCTION}${link.path}`);
      await expect.poll(() => beacons.length).toBe(1);

      const arrival = link.arrives(page, BOUND, clicks);
      await page.locator(link.selector).first().click();
      await arrival;
      await expect
        .poll(() => beacons.map(({ type, name }) => ({ type, name })))
        .toEqual([
          { type: "event", name: undefined },
          { type: "event", name: link.event },
        ]);
      // The tracker cancelled the click and navigated itself, or left it to the browser, as the link calls for.
      await expect.poll(() => clicks).toEqual([link.takenOver]);
      expect(problems).toEqual([]);
    });
  }

  for (const link of FAILURE_LINKS) {
    for (const answer of ["abort", "bad-gateway"] as const) {
      trackerTest(`${link.kind} goes where it points, within ${BOUND / 1000}s, when /api/send fails (${answer})`, async ({ page, context }) => {
        // Chromium and WebKit log the failed request itself, naming it, as a console error; nothing else may be logged.
        const problems = problemsOn(page, `${STATS_ORIGIN}/api/send`);
        const clicks = await watchClicks(page, { block: true });
        const { beacons } = await runTracker(context, answer);
        await page.goto(`${PRODUCTION}${link.path}`);
        await expect.poll(() => beacons.length).toBe(1);

        const arrival = link.arrives(page, BOUND, clicks);
        await page.locator(link.selector).first().click();
        await arrival;
        await expect.poll(() => beacons.at(-1)?.name).toBe(link.event);
        expect(problems).toEqual([]);
      });
    }

    if (link.takenOver) {
      // Known limitation of Umami 3.4.0: it cancels the click, awaits fetch(/api/send) with no timeout, and
      // only then follows the link. So while the request is pending nothing happens; the click is released
      // when the request ends. In production nginx ends it after 3 seconds (the proxy timeouts on /api/send in
      // deploy/nginx/stats.zachgreen.codes.conf, which pnpm test:nginx proves with a stub Umami that never
      // answers); a refused connection or an error reply ends it at once (above). This pins the client side, so
      // a tracker upgrade that behaves differently shows up here.
      trackerTest(
        `${link.kind} waits, while /api/send hangs, until the request ends (Umami 3.4.0 has no timeout)`,
        async ({ page, context, browserName }) => {
          trackerTest.skip(link.event === "email-click" && browserName === "firefox", "Firefox shows no mailto: attempt, so a held one can't be seen");
          const clicks = await watchClicks(page, { block: true });
          const { beacons, release } = await runTracker(context, "hang");
          await page.goto(`${PRODUCTION}${link.path}`);
          await expect.poll(() => beacons.length).toBe(1);

          const arrival = link.arrives(page, HOLD + BOUND, clicks);
          await page.locator(link.selector).first().click();
          await expect.poll(() => beacons.at(-1)?.name, "the event was posted").toBe(link.event);
          expect(await Promise.race([arrival.then(() => "went"), page.waitForTimeout(HOLD).then(() => "held")])).toBe("held");

          await release();
          await arrival;
        },
      );
    } else {
      trackerTest(`${link.kind} is not held while /api/send hangs: target="_blank" keeps the tracker out of it`, async ({ page, context }) => {
        const clicks = await watchClicks(page, { block: true });
        const { beacons } = await runTracker(context, "hang");
        await page.goto(`${PRODUCTION}${link.path}`);
        await expect.poll(() => beacons.length).toBe(1);

        // The click reaches the browser uncancelled, at once, with the beacon unanswered.
        const arrival = link.arrives(page, BOUND, clicks);
        await page.locator(link.selector).first().click();
        await arrival;
        await expect.poll(() => beacons.at(-1)?.name, "the event was posted, and is still unanswered").toBe(link.event);
      });
    }
  }

  trackerTest("a click with a modifier key is left to the browser, but still counted", async ({ page, context }) => {
    // Blocked, because a Ctrl-click would open a tab.
    const clicks = await watchClicks(page, { block: true });
    const { beacons } = await runTracker(context, "ok");
    await page.goto(`${PRODUCTION}/about/`);
    await expect.poll(() => beacons.length).toBe(1);

    await page.locator(`footer a[href="https://github.com/${PROFILE}"]`).click({ modifiers: ["Control"] });
    await expect.poll(() => beacons.at(-1)?.name).toBe("outbound-github");
    await expect.poll(() => clicks).toEqual([false]);
  });

  trackerTest("with the opt-out flag set (localStorage umami.disabled), nothing is sent and links are fully native", async ({ page, context }) => {
    await page.addInitScript(() => localStorage.setItem("umami.disabled", "1"));
    const clicks = await watchClicks(page, { block: false });
    const { beacons } = await runTracker(context, "ok");
    await page.goto(`${PRODUCTION}/about/`);
    // The tracker is there, but it only installs its click listener if it is going to count.
    expect(await page.evaluate(() => typeof (window as unknown as { umami?: unknown }).umami)).toBe("object");
    await page.locator(`footer a[href="https://github.com/${PROFILE}"]`).click();
    await expect(page).toHaveURL(`https://github.com/${PROFILE}`);
    expect(clicks).toEqual([false]);
    expect(beacons).toEqual([]);
  });
});

trackerTest("on any other hostname, such as the local server, the tracker counts nothing and links are fully native", async ({ page, context, baseURL }) => {
  await stubDestinations(context);
  const clicks = await watchClicks(page, { block: false });
  const { beacons } = await runTracker(context, "ok");
  const problems = problemsOn(page);
  await page.goto("/about/");
  expect(new URL(page.url()).hostname).not.toBe(new URL(ORIGIN).hostname);
  // The tracker is there, but it only installs its click listener if it is going to count, and it isn't on zachgreen.codes.
  expect(await page.evaluate(() => typeof (window as unknown as { umami?: unknown }).umami)).toBe("object");
  await page.locator(`footer a[href="https://github.com/${PROFILE}"]`).click();
  await expect(page).toHaveURL(`https://github.com/${PROFILE}`);
  expect(clicks).toEqual([false]);
  expect(beacons, `on ${baseURL}`).toEqual([]);
  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------------------
// That the real-tracker tests never leave the machine
// ---------------------------------------------------------------------------------------

trackerTest.describe("the proxy behind the real-tracker tests", () => {
  trackerTest.beforeEach(async ({ context, baseURL }) => {
    await serveAsProduction(context, baseURL!);
  });

  trackerTest("saw nothing leave the machine in a visit with every kind of click", async ({ page, context, escapeProxy, browserName }) => {
    const clicks = await watchClicks(page, { block: true });
    const { beacons } = await runTracker(context, "ok");
    for (const link of LINKS) {
      clicks.length = 0;
      await page.goto(`${PRODUCTION}${link.path}`);
      const arrival = link.arrives(page, BOUND, clicks);
      await page.locator(link.selector).first().click();
      await arrival;
    }
    expect(beacons.length).toBeGreaterThanOrEqual(LINKS.length);
    expect(escapes(escapeProxy.take(), browserName)).toEqual([]);
  });

  // Controls: the proxy is only a guard if it would see what the routes miss.
  trackerTest("sees a plain http request that no route answers", async ({ page, escapeProxy }) => {
    await page.goto("/about/");
    await page.evaluate(() => fetch("http://control.test/probe", { mode: "no-cors" }).catch(() => undefined));
    await expect.poll(() => escapeProxy.take()).toContain("GET http://control.test/probe");
  });

  // A download is fetched outside the routes in Chromium and WebKit: it would request the real site.
  trackerTest("sees a download that no route answers (Chromium and WebKit)", async ({ page, escapeProxy, browserName }) => {
    trackerTest.skip(browserName === "firefox", "Firefox routes downloads, so there is nothing for the proxy to see");
    await page.goto(`${PRODUCTION}/resume/`);
    await page.locator(`main a[href="${PDF_PATH}"]`).click();
    await expect.poll(() => escapeProxy.take()).toContain(`GET ${PRODUCTION}${PDF_PATH}`);
  });
});
