# WebUSB Card Status Hang — Debug Progress

## Problem
`gpg --card-status` hangs when run in the WASM/WebUSB IWA environment. The command times out after 60 seconds.

## Architecture Overview

### Worker Topology (all Web Workers)
```
gpg-browser-worker.js  (gpg binary, runs in its own Worker)
    │
    ├── agent bridge (SharedArrayBuffer queues: gpgToAgent / agentToGpg)
    │
    ▼
gpg-agent-server-worker.js  (gpg-agent binary, runs in its own Worker)
    │
    ├── scd bridge device (SharedArrayBuffer queues: agentToScdaemon / scdaemonToAgent)
    │   registered as /dev/gnupg-scd-bridge-* via FS.registerDevice()
    │
    ▼
gpg-scdaemon-server-worker.js  (scdaemon binary, runs in its own Worker)
    │
    ├── WebUSB (libusb via Emscripten)
    │
    ▼
USB Smartcard (e.g. Nitrokey 0x20a0:0x42d4)
```

### Communication Flow for `gpg --card-status`
1. **gpg** calls `agent_scd_learn()` which connects to gpg-agent via pre-opened FD (GNUPG_WASM_AGENT_FD)
2. **gpg** sends Assuan commands to agent: `RESET`, `GETINFO version`, `OPTION ...`, then `SCD GETINFO version`
3. **gpg-agent** receives `SCD GETINFO version` via its stdin (gpgToAgent queue)
4. **gpg-agent** C code: `cmd_scd()` → `divert_generic_cmd()` → `agent_card_scd()` → `start_scd()` → `daemon_start(DAEMON_SCD)`
5. **gpg-agent** `daemon_start` calls `wasm_connect_preopened_scdaemon()` → `assuan_socket_connect_fd(fd=3)` on the scd bridge device
6. **libassuan** `_assuan_connect_finalize()` reads the scdaemon greeting from the scd bridge device FD
7. **gpg-agent** then calls `assuan_transact(ctx, "GETINFO version", ...)` which writes to scd bridge device and reads response
8. **scdaemon** receives command via its stdin (agentToScdaemon queue), processes it, writes response to stdout (scdaemonToAgent queue)
9. Response flows back: scdaemon → scd bridge device → gpg-agent → agent bridge → gpg

### Bridge Mechanism
- Each bridge uses two `SharedArrayBuffer` ring queues (262144 bytes each)
- Queue layout: `ctrl` = Int32Array(4) [head, tail, closed, stamp], `data` = Uint8Array(size)
- `queuePushByte()`: writes byte, advances head, calls `Atomics.notify(ctrl, 3)`
- `queuePopByte(shouldBlock)`: reads byte from tail; if empty and shouldBlock, does `Atomics.wait(ctrl, 3, stamp, 10)` in a loop
- `queueNotify()`: `Atomics.add(ctrl, 3, 1)` + `Atomics.notify(ctrl, 3)`

### Agent stdin mechanism (gpg-agent-server-worker.js)
- `FS.init()` registers a per-byte stdin callback
- The callback calls `queuePopByte(bridge.gpgToAgent, shouldBlock)`
- `shouldBlock = (stdinDeliveredInRead === 0)` — blocks on first byte of each read, non-blocking for subsequent bytes
- When the C code calls `read(fd=0, buf, size)`, Emscripten calls this callback repeatedly

### Scd bridge device (gpg-agent-server-worker.js)
- Registered via `FS.registerDevice()` at `/dev/gnupg-scd-bridge-*`
- `read()`: calls `scdaemonBridge.readByte(true)` for first byte (blocking), then non-blocking for rest
- `write()`: calls `scdaemonBridge.writeByte()` for each byte
- The scdaemonBridge reads from `scdaemonToAgent` queue and writes to `agentToScdaemon` queue

### Scdaemon stdin/stdout (gpg-scdaemon-server-worker.js)
- `FS.init()` registers stdin callback: `queuePopByte(bridge.agentToScdaemon, true)` (always blocking)
- stdout callback: `queuePushByte(bridge.scdaemonToAgent, ch, true)`

## Key Source Files

### JavaScript Workers
- `scripts/wasm/gpg-browser-worker.js` — gpg runner, creates agent bridge, registers agent FD device
- `scripts/wasm/gpg-agent-server-worker.js` — gpg-agent runner, creates scd bridge device, manages scdaemon worker
- `scripts/wasm/gpg-scdaemon-server-worker.js` — scdaemon runner, manages USB devices

