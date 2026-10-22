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
| `pnpm test:nginx` | Runs the config in `deploy/nginx/` in Docker (nginx 1.28.3) and checks redirects, headers, caching and that nothing outside `site/` is served. Needs Docker and openssl. |
| `pnpm test:links` | Crawls the local site, external links included |
| `pnpm test:lighthouse` | The Lighthouse budgets in `lighthouserc.json`. Needs Chrome. |
| `pnpm test:live` | The `test:nginx` checks against production, plus brotli and font caching. `BASE_URL` points it elsewhere. |

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

## Once a year

- In January, update the year in the footer, `Copyright <year> Zach Green`, on every page
  in `site/`, `404.html` included.
