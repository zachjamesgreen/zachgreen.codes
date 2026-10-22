#!/usr/bin/env bash
# Deploys zachgreen.codes. Run it as yourself, no sudo, from a machine that has the fonts:
#
#   pnpm deploy
#
# The server's clone pulls main from GitHub, then the fonts, which are never committed,
# are copied up from site/fonts/. This only changes the files nginx serves: a change
# under deploy/nginx/ goes live by re-running deploy/setup-site.sh on the server.
#
# Where to deploy is never committed. It comes from the environment or, for what the
# environment doesn't set, from .deploy.env in the repo root (gitignored), as KEY=value
# lines that are read, not run. A `#` after whitespace starts a comment, and values may
# be quoted:
#   DEPLOY_HOST  the server's SSH destination: a host alias from your SSH config, or user@host
#   DEPLOY_DIR   the clone's directory on the server, the one that holds site/
# `pnpm run deploy --settings` prints the two it would use, and does nothing else. (It
# needs the `run`: given an argument, `pnpm deploy` is pnpm's own deploy command.)
# Afterwards, `pnpm test:live` checks production.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() {
  printf 'deploy: %s\n' "$1" >&2
  shift
  if (( $# > 0 )); then printf '  %s\n' "$@" >&2; fi
  exit 1
}

case ${1:-} in
  "" | --settings) ;;
  *) fail "usage: scripts/deploy.sh [--settings]" ;;
esac

# KEY=value, then maybe whitespace and a # comment. The value is "double-quoted",
# 'single-quoted', or bare: no whitespace, quotes or #.
dq='"[^"]*"'
sq="'[^']*'"
bare="[^[:space:]\"'#]*"
setting_re="^[[:space:]]*(DEPLOY_HOST|DEPLOY_DIR)[[:space:]]*=[[:space:]]*($dq|$sq|$bare)([[:space:]]+#.*)?[[:space:]]*$"
if [[ -f .deploy.env ]]; then
  n=0
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ $setting_re ]] || fail ".deploy.env line $n isn't DEPLOY_HOST=... or DEPLOY_DIR=..., with an optional # comment after it"
    key=${BASH_REMATCH[1]}
    value=${BASH_REMATCH[2]}
    if [[ $value == \"*\" || $value == \'*\' ]]; then value=${value:1:-1}; fi
    # The environment wins.
    [[ -n ${!key:-} ]] || printf -v "$key" '%s' "$value"
  done <.deploy.env
fi
missing=()
[[ -n ${DEPLOY_HOST:-} ]] || missing+=(DEPLOY_HOST)
[[ -n ${DEPLOY_DIR:-} ]] || missing+=(DEPLOY_DIR)
if (( ${#missing[@]} > 0 )); then
  fail "${missing[*]} not set. Set both in the environment, or in .deploy.env in the repo root" \
    "(gitignored; one KEY=value per line, read as data, never run):" \
    "  DEPLOY_HOST=<host>        # the server's SSH destination: a host alias, or <user>@<host>" \
    "  DEPLOY_DIR=/path/to/site  # the clone on the server, the directory that holds site/"
fi
# Both end up in commands run on the server, so only plain values get through.
[[ $DEPLOY_HOST =~ ^[A-Za-z0-9_.@-]+$ && $DEPLOY_HOST != -* ]] || fail "DEPLOY_HOST must be a host alias, a host name or user@host."
[[ $DEPLOY_DIR =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "DEPLOY_DIR must be an absolute path of letters, digits and . _ - /."
if [[ ${1:-} == --settings ]]; then
  printf 'DEPLOY_HOST=%s\nDEPLOY_DIR=%s\n' "$DEPLOY_HOST" "$DEPLOY_DIR"
  exit 0
fi

# The server deploys origin/main, so what is checked out here has to be exactly that:
# otherwise the fonts and the check afterwards would be for something else.
git fetch --quiet origin main
head=$(git rev-parse HEAD)
main=$(git rev-parse origin/main)
if [[ $head != "$main" ]]; then
  fail "HEAD ($(git rev-parse --short HEAD)) isn't origin/main ($(git rev-parse --short origin/main)), which is what the server deploys." \
    "Merge the branch's pull request first, then: git switch main && git pull --ff-only"
fi
# The font check below reads site.css from the working tree; the server gets the committed one.
git diff --quiet HEAD -- site/css/site.css ||
  fail "site/css/site.css has uncommitted changes, so the font check would be for a stylesheet the server won't have."

# rsync --delete makes the server's fonts match these, so a missing, empty or partial
# site/fonts/ here would delete fonts there.
shopt -s nullglob
fonts=(site/fonts/*.woff2)
shopt -u nullglob
(( ${#fonts[@]} > 0 )) ||
  fail "site/fonts/ has no .woff2 files, and rsync --delete would remove the fonts on the server." "Copy the font files in first (see Fonts in README.md)."
node --input-type=module -e 'import { haveFonts } from "./scripts/lib/site.ts"; process.exitCode = haveFonts() ? 0 : 1;' ||
  fail "site/fonts/ lacks a font that site/css/site.css loads, and rsync --delete would remove it on the server."

echo "Pulling on the server..."
# shellcheck disable=SC2029  # DEPLOY_DIR is expanded here on purpose; it was checked above.
ssh "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && git pull --ff-only"
# shellcheck disable=SC2029
deployed=$(ssh "$DEPLOY_HOST" "git -C '$DEPLOY_DIR' rev-parse HEAD")
if [[ $deployed != "$head" ]]; then
  fail "the server is at ${deployed:0:7}, not $(git rev-parse --short HEAD): main moved while this ran. The fonts weren't copied." \
    "Pull, then deploy again."
fi

echo "Copying the fonts..."
# Only the .woff2 files: anything else in site/fonts/ (a licence file, which can carry the
# buyer's details) stays here, and --delete-excluded removes any copy of it there.
# --chmod: nginx reads the fonts as another user, whatever their modes are here.
rsync -a --delete --delete-excluded --include='*.woff2' --exclude='*' --chmod=D755,F644 \
  site/fonts/ "$DEPLOY_HOST:$DEPLOY_DIR/site/fonts/"

echo "Deployed $(git log -1 --format='%h %s'). Check production with: pnpm test:live"