### C Code (agent side)
- `agent/command.c:cmd_scd()` — handles `SCD` prefix commands from gpg
- `agent/call-scd.c:agent_card_scd()` — forwards SCD commands to scdaemon via assuan
- `agent/call-scd.c:start_scd()` → `agent/call-daemon.c:daemon_start(DAEMON_SCD)`
- `agent/call-daemon.c:wasm_connect_preopened_scdaemon()` — connects to scdaemon via pre-opened FD from `GNUPG_WASM_SCDAEMON_FD`

### C Code (libassuan — the Assuan IPC library)
- `PLAY/src/libassuan/src/assuan-handler.c:process_request()` — server-side command loop (used by both agent and scdaemon)
- `PLAY/src/libassuan/src/assuan-socket-connect.c:assuan_socket_connect_fd()` — client connects to server via FD
- `PLAY/src/libassuan/src/assuan-socket-connect.c:_assuan_connect_finalize()` — reads server greeting
- `PLAY/src/libassuan/src/client.c:assuan_transact()` — sends command, reads response
- `PLAY/src/libassuan/src/assuan-buffer.c:readline()` — reads from FD until newline
- `PLAY/src/libassuan/src/assuan-buffer.c:writen()` — writes all bytes to FD
- `PLAY/src/libassuan/src/assuan-buffer.c:_assuan_write_line()` — writes a line with newline
- `PLAY/src/libassuan/src/system.c:_assuan_read()` — low-level read, calls `__assuan_read` (POSIX `read()`) with pre/post syscall clamps
- `PLAY/src/libassuan/src/system.c:_assuan_write()` — low-level write
- `PLAY/src/libassuan/src/system-posix.c:__assuan_read()` — just `read(fd, buffer, size)`

### C Code (scdaemon side)
- `scd/command.c` — scdaemon Assuan command handlers (SERIALNO, LEARN, GETINFO, etc.)
- `scd/app.c:select_application()` — opens card reader, connects to smartcard
- `scd/ccid-driver.c` — CCID USB driver (uses libusb)

## Observed Behavior from Logs

### What works
1. scdaemon starts, sends greeting `OK GNU Privacy Guard's Smartcard server ready, process 42` to scdaemonToAgent queue (58 bytes)
2. scdaemon enters `process_request` loop, blocks on stdin waiting for commands
3. gpg-agent starts, sends greeting `OK Pleased to meet you, process 42` to agentToGpg queue
4. gpg-agent enters `process_request` loop, blocks on stdin (gpgToAgent queue)
5. gpg connects to agent, reads greeting successfully
6. gpg sends RESET → agent processes → OK
7. gpg sends GETINFO version → agent processes → D 2.5.17 / OK
8. gpg sends OPTION allow-pinentry-notify → OK
9. gpg sends OPTION agent-awareness=2.1.0 → OK
10. gpg sends OPTION pinentry-mode=loopback → OK

### Where it hangs
11. gpg sends `SCD GETINFO version\n` to agent bridge (run.agent.tx calls 11-12)
12. gpg blocks on `run.agent.rx.enter` call 9/12, waiting for agent response
13. **Agent never responds** — 60s timeout fires

### What's missing
- No C-side `[wasm-trace]` logs from the agent after `SCD GETINFO version` is written
- No `dispatch_command` log for `SCD`
- No `cmd_scd`, `agent_card_scd`, `daemon_start`, `assuan_socket_connect_fd` logs
- No `_assuan_read`, `readline`, `writen`, `assuan_transact` logs from the agent

### Hypothesis
The agent's C code is stuck in `process_request` → `_assuan_read_line` → `readline` → `readfnc` (which is `_assuan_simple_read` → `read(fd=0, ...)` → Emscripten FS stdin callback → `queuePopByte(gpgToAgent, shouldBlock=true)` → `Atomics.wait`).

The agent's stdin callback blocks via `Atomics.wait` on the gpgToAgent queue. When gpg writes `SCD GETINFO version\n`, the bytes go into the SharedArrayBuffer and `Atomics.notify` is called. The agent's `Atomics.wait` should wake up (10ms timeout anyway). But somehow the agent never sees the data.

