# GnuPG WASM — USB Smartcard (WebUSB + CCID) Feature

## Overview

This project ports GnuPG's smartcard daemon (`scdaemon`) to WebAssembly, enabling
direct communication with USB security keys (e.g. Nitrokey, CanoKey) from a browser
via WebUSB. The entire stack runs inside an **Isolated Web App (IWA)** to satisfy
the security requirements of WebUSB and Content Security Policy.

Hardware tested: **CanoKey** (VID `0x20a0`, PID `0x42d4`) connected via USB-IP.
Interface 2 is the CCID smartcard interface.

---

## Architecture

Three WASM processes run in separate Web Workers, communicating via SharedArrayBuffer
ring queues with `Atomics.wait` / `Atomics.notify`:

```
┌──────────────────────┐
│  gpg                 │  (gpg-browser-worker.js)
│  Web Worker          │
└──────┬───────────────┘
       │ SharedArrayBuffer [gpgToAgent / agentToGpg]
       │ (Emscripten FS device on fd 3)
┌──────▼───────────────┐
│  gpg-agent           │  (gpg-agent-server-worker.js)
│  Web Worker          │
└──────┬───────────────┘
       │ SharedArrayBuffer [agentToScdaemon / scdaemonToAgent]
       │ (Emscripten FS device on fd 3)
┌──────▼───────────────┐
│  scdaemon            │  (gpg-scdaemon-server-worker.js)
│  Web Worker          │
│  + pthreads pool     │
└──────┬───────────────┘
       │ WebUSB (transferIn / transferOut)
┌──────▼───────────────┐
│  USB Security Key    │
│  (CCID interface)    │
└──────────────────────┘
```

### Ring queue details

Each SharedArrayBuffer queue has:
- `ctrl`: `Int32Array` — `[head, tail, closed, notify_counter]`
- `data`: `Uint8Array` ring buffer, 262144 bytes

Emscripten's `FS.createDevice` provides `read()` / `write()` callbacks. The `read()`
callback calls `input()` in a loop; `input()` pops one byte from the ring queue.

### scdaemon compilation flags

```
-pthread -sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=4
-sASYNCIFY --bind
-sTRUSTED_TYPES=1 -sDYNAMIC_EXECUTION=0   (browser target only)
```

- `ASYNCIFY` is required because the libusb WebUSB backend uses async JavaScript APIs
  (device enumeration, transfers) that must be awaited from synchronous C code.
- `DYNAMIC_EXECUTION=0` prevents Emscripten from generating `new Function(...)` calls,
  which would violate the IWA's CSP (`script-src 'self' 'wasm-unsafe-eval'`).
- `TRUSTED_TYPES=1` enables Trusted Types support for IWA compliance.

---

## Data flow for `gpg --card-status`

1. `gpg` sends `SCD SERIALNO` to `gpg-agent` via the gpg↔agent ring queue.
2. `gpg-agent` relays the command to `scdaemon` via the agent↔scdaemon ring queue.
3. `scdaemon` receives the command on stdin (Emscripten FS device backed by the queue).
4. `scdaemon`'s Assuan command handler invokes `scd/command.c` → `scd/app.c` → `scd/ccid-driver.c`.
5. `ccid-driver.c` calls `libusb_bulk_transfer()` for CCID USB communication.
6. `libusb` (Emscripten WebUSB backend) translates to `device.transferOut()` / `device.transferIn()`.
7. The WebUSB API communicates with the physical USB device.
8. Response travels back up the chain: libusb → ccid-driver → app → command → stdout → ring queue → agent → gpg.

---

## Bugs found and fixed

### Bug 1: scdaemon stdin blocking logic

**Symptom**: After reading a complete Assuan command line, Emscripten's `read()` loop
called `input()` again, blocking forever waiting for the next byte.

**Root cause**: `queuePopByte(bridge.agentToScdaemon, true)` was hardcoded to always
block. After a full line was consumed, the next `input()` call would block indefinitely
because no more data was available yet.

**Fix** (`gpg-scdaemon-server-worker.js`): Introduced `stdinDeliveredInRead` /
`stdinReadSeq` tracking. The first byte of each `read()` syscall blocks (waits for
data); subsequent bytes within the same `read()` are non-blocking (return `null`
immediately if the queue is empty, signaling EOF to Emscripten).

