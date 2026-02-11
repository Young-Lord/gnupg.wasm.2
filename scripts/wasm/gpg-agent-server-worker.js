/* eslint-env worker */

let started = false;
let finished = false;
let activeFS = null;
let activeHomedir = '/gnupg';
let persistRoots = [];
let bridge = null;
let scdaemonBridge = null;
let stderrBuffer = [];
let heartbeatId = null;
const bridgeMetrics = {
  stdinReadCalls: 0,
  stdinRead: 0,
  stdoutWriteCalls: 0,
  stdoutWrite: 0,
  stderrWrite: 0,
  stdinPreview: [],
  stdoutPreview: [],
  stderrPreview: [],
};
const SUPPRESSED_DEBUG_STEPS = new Set([
  'bridge.stdin.call',
  'bridge.stdin.byte',
  'bridge.stdout.byte',
]);

function postDebug(step, data) {
  if (SUPPRESSED_DEBUG_STEPS.has(step)) {
    return;
  }
  postMessage({
    type: 'debug',
    step,
    data: data && typeof data === 'object' ? data : { value: data },
  });
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizePath(pathValue, fallback) {
  let value = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!value) {
    value = fallback;
  }
  if (!value.startsWith('/')) {
    value = `/${value}`;
  }
  if (value.length > 1 && value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  return value.replace(/\/{2,}/g, '/');
}

function normalizePersistRoots(value, fallback) {
  const roots = [];
  const seen = new Set();

  if (Array.isArray(value)) {
    for (const raw of value) {
      if (typeof raw !== 'string') {
        continue;
      }
      const path = normalizePath(raw, '/');
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      roots.push(path);
    }
  }

  if (!roots.length && Array.isArray(fallback)) {
    for (const raw of fallback) {
      if (typeof raw !== 'string') {
        continue;
      }
      const path = normalizePath(raw, '/');
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      roots.push(path);
    }
  }

  return roots;
}

function parentDirectory(pathValue) {
  const idx = pathValue.lastIndexOf('/');
  if (idx <= 0) {
    return '/';
  }
  return pathValue.slice(0, idx);
}

function ensureDirectory(FS, dirPath) {
  if (!dirPath || dirPath === '/') {
    return;
  }
  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch {
      if (!FS.analyzePath(current).exists) {
        throw new Error(`unable to create directory: ${current}`);
      }
    }
  }
}

function normalizeMode(mode, fallback) {
  if (Number.isFinite(mode)) {
    return Number(mode) & 0o777;
  }
  return fallback;
}

function encodeBase64(bytes) {
  let binary = '';
  const chunkSize = 0x4000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let part = '';
    for (let j = 0; j < chunk.length; j += 1) {
      part += String.fromCharCode(chunk[j]);
    }
    binary += part;
  }

  return btoa(binary);
}

function decodeBase64(base64Text) {
  if (!base64Text) {
    return new Uint8Array();
  }
  const binary = atob(base64Text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function restoreFsState(FS, state) {
  if (!state || typeof state !== 'object') {
    return;
  }

  const dirs = Array.isArray(state.dirs) ? state.dirs.slice() : [];
  dirs.sort((a, b) => String(a.path || '').length - String(b.path || '').length);

  for (const entry of dirs) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }
    const path = normalizePath(entry.path, '/');
    ensureDirectory(FS, path);
    try {
      FS.chmod(path, normalizeMode(entry.mode, 0o700));
    } catch {
      /* Best effort only. */
    }
  }

  const files = Array.isArray(state.files) ? state.files.slice() : [];
  files.sort((a, b) => String(a.path || '').length - String(b.path || '').length);

  for (const entry of files) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }
    const path = normalizePath(entry.path, '/');
    ensureDirectory(FS, parentDirectory(path));
    const bytes = decodeBase64(typeof entry.data === 'string' ? entry.data : '');
    FS.writeFile(path, bytes);
    try {
      FS.chmod(path, normalizeMode(entry.mode, 0o600));
    } catch {
      /* Best effort only. */
    }
  }
}

