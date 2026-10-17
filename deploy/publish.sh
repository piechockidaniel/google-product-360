#!/usr/bin/env bash
#
# Publishes the current checkout to a VPS over SSH and runs deploy/deploy.sh there.
#
#   bash deploy/publish.sh user@vps.example.com                  # git mode: server pulls the branch it has checked out
#   bash deploy/publish.sh user@vps.example.com /opt/gmc-manager # explicit remote directory (default /opt/gmc-manager)
#   bash deploy/publish.sh user@vps.example.com --rsync          # rsync mode: copy the local tree (no git needed on the server)
#   bash deploy/publish.sh user@vps.example.com --rsync --with-demo --pm2
#
# Every option that deploy.sh understands (--pm2, --systemd, --with-demo, --skip-install) is passed through.
# Requirements: ssh access; for --rsync also rsync on both sides. Node >= 22.13 on the server.
set -euo pipefail

[[ $# -ge 1 ]] || { sed -n '2,12p' "$0"; exit 2; }
TARGET="$1"; shift
REMOTE_DIR="/opt/gmc-manager"
MODE=git
PASS=()
for arg in "$@"; do
  case "$arg" in
    --rsync) MODE=rsync ;;
    --git) MODE=git ;;
    /*) REMOTE_DIR="$arg" ;;
    *) PASS+=("$arg") ;;
  esac
done

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log() { printf '\033[1;32m[publish]\033[0m %s\n' "$*"; }

if [[ "$MODE" == "rsync" ]]; then
  log "rsync ${LOCAL_DIR}/ -> ${TARGET}:${REMOTE_DIR}/ (excluding node_modules, dist, data, .env, secrets)"
  ssh "$TARGET" "mkdir -p '${REMOTE_DIR}'"
  rsync -az --delete \
    --exclude node_modules --exclude client/node_modules --exclude dist --exclude data --exclude coverage \
    --exclude .env --exclude '.env.*' --include '.env.example' --exclude 'service-account-key.json' --exclude '*.sqlite*' --exclude .git \
    "${LOCAL_DIR}/" "${TARGET}:${REMOTE_DIR}/"
  PASS+=(--no-pull)
else
  log "git mode – the server pulls its checked-out branch"
  ssh "$TARGET" "test -d '${REMOTE_DIR}/.git'" || {
    echo "No git checkout at ${TARGET}:${REMOTE_DIR}. Clone it first (git clone <repo> ${REMOTE_DIR}) or use --rsync." >&2
    exit 1
  }
fi

log "Running deploy.sh on ${TARGET} (${PASS[*]:-default options})"
ssh -t "$TARGET" "cd '${REMOTE_DIR}' && bash deploy/deploy.sh ${PASS[*]:-}"
