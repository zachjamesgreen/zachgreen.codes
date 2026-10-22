import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findTrackedFonts } from "../../scripts/check-no-fonts.ts";

describe("findTrackedFonts", () => {
  it("returns font files and nothing else, in input order", () => {
    assert.deepEqual(
      findTrackedFonts(["site/fonts/a.woff2", "x/B.TTF", "site/css/site.css"]),
      ["site/fonts/a.woff2", "x/B.TTF"],
    );
  });

  it("matches .woff, .woff2, .ttf and .otf in any letter case", () => {
    const fonts = ["a.woff", "b.WOFF2", "c.ttf", "d.OtF"];
    assert.deepEqual(findTrackedFonts(fonts), fonts);
  });

  it("matches on the extension, not on a name that merely contains one", () => {
    assert.deepEqual(
      findTrackedFonts(["woff2-notes.md", "site/fonts/README.md", "a.ttf.txt", "otf", "dir.otf/readme"]),
      [],
    );
  });

  it("returns an empty list for no input", () => {
    assert.deepEqual(findTrackedFonts([]), []);
  });
});

// The CLI is what CI and the pre-commit hook run, so it is exercised as a real
// process inside throwaway git repos.
describe("check-no-fonts CLI", () => {
  const script = fileURLToPath(new URL("../../scripts/check-no-fonts.ts", import.meta.url));
  const dirs: string[] = [];

  // Isolated from the developer's git config (identity, global ignore rules, hooks).
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  function git(cwd: string, ...args: string[]) {
    const res = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  }

  function run(cwd: string, ...args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
  }

  async function repo(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "check-no-fonts-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  }

  after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

  it("exits 1 and names a tracked font", async () => {
    const dir = await repo({ "x.woff2": "font", "readme.md": "hi" });
    git(dir, "add", "-A");
    const res = run(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^ {2}x\.woff2$/m);
    assert.doesNotMatch(res.stderr, /readme/);
  });

  it("exits 0 when no tracked file is a font", async () => {
    const dir = await repo({ "readme.md": "hi" });
    git(dir, "add", "-A");
    const res = run(dir);
    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
  });

  it("ignores a font that is present but not tracked", async () => {
    const dir = await repo({ "readme.md": "hi", "site/fonts/a.woff2": "font" });
    git(dir, "add", "readme.md");
    assert.equal(run(dir).status, 0);
  });

  it("--staged exits 1 for a staged font, whatever the letter case", async () => {
    const dir = await repo({ "site/fonts/Mono.TTF": "font", "readme.md": "hi" });
    git(dir, "add", "-A");
    const res = run(dir, "--staged");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^ {2}site\/fonts\/Mono\.TTF$/m);
  });

  it("--staged exits 0 when only non-fonts are staged", async () => {
    const dir = await repo({ "site/fonts/a.otf": "font", "readme.md": "hi" });
    git(dir, "add", "readme.md");
    assert.equal(run(dir, "--staged").status, 0);
  });

  it("--staged does not block staging the deletion of a font", async () => {
    const dir = await repo({ "a.woff": "font" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "rm", "-q", "a.woff");
    assert.equal(run(dir, "--staged").status, 0);
    assert.equal(run(dir).status, 0);
  });

  it("without --staged still reports a font that is committed", async () => {
    const dir = await repo({ "a.woff": "font" });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    assert.equal(run(dir).status, 1);
  });
});
