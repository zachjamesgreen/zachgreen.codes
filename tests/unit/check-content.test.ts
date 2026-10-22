import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findForbidden, hitSummary, loadForbiddenTerms, termsFromEnv, termsFromFile } from "../../scripts/check-content.ts";

// Made-up terms. The real list never goes in the repo: the guard is given it at run time.
const TERMS = ["Zephyrine", "Quuxworks Title"] as const;

/** What findForbidden reports for a term and for a phone number: the text as found, where, and which kind of hit. */
const termHit = (term: string, index: number) => ({ kind: "term", term, index });
const phoneHit = (term: string, index: number) => ({ kind: "phone", term, index });

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A throwaway working directory holding the given files, keyed by path. */
async function project(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "check-content-"));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

describe("findForbidden: terms", () => {
  for (const term of TERMS) {
    it(`flags ${term} in any letter case, reporting the text found and where`, () => {
      for (const variant of [term, term.toUpperCase(), term.toLowerCase()]) {
        assert.deepEqual(findForbidden(`built ${variant} in 2021`, TERMS), [termHit(variant, 6)]);
      }
    });
  }

  it("reports every hit, in order", () => {
    assert.deepEqual(findForbidden("Zephyrine, then Quuxworks Title", TERMS), [
      termHit("Zephyrine", 0),
      termHit("Quuxworks Title", 16),
    ]);
  });

  it("checks only the terms it is given", () => {
    assert.deepEqual(findForbidden("built Zephyrine", ["Quuxworks Title"]), []);
    assert.deepEqual(findForbidden("built Zephyrine", []), []);
  });

  it("returns nothing for clean text", () => {
    assert.deepEqual(findForbidden("Zach Green builds web apps at Settlor.", TERMS), []);
    assert.deepEqual(findForbidden("", TERMS), []);
  });

  it("ignores empty and blank terms, rather than matching everywhere", () => {
    assert.deepEqual(findForbidden("anything at all", ["", "   ", "&nbsp;"]), []);
  });

  it("escapes a term, so its punctuation matches only itself", () => {
    assert.deepEqual(findForbidden("Zeph-yrine Zephxyrine", ["Zeph.yrine"]), []);
    assert.deepEqual(findForbidden("Zeph.yrine", ["Zeph.yrine"]), [termHit("Zeph.yrine", 0)]);
  });
});

describe("findForbidden: dash entities in a term", () => {
  it("a hyphen in a term also matches a dash entity, as it would a hyphen", () => {
    for (const text of ["Zeph-yrine", "Zeph&ndash;yrine", "Zeph&#8209;yrine", "Zeph&#x2212;yrine", "ZEPH&MDASH;YRINE"]) {
      assert.deepEqual(findForbidden(`at ${text}.`, ["Zeph-yrine"]), [termHit(text, 3)], text);
    }
  });

  it("still does not match a term with something else where its hyphen is", () => {
    for (const text of ["Zeph yrine", "Zephyrine", "Zeph&nbsp;yrine", "Zeph&amp;yrine", "Zeph.yrine"]) {
      assert.deepEqual(findForbidden(text, ["Zeph-yrine"]), [], text);
    }
  });
});

describe("hitSummary", () => {
  it("gives the count and the character offsets, and nothing of the text found", () => {
    const text = "built Zephyrine, then call (720) 555-0100 at Quuxworks Title";
    const summary = hitSummary(findForbidden(text, TERMS));
    assert.equal(summary, "3 forbidden terms or phone numbers, at character offsets 6, 27, 45");
    assert.doesNotMatch(summary, /zephyrine|quuxworks|555/i);
  });

  it("says it in the singular for one hit", () => {
    assert.equal(hitSummary(findForbidden("built Zephyrine", TERMS)), "1 forbidden term or phone number, at character offset 6");
  });

  it("says so when there is none", () => {
    assert.equal(hitSummary([]), "no forbidden terms or phone numbers");
  });
});

describe("findForbidden: word boundaries", () => {
  it("does not flag a term inside a longer word", () => {
    for (const text of ["the Zephyrineum", "preZephyrine", "Zephyrines", "Zephyrine2", "Zephyriné", "Quuxworks Titles", "MyQuuxworks Title"]) {
      assert.deepEqual(findForbidden(text, TERMS), [], text);
    }
  });

  it("flags a term next to punctuation, markup or an entity", () => {
    const cases: [string, number][] = [
      ["(Zephyrine)", 1],
      ["Zephyrine's", 0],
      ["Zephyrine-based", 0],
      ["Zephyrine_app", 0],
      ["<b>Zephyrine</b>", 3],
      ["at Zephyrine, Inc.", 3],
      ["&ldquo;Zephyrine&rdquo;", 7],
    ];
    for (const [text, index] of cases) {
      assert.deepEqual(findForbidden(text, TERMS), [termHit("Zephyrine", index)], text);
    }
  });
});

