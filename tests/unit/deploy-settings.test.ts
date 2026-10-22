// scripts/deploy.sh reads DEPLOY_HOST and DEPLOY_DIR from the environment or from
// .deploy.env, which it parses and never runs. `--settings` stops after that, so these
// run the real script, in a throwaway copy of the repo layout, without git or a server.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/deploy.sh", import.meta.url));
const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

/** deploy.sh --settings in a fresh directory with this .deploy.env (none if undefined) and these extra variables. */
async function settings(deployEnv: string | undefined, env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "deploy-settings-"));
  dirs.push(dir);
  await mkdir(join(dir, "scripts"));
  await copyFile(SCRIPT, join(dir, "scripts/deploy.sh"));
  if (deployEnv !== undefined) await writeFile(join(dir, ".deploy.env"), deployEnv);
  const base = { ...process.env, ...env };
  if (!("DEPLOY_HOST" in env)) delete base.DEPLOY_HOST;
  if (!("DEPLOY_DIR" in env)) delete base.DEPLOY_DIR;
  const res = spawnSync("bash", [join(dir, "scripts/deploy.sh"), "--settings"], { cwd: dir, env: base, encoding: "utf8" });
  return { ...res, dir };
}

describe("deploy.sh settings", () => {
  it("reads .deploy.env with comments, blank lines, quotes and spaces around =", async () => {
    const res = await settings(
      [
        "# Where pnpm deploy goes.",
        "",
        "DEPLOY_HOST=example-host   # an SSH host alias",
        '  DEPLOY_DIR = "/srv/example.site"  # the clone',
        "",
      ].join("\n"),
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "DEPLOY_HOST=example-host\nDEPLOY_DIR=/srv/example.site\n");
  });

  it("lets the environment win over the file", async () => {
    const res = await settings("DEPLOY_HOST=from-file\nDEPLOY_DIR=/srv/from-file\n", { DEPLOY_HOST: "from-env" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "DEPLOY_HOST=from-env\nDEPLOY_DIR=/srv/from-file\n");
  });

  it("never runs the file: a line that isn't a setting is an error", async () => {
    const res = await settings("DEPLOY_HOST=example-host\nDEPLOY_DIR=/srv/x\ntouch ran-it\nDEPLOY_DIR=$(touch ran-it)\n");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\.deploy\.env line 3 isn't DEPLOY_HOST=\.\.\. or DEPLOY_DIR=\.\.\./);
    assert.equal(existsSync(join(res.dir, "ran-it")), false);
  });

  it("only takes # as a comment after whitespace", async () => {
    const res = await settings("DEPLOY_HOST=example-host\nDEPLOY_DIR=/srv/x#y\n");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /line 2/);
  });

  it("says where to set both when they are missing", async () => {
    const res = await settings(undefined);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /DEPLOY_HOST DEPLOY_DIR not set/);
    assert.match(res.stderr, /environment/);
    assert.match(res.stderr, /\.deploy\.env/);
  });

  it("refuses a DEPLOY_HOST that ssh would read as an option", async () => {
    const res = await settings(undefined, { DEPLOY_HOST: "-oProxyCommand=x", DEPLOY_DIR: "/srv/x" });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /DEPLOY_HOST must be/);
  });
});
