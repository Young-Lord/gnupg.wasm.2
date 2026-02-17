/* eslint-env worker */

let started = false;
let finished = false;
let bridge = null;
let stderrBuffer = [];
let stderrLineBuffer = [];
let stderrLoggedLines = 0;
let debugEnabled = false;
let heartbeatId = null;
let restoreConsoleFilter = () => {};

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

let workerUrlPolicy = undefined;
let workerScriptUrlShimInstalled = false;
const DEBUG_BUILD_TAG = '2026-02-15-console-trace-v9';

// Global error handlers — catch anything that kills the worker silently
self.onerror = (message, source, lineno, colno, error) => {
  try {
    logScdTrace('[scd-onerror]', message, source, lineno, colno, error);
    postDebug('global.onerror', {
      message: String(message || ''),
      source: String(source || '').slice(-80),
      lineno,
      colno,
      error: error ? formatError(error) : '',
    });
    finish(1, `global error: ${message}`);
  } catch { /* last resort */ }
};

function formatUnhandledReason(reason) {
  if (!reason) {
    return 'unknown';
  }
  if (typeof reason === 'string') {
    return reason;
  }
  if (reason && typeof reason === 'object') {
    const name = typeof reason.name === 'string' ? reason.name : '';
    const message = typeof reason.message === 'string'
      ? reason.message
      : formatError(reason);
    return [name, message].filter(Boolean).join(' ');
  }
  return String(reason);
}

function isFatalWebUsbRejection(reason) {
  const text = formatUnhandledReason(reason).toLowerCase();
  if (!text) {
    return false;
  }
  if (text.includes("failed to execute 'claiminterface'")) {
    return true;
  }
  if (text.includes("failed to execute 'selectalternateinterface'")) {
    return true;
  }
  if (text.includes('protected interface') || text.includes('protected class')) {
    return true;
  }
  if (text.includes('webusb') && (text.includes('securityerror') || text.includes('invalidstateerror'))) {
    return true;
  }
  return false;
}

self.onunhandledrejection = (event) => {
  try {
    const reason = event && event.reason;
    const reasonText = formatUnhandledReason(reason);
    logScdTrace('[scd-unhandledrejection]', reason);
    postDebug('global.unhandledrejection', {
      reason: reasonText,
    });
    if (started && !finished && isFatalWebUsbRejection(reason)) {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      finish(2, `webusb rejection: ${reasonText}`);
    }
  } catch { /* last resort */ }
};

function ensureDefaultWorkerScriptPolicy() {
  if (!self.trustedTypes || typeof self.trustedTypes.createPolicy !== 'function') {
    return;
  }
  if (self.trustedTypes.defaultPolicy
      && typeof self.trustedTypes.defaultPolicy.createScriptURL === 'function') {
    return;
  }
  try {
    self.trustedTypes.createPolicy('default', {
      createScript(value) {
        return String(value);
      },
      createScriptURL(value) {
        return String(value);
      },
    });
  } catch {
    /* Ignore default policy creation failures. */
  }
}

function getWorkerUrlPolicy() {
  if (workerUrlPolicy !== undefined) {
    return workerUrlPolicy;
  }
  if (!self.trustedTypes || typeof self.trustedTypes.createPolicy !== 'function') {
    workerUrlPolicy = null;
    return workerUrlPolicy;
  }

  ensureDefaultWorkerScriptPolicy();

  const policyNames = [
    'gnupg-wasm-worker-url',
    'gnupg-wasm',
  ];

  for (const name of policyNames) {
    try {
      workerUrlPolicy = self.trustedTypes.createPolicy(name, {
        createScriptURL(value) {
          return String(value);
        },
      });
      return workerUrlPolicy;
    } catch {
      /* Ignore policy creation failures and try next candidate. */
    }
  }

  if (self.trustedTypes.defaultPolicy
      && typeof self.trustedTypes.defaultPolicy.createScriptURL === 'function') {
    workerUrlPolicy = self.trustedTypes.defaultPolicy;
    return workerUrlPolicy;
  }

  workerUrlPolicy = null;
  return workerUrlPolicy;
}

function installWorkerScriptUrlShim() {
  if (workerScriptUrlShimInstalled) {
    return;
  }
  if (typeof self.Worker !== 'function') {
    return;
  }

  const NativeWorker = self.Worker;
  const WorkerWrapper = function WrappedWorker(scriptURL, options) {
    return new NativeWorker(asWorkerScriptUrl(scriptURL), options);
  };

  try {
    Object.setPrototypeOf(WorkerWrapper, NativeWorker);
  } catch {
    /* Best effort only. */
  }
  WorkerWrapper.prototype = NativeWorker.prototype;

  try {
    self.Worker = WorkerWrapper;
    workerScriptUrlShimInstalled = true;
  } catch {
  }
}