**Possible root causes to investigate:**
1. The agent's thread is stuck in a way that prevents the `Atomics.wait` loop from re-checking (e.g., Asyncify unwinding issue)
2. The `queuePopByte` is reading from a different SharedArrayBuffer than what gpg is writing to
3. The agent's `process_request` loop completed but the next iteration hasn't started yet (timing issue with npth/Asyncify)
4. The `_assuan_pre_syscall` / `_assuan_post_syscall` (npth clamp) is interfering with the blocking read

## Debug Logging Added

### Iteration 1 (JS-side only — already active)
- `gpg-browser-worker.js`: Every agent bridge read/write logs entry, data, ASCII content
- `gpg-agent-server-worker.js`: scd bridge device read/write logs entry with queue state, first byte result, wait time
- `gpg-scdaemon-server-worker.js`: stdin logs every call (first 64 + every 64th), every byte for first 128 reads/writes

### Iteration 2 (C-side — just rebuilt, awaiting test)
- `assuan-buffer.c` `readline()`: logs enter/exit with fd, iter count, each readfnc call and return
- `assuan-buffer.c` `writen()`: logs enter/exit with fd and byte count
- `assuan-buffer.c` `_assuan_write_line()`: logs line being written with fd
- `system.c` `_assuan_read()`: logs enter, pre_syscall, read call, return value with errno
- `system.c` `_assuan_write()`: logs enter and return value with errno
- `assuan-socket-connect.c` `assuan_socket_connect_fd()`: logs enter/exit with fd and flags
- `assuan-socket-connect.c` `_assuan_connect_finalize()`: logs greeting read attempt and result
- `client.c` `assuan_transact()`: logs command, write_line result, read_from_server result
- `assuan-handler.c` `dispatch_command()`: logs command being dispatched with fd info
- `call-daemon.c`: more granular logging around `wasm_connect_preopened_scdaemon`
- `call-scd.c`: logs `assuan_transact` call with context pointer

## Build Notes

### Two separate build prefixes
- **Node**: `PLAY/wasm-prefix/` built by `build-gnupg.sh`
- **Browser**: `PLAY/wasm-prefix-browser/` built by `build-gnupg-browser.sh`

### Rebuilding libassuan (required for C-side changes)
`build-gnupg.sh --force` only rebuilds gnupg, NOT dependencies like libassuan.

To rebuild libassuan after editing `PLAY/src/libassuan/src/*.c`:
```bash
# Source emscripten env
source scripts/wasm/env.sh

# Rebuild for node prefix
emmake make -C PLAY/wasm-build/libassuan/src
emmake make -C PLAY/wasm-build/libassuan install

# Rebuild for browser prefix
emmake make -C PLAY/wasm-build-browser/libassuan/src
emmake make -C PLAY/wasm-build-browser/libassuan install

# Then rebuild gnupg to relink
bash scripts/wasm/build-gnupg.sh --force
bash scripts/wasm/build-gnupg-browser.sh --force

# Then rebuild IWA bundle
bash scripts/wasm/build-iwa.sh
```

### Verifying traces are in the wasm binary
```bash
strings PLAY/wasm-prefix-browser/bin/gpg-agent.wasm | grep "wasm-trace.*_assuan_read"
```

### Running the test
```bash
pkill -f "chromium.*chromium-iwa-test" || true
rm -rf /tmp/chromium-iwa-test
chromium \
  --user-data-dir=/tmp/chromium-iwa-test \
  --no-first-run \
  --enable-features=IsolatedWebApps,IsolatedWebAppDevMode \
  --install-isolated-web-app-from-file=/home/niko/Desktop/Projects/gnupg-w32/gnupg/PLAY/iwa/gnupg-wasm-demo.swbn
```
Then open: `isolated-app://r2m3p4dvre3uofxuq3qdhj3mhv5rb5nmtandzekfbdajgviaorjaaaic/scripts/wasm/demo/demo.html`

## Next Steps
1. **Get new log output** — the C-side libassuan traces should now appear, showing exactly where in the agent's Assuan I/O the hang occurs
2. **Determine if the agent ever receives the SCD command** — look for `dispatch_command: line='SCD'` in agent stderr
3. **If agent never receives it** — the problem is in the stdin read mechanism (Atomics.wait / Asyncify interaction)
4. **If agent receives but hangs in daemon_start** — the problem is in the scd bridge device read (reading scdaemon greeting)
5. **If agent connects to scdaemon but hangs in assuan_transact** — the problem is in the scd bridge device write/read for the forwarded command