describe("findForbidden: multi-word terms and non-breaking spaces", () => {
  it("matches a multi-word term across any run of whitespace, NBSP included", () => {
    for (const gap of [" ", "  ", "\n  ", "\t", "\u00a0", "\u202f", " \u00a0 "]) {
      assert.deepEqual(findForbidden(`at Quuxworks${gap}Title Co`, TERMS), [termHit(`Quuxworks${gap}Title`, 3)], JSON.stringify(gap));
    }
  });

  it("matches across an NBSP character reference", () => {
    for (const gap of ["&nbsp;", "&#160;", "&#xa0;", "&#xA0;", " &nbsp; "]) {
      assert.deepEqual(findForbidden(`at Quuxworks${gap}Title Co`, TERMS), [termHit(`Quuxworks${gap}Title`, 3)], gap);
    }
  });

  it("does not match the words of a multi-word term apart", () => {
    for (const text of ["Quuxworks, Title", "Quuxworks-Title", "QuuxworksTitle", "Quuxworks alone. Title alone."]) {
      assert.deepEqual(findForbidden(text, TERMS), [], text);
    }
  });

  it("normalizes the terms too: an NBSP or its reference in a term means any whitespace", () => {
    for (const term of ["Quuxworks\u00a0Title", "Quuxworks&nbsp;Title", "Quuxworks&#160;Title", "  Quuxworks   Title  "]) {
      assert.deepEqual(findForbidden("at Quuxworks Title", [term]), [termHit("Quuxworks Title", 3)], JSON.stringify(term));
    }
  });
});

describe("findForbidden: phone numbers", () => {
  const shapes = ["720 555 0100", "(720) 555-0100", "720.555.0100", "+1 720 555 0100"];

  for (const shape of shapes) {
    it(`flags ${shape}`, () => {
      assert.deepEqual(findForbidden(`call ${shape} today`, []), [phoneHit(shape, 5)]);
    });
  }

  it("also flags the dashed, compact and 1-prefixed forms", () => {
    for (const shape of ["720-555-0100", "7205550100", "1-720-555-0100", "(720)555-0100", "+17205550100"]) {
      assert.deepEqual(findForbidden(shape, []), [phoneHit(shape, 0)], shape);
    }
  });

  it("flags a number spaced with NBSP or an NBSP character reference", () => {
    for (const shape of ["720\u00a0555\u00a00100", "720&nbsp;555&nbsp;0100", "(720)&#160;555-0100", "+1&#xa0;720&#xA0;555&#xa0;0100"]) {
      assert.deepEqual(findForbidden(`call ${shape} today`, []), [phoneHit(shape, 5)], shape);
    }
  });

  it("flags a number whose separators are en dashes, em dashes or non-breaking hyphens", () => {
    for (const shape of ["720\u2013555\u20130100", "720\u2014555\u20140100", "720\u2011555\u20110100", "1\u2013720\u2013555\u20130100"]) {
      assert.deepEqual(findForbidden(shape, []), [phoneHit(shape, 0)], JSON.stringify(shape));
    }
  });

  it("flags a number whose separators are dash entities, named, decimal or hex", () => {
    const shapes = [
      "720&ndash;555&ndash;0100",
      "720&mdash;555&mdash;0100",
      "720&minus;555&minus;0100",
      "720&#8211;555&#8211;0100",
      "720&#8208;555&#8212;0100",
      "720&#8722;555&#8722;0100",
      "720&#x2011;555&#x2011;0100",
      "720&#x2010;555&#x2014;0100",
      "720&#x2212;555&#x2212;0100",
      "720&#X2013;555&#x2013;0100",
      "720&#x02011;555&#x0002013;0100",
      "720&#00008211;555&#0008211;0100",
      "1&ndash;720&ndash;555&ndash;0100",
      "(720)&ndash;555&ndash;0100",
      "+1&#x2011;720&#x2011;555&#x2011;0100",
      "720&ndash;555-0100",
    ];
    for (const shape of shapes) {
      assert.deepEqual(findForbidden(`call ${shape} today`, []), [phoneHit(shape, 5)], shape);
    }
  });

  it("reports a dash-entity number where it is in the source, not where a normalized copy would have it", () => {
    const text = "&ndash;&ndash; 720&ndash;555&ndash;0100 &ndash; 720&mdash;555&mdash;0100";
    assert.deepEqual(findForbidden(text, []), [phoneHit("720&ndash;555&ndash;0100", 15), phoneHit("720&mdash;555&mdash;0100", 48)]);
  });

  it("does not take a trailing full stop as part of the number", () => {
    assert.deepEqual(findForbidden("Call 720.555.0100.", []), [phoneHit("720.555.0100", 5)]);
  });

  it("checks phone numbers alongside the terms", () => {
    assert.deepEqual(findForbidden("Zephyrine: 720-555-0100", TERMS), [
      termHit("Zephyrine", 0),
      phoneHit("720-555-0100", 11),
    ]);
  });

  const lookalikes = [
    "14.369",
    "2021–2026",
    "2021&nbsp;–&nbsp;2026",
    "2021&ndash;2026",
    "2021&#8211;2026",
    "2021&#x2013;2026",
    "720&ndash;555",
    "720&#8209;555&#8209;010",
    "&#8211;720555010&#8211;",
    "1200×630",
    "about 650 commits",
    "SHA256:ubdsm…",
    "0.7205550100",
    "17205550100123",
  ];

  for (const text of lookalikes) {
    it(`does not flag ${text}`, () => {
      assert.deepEqual(findForbidden(text, []), []);
    });
  }
});

