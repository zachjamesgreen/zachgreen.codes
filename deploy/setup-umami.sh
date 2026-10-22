#!/usr/bin/env bash
# Puts Umami, the site's analytics, on the server at https://stats.zachgreen.codes: the
# Docker stack in deploy/umami/compose.yaml, and the stats host's nginx config. Run it
# with sudo from the server's clone of this repo, from the account that owns the clone,
# inside tmux, so a dropped connection can't cut it short (it ignores SIGHUP as well):
#
#   ssh -t <host> tmux new-session -A -s setup
#   cd /var/www/zachgreen.codes && sudo deploy/setup-umami.sh
#
# Nothing about the server is written in here. The log goes to setup/04-umami-log.txt in
# the home of the user who ran sudo (SUDO_USER), and the server's address comes from DNS.
#
# What it does, in order. It is safe to run again at any point: each stage sees what is
# already done and does the rest. Running it again is also how a change to compose.yaml
# (an update) or to the stats nginx files goes live.
#   0. Pre-flight: checks the server, and that this checkout is the public main branch
#      with no local changes, since the files come from it. If anything is off, it lists
#      what and stops, having changed nothing.
#   1. DNS: stats.zachgreen.codes must resolve to the same addresses as zachgreen.codes,
#      A and AAAA (an A record, or a CNAME to the apex). It compares the two lookups.
#   2. Files: /srv/umami (root, 700) gets compose.yaml from this checkout, and the first
#      time only, a .env of `openssl rand` secrets (600). The .env is never printed,
#      logged or regenerated: a new database password wouldn't open the existing database.
#      A saved website ID whose database volume is gone is removed, so stage 4 asks again.
#   3. Start: `docker compose up -d`, waiting until both containers are healthy and
#      /login answers. Then it checks that port 3000 listens on loopback only. A new
#      database starts with Umami's default login, so if the stats host is already
#      published (the old volume was lost), it goes offline first, until stage 5, and the
#      nginx running here must be seen not to answer for it before Umami starts.
#   4. The website ID and the default login. Unless /srv/umami/website-id already holds
#      an ID, it stops and tells Zach how to: reach Umami through an SSH tunnel, replace its
#      default login with a long random username and password, add the website, and paste
#      its ID here. Then, on every run, it stops while the default login still works or a
#      user is still called admin: until then, Umami stays off the internet.
#   5. Publish: the certificate, if there is none yet (certbot certonly --nginx; nginx gets
#      the vhost's plain-HTTP block on its own first, for the challenge), then the nginx
#      files, `nginx -t`, a reload if anything changed, and checks that nginx serves the new
#      config: /insights and /login answer through it, the apex still has its CSP, and
#      Foundry answers as it did before. If anything in this stage fails, every nginx file
#      (nginx.conf too, if certbot left it changed) goes back the way it was and nginx
#      reloads that config. A certificate certbot got stays.
#   6. Prints a summary.
# A failure in stages 2 to 4 undoes nothing: what they did is what a re-run needs.

set -uo pipefail

REPO_URL=https://github.com/zachjamesgreen/zachgreen.codes.git
DOMAIN=zachgreen.codes
STATS=stats.$DOMAIN
FOUNDRY=foundry.$DOMAIN
# The checkout this script is in: the files come from it.
REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)
COMPOSE_SRC=$REPO_DIR/deploy/umami/compose.yaml
ZONE_SRC=$REPO_DIR/deploy/nginx/conf.d/zachgreen-umami.conf
VHOST_SRC=$REPO_DIR/deploy/nginx/stats.zachgreen.codes.conf
UMAMI_DIR=/srv/umami
COMPOSE_FILE=$UMAMI_DIR/compose.yaml
ENV_FILE=$UMAMI_DIR/.env
WEBSITE_ID_FILE=$UMAMI_DIR/website-id
PROJECT=umami
VOLUME=${PROJECT}_umami-db
UMAMI_URL=http://127.0.0.1:3000
# Umami's documented default login, which it creates with the database.
DEFAULT_LOGIN='{"username":"admin","password":"umami"}'
NGINX=/etc/nginx
DEFAULT_DENY=$NGINX/sites-enabled/00-default-deny
ZONE_CONF=$NGINX/conf.d/zachgreen-umami.conf
STATS_AVAILABLE=$NGINX/sites-available/$STATS
STATS_ENABLED=$NGINX/sites-enabled/$STATS
APEX_HEADERS=$NGINX/snippets/security-headers.conf
# In each nginx file this script installs, so it can tell its own from someone else's.
MARKER="Installed by deploy/setup-umami.sh"
# The uid:gid of each nginx file it installs.
ROOT_OWNER=0:0
LETSENCRYPT=/etc/letsencrypt
LIVE=$LETSENCRYPT/live/$STATS
RENEWAL=$LETSENCRYPT/renewal/$STATS.conf
ACME_ACCOUNTS=$LETSENCRYPT/accounts/acme-v02.api.letsencrypt.org/directory
LOCK=/run/zachgreen-codes-setup-umami.lock
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=/root/nginx-backup-umami-$STAMP
WAIT_SECONDS=180
# What the preamble below says. It is word for word the same as setup-site.sh's, and
# tests/unit/setup-scripts-shared.test.ts keeps the two that way.
RUN_WITH="sudo $0"
OWNER_ROLE="owns the site's clone"
LOG_NAME=04-umami-log.txt

# What this run has done so far, so that a failure in stage 5 undoes exactly that.
STATE=checking    # checking: nothing changed. working: stages 2-4. changing: stage 5 rolls back. finished.
INSTALLED=()      # nginx paths stage 5 has written; their old versions are in $BACKUP
LINKED=0          # 1 if this run created the sites-enabled symlink
RELOADED=0        # 1 once nginx has been reloaded
CERT_NEW=0        # 1 once certbot has got the certificate, in this run
CERTBOT_ENTERED=0 # 1 once nginx.conf is saved and certbot about to run
ENV_TMP=""        # a .env being written, removed if the run stops first
WEBSITE_ID=""
TEE_PID=""
PROBLEMS=()
PROBE_STATUS=""
PROBE_TYPE=""
PROBE_CSP=""
OUTCOME_443=""
OUTCOME_80=""
NEW_WARNINGS=""

