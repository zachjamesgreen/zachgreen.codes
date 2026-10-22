# zachgreen.codes

The source of [zachgreen.codes](https://zachgreen.codes), Zach Green's portfolio site: a home
page, a page per project, an about page and a resume.

## No build step

The site is hand-written HTML and CSS in `site/`. There is no framework, bundler or
generator: the files in `site/` are exactly what the server sends, and deploying is a
`git pull` on the server. Pages share their header and footer by copy, not by template.

`package.json` holds development tools only (linters, tests, and the scripts that make the
resume PDF and the preview image). Nothing it installs is served.

## Local development

You need Node 24.2 or newer and pnpm (`packageManager` in `package.json` pins the version;
`corepack enable` picks it up).

```sh
pnpm install   # also turns on the pre-commit hook in .githooks/
pnpm dev       # serves site/ at http://127.0.0.1:4321
```

## Fonts

The two typefaces, Calling Code and MonoLisa, are commercial, so their files are never
committed. `site/fonts/` is gitignored, the pre-commit hook refuses to stage a font file,
and `pnpm check` fails if one is tracked. Without them the site falls back to system fonts,
which is what CI and anyone else's clone shows.

To use the real fonts locally, put the `.woff2` files that the `@font-face` rules in
`site/css/site.css` name into `site/fonts/`. `pnpm deploy` copies them to the server with
this, where `DEPLOY_HOST` and `DEPLOY_DIR` are its two settings (see Deploying):

```sh
rsync -a --delete --delete-excluded --include='*.woff2' --exclude='*' --chmod=D755,F644 \
  site/fonts/ "$DEPLOY_HOST:$DEPLOY_DIR/site/fonts/"
```

Only `.woff2` files go up. Anything else in `site/fonts/`, such as a licence file that
carries the buyer's details, stays on your machine.

Fonts are served with a year-long `immutable` cache, so browsers never check them again.
**Whenever a font file changes, give it a new file name** and update its `url()` in
`site.css`. Under the old name, returning visitors would keep the old file for a year.

## Content guard

`pnpm check` and the pre-commit hook scan `site/` for a phone number and for a list of
terms that must never appear on the site. The repo is public, so the list is not in it:

- Locally it is `.forbidden-terms` in the repo root, one term per line, `#` for comments.
  The file is gitignored. Never commit it.
- In CI it is the repository secret `FORBIDDEN_TERMS`, one term per line.

With no terms at all the guard fails instead of passing a scan that could never find
anything, so a fresh clone can't commit until it has `.forbidden-terms`. A hit is reported
by file, line and column, never by the text it matched.

## Making changes

### CSS

CSS is cached for a day, and with no build step its file names can't carry a hash. So:

- after changing `site/css/site.css`, bump the `?v=N` on its `<link>` in every page,
  `404.html` included (an e2e test checks they all match);
- after changing `site/css/print.css`, bump its `?v=N` on the resume page.

### The resume PDF and the preview image

- `pnpm resume:pdf` prints `/resume/` to `site/resume/zach-green-resume.pdf`. Run it after
  every change to the resume page: an e2e test fails while the PDF's text is out of date.
- `pnpm og:image` renders `scripts/og.html` to `site/img/og.png` (1200x630), and the favicon
  PNGs from `site/favicon.svg`.

Both need the real fonts in `site/fonts/` and refuse to run without them. Commit what they
write.

### Adding a project page

1. Create `site/<name>/index.html`. Copying `site/tagshelf/index.html` keeps the shared
   header, footer and head tags; then change the title, description, canonical URL and
   Open Graph tags.
2. Add a card for it to the Work section of `site/index.html`.
3. Add it to `PAGES` in `tests/helpers/pages.ts`. The e2e and meta tests walk that list, and
   `tests/unit/pages.test.ts` fails while `PAGES` and the pages in `site/` disagree.
4. Add its URL to `site/sitemap.xml`. `tests/unit/sitemap.test.ts` checks that the sitemap
   lists exactly `PAGES`.

## Tests

| Command | What it checks |
| --- | --- |
| `pnpm check` | `pnpm lint` (html-validate, stylelint, tsc, the font check, the content guard), then `pnpm test:unit` |
| `pnpm test:unit` | The unit tests in `tests/unit/` |
| `pnpm test:e2e` | Playwright in Chromium, Firefox and WebKit, against its own server on port 4322 (`E2E_PORT` picks another), so it can run beside `pnpm dev`. Install the browsers once with `pnpm exec playwright install`. |
| `pnpm test:nginx` | Runs the config in `deploy/nginx/` in Docker (nginx 1.28.3) and checks redirects, headers, caching and that nothing outside `site/` is served. For the stats host, it proxies to a stub of Umami and checks the proxy headers, the security headers and the login's rate limit. Needs Docker and openssl. |
| `pnpm test:links` | Crawls the local site, external links included |
| `pnpm test:lighthouse` | The Lighthouse budgets in `lighthouserc.json`. Needs Chrome. |
| `pnpm test:live` | The `test:nginx` checks against production, plus brotli, font caching, Umami at `stats.zachgreen.codes`, and port 3000 being closed. It posts made-up logins until it gets a 429, so the dashboard's login is rate-limited from your address for a minute afterwards. `BASE_URL` and `STATS_BASE_URL` point it elsewhere. |

CI runs all of them except `test:live`, which hits the live site.

## Deploying

The server runs nginx and serves a clone of this repo. nginx's root is the clone's `site/`
directory (`/var/www/zachgreen.codes/site` in `deploy/nginx/zachgreen.codes.conf`), so
nothing else in the repo is reachable.

Nothing about the server is committed. `pnpm deploy` reads where to deploy from two
settings, in the environment or in a `.deploy.env` file in the repo root. The file is
gitignored: never commit it. It holds `KEY=value` lines, read as data and never run. A `#`
after whitespace starts a comment, and the environment wins over the file.
`pnpm run deploy --settings` prints what it would use, and does nothing else. It needs
the `run`: given an argument, `pnpm deploy` is pnpm's own deploy command.

```sh
DEPLOY_HOST=<host>          # the server's SSH destination: a host alias, or <user>@<host>
DEPLOY_DIR=/path/to/site    # the clone on the server, the directory that holds site/
```

`DEPLOY_DIR` is the `root` in `deploy/nginx/zachgreen.codes.conf` minus its `/site`, the
same directory `deploy/setup-site.sh` reads from that line.

Deploy from `main` once the pull request is merged:

```sh
git switch main && git pull --ff-only
pnpm deploy      # scripts/deploy.sh
pnpm test:live
```

`pnpm deploy` refuses to run unless all of these hold:

- both settings are set;
- `HEAD` is `origin/main`;
- `site/css/site.css` has no uncommitted changes;
- `site/fonts/` has every font that `site.css` loads.

It then has the server run `git pull --ff-only`, and checks that the server is now at your
`HEAD`. Only then does it copy the fonts up, with the rsync line above.

### The nginx config

`pnpm deploy` only changes the files nginx serves. The nginx config is in `deploy/nginx/`,
and `deploy/setup-site.sh` installs it. That script runs as root on the server, so run it
again after merging any change to `deploy/nginx/`. Run it with sudo from the account that
should own the clone, and inside tmux, so a dropped connection can't cut it short:

```sh
scp deploy/setup-site.sh <host>:setup/03-setup-site.sh
ssh -t <host> tmux new-session -A -s setup
sudo bash ~/setup/03-setup-site.sh       # on the server, inside tmux
```

What the script does:

1. It checks the server, and stops without changing anything if something is off. That
   includes two things:
   - apt's plan for the brotli module, which must install nothing but the module and
     libbrotli, and remove nothing;
   - the web root that `deploy/nginx/zachgreen.codes.conf` names, which must be
     `/var/www/zachgreen.codes`.
2. It installs the brotli module, backs up the files it replaces, and clones or pulls the
   site.
3. It installs the files from the clone and runs `nginx -t`.
4. It reloads nginx, and checks that nginx took the new config. Only then does a fresh
   clone become the web root. The old config, whose root is the web root itself, is never
   live while the clone is there, so it never serves the repo's top level, `.git/`
   included. On a first run, the site answers 404 for the moment between the reload and
   that swap.
5. It checks that `/` is the site and `/.git/HEAD` is a 404.

If anything fails, it puts every file, the web root and the clone back as they were, and
reloads nginx with the old config. The brotli module package stays installed: it only
loads the module, which does nothing without this site's config.

There is one exception. If the new clone can't be moved back out of the web root, the old
config would serve its `.git/`. So the script keeps the new config, on disk and running,
doesn't reload nginx, and prints the commands that finish the rollback by hand.

The comment at the top of the script lists every step and check.

| Repo file | On the server | What it holds |
| --- | --- | --- |
| `deploy/nginx/zachgreen.codes.conf` | `/etc/nginx/sites-available/zachgreen.codes`, linked from `sites-enabled/` | The server blocks: HTTP and `www` redirects, and the site |
| `deploy/nginx/conf.d/zachgreen.conf` | `/etc/nginx/conf.d/zachgreen.conf` | The `$cache_control` map (http context) |
| `deploy/nginx/snippets/security-headers.conf` | `/etc/nginx/snippets/security-headers.conf` | CSP, HSTS and the other security headers, and `Cache-Control` |
| `deploy/nginx/snippets/zachgreen-compression.conf` | `/etc/nginx/snippets/zachgreen-compression.conf` | gzip |
| `deploy/nginx/snippets/zachgreen-brotli.conf` | `/etc/nginx/snippets/zachgreen-brotli.conf` | brotli, from the `libnginx-mod-http-brotli-filter` package |

Compression and headers are set in this site's own server blocks, so other sites on the
server keep their own. The certificate lines are the ones certbot manages, so renewal keeps
working.

## Stats (Umami)

The site's analytics are a self-hosted [Umami](https://umami.is), with its dashboard at
**https://stats.zachgreen.codes**, behind Umami's own login. Umami and its Postgres run in
Docker on the server (`deploy/umami/compose.yaml`). Umami listens on the server's
127.0.0.1:3000 only, and nginx proxies the stats host to it.

| Repo file | On the server | What it holds |
| --- | --- | --- |
| `deploy/umami/compose.yaml` | `/srv/umami/compose.yaml` | The two containers, pinned to an exact tag and digest each |
| `deploy/umami/.env.example` | `/srv/umami/.env` (root, 600) | The secrets. The script generates the real file once. Never commit it. |
| `deploy/nginx/stats.zachgreen.codes.conf` | `/etc/nginx/sites-available/stats.zachgreen.codes`, linked from `sites-enabled/` | The stats host: HTTP redirect, TLS, security headers, the proxy |
| `deploy/nginx/conf.d/zachgreen-umami.conf` | `/etc/nginx/conf.d/zachgreen-umami.conf` | The rate limit on the login (http context) |

The login, `/api/auth/login`, takes 5 attempts a minute per address after a burst of 3.
The tracker (`/insights`) and its beacon (`/api/send`) aren't limited. nginx adds HSTS
and the other security headers, but no CSP: Umami sends its own, which its dashboard needs.

### Installing

`deploy/setup-umami.sh` sets it all up. It runs as root on the server, from the server's
clone (the web root), which has to be at `main` with no local changes. Before the first run:

- `stats.zachgreen.codes` needs a DNS record: an A record with the apex's address, or a
  CNAME to `zachgreen.codes`;
- `deploy/setup-site.sh` has run, so the apex is set up and certbot has an account.

Then merge, pull the clone (`pnpm deploy` does), and on the server, inside tmux:

```sh
ssh -t <host> tmux new-session -A -s setup
cd /var/www/zachgreen.codes && sudo deploy/setup-umami.sh     # on the server
```

It logs to `~/setup/04-umami-log.txt`. It goes in stages, and is safe to run again at any
point: each stage does only what isn't done yet.

0. **Pre-flight.** It checks the server and the clone, and stops without changing anything if
   something is off.
1. **DNS.** `stats.zachgreen.codes` must resolve to the same addresses as `zachgreen.codes`.
2. **Files.** It creates `/srv/umami` (root, 700) and installs `compose.yaml`. The first
   time only, it generates `.env` with `openssl rand`. The secrets are never printed or
   logged, and an existing `.env` is never regenerated: a new database password wouldn't
   open the existing database.
3. **Starting Umami.** It runs `docker compose up -d`, waits until Umami is healthy, and
   checks that port 3000 listens on loopback only.
4. **The website ID and the default login.** Umami starts with a well-known login, so the
   script stops here until you replace it. The stats host isn't public yet. From your own
   machine:
   - open a tunnel: `ssh -L 3000:127.0.0.1:3000 <host>`, then browse to http://localhost:3000;
   - log in as `admin` / `umami`;
   - at http://localhost:3000/admin/users, give `admin` a long random username and a long
     random password (two-factor login is at http://localhost:3000/settings/security);
   - at http://localhost:3000/websites, add `zachgreen.codes`, with sharing left off;
   - paste its Website ID (in the website's settings) into the script.

   On every run after this, the script stops while the default login still works or a
   user is still called `admin`.
5. **Publishing.** certbot gets the certificate (only the first time), then the script
   installs the nginx files, runs `nginx -t`, reloads nginx if anything changed, and checks
   the result:
   - `/insights` and `/login` answer through nginx;
   - the apex still sends its CSP;
   - Foundry answers as it did before.

   If anything in this stage fails, every nginx file goes back the way it was.

After the first install:

- run `sudo certbot renew --dry-run` once, to check that renewal works;
- run `pnpm test:live` from your machine;
- add the tracker tag, with the Website ID the summary prints, to the site's pages.

### Updates, about monthly

The images are pinned, so nothing updates by itself. Unattended upgrades update Docker,
not Umami or Postgres. The login page is public, so staying current is part of keeping it safe.

1. Check [Umami's releases](https://github.com/umami-software/umami/releases) and the
   latest Postgres 18 minor. Read the release notes: Umami migrates its database by
   itself when it starts. Stay on Postgres 18: a new major release can't read the old
   data without an upgrade step.
2. In `deploy/umami/compose.yaml`, bump the tag and its digest. To get the digest:
   `docker buildx imagetools inspect ghcr.io/umami-software/umami:<version>` (or
   `postgres:<tag>`), and copy the first `Digest:` line.
3. Open a pull request and merge it. (`pnpm check` checks that each image still has an
   exact tag and a digest, not that the digest belongs to the tag, so copy it carefully.)
4. Pull the server's clone (`pnpm deploy`), then run `sudo deploy/setup-umami.sh` there
   again. It installs the new `compose.yaml` and recreates the containers that changed.
   The data stays in the `umami-db` volume.

### No backups, by design

The stats live only in the Docker volume `umami_umami-db`. If it is lost, the stats start
again from zero. `/srv/umami/.env` belongs with that volume: if the `.env` is lost but the
volume isn't, the script refuses to make a new one until the volume is removed
(`sudo docker volume rm umami_umami-db`).

A new database is a new Umami: its default login is back, and the website, with its ID, is
gone. So when the script finds no volume, it takes the stats host offline before Umami
starts, forgets the saved website ID, and stops at stage 4 again. Do the login steps
again, add the website again, and put its new ID in the site's tracker tag.

### Memory

The server is small, and Foundry runs on it too. Umami is capped at 512 MiB and Postgres
at 256 MiB (`mem_limit` in `compose.yaml`). To check:

```sh
free -h
sudo docker stats --no-stream
```

## Once a year

- In January, update the year in the footer, `Copyright <year> Zach Green`, on every page
  in `site/`, `404.html` included.
