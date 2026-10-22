// deploy/setup-umami.sh runs as root on the server, so this checks it two ways. Its shape:
// it parses, its sections run in the documented order, nothing changes before the checks
// pass, and certbot can't accept terms or edit configs. And its decisions, by sourcing
// it (it returns before its main flow when sourced) and calling its functions with stub
// `dig`, `curl` and `docker` commands first on PATH: the DNS comparison, the .env that is
// never regenerated or printed, the website ID check, and the default-login refusal.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../deploy/setup-umami.sh", import.meta.url));
const COMPOSE = fileURLToPath(new URL("../../deploy/umami/compose.yaml", import.meta.url));
const README = fileURLToPath(new URL("../../README.md", import.meta.url));
const lines = readFileSync(SCRIPT, "utf8").split("\n");
const code = lines.filter((line) => !/^\s*#/.test(line));

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

/** Index of the first line in `block` matching `re`, failing if there is none. */
function lineIndex(block: string[], re: RegExp, from = 0): number {
  const i = block.findIndex((line, index) => index >= from && re.test(line));
  assert.ok(i >= 0, `no line matching ${re}`);
  return i;
}

// A command that writes something, at a command position: the start of a line, or after
// one of ; & | ( if then do else while until, maybe negated with !. Also the script's own
// helpers that write, and a redirect into a file named by a variable.
const CHANGES = new RegExp(
  String.raw`(?:(?:^|[;&|(]|\b(?:if|then|do|else|while|until)\b)\s*(?:!\s*)?(?:as_owner\s+|sudo\s+-u\s+\S+\s+)?` +
    String.raw`(?:cp|mv|rm|ln|chmod|chown|install|tee|mkdir|touch|certbot|ensure_env|generate_env|install_file|reload_nginx|` +
    String.raw`systemctl\s+(?:reload|restart|start|stop)|nginx\s+-s|compose\s+(?:up|down|pull|rm|stop|restart|create|exec)|` +
    String.raw`docker\s+(?:compose\s+\S.*\s)?(?:up|down|rm|stop|kill|volume\s+(?:rm|create|prune))|` +
    String.raw`git\s+(?:-C\s+\S+\s+)?(?:clone|pull|reset|checkout|fetch|merge))\b)|(?<![0-9&])>>?\s*"?\$`,
);

const UUID = "7799cbef-167b-488b-999e-395b5e287bac";

let stubs: string;
let dns: string;
let work: string;

before(() => {
  const root = mkdtempSync(join(tmpdir(), "setup-umami-test-"));
  stubs = join(root, "bin");
  dns = join(root, "dns");
  work = join(root, "work");
  for (const dir of [stubs, dns, work]) mkdirSync(dir);
  // dig +short: the lines in $STUB_DNS/<name>.<type>, or nothing.
  stub("dig", String.raw`name= type=
for arg; do case $arg in A|AAAA) type=$arg ;; +*|-*|@*) ;; *) name=$arg ;; esac; done
cat "$STUB_DNS/$name.$type" 2>/dev/null
exit 0`);
  // curl: logs its arguments one per line to $STUB_LOG, and prints what -w asks for: the
  // next line of $STUB_STATUSES when that is set (one per call, "<http code> <exit code>",
  // and it exits with that code, as curl does), else $STUB_STATUS.
  stub("curl", String.raw`[[ -n $STUB_LOG ]] && printf '%s\n' "$@" >"$STUB_LOG"
if [[ -n $STUB_STATUSES ]]; then
  line=$(head -n1 "$STUB_STATUSES"); sed -i 1d "$STUB_STATUSES"
  printf '%s' "$line"
  rc=$(printf '%s' "$line" | cut -s -d' ' -f2)
  exit $((rc))
fi
printf '%s' "$STUB_STATUS"`);
  // docker: `docker volume inspect`, which succeeds when $STUB_VOLUME is "exists", and the
  // `compose ... exec ... psql` count of users called admin, which prints $STUB_ADMINS or fails.
  // (No braces in these bodies: in a template literal they would be JavaScript's.)
  stub("docker", String.raw`if [[ $1 == volume && $2 == inspect ]]; then [[ $STUB_VOLUME == exists ]]; exit; fi
if [[ " $* " == *" exec "* ]]; then [[ -n $STUB_ADMINS ]] || exit 1; printf '%s\n' "$STUB_ADMINS"; exit 0; fi
exit 1`);
  // nginx and systemctl: log what they are asked to $STUB_CALLS; nginx -t exits $STUB_NGINX_T.
  stub("nginx", String.raw`[[ -n $STUB_CALLS ]] && printf 'nginx %s\n' "$*" >>"$STUB_CALLS"
if [[ $1 == -t ]]; then
  if (( STUB_NGINX_T )); then echo "nginx: [emerg] the stub's reason for failing" >&2; else echo "nginx: configuration file test is successful" >&2; fi
fi
exit $((STUB_NGINX_T))`);
  stub("systemctl", String.raw`[[ -n $STUB_CALLS ]] && printf 'systemctl %s\n' "$*" >>"$STUB_CALLS"
exit 0`);
  // pgrep: a new "worker" every time, so a reload is seen to take at once.
  stub("pgrep", "date +%s%N");
});

after(() => rmSync(join(stubs, ".."), { recursive: true, force: true }));

function stub(name: string, body: string): void {
  const path = join(stubs, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** Runs `snippet` in bash after sourcing the script, with the stubs first on PATH. */
function sourced(snippet: string, env: Record<string, string> = {}): { status: number | null; out: string } {
  const res = spawnSync("bash", ["-c", `source "$SCRIPT" || exit 99\n${snippet}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, SCRIPT, STUB_DNS: dns, ...env },
    input: "",
    timeout: 10_000,
  });
  assert.equal(res.error, undefined, `bash didn't finish: ${res.error}`);
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/** Sets what the stub `dig` answers, as `name.type` => lines. */
function answers(records: Record<string, string[]>): void {
  rmSync(dns, { recursive: true, force: true });
  mkdirSync(dns);
  for (const [key, value] of Object.entries(records)) writeFileSync(join(dns, key), `${value.join("\n")}\n`);
}

describe("deploy/setup-umami.sh: its shape", () => {
  it("parses (bash -n)", () => {
    const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, "");
  });

  it("is executable, so `sudo deploy/setup-umami.sh` runs it", () => {
    assert.ok(statSync(SCRIPT).mode & 0o100, "no execute bit");
    assert.equal(lines[0], "#!/usr/bin/env bash");
  });

  it("runs its seven sections in order: pre-flight, then the five stages, then the summary", () => {
    const titles = [/^Pre-flight/, /^DNS/, /^Files/, /^Starting Umami$/, /website ID/, /^Publishing/, /^Summary$/];
    assert.deepEqual(sections.map(({ number }) => number), [0, 1, 2, 3, 4, 5, 6]);
    sections.forEach(({ title }, i) => assert.match(title, titles[i]!));
  });

  it("returns before its main flow when sourced, so the tests can call its functions", () => {
    const guard = code.indexOf('[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0');
    const root = code.findIndex((line) => line.startsWith("if (( EUID != 0 ))"));
    assert.ok(guard >= 0 && root > guard, "the guard isn't right before the main flow");
  });

  it("changes nothing on the server before the pre-flight and DNS checks have passed", () => {
    for (const number of [0, 1]) {
      assert.deepEqual(sectionCode(number).filter((line) => CHANGES.test(line)), [], `section ${number} changes something`);
      assert.ok(sectionCode(number).includes("stop_on_problems"), `section ${number} never stops on its problems`);
    }
    // Before section 0, outside the function definitions, only the log is set up.
    const early: string[] = [];
    let inFunction = false;
    for (const line of lines.slice(0, sections[0]!.index)) {
      if (/^[a-z_0-9]+\(\) \{$/.test(line)) inFunction = true;
      else if (inFunction && line === "}") inFunction = false;
      else if (!inFunction && !/^\s*#/.test(line) && !/^[a-z_0-9]+\(\) \{.*\}$/.test(line) && CHANGES.test(line)) early.push(line);
    }
    assert.deepEqual(early, ['if [[ ! -d $LOG_DIR ]] && ! install -d -o "$OWNER" -g "$OWNER_GROUP" "$LOG_DIR"; then', 'exec > >(tee -ia "$LOG") 2>&1']);
  });

  it("finds the changes it is meant to find, so the check above isn't vacuous", () => {
    for (const number of [2, 3, 4, 5]) {
      assert.ok(sectionCode(number).some((line) => CHANGES.test(line)), `section ${number} has no change the pattern sees`);
    }
  });

  it("runs from a clean checkout that is at the public main branch", () => {
    const preflight = sectionCode(0).join("\n");
    assert.match(preflight, /status --porcelain --untracked-files=no/);
    assert.match(preflight, /ls-remote --exit-code "\$REPO_URL" refs\/heads\/main/);
    assert.match(preflight, /rev-parse HEAD/);
  });

  it("checks in pre-flight what the later stages rely on", () => {
    const preflight = sectionCode(0).join("\n");
    for (const check of ["resolute", "docker compose version", "systemctl is-enabled --quiet docker", "dig", "$DEFAULT_DENY", "env_problems", "$MARKER", "zone=umami_login", "server_name", "regr.json", "$ZONE_CONF", "$STATS_AVAILABLE", "$STATS_ENABLED", ":3000"]) {
      assert.ok(preflight.includes(check), `the pre-flight section doesn't mention ${check}`);
    }
  });

  it("skips the pause once the website ID is saved, and always checks the default login before publishing", () => {
    const stage = sectionCode(4);
    const skip = lineIndex(stage, /^if website_id_saved; then$/);
    const pause = lineIndex(stage, /^\s+pause_instructions$/);
    const otherwise = lineIndex(stage, /^else$/);
    const end = lineIndex(stage, /^fi$/, skip);
    assert.ok(skip < otherwise && otherwise < pause && pause < end, "the pause isn't in the else branch of website_id_saved");
    // After the if, so it runs on every run, re-runs included.
    assert.ok(lineIndex(stage, /^check_default_login \|\| die /) > end, "the default-login check isn't after the pause");
    assert.ok(lineIndex(stage, /^check_admin_renamed \|\| die /) > end, "the admin-username check isn't after the pause");
  });

  it("publishes in a safe order: rollback armed first, certbot only without a certificate, reload only after nginx -t, and done only after the probes", () => {
    const stage = sectionCode(5);
    const armed = lineIndex(stage, /^STATE=changing$/);
    const firstInstall = lineIndex(stage, /\binstall_file\b/);
    assert.ok(armed < firstInstall, "STATE=changing comes after the first install");
    // certbot sits inside `if ! cert_exists; then ... fi`.
    const certIf = lineIndex(stage, /^if ! cert_exists; then$/);
    const certbot = lineIndex(stage, /^\s+certbot\s/);
    const certFi = lineIndex(stage, /^fi$/, certIf);
    assert.ok(certIf < certbot && certbot < certFi, "certbot runs outside `if ! cert_exists`");
    const gate = lineIndex(stage, /NGINX_T_STATUS == 0 \)\) \|\| die/, certFi);
    // The reload is skipped only when nothing changed: no file installed, no link made.
    const changed = lineIndex(stage, /^if \(\( \$\{#INSTALLED\[@\]\} > 0 \|\| LINKED \)\); then$/, gate);
    const reload = lineIndex(stage, /^\s+reload_nginx \|\| die "nginx didn't take the new config/, changed);
    const probe = lineIndex(stage, /die "after the reload/, reload);
    const finished = lineIndex(stage, /^STATE=finished$/, probe);
    assert.ok(gate < changed && changed + 2 === reload && reload < probe && probe < finished);
    // After certbot, its changes are checked before anything else is installed.
    assert.ok(lineIndex(stage, /certbot_left_changed/, certbot) < certFi, "nothing checks what certbot left");
    for (const check of ["/insights", "/login", "$EXPECTED_CSP", "FOUNDRY_BEFORE"]) {
      assert.ok(stage.slice(reload, finished).some((line) => line.includes(check)), `no ${check} check after the reload`);
    }
  });

  it("with a new database, forgets the old website ID and keeps the stats host offline until stage 5", () => {
    assert.ok(sectionCode(2).includes('drop_stale_website_id || die "couldn\'t remove the stale $WEBSITE_ID_FILE"'), "stage 2 doesn't drop a stale website ID");
    const start = sectionCode(3);
    // With no database: the link goes if it is there, and then, either way, nginx must be
    // seen not to answer for stats, before compose up starts a database with the default login.
    const fresh = lineIndex(start, /^if ! database_exists; then$/);
    assert.deepEqual(start.slice(fresh + 1, fresh + 6).map((line) => line.replace(/ \|\| die .*$/, " || die")), [
      "  if [[ -L $STATS_ENABLED ]]; then",
      "    take_offline || die",
      "  fi",
      "  ensure_offline || die",
      "fi",
    ]);
    assert.ok(fresh < lineIndex(start, /^compose up /), "compose up comes before the offline check, so a new database could start while stats is public");
  });

  it("can't be stopped between removing the link and the reload, and shows why nginx -t failed", () => {
    const body = functionBody("take_offline").split("\n").filter((line) => !/^\s*#/.test(line));
    const guard = body.findIndex((line) => /^\s*trap '' INT TERM$/.test(line));
    const rm = body.findIndex((line) => line.includes('rm -f -- "$STATS_ENABLED"'));
    const reload = body.findIndex((line) => /reload_nginx/.test(line));
    const restore = body.findIndex((line) => /^\s*catch_signals$/.test(line));
    assert.ok(guard > 0 && guard < rm && rm < reload && reload < restore, "the rm and the reload aren't inside trap '' INT TERM ... catch_signals");
    // And nothing leaves it between the two, so the signals always come back.
    assert.deepEqual(body.slice(guard + 1, restore).filter((line) => /\b(?:return|exit)\b/.test(line)), [], "a return or exit skips catch_signals");
    assert.doesNotMatch(body.join("\n"), /nginx -t >\/dev\/null/, "nginx -t's output is thrown away");
  });

  it("puts nginx.conf back in the rollback if certbot didn't", () => {
    const body = functionBody("rollback");
    assert.match(body, /if \(\( CERTBOT_ENTERED \)\); then/);
    assert.match(body, /cp -a -- "\$BACKUP\/nginx\.conf\.before-certbot" "\$NGINX\/nginx\.conf"/);
    assert.ok(sectionCode(5).some((line) => /^\s+save_before_certbot \|\| die/.test(line)), "nginx.conf isn't saved before certbot");
  });

  it("runs certbot once, for a certificate only: no terms accepted for Zach, no config edits, no prompt", () => {
    const calls = code.filter((line) => /(?:^|[;&|]|\bthen\b)\s*certbot\s/.test(line));
    assert.equal(calls.length, 1, calls.join("\n"));
    const call = calls[0]!;
    for (const flag of ["certonly", "--nginx", "--non-interactive", '--cert-name "$STATS"', '-d "$STATS"', "</dev/null"]) {
      assert.ok(call.includes(flag), `certbot without ${flag}`);
    }
    assert.doesNotMatch(call, /--agree-tos|--register-unsafely|--redirect|--force|--expand|\binstall\b|\brun\b|--email/);
  });

  it("rolls back the nginx files and can't be cut short while doing it", () => {
    const first = functionBody("on_exit").split("\n").slice(1).find((line) => !/^\s*#/.test(line));
    assert.match(first ?? "", /^\s*(?:local status=\$\?; )?trap '' INT TERM$/);
    assert.match(functionBody("on_exit"), /changing\) rollback/);
    const body = functionBody("rollback");
    assert.match(body, /for dest in "\$\{INSTALLED\[@\]\}"/);
    assert.match(body, /cp -a -- "\$saved" "\$dest"/);
    assert.match(body, /rm -f -- "\$dest"/);
    assert.match(body, /LINKED/);
  });

  it("never prints a secret: no xtrace, nothing that dumps the environment or the .env file", () => {
    for (const line of code) {
      assert.doesNotMatch(line, /\bset\s+-[a-z]*x|xtrace|BASH_XTRACEFD|\bprintenv\b|compose\s+(?:\S+\s+)*config\b|docker\s+inspect/, line);
      if (!/\$\{?ENV_(?:FILE|TMP)\b/.test(line)) continue;
      assert.doesNotMatch(line, /\b(?:cat|head|tail|less|more|tee|source|sed|awk|cut|diff|cmp)\b|<\s*"?\$\{?ENV_|^\s*\.\s/, line);
      if (/\bgrep\b/.test(line)) assert.match(line, /\bgrep\s+-[A-Za-z]*q/, `grep on the .env without -q: ${line}`);
    }
    // The random values exist only inside generate_env, which writes them to the file.
    // ... and never as a shell word that xtrace could print: openssl writes to the file itself.
    const rand = code.filter((line) => /(?:^|[;{(]\s*)openssl\s+rand\b/.test(line));
    assert.equal(rand.length, 1, rand.join("\n"));
    assert.ok(functionBody("generate_env").includes(rand[0]!), "openssl rand outside generate_env");
    assert.match(rand[0]!, /\{ printf '%s=' "\$key"; openssl rand -hex 32; \} >>"\$ENV_TMP"/);
    assert.match(functionBody("generate_env"), /^\s*local -\n\s*local key\n\s*set \+x$/m);
  });

  it("names no server: the tunnel uses a placeholder host, and 127.0.0.1 is the only address", () => {
    assert.ok(code.some((line) => line.includes("ssh -L 3000:127.0.0.1:3000 <your-ssh-host>")), "no tunnel line with <your-ssh-host>");
    const addresses = new Set(lines.flatMap((line) => [...line.matchAll(/(?<!\d|\d\.)\d{1,3}(?:\.\d{1,3}){3}(?!\.?\d)/g)].map(([ip]) => ip)));
    assert.deepEqual([...addresses], ["127.0.0.1"]);
  });
});

describe("deploy/setup-umami.sh: the DNS comparison", () => {
  const apex = "zachgreen.codes";
  const stats = "stats.zachgreen.codes";
  const check = () => sourced("check_dns");

  it("passes when stats has the apex's A record", () => {
    answers({ [`${apex}.A`]: ["203.0.113.10"], [`${stats}.A`]: ["203.0.113.10"] });
    const { status, out } = check();
    assert.equal(status, 0, out);
    assert.match(out, /203\.0\.113\.10/);
  });

  it("passes when stats is a CNAME chain that ends at the apex's address", () => {
    answers({ [`${apex}.A`]: ["203.0.113.10"], [`${stats}.A`]: ["alias.zachgreen.codes.", `${apex}.`, "203.0.113.10"] });
    const { status, out } = check();
    assert.equal(status, 0, out);
  });

  it("compares sets: the order and repeats of the addresses don't matter", () => {
    answers({ [`${apex}.A`]: ["203.0.113.11", "203.0.113.10"], [`${stats}.A`]: [`${apex}.`, "203.0.113.10", "203.0.113.11", "203.0.113.10"] });
    assert.equal(check().status, 0);
  });

  it("fails, telling Zach to add the record, when stats is a CNAME to somewhere else", () => {
    answers({ [`${apex}.A`]: ["203.0.113.10"], [`${stats}.A`]: ["elsewhere.example.", "198.51.100.20"] });
    const { status, out } = check();
    assert.equal(status, 1, out);
    assert.match(out, /Add the DNS record/);
    assert.match(out, /198\.51\.100\.20/);
    assert.doesNotMatch(out, /elsewhere\.example/, "a CNAME name was taken for an address");
  });

  it("fails, telling Zach to add the record, when stats has no record", () => {
    answers({ [`${apex}.A`]: ["203.0.113.10"] });
    const { status, out } = check();
    assert.equal(status, 1, out);
    assert.match(out, /Add the DNS record/);
  });

  it("fails when stats has only some of the apex's addresses", () => {
    answers({ [`${apex}.A`]: ["203.0.113.10", "203.0.113.11"], [`${stats}.A`]: ["203.0.113.10"] });
    assert.equal(check().status, 1);
  });

  it("compares AAAA too: the apex's IPv6 addresses must match, and stats can't add its own", () => {
    answers({ [`${apex}.A`]: ["203.0.113.10"], [`${apex}.AAAA`]: ["2001:db8::10"], [`${stats}.A`]: ["203.0.113.10"], [`${stats}.AAAA`]: [`${apex}.`, "2001:db8::10"] });
    assert.equal(check().status, 0, "same A and AAAA");
    answers({ [`${apex}.A`]: ["203.0.113.10"], [`${apex}.AAAA`]: ["2001:db8::10"], [`${stats}.A`]: ["203.0.113.10"] });
    assert.equal(check().status, 1, "stats lacks the apex's AAAA");
    answers({ [`${apex}.A`]: ["203.0.113.10"], [`${stats}.A`]: ["203.0.113.10"], [`${stats}.AAAA`]: ["2001:db8::99"] });
    assert.equal(check().status, 1, "stats has an AAAA the apex doesn't");
  });

  it("fails when the apex itself doesn't resolve, rather than comparing nothing with nothing", () => {
    answers({});
    const { status, out } = check();
    assert.equal(status, 1, out);
    assert.match(out, /zachgreen\.codes has no A record/);
  });
});

describe("deploy/setup-umami.sh: the .env", () => {
  const keys = ["APP_SECRET", "POSTGRES_PASSWORD", "TWO_FACTOR_ENCRYPTION_KEY"];

  // The keys come from the repo's compose.yaml (COMPOSE_SRC), as on the server.
  function inWork(dir: string, snippet: string, env: Record<string, string> = {}) {
    return sourced(`UMAMI_DIR=${dir}; ENV_FILE=${dir}/.env\n${snippet}`, env);
  }

  it("takes its keys from the ${NAME:?} references in compose.yaml", () => {
    const { status, out } = sourced('env_keys "$COMPOSE"', { COMPOSE });
    assert.equal(status, 0, out);
    assert.deepEqual(out.trim().split("\n"), keys);
  });

  it("generates a missing .env with mode 600, a fresh URL-safe value per key, and prints none of them", () => {
    const dir = mkdtempSync(join(work, "new-"));
    const { status, out } = inWork(dir, "ensure_env");
    assert.equal(status, 0, out);
    const env = readFileSync(join(dir, ".env"), "utf8");
    assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);
    const entries = env.trim().split("\n").map((line) => line.split("="));
    assert.deepEqual(entries.map(([key]) => key), keys);
    const values = entries.map(([, value]) => value!);
    for (const value of values) {
      assert.match(value, /^[0-9a-f]{64}$/);
      assert.ok(!out.includes(value), "a generated value was printed");
      assert.ok(!out.includes(value.slice(0, 12)), "part of a generated value was printed");
    }
    assert.equal(new Set(values).size, values.length, "two keys got the same value");
  });

  it("never regenerates an existing .env: the file stays exactly as it was", () => {
    const dir = mkdtempSync(join(work, "kept-"));
    const original = keys.map((key) => `${key}=existing-${key.toLowerCase()}`).join("\n").concat("\n");
    writeFileSync(join(dir, ".env"), original, { mode: 0o600 });
    const before = statSync(join(dir, ".env"));
    const { status, out } = inWork(dir, "ensure_env");
    assert.equal(status, 0, out);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), original);
    const after = statSync(join(dir, ".env"));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.match(out, /kept/);
    assert.ok(!out.includes("existing-"), "a value was printed");
  });

  it("refuses an existing .env that lacks a key, naming the key and not touching the file", () => {
    const dir = mkdtempSync(join(work, "partial-"));
    const original = "POSTGRES_PASSWORD=existing-password\nAPP_SECRET=\n";
    writeFileSync(join(dir, ".env"), original, { mode: 0o600 });
    const { status, out } = inWork(dir, "env_problems; printf '%s\\n' \"${PROBLEMS[@]}\"; ensure_env");
    assert.notEqual(status, 0, out);
    // Listed once by the pre-flight check, once by ensure_env.
    assert.equal(out.match(/lacks a value for: APP_SECRET TWO_FACTOR_ENCRYPTION_KEY\./g)?.length, 2, out);
    assert.ok(!out.includes("existing-password"), "a value was printed");
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), original);
  });

  it("refuses to make a new .env while the database volume exists: its password would no longer match", () => {
    const dir = mkdtempSync(join(work, "orphan-"));
    const withVolume = inWork(dir, "env_problems; printf '%s\\n' \"${PROBLEMS[@]}\"", { STUB_VOLUME: "exists" });
    assert.match(withVolume.out, /umami_umami-db/);
    const fresh = inWork(dir, "env_problems; printf 'problems=%s\\n' \"${#PROBLEMS[@]}\"", { STUB_VOLUME: "missing" });
    assert.match(fresh.out, /problems=0/);
  });
});

describe("deploy/setup-umami.sh: the website ID and the default login", () => {
  it("accepts a UUID, trimmed and lowercased, and nothing else", () => {
    const valid = [UUID, ` ${UUID}\t`, UUID.toUpperCase()];
    // Through the environment, so the tab reaches the function as a tab.
    const normalize = (input: string) => sourced('normalize_uuid "$INPUT"', { INPUT: input });
    for (const input of valid) {
      const { status, out } = normalize(input);
      assert.equal(status, 0, `${JSON.stringify(input)}: ${out}`);
      assert.equal(out, `${UUID}\n`);
    }
    const invalid = ["", "not-a-uuid", UUID.slice(1), `${UUID}0`, `{${UUID}}`, `${UUID} extra`, UUID.replaceAll("-", ""), UUID.replace("7", "g")];
    for (const input of invalid) {
      assert.equal(normalize(input).status, 1, JSON.stringify(input));
    }
  });

  it("treats the stage as done only when website-id holds a UUID", () => {
    const dir = mkdtempSync(join(work, "id-"));
    const saved = (content?: string) => {
      if (content !== undefined) writeFileSync(join(dir, "website-id"), content);
      return sourced(`WEBSITE_ID_FILE=${dir}/website-id; website_id_saved && echo "saved $WEBSITE_ID"`);
    };
    assert.equal(saved().status, 1, "no file");
    assert.equal(saved("").status, 1, "empty");
    assert.equal(saved("garbage\n").status, 1, "not a UUID");
    const ok = saved(`${UUID}\n`);
    assert.equal(ok.status, 0);
    assert.match(ok.out, new RegExp(`saved ${UUID}`));
  });

  it("doesn't wait for the website ID when stdin isn't a terminal", () => {
    const { status, out } = sourced("read_website_id");
    assert.equal(status, 1, out);
    assert.match(out, /isn't a terminal/);
  });

  it("refuses while the default login still works, and passes only on a 401", () => {
    const log = join(work, "curl.log");
    const login = (code: string) => sourced("check_default_login", { STUB_STATUS: code, STUB_LOG: log });
    const ok = login("401");
    assert.equal(ok.status, 0, ok.out);
    const args = readFileSync(log, "utf8");
    assert.match(args, /^http:\/\/127\.0\.0\.1:3000\/api\/auth\/login$/m);
    assert.match(args, /^\{"username":"admin","password":"umami"\}$/m);

    const still = login("200");
    assert.equal(still.status, 1);
    assert.match(still.out, /still log in/);
    for (const code of ["000", "500", "429"]) {
      const unknown = login(code);
      assert.equal(unknown.status, 1, `HTTP ${code} isn't proof the default login fails`);
      assert.match(unknown.out, new RegExp(`HTTP ${code}`));
    }
  });
});

describe("deploy/setup-umami.sh: the port-80 block it stages for certbot", () => {
  it("is the vhost's first server block: the plain-HTTP redirect, with no TLS in it", () => {
    const { status, out } = sourced("port80_block");
    assert.equal(status, 0, out);
    const block = out.split("\n").filter((line) => !/^\s*(?:#|$)/.test(line));
    assert.deepEqual(block, [
      "server {",
      "    listen 80;",
      "    listen [::]:80;",
      "    server_name stats.zachgreen.codes;",
      "    server_tokens off;",
      "    return 301 https://stats.zachgreen.codes$request_uri;",
      "}",
    ]);
  });
});

describe("deploy/setup-umami.sh: secrets under bash -x", () => {
  it("prints no generated value even when the whole run is traced", () => {
    const dir = mkdtempSync(join(work, "traced-"));
    const res = spawnSync("bash", ["-x", "-c", `source "$SCRIPT" || exit 99\nUMAMI_DIR=${dir}; ENV_FILE=${dir}/.env\nensure_env`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, SCRIPT },
      input: "",
      timeout: 10_000,
    });
    assert.equal(res.status, 0, res.stderr);
    const out = `${res.stdout}${res.stderr}`;
    assert.match(out, /^\++ /m, "nothing was traced, so this would prove nothing");
    const values = readFileSync(join(dir, ".env"), "utf8").trim().split("\n").map((line) => line.split("=")[1]!);
    assert.equal(values.length, 3);
    for (const value of values) {
      assert.match(value, /^[0-9a-f]{64}$/);
      assert.ok(!out.includes(value.slice(0, 12)), "a generated value is in the trace");
    }
  });
});

describe("deploy/setup-umami.sh: the admin username check", () => {
  const check = (admins?: string) => sourced("check_admin_renamed", admins === undefined ? {} : { STUB_ADMINS: admins });

  it("passes when no user is called admin", () => {
    const { status, out } = check("0");
    assert.equal(status, 0, out);
  });

  it("refuses while a user is still called admin", () => {
    const { status, out } = check("1");
    assert.equal(status, 1, out);
    assert.match(out, /still called admin/);
  });

  it("refuses when the database can't answer: no answer proves nothing", () => {
    const { status, out } = check();
    assert.equal(status, 1, out);
    assert.match(out, /STOP: couldn't read the user names/);
  });
});

describe("deploy/setup-umami.sh: a website ID whose database is gone", () => {
  const drop = (dir: string, volume: string) => sourced(`WEBSITE_ID_FILE=${dir}/website-id; drop_stale_website_id`, { STUB_VOLUME: volume });

  it("is removed when the database volume is gone, so stage 4 asks for a new one", () => {
    const dir = mkdtempSync(join(work, "stale-"));
    writeFileSync(join(dir, "website-id"), `${UUID}\n`);
    const { status, out } = drop(dir, "missing");
    assert.equal(status, 0, out);
    assert.ok(!existsSync(join(dir, "website-id")), "the stale ID is still there");
    assert.match(out, /the database it was made in is gone/);
  });

  it("is kept while its database exists", () => {
    const dir = mkdtempSync(join(work, "current-"));
    writeFileSync(join(dir, "website-id"), `${UUID}\n`);
    const { status, out } = drop(dir, "exists");
    assert.equal(status, 0, out);
    assert.equal(readFileSync(join(dir, "website-id"), "utf8"), `${UUID}\n`);
  });

  it("leaves nothing to do when no ID is saved", () => {
    const dir = mkdtempSync(join(work, "none-"));
    assert.equal(drop(dir, "missing").status, 0);
  });
});

/** An nginx tree in a temp dir, and the script's paths pointed into it. */
function nginxTree(): { root: string; setup: string; calls: string } {
  const root = mkdtempSync(join(work, "nginx-"));
  for (const dir of ["etc/nginx/conf.d", "etc/nginx/sites-available", "etc/nginx/sites-enabled", "src"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "etc/nginx/nginx.conf"), "the nginx.conf from before this run\n");
  writeFileSync(join(root, "nginx.pid"), "1\n");
  const setup = [
    `R=${root}`,
    "NGINX=$R/etc/nginx",
    "ZONE_CONF=$NGINX/conf.d/zachgreen-umami.conf",
    "STATS_AVAILABLE=$NGINX/sites-available/stats.zachgreen.codes",
    "STATS_ENABLED=$NGINX/sites-enabled/stats.zachgreen.codes",
    "BACKUP=$R/backup",
    "NGINX_PID_FILE=$R/nginx.pid",
    "LOG=$R/log",
    // Only root can install files as root: the same install, without -o and -g, and the
    // test's own user as the owner an installed file must have.
    "ROOT_OWNER=$(id -u):$(id -g)",
    'install() { local args=(); while (( $# )); do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; command install "${args[@]}"; }',
  ].join("\n");
  return { root, setup, calls: join(root, "calls") };
}

describe("deploy/setup-umami.sh: stage 5's files and their rollback", () => {
  it("puts each file back byte for byte with its mode, removes what the run made, and restores nginx.conf that certbot left changed", () => {
    const { root, setup, calls } = nginxTree();
    const zone = join(root, "etc/nginx/conf.d/zachgreen-umami.conf");
    const before = "# Installed by deploy/setup-umami.sh\nthe zone from before this run\n";
    writeFileSync(zone, before);
    chmodSync(zone, 0o640);
    writeFileSync(join(root, "src/zone.conf"), "a new zone\n");
    writeFileSync(join(root, "src/vhost.conf"), "a new vhost\n");
    const { status, out } = sourced(`${setup}
STATE=changing
install_file "$R/src/zone.conf" "$ZONE_CONF" || exit 10
install_file "$R/src/vhost.conf" "$STATS_AVAILABLE" || exit 11
link_vhost || exit 12
save_before_certbot || exit 13
echo "include /etc/letsencrypt/le_http_01_cert_challenge.conf;" >>"$NGINX/nginx.conf"
RELOADED=1
rollback`, { STUB_CALLS: calls });
    assert.equal(status, 0, out);
    assert.equal(readFileSync(zone, "utf8"), before);
    assert.equal(statSync(zone).mode & 0o777, 0o640, "the mode wasn't restored");
    assert.ok(!existsSync(join(root, "etc/nginx/sites-available/stats.zachgreen.codes")), "the run's new vhost is still there");
    assert.throws(() => lstatSync(join(root, "etc/nginx/sites-enabled/stats.zachgreen.codes")), "the run's link is still there");
    assert.equal(readFileSync(join(root, "etc/nginx/nginx.conf"), "utf8"), "the nginx.conf from before this run\n");
    assert.match(out, /restored .*nginx\.conf, which certbot had left changed/);
    const log = readFileSync(calls, "utf8");
    assert.match(log, /^nginx -t$/m);
    assert.match(log, /^systemctl reload nginx$/m);
  });

  it("leaves an unchanged file alone, with no backup directory and nothing to roll back", () => {
    const { root, setup } = nginxTree();
    const zone = join(root, "etc/nginx/conf.d/zachgreen-umami.conf");
    writeFileSync(zone, "the same zone\n", { mode: 0o644 });
    writeFileSync(join(root, "src/zone.conf"), "the same zone\n");
    const { status, out } = sourced(`${setup}\ninstall_file "$R/src/zone.conf" "$ZONE_CONF" && printf 'installed=%s\\n' "\${#INSTALLED[@]}"`);
    assert.equal(status, 0, out);
    assert.match(out, /\(unchanged\)/);
    assert.match(out, /installed=0/);
    assert.ok(!existsSync(join(root, "backup")), "a backup directory was made for nothing");
  });

  it("makes the backup directory at the first file that changes, with the old bytes in it", () => {
    const { root, setup } = nginxTree();
    const zone = join(root, "etc/nginx/conf.d/zachgreen-umami.conf");
    writeFileSync(zone, "the old zone\n", { mode: 0o644 });
    writeFileSync(join(root, "src/zone.conf"), "a new zone\n");
    const { status, out } = sourced(`${setup}\ninstall_file "$R/src/zone.conf" "$ZONE_CONF"`);
    assert.equal(status, 0, out);
    assert.match(out, /\(changed\)/);
    assert.equal(readFileSync(join(root, "backup", zone), "utf8"), "the old zone\n");
    assert.equal(readFileSync(zone, "utf8"), "a new zone\n");
  });

  it("takes a published stats host offline: the link goes, nginx -t, then a reload", () => {
    const { root, setup, calls } = nginxTree();
    writeFileSync(join(root, "etc/nginx/sites-available/stats.zachgreen.codes"), "the vhost\n");
    symlinkSync(join(root, "etc/nginx/sites-available/stats.zachgreen.codes"), join(root, "etc/nginx/sites-enabled/stats.zachgreen.codes"));
    const { status, out } = sourced(`${setup}\ntake_offline`, { STUB_CALLS: calls });
    assert.equal(status, 0, out);
    assert.throws(() => lstatSync(join(root, "etc/nginx/sites-enabled/stats.zachgreen.codes")), "the link is still there");
    assert.match(readFileSync(calls, "utf8"), /^nginx -t\nsystemctl reload nginx$/m);
  });

  it("puts the link back and fails, reloading nothing, when nginx -t fails without it", () => {
    const { root, setup, calls } = nginxTree();
    writeFileSync(join(root, "etc/nginx/sites-available/stats.zachgreen.codes"), "the vhost\n");
    symlinkSync(join(root, "etc/nginx/sites-available/stats.zachgreen.codes"), join(root, "etc/nginx/sites-enabled/stats.zachgreen.codes"));
    const { status, out } = sourced(`${setup}\ntake_offline`, { STUB_CALLS: calls, STUB_NGINX_T: "1" });
    assert.equal(status, 1, out);
    assert.match(out, /the stub's reason for failing/, "nginx -t's reason isn't shown");
    assert.ok(lstatSync(join(root, "etc/nginx/sites-enabled/stats.zachgreen.codes")).isSymbolicLink(), "the link wasn't put back");
    assert.doesNotMatch(readFileSync(calls, "utf8"), /reload/);
  });
});

describe("deploy/setup-umami.sh: nginx must not answer for stats before a new database starts", () => {
  /** Runs ensure_offline with curl answering `answers` in turn, one per request. */
  function offline(answers: string[]) {
    const { root, setup, calls } = nginxTree();
    const queue = join(root, "answers");
    writeFileSync(queue, answers.map((answer) => `${answer}\n`).join(""));
    const result = sourced(`${setup}\nensure_offline`, { STUB_STATUSES: queue, STUB_CALLS: calls });
    return { ...result, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
  }

  // Each check asks twice, 443 then 80. The catch-all's refusals, as measured against
  // 00-default-deny on Ubuntu 26.04's nginx and curl: the TLS handshake refused (35), and
  // port 80 closed with no answer (52). Each answer here is "<http code> <curl exit code>".
  const CATCH_ALL = ["000 35", "000 52"];

  it("passes, reloading nothing, on the catch-all's own refusals: 35 on 443 and 52 on 80", () => {
    const { status, out, calls } = offline(CATCH_ALL);
    assert.equal(status, 0, out);
    assert.doesNotMatch(calls, /reload/);
  });

  it("reloads nginx once when it still serves stats (its link gone, but no reload), then passes", () => {
    const { status, out, calls } = offline(["502 0", "301 0", ...CATCH_ALL]);
    assert.equal(status, 0, out);
    assert.match(out, /doesn't refuse stats\.zachgreen\.codes as its catch-all does \(443: 502 0, 80: 301 0/);
    assert.match(calls, /^systemctl reload nginx$/m);
  });

  it("counts an answer on port 80 alone as serving", () => {
    const { status, out, calls } = offline(["000 35", "301 0", ...CATCH_ALL]);
    assert.equal(status, 0, out);
    assert.match(calls, /^systemctl reload nginx$/m);
  });

  it("refuses when nginx still serves stats after the reload", () => {
    const { status, out } = offline(["502 0", "301 0", "502 0", "301 0"]);
    assert.equal(status, 1, out);
    assert.match(out, /still doesn't refuse stats\.zachgreen\.codes after a reload/);
  });

  // No answer at all is not the catch-all's answer: it proves nothing about what nginx serves.
  for (const [what, answer443, answer80] of [
    ["a timeout on 443", "000 28", "000 52"],
    ["a refused connection on both", "000 7", "000 7"],
    ["a reset on 80", "000 35", "000 56"],
    ["a name that doesn't resolve", "000 6", "000 6"],
    ["no output at all", "", ""],
  ] as const) {
    it(`refuses on ${what}, even after a reload: no answer isn't proof that stats is offline`, () => {
      const { status, out, calls } = offline([answer443, answer80, answer443, answer80]);
      assert.equal(status, 1, out);
      assert.match(calls, /^systemctl reload nginx$/m, "it didn't try a reload first");
      assert.match(out, /still doesn't refuse/);
    });
  }
});

describe("deploy/setup-umami.sh: an installed file's owner", () => {
  it("reinstalls a file whose bytes and mode are right but whose owner isn't root", () => {
    const { root, setup } = nginxTree();
    const zone = join(root, "etc/nginx/conf.d/zachgreen-umami.conf");
    writeFileSync(zone, "the same zone\n", { mode: 0o644 });
    writeFileSync(join(root, "src/zone.conf"), "the same zone\n");
    // An owner the file doesn't have: 0:0 as on the server, which the test's file isn't,
    // unless the tests run as root, which makes the file 0:0.
    const wrongOwner = process.getuid?.() === 0 ? "1:1" : "0:0";
    const { status, out } = sourced(`${setup}\nROOT_OWNER=${wrongOwner}\ninstall_file "$R/src/zone.conf" "$ZONE_CONF"`);
    assert.equal(status, 0, out);
    assert.match(out, /\(changed\)/);
    assert.ok(existsSync(join(root, "backup", zone)), "it wasn't backed up and reinstalled");
  });
});

describe("README.md's stages of setup-umami.sh", () => {
  it("are numbered and named as the script's sections are", () => {
    const readme = readFileSync(README, "utf8");
    const part = readme.slice(readme.indexOf("### Installing"), readme.indexOf("### Updates"));
    const stages = [...part.matchAll(/^(\d+)\. \*\*([^*]+?)\.\*\*/gm)].map(([, n, title]) => ({ number: Number(n), title: title! }));
    assert.deepEqual(stages.map(({ number }) => number), [0, 1, 2, 3, 4, 5]);
    for (const { number, title } of stages) {
      const section = sections.find((s) => s.number === number);
      assert.ok(section?.title.startsWith(title), `README stage ${number} is "${title}", but the script's section ${number} is "${section?.title}"`);
    }
  });
});
