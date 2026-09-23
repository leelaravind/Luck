#!/usr/bin/env sh
# Start Luck - AI Roulette Lab on macOS, Linux or Git Bash.
#
#   sh scripts/start.sh          development mode (npm run dev)  -> http://127.0.0.1:5717
#   sh scripts/start.sh --prod   build + one-port app (npm start) -> http://127.0.0.1:3717
#
# Works from any folder. Checks Node.js (22.13 or newer), runs "npm ci" if node_modules is
# missing, creates .env from .env.example if .env does not exist (never overwrites it).
# It never installs anything globally and never stops other programs.
set -eu

usage() {
  cat <<'USAGE'
Usage: sh scripts/start.sh [--prod]
  (no option)  development mode: npm run dev   (open http://127.0.0.1:5717)
  --prod       build and serve on one port: npm start   (open http://127.0.0.1:3717)
USAGE
}

MODE=dev
for arg in "$@"; do
  case "$arg" in
    --prod | -p) MODE=prod ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

fail() {
  printf '\nERROR: %s\n' "$1" >&2
  exit 1
}

# Repository root = parent of the folder this script lives in (independent of the current directory).
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(dirname -- "$SCRIPT_DIR")
cd -- "$REPO_ROOT"

command -v node >/dev/null 2>&1 ||
  fail "Node.js was not found. Install Node.js 22 LTS (22.13 or newer) or 24 from https://nodejs.org/ and open a new terminal."
command -v npm >/dev/null 2>&1 ||
  fail "npm was not found. It is installed together with Node.js (https://nodejs.org/)."

NODE_VERSION=$(node -p 'process.versions.node')
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
  fail "Node.js $NODE_VERSION is too old. Luck needs Node.js 22.13 or newer (22 LTS or 24)."
fi

echo "Luck folder: $REPO_ROOT"
echo "Node.js:     $NODE_VERSION"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (npm ci)..."
  npm ci || fail "npm ci failed. See docs/troubleshooting.md."
fi

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "Created .env from .env.example (edit it to add optional API keys)."
fi

if [ "$MODE" = prod ]; then
  echo "Building and starting the one-port app. Open the address it prints (default http://127.0.0.1:3717)."
  exec npm start
else
  echo "Starting development mode. Open http://127.0.0.1:5717 (or your LUCK_WEB_PORT) once it is ready."
  exec npm run dev
fi
