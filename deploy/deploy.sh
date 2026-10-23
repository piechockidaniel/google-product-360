#!/usr/bin/env bash
#
# Builds and (re)starts GMC Manager on the server it runs on. Idempotent – safe to run for the
# first install and for every update. Run it from the application directory:
#
#   bash deploy/deploy.sh                 # git pull + npm ci + build + restart (pm2 if present, else systemd)
#   bash deploy/deploy.sh --pm2           # force the pm2 runner (installs pm2 globally when missing)
#   bash deploy/deploy.sh --systemd       # force systemd (unit: deploy/gmc-manager.service)
#   bash deploy/deploy.sh --no-pull       # code already updated (rsync, CI artifact)
#   bash deploy/deploy.sh --with-demo     # also start the demo instance (pm2 only, port $DEMO_PORT or 8090)
#   bash deploy/deploy.sh --skip-install  # no npm ci (dependencies unchanged)
#
# Environment: APP_DIR (default: repo root of this script), SERVICE_NAME (gmc-manager), DEMO_PORT (8090).
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVICE_NAME="${SERVICE_NAME:-gmc-manager}"
RUNNER=""            # pm2 | systemd | none
PULL=1
INSTALL=1
WITH_DEMO=0

for arg in "$@"; do
  case "$arg" in
    --pm2) RUNNER=pm2 ;;
    --systemd) RUNNER=systemd ;;
    --none) RUNNER=none ;;
    --no-pull) PULL=0 ;;
    --skip-install) INSTALL=0 ;;
    --with-demo) WITH_DEMO=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$APP_DIR"
log "Application directory: $APP_DIR"

# ---- 1. prerequisites ------------------------------------------------------------------------
command -v node >/dev/null || die "Node.js is not installed (need >= 22.13). See https://nodejs.org or 'nvm install 22'."
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [M,m]=process.versions.node.split(".").map(Number); process.exit(M>22||(M===22&&m>=13)?0:1)' \
  || die "Node.js $NODE_VERSION is too old – GMC Manager needs >= 22.13 (built-in SQLite)."
log "Node.js $NODE_VERSION"

# ---- 2. code ---------------------------------------------------------------------------------
if [[ $PULL -eq 1 && -d .git ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    warn "Working tree has local changes – skipping git pull (use --no-pull to silence this)."
  else
    log "git pull --ff-only"
    git pull --ff-only
  fi
fi
GIT_REV="$(git rev-parse --short HEAD 2>/dev/null || echo 'n/a')"

# ---- 3. configuration ------------------------------------------------------------------------
mkdir -p data data/logs
if [[ ! -f .env ]]; then
  log "No .env found – creating one from .env.example with fresh secrets"
  cp .env.example .env
  SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
  WEBHOOK_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"
  sed -i.bak -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" -e "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=${WEBHOOK_SECRET}|" .env && rm -f .env.bak
  warn "Review .env (PUBLIC_URL, PORT). Merchant Center credentials can be entered in the browser wizard."
fi
if grep -q '^SESSION_SECRET=change-me' .env; then
  warn "SESSION_SECRET in .env is still the default – set a long random value!"
fi

# ---- 4. dependencies + build ------------------------------------------------------------------
if [[ $INSTALL -eq 1 ]]; then
  log "npm ci (server + client)"
  npm ci --no-audit --no-fund
fi
log "npm run build"
npm run build

# ---- 5. restart ------------------------------------------------------------------------------
if [[ -z "$RUNNER" ]]; then
  if command -v pm2 >/dev/null; then RUNNER=pm2
  elif systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE_NAME}.service" | grep -q "${SERVICE_NAME}"; then RUNNER=systemd
  else RUNNER=none; fi
fi

case "$RUNNER" in
  pm2)
    if ! command -v pm2 >/dev/null; then
      log "Installing pm2 globally"
      npm install -g pm2 --no-audit --no-fund
    fi
    log "pm2 startOrReload (app: ${SERVICE_NAME})"
    pm2 startOrReload deploy/ecosystem.config.cjs --only "${SERVICE_NAME}" --update-env
    if [[ $WITH_DEMO -eq 1 ]]; then
      log "pm2 startOrReload (demo on port ${DEMO_PORT:-8090})"
      DEMO_PORT="${DEMO_PORT:-8090}" pm2 startOrReload deploy/ecosystem.config.cjs --only "${SERVICE_NAME}-demo" --update-env
    fi
    pm2 save >/dev/null
    log "If pm2 is not yet registered as a boot service run once:  pm2 startup   (then execute the printed sudo command)"
    ;;
  systemd)
    if [[ ! -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]; then
      log "Installing systemd unit /etc/systemd/system/${SERVICE_NAME}.service (needs sudo)"
      sed -e "s|/opt/gmc-manager|${APP_DIR}|g" -e "s|^User=.*|User=$(id -un)|" deploy/gmc-manager.service | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null
      sudo systemctl daemon-reload
      sudo systemctl enable "${SERVICE_NAME}" >/dev/null
    fi
    log "systemctl restart ${SERVICE_NAME}"
    sudo systemctl restart "${SERVICE_NAME}"
    ;;
  none)
    warn "No process manager selected – build finished, start manually with 'npm start' (or re-run with --pm2 / --systemd)."
    ;;
esac

# ---- 6. health check -------------------------------------------------------------------------
if [[ "$RUNNER" != "none" ]]; then
  PORT="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"; PORT="${PORT:-8080}"
  HOST_BIND="$(grep -E '^HOST=' .env | cut -d= -f2 | tr -d '[:space:]')"; HOST_BIND="${HOST_BIND:-0.0.0.0}"
  [[ "$HOST_BIND" == "0.0.0.0" ]] && HOST_BIND=127.0.0.1
  for i in $(seq 1 20); do
    if curl -fsS "http://${HOST_BIND}:${PORT}/healthz" >/dev/null 2>&1; then
      log "Healthy: $(curl -fsS "http://${HOST_BIND}:${PORT}/healthz")"
      log "Deployed revision ${GIT_REV} with ${RUNNER}."
      exit 0
    fi
    sleep 1
  done
  warn "The service did not answer on http://${HOST_BIND}:${PORT}/healthz within 20 s."
  case "$RUNNER" in
    pm2) pm2 logs "${SERVICE_NAME}" --lines 30 --nostream ;;
    systemd) sudo journalctl -u "${SERVICE_NAME}" -n 30 --no-pager ;;
  esac
  exit 1
fi
