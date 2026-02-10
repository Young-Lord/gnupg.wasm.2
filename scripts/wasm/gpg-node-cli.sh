#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh"

usage() {
  cat <<'EOF'
Usage: scripts/wasm/gpg-node-cli.sh [options] -- [gpg args...]

Run wasm gpg under Node with a ffmpeg-like argument passthrough interface.

Examples:
  scripts/wasm/gpg-node-cli.sh -- --version
  scripts/wasm/gpg-node-cli.sh -- --list-keys
  scripts/wasm/gpg-node-cli.sh -- \
    --pinentry-mode loopback --passphrase test --symmetric in.txt

Options:
  --gpg PATH         Explicit gpg launcher path (default: PLAY/wasm-prefix/bin/gpg)
  --node PATH        Explicit node path (default: EMSDK_NODE or node)
  --homedir PATH     Explicit GNUPGHOME for this invocation
  --raw              Do not inject default gpg flags
  --help             Show this help text

Default injected gpg flags (unless --raw):
  --homedir <dir> --batch --yes --no-tty --no-autostart
EOF
}

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    wasm_die "Missing required tool: $tool"
  fi
}

NODE_BIN="${NODE_BIN:-${EMSDK_NODE:-node}}"
GPG_BIN="${GPG_BIN:-$WASM_PREFIX/bin/gpg}"
CLI_HOME="${GPG_CLI_HOME:-$WASM_BUILD_DIR/cli-node/gnupghome}"
RAW_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gpg)
      [[ $# -ge 2 ]] || wasm_die "--gpg expects a path argument"
      GPG_BIN="$2"
      shift 2
      ;;
    --node)
      [[ $# -ge 2 ]] || wasm_die "--node expects a path argument"
      NODE_BIN="$2"
      shift 2
      ;;
    --homedir)
      [[ $# -ge 2 ]] || wasm_die "--homedir expects a path argument"
      CLI_HOME="$2"
      shift 2
      ;;
    --raw)
      RAW_MODE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      wasm_die "Unknown option: $1"
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  usage
  wasm_die "Missing gpg arguments after --"
fi

require_tool "$NODE_BIN"

if [[ ! -f "$GPG_BIN" ]]; then
  wasm_die "Given gpg path does not exist: $GPG_BIN"
fi

mkdir -p "$CLI_HOME"
chmod 700 "$CLI_HOME" || true

DEFAULT_FLAGS=(
  "--homedir" "$CLI_HOME"
  "--batch"
  "--yes"
  "--no-tty"
  "--no-autostart"
)

wasm_info "Node: $NODE_BIN"
wasm_info "gpg:  $GPG_BIN"
wasm_info "home: $CLI_HOME"

if [[ "$RAW_MODE" -eq 1 ]]; then
  exec "$NODE_BIN" "$GPG_BIN" "$@"
else
  exec "$NODE_BIN" "$GPG_BIN" "${DEFAULT_FLAGS[@]}" "$@"
fi
