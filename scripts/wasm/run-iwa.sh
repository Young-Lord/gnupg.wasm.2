#!/usr/bin/env bash
# Launch the GnuPG WASM Isolated Web App in Chromium.
#
# Usage:
#   bash scripts/wasm/run-iwa.sh [--build] [--port PORT]
#
# Options:
#   --build   Rebuild browser wasm + IWA bundle before launching.
#   --port    Dev-server port for plain-web fallback (default: 8080).
#
# Prerequisites:
#   1. Build deps once:    bash scripts/wasm/build-deps.sh
#   2. Build browser wasm: bash scripts/wasm/build-gnupg-browser.sh --force
#   3. Build IWA bundle:   bash scripts/wasm/build-iwa.sh
#
# The script will:
#   - Optionally rebuild (--build)
#   - Create a fresh Chromium profile in /tmp
#   - Launch Chromium with IsolatedWebApps + IsolatedWebAppDevMode
#   - Install the .swbn bundle via --install-isolated-web-app-from-file
#   - Print the app-id so you can open it from chrome://apps or app launcher
#
# Note: IWA windows open as standalone app windows, not regular tabs.
# After Chromium starts, open the app from the system app launcher or
# navigate to chrome://apps and click the "GnuPG WASM" icon.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

SWBN_PATH="$ROOT_DIR/PLAY/iwa/gnupg-wasm-demo.swbn"
PROFILE_DIR="/tmp/chromium-iwa-gnupg-$$"
BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)  BUILD=1; shift ;;
    --help|-h)
      sed -n '2,/^$/{ s/^# \?//; p }' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ "$BUILD" -eq 1 ]]; then
  echo "[run-iwa] Building browser wasm..."
  bash "$SCRIPT_DIR/build-gnupg-browser.sh" --force
  echo "[run-iwa] Building IWA bundle..."
  bash "$SCRIPT_DIR/build-iwa.sh"
fi

if [[ ! -f "$SWBN_PATH" ]]; then
  echo "[run-iwa] ERROR: IWA bundle not found at $SWBN_PATH" >&2
  echo "[run-iwa] Run with --build or build manually first." >&2
  exit 1
fi

echo "[run-iwa] Bundle: $SWBN_PATH"
echo "[run-iwa] Profile: $PROFILE_DIR"
echo ""
echo "[run-iwa] Chromium will install the IWA on startup."
echo "[run-iwa] The app opens as a standalone window (not a tab)."
echo "[run-iwa] If it doesn't auto-open, find 'GnuPG WASM' in your app launcher"
echo "[run-iwa] or go to chrome://apps in the Chromium window."
echo ""

cleanup() {
  echo "[run-iwa] Cleaning up profile: $PROFILE_DIR"
  rm -rf "$PROFILE_DIR"
}
trap cleanup EXIT

chromium \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \
  --install-isolated-web-app-from-file="$SWBN_PATH"