section() { printf '\n===== %s =====\n' "$*"; }
info() { printf '  %s\n' "$*"; }
indent() { sed 's/^/    /'; }
die() {
  printf '\nABORTED: %s\n' "$*"
  exit 1
}
problem() { PROBLEMS+=("$*"); }
# Lists every problem found so far and stops, if there are any.
stop_on_problems() {
  local p
  (( ${#PROBLEMS[@]} > 0 )) || return 0
  for p in "${PROBLEMS[@]}"; do printf '  - %s\n' "${p//$'\n'/$'\n'      }"; done
  die "${#PROBLEMS[@]} check(s) failed. Nothing on the server was changed."
}
catch_signals() {
  trap 'die "interrupted (SIGINT)"' INT
  trap 'die "interrupted (SIGTERM)"' TERM
}
# git refuses to work in a repo that belongs to another user, so it runs as the owner.
as_owner() { sudo -u "$OWNER" -H "$@"; }
# The stack, always with its fixed project name, directory and .env.
compose() { docker compose --project-name "$PROJECT" --project-directory "$UMAMI_DIR" --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
# A list on one line, or "none".
words() { if [[ -n $1 ]]; then printf '%s' "${1//$'\n'/ }"; else printf 'none'; fi; }
# The lines of a config file that nginx reads: comments and blank lines removed.
directives() { sed -e 's/#.*$//' -e '/^[[:space:]]*$/d' "$1"; }
# path:line:text for each line under /etc/nginx (symlinks followed) that matches the ERE
# $1 outside its comments, leaving out the files named after it.
nginx_lines_matching() {
  local re=$1 hit path text skip
  shift
  while IFS= read -r hit; do
    path=${hit%%:*}
    text=${hit#*:*:}
    text=${text%%#*}
    [[ $text =~ $re ]] || continue
    for skip in "$@"; do [[ $path == "$skip" ]] && continue 2; done
    printf '%s\n' "$hit"
  done < <(grep -RnE -- "$re" "$NGINX" 2>/dev/null)
}
# The Content-Security-Policy value a security-headers snippet sets.
csp_of() { sed -nE 's/^[[:space:]]*add_header[[:space:]]+Content-Security-Policy[[:space:]]+"([^"]+)".*$/\1/p' "$1"; }

# The addresses DNS gives for $1's records of type $2 (A or AAAA), sorted, one per line.
# When $1 is a CNAME, dig lists the names in the chain before the addresses; only the
# addresses are kept.
addresses() {
  local pattern
  if [[ $2 == A ]]; then pattern='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; else pattern='^[0-9A-Fa-f]{0,4}(:[0-9A-Fa-f]{0,4}){2,7}$'; fi
  dig +short +time=3 +tries=2 "$1" "$2" 2>/dev/null | grep -E "$pattern" | sort -u
}
# Whether $STATS resolves to exactly $DOMAIN's addresses, A and AAAA alike: then it is
# this server, and certbot's challenge reaches it. Prints what it found either way.
check_dns() {
  local apex4 apex6 stats4 stats6 found
  apex4=$(addresses "$DOMAIN" A)
  apex6=$(addresses "$DOMAIN" AAAA)
  stats4=$(addresses "$STATS" A)
  stats6=$(addresses "$STATS" AAAA)
  if [[ -z $apex4 ]]; then
    printf '%s has no A record (or the lookup failed), so there is nothing to compare %s with.\n' "$DOMAIN" "$STATS"
    return 1
  fi
  found=$(printf '%s: A %s; AAAA %s\n' "$DOMAIN" "$(words "$apex4")" "$(words "$apex6")" "$STATS" "$(words "$stats4")" "$(words "$stats6")")
  if [[ $apex4 == "$stats4" && $apex6 == "$stats6" ]]; then
    printf '%s resolves to the same addresses as %s:\n%s\n' "$STATS" "$DOMAIN" "$found"
    return 0
  fi
  printf '%s\n' "$STATS doesn't resolve to the same addresses as $DOMAIN yet:" "$found" \
    "Add the DNS record first: an A record for $STATS with $DOMAIN's address (and an AAAA" \
    "record for each IPv6 address it has), or a CNAME from $STATS to $DOMAIN. Once it" \
    "resolves here, run this again."
  return 1
}

# The variables a compose file takes from its .env: its ${NAME:?...} references, outside
# comments, sorted.
env_keys() { grep -v '^[[:space:]]*#' "$1" | grep -oE '\$\{[A-Z][A-Z0-9_]*:\?' | sed -E 's/^\$\{([A-Z0-9_]+):\?$/\1/' | sort -u; }
# Which of the keys $2... the env file $1 has no value for, space-separated. Only ever
# tests the file, so a value can't reach the output.
env_missing() {
  local file=$1 key missing=()
  shift
  for key; do grep -qE "^$key=.+" "$file" || missing+=("$key"); done
  printf '%s' "${missing[*]}"
}
# Whether Umami's database volume exists: it holds the stats, the login and the website.
database_exists() { docker volume inspect "$VOLUME" >/dev/null 2>&1; }
# Pre-flight for the .env. One that exists is never regenerated, so it must already have
# a value for each key compose.yaml uses. A missing one is made in stage 2, which is safe
# only while there is no database whose password it would no longer match.
env_problems() {
  local keys missing
  mapfile -t keys < <(env_keys "$COMPOSE_SRC")
  if [[ -L $ENV_FILE || ( -e $ENV_FILE && ! -f $ENV_FILE ) ]]; then
    problem "$ENV_FILE isn't a regular file"
  elif [[ -f $ENV_FILE ]]; then
    [[ $(stat -c %u "$ENV_FILE") == 0 ]] || problem "$ENV_FILE isn't owned by root"
    missing=$(env_missing "$ENV_FILE" "${keys[@]}")
    [[ -z $missing ]] || problem "$ENV_FILE lacks a value for: $missing. It is never regenerated, so add each as KEY=<64 hex digits from 'openssl rand -hex 32'>, then run this again."
  elif database_exists; then
    problem "there is no $ENV_FILE, but the database volume $VOLUME exists, and a new password wouldn't open it. Put the old .env back, or, to start the stats again from zero, remove the volume (docker volume rm $VOLUME)."
  fi
}
# Writes a new $ENV_FILE with a fresh random value for each key in $@: 64 hex digits,
# which are URL-safe, as the password inside DATABASE_URL has to be. openssl writes each
# value straight into the file, so it is never a shell word that could reach the output,
# and tracing is off in here even under bash -x (local - restores it on return).
generate_env() {
  local -
  local key
  set +x
  ENV_TMP=$(mktemp "$UMAMI_DIR/.env.new.XXXXXXXX") || return 1
  for key; do
    { printf '%s=' "$key"; openssl rand -hex 32; } >>"$ENV_TMP" || return 1
    grep -qxE "$key=[0-9a-f]{64}" "$ENV_TMP" || return 1
  done
  chmod 600 "$ENV_TMP" && mv -- "$ENV_TMP" "$ENV_FILE" || return 1
  ENV_TMP=""
}
# Stage 2's .env: an existing one is kept exactly as it is; a missing one is generated.
ensure_env() {
  local keys missing
  mapfile -t keys < <(env_keys "$COMPOSE_SRC")
  (( ${#keys[@]} > 0 )) || { info "$COMPOSE_SRC has no \${NAME:?} references, so there is nothing to put in the .env"; return 1; }
  if [[ -f $ENV_FILE ]]; then
    missing=$(env_missing "$ENV_FILE" "${keys[@]}")
    if [[ -n $missing ]]; then
      info "$ENV_FILE lacks a value for: $missing. It is never regenerated: add each by hand."
      return 1
    fi
    [[ $(stat -c %a "$ENV_FILE") == 600 ]] || chmod 600 "$ENV_FILE" || return 1
    info "kept $ENV_FILE as it is (600; it is never regenerated)"
  else
    generate_env "${keys[@]}" || { info "couldn't write $ENV_FILE"; return 1; }
    info "generated $ENV_FILE (600) with a random value for each of: ${keys[*]}"
  fi
}

# $1, trimmed and lowercased, if it is a UUID (Umami's website IDs are). Fails otherwise.
normalize_uuid() {
  local id=$1
  id=${id#"${id%%[![:space:]]*}"}
  id=${id%"${id##*[![:space:]]}"}
  id=${id,,}
  [[ $id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || return 1
  printf '%s\n' "$id"
}
# Whether stage 4's pause is done: $WEBSITE_ID_FILE holds a UUID. Sets WEBSITE_ID.
website_id_saved() {
  local id
  [[ -f $WEBSITE_ID_FILE ]] || return 1
  id=$(normalize_uuid "$(<"$WEBSITE_ID_FILE")") || return 1
  WEBSITE_ID=$id
}
# A website ID belongs to the database it was made in. When that database is gone (its
# volume was lost, and there are no backups), the saved ID names nothing any more, so it
# goes, and stage 4 asks for the new website's ID.
drop_stale_website_id() {
  [[ -e $WEBSITE_ID_FILE ]] || return 0
  database_exists && return 0
  rm -f -- "$WEBSITE_ID_FILE" || return 1
  info "removed $WEBSITE_ID_FILE: the database it was made in is gone, so stage 4 asks for the new website's ID"
}
pause_instructions() {
  printf '%s\n' \
    "" \
    "  Umami is running, on this server's loopback only. Before it goes public, from your own machine:" \
    "" \
    "   1. Open an SSH tunnel to it, and leave it open:" \
    "        ssh -L 3000:127.0.0.1:3000 <your-ssh-host>" \
    "   2. Browse to http://localhost:3000 and log in with Umami's default login: admin / umami." \
    "   3. Replace that login. At http://localhost:3000/admin/users, edit admin: give it a long" \
    "      random username (Umami keeps usernames in lower case) and a long random password, and" \
    "      save. Keep both in your password manager. Two-factor login, if you want it, is at" \
    "      http://localhost:3000/settings/security." \
    "   4. At http://localhost:3000/websites, add a website: name zachgreen.codes, domain" \
    "      zachgreen.codes. Leave its sharing off, as it is for a new website." \
    "   5. Open that website's settings (Edit) and copy its Website ID." \
    "" \
    "  Then paste the Website ID here. It goes in the site's tracker tag, so it isn't secret."
}
# Reads the website ID from the terminal: three tries. Sets WEBSITE_ID. Without a
# terminal it doesn't wait, so a run with no one at it can't hang here.
read_website_id() {
  local line id _
  if [[ ! -t 0 ]]; then
    info "stdin isn't a terminal, so this can't wait for the website ID. Run this again from a terminal (inside tmux) to paste it."
    return 1
  fi
  for _ in 1 2 3; do
    printf '\n  Website ID: '
    IFS= read -r line || return 1
    if id=$(normalize_uuid "$line"); then
      WEBSITE_ID=$id
      return 0
    fi
    # Not echoed: it could be the new password, pasted into the wrong window.
    info "that isn't a website ID, which is a UUID (8-4-4-4-12 hexadecimal digits). Try again."
  done
  return 1
}
# The status Umami's login API answers for the default login, from this machine.
default_login_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H 'Content-Type: application/json' --data "$DEFAULT_LOGIN" "$UMAMI_URL/api/auth/login" 2>/dev/null
}
# Passes only when Umami rejects the default login with a 401; anything else, a success
# or an answer that proves nothing (a 5xx, no answer), stops the run.
check_default_login() {
  local status
  status=$(default_login_status)
  case $status in
    401) info "the default login (admin / umami) no longer works: Umami answers 401" ;;
    200)
      info "STOP: the default login (admin / umami) can still log in. Through the SSH tunnel, give admin a new username and password at http://localhost:3000/admin/users, then run this again."
      return 1
      ;;
    *)
      info "STOP: couldn't check the default login: Umami answered HTTP ${status:-000}, not 401."
      return 1
      ;;
  esac
}
# Passes when no user is called admin any more: renamed, or deleted for a new admin user.
# A changed password alone would leave a username anyone can guess. Like the login check,
# it fails closed: no answer from the database stops the run too.
check_admin_renamed() {
  local count
  count=$(compose exec -T db psql -U umami -d umami -tAc "select count(*) from \"user\" where username = 'admin' and deleted_at is null" 2>/dev/null | tr -d '[:space:]')
  case $count in
    0) info "no user is called admin any more" ;;
    [1-9]*)
      info "STOP: a user is still called admin. Through the SSH tunnel, give it a long random username at http://localhost:3000/admin/users, then run this again."
      return 1
      ;;
    *)
      info "STOP: couldn't read the user names from Umami's database (sudo docker compose -p $PROJECT logs db shows why), so this can't tell that none is called admin."
      return 1
      ;;
  esac
}

cert_exists() { [[ -s $LIVE/fullchain.pem && -s $LIVE/privkey.pem ]]; }
# The vhost's first server block, with the comments above it: the plain-HTTP redirect,
# which nginx needs on its own for certbot's challenge before there is a certificate.
port80_block() { sed '/^}/q' "$VHOST_SRC"; }
# The backup directory, made when the first file is about to change.
ensure_backup_dir() { [[ -d $BACKUP ]] || install -d -m 700 "$BACKUP"; }
# Installs $1 as $2 (root:root, 644), unless $2 already is exactly that: the same bytes,
# mode and owner (ROOT_OWNER). The first time a run
# changes $2, what was there goes to $BACKUP first, for the rollback.
install_file() {
  local src=$1 dest=$2 change
  if [[ ! -e $dest ]]; then
    change=new
  elif cmp -s -- "$src" "$dest" && [[ $(stat -c %a "$dest") == 644 && $(stat -c %u:%g "$dest") == "$ROOT_OWNER" ]]; then
    info "$dest (unchanged)"
    return 0
  else
    change=changed
  fi
  ensure_backup_dir || return 1
  if [[ " ${INSTALLED[*]} " != *" $dest "* ]]; then
    # Not cp --parents: as root, coreutils 9's resolves the parents from the current directory.
    if [[ -e $dest || -L $dest ]]; then
      install -d -m 700 "$BACKUP$(dirname -- "$dest")" && cp -a -- "$dest" "$BACKUP$dest" || return 1
    fi
    INSTALLED+=("$dest")
  fi
  install -m 644 -o root -g root -- "$src" "$dest" || return 1
  info "$dest ($change)"
}
# Before certbot: a copy of nginx.conf. certbot's nginx authenticator changes it for the
# challenge and should put it back; if it doesn't, the rollback does.
save_before_certbot() {
  ensure_backup_dir && cp -a -- "$NGINX/nginx.conf" "$BACKUP/nginx.conf.before-certbot" || return 1
  CERTBOT_ENTERED=1
}
# What certbot left changed, of nginx.conf and the plain-HTTP block it answered in.
certbot_left_changed() {
  local changed=()
  cmp -s -- "$BACKUP/nginx.conf.before-certbot" "$NGINX/nginx.conf" || changed+=("$NGINX/nginx.conf")
  cmp -s -- "$BACKUP/$STATS.port80" "$STATS_AVAILABLE" || changed+=("$STATS_AVAILABLE")
  printf '%s' "${changed[*]}"
}
# For a new database behind a published stats host (its old database was lost): Umami
# starts with its default login, so the host goes offline until stage 5 publishes it again.
# If nginx -t fails without the link, it says why, the link goes back and nothing is
# reloaded. Ctrl-C can't land between the link going and the reload.
take_offline() {
  local out ok=1
  trap '' INT TERM
  if ! rm -f -- "$STATS_ENABLED"; then
    ok=0
  elif ! out=$(nginx -t 2>&1); then
    info "nginx -t fails without $STATS_ENABLED, so the link goes back:"
    printf '%s\n' "$out" | indent
    ln -s -- "$STATS_AVAILABLE" "$STATS_ENABLED"
    ok=0
  elif ! reload_nginx; then
    ok=0
  fi
  catch_signals
  (( ok )) || return 1
  info "took https://$STATS offline: a new database starts with Umami's default login"
}
# How a request for $1://$STATS/ (https or http) to the nginx on this machine ends, as
# "<http code> <curl exit code>": "000 35" for a refused TLS handshake, say.
request_outcome() {
  local port=443
  [[ $1 == http ]] && port=80
  curl -sk -o /dev/null -w '%{http_code} %{exitcode}' --max-time 10 --resolve "$STATS:$port:127.0.0.1" "$1://$STATS/" 2>/dev/null
}
# Whether the nginx running here refuses $STATS the way its catch-all does, which is the
# only proof that it doesn't serve the stats vhost. What is on disk doesn't say: a link
# removed without a reload leaves the old config serving. The catch-all (00-default-deny)
# refuses the TLS handshake on 443 (curl exit 35) and closes port 80 with no answer (52),
# as measured with Ubuntu 26.04's nginx and curl. Anything else proves nothing: an answer,
# a timeout (28), a refused connection (7), a reset (56), no output. Sets OUTCOME_443 and
# OUTCOME_80, for the messages.
stats_refused() {
  OUTCOME_443=$(request_outcome https)
  OUTCOME_80=$(request_outcome http)
  [[ $OUTCOME_443 == "000 35" && $OUTCOME_80 == "000 52" ]]
}
# Before a new database starts: nginx here must refuse $STATS as its catch-all does. If it
# doesn't, one reload (the link is already gone), and then it must.
ensure_offline() {
  stats_refused && return 0
  info "nginx here doesn't refuse $STATS as its catch-all does (443: ${OUTCOME_443:-no answer}, 80: ${OUTCOME_80:-no answer}; HTTP code, curl exit code): reloading it"
  reload_nginx || { info "nginx didn't take the reload"; return 1; }
  if ! stats_refused; then
    info "nginx here still doesn't refuse $STATS after a reload (443: ${OUTCOME_443:-no answer}, 80: ${OUTCOME_80:-no answer})"
    return 1
  fi
  info "https://$STATS is offline now: nginx refuses it as its catch-all does"
}
# The sites-enabled symlink, as setup-site.sh has the apex's.
link_vhost() {
  [[ -L $STATS_ENABLED ]] && return 0
  ln -s -- "$STATS_AVAILABLE" "$STATS_ENABLED" || return 1
  LINKED=1
  info "$STATS_ENABLED -> $STATS_AVAILABLE (new)"
}
# Status and Content-Type of https://$STATS$1 from the nginx on this machine. -k: this
# checks which config nginx serves, not the certificate.
probe_stats() {
  local out
  out=$(curl -sk -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 --resolve "$STATS:443:127.0.0.1" "https://$STATS$1" 2>/dev/null)
  PROBE_STATUS=${out%% *}
  PROBE_TYPE=${out#* }
}
# Status and Content-Security-Policy of https://$DOMAIN$1 from the nginx on this machine.
# -k: this checks which config nginx serves, not the certificate (the summary shows that).
probe() {
  local headers
  headers=$(curl -sk -o /dev/null -D - --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1" 2>/dev/null | tr -d '\r')
  PROBE_STATUS=$(sed -nE '1s/^HTTP\/[0-9.]+ ([0-9]{3}).*$/\1/p' <<<"$headers")
  PROBE_CSP=$(sed -nE 's/^content-security-policy:[[:space:]]*(.*)$/\1/Ip' <<<"$headers")
}
# The status https://$1$2 answers from the nginx on this machine ("000" for none).
status_of() { curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$1:443:127.0.0.1" "https://$1$2" 2>/dev/null; }
# The nginx master's children, its workers.
nginx_workers() {
  local master
  master=$(cat "$NGINX_PID_FILE" 2>/dev/null) || return 0
  pgrep -P "$master" | sort
}
# Reloads nginx, and fails unless the master starts new workers within 10 s.
# systemctl reload returns once nginx has the signal, even if the master then rejects the
# config: it logs why and keeps its old workers serving the old one.
reload_nginx() {
  local before _
  before=$(nginx_workers)
  systemctl reload nginx || return 1
  for _ in {1..20}; do
    sleep 0.5
    [[ -n $(comm -13 <(printf '%s\n' "$before") <(nginx_workers)) ]] && return 0
  done
  return 1
}

rollback() {
  STATE=rolling-back
  section "Rolling back the nginx changes"
  local dest saved undid=0
  # The link first: a link left to a removed file would fail nginx -t.
  if (( LINKED )); then
    undid=1
    if rm -f -- "$STATS_ENABLED"; then info "removed $STATS_ENABLED (this run created it)"; else info "FAILED to remove $STATS_ENABLED"; fi
  fi
  for dest in "${INSTALLED[@]}"; do
    saved=$BACKUP$dest
    undid=1
    if [[ -e $saved || -L $saved ]]; then
      if cp -a -- "$saved" "$dest"; then info "restored $dest"; else info "FAILED to restore $dest from $saved"; fi
    else
      if rm -f -- "$dest"; then info "removed $dest (this run created it)"; else info "FAILED to remove $dest"; fi
    fi
  done
  # certbot changes nginx.conf for its challenge and should have put it back.
  if (( CERTBOT_ENTERED )); then
    if ! cmp -s -- "$BACKUP/nginx.conf.before-certbot" "$NGINX/nginx.conf"; then
      undid=1
      if cp -a -- "$BACKUP/nginx.conf.before-certbot" "$NGINX/nginx.conf"; then
        info "restored $NGINX/nginx.conf, which certbot had left changed"
      else
        info "FAILED to restore $NGINX/nginx.conf from $BACKUP/nginx.conf.before-certbot"
      fi
    fi
  fi
  (( undid )) || info "no nginx file had been changed yet"
  info "nginx -t on the restored config:"
  if nginx -t 2>&1 | indent; then
    # A reload may have been half-taken, so make sure nginx runs the restored config.
    if (( RELOADED )); then
      if reload_nginx; then
        info "reloaded nginx with the restored config"
      else
        info "WARNING: nginx didn't take the restored config. Check its error log, then reload it by hand."
      fi
    fi
  else
    info "WARNING: the restored config fails nginx -t. Don't reload nginx until that's fixed."
  fi
  if (( CERT_NEW )); then
    info "The certificate certbot got for $STATS stays in $LIVE. Its renewal needs the stats"
    info "vhost, so run this again once the problem is fixed (or: certbot delete --cert-name $STATS)."
  fi
  [[ -d $BACKUP ]] && info "Backup: $BACKUP"
  info "Log:    $LOG"
}

# What on_exit does when there is nothing to roll back: a half-written .env goes, and a
# run that fails in stages 2 to 4 says how to carry on.
exit_cleanup() {
  [[ -n $ENV_TMP ]] && rm -f -- "$ENV_TMP"
  if [[ $STATE == working ]] && (( $1 != 0 )); then
    info "Nothing from stages 2 to 4 is undone: running this again carries on from here. Log: $LOG"
  fi
}

# Word for word the same as setup-site.sh's (tests/unit/setup-scripts-shared.test.ts).
on_exit() {
  # First, so a second Ctrl-C can't cut the rollback short ($? is read in the same line).
  local status=$?; trap '' INT TERM
  case $STATE in
    changing) rollback; (( status != 0 )) || status=1 ;;
    *) exit_cleanup "$status" ;;
  esac
  # Let tee write out the end of the log before the shell (and the SSH session) goes.
  if [[ -n $TEE_PID ]]; then
    exec >&- 2>&-
    wait "$TEE_PID" 2>/dev/null
  fi
  exit "$status"
}

# Sourced (by tests/unit/setup-umami.test.ts), it stops here, with the functions defined.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0

if (( EUID != 0 )); then
  echo "Run this with sudo: $RUN_WITH" >&2
  exit 1
fi
# The clone's owner is whoever ran sudo, and the log goes in their home.
OWNER=${SUDO_USER:-}
if [[ -z $OWNER || $OWNER == root ]] || ! getent passwd "$OWNER" >/dev/null; then
  echo "Run this with sudo from the account that $OWNER_ROLE, not as root itself (SUDO_USER is '${SUDO_USER:-}')." >&2
  exit 1
fi
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)
OWNER_GROUP=$(id -gn "$OWNER")
LOG_DIR=$OWNER_HOME/setup
LOG=$LOG_DIR/$LOG_NAME
# root appends to the log, so it mustn't be a link to some other file.
if [[ ! -d $OWNER_HOME || -L $LOG_DIR || -L $LOG ]]; then
  echo "$OWNER's home ($OWNER_HOME) is missing, or $LOG_DIR or $LOG is a symlink." >&2
  exit 1
fi
# One run at a time.
if ! command -v flock >/dev/null; then
  echo "flock isn't installed (util-linux), so this can't make sure it's the only run." >&2
  exit 1
fi
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Another run of this script is going on (it holds $LOCK)." >&2
  exit 1
fi

# A dropped SSH connection must not stop a run halfway, so SIGHUP and SIGPIPE are
# ignored, by tee (which inherits that) too, and the rest of the run still lands in the log.
trap '' HUP PIPE
if [[ ! -d $LOG_DIR ]] && ! install -d -o "$OWNER" -g "$OWNER_GROUP" "$LOG_DIR"; then
  echo "Couldn't create $LOG_DIR for the log." >&2
  exit 1
fi
exec > >(tee -ia "$LOG") 2>&1
TEE_PID=$!
catch_signals
trap on_exit EXIT
# Commands run as $OWNER start in the current directory, so it must be one they can enter.
cd / || exit 1

echo "=== $(basename "$0") on $(hostname) at $(date -u '+%F %T UTC'), for $OWNER ==="
# Files this run creates are root's alone (the nginx files get 644 explicitly).
umask 077

section "0. Pre-flight checks (nothing is changed unless they all pass)"
codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release 2>/dev/null | tr -d '"')
[[ $codename == resolute ]] || problem "this is for Ubuntu 26.04 (resolute), but VERSION_CODENAME is '$codename'"

for cmd in docker nginx certbot git curl openssl ss sudo systemctl install cmp comm mktemp pgrep sha256sum stat; do
  command -v "$cmd" >/dev/null || problem "command not found: $cmd"
done
command -v dig >/dev/null || problem "dig isn't installed (Ubuntu package bind9-dnsutils); stage 1 compares DNS answers with it"
if docker info >/dev/null 2>&1; then
  docker compose version >/dev/null 2>&1 || problem "the Docker Compose plugin is missing: docker compose version fails"
else
  problem "Docker isn't running: docker info fails"
fi
# restart: unless-stopped brings the containers back after a reboot only if dockerd starts.
systemctl is-enabled --quiet docker || problem "Docker doesn't start at boot (sudo systemctl enable docker), so Umami wouldn't come back after a reboot"

# The files come from this checkout, so it must be exactly the public main branch.
if [[ -z $REPO_DIR || ! -d $REPO_DIR/.git ]]; then
  problem "this script isn't in a clone of the repo (no .git/ in '$REPO_DIR')"
else
  head=$(as_owner git -C "$REPO_DIR" rev-parse HEAD 2>&1) || problem "can't read the HEAD of $REPO_DIR as $OWNER: $head"
  dirty=$(as_owner git -C "$REPO_DIR" status --porcelain --untracked-files=no 2>&1)
  [[ -z $dirty ]] || problem "$REPO_DIR has local changes, so its files may not be the repo's:
$dirty"
  main=$(as_owner git -C "$REPO_DIR" ls-remote --exit-code "$REPO_URL" refs/heads/main 2>/dev/null | cut -f1)
  if [[ -z $main ]]; then
    problem "can't reach $REPO_URL as $OWNER, or it has no main branch"
  elif [[ $head != "$main" ]]; then
    problem "$REPO_DIR is at ${head:0:7}, not at main (${main:0:7}): pull it first (pnpm deploy does)"
  fi
  for file in "$COMPOSE_SRC" "$ZONE_SRC" "$VHOST_SRC"; do
    [[ -f $file ]] || problem "the checkout has no $file"
  done
fi

[[ -d $(dirname "$UMAMI_DIR") ]] || problem "$(dirname "$UMAMI_DIR")/ doesn't exist"
if [[ -L $UMAMI_DIR || ( -e $UMAMI_DIR && ! -d $UMAMI_DIR ) ]]; then
  problem "$UMAMI_DIR exists and isn't a directory"
elif [[ -d $UMAMI_DIR && $(stat -c %u "$UMAMI_DIR") != 0 ]]; then
  problem "$UMAMI_DIR isn't owned by root"
fi
for file in "$COMPOSE_FILE" "$WEBSITE_ID_FILE"; do
  [[ ! -L $file ]] || problem "$file is a symlink"
done
env_problems

# Another compose project called umami would be taken over by this one.
others=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | awk -v dir="$UMAMI_DIR" '$2 != dir')
[[ -z $others ]] || problem "Docker already has a compose project called $PROJECT outside $UMAMI_DIR:
$others"
# Port 3000 is Umami's: anything else on it would get the stats host's traffic.
ours=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=umami" --filter status=running 2>/dev/null)
listeners=$(ss -Htln 'sport = :3000' 2>/dev/null)
[[ -n $ours || -z $listeners ]] || problem "something besides Umami listens on :3000:
$listeners"

systemctl is-active --quiet nginx || problem "nginx isn't running"
PREFLIGHT_NGINX_T=$(nginx -t 2>&1) || problem "the current config already fails nginx -t:
$PREFLIGHT_NGINX_T"
# Where the nginx master's pid is, to see that a reload took: from nginx.conf.
nginx_conf=$(directives "$NGINX/nginx.conf" 2>/dev/null)
NGINX_PID_FILE=$(sed -nE 's/^[[:space:]]*pid[[:space:]]+([^[:space:];]+).*$/\1/p' <<<"$nginx_conf")
NGINX_PID_FILE=${NGINX_PID_FILE%%$'\n'*}
[[ -s ${NGINX_PID_FILE:-} ]] || problem "can't find the nginx master's pid: $NGINX/nginx.conf's 'pid' file ('${NGINX_PID_FILE:-}') is missing or empty"
for dir in "$NGINX/conf.d" "$NGINX/sites-available" "$NGINX/sites-enabled"; do
  [[ -d $dir ]] || problem "$dir/ is missing"
done

# The catch-all answers unknown names with 444 and refuses unknown TLS names, on IPv4 and
# IPv6. Until the stats vhost is in, certbot would otherwise copy it for its challenge.
if [[ -e $DEFAULT_DENY ]]; then
  deny=$(directives "$DEFAULT_DENY")
  for want in '[::]:80=\[::\]:80' '[::]:443=\[::\]:443' '80=((\*|0\.0\.0\.0):)?80' '443=((\*|0\.0\.0\.0):)?443'; do
    grep -qE "^[[:space:]]*listen[[:space:]]+${want#*=}[[:space:]][^;]*default_server" <<<"$deny" ||
      problem "$DEFAULT_DENY has no 'listen ${want%%=*} ... default_server'"
  done
else
  problem "$DEFAULT_DENY, the catch-all default_server, isn't there"
fi

# This script's nginx files, by name: one already there must be its own.
for file in "$ZONE_CONF" "$STATS_AVAILABLE"; do
  if [[ -L $file || ( -e $file && ! -f $file ) ]]; then
    problem "$file isn't a regular file"
  elif [[ -f $file ]] && ! grep -qF "$MARKER" "$file"; then
    problem "$file already exists and isn't this script's: it doesn't say '$MARKER'"
  fi
done
if [[ -e $STATS_ENABLED || -L $STATS_ENABLED ]] && [[ ! -L $STATS_ENABLED || $(readlink -f "$STATS_ENABLED") != "$STATS_AVAILABLE" ]]; then
  problem "$STATS_ENABLED exists and isn't a symlink to $STATS_AVAILABLE"
fi
# And what's in them: the zone's name, and the server name, must be theirs alone.
zone_users=$(nginx_lines_matching 'zone=umami_login([^[:alnum:]_]|$)' "$ZONE_CONF" "$STATS_AVAILABLE" "$STATS_ENABLED")
[[ -z $zone_users ]] || problem "the limit_req zone umami_login already appears outside this script's files:
$zone_users"
name_users=$(nginx_lines_matching "server_name[^;]*[[:space:]]${STATS//./\\.}([[:space:];]|$)" "$STATS_AVAILABLE" "$STATS_ENABLED")
[[ -z $name_users ]] || problem "another server block already answers for $STATS:
$name_users"

# After the reload, the apex must still send the CSP its snippet sets.
EXPECTED_CSP=$(csp_of "$APEX_HEADERS" 2>/dev/null)
[[ -n $EXPECTED_CSP ]] || problem "$APEX_HEADERS sets no Content-Security-Policy, so the apex can't be checked after the reload (deploy/setup-site.sh installs it)"

for file in "$LETSENCRYPT/options-ssl-nginx.conf" "$LETSENCRYPT/ssl-dhparams.pem"; do
  [[ -s $file ]] || problem "missing or empty: $file"
done
if cert_exists; then
  san=$(openssl x509 -in "$LIVE/fullchain.pem" -noout -ext subjectAltName 2>/dev/null)
  grep -qE "(^|[[:space:],])DNS:${STATS//./\\.}(,|[[:space:]]|$)" <<<"$san" || problem "the certificate in $LIVE doesn't cover $STATS"
  # Renewal uses certbot's nginx authenticator, like the apex's.
  if [[ -f $RENEWAL ]] && ! grep -qE '^[[:space:]]*authenticator[[:space:]]*=[[:space:]]*nginx[[:space:]]*$' "$RENEWAL"; then
    problem "$RENEWAL doesn't have 'authenticator = nginx'"
  fi
else
  [[ ! -e $LIVE ]] || problem "$LIVE exists, but without a certificate and key: look at it (sudo certbot certificates) first"
  # certbot runs with --non-interactive, so it needs the account the apex's certificate
  # was made with: this never registers one or accepts the terms for you.
  compgen -G "$ACME_ACCOUNTS/*/regr.json" >/dev/null ||
    problem "certbot has no Let's Encrypt account here ($ACME_ACCOUNTS/), and this never makes one or accepts the terms for you. Run 'sudo certbot register' once, then this again."
fi
stop_on_problems
info "all passed"

section "1. DNS: $STATS"
if dns=$(check_dns); then
  printf '%s\n' "$dns" | indent
else
  problem "$dns"
fi
stop_on_problems

section "2. Files in $UMAMI_DIR"
# From here, a failure leaves what was done in place: it is what a re-run builds on.
STATE=working
if [[ -d $UMAMI_DIR ]]; then
  if [[ $(stat -c %a "$UMAMI_DIR") != 700 ]]; then
    chmod 700 "$UMAMI_DIR" || die "couldn't make $UMAMI_DIR 700"
    info "made $UMAMI_DIR 700"
  fi
  info "$UMAMI_DIR is there"
else
  install -d -m 700 -o root -g root "$UMAMI_DIR" || die "couldn't create $UMAMI_DIR"
  info "created $UMAMI_DIR (root, 700)"
fi
# A changed compose.yaml is how an update arrives: stage 3 recreates what changed.
if [[ ! -e $COMPOSE_FILE ]]; then change=new; elif cmp -s -- "$COMPOSE_SRC" "$COMPOSE_FILE"; then change=unchanged; else change=changed; fi
install -m 600 -o root -g root -- "$COMPOSE_SRC" "$COMPOSE_FILE" || die "couldn't install $COMPOSE_FILE"
info "$COMPOSE_FILE ($change)"
ensure_env || die "the .env isn't usable (see above)"
drop_stale_website_id || die "couldn't remove the stale $WEBSITE_ID_FILE"

section "3. Starting Umami"
# Without its volume, the database starts afresh, with Umami's default login: it must not
# be public, even for the moment before stage 4 checks the login. That is what nginx
# serves, not only what is on disk, so it is checked by asking nginx.
if ! database_exists; then
  if [[ -L $STATS_ENABLED ]]; then
    take_offline || die "couldn't take https://$STATS offline, so Umami isn't started with a new database"
  fi
  ensure_offline || die "nginx here doesn't refuse $STATS as its catch-all does, so Umami isn't started with a new database: its default login could be public"
fi
info "docker compose up -d (the first run downloads the images first), then waiting up to ${WAIT_SECONDS}s for both containers to be healthy"
compose up -d --quiet-pull --wait --wait-timeout "$WAIT_SECONDS" 2>&1 | indent
(( PIPESTATUS[0] == 0 )) || die "docker compose up failed, or a container didn't become healthy (sudo docker compose -p $PROJECT logs shows why)"
login=""
for _ in {1..30}; do
  login=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$UMAMI_URL/login")
  [[ $login == 200 ]] && break
  sleep 1
done
[[ $login == 200 ]] || die "$UMAMI_URL/login answers ${login:-nothing}, not 200"
info "$UMAMI_URL/login answers 200"
# Docker's published ports bypass ufw: the loopback binding is what keeps Umami private.
listeners=$(ss -Htln 'sport = :3000' | awk '{print $4}')
exposed=$(grep -vxE '127\.0\.0\.1:3000|\[::1\]:3000' <<<"$listeners")
if [[ -z $listeners || -n $exposed ]]; then
  compose stop umami 2>&1 | indent
  die "port 3000 should listen on loopback only, but listens on: $(words "$listeners"). Umami is stopped."
fi
info "port 3000 listens on loopback only: $(words "$listeners")"

section "4. The website ID and the default login"
if website_id_saved; then
  info "skipped the pause: $WEBSITE_ID_FILE holds the website ID $WEBSITE_ID"
else
  pause_instructions
  read_website_id || die "no website ID yet. Run this again from a terminal to paste it: it carries on from here."
  printf '%s\n' "$WEBSITE_ID" >"$WEBSITE_ID_FILE" || die "couldn't write $WEBSITE_ID_FILE"
  info "saved the website ID $WEBSITE_ID to $WEBSITE_ID_FILE"
fi
check_default_login || die "Umami stays off the internet until its default login is shown to fail."
check_admin_renamed || die "Umami stays off the internet until no user is called admin."

section "5. Publishing https://$STATS"
# Foundry shares nginx with this site: it must answer the same after the reload.
FOUNDRY_BEFORE=$(status_of "$FOUNDRY" /)
# From here on, a failure undoes this stage's nginx changes (on_exit calls rollback).
STATE=changing
if ! cert_exists; then
  info "no certificate for $STATS yet: first the vhost's plain-HTTP block on its own, for certbot's challenge"
  ensure_backup_dir || die "couldn't create $BACKUP"
  port80_block >"$BACKUP/$STATS.port80" || die "couldn't read the plain-HTTP block from $VHOST_SRC"
  install_file "$BACKUP/$STATS.port80" "$STATS_AVAILABLE" || die "couldn't install $STATS_AVAILABLE"
  link_vhost || die "couldn't link $STATS_ENABLED"
  nginx -t 2>&1 | indent
  (( PIPESTATUS[0] == 0 )) || die "nginx -t failed with the plain-HTTP block"
  RELOADED=1
  reload_nginx || die "nginx didn't take the plain-HTTP block"
  # If certbot fails, the rollback puts this copy back should certbot not have.
  save_before_certbot || die "couldn't save $NGINX/nginx.conf before certbot"
  # certonly: certbot only gets the certificate. Its nginx authenticator changes the config
  # for the challenge and puts it back afterwards. --non-interactive: it asks nothing, so it
  # uses the existing account and accepts no terms. stdin is not the terminal either way.
  certbot certonly --nginx --non-interactive --cert-name "$STATS" -d "$STATS" </dev/null || die "certbot couldn't get the certificate (see its output above)"
  CERT_NEW=1
  cert_exists || die "certbot finished, but $LIVE has no certificate and key"
  left=$(certbot_left_changed)
  [[ -z $left ]] || die "certbot left $left changed"
  info "certbot got the certificate, and left the nginx config as it was"
fi
# The install, the reload and the checks run to the end, or roll back: Ctrl-C can't stop them halfway.
trap '' INT TERM
install_file "$ZONE_SRC" "$ZONE_CONF" || die "couldn't install $ZONE_CONF"
install_file "$VHOST_SRC" "$STATS_AVAILABLE" || die "couldn't install $STATS_AVAILABLE"
link_vhost || die "couldn't link $STATS_ENABLED"
NGINX_T=$(nginx -t 2>&1)
NGINX_T_STATUS=$?
printf '%s\n' "$NGINX_T" | indent
(( NGINX_T_STATUS == 0 )) || die "nginx -t failed with the new config"
NEW_WARNINGS=$(grep -F '[warn]' <<<"$NGINX_T" | grep -vxF -f <(grep -F '[warn]' <<<"$PREFLIGHT_NGINX_T"))
# A re-run that changes nothing leaves nginx as it is; the checks below still run.
if (( ${#INSTALLED[@]} > 0 || LINKED )); then
  RELOADED=1
  reload_nginx || die "nginx didn't take the new config: the reload failed, or its master rejected the config (see its error log)"
else
  info "no nginx file changed, so nginx isn't reloaded"
fi
# And the new config is the one that answers.
for _ in {1..10}; do
  probe_stats /insights
  [[ $PROBE_STATUS == 200 && $PROBE_TYPE =~ ^(application|text)/javascript ]] && break
  sleep 0.5
done
[[ $PROBE_STATUS == 200 && $PROBE_TYPE =~ ^(application|text)/javascript ]] ||
  die "after the reload, https://$STATS/insights on this machine answers ${PROBE_STATUS:-nothing} (${PROBE_TYPE:-no type}), not 200 with JavaScript"
probe_stats /login
[[ $PROBE_STATUS == 200 ]] || die "https://$STATS/login answers ${PROBE_STATUS:-nothing} on this machine, not 200"
probe /
[[ $PROBE_STATUS == 200 && $PROBE_CSP == "$EXPECTED_CSP" ]] ||
  die "https://$DOMAIN/ answers ${PROBE_STATUS:-nothing} on this machine, not 200 with the site's Content-Security-Policy"
foundry_after=$(status_of "$FOUNDRY" /)
[[ $foundry_after == "$FOUNDRY_BEFORE" ]] ||
  die "https://$FOUNDRY/ answered $FOUNDRY_BEFORE before the reload and $foundry_after after it"
info "/insights is the tracker and /login answers, through nginx; the apex still has its CSP; Foundry answers $foundry_after as before"
STATE=finished
catch_signals

section "6. Summary"
echo "nginx -t:"
nginx -t 2>&1 | indent
if [[ -n $NEW_WARNINGS ]]; then
  echo "New nginx warnings since the start of this run (nginx -t still passes):"
  printf '%s\n' "$NEW_WARNINGS" | indent
fi
echo
echo "Containers:"
compose ps 2>&1 | indent
mapfile -t ids < <(compose ps -q 2>/dev/null)
if (( ${#ids[@]} > 0 )); then
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' "${ids[@]}" 2>&1 | indent
fi
echo "Memory (free -h):"
free -h | indent
echo
echo "Listening on port 3000:"
ss -Htln 'sport = :3000' | indent
echo
echo "curl -sI --resolve $STATS:443:127.0.0.1 https://$STATS/login"
curl -sS -I --max-time 10 --resolve "$STATS:443:127.0.0.1" "https://$STATS/login" 2>&1 | indent
echo
echo "Dashboard:  https://$STATS"
echo "Website ID: $WEBSITE_ID"
if [[ -d $BACKUP ]]; then echo "Backup:     $BACKUP"; else echo "Backup:     none (no nginx file changed)"; fi
echo "Log:        $LOG"
echo
echo "Next:"
echo "  - The tracker tag for every page of the site (with the website ID above):"
echo "      <script defer src=\"https://$STATS/insights\" data-website-id=\"$WEBSITE_ID\" data-domains=\"$DOMAIN\"></script>"
echo "  - Once, to check that the certificate renews with this config: sudo certbot renew --dry-run"
echo "  - From your machine: pnpm test:live"
echo "  - Updates, about monthly (README.md, Stats (Umami)): bump the image tag and digest in"
echo "    deploy/umami/compose.yaml, merge the pull request, pull this clone (pnpm deploy),"
echo "    and run this again: it installs the new compose.yaml and recreates the containers."
echo
echo "=== done at $(date -u '+%F %T UTC') ==="
