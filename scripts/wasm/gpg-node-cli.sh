#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh"

NODE_BIN="${NODE_BIN:-${EMSDK_NODE:-node}}"

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  wasm_die "Missing required tool: $NODE_BIN"
fi

exec "$NODE_BIN" "$SCRIPT_DIR/gpg-node-cli.mjs" "$@"
