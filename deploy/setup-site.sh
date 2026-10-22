#!/usr/bin/env bash
# Puts zachgreen.codes on the server: a clone of this repo as the web root, and the
# nginx config from deploy/nginx/. Run it with sudo, from the account that is to own the
# clone, from a copy of this file. Run it inside tmux, so a dropped connection can't cut
# it short (it ignores SIGHUP as well). For example:
#
#   scp deploy/setup-site.sh <host>:setup/03-setup-site.sh
#   ssh -t <host> tmux new-session -A -s setup
#   sudo bash ~/setup/03-setup-site.sh
#
# Nothing about the server is written in here. The clone belongs to the user who ran sudo
# (SUDO_USER), and the log goes to setup/03-site-log.txt in that user's home. The web root
# is the `root` that deploy/nginx/zachgreen.codes.conf gives nginx, minus its /site, and it
# must be /var/www/<the domain>: a typo there can't make this move some other directory.
#
# What it does, in order. It is safe to run again: a second run pulls the clone and
# reinstalls the nginx files, which is also how a change to deploy/nginx/ goes live.
#   1. Pre-flight: checks the server is the way this config expects.
#   2. Clones the repo into a temporary directory, reads the web root from its nginx
#      config, and checks that web root. If anything in 1 or 2 is off, it lists what and
#      stops, having changed nothing (the temporary clone is deleted).
#   3. Installs the brotli module package, and nothing else: step 1 checks that apt's
#      plan installs nothing but the module and libbrotli, and removes nothing.
#   4. Backs up the nginx files it is about to replace, to /root/nginx-backup-<UTC time>/.
#   5. Pulls the clone already at the web root (`git pull --ff-only`), if there is one.
#   6. Installs the five nginx files from the clone.
#   7. Runs `nginx -t`, reloads nginx, and checks that nginx took the new config. Only
#      then does a new clone take the web root's place (the old content goes to the
#      backup), so the old config never serves the repo's top level. On a first run the
#      site answers 404 for the moment between the reload and that swap. Last, it checks
#      that / is the site and /.git/HEAD is a 404.
#      If anything fails from step 3 on, every file, the web root and the clone go back
#      the way they were, nginx reloads that config, and the script exits non-zero. The
#      brotli package stays installed: it only loads the module, which does nothing on
#      its own. One exception: if the new clone can't be moved back out of the web root,
#      the old config would serve its top level, so the new config stays (on disk and
#      running), nginx isn't reloaded, and the script says how to finish by hand.
#   8. Prints a summary.
#
# The fonts aren't in the repo: scripts/deploy.sh copies them up from a machine that has them.

set -uo pipefail

REPO_URL=https://github.com/zachjamesgreen/zachgreen.codes.git
DOMAIN=zachgreen.codes
NGINX=/etc/nginx
DEFAULT_DENY=$NGINX/sites-enabled/00-default-deny
SITE_AVAILABLE=$NGINX/sites-available/zachgreen.codes
SITE_ENABLED=$NGINX/sites-enabled/zachgreen.codes
SITE_CONF=deploy/nginx/zachgreen.codes.conf
# The only web root this script will touch, whatever SITE_CONF says.
SITE_ROOT=/var/www/$DOMAIN
HEADERS=$NGINX/snippets/security-headers.conf
LIVE=/etc/letsencrypt/live/zachgreen.codes
RENEWAL=/etc/letsencrypt/renewal/zachgreen.codes.conf
BROTLI_PKG=libnginx-mod-http-brotli-filter
LOCK=/run/zachgreen-codes-setup-site.lock
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=/root/nginx-backup-$STAMP

# Repo file : server path. The site file goes last, after the files it includes.
FILES=(
  "deploy/nginx/conf.d/zachgreen.conf:$NGINX/conf.d/zachgreen.conf"
  "deploy/nginx/snippets/security-headers.conf:$HEADERS"
  "deploy/nginx/snippets/zachgreen-compression.conf:$NGINX/snippets/zachgreen-compression.conf"
  "deploy/nginx/snippets/zachgreen-brotli.conf:$NGINX/snippets/zachgreen-brotli.conf"
  "$SITE_CONF:$SITE_AVAILABLE"
)

