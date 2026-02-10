#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ITERATIONS = 3;
const DEFAULT_WARMUP = 1;
const DEFAULT_SYM_BYTES = 64 * 1024;
const DEFAULT_SIGN_BYTES = 16 * 1024;
const DEFAULT_PKE_BYTES = 16 * 1024;
const DEFAULT_GNUPG_AGENT_S2K_COUNT = 65536;
const DEFAULT_PASSPHRASE = 'bench-passphrase';

function usage() {
  process.stdout.write(
    [
      'Usage: node scripts/wasm/benchmark-openpgp.mjs [options]',
      '',
      'Build gnupg wasm (unless skipped), then benchmark against OpenPGP.js.',
      '',
      'Benchmarked tasks:',
      '  - keygen_ed25519_sign',
      '  - sym_encrypt',
      '  - sym_decrypt',
      '  - sign_detached',
      '  - verify_detached',
      '  - pke_encrypt',
      '  - pke_decrypt',
      '',
      'Options:',
      `  --iterations N      Measured iterations per task (default: ${DEFAULT_ITERATIONS})`,
      `  --warmup N          Warmup iterations per task (default: ${DEFAULT_WARMUP})`,
      `  --sym-bytes N       Payload bytes for symmetric tasks (default: ${DEFAULT_SYM_BYTES})`,
      `  --sign-bytes N      Payload bytes for sign/verify tasks (default: ${DEFAULT_SIGN_BYTES})`,
      `  --pke-bytes N       Payload bytes for public-key enc/dec tasks (default: ${DEFAULT_PKE_BYTES})`,
      `  --gnupg-agent-s2k-count N  S2K count written to gpg-agent.conf (default: ${DEFAULT_GNUPG_AGENT_S2K_COUNT})`,
      '  --workdir PATH      Working directory for generated artifacts',
      '  --json-out PATH     Write JSON report to this path',
      '  --openpgp-dir PATH  Node dependency directory for OpenPGP.js install',
      `  --passphrase VALUE  Passphrase used in both implementations (default: ${DEFAULT_PASSPHRASE})`,
      '  --skip-build        Skip scripts/wasm/build-all.sh before benchmarking',
      '  --help              Show this help text',
      '',
      'Examples:',
      '  node scripts/wasm/benchmark-openpgp.mjs',
      '  node scripts/wasm/benchmark-openpgp.mjs --iterations 5 --warmup 2',
      '  node scripts/wasm/benchmark-openpgp.mjs --skip-build --json-out /tmp/bench.json',
      '',
    ].join('\n')
  );
}

function isFlag(arg) {
  return arg.startsWith('--');
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv, defaults) {
  const out = {
    iterations: defaults.iterations,
    warmup: defaults.warmup,
    symBytes: defaults.symBytes,
    signBytes: defaults.signBytes,
    pkeBytes: defaults.pkeBytes,
    gnupgAgentS2kCount: defaults.gnupgAgentS2kCount,
    passphrase: defaults.passphrase,
    workdir: defaults.workdir,
    jsonOut: defaults.jsonOut,
    openpgpDir: defaults.openpgpDir,
    skipBuild: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case '--iterations': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--iterations expects a value');
        }
        out.iterations = parsePositiveInt(next, '--iterations');
        i += 2;
        break;
      }
      case '--warmup': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--warmup expects a value');
        }
        out.warmup = parsePositiveInt(next, '--warmup');
        i += 2;
        break;
      }
      case '--sym-bytes': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--sym-bytes expects a value');
        }
        out.symBytes = parsePositiveInt(next, '--sym-bytes');
        i += 2;
        break;
      }
      case '--sign-bytes': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--sign-bytes expects a value');
        }
        out.signBytes = parsePositiveInt(next, '--sign-bytes');
        i += 2;
        break;
      }
      case '--pke-bytes': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--pke-bytes expects a value');
        }
        out.pkeBytes = parsePositiveInt(next, '--pke-bytes');
        i += 2;
        break;
      }
      case '--gnupg-agent-s2k-count': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--gnupg-agent-s2k-count expects a value');
        }
        out.gnupgAgentS2kCount = parsePositiveInt(next, '--gnupg-agent-s2k-count');
        i += 2;
        break;
      }
      case '--passphrase': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--passphrase expects a value');
        }
        out.passphrase = next;
        i += 2;
        break;
      }
      case '--workdir': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--workdir expects a value');
        }
        out.workdir = next;
        i += 2;
        break;
      }
      case '--json-out': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--json-out expects a value');
        }
        out.jsonOut = next;
        i += 2;
        break;
      }
      case '--openpgp-dir': {
        const next = argv[i + 1];
        if (!next || isFlag(next)) {
          throw new Error('--openpgp-dir expects a value');
        }
        out.openpgpDir = next;
        i += 2;
        break;
      }
      case '--skip-build':
        out.skipBuild = true;
        i += 1;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return out;
}

