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
  --reconfigure      Force rerun configure before build.
  --configure-only   Run configure only.
  --target NAME      Build target: node (default) or browser.
  --browser          Shortcut for --target browser.
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
RECONFIGURE=0
TARGET="node"

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

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
    --reconfigure)
      RECONFIGURE=1
      shift
      ;;
    --target)
      [[ $# -ge 2 ]] || wasm_die "--target expects node or browser"
      TARGET="$2"
      shift 2
      ;;
    --browser)
      TARGET="browser"
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

if [[ "$TARGET" != "node" && "$TARGET" != "browser" ]]; then
  wasm_die "Unsupported --target value: $TARGET (expected node or browser)"
fi

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
      continue
    fi
    if [[ -f "$WASM_PREFIX/libexec/$stem" ]]; then
      cp -f "$wasm" "$WASM_PREFIX/libexec/"
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
poll_needle = 'if(stream.stream_ops.poll){'
poll_replacement = 'if(stream.stream_ops&&stream.stream_ops.poll){'

extra_fd_needle = (
    'createStandardStreams(){FS.createStream({nfd:0,position:0,path:"/dev/stdin",'
    'flags:0,tty:true,seekable:false},0);var paths=[,"/dev/stdout","/dev/stderr"];'
    'for(var i=1;i<3;i++){FS.createStream({nfd:i,position:0,path:paths[i],flags:577,'
    'tty:true,seekable:false},i)}}'
)
extra_fd_replacement = (
    'createStandardStreams(){FS.createStream({nfd:0,position:0,path:"/dev/stdin",'
    'flags:0,tty:true,seekable:false},0);var paths=[,"/dev/stdout","/dev/stderr"];'
    'for(var i=1;i<3;i++){FS.createStream({nfd:i,position:0,path:paths[i],flags:577,'
    'tty:true,seekable:false},i)}var extra=(typeof process!="undefined"&&process&&process.env)'
    '?process.env.GNUPG_WASM_EXTRA_FDS:undefined;if(extra){for(var fdstr of extra.split(","))'
    '{var nfd=Number(fdstr);if(Number.isInteger(nfd)&&nfd>2&&!FS.streams[nfd]){FS.createStream('
    '{nfd:nfd,position:0,path:"/dev/fd/"+nfd,flags:2,seekable:false},nfd)}}}}'
)

poll_count = 0
fd_count = 0

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

        updated = data
        replaced = False

        if poll_needle in updated:
            updated = updated.replace(poll_needle, poll_replacement)
            poll_count += 1
            replaced = True

        if extra_fd_needle in updated:
            updated = updated.replace(extra_fd_needle, extra_fd_replacement)
            fd_count += 1
            replaced = True

        if not replaced:
            continue
        path.write_text(updated, encoding='utf-8')

print(f'poll={poll_count} extra_fds={fd_count}')
PY
)"
  wasm_info "Patched wasm launchers: $patched"
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

CONFIGURE_REQUIRED=0
if [[ ! -f "$BUILD_DIR/Makefile" ]]; then
  CONFIGURE_REQUIRED=1
elif [[ "$CLEAN" -eq 1 || "$CONFIGURE_ONLY" -eq 1 || "$RECONFIGURE" -eq 1 ]]; then
  CONFIGURE_REQUIRED=1
fi

GNUPG_CONFIGURE_FLAGS=(
  "--host=$WASM_HOST"
  "--build=$WASM_BUILD_TRIPLET"
  "--prefix=$WASM_PREFIX"
  "--enable-static"
  "--disable-shared"
  "--enable-ccid-driver"
  "--disable-gpgsm"
  "--disable-dirmngr"
  "--disable-keyboxd"
  "--disable-tpm2d"
  "--disable-g13"
  "--disable-gpgtar"
  "--disable-wks-tools"
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
if [[ "$TARGET" == "browser" ]]; then
  GNUPG_LDFLAGS="$(wasm_append_flags "$LDFLAGS" "$WASM_BROWSER_LDFLAGS")"
else
  GNUPG_LDFLAGS="$(wasm_append_flags "$LDFLAGS" "$WASM_NODE_LDFLAGS")"
fi

# libusb WebUSB backend uses Embind async helpers.
GNUPG_LDFLAGS="$(wasm_append_flags "$GNUPG_LDFLAGS" "--bind -sASYNCIFY")"

if [[ "$TARGET" == "browser" ]] && is_truthy "${WASM_KEEP_SYMBOLS:-0}"; then
  GNUPG_CFLAGS="$(wasm_append_flags "$GNUPG_CFLAGS" "$WASM_KEEP_SYMBOLS_CFLAGS")"
  GNUPG_CXXFLAGS="$(wasm_append_flags "$GNUPG_CXXFLAGS" "$WASM_KEEP_SYMBOLS_CFLAGS")"
  GNUPG_LDFLAGS="$(wasm_append_flags "$GNUPG_LDFLAGS" "$WASM_KEEP_SYMBOLS_LDFLAGS")"
  wasm_info "Browser symbol retention enabled"
fi

wasm_info "Configuring gnupg"
wasm_info "Target: $TARGET"
{
  if [[ "$CONFIGURE_REQUIRED" -eq 1 ]]; then
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
  else
    echo "== reuse existing configure =="
  fi

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
