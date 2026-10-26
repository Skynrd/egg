#!/usr/bin/env bash
# Builds the planner twice and copies the results into the bldevs.com site repo:
#   <site>/egg/      production build
#   <site>/eggtest/  same code with VITE_TESTING=true (testing tools visible)
# Commit and push the site repo afterwards to deploy.
#
# Usage: VITE_API_ROOT='https://<worker>.workers.dev/?url=https://www.auxbrain.com' scripts/build-bldevs.sh [site dir]
set -euo pipefail

SITE_DIR="${1:-/c/BLDevs/bldevs.com}"
: "${VITE_API_ROOT:?set VITE_API_ROOT to your CORS proxy, e.g. https://egg-proxy.<you>.workers.dev/?url=https://www.auxbrain.com}"
export VITE_API_ROOT
# Git Bash on Windows would otherwise rewrite VITE_BASE=/egg/ into C:/Program Files/Git/egg/.
export MSYS_NO_PATHCONV=1 MSYS2_ENV_CONV_EXCL='VITE_'

cd "$(dirname "$0")/.."
[ -f "$SITE_DIR/index.html" ] || { echo "Site repo not found at $SITE_DIR" >&2; exit 1; }

build_to() {
  local name="$1" testing="$2"
  echo "==> Building /$name/ (VITE_TESTING=$testing)"
  VITE_BASE="/$name/" VITE_TESTING="$testing" pnpm build
  rm -rf "${SITE_DIR:?}/$name"
  cp -r dist "$SITE_DIR/$name"
}

build_to egg false
build_to eggtest true

echo "==> Done. Review and push: cd $SITE_DIR && git status"
