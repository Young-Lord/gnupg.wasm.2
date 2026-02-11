#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${GNUPG_WASM_REPO_ROOT:-$(cd -- "$SCRIPT_DIR/../.." && pwd)}"

BROWSER_PREFIX="${WASM_BROWSER_PREFIX:-$REPO_ROOT/PLAY/wasm-prefix-browser}"
BROWSER_BUILD_DIR="${WASM_BROWSER_BUILD_DIR:-$REPO_ROOT/PLAY/wasm-build-browser}"
BROWSER_LOG_DIR="${WASM_BROWSER_LOG_DIR:-$REPO_ROOT/PLAY/wasm-logs-browser}"

mkdir -p "$BROWSER_PREFIX" "$BROWSER_BUILD_DIR" "$BROWSER_LOG_DIR"

printf '[wasm] Browser prefix: %s\n' "$BROWSER_PREFIX"
printf '[wasm] Browser build:  %s\n' "$BROWSER_BUILD_DIR"

SKIP_PREPARE=0
for arg in "$@"; do
  case "$arg" in
    --help|-h|--configure-only)
      SKIP_PREPARE=1
      ;;
  esac
done

if [[ -z "${WASM_KEEP_SYMBOLS:-}" ]]; then
  WASM_KEEP_SYMBOLS=1
fi

WASM_PREFIX="$BROWSER_PREFIX" \
WASM_BUILD_DIR="$BROWSER_BUILD_DIR" \
WASM_LOG_DIR="$BROWSER_LOG_DIR" \
WASM_KEEP_SYMBOLS="$WASM_KEEP_SYMBOLS" \
bash "$SCRIPT_DIR/build-gnupg.sh" --target browser "$@"

if [[ "$SKIP_PREPARE" -eq 0 ]]; then
  WASM_PREFIX="$BROWSER_PREFIX" \
  WASM_BUILD_DIR="$BROWSER_BUILD_DIR" \
  WASM_LOG_DIR="$BROWSER_LOG_DIR" \
  WASM_KEEP_SYMBOLS="$WASM_KEEP_SYMBOLS" \
  bash "$SCRIPT_DIR/prepare-browser-assets.sh"
fi