describe("where the terms come from", () => {
  it("FORBIDDEN_TERMS is split on commas and newlines, trimmed, with blanks dropped", () => {
    assert.deepEqual(termsFromEnv("Zephyrine,Quuxworks Title"), [...TERMS]);
    assert.deepEqual(termsFromEnv(" Zephyrine \r\n\n Quuxworks Title ,, "), [...TERMS]);
    assert.deepEqual(termsFromEnv(""), []);
    assert.deepEqual(termsFromEnv(undefined), []);
  });

  it(".forbidden-terms has one term per line, and # starts a comment", () => {
    const file = "# Kept out of the repo.\nZephyrine\n\n  Quuxworks Title   # the long one\r\n#Zorblat\n";
    assert.deepEqual(termsFromFile(file), [...TERMS]);
    assert.deepEqual(termsFromFile("# nothing but comments\n\n"), []);
  });

  it("reads FORBIDDEN_TERMS", async () => {
    const cwd = await project();
    assert.deepEqual(await loadForbiddenTerms({ env: { FORBIDDEN_TERMS: "Zephyrine,Quuxworks Title" }, cwd }), [...TERMS]);
  });

  it("reads .forbidden-terms in the working directory", async () => {
    const cwd = await project({ ".forbidden-terms": "Zephyrine\nQuuxworks Title\n" });
    assert.deepEqual(await loadForbiddenTerms({ env: {}, cwd }), [...TERMS]);
  });

  it("combines both sources, without repeats", async () => {
    const cwd = await project({ ".forbidden-terms": "Quuxworks Title\nZephyrine\n" });
    assert.deepEqual(await loadForbiddenTerms({ env: { FORBIDDEN_TERMS: "Zephyrine" }, cwd }), ["Zephyrine", "Quuxworks Title"]);
  });

  it("gives no terms when neither source has one", async () => {
    assert.deepEqual(await loadForbiddenTerms({ env: {}, cwd: await project() }), []);
    const cwd = await project({ ".forbidden-terms": "# only a comment\n" });
    assert.deepEqual(await loadForbiddenTerms({ env: { FORBIDDEN_TERMS: " , " }, cwd }), []);
  });
});

