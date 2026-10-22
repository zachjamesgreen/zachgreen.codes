// deploy/setup-site.sh runs as root on the server and can't be tried out anywhere else,
// so this pins its shape: it parses, its sections run in the documented order, and the
// pre-flight checks all come before the first command that changes anything.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../deploy/setup-site.sh", import.meta.url));
const lines = readFileSync(SCRIPT, "utf8").split("\n");

/** The `section "N. Title"` calls, in file order. */
const sections = lines.flatMap((line, index) => {
  const match = /^section "(\d+)\. ([^"]+)"$/.exec(line);
  return match ? [{ index, number: Number(match[1]), title: match[2]! }] : [];
});

/** The code lines of section `number`: up to the next section, comments left out. */
function sectionCode(number: number): string[] {
  const at = sections.findIndex((section) => section.number === number);
  assert.ok(at >= 0, `no section ${number}`);
  const end = sections[at + 1]?.index ?? lines.length;
  return lines.slice(sections[at]!.index + 1, end).filter((line) => !/^\s*#/.test(line));
}

/** The body of the function `name() {` ... `}` defined at the top level. */
function functionBody(name: string): string {
  const start = lines.indexOf(`${name}() {`);
  assert.ok(start >= 0, `no function ${name}`);
  const end = lines.indexOf("}", start);
  return lines.slice(start, end + 1).join("\n");
}

// A command that writes something, at a command position: the start of a line, or after
// one of ; & | ( if then do else while until, maybe negated with !. It may run through
// as_owner or sudo -u.
const CHANGES = new RegExp(
  String.raw`(?:^|[;&|(]|\b(?:if|then|do|else|while|until)\b)\s*(?:!\s*)?(?:as_owner\s+|sudo\s+-u\s+\S+\s+)?` +
    String.raw`(?:apt-get\b[^;&|]*\b(?:install|update|upgrade|remove)\b|cp|mv|rm|ln|chmod|chown|install|tee|mkdir|touch|` +
    String.raw`systemctl\s+(?:reload|restart|start|stop)|git\s+(?:-C\s+\S+\s+)?(?:clone|pull|reset|checkout|fetch|merge))\b`,
);

describe("deploy/setup-site.sh", () => {
  it("parses (bash -n)", () => {
    const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, "");
  });

  it("runs its eight sections in order", () => {
    const titles = [
      /^Pre-flight/,
      /^The repo, and the web root/,
      /brotli/,
      /^Backing up/,
      /^The site$/,
      /^Installing/,
      /^nginx -t, reload, and check$/,
      /^Summary$/,
    ];
    assert.deepEqual(sections.map(({ number }) => number), [1, 2, 3, 4, 5, 6, 7, 8]);
    sections.forEach(({ title }, i) => assert.match(title, titles[i]!));
  });

  it("checks everything the server must have in the pre-flight section", () => {
    const code = sectionCode(1).join("\n");
    const checks = [
      "resolute", "$DEFAULT_DENY", "[::]:80", "[::]:443", "authenticator", "gzip", "$cache_control",
      "fullchain.pem", "privkey.pem", "snippets/(security-headers|zachgreen-)", "unexpected_installs",
    ];
    for (const check of checks) {
      assert.ok(code.includes(check), `the pre-flight section doesn't mention ${check}`);
    }
    // apt's plan is a simulation: -s.
    assert.match(functionBody("unexpected_installs"), /apt-get -s /);
    // It reports removals too, and lets through only installs of the module and libbrotli.
    assert.match(functionBody("unexpected_installs"), /\^\(Inst\|Remv\)/);
    assert.match(functionBody("unexpected_installs"), /grep -vxE "Inst \(\$BROTLI_PKG\|libbrotli/);
  });

  it("changes nothing on the server before the checks in sections 1 and 2 have passed", () => {
    assert.deepEqual(sectionCode(1).filter((line) => CHANGES.test(line)), [], "the pre-flight section changes something");
    // Section 2 may only make the temporary clone it reads the web root from.
    assert.deepEqual(sectionCode(2).filter((line) => CHANGES.test(line) && !line.includes('"$STAGE"')), [], "section 2 changes something besides the temporary clone");

    // Before section 1, outside the function definitions, only the log is set up.
    const before: string[] = [];
    let inFunction = false;
    for (const line of lines.slice(0, sections[0]!.index)) {
      if (/^[a-z_]+\(\) \{$/.test(line)) inFunction = true;
      else if (inFunction && line === "}") inFunction = false;
      else if (!inFunction && !/^\s*#/.test(line) && !/^[a-z_]+\(\) \{.*\}$/.test(line) && CHANGES.test(line)) before.push(line);
    }
    assert.deepEqual(before, ['if [[ ! -d $LOG_DIR ]] && ! install -d -o "$OWNER" -g "$OWNER_GROUP" "$LOG_DIR"; then', 'exec > >(tee -ia "$LOG") 2>&1']);

    // Both sections end by stopping on any problem, and only then do changes count as such.
    for (const number of [1, 2]) assert.ok(sectionCode(number).includes("stop_on_problems"), `section ${number} never stops on its problems`);
    const second = sectionCode(2);
    assert.ok(second.indexOf("STATE=changing") > second.lastIndexOf("stop_on_problems"), "STATE=changing comes before section 2's checks");
  });

  it("finds the changes it is meant to find, so the checks above aren't vacuous", () => {
    for (const number of [3, 4, 5, 6, 7]) {
      assert.ok(sectionCode(number).some((line) => CHANGES.test(line)), `section ${number} has no change the pattern sees`);
    }
  });

  it("reloads only after nginx -t passes, and swaps in the clone and finishes only after checking nginx", () => {
    const code = sectionCode(7);
    const at = (re: RegExp) => {
      const i = code.findIndex((line) => re.test(line));
      assert.ok(i >= 0, `section 7 has no line matching ${re}`);
      return i;
    };
    const order = [
      at(/NGINX_T_STATUS == 0 \)\) \|\| die/),
      at(/^reload_nginx \|\| die/),
      at(/^\s*die "after the reload/),
      at(/^\s*mv -- "\$STAGE" "\$WEBROOT"/),
      at(/^probe \/\.git\/HEAD$/),
      at(/^STATE=finished$/),
    ];
    assert.deepEqual(order, order.toSorted((a, b) => a - b));
  });

  it("only ever takes /var/www/<domain> as the web root, and checks that before using it", () => {
    assert.ok(lines.includes("SITE_ROOT=/var/www/$DOMAIN"), "no SITE_ROOT=/var/www/$DOMAIN");
    const code = sectionCode(2);
    const derived = code.findIndex((line) => /^WEBROOT=\$\(web_root_of /.test(line));
    const bound = code.findIndex((line) => line === '[[ $WEBROOT == "$SITE_ROOT" ]] ||');
    const stop = code.indexOf("stop_on_problems", bound);
    assert.ok(derived >= 0 && bound > derived, "the web root isn't compared with SITE_ROOT after it is read");
    assert.ok(stop > bound, "no stop_on_problems after the comparison");
    // Until then, the web root is only printed or reported.
    const uses = code.slice(derived + 1, stop).filter((line) => /\$WEBROOT\b/.test(line));
    assert.deepEqual(uses.filter((line) => !/^\s*(?:info|problem) /.test(line) && line !== code[bound]), []);
  });

  it("undoes the web root first, and doesn't reload nginx while the new clone is stuck there", () => {
    const body = functionBody("rollback");
    const web = body.indexOf('mv -- "$WEBROOT" "$BACKUP/unused-clone"');
    const files = body.indexOf('for dest in "${INSTALLED[@]}"');
    const reload = body.indexOf("reload_nginx");
    assert.ok(web >= 0 && web < files && files < reload, "the clone isn't moved out of the web root before the files and the reload");
    // A failed move ends the rollback there, before the files are restored or nginx reloaded.
    assert.match(body, /else\n\s*manual_recovery\n\s*return\n/);
    assert.doesNotMatch(functionBody("manual_recovery"), /^\s*(?:reload_nginx|systemctl|nginx -s)/m);
    // A partial copy left by a failed move to the web root counts as the clone too.
    assert.match(body, /\(\( SWAPPED \)\) \|\| \{ \(\( SWAP_STARTED \)\) && \[\[ -e \$WEBROOT \]\]; \}/);
    const code = sectionCode(7);
    assert.ok(code.indexOf("  SWAP_STARTED=1") === code.findIndex((line) => /^\s*mv -- "\$STAGE" "\$WEBROOT"/.test(line)) - 1, "SWAP_STARTED isn't set right before the move");
  });

  it("can't be cut short by a signal once it is undoing a run", () => {
    const first = functionBody("on_exit").split("\n").slice(1).find((line) => !/^\s*#/.test(line));
    assert.match(first ?? "", /^\s*(?:local status=\$\?; )?trap '' INT TERM$/);
  });
});
