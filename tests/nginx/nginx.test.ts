// Runs the repo's nginx config in Docker, laid out the way it is on the server, and
// checks it with the same assertions `pnpm test:live` runs against production.
//
// Everything the config references but the repo doesn't own is a stand-in written into a
// temp dir: Ubuntu's stock nginx.conf, the server's catch-all default_server, certbot's
// options-ssl-nginx.conf and ssl-dhparams.pem, and a self-signed certificate. The site is
// a copy of the repo's site/ plus stubs for pages that don't exist yet.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { runAssertions } from "./assertions.ts";

const execFileAsync = promisify(execFile);

// nginx 1.28.3 is the version on the server (spec §3.2). The digest pins the exact image.
const IMAGE = "nginx:1.28.3@sha256:146adea4768b83c607d0bdfa4188464e3da6e0a3ad4475db1d1d8f64f27c29cc";
// `after` removes the container. If a run is killed first, find the leftover with
// `docker ps -a --filter label=zachgreen.codes.test=nginx`.
const LABEL = "zachgreen.codes.test=nginx";
const REPO = resolve(import.meta.dirname, "../..");
const CONF = join(REPO, "deploy/nginx");

// Ubuntu 26.04's stock /etc/nginx/nginx.conf (package nginx 1.28.3), minus its comments.
// It sets the include layout, and it already has `gzip on;` in the http block, so a
// second one in conf.d fails `nginx -t` as a duplicate.
const UBUNTU_NGINX_CONF = `user www-data;
worker_processes auto;
worker_cpu_affinity auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;
    server_tokens build;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    access_log /var/log/nginx/access.log;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`;

// The server's catch-all (spec §3.2): unknown hostnames get 444 and unknown SNI names a
// refused handshake. With it in place a request only reaches a zachgreen.codes block if
// that block's server_name really matches.
const DEFAULT_SERVER = `server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
    return 444;
}
`;

// The directives of certbot's options-ssl-nginx.conf, which the server blocks include.
const CERTBOT_SSL_OPTIONS = `ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;

ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;

ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384";
`;

const STUB_PAGE = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8"><title>Stub</title></head>
  <body><h1>Stub page for the nginx test</h1></body>
</html>
`;

let tmp: string | undefined;
let container: string | undefined;
let ports: { http: number; https: number };

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "nginx-test-"));
  const etcNginx = join(tmp, "etc/nginx");
  const letsencrypt = join(tmp, "etc/letsencrypt");
  const webRoot = join(tmp, "var/www/zachgreen.codes");
  const site = join(webRoot, "site");

  // nginx config, at the paths it has on the server. conf.d/zachgreen-brotli.conf stays
  // out: the stock image has no brotli module, and an unknown directive fails `nginx -t`.
  await put(join(etcNginx, "nginx.conf"), UBUNTU_NGINX_CONF);
  await put(join(etcNginx, "sites-enabled/default"), DEFAULT_SERVER);
  await copy(join(CONF, "zachgreen.codes.conf"), join(etcNginx, "sites-enabled/zachgreen.codes"));
  await copy(join(CONF, "conf.d/zachgreen.conf"), join(etcNginx, "conf.d/zachgreen.conf"));
  await copy(join(CONF, "snippets/security-headers.conf"), join(etcNginx, "snippets/security-headers.conf"));

  // Let's Encrypt files.
  const live = join(letsencrypt, "live/zachgreen.codes");
  await mkdir(live, { recursive: true });
  await openssl(
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc", "-days", "2",
    "-subj", "/CN=zachgreen.codes", "-addext", "subjectAltName=DNS:zachgreen.codes,DNS:www.zachgreen.codes",
    "-keyout", join(live, "privkey.pem"), "-out", join(live, "fullchain.pem"),
  );
  // certbot's ssl-dhparams.pem is this group too (RFC 7919 ffdhe2048).
  await openssl("genpkey", "-genparam", "-algorithm", "DH", "-pkeyopt", "group:ffdhe2048", "-out", join(letsencrypt, "ssl-dhparams.pem"));
  await put(join(letsencrypt, "options-ssl-nginx.conf"), CERTBOT_SSL_OPTIONS);

  // The web root is the repo clone; nginx serves only its site/.
  await cp(join(REPO, "site"), site, { recursive: true });
  // Pages built in parallel with this test. Written only when missing, so the real
  // files win once they exist.
  await putIfMissing(join(site, "settlor/index.html"), STUB_PAGE);
  await putIfMissing(join(site, "resume/zach-green-resume.pdf"), "%PDF-1.4\n%%EOF\n");
  // Probes beside site/, where the clone has them: unreachable because root is site/.
  await put(join(webRoot, ".git/HEAD"), "ref: refs/heads/main\n");
  await put(join(webRoot, "docs/index.html"), STUB_PAGE);
  // And a dotfile inside site/, which only the `location ~ /\.` backstop keeps private.
  await put(join(site, ".git/HEAD"), "ref: refs/heads/main\n");

  container = await docker(
    "run", "--detach", "--label", LABEL,
    "--publish", "127.0.0.1::80", "--publish", "127.0.0.1::443",
    "--volume", `${join(etcNginx, "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
    "--volume", `${join(etcNginx, "conf.d")}:/etc/nginx/conf.d:ro`,
    "--volume", `${join(etcNginx, "sites-enabled")}:/etc/nginx/sites-enabled:ro`,
    "--volume", `${join(etcNginx, "snippets")}:/etc/nginx/snippets:ro`,
    "--volume", `${letsencrypt}:/etc/letsencrypt:ro`,
    "--volume", `${webRoot}:/var/www/zachgreen.codes:ro`,
    "--entrypoint", "nginx", IMAGE, "-g", "daemon off;",
  );
  ports = { http: await hostPort(container, 80), https: await hostPort(container, 443) };
  await waitUntilServing(container);
});

