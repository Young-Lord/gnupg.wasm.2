#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/wasm/build-all.sh [options]

Build wasm dependencies and GnuPG in one command.

Options:
  --clean            Remove build directories before rebuilding.
  --force            Rebuild even when stamps exist.
  --configure-only   Only configure GnuPG (dependencies are still built).
  --skip-deps        Skip dependency build stage.
  --skip-gnupg       Skip GnuPG build stage.
  --help             Show this help text.
EOF
}

CLEAN=0
FORCE=0
CONFIGURE_ONLY=0
SKIP_DEPS=0
SKIP_GNUPG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)
      CLEAN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --configure-only)
      CONFIGURE_ONLY=1
      shift
      ;;
    --skip-deps)
      SKIP_DEPS=1
      shift
      ;;
    --skip-gnupg)
      SKIP_GNUPG=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf '[wasm] error: Unknown option: %s\n' "$1" >&2
      exit 1
      ;;
  esac
done

deps_args=()
gnupg_args=()

if [[ "$CLEAN" -eq 1 ]]; then
  deps_args+=(--clean)
  gnupg_args+=(--clean)
fi

if [[ "$FORCE" -eq 1 ]]; then
  deps_args+=(--force)
  gnupg_args+=(--force)
fi

if [[ "$CONFIGURE_ONLY" -eq 1 ]]; then
  gnupg_args+=(--configure-only)
fi

if [[ "$SKIP_DEPS" -eq 0 ]]; then
  "$SCRIPT_DIR/build-deps.sh" "${deps_args[@]}"
fi

if [[ "$SKIP_GNUPG" -eq 0 ]]; then
  "$SCRIPT_DIR/build-gnupg.sh" "${gnupg_args[@]}"
fi
