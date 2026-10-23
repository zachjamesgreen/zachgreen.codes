// Runs the repo's nginx config in Docker, laid out the way it is on the server, and
// checks it with the same assertions `pnpm test:live` runs against production.
//
// Everything the config references but the repo doesn't own is a stand-in written into a
// temp dir: Ubuntu's stock nginx.conf, the server's catch-all default_server, certbot's
// options-ssl-nginx.conf and ssl-dhparams.pem, self-signed certificates, and a stub of
// Umami on 127.0.0.1:3000 for the stats vhost to proxy to. The site is a copy of the
// repo's site/, plus a stub font file and the privacy probes.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { runAssertions, runStatsAssertions, STUB_HANG_HEADER } from "./assertions.ts";

const execFileAsync = promisify(execFile);

// nginx 1.28.3 is the version on the server. The digest pins the exact image.
const IMAGE = "nginx:1.28.3@sha256:146adea4768b83c607d0bdfa4188464e3da6e0a3ad4475db1d1d8f64f27c29cc";
// `after` removes the container. If a run is killed first, find the leftover with
// `docker ps -a --filter label=zachgreen.codes.test=nginx`.
const LABEL = "zachgreen.codes.test=nginx";
const REPO = resolve(import.meta.dirname, "../..");
const CONF = join(REPO, "deploy/nginx");
const FONT_STUB = "fonts/nginx-test-stub.woff2";

// Ubuntu 26.04's stock /etc/nginx/nginx.conf (package nginx 1.28.3), minus its comments.
// It sets the include layout, and its http block already has `gzip on;`. The site's
// compression settings are a server-level snippet (snippets/zachgreen-compression.conf),
// so they apply to the apex host only and repeat `gzip on;` without a duplicate.
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

// The server's catch-all: unknown hostnames get 444 and unknown SNI names a
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

// What the stub answers any other path with: the proxy headers it was sent, as JSON, so the
// test can check them.
const ECHO_BODY = `'{"host":"$http_host","xRealIp":"$http_x_real_ip","xForwardedFor":"$http_x_forwarded_for","xForwardedProto":"$http_x_forwarded_proto"}'`;

// Where the stub sends a /api/send that carries the hang header: a listener (BLACK_HOLE)
// that accepts the connection and never answers, as an Umami stuck on its database would.
const BLACK_HOLE_PORT = 3001;

// Stands in for Umami behind the stats vhost: the upstream at 127.0.0.1:3000 inside the
// container. Like Umami, it sends its own CSP, the CORS header the tracker needs, and an
// X-Powered-By that nginx must hide. /insights and /login answer as Umami's would; any
// other path answers with the proxy headers it was sent, /api/send included, so the test
// can check them, unless the request asks for a hang.
const UMAMI_STUB = `server {
    listen 127.0.0.1:3000;
    server_name _;
    server_tokens off;

    add_header Content-Security-Policy "default-src 'self'; frame-ancestors 'self';" always;
    add_header Access-Control-Allow-Origin "*" always;
    add_header X-Powered-By "Next.js" always;

    location = /insights {
        default_type application/javascript;
        return 200 "/* stub tracker */";
    }

    location = /login {
        default_type text/html;
        return 200 "<!DOCTYPE html><title>Stub login</title>";
    }

    location = /api/send {
        error_page 418 = @black_hole;
        if ($http_${STUB_HANG_HEADER.replaceAll("-", "_")}) {
            return 418;
        }
        default_type application/json;
        return 200 ${ECHO_BODY};
    }

    location @black_hole {
        proxy_pass http://127.0.0.1:${BLACK_HOLE_PORT};
    }

    location / {
        default_type application/json;
        return 200 ${ECHO_BODY};
    }
}
`;

