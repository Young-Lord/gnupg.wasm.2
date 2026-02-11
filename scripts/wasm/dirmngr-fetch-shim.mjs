#!/usr/bin/env node

import { createHash } from 'node:crypto';
import process from 'node:process';
import readline from 'node:readline';

const ZBASE32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';
const DEFAULT_VERSION = '2.5.17';
const DEBUG = process.env.GNUPG_WASM_DIRMNGR_DEBUG === '1';

function debugLog(message) {
  if (!DEBUG) {
    return;
  }
  process.stderr.write(`[dirmngr-shim] ${message}\n`);
}

function parseArgs(argv) {
  const args = {
    homedir: '',
    keyserver: process.env.GNUPG_WASM_KEYSERVER || 'hkps://keys.openpgp.org',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--homedir') {
      args.homedir = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--keyserver') {
      args.keyserver = argv[i + 1] || args.keyserver;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage: scripts/wasm/dirmngr-fetch-shim.mjs [options]',
          '',
          'Assuan-compatible dirmngr shim that serves KS_* commands via fetch API.',
          '',
          'Options:',
          '  --homedir PATH      Optional GNUPGHOME hint (not required).',
          '  --keyserver URI     Default keyserver URI (default: hkps://keys.openpgp.org).',
          '  --help              Show this help text.',
          '',
        ].join('\n')
      );
      process.exit(0);
    }
  }

  return args;
}

