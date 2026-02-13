/* eslint-env worker */

let started = false;
let finished = false;
let bridge = null;
let stderrBuffer = [];
let stderrLineBuffer = [];
let stderrLoggedLines = 0;
let debugEnabled = false;

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
const DEBUG_BUILD_TAG = '2026-02-13-log-v2';

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
    postDebug('worker.script-url-shim', { installed: true });
  } catch {
    postDebug('worker.script-url-shim', { installed: false });
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
  if (stderrBuffer.length > 4096) {
    stderrBuffer = stderrBuffer.slice(-2048);
  }

  if (value === 10 || value === 13) {
    if (stderrLineBuffer.length > 0) {
      const line = String.fromCharCode(...stderrLineBuffer).trim();
      stderrLineBuffer = [];
      if (line && stderrLoggedLines < 40) {
        stderrLoggedLines += 1;
        postDebug('stderr.line', { line });
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
  if (finished) {
    return;
  }
  finished = true;

  if (stderrLineBuffer.length > 0 && stderrLoggedLines < 40) {
    const tailLine = String.fromCharCode(...stderrLineBuffer).trim();
    stderrLineBuffer = [];
    if (tailLine) {
      stderrLoggedLines += 1;
      postDebug('stderr.line', { line: tailLine });
    }
  }

  if (bridge) {
    queueClose(bridge.agentToScdaemon);
    queueClose(bridge.scdaemonToAgent);
  }

  const stderrText = new TextDecoder().decode(new Uint8Array(stderrBuffer));
  postDebug('finish', {
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    errorMessage: errorMessage ? String(errorMessage) : '',
    bridgeMetrics: { ...bridgeMetrics },
    agentToScdaemon: bridge ? summarizeQueue(bridge.agentToScdaemon) : null,
    scdaemonToAgent: bridge ? summarizeQueue(bridge.scdaemonToAgent) : null,
  });

  postMessage({
    type: 'result',
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    error: errorMessage ? String(errorMessage) : '',
    stderr: stderrText,
  });

  setTimeout(() => {
    self.close();
  }, 0);
}

async function handleStart(message) {
  if (started) {
    postMessage({ type: 'error', message: 'scdaemon worker already started' });
    return;
  }
  started = true;
  debugEnabled = Boolean(message && message.debug === true);

  const scdaemonScriptUrl = typeof message.scdaemonScriptUrl === 'string'
    ? message.scdaemonScriptUrl
    : '';
  const scdaemonWasmUrl = typeof message.scdaemonWasmUrl === 'string'
    ? message.scdaemonWasmUrl
    : '';
  const homedir = normalizePath(message.homedir, '/gnupg');
  const usbAuthorizedDevices = normalizeUsbAuthorizedDevices(message.usbAuthorizedDevices);

  self.__gnupgAuthorizedUsbDevices = usbAuthorizedDevices;
  postDebug('usb.authorized-devices', {
    buildTag: DEBUG_BUILD_TAG,
    count: usbAuthorizedDevices.length,
  });

  if (!scdaemonScriptUrl) {
    finish(2, 'missing scdaemonScriptUrl');
    return;
  }
  if (!message.bridge || typeof message.bridge !== 'object') {
    finish(2, 'missing shared-memory bridge');
    return;
  }

  bridge = {
    agentToScdaemon: createSharedQueue(message.bridge.agentToScdaemon),
    scdaemonToAgent: createSharedQueue(message.bridge.scdaemonToAgent),
  };

  const finalArgs = [
    '--server',
    '--verbose',
    '--homedir', homedir,
  ];

  installWorkerScriptUrlShim();

  self.Module = {
    arguments: finalArgs,
    noInitialRun: true,
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

        const rxTracer = createLineTracer('rx');
        const txTracer = createLineTracer('tx');

        FS.init(
          () => {
            bridgeMetrics.stdinReadCalls += 1;
            const waitStartedAt = Date.now();
            const value = queuePopByte(bridge.agentToScdaemon, true);
            const waitMs = Date.now() - waitStartedAt;
            if (waitMs >= 400) {
              postDebug('wait', {
                ms: waitMs,
                calls: bridgeMetrics.stdinReadCalls,
                rxBytes: bridgeMetrics.stdinRead,
                txBytes: bridgeMetrics.stdoutWrite,
              });
            }
            if (value !== null && value !== undefined) {
              bridgeMetrics.stdinRead += 1;
              rxTracer.push(value);
              if (bridgeMetrics.stdinPreview.length < 32) {
                bridgeMetrics.stdinPreview.push(Number(value) & 0xff);
              }
              if ((bridgeMetrics.stdinRead % 256) === 0) {
                postDebug('rx.total', {
                  bytes: bridgeMetrics.stdinRead,
                  calls: bridgeMetrics.stdinReadCalls,
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
            txTracer.push(ch);
            if (bridgeMetrics.stdoutPreview.length < 32) {
              bridgeMetrics.stdoutPreview.push(Number(ch) & 0xff);
            }
            if ((bridgeMetrics.stdoutWrite % 256) === 0) {
              postDebug('tx.total', {
                bytes: bridgeMetrics.stdoutWrite,
                calls: bridgeMetrics.stdoutWriteCalls,
              });
            }
            queuePushByte(bridge.scdaemonToAgent, ch, true);
          },
          (ch) => {
            writeStderrByte(ch);
          }
        );
      },
    ],
    onRuntimeInitialized: () => {
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
    await importLauncherScript(scdaemonScriptUrl);
  } catch (error) {
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