function captureFsState(FS, roots) {
  if (!FS || !roots.length) {
    return null;
  }

  const dirs = [];
  const files = [];
  const seen = new Set();

  const walk = (path) => {
    if (seen.has(path)) {
      return;
    }
    seen.add(path);

    const stat = FS.stat(path);
    if (FS.isDir(stat.mode)) {
      dirs.push({
        path,
        mode: normalizeMode(stat.mode, 0o700),
      });
      const names = FS.readdir(path);
      for (const name of names) {
        if (name === '.' || name === '..') {
          continue;
        }
        const child = path === '/' ? `/${name}` : `${path}/${name}`;
        walk(child);
      }
      return;
    }

    if (FS.isFile(stat.mode)) {
      const bytes = FS.readFile(path, { encoding: 'binary' });
      files.push({
        path,
        mode: normalizeMode(stat.mode, 0o600),
        data: encodeBase64(bytes),
      });
    }
  };

  for (const rootRaw of roots) {
    const root = normalizePath(rootRaw, '/');
    const info = FS.analyzePath(root);
    if (!info.exists) {
      continue;
    }
    walk(root);
  }

  dirs.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 1,
    roots: roots.slice(),
    dirs,
    files,
  };
}

function createSharedQueue(desc) {
  if (!desc || !desc.meta || !desc.data) {
    throw new Error('invalid shared queue descriptor');
  }
  return {
    ctrl: new Int32Array(desc.meta),
    data: new Uint8Array(desc.data),
  };
}

function createSharedQueueDescriptor(size = 262144) {
  const normalizedSize = Number.isFinite(size) ? Math.max(1024, Number(size) | 0) : 262144;
  return {
    meta: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
    data: new SharedArrayBuffer(normalizedSize),
  };
}

function queueNotify(queue) {
  const { ctrl } = queue;
  Atomics.add(ctrl, 3, 1);
  Atomics.notify(ctrl, 3);
}

function queuePushByte(queue, byteValue, shouldBlock = true) {
  const { ctrl, data } = queue;
  const size = data.length;
  const value = Number(byteValue) & 0xff;

  while (true) {
    const head = Atomics.load(ctrl, 0);
    const tail = Atomics.load(ctrl, 1);
    const next = (head + 1) % size;
    if (next !== tail) {
      data[head] = value;
      Atomics.store(ctrl, 0, next);
      queueNotify(queue);
      return true;
    }
    if (Atomics.load(ctrl, 2) !== 0) {
      return false;
    }

    if (!shouldBlock) {
      return false;
    }

    const stamp = Atomics.load(ctrl, 3);
    Atomics.wait(ctrl, 3, stamp, 10);
  }
}

function queuePopByte(queue, shouldBlock = false) {
  const { ctrl, data } = queue;
  const size = data.length;

  while (true) {
    const head = Atomics.load(ctrl, 0);
    const tail = Atomics.load(ctrl, 1);

    if (tail !== head) {
      const value = data[tail];
      const next = (tail + 1) % size;
      Atomics.store(ctrl, 1, next);
      queueNotify(queue);
      return value;
    }

    if (Atomics.load(ctrl, 2) !== 0) {
      return null;
    }

    if (!shouldBlock) {
      return undefined;
    }

    const stamp = Atomics.load(ctrl, 3);
    Atomics.wait(ctrl, 3, stamp, 10);
  }
}

function queueClose(queue) {
  Atomics.store(queue.ctrl, 2, 1);
  queueNotify(queue);
}

function queueHasData(queue) {
  return Atomics.load(queue.ctrl, 0) !== Atomics.load(queue.ctrl, 1);
}

function summarizeQueue(queue) {
  const head = Atomics.load(queue.ctrl, 0);
  const tail = Atomics.load(queue.ctrl, 1);
  const closed = Atomics.load(queue.ctrl, 2) !== 0;
  const size = queue.data.length;
  const used = head >= tail ? head - tail : (size - tail) + head;
  return {
    head,
    tail,
    size,
    used,
    closed,
  };
}

function writeStderrByte(ch) {
  if (ch === null || ch === undefined) {
    return;
  }
  bridgeMetrics.stderrWrite += 1;
  if (bridgeMetrics.stderrPreview.length < 32) {
    bridgeMetrics.stderrPreview.push(Number(ch) & 0xff);
  }
  stderrBuffer.push(Number(ch) & 0xff);
  if (stderrBuffer.length > 4096) {
    stderrBuffer = stderrBuffer.slice(-2048);
  }
}

function callMainWith(args) {
  if (typeof self.callMain === 'function') {
    return self.callMain(args);
  }
  if (self.Module && typeof self.Module.callMain === 'function') {
    return self.Module.callMain(args);
  }
  throw new Error('callMain is not available for gpg-agent worker');
}