function writeLine(line) {
  process.stdout.write(`${line}\n`);
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

function sendDataBuffer(buffer) {
  const maxBytesPerChunk = 220;
  for (let i = 0; i < buffer.length; i += maxBytesPerChunk) {
    const chunk = buffer.subarray(i, i + maxBytesPerChunk);
    writeLine(`D ${assuanEscapeChunk(chunk)}`);
  }
  writeLine('END');
}

function sendDataText(text) {
  sendDataBuffer(Buffer.from(text, 'utf8'));
}

function sendStatus(keyword, value = '') {
  if (value) {
    writeLine(`S ${keyword} ${value}`);
  } else {
    writeLine(`S ${keyword}`);
  }
}

function sendOk(suffix = '') {
  if (suffix) {
    writeLine(`OK ${suffix}`);
  } else {
    writeLine('OK');
  }
}

function sendErr(text = 'General error') {
  const msg = text.replace(/\r?\n/g, ' ').trim();
  if (msg) {
    writeLine(`ERR 1 ${msg}`);
  } else {
    writeLine('ERR 1');
  }
}

function decodePercentPlus(value) {
  if (!value) {
    return '';
  }

  const plusNormalized = value.replace(/\+/g, '%20');
  try {
    return decodeURIComponent(plusNormalized);
  } catch {
    return value;
  }
}

function splitTokens(raw) {
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw.trim().split(/\s+/);
}

function normalizeKeyserver(input) {
  let value = (input || '').trim();
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

function makeLookupUrl(base, op, search) {
  const root = normalizeKeyserver(base);
  const url = new URL('/pks/lookup', `${root}/`);
  url.searchParams.set('op', op);
  url.searchParams.set('options', 'mr');
  url.searchParams.set('search', search);
  return url.toString();
}

async function fetchKeyMaterial(server, pattern) {
  const decoded = decodePercentPlus(pattern);
  const url = makeLookupUrl(server, 'get', decoded);
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    throw new Error(
      `fetch failed for ${url}: ${error instanceof Error ? (error.cause?.message || error.message) : String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`key fetch failed: ${response.status} ${response.statusText}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  return { source: normalizeKeyserver(server), body };
}

async function searchKeys(server, query) {
  const decoded = decodePercentPlus(query);
  const url = makeLookupUrl(server, 'index', decoded);
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    throw new Error(
      `fetch failed for ${url}: ${error instanceof Error ? (error.cause?.message || error.message) : String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`key search failed: ${response.status} ${response.statusText}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  return { source: normalizeKeyserver(server), body };
}

async function fetchDirect(urlValue) {
  const url = decodePercentPlus(urlValue);
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    throw new Error(
      `fetch failed for ${url}: ${error instanceof Error ? (error.cause?.message || error.message) : String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`URL fetch failed: ${response.status} ${response.statusText}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  return { source: url, body };
}

function zbase32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';

  for (let i = 0; i < buf.length; i += 1) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      const idx = (value >>> (bits - 5)) & 0x1f;
      out += ZBASE32_ALPHABET[idx];
      bits -= 5;
    }
  }

  if (bits > 0) {
    const idx = (value << (5 - bits)) & 0x1f;
    out += ZBASE32_ALPHABET[idx];
  }

  return out;
}

function wkdUrlsForMailbox(mailboxRaw) {
  const mailbox = decodePercentPlus(mailboxRaw).trim().toLowerCase();
  const at = mailbox.lastIndexOf('@');
  if (at <= 0 || at === mailbox.length - 1) {
    return [];
  }

  const local = mailbox.slice(0, at);
  const domain = mailbox.slice(at + 1);
  const hash = createHash('sha1').update(local, 'utf8').digest();
  const hu = zbase32Encode(hash);
  const localEsc = encodeURIComponent(local);

  return [
    `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hu}?l=${localEsc}`,
    `https://${domain}/.well-known/openpgpkey/hu/${hu}?l=${localEsc}`,
  ];
}

async function fetchWkd(mailboxRaw) {
  const urls = wkdUrlsForMailbox(mailboxRaw);
  if (!urls.length) {
    throw new Error('invalid mailbox for WKD lookup');
  }

  let lastError = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const body = Buffer.from(await response.arrayBuffer());
      return { source: url, body };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`WKD fetch failed: ${lastError ? lastError.message : 'no result'}`);
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

async function run() {
  const args = parseArgs(process.argv.slice(2));
  let keyservers = [normalizeKeyserver(args.keyserver)];

  debugLog(`start homedir=${args.homedir || '[none]'} keyserver=${keyservers[0]}`);
  writeLine(`OK Dirmngr fetch shim ready (home=${args.homedir || '[none]'})`);

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const lineRaw of rl) {
    const line = lineRaw.replace(/\r$/, '');
    if (!line) {
      continue;
    }

    const splitAt = line.indexOf(' ');
    const command = (splitAt === -1 ? line : line.slice(0, splitAt)).toUpperCase();
    const argText = splitAt === -1 ? '' : line.slice(splitAt + 1).trim();

    debugLog(`cmd=${command} args=${argText}`);

    try {
      if (command === 'BYE') {
        sendOk('closing connection');
        break;
      }

      if (command === 'RESET') {
        sendOk();
        continue;
      }

      if (command === 'OPTION') {
        sendOk();
        continue;
      }

      if (command === 'GETINFO') {
        const key = argText.toLowerCase();
        if (key === 'version') {
          sendDataText(DEFAULT_VERSION);
          sendOk();
        } else if (key === 'pid') {
          sendDataText(String(process.pid));
          sendOk();
        } else {
          sendErr('Unknown GETINFO key');
        }
        continue;
      }

      if (command === 'KEYSERVER') {
        if (!argText) {
          sendStatus('KEYSERVER', keyservers[0]);
          sendOk();
          continue;
        }

        const tokens = splitTokens(argText);
        const clearIdx = tokens.indexOf('--clear');
        if (clearIdx !== -1) {
          tokens.splice(clearIdx, 1);
          keyservers = [];
        }

        for (const token of tokens) {
          keyservers.push(normalizeKeyserver(decodePercentPlus(token)));
        }

        if (!keyservers.length) {
          keyservers.push(normalizeKeyserver(args.keyserver));
        }

        sendOk();
        continue;
      }

      if (command === 'KS_GET') {
        const { values } = parseDelimitedArgs(argText);
        if (!values.length) {
          sendErr('KS_GET requires at least one pattern');
          continue;
        }

        const source = keyservers[0];
        sendStatus('SOURCE', source);

        const chunks = [];
        for (const pattern of values) {
          const result = await fetchKeyMaterial(source, pattern);
          chunks.push(result.body);
          if (result.body.length && result.body[result.body.length - 1] !== 0x0a) {
            chunks.push(Buffer.from('\n', 'utf8'));
          }
        }

        sendDataBuffer(Buffer.concat(chunks));
        sendOk();
        continue;
      }

      if (command === 'KS_SEARCH') {
        const { values } = parseDelimitedArgs(argText);
        if (!values.length) {
          sendErr('KS_SEARCH requires a query');
          continue;
        }

        const source = keyservers[0];
        const result = await searchKeys(source, values.join(' '));
        sendStatus('SOURCE', result.source);
        sendDataBuffer(result.body);
        sendOk();
        continue;
      }

      if (command === 'KS_FETCH') {
        const { values } = parseDelimitedArgs(argText);
        if (!values.length) {
          sendErr('KS_FETCH requires a URL');
          continue;
        }

        const result = await fetchDirect(values.join(' '));
        sendStatus('SOURCE', result.source);
        sendDataBuffer(result.body);
        sendOk();
        continue;
      }

      if (command === 'WKD_GET') {
        const { values } = parseDelimitedArgs(argText);
        if (!values.length) {
          sendErr('WKD_GET requires a mailbox');
          continue;
        }

        const result = await fetchWkd(values[0]);
        sendStatus('SOURCE', result.source);
        sendDataBuffer(result.body);
        sendOk();
        continue;
      }

      if (command === 'DNS_CERT') {
        sendErr('DNS CERT is not implemented in fetch shim');
        continue;
      }

      sendErr(`Unsupported command: ${command}`);
    } catch (error) {
      debugLog(`error=${error instanceof Error ? error.message : String(error)}`);
      sendErr(error instanceof Error ? error.message : String(error));
    }
  }
}

run().catch((error) => {
  sendErr(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
