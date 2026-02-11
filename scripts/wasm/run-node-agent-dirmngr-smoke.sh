#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh"

usage() {
  cat <<'EOF'
Usage: scripts/wasm/run-node-agent-dirmngr-smoke.sh [options]

Run a Node smoke test for wasm gpg-agent and dirmngr-compatible flows:
  1) key generation via bridged gpg-agent
  2) sign/verify via bridged gpg-agent
  3) keyserver receive via fetch-backed dirmngr shim

Options:
  --workdir PATH        Working directory for smoke files.
  --homedir PATH        GNUPGHOME used for this smoke test.
  --passphrase VALUE    Passphrase for generated test key.
  --keyserver URI       Keyserver used by --recv-keys test.
  --recv-key KEYID      Key id/fingerprint used by --recv-keys test.
  --skip-recv           Skip keyserver receive test.
  --help                Show this help text.
EOF
}

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    wasm_die "Missing required tool: $tool"
  fi
}

NODE_CLI="${NODE_CLI:-$SCRIPT_DIR/gpg-node-cli.sh}"
SMOKE_WORKDIR="${SMOKE_WORKDIR:-$WASM_BUILD_DIR/smoke-agent-dirmngr-node}"
SMOKE_GNUPGHOME="${SMOKE_GNUPGHOME:-$SMOKE_WORKDIR/gnupghome}"
SMOKE_PASSPHRASE="${SMOKE_PASSPHRASE:-wasm-agent-smoke-passphrase}"
SMOKE_RECV_KEYS_SERVER="${SMOKE_RECV_KEYS_SERVER:-hkps://keyserver.ubuntu.com}"
SMOKE_RECV_KEYS_ID="${SMOKE_RECV_KEYS_ID:-0x3B4FE6ACC0B21F32}"
SKIP_RECV=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workdir)
      [[ $# -ge 2 ]] || wasm_die "--workdir expects a path argument"
      SMOKE_WORKDIR="$2"
      shift 2
      ;;
    --homedir)
      [[ $# -ge 2 ]] || wasm_die "--homedir expects a path argument"
      SMOKE_GNUPGHOME="$2"
      shift 2
      ;;
    --passphrase)
      [[ $# -ge 2 ]] || wasm_die "--passphrase expects a value"
      SMOKE_PASSPHRASE="$2"
      shift 2
      ;;
    --keyserver)
      [[ $# -ge 2 ]] || wasm_die "--keyserver expects a URI"
      SMOKE_RECV_KEYS_SERVER="$2"
      shift 2
      ;;
    --recv-key)
      [[ $# -ge 2 ]] || wasm_die "--recv-key expects a key id"
      SMOKE_RECV_KEYS_ID="$2"
      shift 2
      ;;
    --skip-recv)
      SKIP_RECV=1
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

require_tool bash
require_tool date
require_tool cmp

if [[ ! -x "$NODE_CLI" ]]; then
  wasm_die "Node CLI wrapper is not executable: $NODE_CLI"
fi

mkdir -p "$SMOKE_WORKDIR" "$SMOKE_GNUPGHOME"
chmod 700 "$SMOKE_GNUPGHOME" || true

run_cli() {
  bash "$NODE_CLI" --homedir "$SMOKE_GNUPGHOME" -- "$@"
}

run_cli_keyserver() {
  local keyserver="$1"
  shift
  bash "$NODE_CLI" --homedir "$SMOKE_GNUPGHOME" --keyserver "$keyserver" -- "$@"
}

SMOKE_UID="Wasm Agent Smoke $(date -u +%Y%m%dT%H%M%SZ) <wasm-agent-smoke-$(date -u +%s)@example.test>"
SMOKE_PLAIN="$SMOKE_WORKDIR/agent-plain.txt"
SMOKE_SIG="$SMOKE_WORKDIR/agent-plain.txt.asc"

printf 'agent+dirmngr smoke payload (%s)\n' "$(date -u +%FT%TZ)" > "$SMOKE_PLAIN"
rm -f "$SMOKE_SIG"

wasm_info "GNUPGHOME: $SMOKE_GNUPGHOME"
wasm_info "Generating test key"
run_cli \
  --pinentry-mode loopback \
  --passphrase "$SMOKE_PASSPHRASE" \
  --quick-generate-key "$SMOKE_UID" default default never

wasm_info "Signing test payload"
run_cli \
  --pinentry-mode loopback \
  --passphrase "$SMOKE_PASSPHRASE" \
  --local-user "$SMOKE_UID" \
  --output "$SMOKE_SIG" \
  --armor \
  --sign "$SMOKE_PLAIN"

wasm_info "Verifying signature"
run_cli --verify "$SMOKE_SIG"

if [[ "$SKIP_RECV" -eq 0 ]]; then
  wasm_info "Receiving key from keyserver"
  run_cli_keyserver "$SMOKE_RECV_KEYS_SERVER" --recv-keys "$SMOKE_RECV_KEYS_ID"
fi

wasm_info "Agent+dirmngr smoke passed"
wasm_info "Workdir: $SMOKE_WORKDIR"
