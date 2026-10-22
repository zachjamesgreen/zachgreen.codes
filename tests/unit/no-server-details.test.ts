// The repo is public, so nothing that identifies the server is committed: no SSH host
// or alias, no user names, no home directories. Where to deploy comes from the
// environment or the gitignored .deploy.env (scripts/deploy.sh), and the server script
// takes its user from SUDO_USER (deploy/setup-site.sh). Paths that follow from the
// domain, like /var/www/zachgreen.codes and /etc/letsencrypt/live/zachgreen.codes/, are
// fine, and so are placeholders like <host>.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPLOY_ENV = join(ROOT, ".deploy.env");

function tracked(...paths: string[]): string[] {
  const res = spawnSync("git", ["ls-files", "-z", "--", ...paths], { cwd: ROOT, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.split("\0").filter(Boolean);
}

/**
 * `file:line` for every line of `files` that `re` matches. A line ending in a backslash is
 * read together with the next, as the shell would, so a command split over lines is one.
 */
function hits(files: string[], re: RegExp, lineFilter: RegExp = /(?:)/): string[] {
  return files.flatMap((file) => {
    const found: string[] = [];
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const first = i;
      let line = lines[i]!;
      while (line.endsWith("\\") && i + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++i]}`;
      if (lineFilter.test(line) && re.test(line)) found.push(`${file}:${first + 1}`);
    }
    return found;
  });
}

const SCOPE = tracked("deploy", "scripts", "README.md");

describe("no server details in the repo", () => {
  it("has files to check", () => {
    assert.ok(SCOPE.includes("deploy/setup-site.sh") && SCOPE.includes("scripts/deploy.sh") && SCOPE.includes("README.md"));
  });

  it("names no /home/<user> directory", () => {
    assert.deepEqual(hits(SCOPE, /\/home\/[A-Za-z0-9._-]+/), []);
  });

  it("runs sudo -u only with a variable, never a literal user", () => {
    assert.deepEqual(hits(SCOPE, /\bsudo\b(?:\s+-[A-Za-z]+)*\s+-u\s*(?!["']?\$)\S/), []);
  });

  it("runs ssh only to a variable or a <placeholder>, never a literal host", () => {
    assert.deepEqual(hits(SCOPE, /\bssh\b(?:\s+-[A-Za-z]+)*\s+(?!["']?\$|<|-)[A-Za-z0-9_.@-]+/), []);
  });

  it("gives scp and rsync no literal host:path either", () => {
    const remote = /(?:^|[\s"'=])(?![$<])[A-Za-z0-9_.@-]+:(?!\/\/)[~/\w$.]/;
    assert.deepEqual(hits(SCOPE, remote, /\b(?:scp|rsync)\s/), []);
  });

  // The real host is only on this machine, so CI can't run this one.
  it("doesn't contain the DEPLOY_HOST of the local .deploy.env anywhere", { skip: !existsSync(DEPLOY_ENV) && "no .deploy.env here" }, () => {
    const host = /^DEPLOY_HOST=["']?([^"'\s]+)/m.exec(readFileSync(DEPLOY_ENV, "utf8"))?.[1];
    assert.ok(host, ".deploy.env has no DEPLOY_HOST");
    const word = new RegExp(String.raw`(?<![\w.-])${host.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?![\w-])`);
    const files = tracked(".").filter((file) => !readFileSync(join(ROOT, file)).includes(0));
    // File names only: the host itself stays out of the output.
    assert.deepEqual(files.filter((file) => word.test(readFileSync(join(ROOT, file), "utf8"))), []);
  });
});