// A listener on the loopback that accepts every connection and then says nothing, holding
// it open. The stock nginx image has perl, and nothing else that listens.
const BLACK_HOLE = `use IO::Socket::INET;
my $listener = IO::Socket::INET->new(LocalAddr => "127.0.0.1", LocalPort => ${BLACK_HOLE_PORT}, Listen => 16, ReuseAddr => 1) or die "listen: $!";
my @held;
while (my $connection = $listener->accept) { push @held, $connection }
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

  // nginx config, at the paths it has on the server. snippets/zachgreen-brotli.conf stays
  // out: the stock image has no brotli module, and an unknown directive fails `nginx -t`.
  // The site config includes it through a glob, which then matches nothing.
  await put(join(etcNginx, "nginx.conf"), UBUNTU_NGINX_CONF);
  await put(join(etcNginx, "sites-enabled/default"), DEFAULT_SERVER);
  await copy(join(CONF, "zachgreen.codes.conf"), join(etcNginx, "sites-enabled/zachgreen.codes"));
  await copy(join(CONF, "conf.d/zachgreen.conf"), join(etcNginx, "conf.d/zachgreen.conf"));
  for (const snippet of ["security-headers.conf", "zachgreen-compression.conf"]) {
    await copy(join(CONF, "snippets", snippet), join(etcNginx, "snippets", snippet));
  }
  // The stats host (Umami), as deploy/setup-umami.sh installs it, and the stub upstream.
  await copy(join(CONF, "stats.zachgreen.codes.conf"), join(etcNginx, "sites-enabled/stats.zachgreen.codes"));
  await copy(join(CONF, "conf.d/zachgreen-umami.conf"), join(etcNginx, "conf.d/zachgreen-umami.conf"));
  await put(join(etcNginx, "sites-enabled/umami-stub"), UMAMI_STUB);

  // Let's Encrypt files: a self-signed certificate per lineage.
  const certificates = { "zachgreen.codes": "DNS:zachgreen.codes,DNS:www.zachgreen.codes", "stats.zachgreen.codes": "DNS:stats.zachgreen.codes" };
  for (const [name, names] of Object.entries(certificates)) {
    const live = join(letsencrypt, "live", name);
    await mkdir(live, { recursive: true });
    await openssl(
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-noenc", "-days", "2",
      "-subj", `/CN=${name}`, "-addext", `subjectAltName=${names}`,
      "-keyout", join(live, "privkey.pem"), "-out", join(live, "fullchain.pem"),
    );
  }
  // certbot's ssl-dhparams.pem is this group too (RFC 7919 ffdhe2048).
  await openssl("genpkey", "-genparam", "-algorithm", "DH", "-pkeyopt", "group:ffdhe2048", "-out", join(letsencrypt, "ssl-dhparams.pem"));
  await put(join(letsencrypt, "options-ssl-nginx.conf"), CERTBOT_SSL_OPTIONS);

  // The web root is the repo clone; nginx serves only its site/.
  await cp(join(REPO, "site"), site, { recursive: true });
  // The real fonts are gitignored, so CI has none. nginx types a file by its extension,
  // so a stub under its own name is enough to check the font caching rule.
  await put(join(site, FONT_STUB), "wOF2 stub for the nginx test\n");
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
  await docker("exec", "--detach", container, "perl", "-e", BLACK_HOLE);
  await waitUntilListening(container, BLACK_HOLE_PORT);
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
    fontPath: `/${FONT_STUB}`,
  });
});

test("the stats config passes the shared stats assertions", async () => {
  assert.ok(container, "the container didn't start");
  await runStatsAssertions({
    base: `https://stats.zachgreen.codes:${ports.https}`,
    httpBase: `http://stats.zachgreen.codes:${ports.http}`,
    resolveTo: "127.0.0.1",
    insecureTls: true,
    echoUpstream: true,
    silentUpstream: true,
  });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
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

/** Waits until something in the container accepts connections on 127.0.0.1:`port`. */
async function waitUntilListening(id: string, port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await succeeds("docker", "exec", id, "bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`))) {
    if (Date.now() > deadline) throw new Error(`nothing listens on 127.0.0.1:${port} in the container`);
    await delay(100);
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