function asWorkerScriptUrl(value) {
  const url = String(value);
  const policy = getWorkerUrlPolicy();
  if (!policy || typeof policy.createScriptURL !== 'function') {
    return url;
  }
  try {
    return policy.createScriptURL(url);
  } catch {
    return url;
  }
}

function postDebug(step, data) {
  if (!debugEnabled) {
    return;
  }
  postMessage({
    type: 'debug',
    step,
    data: data && typeof data === 'object' ? data : { value: data },
  });
}

function logScdTrace(...parts) {
  if (!debugEnabled) {
    return;
  }
  if (typeof console === 'object' && console && typeof console.error === 'function') {
    console.error(...parts);
  }
}

function normalizeWebUsbSupportHint(value) {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return null;
}

function installConsoleNoiseFilter() {
  if (typeof console !== 'object' || !console || typeof console.error !== 'function') {
    return () => {};
  }

  const originalError = console.error.bind(console);
  let finishRequested = false;
  console.error = (...parts) => {
    const text = parts.map((part) => String(part ?? '')).join(' ');
    if (!finishRequested && started && !finished && isFatalWebUsbRejection(text)) {
      finishRequested = true;
      const detail = text.length > 220 ? `${text.slice(0, 220)}...` : text;
      setTimeout(() => {
        finish(2, `webusb rejection: ${detail}`);
      }, 0);
      return;
    }
    if (!debugEnabled && (text.includes('[libusb-webusb-trace]') || text.includes('[libusb-webusb]'))) {
      return;
    }
    originalError(...parts);
  };

  return () => {
    try {
      console.error = originalError;
    } catch {
      /* Ignore restore failures. */
    }
  };
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function byteToDebugChar(byteValue) {
  const value = Number(byteValue) & 0xff;
  if (value >= 32 && value <= 126) {
    return String.fromCharCode(value);
  }
  if (value === 9) {
    return '\\t';
  }
  return '.';
}

function createLineTracer(step, options = {}) {
  const maxLines = Number.isFinite(options.maxLines)
    ? Math.max(1, Number(options.maxLines) | 0)
    : 120;
  const maxLen = Number.isFinite(options.maxLen)
    ? Math.max(16, Number(options.maxLen) | 0)
    : 220;
  const bytes = [];
  let lineCount = 0;

  return {
    push(byteValue) {
      if (byteValue === null || byteValue === undefined) {
        return;
      }
      const value = Number(byteValue) & 0xff;
      if (value === 13) {
        return;
      }
      if (value === 10) {
        if (bytes.length > 0 && lineCount < maxLines) {
          lineCount += 1;
          postDebug(step, {
            n: lineCount,
            line: bytes.map((item) => byteToDebugChar(item)).join(''),
          });
        }
        bytes.length = 0;
        return;
      }
      if (bytes.length < maxLen) {
        bytes.push(value);
      }
    },
  };
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

function normalizeUsbAuthorizedDevices(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const out = [];
  const seen = new Set();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const vendorId = Number(entry.vendorId);
    const productId = Number(entry.productId);
    if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) {
      continue;
    }

    const normalizedEntry = {
      vendorId: Math.max(0, Math.min(0xffff, vendorId | 0)),
      productId: Math.max(0, Math.min(0xffff, productId | 0)),
      serialNumber: typeof entry.serialNumber === 'string' ? entry.serialNumber : '',
    };

    const key = `${normalizedEntry.vendorId}:${normalizedEntry.productId}:${normalizedEntry.serialNumber}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalizedEntry);
  }

  return out;
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

function createSharedQueue(desc) {
  if (!desc || !desc.meta || !desc.data) {
    throw new Error('invalid shared queue descriptor');
  }
  return {
    ctrl: new Int32Array(desc.meta),
    data: new Uint8Array(desc.data),
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
  const value = Number(ch) & 0xff;
  bridgeMetrics.stderrWrite += 1;
  if (bridgeMetrics.stderrPreview.length < 32) {
    bridgeMetrics.stderrPreview.push(value);
  }
  stderrBuffer.push(value);
  if (stderrBuffer.length > 16384) {
    stderrBuffer = stderrBuffer.slice(-8192);
  }

  if (value === 10 || value === 13) {
    if (stderrLineBuffer.length > 0) {
      const line = String.fromCharCode(...stderrLineBuffer).trim();
      stderrLineBuffer = [];
      if (line) {
        logScdTrace('[scd-stderr]', line);
      }
      if (line && stderrLoggedLines < 120) {
        // Filter out noisy per-byte/per-call wasm-trace lines
        const isNoise = line.includes('[wasm-trace]') && (
          line.includes('_assuan_read:') ||
          line.includes('_assuan_write:') ||
          line.includes('writen:') ||
          line.includes('readline: calling readfnc') ||
          line.includes('readline: readfnc returned') ||
          line.includes('readline: enter') ||
          line.includes('readline: done')
        );
        if (!isNoise) {
          stderrLoggedLines += 1;
          postDebug('stderr.line', { line });
        }
      }
    }
    return;
  }

  stderrLineBuffer.push(value);
  if (stderrLineBuffer.length > 1024) {
    stderrLineBuffer = stderrLineBuffer.slice(-512);
  }
}

function callMainWith(args) {
  if (typeof self.callMain === 'function') {
    return self.callMain(args);
  }
  if (self.Module && typeof self.Module.callMain === 'function') {
    return self.Module.callMain(args);
  }
  throw new Error('callMain is not available for scdaemon worker');
}

function getAsyncifySnapshot() {
  const asyncify = self.Asyncify;
  if (!asyncify || typeof asyncify !== 'object') {
    return {
      present: false,
      pending: false,
      state: -1,
      stateName: 'absent',
      hasWhenDone: false,
    };
  }

  const state = Number(asyncify.state);
  const stateName = state === 0
    ? 'normal'
    : state === 1
      ? 'unwinding'
      : state === 2
        ? 'rewinding'
        : state === 3
          ? 'disabled'
          : `unknown(${state})`;

  return {
    present: true,
    pending: Boolean(asyncify.currData),
    state,
    stateName,
    hasWhenDone: typeof asyncify.whenDone === 'function',
  };
}

async function importLauncherScript(scriptUrl) {
  const useFetchBlobPath = !/\.m?js(?:[?#].*)?$/i.test(scriptUrl);

  if (!useFetchBlobPath) {
    importScripts(asWorkerScriptUrl(scriptUrl));
    return;
  }

  const response = await fetch(scriptUrl, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`launcher fetch failed: ${response.status} ${response.statusText}`);
  }

  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    importScripts(asWorkerScriptUrl(blobUrl));
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function finish(exitCode, errorMessage) {
  try {
    restoreConsoleFilter();
  } catch {
    /* Ignore restore failures. */
  }
  restoreConsoleFilter = () => {};

  logScdTrace('[scd-finish] exitCode=' + exitCode, 'error=' + (errorMessage || ''),
    'rx=' + bridgeMetrics.stdinRead, 'tx=' + bridgeMetrics.stdoutWrite,
    'calls=' + bridgeMetrics.stdinReadCalls,
    'stack=' + new Error().stack?.split('\n').slice(1, 4).join(' | '));
  if (finished) {
    logScdTrace('[scd-finish] ALREADY FINISHED, skipping');
    return;
  }
  finished = true;

  if (heartbeatId !== null) {
    clearInterval(heartbeatId);
    heartbeatId = null;
  }

  postDebug('finish', {
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    error: errorMessage ? String(errorMessage) : '',
    rx: bridgeMetrics.stdinRead,
    tx: bridgeMetrics.stdoutWrite,
    calls: bridgeMetrics.stdinReadCalls,
    a2s: bridge ? summarizeQueue(bridge.agentToScdaemon) : null,
    s2a: bridge ? summarizeQueue(bridge.scdaemonToAgent) : null,
    stack: new Error().stack?.split('\n').slice(0, 5).join(' | '),
  });

  // Flush any trailing stderr
  if (stderrLineBuffer.length > 0) {
    const tailLine = String.fromCharCode(...stderrLineBuffer).trim();
    stderrLineBuffer = [];
    if (tailLine && stderrLoggedLines < 80) {
      stderrLoggedLines += 1;
      postDebug('stderr.line', { line: tailLine });
    }
  }

  const stderrText = new TextDecoder().decode(new Uint8Array(stderrBuffer));

  // Post result BEFORE closing queues so agent sees our messages first
  postMessage({
    type: 'result',
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    error: errorMessage ? String(errorMessage) : '',
    stderr: stderrText,
  });

  if (bridge) {
    queueClose(bridge.agentToScdaemon);
    queueClose(bridge.scdaemonToAgent);
  }

  setTimeout(() => { self.close(); }, 50);
}

async function handleStart(message) {
  if (started) {
    postMessage({ type: 'error', message: 'scdaemon worker already started' });
    return;
  }
  started = true;
  debugEnabled = Boolean(message && message.debug === true);
  restoreConsoleFilter = installConsoleNoiseFilter();

  const scdaemonScriptUrl = typeof message.scdaemonScriptUrl === 'string'
    ? message.scdaemonScriptUrl
    : '';
  const scdaemonWasmUrl = typeof message.scdaemonWasmUrl === 'string'
    ? message.scdaemonWasmUrl
    : '';
  const homedir = normalizePath(message.homedir, '/gnupg');
  const webUsbSupported = normalizeWebUsbSupportHint(message.webUsbSupported);
  const usbAuthorizedDevices = normalizeUsbAuthorizedDevices(message.usbAuthorizedDevices);

  self.__gnupgAuthorizedUsbDevices = usbAuthorizedDevices;

  if (!scdaemonScriptUrl) {
    finish(2, 'missing scdaemonScriptUrl');
    return;
  }
  if (!message.bridge || typeof message.bridge !== 'object') {
    finish(2, 'missing shared-memory bridge');
    return;
  }

  if (webUsbSupported === false) {
    const reason = 'WebUSB is not available in this environment';
    postMessage({ type: 'error', message: reason });
    finish(2, reason);
    return;
  }

  bridge = {
    agentToScdaemon: createSharedQueue(message.bridge.agentToScdaemon),
    scdaemonToAgent: createSharedQueue(message.bridge.scdaemonToAgent),
  };

  const diagBuf = message.diagBuf
    ? new Int32Array(message.diagBuf)
    : null;

  const finalArgs = [
    '--server',
    '--verbose',
    '--homedir', homedir,
  ];

  installWorkerScriptUrlShim();

  // Heartbeat: post a message every 500ms to prove the worker is alive.
  // If the agent stops seeing heartbeats, the worker died silently.
  let heartbeatSeq = 0;
  heartbeatId = setInterval(() => {
    heartbeatSeq += 1;
    if (heartbeatSeq <= 40) { // stop after 20s to avoid noise
      postDebug('heartbeat', {
        seq: heartbeatSeq,
        rx: bridgeMetrics.stdinRead,
        tx: bridgeMetrics.stdoutWrite,
        calls: bridgeMetrics.stdinReadCalls,
        finished,
      });
    }
  }, 500);

  self.Module = {
    arguments: finalArgs,
    noInitialRun: true,
    noExitRuntime: true,
    mainScriptUrlOrBlob: scdaemonScriptUrl,
    locateFile: (fileName, scriptDirectory) => {
      if (scdaemonWasmUrl && fileName.endsWith('.wasm')) {
        return scdaemonWasmUrl;
      }
      return `${scriptDirectory}${fileName}`;
    },
    preRun: [
      () => {
        const FS = self.FS || (self.Module && self.Module.FS);
        if (!FS || typeof FS.init !== 'function') {
          throw new Error('FS is not initialized in scdaemon worker');
        }

        // Intercept Emscripten's quit_ function to call finish() before throwing.
        // quit_ is a top-level var in scdaemon.js that throws ExitStatus.
        // If main() returns, callMain → exitJS → _proc_exit → quit_ throws.
        // We need finish() to run before the throw so the agent gets our messages.
        if (typeof self.quit_ === 'undefined') {
          // quit_ might not be on self — it's a local var in the script scope.
          // Try to find it via _proc_exit patching instead.
          postDebug('quit_.notfound', {});
        }

        const envObj = (() => {
          const base = self.ENV && typeof self.ENV === 'object' ? self.ENV : {};
          self.ENV = base;
          if (self.Module && typeof self.Module === 'object') {
            self.Module.ENV = base;
          }
          if (debugEnabled) {
            base.GNUPG_WASM_TRACE = '1';
          } else if (Object.prototype.hasOwnProperty.call(base, 'GNUPG_WASM_TRACE')) {
            delete base.GNUPG_WASM_TRACE;
          }
          return base;
        })();

        ensureDirectory(FS, homedir);
        try {
          FS.chmod(homedir, 0o700);
        } catch {
          /* Best effort only. */
        }

        const rxTracer = { push() {} };
        const txTracer = { push() {} };
        const stdoutLineBuffer = [];

        // Track whether we have delivered at least one byte in the current
        // Emscripten read() call.  Emscripten calls input() in a tight loop
        // up to `length` times.  We must BLOCK on the very first byte (so the
        // C code sleeps until data arrives instead of getting EAGAIN/EOF), but
        // return undefined for subsequent bytes when the queue is empty so
        // that the read loop breaks and returns the partial line to the C
        // caller (assuan reads one line at a time).
        let stdinDeliveredInRead = 0;
        let stdinReadSeq = 0;

        FS.init(
          () => {
            bridgeMetrics.stdinReadCalls += 1;
            if (diagBuf) Atomics.add(diagBuf, 4, 1);

            const shouldBlock = stdinDeliveredInRead === 0;
            const callNum = bridgeMetrics.stdinReadCalls;

            // Logged only when debug mode is enabled.
            if (shouldBlock || callNum <= 5 || callNum % 50 === 0) {
              logScdTrace('[scd-stdin]', 'call=' + callNum,
                'delivered=' + stdinDeliveredInRead,
                'block=' + shouldBlock,
                'seq=' + stdinReadSeq,
                'a2s=' + JSON.stringify(summarizeQueue(bridge.agentToScdaemon)));
            }

            let value;
            try {
              value = queuePopByte(bridge.agentToScdaemon, shouldBlock);
            } catch (popErr) {
              logScdTrace('[scd-stdin] queuePopByte THREW:', popErr);
              throw popErr;
            }

            if (value !== null && value !== undefined) {
              stdinDeliveredInRead += 1;
              bridgeMetrics.stdinRead += 1;
              if (diagBuf) Atomics.add(diagBuf, 5, 1);
              rxTracer.push(value);
              // Log the byte on blocking reads (first byte of each read() call)
              if (shouldBlock) {
                logScdTrace('[scd-stdin]', 'GOT first byte=' + value,
                  '(' + String.fromCharCode(value > 31 && value < 127 ? value : 46) + ')',
                  'call=' + callNum, 'totalRx=' + bridgeMetrics.stdinRead);
              }
            } else {
              const wasNull = value === null;
              logScdTrace('[scd-stdin]', wasNull ? 'EOF(null)' : 'EMPTY(undef)',
                'call=' + callNum, 'delivered=' + stdinDeliveredInRead,
                'block=' + shouldBlock, 'seq=' + stdinReadSeq,
                'a2s=' + JSON.stringify(summarizeQueue(bridge.agentToScdaemon)));
              stdinDeliveredInRead = 0;
              stdinReadSeq += 1;
              // Only log EOF (queue closed) — this is the critical event
              if (wasNull) {
                postDebug('stdin.eof', {
                  n: bridgeMetrics.stdinReadCalls,
                  seq: stdinReadSeq,
                  rx: bridgeMetrics.stdinRead,
                  tx: bridgeMetrics.stdoutWrite,
                  a2s: summarizeQueue(bridge.agentToScdaemon),
                });
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
            if (diagBuf) { Atomics.add(diagBuf, 6, 1); Atomics.add(diagBuf, 7, 1); }
            txTracer.push(ch);
            queuePushByte(bridge.scdaemonToAgent, ch, true);

            const value = Number(ch) & 0xff;
            if (value === 13 || value === 10) {
              if (stdoutLineBuffer.length > 0) {
                const line = String.fromCharCode(...stdoutLineBuffer);
                stdoutLineBuffer.length = 0;
                logScdTrace('[scd-stdout]', line);
              }
            } else if (stdoutLineBuffer.length < 512) {
              stdoutLineBuffer.push(value >= 32 && value <= 126 ? value : 46);
            }
          },
          (ch) => {
            writeStderrByte(ch);
          }
        );
      },
    ],
    onRuntimeInitialized: () => {
      postMessage({ type: 'ready' });
      postDebug('runtime.ready', {
        hasCallMain: typeof self.callMain === 'function',
        hasModuleCallMain: Boolean(self.Module && typeof self.Module.callMain === 'function'),
        noExitRuntime: Boolean(self.Module && self.Module.noExitRuntime),
      });
      logScdTrace('[scd-callMain] BEFORE callMainWith', JSON.stringify(finalArgs));
      try {
        postDebug('callMain.enter', { args: finalArgs });
        const rc = callMainWith(finalArgs.slice());
        const asyncify = getAsyncifySnapshot();
        logScdTrace('[scd-callMain] AFTER callMainWith rc=' + rc,
          'rx=' + bridgeMetrics.stdinRead, 'tx=' + bridgeMetrics.stdoutWrite,
          'calls=' + bridgeMetrics.stdinReadCalls,
          'async=' + JSON.stringify(asyncify));

        if (asyncify.pending && asyncify.hasWhenDone && self.Asyncify) {
          logScdTrace('[scd-callMain] ASYNCIFY pending, waiting for whenDone()');
          postDebug('callMain.async.pending', {
            rc,
            asyncify,
            rx: bridgeMetrics.stdinRead,
            tx: bridgeMetrics.stdoutWrite,
            calls: bridgeMetrics.stdinReadCalls,
          });

          self.Asyncify.whenDone().then((finalRc) => {
            logScdTrace('[scd-callMain] ASYNCIFY done finalRc=' + finalRc,
              'rx=' + bridgeMetrics.stdinRead,
              'tx=' + bridgeMetrics.stdoutWrite,
              'calls=' + bridgeMetrics.stdinReadCalls);
            postDebug('callMain.async.done', {
              finalRc,
              rx: bridgeMetrics.stdinRead,
              tx: bridgeMetrics.stdoutWrite,
              calls: bridgeMetrics.stdinReadCalls,
              a2s: bridge ? summarizeQueue(bridge.agentToScdaemon) : null,
              s2a: bridge ? summarizeQueue(bridge.scdaemonToAgent) : null,
            });
            finish(Number.isFinite(finalRc) ? finalRc : 0, 'callMain async done');
          }).catch((asyncErr) => {
            logScdTrace('[scd-callMain] ASYNCIFY failed:', asyncErr);
            postDebug('callMain.async.error', {
              error: formatError(asyncErr),
              name: asyncErr && asyncErr.name ? String(asyncErr.name) : '',
              status: asyncErr && typeof asyncErr === 'object' ? asyncErr.status : undefined,
              rx: bridgeMetrics.stdinRead,
              tx: bridgeMetrics.stdoutWrite,
            });
            if (asyncErr && typeof asyncErr === 'object' && Number.isFinite(asyncErr.status)) {
              finish(Number(asyncErr.status), `Asyncify ExitStatus=${asyncErr.status}`);
              return;
            }
            finish(1, formatError(asyncErr));
          });
          return;
        }

        postDebug('callMain.exit', {
          rc,
          rx: bridgeMetrics.stdinRead,
          tx: bridgeMetrics.stdoutWrite,
          calls: bridgeMetrics.stdinReadCalls,
          a2s: bridge ? summarizeQueue(bridge.agentToScdaemon) : null,
          s2a: bridge ? summarizeQueue(bridge.scdaemonToAgent) : null,
        });
        finish(Number.isFinite(rc) ? rc : 0, 'callMain returned');
      } catch (error) {
        logScdTrace('[scd-callMain] CATCH error:', error,
          'name=' + (error && error.name),
          'status=' + (error && error.status),
          'isExitStatus=' + Boolean(error && error.name === 'ExitStatus'));
        postDebug('callMain.error', {
          error: formatError(error),
          name: error && error.name ? String(error.name) : '',
          status: error && typeof error === 'object' ? error.status : undefined,
          isExitStatus: Boolean(error && error.name === 'ExitStatus'),
          rx: bridgeMetrics.stdinRead,
          tx: bridgeMetrics.stdoutWrite,
          stack: error && error.stack ? error.stack.split('\n').slice(0, 6).join(' | ') : '',
        });
        if (error && typeof error === 'object' && Number.isFinite(error.status)) {
          finish(Number(error.status), `ExitStatus=${error.status}`);
          return;
        }
        finish(1, formatError(error));
      }
    },
    onExit: (code) => {
      postDebug('onExit', { code });
      finish(code, 'onExit');
    },
    onAbort: (why) => {
      postDebug('onAbort', { why: formatError(why) });
      finish(1, `abort: ${formatError(why)}`);
    },
  };

  try {
    postDebug('import.start', { url: scdaemonScriptUrl.slice(-60) });
    await importLauncherScript(scdaemonScriptUrl);
    postDebug('import.done', {
      hasCallMain: typeof self.callMain === 'function',
      finished,
    });
  } catch (error) {
    postDebug('import.error', { error: formatError(error) });
    finish(1, formatError(error));
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
