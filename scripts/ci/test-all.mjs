#!/usr/bin/env node
// One entry point for every test layer. Node built-ins only, so it runs before `pnpm install`.
//
//   node scripts/ci/test-all.mjs                      lint, typecheck, unit, integration, e2e (in order)
//   node scripts/ci/test-all.mjs unit integration     only the named steps, still in that order
//   node scripts/ci/test-all.mjs e2e --invariants s1a,s2b,s3,s4   a subset of the invariant audit
//   node scripts/ci/test-all.mjs e2e --keep           leave the e2e stack running afterwards
//   node scripts/ci/test-all.mjs up | down            the main stack, for manual use
//
// Stops at the first failing step and exits with its code (never 0 after a failure).
//
// Steps that need Node run through pnpm. When this Node is older than 22 (the repo needs
// >= 22.12) they run instead in the node:22 image on a copy of the working tree (pnpm store
// cached in the volume inblack-ci-pnpm-store), so a machine with only Docker and any Node can
// still run everything. Docker steps always run on the host.
//
// Integration: when TEST_DATABASE_URL is set (CI service containers) it is used as is.
// Otherwise a throwaway Postgres and Redis start from scripts/ci/integration.compose.yml under
// the compose project inblack-ci-int, and are removed afterwards.
//
// E2E: `docker compose up --build -d --wait` of the working tree under the project
// inblack-e2e, then scripts/audit/sse.mjs, scripts/audit/invariants.mjs (reusing that stack)
// and scripts/audit/security.mjs when it exists. The compose file fixes container names
// (inblack-*), so the step refuses to start while such containers belong to another project.
// Compose logs go to $CI_LOG_DIR (default <tmp>/inblack-ci) when the step fails.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL = ['lint', 'typecheck', 'unit', 'integration', 'e2e'];
const EXTRA = ['up', 'down'];

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const INVARIANTS = opt('invariants');
const KEEP = argv.includes('--keep');
const named = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--invariants');
const unknown = named.filter((s) => !ALL.includes(s) && !EXTRA.includes(s));
if (unknown.length) {
  console.error(`unknown step(s): ${unknown.join(', ')}. Steps: ${[...ALL, ...EXTRA].join(', ')}`);
  process.exit(2);
}
const steps = named.length ? [...ALL, ...EXTRA].filter((s) => named.includes(s)) : ALL;

const NODE_IN_DOCKER = Number(process.versions.node.split('.')[0]) < 22;
const NODE_IMAGE = 'node:22';
const INT_PROJECT = 'inblack-ci-int';
const INT_COMPOSE = path.join(REPO, 'scripts', 'ci', 'integration.compose.yml');
const E2E_PROJECT = 'inblack-e2e';
const LOG_DIR = process.env.CI_LOG_DIR ?? path.join(os.tmpdir(), 'inblack-ci');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'inblack-ci-out-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

const banner = (text) => console.log(`\n\x1b[1m==> ${text}\x1b[0m`);