function toMs(startNs, endNs) {
  return Number(endNs - startNs) / 1e6;
}

function summarizeSamples(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((acc, value) => acc + value, 0);
  const mean = total / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    meanMs: mean,
    medianMs: median,
    samplesMs: samples,
  };
}

function formatMs(value) {
  return value.toFixed(2);
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function ensurePrivateDir(dirPath) {
  ensureDir(dirPath);
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    /* Best effort permission fix-up. */
  }
}

async function runCommand(command, args, options = {}) {
  const {
    cwd,
    env,
    input,
    inheritOutput = false,
  } = options;

  const start = process.hrtime.bigint();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(env || {}),
      },
      stdio: inheritOutput ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    if (!inheritOutput) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.once('error', (error) => {
      reject(error);
    });

    if (input !== undefined && input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.once('close', (code, signal) => {
      const durationMs = toMs(start, process.hrtime.bigint());
      if (code === 0) {
        resolve({ code, signal, stdout, stderr, durationMs });
        return;
      }
      const error = new Error(
        `Command failed: ${command} ${args.join(' ')} (code=${code}, signal=${signal ?? 'none'})`
      );
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      error.durationMs = durationMs;
      reject(error);
    });
  });
}

async function ensureOpenpgpInstall(openpgpDir) {
  ensureDir(openpgpDir);

  const packageJsonPath = path.join(openpgpDir, 'package.json');
  let pkg = {
    private: true,
    type: 'module',
    dependencies: {},
  };

  if (existsSync(packageJsonPath)) {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (!pkg.dependencies || typeof pkg.dependencies !== 'object') {
      pkg.dependencies = {};
    }
  }

  if (pkg.dependencies.openpgp !== '^6') {
    pkg.dependencies.openpgp = '^6';
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }

  await runCommand('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: openpgpDir,
    inheritOutput: true,
  });

  const installedPackageJson = path.join(openpgpDir, 'node_modules', 'openpgp', 'package.json');
  if (!existsSync(installedPackageJson)) {
    throw new Error(`OpenPGP.js installation missing at: ${installedPackageJson}`);
  }
  const installedPkg = JSON.parse(readFileSync(installedPackageJson, 'utf8'));
  return installedPkg.version;
}

async function loadOpenpgp(openpgpDir) {
  const packageJsonPath = path.join(openpgpDir, 'package.json');
  const requireFromOpenpgpDir = createRequire(packageJsonPath);
  const openpgpEntry = requireFromOpenpgpDir.resolve('openpgp');
  return import(pathToFileURL(openpgpEntry).href);
}

async function collectSamples(label, fn, iterations, warmup) {
  for (let i = 0; i < warmup; i += 1) {
    await fn(i, true);
  }

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    await fn(i, false);
    const elapsed = toMs(start, process.hrtime.bigint());
    samples.push(elapsed);
  }

  const stats = summarizeSamples(samples);
  process.stdout.write(
    `[bench] ${label}: mean=${formatMs(stats.meanMs)}ms median=${formatMs(stats.medianMs)}ms min=${formatMs(stats.minMs)}ms max=${formatMs(stats.maxMs)}ms\n`
  );
  return stats;
}

