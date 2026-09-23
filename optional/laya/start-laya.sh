#!/usr/bin/env bash
# Start the OPTIONAL local Laya classifier server (laya-serve) for Luck - AI Roulette Lab.
#
# Works from any folder. Uses the separate virtual environment <repo>/.venv-laya and always binds
# laya-serve to 127.0.0.1 (laya-serve's own default is 0.0.0.0, which would expose it to the network).
# Nothing here is part of the base npm install. It never installs anything globally.
#
# First run downloads the model weights from Hugging Face (roughly 0.6-2.3 GB depending on the
# checkpoints used), so the first classification can take a long time.
#
# Usage:
#   optional/laya/start-laya.sh --install        # create .venv-laya + pip install, then start
#   optional/laya/start-laya.sh [--port 8000]    # start
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENV="$REPO_ROOT/.venv-laya"
VENV_PY="$VENV/bin/python"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
INSTALL=0
PORT=8000

fail() {
  echo >&2
  echo "ERROR: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --port)
      shift
      [ $# -gt 0 ] || fail "--port needs a value"
      PORT="$1"
      ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done

case "$PORT" in
  ''|*[!0-9]*) fail "Port must be a number (got '$PORT')" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "Port must be between 1 and 65535 (got $PORT)"

if [ "$INSTALL" -eq 1 ]; then
  if [ ! -x "$VENV_PY" ]; then
    PYTHON_BIN="${PYTHON:-python3}"
    echo "Creating virtual environment $VENV ..."
    "$PYTHON_BIN" -m venv "$VENV" || fail "Could not create the virtual environment with '$PYTHON_BIN'. Install Python 3 or set PYTHON."
  fi
  echo "Installing optional/laya/requirements.txt into .venv-laya ..."
  "$VENV_PY" -m pip install -r "$REQUIREMENTS" || fail "pip install failed (see the output above)."
fi

[ -x "$VENV_PY" ] || fail "No Laya environment found at $VENV. Run with --install first (see optional/laya/README.md)."
SERVE="$VENV/bin/laya-serve"
[ -x "$SERVE" ] || fail "laya-serve is not installed in $VENV. Run with --install."

# Loopback only, always. LAYA_API_KEY (if exported) is honoured by laya-serve itself;
# put the same value in the app's .env as LAYA_API_KEY.
export LAYA_HOST=127.0.0.1
export LAYA_PORT="$PORT"

echo "Starting laya-serve on http://127.0.0.1:$PORT (Ctrl+C to stop) ..."
exec "$SERVE"
