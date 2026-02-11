/* eslint-env worker */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let debugEnabled = false;
let traceCounter = 0;
let activeSession = null;

function postError(message) {
  postMessage({ type: 'error', message: String(message || 'unknown dirmngr worker error') });
}

function shortText(value, limit = 260) {
  const text = String(value || '').replace(/\s+/g, ' ');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function postDebug(step, data = null) {
  if (!debugEnabled) {
    return;
  }
  traceCounter += 1;
  postMessage({
    type: 'debug',
    step,
    data: {
      seq: traceCounter,
      ...(data && typeof data === 'object' ? data : { value: data }),
    },
  });
}

function normalizeKeyserver(input) {
  let value = String(input || '').trim();
  if (!value) {
    value = 'hkps://keys.openpgp.org';
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `hkps://${value}`;
  }
  if (value.startsWith('hkp://')) {
    value = `http://${value.slice('hkp://'.length)}`;
  }
  if (value.startsWith('hkps://')) {
    value = `https://${value.slice('hkps://'.length)}`;
  }
  if (value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  return value;
}

function decodePercentPlus(value) {
  if (!value) {
    return '';
  }
  const plusNormalized = String(value).replace(/\+/g, '%20');
  try {
    return decodeURIComponent(plusNormalized);
  } catch {
    return String(value);
  }
}

function splitTokens(raw) {
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw.trim().split(/\s+/);
}

function parseDelimitedArgs(raw) {
  const tokens = splitTokens(raw);
  const delimiter = tokens.indexOf('--');
  if (delimiter === -1) {
    return { options: tokens, values: [] };
  }
  return {
    options: tokens.slice(0, delimiter),
    values: tokens.slice(delimiter + 1),
  };
}

function normalizeLegacySearchTerm(raw) {
  const value = decodePercentPlus(raw).trim();
  if (!value) {
    return value;
  }
  if (/^0x[0-9a-f]+$/i.test(value)) {
    return value;
  }
  if (/^[0-9a-f]+$/i.test(value) && [16, 32, 40, 64].includes(value.length)) {
    return `0x${value}`;
  }
  return value;
}

function makeLookupUrl(base, op, search) {
  const root = normalizeKeyserver(base);
  const url = new URL('/pks/lookup', `${root}/`);
  url.searchParams.set('op', op);
  url.searchParams.set('options', 'mr');
  url.searchParams.set('search', search);
  return url.toString();
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

function assuanEscapeChunk(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b < 0x20 || b >= 0x7f || b === 0x0a || b === 0x0d || b === 0x25) {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

function createProtocol(bridge) {
  const writeLine = (line) => {
    const bytes = textEncoder.encode(`${line}\n`);
    for (const byte of bytes) {
      queuePushByte(bridge.dirmngrToGpg, byte, true);
    }
  };

  const sendDataBuffer = (buffer) => {
    const maxBytesPerChunk = 220;
    for (let i = 0; i < buffer.length; i += maxBytesPerChunk) {
      const chunk = buffer.subarray(i, i + maxBytesPerChunk);
      writeLine(`D ${assuanEscapeChunk(chunk)}`);
    }
    writeLine('END');
  };

  const sendDataText = (text) => {
    sendDataBuffer(textEncoder.encode(String(text || '')));
  };

  const sendStatus = (keyword, value = '') => {
    if (value) {
      writeLine(`S ${keyword} ${value}`);
    } else {
      writeLine(`S ${keyword}`);
    }
  };

  const sendOk = (suffix = '') => {
    if (suffix) {
      writeLine(`OK ${suffix}`);
    } else {
      writeLine('OK');
    }
  };

  const sendErr = (text = 'General error') => {
    const msg = String(text).replace(/\r?\n/g, ' ').trim();
    if (msg) {
      writeLine(`ERR 1 ${msg}`);
    } else {
      writeLine('ERR 1');
    }
  };

  return {
    writeLine,
    sendDataBuffer,
    sendDataText,
    sendStatus,
    sendOk,
    sendErr,
  };
}

async function fetchLookup(server, op, search) {
  const url = makeLookupUrl(server, op, normalizeLegacySearchTerm(search));
  postDebug('fetch.lookup.begin', {
    op,
    search: shortText(search, 120),
    url,
  });
  const response = await fetch(url, { redirect: 'follow' });
  postDebug('fetch.lookup.response', {
    op,
    status: response.status,
    statusText: response.statusText,
    url,
  });
  if (!response.ok) {
    let detail = '';
    try {
      const text = (await response.text()).trim();
      if (text) {
        detail = text.replace(/\s+/g, ' ').slice(0, 260);
      }
    } catch {
      detail = '';
    }
    const hint = response.status === 400
      ? ' (bad request: query may be invalid for this keyserver)'
      : '';
    postDebug('fetch.lookup.error', {
      op,
      status: response.status,
      statusText: response.statusText,
      detail,
      url,
    });
    throw new Error(`${op} failed: ${response.status} ${response.statusText}${hint}${detail ? `: ${detail}` : ''}`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  postDebug('fetch.lookup.done', {
    op,
    bytes: body.length,
    url,
  });
  return body;
}

async function fetchDirect(urlValue) {
  const url = decodePercentPlus(urlValue);
  postDebug('fetch.direct.begin', {
    url,
  });
  const response = await fetch(url, { redirect: 'follow' });
  postDebug('fetch.direct.response', {
    status: response.status,
    statusText: response.statusText,
    url,
  });
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  postDebug('fetch.direct.done', {
    bytes: body.length,
    url,
  });
  return {
    source: url,
    body,
  };
}

async function processCommand(line, state, proto) {
  const splitAt = line.indexOf(' ');
  const command = (splitAt === -1 ? line : line.slice(0, splitAt)).toUpperCase();
  const argText = splitAt === -1 ? '' : line.slice(splitAt + 1).trim();
  postDebug('assuan.command', {
    command,
    arg: shortText(argText, 160),
  });

  if (command === 'BYE') {
    proto.sendOk('closing connection');
    postDebug('assuan.bye', {});
    return { resetSession: true };
  }
  if (command === 'RESET' || command === 'OPTION') {
    proto.sendOk();
    return { resetSession: false };
  }
  if (command === 'GETINFO') {
    const key = argText.toLowerCase();
    if (key === 'version') {
      proto.sendDataText('2.5.17');
      proto.sendOk();
    } else if (key === 'pid') {
      proto.sendDataText('1');
      proto.sendOk();
    } else {
      proto.sendErr('Unknown GETINFO key');
    }
    return { resetSession: false };
  }
  if (command === 'KEYSERVER') {
    if (!argText) {
      proto.sendStatus('KEYSERVER', state.keyservers[0]);
      proto.sendOk();
      return { resetSession: false };
    }
    const tokens = splitTokens(argText);
    const clearIdx = tokens.indexOf('--clear');
    if (clearIdx !== -1) {
      tokens.splice(clearIdx, 1);
      state.keyservers = [];
    }
    for (const token of tokens) {
      state.keyservers.push(normalizeKeyserver(decodePercentPlus(token)));
    }
    if (!state.keyservers.length) {
      state.keyservers.push('https://keys.openpgp.org');
    }
    postDebug('keyserver.set', {
      keyservers: state.keyservers.slice(),
    });
    proto.sendOk();
    return { resetSession: false };
  }
  if (command === 'KS_SEARCH') {
    const { values } = parseDelimitedArgs(argText);
    if (!values.length) {
      proto.sendErr('KS_SEARCH requires a query');
      return { resetSession: false };
    }
    const source = state.keyservers[0];
    postDebug('ks.search', {
      source,
      query: shortText(values.join(' '), 140),
    });
    const body = await fetchLookup(source, 'index', values.join(' '));
    proto.sendStatus('SOURCE', source);
    proto.sendDataBuffer(body);
    proto.sendOk();
    return { resetSession: false };
  }
  if (command === 'KS_GET') {
    const { values } = parseDelimitedArgs(argText);
    if (!values.length) {
      proto.sendErr('KS_GET requires at least one pattern');
      return { resetSession: false };
    }
    const source = state.keyservers[0];
    postDebug('ks.get', {
      source,
      patterns: values.map((value) => shortText(value, 80)),
    });
    proto.sendStatus('SOURCE', source);
    const blocks = [];
    for (const pattern of values) {
      const body = await fetchLookup(source, 'get', pattern);
      blocks.push(body);
      if (body.length && body[body.length - 1] !== 0x0a) {
        blocks.push(textEncoder.encode('\n'));
      }
    }
    const total = blocks.reduce((sum, block) => sum + block.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const block of blocks) {
      out.set(block, offset);
      offset += block.length;
    }
    proto.sendDataBuffer(out);
    proto.sendOk();
    return { resetSession: false };
  }
  if (command === 'KS_FETCH') {
    const { values } = parseDelimitedArgs(argText);
    if (!values.length) {
      proto.sendErr('KS_FETCH requires a URL');
      return { resetSession: false };
    }
    const result = await fetchDirect(values.join(' '));
    postDebug('ks.fetch', {
      source: result.source,
      bytes: result.body.length,
    });
    proto.sendStatus('SOURCE', result.source);
    proto.sendDataBuffer(result.body);
    proto.sendOk();
    return { resetSession: false };
  }

  proto.sendErr(`Unsupported command: ${command}`);
  postDebug('assuan.unsupported', {
    command,
    arg: shortText(argText, 160),
  });
  return { resetSession: false };
}

async function runBridge(message) {
  debugEnabled = Boolean(message && message.debug === true);
  traceCounter = 0;
  const bridge = {
    gpgToDirmngr: createSharedQueue(message.bridge && message.bridge.gpgToDirmngr),
    dirmngrToGpg: createSharedQueue(message.bridge && message.bridge.dirmngrToGpg),
  };
  postDebug('bridge.start', {
    gpgToDirmngrSize: bridge.gpgToDirmngr.data.length,
    dirmngrToGpgSize: bridge.dirmngrToGpg.data.length,
  });
  const proto = createProtocol(bridge);
  const state = {
    keyservers: [normalizeKeyserver('hkps://keys.openpgp.org')],
  };

  const sendGreeting = () => {
    postDebug('assuan.greeting', {
      keyserver: state.keyservers[0],
    });
    proto.sendOk('Dirmngr fetch shim ready');
  };

  activeSession = {
    sendGreeting,
    state,
  };

  sendGreeting();
  postMessage({ type: 'ready' });

  let lineBytes = [];

  while (true) {
    const byteValue = queuePopByte(bridge.gpgToDirmngr, true);
    if (byteValue === null) {
      break;
    }
    if (byteValue === 13) {
      continue;
    }
    if (byteValue !== 10) {
      lineBytes.push(byteValue);
      if (lineBytes.length > 65536) {
        lineBytes = lineBytes.slice(-4096);
      }
      continue;
    }

    const line = textDecoder.decode(new Uint8Array(lineBytes)).trim();
    lineBytes = [];
    if (!line) {
      continue;
    }
    postDebug('assuan.rx-line', {
      line: shortText(line, 180),
    });

    try {
      const result = await processCommand(line, state, proto);
      if (result && result.resetSession) {
        postDebug('assuan.session-reset', {});
        sendGreeting();
      }
    } catch (error) {
      postDebug('assuan.command-error', {
        error: error instanceof Error ? error.message : String(error),
        line: shortText(line, 180),
      });
      proto.sendErr(error instanceof Error ? error.message : String(error));
    }
  }

  postDebug('bridge.stop', {});
  activeSession = null;
  queueClose(bridge.gpgToDirmngr);
  queueClose(bridge.dirmngrToGpg);
  postMessage({ type: 'result', exitCode: 0 });
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'session-reset') {
    if (activeSession && typeof activeSession.sendGreeting === 'function') {
      postDebug('assuan.session-reset.external', {
        reason: shortText(message.reason || 'external-reset', 80),
      });
      activeSession.sendGreeting();
    }
    return;
  }
  if (message.type === 'start') {
    void runBridge(message).catch((error) => {
      activeSession = null;
      postDebug('bridge.fatal', {
        error: error instanceof Error ? error.message : String(error),
      });
      postError(error instanceof Error ? error.message : String(error));
      postMessage({ type: 'result', exitCode: 1, error: error instanceof Error ? error.message : String(error) });
      self.close();
    });
  }
});
