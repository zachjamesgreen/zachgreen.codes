import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FORBIDDEN_TERMS, findForbidden } from "../../scripts/check-content.ts";

describe("findForbidden: internal names", () => {
  it("lists the four names from the spec", () => {
    assert.deepEqual([...FORBIDDEN_TERMS], ["redacted-a", "redacted-b", "redacted-c", "redacted-d"]);
  });

  for (const term of ["redacted-a", "redacted-b", "redacted-c", "redacted-d"]) {
    it(`flags ${term} in any letter case, reporting the text found and where`, () => {
      for (const variant of [term, term.toUpperCase(), term.toLowerCase()]) {
        assert.deepEqual(findForbidden(`built ${variant} in 2021`), [{ term: variant, index: 6 }]);
      }
    });
  }

  it("flags redacted-d across a line break", () => {
    assert.deepEqual(findForbidden("at Land\n  Title Co"), [{ term: "Land\n  Title", index: 3 }]);
  });

  it("reports every hit, in order", () => {
    assert.deepEqual(findForbidden("redacted-a, then redacted-b"), [
      { term: "redacted-a", index: 0 },
      { term: "redacted-b", index: 13 },
    ]);
  });

  it("returns nothing for clean text", () => {
    assert.deepEqual(findForbidden("Zach Green builds web apps at Settlor."), []);
    assert.deepEqual(findForbidden(""), []);
  });
});

describe("findForbidden: phone numbers", () => {
  const shapes = ["720 555 0100", "(720) 555-0100", "720.555.0100", "+1 720 555 0100"];

  for (const shape of shapes) {
    it(`flags ${shape}`, () => {
      assert.deepEqual(findForbidden(`call ${shape} today`), [{ term: shape, index: 5 }]);
    });
  }

  it("also flags the dashed, compact and 1-prefixed forms", () => {
    for (const shape of ["720-555-0100", "7205550100", "1-720-555-0100", "(720)555-0100", "+17205550100"]) {
      assert.deepEqual(findForbidden(shape), [{ term: shape, index: 0 }], shape);
    }
  });

  it("does not take a trailing full stop as part of the number", () => {
    assert.deepEqual(findForbidden("Call 720.555.0100."), [{ term: "720.555.0100", index: 5 }]);
  });

  const lookalikes = [
    "14.369",
    "2021–2026",
    "1200×630",
    "about 650 commits",
    "SHA256:ubdsm…",
    "0.7205550100",
    "17205550100123",
  ];

  for (const text of lookalikes) {
    it(`does not flag ${text}`, () => {
      assert.deepEqual(findForbidden(text), []);
    });
  }
});

// The CLI is what `pnpm lint` and the history check run, so it is exercised as a
// real process: an entry point that silently does nothing would still pass every
// test above.
describe("check-content CLI", () => {
  const script = fileURLToPath(new URL("../../scripts/check-content.ts", import.meta.url));
  const dirs: string[] = [];

  function run(args: string[], options: { input?: string; cwd?: string } = {}) {
    return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...options });
  }

  // A throwaway repo root holding the given files, keyed by path.
  async function project(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "check-content-"));
    dirs.push(dir);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  }

  after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

  it("--stdin exits 1 and names the line and column of a forbidden name", () => {
    const res = run(["--stdin"], { input: "fine\nbuilt redacted-a\n" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^stdin:2:7 {2}forbidden: "redacted-a"$/m);
  });

  it("--stdin exits 1 on a phone number", () => {
    assert.equal(run(["--stdin"], { input: "call (720) 555-0100" }).status, 1);
  });

  it("--stdin exits 0 on clean text", () => {
    const res = run(["--stdin"], { input: "Zach Green, full-stack developer in Denver.\n" });
    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
  });

  it("scans site/ recursively and reports how many files it read", async () => {
    const cwd = await project({ "site/index.html": "<p>hi</p>", "site/css/site.css": "a{}", "site/img/a.svg": "<svg/>" });
    const res = run([], { cwd });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "scanned 3 files\n");
  });

  it("exits 1 on a forbidden term in a nested file, naming the file", async () => {
    const cwd = await project({ "site/index.html": "<p>hi</p>", "site/a/index.html": "<p>redacted-d</p>" });
    const res = run([], { cwd });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^site\/a\/index\.html:1:4 {2}forbidden: "redacted-d"$/m);
  });

  it("fails when it finds nothing to scan, rather than passing an empty scan", async () => {
    const cases: Record<string, string>[] = [{}, { "site/notes.md": "not a scanned type" }];
    for (const files of cases) {
      const res = run([], { cwd: await project(files) });
      assert.equal(res.status, 1, JSON.stringify(files));
      assert.match(res.stderr, /no files to scan/i);
    }
  });
});