# What this run has done so far, so that a failure undoes exactly that (rollback).
STATE=checking    # checking: nothing changed yet. changing: a failure rolls back. finished.
BACKED_UP=()      # server paths copied into $BACKUP
INSTALLED=()      # server paths this run has written
STAGE=""          # the temporary clone, until it becomes the web root or is deleted
WEBROOT=""        # from the clone's nginx config
OLD_WEBROOT=""    # where the web root's old content was moved to
SWAP_STARTED=0    # 1 once the temporary clone has started to move to the web root
SWAPPED=0         # 1 once the temporary clone is the web root
OLD_HEAD=""       # the existing clone's commit before `git pull`
RELOADED=0        # 1 once `systemctl reload nginx` has been tried
BROTLI_NEW=0      # 1 if this run installed the brotli package
TEE_PID=""
PROBLEMS=()
PROBE_STATUS=""
PROBE_CSP=""

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
# Commands on the clone run as its owner: git refuses to work in a repo that belongs
# to another user, and what it writes has to belong to the owner.
as_owner() { sudo -u "$OWNER" -H "$@"; }
# The lines of a config file that nginx reads: comments and blank lines removed.
directives() { sed -e 's/#.*$//' -e '/^[[:space:]]*$/d' "$1"; }
brotli_installed() {
  # shellcheck disable=SC2016  # ${Status} is dpkg-query's format, not a shell variable.
  [[ $(dpkg-query -W -f='${Status}' "$BROTLI_PKG" 2>/dev/null) == *" ok installed" ]]
}
# What apt's plan for installing the brotli module does besides installing the module and
# libbrotli, as "Inst <package>" and "Remv <package>" lines: nothing, or the install would
# upgrade nginx, or remove something, too.
unexpected_installs() {
  local plan
  if ! plan=$(apt-get -s -o Debug::NoLocking=1 install --no-install-recommends "$BROTLI_PKG" 2>&1); then
    printf 'apt-get -s install failed:\n%s\n' "$plan"
    return
  fi
  sed -nE 's/^(Inst|Remv) ([^ ]+).*$/\1 \2/p' <<<"$plan" | grep -vxE "Inst ($BROTLI_PKG|libbrotli[^ ]*)"
}
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
# The web root a site config names: its one `root`, minus the /site nginx serves.
web_root_of() {
  local root
  root=$(directives "$1" 2>/dev/null | sed -nE 's/^[[:space:]]*root[[:space:]]+([^;[:space:]]+)[[:space:]]*;.*$/\1/p')
  [[ $root =~ ^/[A-Za-z0-9._/-]+/site$ && /$root/ != */./* && /$root/ != */../* ]] || return 1
  printf '%s\n' "${root%/site}"
}
# The Content-Security-Policy value a security-headers snippet sets.
csp_of() { sed -nE 's/^[[:space:]]*add_header[[:space:]]+Content-Security-Policy[[:space:]]+"([^"]+)".*$/\1/p' "$1"; }
# Status and Content-Security-Policy of https://$DOMAIN$1 from the nginx on this machine.
# -k: this checks which config nginx serves, not the certificate (the summary shows that).
probe() {
  local headers
  headers=$(curl -sk -o /dev/null -D - --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1" 2>/dev/null | tr -d '\r')
  PROBE_STATUS=$(sed -nE '1s/^HTTP\/[0-9.]+ ([0-9]{3}).*$/\1/p' <<<"$headers")
  PROBE_CSP=$(sed -nE 's/^content-security-policy:[[:space:]]*(.*)$/\1/Ip' <<<"$headers")
}
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
# The temporary clone is this run's own, so it is deleted rather than kept.
remove_stage() {
  [[ -n $STAGE && -d $STAGE && $(basename "$STAGE") == zachgreen-codes-clone.* ]] || return 0
  if rm -rf -- "$STAGE"; then info "deleted the temporary clone $STAGE"; else info "FAILED to delete $STAGE"; fi
  STAGE=""
}

# For when the new clone is stuck at the web root: nothing more is undone, nginx isn't
# reloaded, and this says how to finish the rollback by hand.
manual_recovery() {
  local dest
  printf '\n%s\n' "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  printf '%s\n' \
    "MANUAL RECOVERY NEEDED. This run's clone is at $WEBROOT and couldn't be moved out." \
    "Nothing else was rolled back and nginx was NOT reloaded: it runs the new config, which" \
    "serves only $WEBROOT/site, and the nginx files on disk are the new ones too, so a" \
    "restart or a reboot keeps it that way. Don't put the old config back before the clone" \
    "is gone: its root is $WEBROOT itself, so it would serve the clone's .git/." \
    "To finish the rollback, as root, in this order:" \
    "  mv $WEBROOT $BACKUP/unused-clone"
  [[ -n $OLD_WEBROOT ]] && printf '%s\n' "  mv $OLD_WEBROOT $WEBROOT"
  for dest in "${INSTALLED[@]}"; do
    if [[ -e $BACKUP$dest || -L $BACKUP$dest ]]; then printf '  cp -a %s %s\n' "$BACKUP$dest" "$dest"
    else printf '  rm %s\n' "$dest"; fi
  done
  [[ -n $STAGE && -d $STAGE ]] && printf '  rm -rf %s\n' "$STAGE"
  printf '%s\n' "  nginx -t && systemctl reload nginx"
  printf '%s\n' "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  info "Log: $LOG"
}

rollback() {
  STATE=rolling-back
  section "Rolling back"
  local dest saved head undid=0
  # The web root first. If this run's clone can't be moved back out of it, the old config
  # (whose root is the web root itself) would serve the clone's top level, .git/ included,
  # so nginx keeps the new config, on disk and running, and the rest is left to a person.
  if (( SWAPPED )) || { (( SWAP_STARTED )) && [[ -e $WEBROOT ]]; }; then
    undid=1
    if mv -- "$WEBROOT" "$BACKUP/unused-clone"; then
      if (( SWAPPED )); then info "moved the new clone out of $WEBROOT, to $BACKUP/unused-clone"
      else info "moved a partial copy of the new clone out of $WEBROOT, to $BACKUP/unused-clone"; fi
      SWAPPED=0
    else
      manual_recovery
      return
    fi
  fi
  if [[ -n $OLD_WEBROOT ]]; then
    undid=1
    if [[ -e $WEBROOT ]]; then
      info "FAILED: something is at $WEBROOT, so the old web root stays at $OLD_WEBROOT"
    elif mv -- "$OLD_WEBROOT" "$WEBROOT"; then
      info "put the old $WEBROOT back"
    else
      info "FAILED to move $OLD_WEBROOT back to $WEBROOT"
    fi
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
  remove_stage
  if [[ -n $OLD_HEAD ]]; then
    head=$(as_owner git -C "$WEBROOT" rev-parse HEAD 2>/dev/null)
    if [[ $head != "$OLD_HEAD" ]]; then
      undid=1
      if as_owner git -C "$WEBROOT" reset --quiet --keep "$OLD_HEAD"; then
        info "reset the clone to ${OLD_HEAD:0:12}, where it was before the pull"
      else
        info "FAILED to reset the clone to $OLD_HEAD"
      fi
    fi
  fi
  (( undid )) || info "no nginx file or site content had been changed yet"
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
  if (( BROTLI_NEW )); then
    info "$BROTLI_PKG stays installed: it only loads the module, which does nothing"
    info "until a config turns brotli on."
  fi
  [[ -d $BACKUP ]] && info "Backup: $BACKUP"
  info "Log:    $LOG"
}

on_exit() {
  # First, so a second Ctrl-C can't cut the rollback short ($? is read in the same line).
  local status=$?; trap '' INT TERM
  case $STATE in
    changing) rollback; (( status != 0 )) || status=1 ;;
    checking) remove_stage ;;
    *) ;;
  esac
  # Let tee write out the end of the log before the shell (and the SSH session) goes.
  if [[ -n $TEE_PID ]]; then
    exec >&- 2>&-
    wait "$TEE_PID" 2>/dev/null
  fi
  exit "$status"
}

if (( EUID != 0 )); then
  echo "Run this with sudo: sudo bash $0" >&2
  exit 1
fi
# The clone's owner is whoever ran sudo, and the log goes in their home.
OWNER=${SUDO_USER:-}
if [[ -z $OWNER || $OWNER == root ]] || ! getent passwd "$OWNER" >/dev/null; then
  echo "Run this with sudo from the account that is to own the site's clone, not as root itself (SUDO_USER is '${SUDO_USER:-}')." >&2
  exit 1
fi
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)
OWNER_GROUP=$(id -gn "$OWNER")
LOG_DIR=$OWNER_HOME/setup
LOG=$LOG_DIR/03-site-log.txt
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

section "1. Pre-flight checks (nothing is changed unless they all pass)"
codename=$(sed -n 's/^VERSION_CODENAME=//p' /etc/os-release 2>/dev/null | tr -d '"')
[[ $codename == resolute ]] || problem "this is for Ubuntu 26.04 (resolute), but VERSION_CODENAME is '$codename'"

for cmd in nginx git curl openssl ss sudo apt-get dpkg-query systemctl install cmp mktemp pgrep flock; do
  command -v "$cmd" >/dev/null || problem "command not found: $cmd"
done

systemctl is-active --quiet nginx || problem "nginx isn't running"
PREFLIGHT_NGINX_T=$(nginx -t 2>&1) || problem "the current config already fails nginx -t:
$PREFLIGHT_NGINX_T"

# Who nginx reads the site as, and where its master's pid is: from nginx.conf.
nginx_conf=$(directives "$NGINX/nginx.conf")
NGINX_USER=$(sed -nE 's/^[[:space:]]*user[[:space:]]+([^[:space:];]+).*$/\1/p' <<<"$nginx_conf")
NGINX_USER=${NGINX_USER%%$'\n'*}
if [[ -z $NGINX_USER ]] || ! getent passwd "$NGINX_USER" >/dev/null; then
  problem "can't tell which user nginx runs as: $NGINX/nginx.conf has no 'user' line naming an existing user"
fi
NGINX_PID_FILE=$(sed -nE 's/^[[:space:]]*pid[[:space:]]+([^[:space:];]+).*$/\1/p' <<<"$nginx_conf")
NGINX_PID_FILE=${NGINX_PID_FILE%%$'\n'*}
[[ -s ${NGINX_PID_FILE:-} ]] || problem "can't find the nginx master's pid: $NGINX/nginx.conf's 'pid' file ('${NGINX_PID_FILE:-}') is missing or empty"

# The catch-all has to hold [::]:80 and [::]:443 as well. Without it, the first server
# block listening there (another site's) would answer unknown names over IPv6.
if [[ -e $DEFAULT_DENY ]]; then
  deny=$(directives "$DEFAULT_DENY")
  for want in '[::]:80=\[::\]:80' '[::]:443=\[::\]:443' '80=((\*|0\.0\.0\.0):)?80' '443=((\*|0\.0\.0\.0):)?443'; do
    grep -qE "^[[:space:]]*listen[[:space:]]+${want#*=}[[:space:]][^;]*default_server" <<<"$deny" ||
      problem "$DEFAULT_DENY has no 'listen ${want%%=*} ... default_server'"
  done
else
  problem "$DEFAULT_DENY, the catch-all default_server, isn't there"
fi

# certbot's nginx authenticator answers the HTTP challenge inside nginx. A webroot
# authenticator would write to a directory that the :80 redirect never serves.
if [[ -f $RENEWAL ]]; then
  grep -qE '^[[:space:]]*authenticator[[:space:]]*=[[:space:]]*nginx[[:space:]]*$' "$RENEWAL" ||
    problem "$RENEWAL doesn't have 'authenticator = nginx', so renewals may break with this config"
else
  problem "$RENEWAL isn't there"
fi

# The site's gzip settings are a server-level snippet that expects the http block to
# have Ubuntu's stock `gzip on;` and no other gzip settings.
gzip_lines=$(grep -E '(^|[[:space:];{])gzip(_[a-z_]+)?[[:space:]]' <<<"$nginx_conf" |
  grep -vE '^[[:space:]]*gzip[[:space:]]+on[[:space:]]*;[[:space:]]*$')
[[ -z $gzip_lines ]] || problem "$NGINX/nginx.conf has gzip settings besides 'gzip on;':
$gzip_lines"

# conf.d/zachgreen.conf defines $cache_control. Anything else that defines or uses it
# would clash with that map or come to depend on it.
# shellcheck disable=SC2016  # '\$cache_control' is the nginx variable, matched literally.
cache_control=$(nginx_lines_matching '\$cache_control([^[:alnum:]_]|$)' "$NGINX/conf.d/zachgreen.conf" "$HEADERS")
[[ -z $cache_control ]] || problem "\$cache_control already appears outside this site's files:
$cache_control"

# This site's snippets are for its own server blocks. Another site that included one would
# have its headers or compression changed by every install of this one.
snippet_users=$(nginx_lines_matching 'snippets/(security-headers|zachgreen-)' "$SITE_AVAILABLE" "$SITE_ENABLED")
[[ -z $snippet_users ]] || problem "something besides this site's own config includes its snippets:
$snippet_users"

for file in "$LIVE/fullchain.pem" "$LIVE/privkey.pem" /etc/letsencrypt/options-ssl-nginx.conf /etc/letsencrypt/ssl-dhparams.pem; do
  [[ -s $file ]] || problem "missing or empty: $file"
done
if [[ -s $LIVE/fullchain.pem ]]; then
  san=$(openssl x509 -in "$LIVE/fullchain.pem" -noout -ext subjectAltName 2>/dev/null)
  for name in "$DOMAIN" "www.$DOMAIN"; do
    grep -qE "(^|[[:space:],])DNS:${name//./\\.}(,|[[:space:]]|$)" <<<"$san" ||
      problem "the certificate in $LIVE doesn't cover $name"
  done
fi

[[ -d $NGINX/conf.d && -d $NGINX/snippets ]] || problem "$NGINX/conf.d/ or $NGINX/snippets/ is missing"
[[ -f $SITE_AVAILABLE ]] || problem "$SITE_AVAILABLE isn't there"
if [[ ! -L $SITE_ENABLED || $(readlink -f "$SITE_ENABLED") != "$SITE_AVAILABLE" ]]; then
  problem "$SITE_ENABLED should be a symlink to $SITE_AVAILABLE"
fi

if ! brotli_installed; then
  extra=$(unexpected_installs)
  [[ -z $extra ]] || problem "apt's plan for $BROTLI_PKG does more than install it and libbrotli:
$extra"
fi

as_owner git ls-remote --exit-code --heads "$REPO_URL" main >/dev/null 2>&1 ||
  problem "can't reach $REPO_URL as $OWNER, or it has no main branch"
stop_on_problems
info "all passed"

section "2. The repo, and the web root its nginx config names"
# A temporary clone, outside anything nginx serves. It is the source of the web root's
# path, and on a first run it becomes the web root.
STAGE=$(mktemp -d /var/tmp/zachgreen-codes-clone.XXXXXXXX) || die "couldn't create a temporary directory"
chown "$OWNER:$OWNER_GROUP" "$STAGE" || die "couldn't hand $STAGE to $OWNER"
chmod 755 "$STAGE" || die "couldn't make $STAGE readable"
as_owner git clone --quiet "$REPO_URL" "$STAGE" || die "git clone failed"
info "cloned $(as_owner git -C "$STAGE" log -1 --format='%h %s')"
WEBROOT=$(web_root_of "$STAGE/$SITE_CONF") ||
  die "$SITE_CONF in the clone doesn't have exactly one 'root /<dir>/site;' line"
info "the web root, from the 'root' in $SITE_CONF: $WEBROOT"
# A typo in that line (root /var/www/site;) would otherwise have this move all of /var/www.
[[ $WEBROOT == "$SITE_ROOT" ]] ||
  problem "$SITE_CONF puts the web root at $WEBROOT, but this site's web root must be $SITE_ROOT"
stop_on_problems

# The web root is either this repo's clone, to pull, or content for a new clone to replace.
WEBROOT_IS_CLONE=0
if [[ ! -d $(dirname "$WEBROOT") ]]; then
  problem "$(dirname "$WEBROOT")/, which holds the web root, doesn't exist"
elif [[ -L $WEBROOT ]]; then
  problem "$WEBROOT is a symlink; expected a directory"
elif [[ -e $WEBROOT && ! -d $WEBROOT ]]; then
  problem "$WEBROOT isn't a directory"
elif [[ -e $WEBROOT/.git ]]; then
  if [[ $(stat -c %U "$WEBROOT") != "$OWNER" ]]; then
    problem "$WEBROOT is a git repo that $OWNER doesn't own"
  elif [[ $(as_owner git -C "$WEBROOT" remote get-url origin 2>/dev/null) != "$REPO_URL" ]]; then
    problem "$WEBROOT is a git repo, but its origin isn't $REPO_URL"
  elif [[ -n $(as_owner git -C "$WEBROOT" status --porcelain --untracked-files=no 2>&1) ]]; then
    problem "$WEBROOT has local changes, so it can't pull:
$(as_owner git -C "$WEBROOT" status --short --untracked-files=no 2>&1)"
  else
    WEBROOT_IS_CLONE=1
  fi
fi
# On a first run, a security-headers.conf already in snippets/ is someone else's, and
# installing this site's over it would change their headers.
if (( ! WEBROOT_IS_CLONE )) && [[ -e $HEADERS ]] && ! grep -qF 'stats.zachgreen.codes' "$HEADERS"; then
  problem "$HEADERS already exists and isn't this site's (it doesn't mention stats.zachgreen.codes)"
fi
stop_on_problems
if (( WEBROOT_IS_CLONE )); then
  info "$WEBROOT is already a clone of the repo: it will be pulled"
else
  info "$WEBROOT will be replaced by the new clone"
fi

# From here on, a failure undoes what this run did (on_exit calls rollback).
STATE=changing

section "3. The brotli module ($BROTLI_PKG)"
if brotli_installed; then
  info "already installed"
else
  # apt and dpkg run to the end once started: a half-done dpkg run is worse than either
  # outcome. needrestart only lists, so the install can't restart other services. The
  # package's own trigger reloads nginx, which loads the module and changes nothing else.
  trap '' INT TERM
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
  apt-get -q -o DPkg::Lock::Timeout=300 update || info "apt-get update failed; trying the install with the current package lists"
  extra=$(unexpected_installs)
  [[ -z $extra ]] || die "with the updated package lists, apt's plan for $BROTLI_PKG does more than install it and libbrotli: ${extra//$'\n'/, }"
  apt-get -q -y -o DPkg::Lock::Timeout=300 install --no-install-recommends "$BROTLI_PKG" || die "couldn't install $BROTLI_PKG"
  BROTLI_NEW=1
  catch_signals
fi
grep -qs ngx_http_brotli_filter_module "$NGINX"/modules-enabled/*.conf ||
  die "$BROTLI_PKG is installed, but nothing in $NGINX/modules-enabled/ loads ngx_http_brotli_filter_module"
info "the module is enabled in $NGINX/modules-enabled/"

section "4. Backing up to $BACKUP"
install -d -m 700 "$BACKUP" || die "couldn't create $BACKUP"
for pair in "${FILES[@]}"; do
  dest=${pair#*:}
  if [[ -e $dest || -L $dest ]]; then
    cp -a --parents -- "$dest" "$BACKUP/" || die "couldn't back up $dest"
    BACKED_UP+=("$dest")
    info "$dest"
  fi
done
(( ${#BACKED_UP[@]} > 0 )) || info "none of the five files exist yet"

section "5. The site"
if (( WEBROOT_IS_CLONE )); then
  OLD_HEAD=$(as_owner git -C "$WEBROOT" rev-parse HEAD) || die "couldn't read the clone's HEAD"
  as_owner git -C "$WEBROOT" pull --ff-only || die "git pull --ff-only failed in $WEBROOT"
  [[ $(web_root_of "$WEBROOT/$SITE_CONF") == "$WEBROOT" ]] ||
    die "after the pull, $SITE_CONF no longer names $WEBROOT as the web root"
  SRC=$WEBROOT
  remove_stage
else
  SRC=$STAGE
  info "the new clone stays in $STAGE until nginx has taken the new config"
fi
info "at $(as_owner git -C "$SRC" log -1 --format='%h %s')"
for pair in "${FILES[@]}"; do
  [[ -f $SRC/${pair%%:*} ]] || die "the clone has no ${pair%%:*}"
done
# test -r also needs search permission on every directory on the way, so this checks the path.
sudo -u "$NGINX_USER" test -r "$SRC/site/index.html" || die "$NGINX_USER (nginx) can't read $SRC/site/index.html"
info "$NGINX_USER can read site/"

section "6. Installing the nginx files"
# This section and the next run to the end, or roll back: Ctrl-C can't stop them halfway.
trap '' INT TERM
for pair in "${FILES[@]}"; do
  src=$SRC/${pair%%:*}
  dest=${pair#*:}
  if [[ ! -e $dest ]]; then change=new; elif cmp -s "$src" "$dest"; then change=unchanged; else change=changed; fi
  INSTALLED+=("$dest")
  install -m 644 -o root -g root -- "$src" "$dest" || die "couldn't install $dest"
  info "$dest ($change)"
done

section "7. nginx -t, reload, and check"
NGINX_T=$(nginx -t 2>&1)
NGINX_T_STATUS=$?
printf '%s\n' "$NGINX_T" | indent
(( NGINX_T_STATUS == 0 )) || die "nginx -t failed with the new config"
NEW_WARNINGS=$(grep -F '[warn]' <<<"$NGINX_T" | grep -vxF -f <(grep -F '[warn]' <<<"$PREFLIGHT_NGINX_T"))
EXPECTED_CSP=$(csp_of "$HEADERS")
[[ -n $EXPECTED_CSP ]] || die "$HEADERS sets no Content-Security-Policy to check for"

RELOADED=1
reload_nginx || die "nginx didn't take the new config: the reload failed, or its master rejected the config (see its error log)"
# And the new config is the one that answers.
for _ in {1..10}; do
  probe /
  [[ $PROBE_CSP == "$EXPECTED_CSP" ]] && break
  sleep 0.5
done
[[ $PROBE_CSP == "$EXPECTED_CSP" ]] ||
  die "after the reload, https://$DOMAIN/ on this machine doesn't send the new Content-Security-Policy (status ${PROBE_STATUS:-none})"
info "nginx took the new config"

if [[ -n $STAGE ]]; then
  if [[ -e $WEBROOT ]]; then
    install -d -m 700 "$BACKUP$(dirname "$WEBROOT")" || die "couldn't create $BACKUP$(dirname "$WEBROOT")"
    mv -- "$WEBROOT" "$BACKUP$(dirname "$WEBROOT")/" || die "couldn't move $WEBROOT aside"
    OLD_WEBROOT=$BACKUP$WEBROOT
    info "moved the old $WEBROOT to $OLD_WEBROOT"
  fi
  SWAP_STARTED=1
  mv -- "$STAGE" "$WEBROOT" || die "couldn't move the clone to $WEBROOT"
  STAGE=""
  SWAPPED=1
  info "the clone is now $WEBROOT"
fi
probe /
[[ $PROBE_STATUS == 200 && $PROBE_CSP == "$EXPECTED_CSP" ]] ||
  die "https://$DOMAIN/ answers ${PROBE_STATUS:-nothing} on this machine, not 200 with the site's Content-Security-Policy"
probe /.git/HEAD
[[ $PROBE_STATUS == 404 ]] || die "https://$DOMAIN/.git/HEAD answers ${PROBE_STATUS:-nothing} on this machine, not 404"
info "/ is 200 with the site's headers, and /.git/HEAD is 404"
STATE=finished
catch_signals

section "8. Summary"
echo "nginx -t:"
nginx -t 2>&1 | indent
if [[ -n $NEW_WARNINGS ]]; then
  echo "New nginx warnings since the start of this run (nginx -t still passes):"
  printf '%s\n' "$NEW_WARNINGS" | indent
fi
echo
echo "Listening TCP sockets:"
ss -tlnp | indent
echo
echo "curl -sI --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/"
curl -sS -I --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" 2>&1 | indent
encoding=$(curl -sS -o /dev/null -D - --max-time 10 -H 'Accept-Encoding: br, gzip' \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/css/site.css" 2>&1 | grep -i '^content-encoding' | tr -d '\r')
echo "/css/site.css for a client that accepts brotli: ${encoding:-no Content-Encoding header}"
echo
echo "Web root: $WEBROOT at $(as_owner git -C "$WEBROOT" log -1 --format='%h %s'), owned by $OWNER"
echo "Backup:   $BACKUP"
echo "Log:      $LOG"
echo
echo "Next:"
echo "  - The fonts aren't in the repo. From a machine that has them in site/fonts/, run"
echo "    scripts/deploy.sh (pnpm deploy), with DEPLOY_DIR=$WEBROOT: it pulls here, then"
echo "    copies the fonts."
echo "  - Then, from there: pnpm test:live"
echo "  - To check that certificate renewal still works with this config: sudo certbot renew --dry-run"
echo
echo "=== done at $(date -u '+%F %T UTC') ==="