after(async () => {
  try {
    if (container !== undefined) await docker("rm", "--force", container);
  } finally {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
  }
});

test("nginx -t accepts the config without warnings", async () => {
  assert.ok(container, "the container didn't start");
  const { stderr } = await execFileAsync("docker", ["exec", container, "nginx", "-t"]);
  assert.match(stderr, /test is successful/);
  assert.doesNotMatch(stderr, /\[(?:warn|error|crit|alert|emerg)\]/);
});

test("the site config passes the shared assertions", async () => {
  assert.ok(container, "the container didn't start");
  await runAssertions({
    base: `https://zachgreen.codes:${ports.https}`,
    httpBase: `http://zachgreen.codes:${ports.http}`,
    resolveTo: "127.0.0.1",
    insecureTls: true,
    expectBrotli: false,
  });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function putIfMissing(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function copy(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}

async function openssl(...args: string[]): Promise<void> {
  await execFileAsync("openssl", args);
}

async function docker(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args);
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`docker ${args[0]} failed: ${stderr || String(error)}`, { cause: error });
  }
}

/** The ephemeral host port Docker published for a container port. */
async function hostPort(id: string, containerPort: number): Promise<number> {
  const binding = await docker("port", id, `${containerPort}/tcp`); // "127.0.0.1:49153"
  const port = Number(binding.split("\n")[0]?.split(":").at(-1));
  assert.ok(Number.isInteger(port) && port > 0, `no host port for ${containerPort} in "${binding}"`);
  return port;
}

/**
 * Waits for nginx's pid file, which it writes only after binding its listening sockets, or
 * fails with its logs if it exited instead. Probing a port wouldn't work: Docker's proxy
 * accepts connections before nginx is up, and a config without a matching server answers
 * with the catch-all's 444, which looks the same.
 */
async function waitUntilServing(id: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await succeeds("docker", "exec", id, "test", "-s", "/run/nginx.pid"))) {
    const running = await docker("inspect", "--format", "{{.State.Running}}", id);
    if (running !== "true" || Date.now() > deadline) {
      const { stdout, stderr } = await execFileAsync("docker", ["logs", id]);
      throw new Error(`nginx ${running === "true" ? "didn't start in time" : "exited"}:\n${stdout}${stderr}`);
    }
    await delay(200);
  }
}

async function succeeds(command: string, ...args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
}
