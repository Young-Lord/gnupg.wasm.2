#!/usr/bin/env bash

WASM_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GNUPG_WASM_REPO_ROOT="${GNUPG_WASM_REPO_ROOT:-$(cd -- "$WASM_SCRIPT_DIR/../.." && pwd)}"
GNUPG_WASM_EMSDK="${GNUPG_WASM_EMSDK:-$GNUPG_WASM_REPO_ROOT/../emsdk}"

wasm_info() {
  printf '[wasm] %s\n' "$*"
}

wasm_die() {
  printf '[wasm] error: %s\n' "$*" >&2
  return 1 2>/dev/null || exit 1
}

wasm_append_flags() {
  local current="$1"
  local extra="$2"

  if [[ -n "$current" ]]; then
    printf '%s %s' "$current" "$extra"
  else
    printf '%s' "$extra"
  fi
}

if [[ ! -f "$GNUPG_WASM_EMSDK/emsdk_env.sh" ]]; then
  wasm_die "Missing emsdk_env.sh at $GNUPG_WASM_EMSDK/emsdk_env.sh"
fi

if [[ -z "${EMSDK_QUIET:-}" ]]; then
  export EMSDK_QUIET=1
fi

# shellcheck disable=SC1090
source "$GNUPG_WASM_EMSDK/emsdk_env.sh" >/dev/null

WASM_HOST="${WASM_HOST:-$(emcc -dumpmachine)}"
WASM_BUILD_TRIPLET="${WASM_BUILD_TRIPLET:-$($GNUPG_WASM_REPO_ROOT/build-aux/config.guess)}"

WASM_PREFIX="${WASM_PREFIX:-$GNUPG_WASM_REPO_ROOT/PLAY/wasm-prefix}"
WASM_BUILD_DIR="${WASM_BUILD_DIR:-$GNUPG_WASM_REPO_ROOT/PLAY/wasm-build}"
WASM_LOG_DIR="${WASM_LOG_DIR:-$GNUPG_WASM_REPO_ROOT/PLAY/wasm-logs}"

if command -v nproc >/dev/null 2>&1; then
  _wasm_default_jobs="$(nproc)"
else
  _wasm_default_jobs="4"
fi
WASM_JOBS="${WASM_JOBS:-$_wasm_default_jobs}"
WASM_PTHREAD_POOL_SIZE="${WASM_PTHREAD_POOL_SIZE:-4}"
WASM_INITIAL_MEMORY="${WASM_INITIAL_MEMORY:-128MB}"

WASM_THREAD_FLAGS="${WASM_THREAD_FLAGS:--pthread -sUSE_PTHREADS=1}"
WASM_COMMON_CPPFLAGS="${WASM_COMMON_CPPFLAGS:--I$WASM_PREFIX/include}"
WASM_COMMON_CFLAGS="${WASM_COMMON_CFLAGS:--O2 -fPIC $WASM_THREAD_FLAGS}"
WASM_COMMON_CXXFLAGS="${WASM_COMMON_CXXFLAGS:-$WASM_COMMON_CFLAGS}"
WASM_COMMON_LDFLAGS="${WASM_COMMON_LDFLAGS:--L$WASM_PREFIX/lib $WASM_THREAD_FLAGS -sPTHREAD_POOL_SIZE=$WASM_PTHREAD_POOL_SIZE -sINITIAL_MEMORY=$WASM_INITIAL_MEMORY}"
WASM_NODE_LDFLAGS="${WASM_NODE_LDFLAGS:--sENVIRONMENT=node -sNODERAWFS=1}"
WASM_BROWSER_LDFLAGS="${WASM_BROWSER_LDFLAGS:--sENVIRONMENT=web,worker,node}"

export WASM_SCRIPT_DIR
export GNUPG_WASM_REPO_ROOT
export GNUPG_WASM_EMSDK
export WASM_HOST
export WASM_BUILD_TRIPLET
export WASM_PREFIX
export WASM_BUILD_DIR
export WASM_LOG_DIR
export WASM_JOBS
export WASM_PTHREAD_POOL_SIZE
export WASM_INITIAL_MEMORY
export WASM_THREAD_FLAGS
export WASM_COMMON_CPPFLAGS
export WASM_COMMON_CFLAGS
export WASM_COMMON_CXXFLAGS
export WASM_COMMON_LDFLAGS
export WASM_NODE_LDFLAGS
export WASM_BROWSER_LDFLAGS

export CC="${CC:-emcc}"
export CXX="${CXX:-em++}"
export AR="${AR:-emar}"
export RANLIB="${RANLIB:-emranlib}"
export NM="${NM:-emnm}"
export STRIP="${STRIP:-llvm-strip}"
export PKG_CONFIG="${PKG_CONFIG:-pkg-config}"

export CPPFLAGS="$(wasm_append_flags "${CPPFLAGS:-}" "$WASM_COMMON_CPPFLAGS")"
export CFLAGS="$(wasm_append_flags "${CFLAGS:-}" "$WASM_COMMON_CFLAGS")"
export CXXFLAGS="$(wasm_append_flags "${CXXFLAGS:-}" "$WASM_COMMON_CXXFLAGS")"
export LDFLAGS="$(wasm_append_flags "${LDFLAGS:-}" "$WASM_COMMON_LDFLAGS")"

if [[ -n "${PKG_CONFIG_PATH:-}" ]]; then
  export PKG_CONFIG_PATH="$WASM_PREFIX/lib/pkgconfig:$PKG_CONFIG_PATH"
else
  export PKG_CONFIG_PATH="$WASM_PREFIX/lib/pkgconfig"
fi
export PKG_CONFIG_LIBDIR="$WASM_PREFIX/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
export PATH="$WASM_PREFIX/bin:$PATH"

mkdir -p "$WASM_PREFIX" "$WASM_BUILD_DIR" "$WASM_LOG_DIR"

wasm_print_env() {
  cat <<EOF
GNUPG_WASM_REPO_ROOT=$GNUPG_WASM_REPO_ROOT
GNUPG_WASM_EMSDK=$GNUPG_WASM_EMSDK
WASM_HOST=$WASM_HOST
WASM_BUILD_TRIPLET=$WASM_BUILD_TRIPLET
WASM_PREFIX=$WASM_PREFIX
WASM_BUILD_DIR=$WASM_BUILD_DIR
WASM_LOG_DIR=$WASM_LOG_DIR
WASM_JOBS=$WASM_JOBS
CC=$CC
CXX=$CXX
AR=$AR
RANLIB=$RANLIB
NM=$NM
CPPFLAGS=$CPPFLAGS
CFLAGS=$CFLAGS
CXXFLAGS=$CXXFLAGS
LDFLAGS=$LDFLAGS
WASM_NODE_LDFLAGS=$WASM_NODE_LDFLAGS
WASM_BROWSER_LDFLAGS=$WASM_BROWSER_LDFLAGS
PKG_CONFIG_PATH=$PKG_CONFIG_PATH
PKG_CONFIG_LIBDIR=$PKG_CONFIG_LIBDIR
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  wasm_print_env
fi
