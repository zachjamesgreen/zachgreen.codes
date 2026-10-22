// deploy/setup-site.sh and deploy/setup-umami.sh each run as root on their own (setup-site.sh
// is copied to the server and run from there), so they can't source a shared library. They
// share code by copy instead, and this keeps the copies the same, byte for byte: each shared
// function, the preamble that sets up the user, the log and the lock, and two pre-flight
// checks. What has to differ (the sudo hint, the owner's role, the log's name) is in each
// script's own variables, and what each does on exit besides the rollback in exit_cleanup.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SCRIPTS = {
  "setup-site.sh": readFileSync(new URL("../../deploy/setup-site.sh", import.meta.url), "utf8").split("\n"),
  "setup-umami.sh": readFileSync(new URL("../../deploy/setup-umami.sh", import.meta.url), "utf8").split("\n"),
};

const SHARED_FUNCTIONS = [
  "section", "info", "indent", "die", "problem", "stop_on_problems", "catch_signals", "as_owner",
  "directives", "nginx_lines_matching", "csp_of", "probe", "nginx_workers", "reload_nginx", "on_exit",
];

/** The definition of the top-level function `name`: its one line, or `name() {` through `}`. */
function definition(lines: string[], name: string): string {
  const starts = lines.flatMap((line, i) => (line.startsWith(`${name}() {`) ? [i] : []));
  assert.equal(starts.length, 1, `${name} is defined ${starts.length} times`);
  const start = starts[0]!;
  if (lines[start]!.endsWith("}") && lines[start] !== `${name}() {`) return lines[start]!;
  const end = lines.indexOf("}", start);
  return lines.slice(start, end + 1).join("\n");
}

/** The lines from the first one matching `from` through the next one matching `to`. */
function span(lines: string[], from: RegExp, to: RegExp): string {
  const start = lines.findIndex((line) => from.test(line));
  assert.ok(start >= 0, `no line matching ${from}`);
  const end = lines.findIndex((line, i) => i > start && to.test(line));
  assert.ok(end > start, `no line matching ${to} after ${from}`);
  return lines.slice(start, end + 1).join("\n");
}

function sameIn(both: (lines: string[]) => string, what: string): void {
  const [site, umami] = Object.values(SCRIPTS).map(both);
  assert.ok(site!.length > 0, `${what} is empty`);
  assert.equal(umami, site, `${what} differs between setup-site.sh and setup-umami.sh`);
}

describe("the code setup-site.sh and setup-umami.sh share", () => {
  for (const name of SHARED_FUNCTIONS) {
    it(`${name}() is the same in both`, () => sameIn((lines) => definition(lines, name), `${name}()`));
  }

  it("the preamble is the same in both: root, SUDO_USER, the log, the lock, tee, the traps", () => {
    sameIn((lines) => span(lines, /^if \(\( EUID != 0 \)\); then$/, /^echo "=== \$\(basename "\$0"\) on /), "the preamble");
    for (const [script, lines] of Object.entries(SCRIPTS)) {
      for (const variable of ["RUN_WITH", "OWNER_ROLE", "LOG_NAME"]) {
        assert.ok(lines.some((line) => line.startsWith(`${variable}=`)), `${script} doesn't set ${variable}`);
      }
      assert.ok(lines.some((line) => /^exit_cleanup\(\) \{/.test(line)), `${script} has no exit_cleanup for on_exit`);
    }
  });

  it("where the nginx master's pid is, read from nginx.conf, is the same in both", () => {
    sameIn((lines) => span(lines, /^NGINX_PID_FILE=\$\(sed /, /^\[\[ -s \$\{NGINX_PID_FILE:-\} \]\] \|\| problem /), "the pid-file lookup");
  });

  it("the check of the catch-all's four listens is the same in both", () => {
    sameIn((lines) => span(lines, /^if \[\[ -e \$DEFAULT_DENY \]\]; then$/, /^fi$/), "the catch-all check");
  });

  it("finds a difference when there is one, so the checks above aren't vacuous", () => {
    const site = SCRIPTS["setup-site.sh"];
    const changed = site.map((line) => line.replace("--max-time 5", "--max-time 10"));
    assert.notEqual(definition(changed, "probe"), definition(site, "probe"));
    assert.throws(() => definition([...site, "probe() { :; }"], "probe"), /defined 2 times/);
  });
});
