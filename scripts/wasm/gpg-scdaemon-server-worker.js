/* eslint-env worker */

let started = false;
let finished = false;
let bridge = null;
let stderrBuffer = [];

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

function postDebug(step, data) {
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
  throw new Error('callMain is not available for scdaemon worker');
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

function finish(exitCode, errorMessage) {
  if (finished) {
    return;
  }
  finished = true;

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

  const scdaemonScriptUrl = typeof message.scdaemonScriptUrl === 'string'
    ? message.scdaemonScriptUrl
    : '';
  const scdaemonWasmUrl = typeof message.scdaemonWasmUrl === 'string'
    ? message.scdaemonWasmUrl
    : '';
  const homedir = normalizePath(message.homedir, '/gnupg');

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
    '--multi-server',
    '--homedir', homedir,
  ];

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

        const envObj = self.ENV || (self.Module && self.Module.ENV);
        if (envObj) {
          envObj.GNUPG_WASM_TRACE = '1';
        }

        ensureDirectory(FS, homedir);
        try {
          FS.chmod(homedir, 0o700);
        } catch {
          /* Best effort only. */
        }

        FS.init(
          () => {
            bridgeMetrics.stdinReadCalls += 1;
            const value = queuePopByte(bridge.agentToScdaemon, false);
            if (value !== null && value !== undefined) {
              bridgeMetrics.stdinRead += 1;
              if (bridgeMetrics.stdinPreview.length < 32) {
                bridgeMetrics.stdinPreview.push(Number(value) & 0xff);
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
