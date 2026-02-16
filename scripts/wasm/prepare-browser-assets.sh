#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/env.sh"

WASM_PREFIX="$WASM_PREFIX/../wasm-prefix-browser"
SRC_GPG="$WASM_PREFIX/bin/gpg"
DST_GPG_JS="$WASM_PREFIX/bin/gpg.js"
SRC_GPG_AGENT="$WASM_PREFIX/bin/gpg-agent"
DST_GPG_AGENT_JS="$WASM_PREFIX/bin/gpg-agent.js"
SRC_SCDAEMON="$WASM_PREFIX/libexec/scdaemon"
DST_SCDAEMON_JS="$WASM_PREFIX/bin/scdaemon.js"
SRC_SCDAEMON_WASM="$WASM_PREFIX/libexec/scdaemon.wasm"
DST_SCDAEMON_WASM="$WASM_PREFIX/bin/scdaemon.wasm"

patch_scdaemon_eval_invoker() {
  local target="$1"
  if [[ ! -f "$target" ]]; then
    return 0
  fi

  python3 - "$target" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
data = path.read_text(encoding='utf-8', errors='ignore')

needle = 'new Function(Object.keys(captures), functionBody)(...Object.values(captures))'
if needle not in data:
  print('[wasm] scdaemon.js eval patch: not needed')
  raise SystemExit(0)

pattern = re.compile(
  r"var __emval_create_invoker = \(argCount, argTypesPtr, kind\) => \{\n(?:.*\n)*?\};\n\nvar __emval_equals = ",
  re.MULTILINE,
)

replacement = """var __emval_create_invoker = (argCount, argTypesPtr, kind) => {
  var GenericWireTypeSize = 8;
  var [retType, ...argTypes] = emval_lookupTypes(argCount, argTypesPtr);
  var toReturnWire = retType.toWireType.bind(retType);
  var argFromPtr = argTypes.map(type => type.readValueFromPointer.bind(type));
  argCount--;
  var invokerFunction = (handle, methodName, destructorsRef, argsPtr) => {
    var argv = new Array(argCount);
    for (var i = 0; i < argCount; ++i) {
      argv[i] = argFromPtr[i](argsPtr + i * GenericWireTypeSize);
    }
    var result;
    switch (kind) {
     case 0:
      result = Emval.toValue(handle)(...argv);
      break;

     case 1:
      result = Emval.toValue(handle)[getStringOrSymbol(methodName)](...argv);
      break;

     case 2:
      result = Reflect.construct(Emval.toValue(handle), argv);
      break;

     case 3:
      result = argv.length ? argv[argv.length - 1] : undefined;
      break;

     default:
      throwBindingError(`invalid EM_INVOKER_KIND: ${kind}`);
    }
    if (!retType.isVoid) {
      return emval_returnValue(toReturnWire, destructorsRef, result);
    }
  };
  var functionName = `methodCaller<(${argTypes.map(t => t.name)}) => ${retType.name}>`;
  return emval_addMethodCaller(createNamedFunction(functionName, invokerFunction));
};

var __emval_equals = """

updated, count = pattern.subn(replacement, data, count=1)
if count != 1:
  print('[wasm] scdaemon.js eval patch: failed to locate __emval_create_invoker', file=sys.stderr)
  raise SystemExit(1)

path.write_text(updated, encoding='utf-8')
print('[wasm] scdaemon.js eval patch: applied')
PY
}

patch_scdaemon_poll_proxy_async() {
  local target="$1"
  if [[ ! -f "$target" ]]; then
    return 0
  fi

  python3 - "$target" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
data = path.read_text(encoding='utf-8', errors='ignore')

old = "  return Asyncify.handleAsync(innerFunc);\n};\n\n___syscall_poll.isAsync = true;"
new = "  if (PThread.currentProxiedOperationCallerThread) {\n    return innerFunc();\n  }\n  return Asyncify.handleAsync(innerFunc);\n};\n\n___syscall_poll.isAsync = true;"

if old in data:
  data = data.replace(old, new, 1)
  path.write_text(data, encoding='utf-8')
  print('[wasm] scdaemon.js poll proxy patch: applied')
  raise SystemExit(0)

# If pattern is already patched, do nothing.
if new in data:
  print('[wasm] scdaemon.js poll proxy patch: already applied')
  raise SystemExit(0)

print('[wasm] scdaemon.js poll proxy patch: pattern not found', file=sys.stderr)
raise SystemExit(1)
PY
}

if [[ ! -f "$SRC_GPG" ]]; then
  wasm_die "Missing wasm launcher: $SRC_GPG"
fi

cp -f "$SRC_GPG" "$DST_GPG_JS"
chmod +x "$DST_GPG_JS" || true

if [[ -f "$SRC_GPG_AGENT" ]]; then
  cp -f "$SRC_GPG_AGENT" "$DST_GPG_AGENT_JS"
  chmod +x "$DST_GPG_AGENT_JS" || true
  wasm_info "Prepared browser asset: $DST_GPG_AGENT_JS"
else
  wasm_info "Skipping gpg-agent.js (missing source launcher: $SRC_GPG_AGENT)"
fi

if [[ -f "$SRC_SCDAEMON" ]]; then
  cp -f "$SRC_SCDAEMON" "$DST_SCDAEMON_JS"
  patch_scdaemon_eval_invoker "$DST_SCDAEMON_JS"
  patch_scdaemon_poll_proxy_async "$DST_SCDAEMON_JS"
  chmod +x "$DST_SCDAEMON_JS" || true
  wasm_info "Prepared browser asset: $DST_SCDAEMON_JS"
else
  wasm_info "Skipping scdaemon.js (missing source launcher: $SRC_SCDAEMON)"
fi

if [[ -f "$SRC_SCDAEMON_WASM" ]]; then
  cp -f "$SRC_SCDAEMON_WASM" "$DST_SCDAEMON_WASM"
  wasm_info "Prepared browser asset: $DST_SCDAEMON_WASM"
else
  wasm_info "Skipping scdaemon.wasm (missing sidecar: $SRC_SCDAEMON_WASM)"
fi

wasm_info "Prepared browser asset: $DST_GPG_JS"
wasm_info "Use in demo: /PLAY/wasm-prefix-browser/bin/gpg.js"