// The CLI is what `pnpm lint` runs, so it is exercised as a real process: an entry
// point that silently does nothing would still pass every test above. Each run gets a
// clean environment and its own temp working directory, so neither a FORBIDDEN_TERMS
// from CI nor the repo's own .forbidden-terms can leak in.
describe("check-content CLI", () => {
  const script = fileURLToPath(new URL("../../scripts/check-content.ts", import.meta.url));
  const withTerms = { FORBIDDEN_TERMS: TERMS.join(",") };

  function run(args: string[], options: { cwd: string; env?: Record<string, string>; input?: string }) {
    return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: options.cwd, env: options.env ?? {}, input: options.input });
  }

  /** The guard's output goes to a public CI log: no part of what it matched may be in it. */
  function assertNoEcho(res: { stdout: string; stderr: string }, ...found: string[]) {
    for (const text of found) {
      assert.ok(!res.stdout.toLowerCase().includes(text.toLowerCase()), `stdout echoes ${text.length} matched characters`);
      assert.ok(!res.stderr.toLowerCase().includes(text.toLowerCase()), `stderr echoes ${text.length} matched characters`);
    }
  }

  it("--stdin exits 1 and names the line and column and kind of a forbidden term, not the term", async () => {
    const res = run(["--stdin"], { cwd: await project(), env: withTerms, input: "fine\nbuilt Zephyrine\n" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^stdin:2:7 {2}forbidden term$/m);
    assert.match(res.stderr, /^1 forbidden term or phone number found$/m);
    assertNoEcho(res, "Zephyrine");
  });

  it("takes newline-separated terms from FORBIDDEN_TERMS", async () => {
    const res = run(["--stdin"], { cwd: await project(), env: { FORBIDDEN_TERMS: "Zephyrine\nQuuxworks Title\n" }, input: "at Quuxworks\u00a0Title" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^stdin:1:4 {2}forbidden term$/m);
    assertNoEcho(res, "Quuxworks", "Title");
  });

  it("takes terms from .forbidden-terms in the working directory", async () => {
    const cwd = await project({ ".forbidden-terms": "# made up\nZephyrine\n" });
    const res = run(["--stdin"], { cwd, input: "built ZEPHYRINE\n" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^stdin:1:7 {2}forbidden term$/m);
    assertNoEcho(res, "Zephyrine");
    assert.equal(run(["--stdin"], { cwd, input: "the Zephyrineum\n" }).status, 0);
  });

  it("--stdin exits 1 on a phone number, naming where and what kind but not the digits", async () => {
    const res = run(["--stdin"], { cwd: await project(), env: withTerms, input: "call (720) 555-0100" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^stdin:1:6 {2}phone number$/m);
    assertNoEcho(res, "555", "720", "0100");
  });

  it("--stdin catches a number written with dash entities, without echoing it", async () => {
    const res = run(["--stdin"], { cwd: await project(), env: withTerms, input: "<p>720&ndash;555&ndash;0100</p>" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^stdin:1:4 {2}phone number$/m);
    assertNoEcho(res, "555", "720", "0100", "ndash");
  });

  it("--stdin exits 0 on clean text", async () => {
    const res = run(["--stdin"], { cwd: await project(), env: withTerms, input: "Zach Green, full-stack developer in Denver.\n" });
    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
  });

  it("scans site/ recursively and reports how many files it read", async () => {
    const cwd = await project({ "site/index.html": "<p>hi</p>", "site/css/site.css": "a{}", "site/img/a.svg": "<svg/>" });
    const res = run([], { cwd, env: withTerms });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "scanned 3 files\n");
  });

  it("exits 1 on a forbidden term in a nested file, naming the file", async () => {
    const cwd = await project({ "site/index.html": "<p>hi</p>", "site/a/index.html": "<p>Quuxworks&nbsp;Title</p>" });
    const res = run([], { cwd, env: withTerms });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^site\/a\/index\.html:1:4 {2}forbidden term$/m);
    assertNoEcho(res, "Quuxworks", "Title", "nbsp");
  });

  it("scanning site/, a number in a file is reported by location and kind only", async () => {
    const cwd = await project({ "site/a.html": "<p>ok</p>\n  <p>720&#x2011;555&#x2011;0100 and Zephyrine</p>" });
    const res = run([], { cwd, env: withTerms });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^site\/a\.html:2:6 {2}phone number$/m);
    assert.match(res.stderr, /^site\/a\.html:2:37 {2}forbidden term$/m);
    assert.match(res.stderr, /^2 forbidden terms or phone numbers found$/m);
    assertNoEcho(res, "555", "720", "0100", "2011", "Zephyrine");
  });

  it("fails when it finds nothing to scan, rather than passing an empty scan", async () => {
    const cases: Record<string, string>[] = [{}, { "site/notes.md": "not a scanned type" }];
    for (const files of cases) {
      const res = run([], { cwd: await project(files), env: withTerms });
      assert.equal(res.status, 1, JSON.stringify(files));
      assert.match(res.stderr, /no files to scan/i);
    }
  });

  it("fails closed when neither FORBIDDEN_TERMS nor .forbidden-terms gives a term, naming both", async () => {
    const setups: { files: Record<string, string>; env: Record<string, string> }[] = [
      { files: {}, env: {} },
      { files: {}, env: { FORBIDDEN_TERMS: "" } },
      { files: { ".forbidden-terms": "# only comments\n\n" }, env: { FORBIDDEN_TERMS: " ,\n" } },
    ];
    for (const { files, env } of setups) {
      const cwd = await project({ ...files, "site/index.html": "<p>clean</p>" });
      for (const args of [[], ["--stdin"]]) {
        const res = run(args, { cwd, env, input: "clean text\n" });
        const label = JSON.stringify({ files, env, args });
        assert.equal(res.status, 1, label);
        assert.match(res.stderr, /FORBIDDEN_TERMS/, label);
        assert.match(res.stderr, /\.forbidden-terms/, label);
        assert.equal(res.stdout, "", label);
      }
    }
  });
});
