#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh"

usage() {
  cat <<'EOF'
Usage: scripts/wasm/run-node-smoke.sh [options]

Run a Node-based symmetric encrypt/decrypt smoke test using the built wasm gpg.

Options:
  --gpg PATH          Explicit path to gpg wasm launcher.
  --passphrase VALUE  Passphrase used for test encryption/decryption.
  --workdir PATH      Working directory for smoke files.
  --help              Show this help text.
EOF
}

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    wasm_die "Missing required tool: $tool"
  fi
}

find_gpg() {
  local candidates=(
    "$WASM_PREFIX/bin/gpg"
    "$WASM_PREFIX/bin/gpg.js"
    "$WASM_BUILD_DIR/gnupg/g10/gpg"
    "$WASM_BUILD_DIR/gnupg/g10/gpg.js"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

NODE_BIN="${NODE_BIN:-${EMSDK_NODE:-node}}"
GPG_BIN=""
SMOKE_PASSPHRASE="${SMOKE_PASSPHRASE:-wasm-smoke-passphrase}"
SMOKE_WORKDIR="${SMOKE_WORKDIR:-$WASM_BUILD_DIR/smoke-node}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gpg)
      [[ $# -ge 2 ]] || wasm_die "--gpg expects a path argument"
      GPG_BIN="$2"
      shift 2
      ;;
    --passphrase)
      [[ $# -ge 2 ]] || wasm_die "--passphrase expects a value"
      SMOKE_PASSPHRASE="$2"
      shift 2
      ;;
    --workdir)
      [[ $# -ge 2 ]] || wasm_die "--workdir expects a path argument"
      SMOKE_WORKDIR="$2"
      shift 2
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

require_tool "$NODE_BIN"
require_tool cmp

if [[ -z "$GPG_BIN" ]]; then
  if ! GPG_BIN="$(find_gpg)"; then
    wasm_die "Could not find gpg wasm binary. Build first via scripts/wasm/build-all.sh"
  fi
fi

if [[ ! -f "$GPG_BIN" ]]; then
  wasm_die "Given gpg path does not exist: $GPG_BIN"
fi

SMOKE_GNUPGHOME="${GNUPGHOME:-$SMOKE_WORKDIR/gnupghome}"
PLAINTEXT_FILE="$SMOKE_WORKDIR/plain.txt"
CIPHERTEXT_FILE="$SMOKE_WORKDIR/plain.txt.gpg"
DECRYPTED_FILE="$SMOKE_WORKDIR/plain.txt.dec"

mkdir -p "$SMOKE_WORKDIR" "$SMOKE_GNUPGHOME"
chmod 700 "$SMOKE_GNUPGHOME"

printf 'hello from gnupg wasm node smoke test (%s)\n' "$(date -u +%FT%TZ)" > "$PLAINTEXT_FILE"
rm -f "$CIPHERTEXT_FILE" "$DECRYPTED_FILE"

run_gpg() {
  "$NODE_BIN" "$GPG_BIN" \
    --homedir "$SMOKE_GNUPGHOME" \
    --batch --yes --no-tty --no-autostart "$@"
}

wasm_info "Using gpg binary: $GPG_BIN"
wasm_info "Using GNUPGHOME:  $SMOKE_GNUPGHOME"

run_gpg --version

run_gpg \
  --pinentry-mode loopback \
  --passphrase "$SMOKE_PASSPHRASE" \
  --s2k-count 65536 \
  --compress-algo none \
  --cipher-algo AES256 \
  --output "$CIPHERTEXT_FILE" \
  --symmetric "$PLAINTEXT_FILE"

run_gpg \
  --pinentry-mode loopback \
  --passphrase "$SMOKE_PASSPHRASE" \
  --output "$DECRYPTED_FILE" \
  --decrypt "$CIPHERTEXT_FILE"

if ! cmp -s "$PLAINTEXT_FILE" "$DECRYPTED_FILE"; then
  wasm_die "Smoke test failed: decrypted content does not match original"
fi

wasm_info "Smoke test passed"
wasm_info "Ciphertext: $CIPHERTEXT_FILE"
wasm_info "Decrypted:  $DECRYPTED_FILE"