### Bug 2: CSP `unsafe-eval` violation

**Symptom**: `EvalError: Refused to evaluate a string as JavaScript` when scdaemon
processed `SERIALNO` (which triggers WebUSB/embind code paths via `__emval_create_invoker`).

**Root cause**: Emscripten's `__emval_create_invoker` used `new Function(...)` which
violates the IWA Content Security Policy.

**Fix** (two layers):
1. Added `-sDYNAMIC_EXECUTION=0` to browser link flags in `scripts/wasm/build-gnupg.sh`
   so Emscripten generates eval-free code natively.
2. Belt-and-suspenders JS post-patch in `scripts/wasm/prepare-browser-assets.sh`
   (`patch_scdaemon_eval_invoker`) that replaces any remaining `new Function` with a
   switch-based invoker. This patch now reports "not needed" since the link flag handles it.

### Bug 3: Asyncify premature return

**Symptom**: scdaemon worker called `finish()` (closing queues, killing worker) before
async WebUSB operations completed.

**Root cause**: `callMainWith()` returns immediately when Asyncify unwinds (e.g. during
`libusb_get_device_list` which is async via WebUSB). The worker's `finish()` was called
on the synchronous return.

**Fix** (`gpg-scdaemon-server-worker.js`): After `callMainWith()` returns, check
`Asyncify.currData` (pending) and `Asyncify.whenDone`. If async work is pending, await
`Asyncify.whenDone()` promise before calling `finish()`.

### Bug 4: `___syscall_poll` proxy crash

**Symptom**: `TypeError: rtn.then is not a function` in
`__emscripten_receive_on_main_thread_js`.

**Root cause**: `___syscall_poll` used `Asyncify.handleAsync()` even during proxied
worker→main calls, returning a non-Promise where a Promise was expected.

**Fix** (`scripts/wasm/prepare-browser-assets.sh`, `patch_scdaemon_poll_proxy_async`):
When `PThread.currentProxiedOperationCallerThread` is set, call `innerFunc()` directly
instead of wrapping in `Asyncify.handleAsync()`.

### Bug 5: WebUSB `claimInterface` failure (rc=-1)

**Symptom**: `libusb_claim_interface` returned `LIBUSB_ERROR_IO` (-1).

**Root cause**: No USB configuration was selected before claiming the interface. WebUSB
requires an explicit `selectConfiguration()` call.

**Fix** (`libusb-1.0.29/libusb/os/emscripten_webusb.cpp`):
- Added `claimInterfacePromise()` coroutine that auto-selects the first configuration
  if none is active before calling `claimInterface`.
- Added timeout wrappers for `selectConfiguration` (5s) and `claimInterface` (5s).

```cpp
CaughtPromise claimInterfacePromise(const val& dev, uint8_t iface) {
    auto config = dev["configuration"];
    if (config.isNull() || config.isUndefined()) {
        auto configurations = dev["configurations"];
        auto len = configurations["length"].as<unsigned int>();
        if (len > 0) {
            auto first = configurations[0];
            auto config_value = first["configurationValue"].as<int>();
            co_await_try(val::take_ownership(
                usbi_em_select_configuration_with_timeout(
                    dev.as_handle(), config_value, 5000)));
        }
    }
    co_return co_await_try(val::take_ownership(
        usbi_em_claim_interface_with_timeout(
            dev.as_handle(), iface, 5000)));
}
```

### Bug 6: USB serial string descriptor hang

**Symptom**: `make_reader_id()` hung during USB control transfer to read the serial
number string descriptor.

**Root cause**: The control transfer blocked before the interface was fully ready in
the WebUSB context.

**Fix** (`scd/ccid-driver.c`): Under `__EMSCRIPTEN__`, `make_reader_id()` skips the
string descriptor query and returns a stable fallback reader ID (`VID:PID:X:0`).

### Bug 7: CCID USB event thread deadlock

**Symptom**: First `bulk_out` (CCID `PC_to_RDR_IccPowerOff`, type `0x65`) hung forever
after reader open succeeded.

