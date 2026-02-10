#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh"

usage() {
  cat <<'EOF'
Usage: scripts/wasm/build-gnupg.sh [options]

Build GnuPG itself for wasm32-unknown-emscripten against dependencies in
PLAY/wasm-prefix.

Options:
  --clean            Remove gnupg build directory before configure.
  --force            Rebuild even when stamp exists.
  --configure-only   Run configure only.
  --help             Show this help text.
EOF
}

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    wasm_die "Missing required tool: $tool"
  fi
}

CLEAN=0
FORCE=0
CONFIGURE_ONLY=0

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
    --help|-h)
      usage
      exit 0
      ;;
    *)
      wasm_die "Unknown option: $1"
      ;;
  esac
done

require_tool emconfigure
require_tool emmake
require_tool emcc
require_tool node
require_tool python3

install_wasm_sidecars() {
  local copied=0
  local wasm
  local stem

  shopt -s globstar nullglob
  for wasm in "$BUILD_DIR"/**/*.wasm; do
    stem="$(basename "${wasm%.wasm}")"
    if [[ -f "$WASM_PREFIX/bin/$stem" ]]; then
      cp -f "$wasm" "$WASM_PREFIX/bin/"
      ((copied += 1))
    fi
  done
  shopt -u globstar nullglob

  wasm_info "Installed wasm sidecars: $copied"
}

patch_poll_guard() {
  local patched
  patched="$(python3 - "$WASM_PREFIX" <<'PY'
from pathlib import Path
import sys

prefix = Path(sys.argv[1])
needle = 'if(stream.stream_ops.poll){'
replacement = 'if(stream.stream_ops&&stream.stream_ops.poll){'
count = 0

for sub in ('bin', 'libexec'):
    root = prefix / sub
    if not root.exists():
        continue
    for path in root.iterdir():
        if not path.is_file():
            continue
        try:
            data = path.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        if needle not in data:
            continue
        path.write_text(data.replace(needle, replacement), encoding='utf-8')
        count += 1

print(count)
PY
)"
  wasm_info "Patched launcher poll guards: $patched"
}

STAMP_DIR="$WASM_BUILD_DIR/stamps"
STAMP_FILE="$STAMP_DIR/gnupg"
BUILD_DIR="$WASM_BUILD_DIR/gnupg"
LOG_FILE="$WASM_LOG_DIR/gnupg.log"
mkdir -p "$STAMP_DIR"

if [[ "$CLEAN" -eq 1 ]]; then
  wasm_info "Cleaning gnupg build directory"
  rm -rf "$BUILD_DIR" "$STAMP_FILE"
fi

if [[ "$FORCE" -eq 0 && "$CONFIGURE_ONLY" -eq 0 && -f "$STAMP_FILE" ]]; then
  wasm_info "Skipping gnupg (already built; use --force to rebuild)"
  exit 0
fi

mkdir -p "$BUILD_DIR"

GNUPG_CONFIGURE_FLAGS=(
  "--host=$WASM_HOST"
  "--build=$WASM_BUILD_TRIPLET"
  "--prefix=$WASM_PREFIX"
  "--enable-static"
  "--disable-shared"
  "--disable-gpgsm"
  "--disable-scdaemon"
  "--disable-dirmngr"
  "--disable-keyboxd"
  "--disable-tpm2d"
  "--disable-g13"
  "--disable-gpgtar"
  "--disable-wks-tools"
  "--disable-card-support"
  "--disable-libdns"
  "--disable-ldap"
  "--disable-sqlite"
  "--disable-tofu"
  "--disable-doc"
  "--disable-tests"
  "--disable-ntbtls"
  "--disable-gnutls"
  "--disable-zip"
  "--disable-bzip2"
  "--disable-exec"
  "--with-libgpg-error-prefix=$WASM_PREFIX"
  "--with-libgcrypt-prefix=$WASM_PREFIX"
  "--with-libassuan-prefix=$WASM_PREFIX"
  "--with-ksba-prefix=$WASM_PREFIX"
  "--with-npth-prefix=$WASM_PREFIX"
)

GNUPG_CPPFLAGS="$CPPFLAGS"
GNUPG_CFLAGS="$CFLAGS"
GNUPG_CXXFLAGS="$CXXFLAGS"
GNUPG_LDFLAGS="$(wasm_append_flags "$LDFLAGS" "$WASM_NODE_LDFLAGS")"

wasm_info "Configuring gnupg"
{
  echo "== configure gnupg =="
  (
    cd "$BUILD_DIR"
    CONFIG_SITE="$SCRIPT_DIR/config.site" \
      CPPFLAGS="$GNUPG_CPPFLAGS" \
      CFLAGS="$GNUPG_CFLAGS" \
      CXXFLAGS="$GNUPG_CXXFLAGS" \
      LDFLAGS="$GNUPG_LDFLAGS" \
      emconfigure "$GNUPG_WASM_REPO_ROOT/configure" "${GNUPG_CONFIGURE_FLAGS[@]}"
  )

  if [[ "$CONFIGURE_ONLY" -eq 0 ]]; then
    echo "== build gnupg =="
    emmake make -C "$BUILD_DIR" -j"$WASM_JOBS"

    echo "== install gnupg =="
    emmake make -C "$BUILD_DIR" install

    echo "== install wasm sidecars =="
    install_wasm_sidecars

    echo "== patch wasm launchers =="
    patch_poll_guard
  fi
} 2>&1 | tee "$LOG_FILE"

if [[ "$CONFIGURE_ONLY" -eq 0 ]]; then
  touch "$STAMP_FILE"
  wasm_info "GnuPG build complete"
fi

wasm_info "Prefix: $WASM_PREFIX"
wasm_info "Log:    $LOG_FILE"