function renderComparisonTable(results) {
  const rows = [
    ['Task', 'gnupg-wasm mean(ms)', 'OpenPGP.js mean(ms)', 'ratio(wasm/openpgp)'],
  ];

  for (const result of results) {
    rows.push([
      result.task,
      formatMs(result.wasm.meanMs),
      formatMs(result.openpgp.meanMs),
      result.ratioWasmToOpenpgp.toFixed(2),
    ]);
  }

  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] || 0, cell.length);
    });
  }

  return rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
    .join('\n');
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const nowTag = new Date().toISOString().replace(/[:.]/g, '-');

  const defaults = {
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    symBytes: DEFAULT_SYM_BYTES,
    signBytes: DEFAULT_SIGN_BYTES,
    pkeBytes: DEFAULT_PKE_BYTES,
    gnupgAgentS2kCount: DEFAULT_GNUPG_AGENT_S2K_COUNT,
    passphrase: DEFAULT_PASSPHRASE,
    workdir: path.join(repoRoot, 'PLAY', 'wasm-build', 'bench-openpgp', nowTag),
    jsonOut: path.join(repoRoot, 'PLAY', 'wasm-build', 'bench-openpgp', nowTag, 'results.json'),
    openpgpDir: path.join(repoRoot, 'PLAY', 'wasm-build', 'openpgp-bench-node'),
  };

  let options;
  try {
    options = parseArgs(process.argv.slice(2), defaults);
  } catch (error) {
    usage();
    throw error;
  }

  const gpgNodeCliPath = path.join(scriptDir, 'gpg-node-cli.sh');
  const buildAllScriptPath = path.join(scriptDir, 'build-all.sh');

  if (!existsSync(gpgNodeCliPath)) {
    throw new Error(`Missing gpg wasm Node CLI wrapper: ${gpgNodeCliPath}`);
  }
  if (!existsSync(buildAllScriptPath)) {
    throw new Error(`Missing build script: ${buildAllScriptPath}`);
  }

  const workdir = path.resolve(options.workdir);
  const jsonOut = path.resolve(options.jsonOut);
  const openpgpDir = path.resolve(options.openpgpDir);

  ensureDir(workdir);
  ensureDir(path.dirname(jsonOut));

  if (!options.skipBuild) {
    process.stdout.write('[bench] Ensuring gnupg wasm build is available...\n');
    await runCommand('bash', [buildAllScriptPath], {
      cwd: repoRoot,
      inheritOutput: true,
    });
  }

  process.stdout.write('[bench] Installing/updating OpenPGP.js benchmark dependency...\n');
  const openpgpVersion = await ensureOpenpgpInstall(openpgpDir);
  const openpgp = await loadOpenpgp(openpgpDir);

  process.stdout.write(`[bench] OpenPGP.js version: ${openpgpVersion}\n`);

  const inputsDir = path.join(workdir, 'inputs');
  const outputsDir = path.join(workdir, 'outputs');
  const wasmHome = path.join(workdir, 'gnupg-home');
  const gpgAgentConfPath = path.join(wasmHome, 'gpg-agent.conf');
  const wasmKeygenHomes = path.join(workdir, 'keygen-homes');
  ensureDir(inputsDir);
  ensureDir(outputsDir);
  ensurePrivateDir(wasmHome);
  writeFileSync(
    gpgAgentConfPath,
    `s2k-count ${options.gnupgAgentS2kCount}\n`,
    'utf8'
  );
  process.stdout.write(`[bench] Wrote ${gpgAgentConfPath} (s2k-count ${options.gnupgAgentS2kCount})\n`);
  ensureDir(wasmKeygenHomes);

  const symPlainPath = path.join(inputsDir, `sym-${options.symBytes}.bin`);
  const signPlainPath = path.join(inputsDir, `sign-${options.signBytes}.bin`);
  const pkePlainPath = path.join(inputsDir, `pke-${options.pkeBytes}.bin`);
  writeFileSync(symPlainPath, randomBytes(options.symBytes));
  writeFileSync(signPlainPath, randomBytes(options.signBytes));
  writeFileSync(pkePlainPath, randomBytes(options.pkeBytes));

  const symPlainData = readFileSync(symPlainPath);
  const signPlainData = readFileSync(signPlainPath);
  const pkePlainData = readFileSync(pkePlainPath);

  async function runWasm(gpgArgs, runOptions = {}) {
    const {
      homedir = wasmHome,
      useAgentBridge = false,
      useDirmngrBridge = false,
      useScdaemonBridge = false,
    } = runOptions;

    ensurePrivateDir(homedir);

    const cliArgs = [gpgNodeCliPath, '--homedir', homedir];
    if (!useAgentBridge) {
      cliArgs.push('--no-agent-bridge');
    }
    if (!useDirmngrBridge) {
      cliArgs.push('--no-dirmngr-bridge');
    }
    if (!useScdaemonBridge) {
      cliArgs.push('--no-scdaemon-bridge');
    }
    cliArgs.push('--', ...gpgArgs);

    return runCommand('bash', cliArgs, {
      cwd: repoRoot,
      env: {
        GNUPGHOME: homedir,
      },
    });
  }

  const userTag = `${Date.now()}-${process.pid}`;
  const wasmUserId = `Wasm Bench <wasm-bench-${userTag}@example.test>`;
  const openpgpUser = {
    name: 'OpenPGP Bench',
    email: `openpgp-bench-${userTag}@example.test`,
  };

  process.stdout.write('[bench] Preparing baseline key material...\n');
  await runWasm(
    [
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      '',
      '--quick-generate-key',
      wasmUserId,
      'default',
      'default',
      'never',
    ],
    {
      useAgentBridge: true,
    }
  );

  const openpgpKeyPair = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [openpgpUser],
    passphrase: options.passphrase,
    format: 'armored',
  });
  const openpgpPublicKey = await openpgp.readKey({
    armoredKey: openpgpKeyPair.publicKey,
  });

  async function decryptOpenpgpPrivateKey() {
    const privateKey = await openpgp.readPrivateKey({
      armoredKey: openpgpKeyPair.privateKey,
    });
    return openpgp.decryptKey({
      privateKey,
      passphrase: options.passphrase,
    });
  }

  const openpgpSymConfig = {
    preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed,
    preferredSymmetricAlgorithm: openpgp.enums.symmetric.aes256,
  };

  const wasmSymCipherPath = path.join(outputsDir, 'wasm-sym-pre.gpg');
  const wasmSignDetachedPath = path.join(outputsDir, 'wasm-sign-pre.asc');
  const wasmPkeCipherPath = path.join(outputsDir, 'wasm-pke-pre.gpg');

  await runWasm(
    [
      '--pinentry-mode',
      'loopback',
      '--passphrase',
      options.passphrase,
      '--compress-algo',
      'none',
      '--cipher-algo',
      'AES256',
      '--s2k-count',
      '65536',
      '--output',
      wasmSymCipherPath,
      '--symmetric',
      symPlainPath,
    ],
    {
      useAgentBridge: false,
    }
  );

  await runWasm(
    [
      '--local-user',
      wasmUserId,
      '--armor',
      '--output',
      wasmSignDetachedPath,
      '--detach-sign',
      signPlainPath,
    ],
    {
      useAgentBridge: true,
    }
  );

  await runWasm(
    [
      '--trust-model',
      'always',
      '--output',
      wasmPkeCipherPath,
      '--encrypt',
      '--recipient',
      wasmUserId,
      pkePlainPath,
    ],
    {
      useAgentBridge: false,
    }
  );

  const openpgpSymCipher = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: symPlainData }),
    passwords: [options.passphrase],
    format: 'binary',
    config: openpgpSymConfig,
  });

  const openpgpPreSignKey = await decryptOpenpgpPrivateKey();
  const openpgpDetachedSignature = await openpgp.sign({
    message: await openpgp.createMessage({ binary: signPlainData }),
    signingKeys: openpgpPreSignKey,
    detached: true,
    format: 'armored',
  });

  const openpgpPkeCipher = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: pkePlainData }),
    encryptionKeys: openpgpPublicKey,
    format: 'binary',
  });

  process.stdout.write('[bench] Running benchmark tasks...\n');

  const tasks = [
    {
      name: 'keygen_ed25519_sign',
      wasm: async (iteration, warmupPass) => {
        const runTag = warmupPass ? `warm-${iteration}` : `run-${iteration}`;
        const keygenHome = path.join(wasmKeygenHomes, `wasm-${runTag}`);
        rmSync(keygenHome, { recursive: true, force: true });
        ensurePrivateDir(keygenHome);
        const uid = `Wasm Keygen ${runTag} <wasm-keygen-${userTag}-${runTag}@example.test>`;
        await runWasm(
          [
            '--pinentry-mode',
            'loopback',
            '--passphrase',
            '',
            '--quick-generate-key',
            uid,
            'ed25519',
            'sign',
            'never',
          ],
          {
            homedir: keygenHome,
            useAgentBridge: true,
          }
        );
      },
      openpgp: async (iteration, warmupPass) => {
        const runTag = warmupPass ? `warm-${iteration}` : `run-${iteration}`;
        await openpgp.generateKey({
          type: 'ecc',
          curve: 'ed25519',
          userIDs: [
            {
              name: 'OpenPGP Keygen',
              email: `openpgp-keygen-${userTag}-${runTag}@example.test`,
            },
          ],
          passphrase: options.passphrase,
          format: 'armored',
        });
      },
    },
    {
      name: 'sym_encrypt',
      wasm: async (iteration, warmupPass) => {
        const runTag = warmupPass ? `warm-${iteration}` : `run-${iteration}`;
        const outPath = path.join(outputsDir, `wasm-sym-enc-${runTag}.gpg`);
        await runWasm(
          [
            '--pinentry-mode',
            'loopback',
            '--passphrase',
            options.passphrase,
            '--compress-algo',
            'none',
            '--cipher-algo',
            'AES256',
            '--s2k-count',
            '65536',
            '--output',
            outPath,
            '--symmetric',
            symPlainPath,
          ],
          {
            useAgentBridge: false,
          }
        );
      },
      openpgp: async () => {
        await openpgp.encrypt({
          message: await openpgp.createMessage({ binary: symPlainData }),
          passwords: [options.passphrase],
          format: 'binary',
          config: openpgpSymConfig,
        });
      },
    },
    {
      name: 'sym_decrypt',
      wasm: async (iteration, warmupPass) => {
        const runTag = warmupPass ? `warm-${iteration}` : `run-${iteration}`;
        const outPath = path.join(outputsDir, `wasm-sym-dec-${runTag}.bin`);
        await runWasm(
          [
            '--pinentry-mode',
            'loopback',
            '--passphrase',
            options.passphrase,
            '--output',
            outPath,
            '--decrypt',
            wasmSymCipherPath,
          ],
          {
            useAgentBridge: false,
          }
        );
      },
      openpgp: async () => {
        const message = await openpgp.readMessage({
          binaryMessage: openpgpSymCipher,
        });
        await openpgp.decrypt({
          message,
          passwords: [options.passphrase],
          format: 'binary',
        });
      },
    },
    {
      name: 'sign_detached',
      wasm: async (iteration, warmupPass) => {
        const runTag = warmupPass ? `warm-${iteration}` : `run-${iteration}`;
        const outPath = path.join(outputsDir, `wasm-sign-${runTag}.asc`);
        await runWasm(
          [
            '--local-user',
            wasmUserId,
            '--armor',
            '--output',
            outPath,
            '--detach-sign',
            signPlainPath,
          ],
          {
            useAgentBridge: true,
          }
        );
      },
      openpgp: async () => {
        const privateKey = await decryptOpenpgpPrivateKey();
        await openpgp.sign({
          message: await openpgp.createMessage({ binary: signPlainData }),
          signingKeys: privateKey,
          detached: true,
          format: 'armored',
        });
      },
    },
    {
      name: 'verify_detached',
      wasm: async () => {
        await runWasm(
          ['--verify', wasmSignDetachedPath, signPlainPath],
          {
            useAgentBridge: false,
          }
        );
      },
      openpgp: async () => {
        const message = await openpgp.createMessage({ binary: signPlainData });
        const signature = await openpgp.readSignature({
          armoredSignature: openpgpDetachedSignature,
        });
        const verificationResult = await openpgp.verify({
          message,
          signature,
          verificationKeys: openpgpPublicKey,
        });
        await verificationResult.signatures[0].verified;
      },
    },
    {
      name: 'pke_encrypt',
      wasm: async (iteration, warmupPass) => {
        const runTag = warmupPass ? `warm-${iteration}` : `run-${iteration}`;
        const outPath = path.join(outputsDir, `wasm-pke-enc-${runTag}.gpg`);
        await runWasm(
          [
            '--trust-model',
            'always',
            '--output',
            outPath,
            '--encrypt',
            '--recipient',
            wasmUserId,
            pkePlainPath,
          ],
          {
            useAgentBridge: false,
          }
        );
      },
      openpgp: async () => {
        await openpgp.encrypt({
          message: await openpgp.createMessage({ binary: pkePlainData }),
          encryptionKeys: openpgpPublicKey,
          format: 'binary',
        });
      },
    },
    {
      name: 'pke_decrypt',
      wasm: async (iteration, warmupPass) => {
        const runTag = warmupPass ? `warm-${iteration}` : `run-${iteration}`;
        const outPath = path.join(outputsDir, `wasm-pke-dec-${runTag}.bin`);
        await runWasm(
          [
            '--output',
            outPath,
            '--decrypt',
            wasmPkeCipherPath,
          ],
          {
            useAgentBridge: true,
          }
        );
      },
      openpgp: async () => {
        const privateKey = await decryptOpenpgpPrivateKey();
        const message = await openpgp.readMessage({
          binaryMessage: openpgpPkeCipher,
        });
        await openpgp.decrypt({
          message,
          decryptionKeys: privateKey,
          format: 'binary',
        });
      },
    },
  ];

  const results = [];

  for (const task of tasks) {
    process.stdout.write(`\n[bench] Task: ${task.name}\n`);
    const wasmStats = await collectSamples(
      `${task.name} / gnupg-wasm`,
      task.wasm,
      options.iterations,
      options.warmup
    );
    const openpgpStats = await collectSamples(
      `${task.name} / OpenPGP.js`,
      task.openpgp,
      options.iterations,
      options.warmup
    );

    results.push({
      task: task.name,
      wasm: wasmStats,
      openpgp: openpgpStats,
      ratioWasmToOpenpgp: wasmStats.meanMs / openpgpStats.meanMs,
    });
  }

  const report = {
    createdAt: new Date().toISOString(),
    repoRoot,
    workdir,
    nodeVersion: process.version,
    openpgpVersion,
    config: {
      iterations: options.iterations,
      warmup: options.warmup,
      symBytes: options.symBytes,
      signBytes: options.signBytes,
      pkeBytes: options.pkeBytes,
      gnupgAgentS2kCount: options.gnupgAgentS2kCount,
      gnupgSecretKeyProtection: 'none',
      skipBuild: options.skipBuild,
    },
    tasks: results,
  };

  await fs.writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write('\n[bench] Comparison table (mean latency):\n');
  process.stdout.write(`${renderComparisonTable(results)}\n`);
  process.stdout.write(`\n[bench] JSON report written to: ${jsonOut}\n`);
}

main().catch((error) => {
  process.stderr.write(`[bench] error: ${error.message}\n`);
  if (error.stderr) {
    process.stderr.write(`[bench] stderr:\n${error.stderr}\n`);
  }
  if (error.stdout) {
    process.stderr.write(`[bench] stdout:\n${error.stdout}\n`);
  }
  process.exit(1);
});