**Root cause**: `ccid_open_usb_reader` spawns a detached `ccid_usb_thread` that loops
calling `libusb_handle_events_completed(ctx, NULL)`. On Emscripten with pthreads, this
thread competes with the main thread for the libusb event lock, causing a deadlock —
the main thread's `libusb_bulk_transfer` submits a transfer and blocks waiting for
completion, but the event thread is also blocked fighting for the same lock/proxy queue.

**Fix** (`scd/ccid-driver.c`): Wrapped the entire `ccid_usb_thread` creation block and
the `--ccid_usb_thread_is_alive` decrements in `#ifndef __EMSCRIPTEN__`. On Emscripten,
libusb's event handling is done via the async JavaScript event loop, so the dedicated
event thread is unnecessary and harmful.

---

## Modified files

### JavaScript workers

| File | Description |
|------|-------------|
| `scripts/wasm/gpg-scdaemon-server-worker.js` | scdaemon worker. Build tag `2026-02-15-console-trace-v9`. Stdin blocking logic (Bug 1), Asyncify whenDone handling (Bug 3), debug traces. |
| `scripts/wasm/gpg-agent-server-worker.js` | Agent worker. Build tag `2026-02-15-log-v8`. Scdaemon message relay, debug. |
| `scripts/wasm/gpg-browser-worker.js` | gpg worker. Agent bridge. |

### Build scripts

| File | Description |
|------|-------------|
| `scripts/wasm/build-gnupg.sh` | `-sDYNAMIC_EXECUTION=0` for browser (Bug 2). `--bind -sASYNCIFY` for all. |
| `scripts/wasm/prepare-browser-assets.sh` | JS post-patches: `patch_scdaemon_eval_invoker` (Bug 2), `patch_scdaemon_poll_proxy_async` (Bug 4). |
| `scripts/wasm/build-gnupg-browser.sh` | Wrapper: build-gnupg.sh + prepare-browser-assets.sh. |
| `scripts/wasm/build-iwa.sh` | IWA signed web bundle builder. |
| `scripts/wasm/build-deps.sh` | Dependency build (libusb, libgpg-error, npth, libgcrypt, libassuan, libksba). |

### C sources — gnupg

| File | Changes |
|------|---------|
| `scd/ccid-driver.c` | `make_reader_id()` fallback (Bug 6). Disable `ccid_usb_thread` (Bug 7). `bulk_out`/`bulk_in` trace logging. Skip `--ccid_usb_thread_is_alive` in `do_close_reader`. |
| `scd/scdaemon.c` | `[wasm-trace]` logging. |
| `scd/command.c` | `[wasm-trace]` logging. |
| `scd/app.c` | `[wasm-trace]` logging. |
| `agent/call-daemon.c` | `[wasm-trace]` logging. |
| `agent/call-scd.c` | `[wasm-trace]` logging. |
| `agent/command.c` | `[wasm-trace]` logging. |

### C sources — libusb (external: `../libusb-1.0.29/`)

| File | Changes |
|------|---------|
| `libusb/os/emscripten_webusb.cpp` | `claimInterfacePromise()` coroutine (Bug 5). EM_JS timeout helpers for `selectConfiguration` (5s), `claimInterface` (5s), `transferIn` (8s), `transferOut` (8s). Enhanced error logging. |

### C sources — libassuan (traces removed)

| File | Status |
|------|--------|
| `PLAY/src/libassuan/src/assuan-buffer.c` | `[wasm-trace]` lines removed. |
| `PLAY/src/libassuan/src/system.c` | `[wasm-trace]` lines removed. |
| `PLAY/src/libassuan/src/assuan-handler.c` | `[wasm-trace]` lines removed. |
| `PLAY/src/libassuan/src/client.c` | `[wasm-trace]` lines removed. |
| `PLAY/src/libassuan/src/assuan-socket-connect.c` | `[wasm-trace]` lines removed. |

---

## libusb WebUSB backend — timeout values

| Operation | Timeout | Location |
|-----------|---------|----------|
| `selectConfiguration` | 5000 ms | `claimInterfacePromise()` in `emscripten_webusb.cpp` |
| `claimInterface` | 5000 ms | `claimInterfacePromise()` in `emscripten_webusb.cpp` |
| `transferIn` | 8000 ms | `em_submit_transfer()` in `emscripten_webusb.cpp` |
| `transferOut` | 8000 ms | `em_submit_transfer()` in `emscripten_webusb.cpp` |