/** Runs a command with inherited stdio and resolves its exit code (1 when it could not start). */
function run(cmd, args, { env = process.env, shell = false } = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO, env, stdio: 'inherit', shell });
    child.on('error', (error) => {
      console.error(`could not start ${cmd}: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * pnpm with the given arguments, natively or in the node:22 image. `env` holds only the extra
 * variables the step needs; `network` attaches the container to a compose network.
 */
async function pnpm(args, { env = {}, network, before } = {}) {
  if (!NODE_IN_DOCKER) {
    const merged = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
    // pnpm is a .cmd shim on Windows, which spawn only finds through a shell. The arguments
    // here are fixed strings from this file, never user input.
    const shell = process.platform === 'win32';
    if (before) {
      const code = await run('pnpm', before, { env: merged, shell });
      if (code) return code;
    }
    return run('pnpm', args, { env: merged, shell });
  }
  // The repo is copied into the container (without node_modules or build output) and installed
  // there: running Node off a Windows bind mount is slow enough that test hooks time out. The
  // pnpm store and corepack cache live in the volume inblack-ci-pnpm-store between runs.
  // OUT (a host temp dir) is mounted at /out, so report files land on the host.
  const flags = ['run', '--rm', '-v', `${REPO}:/src:ro`, '-v', 'inblack-ci-pnpm-store:/cache', '-v', `${OUT}:/out`, '-e', 'CI=true', '-e', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0', '-e', 'COREPACK_HOME=/cache/corepack'];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) flags.push('-e', `${k}=${v}`);
  if (network) flags.push('--network', network);
  const script = [
    'set -e',
    'mkdir /work',
    "tar -C /src --exclude=node_modules --exclude=.pnpm-store --exclude=.next --exclude=dist --exclude=coverage -cf - . | tar -C /work -xf -",
    'cd /work',
    'corepack pnpm install --frozen-lockfile --store-dir /cache/store --reporter=append-only > /tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }',
    // `before` is a fixed argument list from this file; quoted for sh.
    ...(before ? [`corepack pnpm ${before.map((a) => `'${a}'`).join(' ')}`] : []),
    'exec corepack pnpm "$@"',
  ].join('\n');
  return run('docker', [...flags, NODE_IMAGE, 'sh', '-c', script, 'sh', ...args]);
}

const docker = (args) => run('docker', args);
const dockerOut = (args) => spawnSync('docker', args, { cwd: REPO, encoding: 'utf8' });

let installed = false;
async function install() {
  // In the node:22 image every step installs into its own container (see pnpm()).
  if (installed || NODE_IN_DOCKER) return 0;
  installed = true;
  banner(`pnpm install --frozen-lockfile${NODE_IN_DOCKER ? ` (in ${NODE_IMAGE}: this Node is ${process.version}, the repo needs >= 22.12)` : ''}`);
  return pnpm(['install', '--frozen-lockfile']);
}

// ---------- Steps ----------

async function lint() {
  return (await install()) || pnpm(['-r', 'lint']);
}

async function typecheck() {
  return (await install()) || pnpm(['-r', 'typecheck']);
}

/**
 * Every package's `test` script. TEST_DATABASE_URL is cleared, so the *.int.spec.ts files skip.
 * The worker resolves @inblack/domain through its dist, so that is built first (a fresh checkout,
 * as in CI, has none).
 */
async function unit() {
  return (await install()) || pnpm(['-r', 'test'], { env: { TEST_DATABASE_URL: undefined, TEST_REDIS_URL: undefined }, before: ['--filter', '@inblack/domain', 'build'] });
}

/**
 * The *.int.spec.ts files against a real, empty Postgres (they apply db/migrations and the seed
 * themselves in beforeAll, so nothing is migrated beforehand). Fails when any of them skipped or
 * none passed, so a missing TEST_DATABASE_URL cannot turn this step green.
 */
async function integration() {
  const code = await install();
  if (code) return code;

  let env;
  let network;
  let started = false;
  if (process.env.TEST_DATABASE_URL) {
    env = { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_REDIS_URL: process.env.TEST_REDIS_URL };
    console.log('using TEST_DATABASE_URL from the environment');
  } else {
    banner(`throwaway Postgres and Redis (compose project ${INT_PROJECT})`);
    const compose = ['compose', '-p', INT_PROJECT, '-f', INT_COMPOSE];
    await docker([...compose, 'down', '-v', '--remove-orphans']);
    started = true;
    const up = await docker([...compose, 'up', '-d', '--wait']);
    if (up) {
      await docker([...compose, 'down', '-v', '--remove-orphans']);
      return up;
    }
    if (NODE_IN_DOCKER) {
      network = `${INT_PROJECT}_default`;
      env = { TEST_DATABASE_URL: 'postgresql://postgres:test@postgres:5432/postgres', TEST_REDIS_URL: 'redis://redis:6379' };
    } else {
      env = { TEST_DATABASE_URL: 'postgresql://postgres:test@127.0.0.1:55432/postgres', TEST_REDIS_URL: 'redis://127.0.0.1:56379' };
    }
  }

  // Only db has *.int.spec.ts today. A package that adds one belongs in this list.
  const report = path.join(OUT, 'int-report.json');
  try {
    banner('integration tests (*.int.spec.ts)');
    const result = await pnpm(
      ['--filter', '@inblack/db', 'exec', 'vitest', 'run', '--reporter=verbose', '--reporter=json', `--outputFile.json=${NODE_IN_DOCKER ? '/out/int-report.json' : report}`, 'int.spec'],
      { env, network },
    );
    if (result) return result;
    const json = JSON.parse(fs.readFileSync(report, 'utf8'));
    const skipped = json.numPendingTests + json.numTodoTests;
    console.log(`integration: ${json.numPassedTests} passed, ${json.numFailedTests} failed, ${skipped} skipped, in ${json.numTotalTestSuites} suites`);
    if (json.numPassedTests === 0 || skipped > 0) {
      console.error('integration tests skipped or did not run: is TEST_DATABASE_URL reaching the database?');
      return 1;
    }
    return 0;
  } finally {
    if (started) await docker(['compose', '-p', INT_PROJECT, '-f', INT_COMPOSE, 'down', '-v', '--remove-orphans']);
  }
}

/** inblack-* containers that belong to a compose project other than `project`. */
function foreignContainers(project) {
  const r = dockerOut(['ps', '-a', '--filter', 'name=inblack-', '--format', '{{.Names}} {{.Label "com.docker.compose.project"}}']);
  if (r.status !== 0) throw new Error(`docker ps failed: ${r.stderr}`);
  return r.stdout.split('\n').filter((l) => l.trim() && !l.trim().endsWith(` ${project}`));
}

async function e2e() {
  const foreign = foreignContainers(E2E_PROJECT);
  if (foreign.length) {
    console.error(`docker-compose.yml fixes container names, and these inblack-* containers belong to another project:\n${foreign.join('\n')}\nStop that stack first; this step does not touch it.`);
    return 1;
  }
  const compose = ['compose', '-p', E2E_PROJECT, '-f', path.join(REPO, 'docker-compose.yml')];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'inblack-e2e-'));
  let code = 0;
  try {
    banner(`docker compose up --build -d --wait (project ${E2E_PROJECT})`);
    code = await docker([...compose, 'up', '--build', '-d', '--wait']);
    if (code) return code;

    banner('SSE audit (scripts/audit/sse.mjs)');
    code = await run(process.execPath, ['scripts/audit/sse.mjs']);
    if (code) return code;

    banner(`invariant audit (scripts/audit/invariants.mjs${INVARIANTS ? ` --only ${INVARIANTS}` : ', all scenarios'})`);
    const inv = ['scripts/audit/invariants.mjs', '--reuse', REPO, '--project', E2E_PROJECT, '--work', work];
    if (INVARIANTS) inv.push('--only', INVARIANTS);
    code = await run(process.execPath, inv);
    if (code) return code;

    const security = path.join(REPO, 'scripts', 'audit', 'security.mjs');
    if (fs.existsSync(security)) {
      banner('security audit (scripts/audit/security.mjs)');
      code = await run(process.execPath, [security]);
      if (code) return code;
    } else {
      console.log('scripts/audit/security.mjs not present, skipped');
    }
    return 0;
  } finally {
    if (code) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const logs = dockerOut([...compose, 'logs', '--no-color', '--timestamps']);
      const ps = dockerOut([...compose, 'ps', '-a']);
      fs.writeFileSync(path.join(LOG_DIR, 'compose.log'), `${ps.stdout}\n${logs.stdout}${logs.stderr}`);
      console.error(`compose logs written to ${path.join(LOG_DIR, 'compose.log')}`);
    }
    if (KEEP) {
      console.log(`left running: compose project ${E2E_PROJECT}`);
    } else {
      await docker([...compose, 'down', '-v', '--remove-orphans']);
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const up = () => docker(['compose', 'up', '--build', '-d', '--wait']);
const down = () => docker(['compose', 'down', '--remove-orphans']);

// ---------- Run ----------

const impl = { lint, typecheck, unit, integration, e2e, up, down };
const summary = [];
let exitCode = 0;
for (const step of steps) {
  banner(`step: ${step}`);
  const started = Date.now();
  let code;
  try {
    code = await impl[step]();
  } catch (error) {
    console.error(error.stack ?? String(error));
    code = 1;
  }
  summary.push({ step, code, seconds: Math.round((Date.now() - started) / 1000) });
  if (code) {
    exitCode = code;
    break;
  }
}

console.log('\n## test-all summary');
for (const { step, code, seconds } of summary) console.log(`${code ? 'FAIL' : 'PASS'}  ${step.padEnd(12)} ${String(seconds).padStart(5)}s${code ? `  (exit ${code})` : ''}`);
const notRun = steps.slice(summary.length);
if (notRun.length) console.log(`not run: ${notRun.join(', ')}`);
process.exit(exitCode);
