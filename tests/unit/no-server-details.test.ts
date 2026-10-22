// The repo is public, so nothing that identifies the server is committed: no SSH host
// or alias, no user names, no home directories, no IP address. Where to deploy comes
// from the environment or the gitignored .deploy.env (scripts/deploy.sh), the server
// scripts take their user from SUDO_USER (deploy/setup-site.sh, deploy/setup-umami.sh),
// and setup-umami.sh learns the server's address from DNS. Paths that follow from the
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
// For the address and home-directory checks, the tests as well: an address in a fixture or
// a sample is just as public. (The command checks read prose, so they stay on SCOPE.)
const WIDE_SCOPE = [...SCOPE, ...tracked("tests")];

// The addresses below are put together at run time, so that this file, which is in
// WIDE_SCOPE as well, holds none of them itself.
const dotted = (...parts: (number | string)[]) => parts.join(".");

// ssh to a literal host. Options are skipped over, and so is a forward to this machine's
// loopback (-L 3000:127.0.0.1:3000), whose argument would otherwise read as the host; any
// other option argument still does, so `-l <user>` is caught too.
const LOOPBACK_FORWARD = String.raw`-[LR]\s*\d+:(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?!\S)`;
const SSH_LITERAL_HOST = new RegExp(
  String.raw`\bssh\b(?:\s+(?:${LOOPBACK_FORWARD}|-(?!${LOOPBACK_FORWARD.slice(1)})[A-Za-z]+))*\s+(?!["']?\$|<|-)[A-Za-z0-9_.@-]+`,
);

// An IPv4 address, unless it is loopback (127.0.0.0/8), unspecified (0.0.0.0) or in a
// documentation range (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, RFC 5737). The
// server's address is learned at run time, from DNS, never written down. An address still
// counts at the end of a sentence (a period after it) and at the start of a reverse-DNS
// name, and with leading zeros; it doesn't inside a longer dotted number, like a five-part
// version.
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d|0\d\d?)`;
const IPV4_NOT_ALLOWED = new RegExp(
  String.raw`(?<!\d|\d\.)(?!127\.|0\.0\.0\.0(?!\.?\d)|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)${OCTET}(?:\.${OCTET}){3}(?!\.?\d)`,
);

describe("no server details in the repo", () => {
  it("has files to check", () => {
    assert.ok(WIDE_SCOPE.includes("tests/live/live.test.ts"), "the tests aren't in WIDE_SCOPE");
    for (const file of ["deploy/setup-site.sh", "deploy/setup-umami.sh", "deploy/umami/compose.yaml", "deploy/nginx/stats.zachgreen.codes.conf", "scripts/deploy.sh", "README.md"]) {
      assert.ok(SCOPE.includes(file), `${file} isn't tracked, so nothing checks it`);
    }
  });

  it("names no /home/<user> directory", () => {
    assert.deepEqual(hits(WIDE_SCOPE, /\/home\/[A-Za-z0-9._-]+/), []);
  });

  it("runs sudo -u only with a variable, never a literal user", () => {
    assert.deepEqual(hits(SCOPE, /\bsudo\b(?:\s+-[A-Za-z]+)*\s+-u\s*(?!["']?\$)\S/), []);
  });

  it("runs ssh only to a variable or a <placeholder>, never a literal host", () => {
    assert.deepEqual(hits(SCOPE, SSH_LITERAL_HOST), []);
  });

  it("reads a loopback port forward as an option, not as a host, and still catches a literal host", () => {
    for (const ok of ["ssh -L 3000:127.0.0.1:3000 <your-ssh-host>", "ssh -t <host> tmux", 'ssh "$DEPLOY_HOST" "cd x"', "ssh -L 8080:localhost:80 $HOST"]) {
      assert.doesNotMatch(ok, SSH_LITERAL_HOST, ok);
    }
    for (const literal of ["ssh -L 3000:127.0.0.1:3000 myserver", "ssh -t myserver", "ssh -L 3000:db.internal:3000 <host>", "ssh -l someone $HOST"]) {
      assert.match(literal, SSH_LITERAL_HOST, literal);
    }
  });

  it("gives scp and rsync no literal host:path either", () => {
    const remote = /(?:^|[\s"'=])(?![$<])[A-Za-z0-9_.@-]+:(?!\/\/)[~/\w$.]/;
    assert.deepEqual(hits(SCOPE, remote, /\b(?:scp|rsync)\s/), []);
  });

  it("names no IPv4 address but loopback, unspecified and documentation ones", () => {
    assert.deepEqual(hits(WIDE_SCOPE, IPV4_NOT_ALLOWED), []);
  });

  it("tells the addresses apart, so the check above isn't vacuous", () => {
    const allowed = [
      "127.0.0.1", "127.0.0.53", "on 127.0.0.1.", "0.0.0.0", "0.0.0.0:3000", "192.0.2.10", "198.51.100.7.", "203.0.113.255",
      "1.28.3", "v24.2", "version 1.2.3.4.5", "1.2.3.4.5.",
    ];
    for (const text of allowed) {
      assert.doesNotMatch(` ${text} `, IPV4_NOT_ALLOWED, text);
    }
    const flagged = [
      dotted(10, 20, 30, 40),
      `listen ${dotted(172, 16, 5, 4)}:80;`,
      `@${dotted(192, 168, 1, 20)}`,
      `${dotted(8, 8, 8, 8)}:53`,
      dotted(0, 0, 0, 1),
      // At the end of a sentence, and in its reverse-DNS form.
      `is ${dotted(10, 20, 30, 40)}.`,
      `${dotted(40, 30, 20, 10)}.in-addr.arpa.`,
      // With leading zeros, which many tools still read as the same address.
      dotted("010", "020", "030", "040"),
      `${dotted(172, "016", 5, "004")}.`,
    ];
    for (const text of flagged) {
      assert.match(text, IPV4_NOT_ALLOWED, text);
    }
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
