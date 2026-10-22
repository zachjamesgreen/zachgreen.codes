import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// `git commit` is run for real, in throwaway repos that carry copies of the hook and
// its two guards, so what is pinned is the commit being refused, not just a script
// exiting 1. Only made-up terms and numbers are used: the real list is never in the repo.
const root = fileURLToPath(new URL("../..", import.meta.url));
const FILES = [".githooks/pre-commit", "scripts/check-content.ts", "scripts/check-no-fonts.ts"];

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

// Isolated from the developer's git config and from the repo the tests run in (a git
// hook sets GIT_DIR and friends, which would aim every call below at that repo), and
// without a FORBIDDEN_TERMS of its own: each test says which terms the hook is given.
const base: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
for (const name of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "FORBIDDEN_TERMS"]) delete base[name];

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

/** A repo with the hook enabled, as `pnpm install` leaves this one, and `files` staged. */
async function stagedRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pre-commit-"));
  dirs.push(dir);
  assert.equal(git(dir, base, "init", "-q").status, 0);
  assert.equal(git(dir, base, "config", "core.hooksPath", ".githooks").status, 0);
  for (const file of FILES) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await copyFile(join(root, file), join(dir, file));
  }
  await chmod(join(dir, ".githooks/pre-commit"), 0o755);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  assert.equal(git(dir, base, "add", "-A").status, 0);
  return dir;
}

/** `git commit`, with the terms the hook is given, if any. Whether it landed is read from the repo. */
function commit(dir: string, forbiddenTerms?: string) {
  const env = forbiddenTerms === undefined ? base : { ...base, FORBIDDEN_TERMS: forbiddenTerms };
  const res = git(dir, env, "commit", "-m", "test");
  const landed = git(dir, base, "rev-parse", "--verify", "-q", "HEAD").status === 0;
  return { ...res, landed };
}

describe("pre-commit hook", () => {
  it("refuses a commit of a site file with a forbidden term, without echoing the term", async () => {
    const dir = await stagedRepo({ "site/index.html": "<p>built Zephyrine</p>\n" });
    const res = commit(dir, "Zephyrine");
    assert.notEqual(res.status, 0);
    assert.equal(res.landed, false);
    assert.match(res.stderr, /^site\/index\.html:1:10 {2}forbidden term$/m);
    assert.doesNotMatch(res.stdout + res.stderr, /zephyrine/i);
  });

  it("refuses a commit of a site file with a phone number written with dash entities", async () => {
    const dir = await stagedRepo({ "site/index.html": "<p>720&ndash;555&ndash;0100</p>\n" });
    const res = commit(dir, "Zephyrine");
    assert.notEqual(res.status, 0);
    assert.equal(res.landed, false);
    assert.match(res.stderr, /^site\/index\.html:1:4 {2}phone number$/m);
    assert.doesNotMatch(res.stdout + res.stderr, /555/);
  });

  it("fails closed with a hint at .forbidden-terms when no terms are configured", async () => {
    const dir = await stagedRepo({ "site/index.html": "<p>clean</p>\n" });
    const res = commit(dir);
    assert.notEqual(res.status, 0);
    assert.equal(res.landed, false);
    assert.match(res.stderr, /\.forbidden-terms/);
  });

  it("lets a clean commit through", async () => {
    const dir = await stagedRepo({ "site/index.html": "<p>clean</p>\n" });
    const res = commit(dir, "Zephyrine");
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.landed, true);
  });

  it("still refuses a font file", async () => {
    const dir = await stagedRepo({ "site/index.html": "<p>clean</p>\n", "site/fonts/Mono.woff2": "font" });
    const res = commit(dir, "Zephyrine");
    assert.notEqual(res.status, 0);
    assert.equal(res.landed, false);
    assert.match(res.stderr, /site\/fonts\/Mono\.woff2/);
  });
});