---

## Build commands

### JS-only changes (worker files)

```bash
cd /home/niko/Desktop/Projects/gnupg-w32/gnupg
bash scripts/wasm/build-iwa.sh
```

### C changes in gnupg (scd/ccid-driver.c, etc.)

```bash
bash scripts/wasm/build-gnupg-browser.sh --force
bash scripts/wasm/build-iwa.sh
```

### C changes in libusb

```bash
emmake make -C PLAY/wasm-build-browser/libusb -j$(nproc) install
bash scripts/wasm/build-gnupg-browser.sh --force   # relink
bash scripts/wasm/build-iwa.sh
```

### C changes in libassuan

```bash
make -C PLAY/wasm-build-browser/libassuan -j$(nproc) install
bash scripts/wasm/build-gnupg-browser.sh --force
bash scripts/wasm/build-iwa.sh
```

### Full clean rebuild

```bash
bash scripts/wasm/build-gnupg-browser.sh --clean --force --reconfigure
bash scripts/wasm/build-iwa.sh
```

### Launch Chromium for testing

```bash
pkill -f "chromium.*chromium-iwa-test" || true
rm -rf /tmp/chromium-iwa-test
chromium \
  --user-data-dir=/tmp/chromium-iwa-test \
  --no-first-run \
  --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \
  --install-isolated-web-app-from-file=PLAY/iwa/gnupg-wasm-demo.swbn
```

IWA URL:
```
isolated-app://r2m3p4dvre3uofxuq3qdhj3mhv5rb5nmtandzekfbdajgviaorjaaaic/scripts/wasm/demo/demo.html
```

---

## Debug logging

### C-level traces

All C debug logging is gated on `#ifdef __EMSCRIPTEN__` (compile-time). Some traces
are additionally gated on the `GNUPG_WASM_TRACE=1` environment variable (runtime,
set by JS when `debugEnabled` is true).

Trace prefixes:
- `[wasm-trace]` — gnupg internal (scdaemon, agent, ccid-driver)
- `[libusb-webusb-trace]` — libusb WebUSB backend

### JS-level traces

- `console.error(...)` in scdaemon worker — goes directly to DevTools console
  (reliable even if worker dies before `postMessage` delivery).
- scdaemon stderr output is captured by `writeStderrByte` and posted as
  `scdaemon.stderr.line` debug messages. Also dumped in bulk at end of agent output.

---

## Current status

All 7 bugs have been fixed. The last build successfully opens the USB reader
(`ccid_open_usb_reader: leave rc=0`) and reaches the first `bulk_out` call
(CCID `PC_to_RDR_IccPowerOff`, type `0x65`). Bug 7 (event thread deadlock) was the
most recent fix — the build with this fix has been deployed but **not yet tested by
the user**.

### Known issues / next steps

1. **CanoKey `Unknown request` error**: During earlier tests, the CanoKey firmware
   logged `[ERR] USBD_CANOKEY_Setup(50): Unknown request`. This may indicate an
   interface number mismatch or wrong endpoint. Will investigate if transfers start
   working but the device rejects commands.

2. **Trace cleanup**: Once card communication works end-to-end, the verbose
   `[wasm-trace]` and `[libusb-webusb-trace]` logging should be gated behind
   `GNUPG_WASM_TRACE=1` runtime check (some already are, but the `bulk_out`/`bulk_in`
   traces in `ccid-driver.c` are unconditional under `__EMSCRIPTEN__`). JS-side
   `console.error` traces should also be gated behind `debugEnabled`.

3. **npth interaction**: `ccid-driver.c` calls `my_npth_unprotect()` before
   `libusb_bulk_transfer` and `my_npth_protect()` after. The npth semaphore
   interaction with Emscripten's proxy queue could cause issues if transfers
   start timing out or deadlocking.

4. **Emscripten errno note**: Emscripten errno 6 = `EAGAIN` (not `ENXIO`).
   Confirmed via `mkerrcodes.h`.

5. **No pcscd**: `pcscd` is NOT running on the host machine. All USB access is
   direct via WebUSB → CCID.