async function importLauncherScript(scriptUrl) {
  const useFetchBlobPath = !/\.m?js(?:[?#].*)?$/i.test(scriptUrl);

  if (!useFetchBlobPath) {
    importScripts(scriptUrl);
    return;
  }

  const response = await fetch(scriptUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`launcher fetch failed: ${response.status} ${response.statusText}`);
  }

  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    importScripts(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function stripJsSuffix(urlText) {
  return String(urlText || '').replace(/\.js(?=(?:[?#].*)?$)/i, '');
}

function finish(exitCode, errorMessage) {
  if (finished) {
    return;
  }
  finished = true;

  if (heartbeatId !== null) {
    clearInterval(heartbeatId);
    heartbeatId = null;
  }

  if (bridge) {
    queueClose(bridge.gpgToAgent);
    queueClose(bridge.agentToGpg);
  }
  if (scdaemonBridge) {
    void scdaemonBridge.shutdownAndWait(300).catch(() => null);
    scdaemonBridge = null;
  }

  const stderrText = new TextDecoder().decode(new Uint8Array(stderrBuffer));
  const fsState = captureFsState(activeFS, persistRoots);
  postDebug('finish', {
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    errorMessage: errorMessage ? String(errorMessage) : '',
    bridgeMetrics: { ...bridgeMetrics },
    gpgToAgent: bridge ? summarizeQueue(bridge.gpgToAgent) : null,
    agentToGpg: bridge ? summarizeQueue(bridge.agentToGpg) : null,
  });

  postMessage({
    type: 'result',
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    fsState,
    error: errorMessage ? String(errorMessage) : '',
    stderr: stderrText,
  });

  setTimeout(() => {
    self.close();
  }, 0);
}

async function handleStart(message) {
  if (started) {
    postMessage({ type: 'error', message: 'gpg-agent worker already started' });
    return;
  }
  started = true;

  const gpgAgentScriptUrl = typeof message.gpgAgentScriptUrl === 'string'
    ? message.gpgAgentScriptUrl
    : '';
  const gpgAgentWasmUrl = typeof message.gpgAgentWasmUrl === 'string'
    ? message.gpgAgentWasmUrl
    : '';
  const gpgScdaemonWorkerUrl = typeof message.gpgScdaemonWorkerUrl === 'string'
    ? message.gpgScdaemonWorkerUrl
    : new URL('./gpg-scdaemon-server-worker.js', self.location.href).toString();
  let gpgScdaemonScriptUrl = typeof message.gpgScdaemonScriptUrl === 'string'
    ? message.gpgScdaemonScriptUrl
    : '';
  let gpgScdaemonWasmUrl = typeof message.gpgScdaemonWasmUrl === 'string'
    ? message.gpgScdaemonWasmUrl
    : '';
  const homedir = normalizePath(message.homedir, '/gnupg');
  activeHomedir = homedir;
  const incomingFsState = message.fsState && typeof message.fsState === 'object'
    ? message.fsState
    : null;

  persistRoots = normalizePersistRoots(
    message.persistRoots,
    incomingFsState && Array.isArray(incomingFsState.roots)
      ? incomingFsState.roots
      : [homedir]
  );
  if (!persistRoots.includes(homedir)) {
    persistRoots.push(homedir);
  }

  if (!gpgAgentScriptUrl) {
    finish(2, 'missing gpgAgentScriptUrl');
    return;
  }

  if (!gpgScdaemonScriptUrl && gpgAgentScriptUrl) {
    gpgScdaemonScriptUrl = gpgAgentScriptUrl.replace(/gpg-agent(?:\.js)?(?=(?:[?#].*)?$)/, 'scdaemon.js');
  }
  if (!gpgScdaemonWasmUrl && gpgAgentWasmUrl) {
    gpgScdaemonWasmUrl = gpgAgentWasmUrl.replace(/gpg-agent\.wasm(?=(?:[?#].*)?$)/, 'scdaemon.wasm');
  }

  if (!message.bridge || typeof message.bridge !== 'object') {
    finish(2, 'missing shared-memory bridge');
    return;
  }

  bridge = {
    gpgToAgent: createSharedQueue(message.bridge.gpgToAgent),
    agentToGpg: createSharedQueue(message.bridge.agentToGpg),
  };

  heartbeatId = setInterval(() => {
    postDebug('heartbeat', {
      bridgeMetrics: { ...bridgeMetrics },
      gpgToAgent: summarizeQueue(bridge.gpgToAgent),
      agentToGpg: summarizeQueue(bridge.agentToGpg),
    });
  }, 2000);

  postDebug('start', {
    gpgAgentScriptUrl,
    gpgAgentWasmUrl,
    homedir,
    persistRoots,
    hasIncomingFsState: Boolean(incomingFsState),
  });

  const createScdaemonBridge = () => {
    const worker = new Worker(gpgScdaemonWorkerUrl);
    let daemonDone = false;
    let resolveResult;
    let rejectResult;
    const resultPromise = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const agentToScdaemonDesc = createSharedQueueDescriptor();
    const scdaemonToAgentDesc = createSharedQueueDescriptor();
    const agentToScdaemon = createSharedQueue(agentToScdaemonDesc);
    const scdaemonToAgent = createSharedQueue(scdaemonToAgentDesc);
    const readableHandlers = [];
    let readableWatcherId = null;
    let lastReadableState = false;
    let lastClosedState = false;

    const notifyReadableHandlers = (mask) => {
      while (readableHandlers.length > 0) {
        const handler = readableHandlers.shift();
        try {
          handler(mask);
        } catch {
          /* Ignore runtime poll callback errors. */
        }
      }
    };

    const ensureReadableWatcher = () => {
      if (readableWatcherId !== null) {
        return;
      }
      readableWatcherId = setInterval(() => {
        const hasData = queueHasData(scdaemonToAgent);
        const closed = Atomics.load(scdaemonToAgent.ctrl, 2) !== 0;
        const becameReadable = hasData && !lastReadableState;
        const becameClosed = closed && !lastClosedState;
        lastReadableState = hasData;
        lastClosedState = closed;
        if (becameReadable || becameClosed) {
          const POLLIN = 0x001;
          const POLLHUP = 0x010;
          let mask = 0;
          if (hasData) {
            mask |= POLLIN;
          }
          if (closed) {
            mask |= POLLHUP;
          }
          if (mask !== 0) {
            notifyReadableHandlers(mask);
          }
        }
      }, 10);
    };

    worker.addEventListener('message', (event) => {
      const messageData = event.data;
      if (!messageData || typeof messageData !== 'object') {
        return;
      }
      if (messageData.type === 'debug') {
        postDebug(`scdaemon.${messageData.step || 'unknown'}`, messageData.data || null);
        return;
      }
      if (messageData.type === 'ready') {
        resolveReady(true);
        return;
      }
      if (messageData.type === 'error') {
        postDebug('scdaemon.error', { message: String(messageData.message || 'unknown worker error') });
        return;
      }
      if (messageData.type === 'result') {
        daemonDone = true;
        resolveResult(messageData);
      }
    });

    worker.addEventListener('error', (event) => {
      const text = event && event.message ? event.message : 'scdaemon worker failed';
      rejectReady(new Error(text));
      rejectResult(new Error(text));
    });

    worker.postMessage({
      type: 'start',
      scdaemonScriptUrl: gpgScdaemonScriptUrl,
      scdaemonWasmUrl: gpgScdaemonWasmUrl,
      homedir,
      bridge: {
        agentToScdaemon: agentToScdaemonDesc,
        scdaemonToAgent: scdaemonToAgentDesc,
      },
    });

    return {
      readAvailableByte() {
        return queuePopByte(scdaemonToAgent, false);
      },
      hasReadableData() {
        return queueHasData(scdaemonToAgent);
      },
      isReadableClosed() {
        return Atomics.load(scdaemonToAgent.ctrl, 2) !== 0;
      },
      registerReadableHandler(callback) {
        if (typeof callback !== 'function') {
          return;
        }
        readableHandlers.push(callback);
        ensureReadableWatcher();
      },
      writeByte(ch) {
        if (ch === null || ch === undefined) {
          return;
        }
        queuePushByte(agentToScdaemon, ch, true);
      },
      async awaitReady(timeoutMs) {
        let timeoutId = null;
        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(false), timeoutMs);
        });
        try {
          const ready = await Promise.race([readyPromise, timeoutPromise]);
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          return Boolean(ready);
        } catch {
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          return false;
        }
      },
      async shutdownAndWait(timeoutMs) {
        if (!daemonDone) {
          for (const byteValue of [66, 89, 69, 10]) {
            queuePushByte(agentToScdaemon, byteValue, false);
          }
        }
        queueClose(agentToScdaemon);

        let timeoutId = null;
        const timeoutPromise = new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve(null), timeoutMs);
        });
        const result = await Promise.race([resultPromise, timeoutPromise]).catch(() => null);
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        if (readableWatcherId !== null) {
          clearInterval(readableWatcherId);
          readableWatcherId = null;
        }
        queueClose(scdaemonToAgent);
        worker.terminate();
        return result;
      },
    };
  };

  try {
    scdaemonBridge = createScdaemonBridge();
    const scdReady = await scdaemonBridge.awaitReady(12000);
    postDebug('scdaemon.ready', {
      scdReady,
      gpgScdaemonWorkerUrl,
      gpgScdaemonScriptUrl,
      gpgScdaemonWasmUrl,
    });
    if (!scdReady) {
      finish(2, 'scdaemon worker did not report ready within timeout');
      return;
    }
  } catch (error) {
    finish(2, `failed to create scdaemon bridge: ${formatError(error)}`);
    return;
  }

  const finalArgs = [
    '--server',
    '--homedir', homedir,
  ];

  self.Module = {
    arguments: finalArgs,
    noInitialRun: true,
    mainScriptUrlOrBlob: gpgAgentScriptUrl,
    locateFile: (fileName, scriptDirectory) => {
      if (gpgAgentWasmUrl && fileName.endsWith('.wasm')) {
        return gpgAgentWasmUrl;
      }
      return `${scriptDirectory}${fileName}`;
    },
    preRun: [
      () => {
        const FS = self.FS || (self.Module && self.Module.FS);
        if (!FS || typeof FS.init !== 'function') {
          throw new Error('FS is not initialized in gpg-agent worker');
        }
        activeFS = FS;

        const envObj = self.ENV || (self.Module && self.Module.ENV);
        if (envObj) {
          envObj.GNUPG_WASM_TRACE = '1';
        }

        FS.init(
          () => {
            bridgeMetrics.stdinReadCalls += 1;
            if (bridgeMetrics.stdinReadCalls <= 16 || (bridgeMetrics.stdinReadCalls % 64) === 0) {
              postDebug('bridge.stdin.call', {
                calls: bridgeMetrics.stdinReadCalls,
                queue: summarizeQueue(bridge.gpgToAgent),
              });
            }
            const value = queuePopByte(bridge.gpgToAgent, false);
            if (value !== null && value !== undefined) {
              bridgeMetrics.stdinRead += 1;
              if (bridgeMetrics.stdinPreview.length < 32) {
                bridgeMetrics.stdinPreview.push(Number(value) & 0xff);
              }
              if (bridgeMetrics.stdinRead <= 32) {
                postDebug('bridge.stdin.byte', {
                  index: bridgeMetrics.stdinRead,
                  value: Number(value) & 0xff,
                });
              }
              if ((bridgeMetrics.stdinRead % 256) === 0) {
                postDebug('bridge.stdin', { bytes: bridgeMetrics.stdinRead });
              }
            }
            return value;
          },
          (ch) => {
            if (ch === null || ch === undefined) {
              return;
            }
            bridgeMetrics.stdoutWriteCalls += 1;
            bridgeMetrics.stdoutWrite += 1;
             if (bridgeMetrics.stdoutPreview.length < 32) {
               bridgeMetrics.stdoutPreview.push(Number(ch) & 0xff);
             }
            if (bridgeMetrics.stdoutWrite <= 32) {
              postDebug('bridge.stdout.byte', {
                index: bridgeMetrics.stdoutWrite,
                value: Number(ch) & 0xff,
              });
            }
            if ((bridgeMetrics.stdoutWrite % 256) === 0) {
              postDebug('bridge.stdout', { bytes: bridgeMetrics.stdoutWrite });
            }
            queuePushByte(bridge.agentToGpg, ch, true);
          },
          (ch) => {
            writeStderrByte(ch);
          }
        );

        if (scdaemonBridge && envObj) {
          const devName = `gnupg-scd-bridge-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
          const devPath = `/dev/${devName}`;
          try {
            if (!FS.registerDevice || !FS.mkdev || !FS.makedev) {
              throw new Error('FS device registration APIs are unavailable');
            }

            const major = 64;
            const minor = ((Date.now() + 23) % 200) + Math.floor(Math.random() * 50);
            const dev = FS.makedev(major, minor);
            const POLLIN = 0x001;
            const POLLOUT = 0x004;
            const POLLHUP = 0x010;
            const errnoCodes = self.ERRNO_CODES || (self.Module && self.Module.ERRNO_CODES) || null;
            const EAGAIN = errnoCodes && Number.isFinite(errnoCodes.EAGAIN)
              ? Number(errnoCodes.EAGAIN)
              : 6;

            FS.registerDevice(dev, {
              read(stream, buffer, offset, length) {
                let count = 0;
                while (count < length) {
                  const byteValue = scdaemonBridge.readAvailableByte();
                  if (byteValue === undefined || byteValue === null) {
                    break;
                  }
                  buffer[offset + count] = byteValue;
                  count += 1;
                  if (!scdaemonBridge.hasReadableData()) {
                    break;
                  }
                }

                if (count === 0 && !scdaemonBridge.isReadableClosed()) {
                  throw new FS.ErrnoError(EAGAIN);
                }
                return count;
              },
              write(stream, buffer, offset, length) {
                let count = 0;
                while (count < length) {
                  scdaemonBridge.writeByte(buffer[offset + count]);
                  count += 1;
                }
                return count;
              },
              poll(stream, timeout, notifyCallback) {
                let mask = POLLOUT;
                if (scdaemonBridge.hasReadableData()) {
                  mask |= POLLIN;
                }
                if (scdaemonBridge.isReadableClosed()) {
                  mask |= POLLHUP;
                }
                if (mask === POLLOUT && typeof notifyCallback === 'function') {
                  scdaemonBridge.registerReadableHandler(notifyCallback);
                }
                return mask;
              },
            });

            FS.mkdev(devPath, 0o600, dev);
            const stream = FS.open(devPath, 'r+');
            envObj.GNUPG_WASM_SCDAEMON_FD = String(stream.fd);
            postDebug('prerun.scdaemon-fd', {
              devPath,
              fd: stream.fd,
            });
          } catch (error) {
            throw new Error(`failed to create scdaemon bridge fd: ${formatError(error)}`);
          }
        } else if (envObj && envObj.GNUPG_WASM_SCDAEMON_FD) {
          delete envObj.GNUPG_WASM_SCDAEMON_FD;
        }

        postDebug('prerun.fs-init', {
          persistRoots,
    hasIncomingFsState: Boolean(incomingFsState),
    hasScdaemonBridge: Boolean(scdaemonBridge),
  });

        if (incomingFsState) {
          restoreFsState(FS, incomingFsState);
        }

        for (const root of persistRoots) {
          ensureDirectory(FS, root);
        }
        ensureDirectory(FS, homedir);
        try {
          FS.chmod(homedir, 0o700);
        } catch {
          /* Best effort only. */
        }
      },
    ],
    onRuntimeInitialized: () => {
      postDebug('runtime-initialized', {});
      postMessage({ type: 'ready' });
      try {
        const rc = callMainWith(finalArgs.slice());
        finish(Number.isFinite(rc) ? rc : 0, 'callMain returned');
      } catch (error) {
        if (error && typeof error === 'object' && Number.isFinite(error.status)) {
          finish(Number(error.status), 'callMain exit status');
          return;
        }
        finish(1, formatError(error));
      }
    },
    onExit: (code) => {
      finish(code, 'onExit');
    },
    onAbort: (why) => {
      finish(1, `abort: ${formatError(why)}`);
    },
  };

  try {
    postDebug('import-launcher.start', { gpgAgentScriptUrl });
    await importLauncherScript(gpgAgentScriptUrl);
    postDebug('import-launcher.done', {});
  } catch (error) {
    const primaryError = formatError(error);
    const fallbackUrl = stripJsSuffix(gpgAgentScriptUrl);
    if (fallbackUrl && fallbackUrl !== gpgAgentScriptUrl) {
      try {
        postDebug('import-launcher.fallback.start', {
          from: gpgAgentScriptUrl,
          to: fallbackUrl,
          reason: primaryError,
        });
        await importLauncherScript(fallbackUrl);
        postDebug('import-launcher.fallback.done', {
          usedUrl: fallbackUrl,
        });
        return;
      } catch (fallbackError) {
        finish(1, `${primaryError}; fallback failed: ${formatError(fallbackError)}`);
        return;
      }
    }
    finish(1, primaryError);
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'start') {
    void handleStart(message).catch((error) => {
      finish(1, formatError(error));
    });
  }
});
