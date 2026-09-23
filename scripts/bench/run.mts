/**
 * The Styx benchmark, replayed with one command. Method: docs/BENCHMARK-METHOD.md.
 *
 *   # everything that runs on this machine alone (no key, no network):
 *   npx tsx scripts/bench/run.mts --only local
 *
 *   # the whole benchmark, live flows on devnet included:
 *   P01_BENCH_RPC='<devnet RPC URL>' npx tsx scripts/bench/run.mts --only all \
 *     --key <path outside the repo> --cluster devnet --rpc-env P01_BENCH_RPC --api-base <deployment>
 *
 *   # check every argument and gate, print the plan and the SOL it needs, send and measure nothing
 *   # (a dry run writes to <temp>/styx-bench-dry/<date>, never under docs/bench):
 *   npx tsx scripts/bench/run.mts --only all --dry-run [--key ... --cluster devnet --rpc-env ...]
 *
 * What it measures: v1 AS DEPLOYED, a pre-v2 (pre-WP10) baseline (protocol.mts).
 * After the live flows it runs the post-run probes (verify/p01-verify.mjs
 * --since-slot <first slot of the run>, verify/p01-crowd.mjs) on every spend,
 * logs under raw/probe-*.log.txt.
 *
 * Flows (--only takes a comma list, or the groups `local`, `live`, `all`):
 *   native          Rust prover, release build, per circuit (bench_all_circuits.rs)
 *   wasm-node       the shipped wasm blob in Node, per circuit, cold and warm
 *   wasm-browser    the shipped wasm blob in a browser Web Worker, per circuit, cold and warm
 *   stark-pipeline  live: prove + allocate + upload + verify + close, per circuit (live-timing.ts --v1)
 *   deposit | withdrawal | subscription | purchase
 *                   live: the app's own worker handlers, end to end (apps/web live harnesses)
 *
 * Output: --out <dir> (default docs/bench/<UTC date>/run-<start time>/; a run
 * refuses a directory that already holds files): manifest.json, one
 * <flow>.json per flow (every sample, and the summary), raw/ (every log, as
 * printed, secrets redacted), signatures.txt, summary.md.
 *
 * Guards: a run whose smallest row has fewer than 30 samples (--n, and --cold-n
 * when a wasm flow runs) and every dry run cannot be written under docs/bench
 * (smoke numbers must never look like results, guards.mts); every JSON says
 * whether it is publishable and why not, and summary.md repeats every flow's
 * verdict in its heading and on every row (summary.mts); every live log is
 * scrubbed (flows/scrub.mts) of claim codes, leaf numbers and private paths
 * before it is written. Each run gets its own new private directory, so no
 * cold cache or purchase record carries over from an earlier run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { summarize, formatSummary, type Summary } from './stats.mts';
import { WITNESSES } from './witnesses.mts';
import { collectEnvironment, cpuBusyPercent, browserVersion } from './env.mts';
import { FLOWS, parseFlowLog, type FlowDef, type FlowSample } from './flows/markers.mts';
import { checkLiveGates, assertDevnetEndpoint, redactSecrets, currentSlot, readDeploySlots, type LiveContext } from './live.mts';
import { resolveOutDir, smallestSampleCount, makePrivateRunDir, prepareSampleFiles, nonEmptyOutRefusal, pidsForProfile } from './guards.mts';
import { renderSummary, type Verdict } from './summary.mts';
import { scrubLiveLog } from './flows/scrub.mts';
import { readProtocol } from './protocol.mts';
import { fundingReport, type LiveFlow } from './funding.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const WEB = path.join(ROOT, 'apps/web');
const MIN_PUBLISHABLE_N = 30;
const BUSY_LIMIT_PERCENT = 15;

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const has = (k: string) => argv.includes(`--${k}`);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

const LOCAL = ['native', 'wasm-node', 'wasm-browser'] as const;
const LIVE = ['stark-pipeline', 'deposit', 'withdrawal', 'subscription', 'purchase'] as const;
type Flow = typeof LOCAL[number] | typeof LIVE[number];

function parseOnly(s: string | undefined): Flow[] {
  const out: Flow[] = [];
  for (const part of (s ?? 'all').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (part === 'all') out.push(...LOCAL, ...LIVE);
    else if (part === 'local') out.push(...LOCAL);
    else if (part === 'live') out.push(...LIVE);
    else if ((LOCAL as readonly string[]).includes(part) || (LIVE as readonly string[]).includes(part)) out.push(part as Flow);
    else fail(`--only: unknown flow "${part}". Flows: ${[...LOCAL, ...LIVE].join(', ')}; groups: local, live, all.`);
  }
  return [...new Set(out)];
}

function fail(msg: string): never {
  console.error(`\nREFUSED — ${msg}`);
  process.exit(2);
}

const DRY = has('dry-run');
const N = Number(opt('n') ?? MIN_PUBLISHABLE_N);
if (!Number.isInteger(N) || N < 1) fail('--n must be a positive integer.');
const COLD_N = Number(opt('cold-n') ?? N);
if (!Number.isInteger(COLD_N) || COLD_N < 1) fail('--cold-n must be a positive integer.');
const ONLY = parseOnly(opt('only'));
const CIRCUITS = (opt('circuits') ?? '0,1,2,3,4,5,6,7').split(',').map((c) => Number(c.trim()));
for (const c of CIRCUITS) if (!(c >= 0 && c <= 7 && Number.isInteger(c))) fail(`--circuits: ${c} is not 0..7`);
const CACHE = opt('cache') ?? 'warm';
if (CACHE !== 'warm' && CACHE !== 'cold') fail('--cache is warm or cold.');
const STARTED_AT = new Date().toISOString();
const DATE = STARTED_AT.slice(0, 10);
// A dry run never writes under docs/bench; a run whose smallest row has fewer
// than 30 samples never does either: --cold-n counts when a wasm flow writes
// cold rows (guards.mts).
const outDir = resolveOutDir({
  root: ROOT, out: opt('out'), dry: DRY, n: smallestSampleCount({ n: N, coldN: COLD_N, flows: ONLY }),
  minN: MIN_PUBLISHABLE_N, date: DATE, tmpDir: os.tmpdir(),
  runId: `run-${STARTED_AT.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`,
});
if (outDir.refused) fail(outDir.refused);
const OUT = outDir.out;
// Every run writes into a directory of its own (guards.mts nonEmptyOutRefusal).
{
  const taken = nonEmptyOutRefusal(OUT, existsSync(OUT) ? readdirSync(OUT) : []);
  if (taken) fail(taken);
}

// Founder fields (docs/BENCHMARK-METHOD.md §2 and §3). Missing ones do not stop
// a run; they mark every result not publishable, with the reason.
const PLANNED_NODE_MAJOR = 24;
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const NODE_ACCEPTED = opt('node-accepted') === undefined ? null : Number(opt('node-accepted'));
const RPC_PLAN = opt('rpc-plan') ?? null;
const PROBES = (opt('probes') ?? 'on') === 'on';
const PROBE_MAX = Number(opt('probe-max') ?? 0); // 0 = every spend

const liveFlows = ONLY.filter((f) => (LIVE as readonly string[]).includes(f));
let live: LiveContext | undefined;
if (liveFlows.length) {
  const g = checkLiveGates({
    cluster: opt('cluster'), key: opt('key'), rpcEnv: opt('rpc-env'), rpc: opt('rpc'),
    apiBase: opt('api-base'), allowProductionApi: has('allow-production-api'),
  }, ROOT, liveFlows.includes('purchase'));
  if (g.errors.length) {
    const lines = g.errors.map((e) => `  - ${e}`).join('\n');
    if (DRY) console.log(`\nLive flows ${liveFlows.join(', ')} would be REFUSED:\n${lines}\n`);
    else fail(`live flows ${liveFlows.join(', ')} cannot run:\n${lines}`);
  } else {
    live = g.ctx;
  }
}

// ------------------------------------------------------------------ helpers
// Raw logs are written as *.log.txt: the repository's .gitignore ignores *.log
// everywhere, and a raw log that cannot be committed cannot be published.
const RAW = path.join(OUT, 'raw');
/**
 * Records that must never be published (history caches, the purchase flow's
 * working record, unscrubbed logs). Outside the repo, and NEW for every run
 * (guards.mts makePrivateRunDir): a --cache cold sample never reads an earlier
 * run's cache, a purchase sample never resumes an earlier run's record.
 */
const PRIVATE_DIR = makePrivateRunDir(path.resolve(opt('private-dir') ?? path.join(os.tmpdir(), 'styx-bench-private')), STARTED_AT);
const secrets = () => [live?.rpcUrl ?? '', process.env.P01_FUNDER_TICKET ?? '', process.env.P01_RELAY_TICKET ?? ''];

function writeJson(name: string, value: unknown) {
  writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n');
}

/**
 * Every log written under OUT goes through this: secrets (RPC URL, tickets)
 * first, then flows/scrub.mts (claim codes, leaf numbers, the private
 * directory, the home directory). `values` adds exact strings to remove.
 */
function publishableLog(text: string, values: string[] = []): string {
  return scrubLiveLog(redactSecrets(text, secrets()), { privatePaths: [PRIVATE_DIR], homeDir: os.homedir(), values });
}

/** The secret strings a purchase run left in its private record: removed from its log wherever they appear. */
function recordSecrets(recordPath: string): string[] {
  const vals: string[] = [];
  for (const f of [recordPath, `${recordPath}.progress.json`]) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
      for (const k of ['claimCode', 'claimProof', 'sealedNote']) if (typeof j[k] === 'string') vals.push(j[k] as string);
    } catch { /* not written (yet) */ }
  }
  return vals;
}

interface ChildResult { code: number | null; out: string; ms: number }

/**
 * Spawn, tee into a raw log, never through a shell. The log under OUT is
 * `publishableLog(...)` (or opts.scrub); when that changed anything, the
 * secret-redacted but unscrubbed copy goes to PRIVATE_DIR/raw-unscrubbed/ for
 * debugging, outside the repository.
 */
function runChild(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; log?: string; echo?: boolean; scrub?: (t: string) => string } = {}): Promise<ChildResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, windowsHide: true });
    let out = '';
    const onData = (d: Buffer) => {
      const s = d.toString('utf8');
      out += s;
      if (opts.echo) process.stdout.write(publishableLog(s));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      const ms = performance.now() - t0;
      if (opts.log) {
        const redacted = redactSecrets(out, secrets());
        const published = opts.scrub ? opts.scrub(out) : publishableLog(out);
        writeFileSync(opts.log, published);
        if (published !== redacted) {
          const keep = path.join(PRIVATE_DIR, 'raw-unscrubbed');
          mkdirSync(keep, { recursive: true });
          writeFileSync(path.join(keep, path.basename(opts.log)), redacted);
        }
      }
      resolve({ code, out, ms });
    });
  });
}

const TSX = ['--import', 'tsx'];

function stat(xs: number[]): Summary | null {
  return xs.length ? summarize(xs) : null;
}

// Machine load DURING the run, sampled every 2 s from os.cpus() tick counters.
// The harness's own prover uses one thread (about 3 % of 32 logical CPUs), so a
// mean above the limit means something else was running.
const loadSamples: Array<{ t: number; busy: number }> = [];
let prevTicks = os.cpus().map((c) => c.times);
function startLoadSampler() {
  setInterval(() => {
    const now = os.cpus().map((c) => c.times);
    let busy = 0;
    let total = 0;
    for (let i = 0; i < now.length && i < prevTicks.length; i++) {
      const d = (k: 'user' | 'nice' | 'sys' | 'irq' | 'idle') => now[i][k] - prevTicks[i][k];
      const t = d('user') + d('nice') + d('sys') + d('irq') + d('idle');
      busy += t - d('idle');
      total += t;
    }
    prevTicks = now;
    if (total > 0) loadSamples.push({ t: Date.now(), busy: (100 * busy) / total });
  }, 2000).unref();
}
let flowWindowStart = Date.now();
function loadSince(t0: number): { mean: number; max: number; samples: number } | null {
  const xs = loadSamples.filter((x) => x.t >= t0).map((x) => x.busy);
  if (!xs.length) return null;
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, max: Math.max(...xs), samples: xs.length };
}

function publishability(n: number, busy: number | null, isLive = false): { publishable: boolean; why_not: string[]; cpu_busy_percent_during: ReturnType<typeof loadSince> } {
  const why: string[] = [];
  if (DRY) why.push('dry run');
  if (n < MIN_PUBLISHABLE_N) why.push(`n = ${n} < ${MIN_PUBLISHABLE_N}`);
  if (NODE_MAJOR !== PLANNED_NODE_MAJOR && NODE_ACCEPTED !== NODE_MAJOR) {
    why.push(`Node ${process.version}: the plan names Node ${PLANNED_NODE_MAJOR}; the founder records another choice with --node-accepted ${NODE_MAJOR}`);
  }
  if (isLive && !RPC_PLAN) why.push('the RPC plan tier is not recorded (--rpc-plan "<provider and tier>")');
  if (busy !== null && busy > BUSY_LIMIT_PERCENT) why.push(`machine ${busy.toFixed(0)} % busy before the run (limit ${BUSY_LIMIT_PERCENT} %)`);
  const during = loadSince(flowWindowStart);
  if (during && during.mean > BUSY_LIMIT_PERCENT) why.push(`machine ${during.mean.toFixed(0)} % busy on average during this flow (limit ${BUSY_LIMIT_PERCENT} %)`);
  return { publishable: why.length === 0, why_not: why, cpu_busy_percent_during: during };
}

const summaryRows: Array<{ flow: string; row: string }> = [];
/** Each flow's publishability() result, the same object its JSON carries: summary.md repeats it. */
const verdicts: Record<string, Verdict> = {};
function verdict(flow: string, n: number, busy: number | null, isLive = false) {
  const v = publishability(n, busy, isLive);
  verdicts[flow] = { publishable: v.publishable, why_not: v.why_not };
  return v;
}
const allSignatures: string[] = [];
/** Every spend a live product flow landed, for the post-run probes. */
const spendSignatures: Array<{ flow: string; run: string; counted: boolean; sig: string }> = [];

// ------------------------------------------------------------------ native
async function flowNative(busy: number | null) {
  const perProcess = 5; // `const N: usize = 5` in bench_all_circuits.rs
  const invocations = Math.ceil(N / perProcess);
  const cargoArgs = ['test', '-p', 'p01_stark_verifier', '--release', '--test', 'bench_all_circuits'];
  console.log(`\n[native] cargo ${cargoArgs.join(' ')} -- --ignored --nocapture   x ${invocations} process(es) of ${perProcess} samples`);
  if (DRY) return;
  const build = await runChild('cargo', [...cargoArgs, '--no-run'], { log: path.join(RAW, 'native-build.log.txt') });
  if (build.code !== 0) throw new Error('native: cargo build failed, see raw/native-build.log.txt');
  flowWindowStart = Date.now(); // the build is not part of the measured window
  const per: Record<string, { prove_ms: number[]; verify_ms: number[]; bytes: number; process: number[] }> = {};
  for (let i = 1; i <= invocations; i++) {
    const json = path.join(RAW, `native-${i}.json`);
    const r = await runChild('cargo', [...cargoArgs, '--', '--ignored', '--nocapture'], {
      env: { ...process.env, P01_BENCH_OUT: json }, log: path.join(RAW, `native-${i}.log.txt`),
    });
    if (r.code !== 0 || !existsSync(json)) throw new Error(`native: run ${i} failed, see raw/native-${i}.log.txt`);
    const data = JSON.parse(readFileSync(json, 'utf8')) as Record<string, { prove_ms: number[]; verify_ms: number[]; bytes: number }>;
    for (const c of CIRCUITS) {
      const d = data[`C${c}`];
      if (!d) throw new Error(`native: C${c} missing from ${json}`);
      const e = (per[`C${c}`] ??= { prove_ms: [], verify_ms: [], bytes: d.bytes, process: [] });
      e.prove_ms.push(...d.prove_ms);
      e.verify_ms.push(...d.verify_ms);
      e.process.push(...d.prove_ms.map(() => i));
      e.bytes = d.bytes;
    }
    console.log(`  process ${i}/${invocations} done (${(r.ms / 1000).toFixed(1)} s)`);
  }
  const circuits: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(per)) {
    const ps = stat(v.prove_ms)!;
    circuits[k] = { ...v, prove: ps, host_verify: stat(v.verify_ms) };
    summaryRows.push({ flow: 'native', row: `| native | ${k} | prove | ${formatSummary(ps)} | ${v.bytes} B |` });
    console.log(`  ${k} prove  ${formatSummary(ps)}`);
  }
  const n = Math.min(...Object.values(per).map((v) => v.prove_ms.length));
  writeJson('native.json', {
    flow: 'native',
    what_is_timed: 'prove = one generate_*_compact_proof call with a fresh CSPRNG mask; host_verify = parse + phase 1 + phase 2 on the host (the on-chain code, not a CU figure).',
    note: 'bench_all_circuits.rs writes each process\'s samples SORTED, so sample order within a process is not recoverable; `process` says which process a sample came from.',
    samples_per_process: perProcess,
    ...verdict('native', n, busy),
    circuits,
  });
}

// ------------------------------------------------------------------ wasm in Node
async function flowWasmNode(busy: number | null) {
  const child = path.join(HERE, 'wasm-node-child.mts');
  console.log(`\n[wasm-node] warm: 1 process, per circuit 1 discarded warm-up + ${N} proofs; cold: ${COLD_N} fresh process(es) per circuit`);
  if (DRY) return;
  const warm = await runChild(process.execPath, [...TSX, child, '--mode', 'warm', '--n', String(N), '--circuits', CIRCUITS.join(',')], {
    log: path.join(RAW, 'wasm-node-warm.log.txt'),
  });
  const wline = warm.out.split(/\r?\n/).find((l) => l.startsWith('BENCH_JSON '));
  if (warm.code !== 0 || !wline) throw new Error('wasm-node: warm run failed, see raw/wasm-node-warm.log.txt');
  const w = JSON.parse(wline.slice('BENCH_JSON '.length));
  const circuits: Record<string, unknown> = {};
  let nMin = Infinity;
  for (const c of CIRCUITS) {
    const k = `C${c}`;
    const cold: Array<{ init_ms: number; prove_ms: number; init_plus_prove_ms: number; process_wall_ms: number }> = [];
    for (let i = 1; i <= COLD_N; i++) {
      const r = await runChild(process.execPath, [...TSX, child, '--mode', 'cold', '--circuits', String(c)], {
        log: path.join(RAW, `wasm-node-cold-${k}-${i}.log.txt`),
      });
      const line = r.out.split(/\r?\n/).find((l) => l.startsWith('BENCH_JSON '));
      if (r.code !== 0 || !line) throw new Error(`wasm-node: cold ${k} run ${i} failed`);
      const j = JSON.parse(line.slice('BENCH_JSON '.length));
      const p = j.circuits[k].prove_ms[0] as number;
      cold.push({ init_ms: j.init_ms, prove_ms: p, init_plus_prove_ms: j.init_ms + p, process_wall_ms: r.ms });
    }
    const wc = w.circuits[k];
    const warmS = stat(wc.prove_ms)!;
    const coldS = stat(cold.map((x) => x.init_plus_prove_ms))!;
    nMin = Math.min(nMin, wc.prove_ms.length, cold.length);
    circuits[k] = { bytes: wc.bytes, warm: { warmup_ms: wc.warmup_ms, prove_ms: wc.prove_ms, digests: wc.digests, summary: warmS }, cold: { samples: cold, summary: coldS } };
    summaryRows.push({ flow: 'wasm-node', row: `| wasm-node | ${k} | warm prove | ${formatSummary(warmS)} | ${wc.bytes} B |` });
    summaryRows.push({ flow: 'wasm-node', row: `| wasm-node | ${k} | cold init+prove | ${formatSummary(coldS)} | |` });
    console.log(`  ${k} warm ${formatSummary(warmS)}\n  ${k} cold ${formatSummary(coldS)}`);
  }
  writeJson('wasm-node.json', {
    flow: 'wasm-node',
    node: w.node, blob_sha256: w.blob_sha256, blob_bytes: w.blob_bytes, warm_process_init_ms: w.init_ms,
    what_is_timed: 'warm: the export call alone, in an instance that already proved once. cold: initStarkWasm (compile + instantiate) + the first export call, in a brand-new process. process_wall_ms (spawn to exit, includes Node and tsx start-up) is recorded but not summarised.',
    ...verdict('wasm-node', nMin, busy),
    circuits,
  });
}

// ------------------------------------------------------------------ wasm in a browser
const CHROME_CANDIDATES = process.platform === 'win32'
  ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

function killTree(pid: number) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * taskkill /T misses Chrome children whose parent already exited (measured
 * 2026-09-22: 5 chrome.exe left running). Find every process still started
 * with THIS run's --user-data-dir and kill it, then check none remain.
 */
function killProfileLeftovers(profile: string) {
  if (process.platform !== 'win32') return;
  const list = () => {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
      { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout.trim()) return [] as number[];
    const raw = JSON.parse(r.stdout);
    const procs = (Array.isArray(raw) ? raw : [raw]).map((x: any) => ({ pid: Number(x.ProcessId), commandLine: x.CommandLine ?? null }));
    return pidsForProfile(procs, profile);
  };
  // Chrome takes seconds to go after a kill (40-60 s measured on 2026-09-22
  // with the machine loaded), and taskkill sometimes misses the browser process
  // itself: Stop-Process each match, wait, list again, up to ~60 s.
  let left = list();
  for (let round = 0; round < 120 && left.length; round++) {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Stop-Process -Id ${left.join(',')} -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500`],
      { windowsHide: true, stdio: 'ignore' });
    left = list();
  }
  if (left.length) console.log(`  note: ${left.length} browser process(es) of this run are still running: ${left.join(', ')}`);
}

async function flowWasmBrowser(busy: number | null) {
  const choice = opt('browser');
  const manual = choice === 'manual';
  const exe = manual ? '' : (choice ?? CHROME_CANDIDATES.find((p) => existsSync(p)) ?? '');
  if (!manual && !exe) throw new Error('wasm-browser: no Chrome/Edge found; pass --browser <path> or --browser manual');
  const version = manual ? 'manual (reported by the page user agent)' : browserVersion(exe);
  console.log(`\n[wasm-browser] ${manual ? 'manual: open the printed URL in the browser under test' : `${exe} ${version} ${has('headed') ? '(headed)' : '(headless=new)'}`}; per circuit ${COLD_N} cold worker(s) + 1 warm-up + ${N} warm proofs`);
  if (DRY) return;

  const token = randomBytes(12).toString('hex');
  const files: Record<string, { file: string; type: string }> = {
    '/page.html': { file: path.join(HERE, 'browser/page.html'), type: 'text/html; charset=utf-8' },
    '/worker.mjs': { file: path.join(HERE, 'browser/worker.mjs'), type: 'text/javascript; charset=utf-8' },
    '/glue/p01_stark.js': { file: path.join(ROOT, 'packages/stark-prover/wasm/p01_stark.js'), type: 'text/javascript; charset=utf-8' },
    '/wasm/p01_stark_bg.wasm': { file: path.join(ROOT, 'packages/stark-prover/wasm/p01_stark_bg.wasm'), type: 'application/wasm' },
  };
  const progressLog = path.join(RAW, 'wasm-browser-progress.log.txt');
  writeFileSync(progressLog, '');
  let resolveResult!: (v: unknown) => void;
  const got = new Promise((r) => { resolveResult = r; });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST') {
      if (u.searchParams.get('token') !== token) { res.writeHead(403).end(); return; }
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        res.writeHead(204).end();
        if (u.pathname === '/progress') { appendFileSync(progressLog, body + '\n'); process.stdout.write(`  ${body}\n`); }
        if (u.pathname === '/result') resolveResult(JSON.parse(body));
      });
      return;
    }
    if (u.pathname === '/witnesses.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(WITNESSES));
      return;
    }
    const f = files[u.pathname];
    if (!f) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store' }).end(readFileSync(f.file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/page.html?token=${token}&n=${N}&cold=${COLD_N}&circuits=${CIRCUITS.join(',')}`;

  let profile = '';
  let browser: ReturnType<typeof spawn> | null = null;
  if (manual) {
    console.log(`  open this URL in the browser under test, on this machine:\n  ${url}`);
  } else {
    profile = mkdtempSync(path.join(os.tmpdir(), 'styx-bench-profile-'));
    const args = [
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
      ...(has('headed') ? [] : ['--headless=new']), url,
    ];
    // Detached on POSIX so the whole process group can be killed; on Windows the
    // tree is killed with taskkill /T (Chrome's renderer and GPU processes
    // outlive a plain kill of the browser process, measured 2026-09-22).
    browser = spawn(exe, args, { windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' });
  }
  const timeoutMs = Number(opt('browser-timeout-s') ?? 3600) * 1000;
  const result = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('wasm-browser: timed out')), timeoutMs))])
    .finally(() => {
      server.close();
      if (browser?.pid) killTree(browser.pid);
      if (profile) killProfileLeftovers(profile);
    }) as Record<string, any>;
  if (profile) {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { /* a Chrome process still holds a lock */ }
    }
    if (existsSync(profile)) console.log(`  note: could not remove the temporary browser profile ${profile}`);
  }
  writeFileSync(path.join(RAW, 'wasm-browser-result.json'), JSON.stringify(result, null, 2));
  if (result.error) throw new Error(`wasm-browser: the page reported ${result.error}`);

  const circuits: Record<string, unknown> = {};
  let nMin = Infinity;
  for (const [k, r] of Object.entries(result.circuits as Record<string, any>)) {
    const warmS = stat(r.warm as number[])!;
    const coldS = stat((r.cold as any[]).map((x) => x.init_plus_prove_ms))!;
    nMin = Math.min(nMin, r.warm.length, r.cold.length);
    circuits[k] = { bytes: r.bytes, warmup_ms: r.warmup_ms, warm: { prove_ms: r.warm, summary: warmS }, cold: { samples: r.cold, summary: coldS }, digests: r.digests };
    summaryRows.push({ flow: 'wasm-browser', row: `| wasm-browser | ${k} | warm prove | ${formatSummary(warmS)} | ${r.bytes} B |` });
    summaryRows.push({ flow: 'wasm-browser', row: `| wasm-browser | ${k} | cold init+prove | ${formatSummary(coldS)} | |` });
  }
  writeJson('wasm-browser.json', {
    flow: 'wasm-browser',
    browser: manual ? 'manual' : { exe: path.basename(exe), version, headless: !has('headed') },
    user_agent: result.user_agent, hardware_concurrency: result.hardware_concurrency, cross_origin_isolated: result.cross_origin_isolated,
    what_is_timed: 'warm: the export call alone inside a module Web Worker that already proved once. cold: new WebAssembly.Module + initSync + the first export call in a brand-new worker (the blob fetch from the local server is recorded as fetch_ms and NOT counted).',
    ...verdict('wasm-browser', nMin, busy),
    circuits,
  });
}

// ------------------------------------------------------------------ live: STARK pipeline
async function flowStarkPipeline(busy: number | null) {
  const script = path.join(ROOT, 'packages/stark-prover/scripts/live-timing.ts');
  const json = path.join(RAW, 'stark-pipeline.json');
  // --warmup-proofs 1: one DISCARDED proof per circuit before any timed one, so no
  // timed sample carries the lazy wasm compile of the process's first call.
  const args = [...TSX, script, '--v1', '--circuit', CIRCUITS.join(','), '--runs', String(N), '--warmup-proofs', '1', '--json', json];
  console.log(`\n[stark-pipeline] live-timing.ts --v1 --circuit ${CIRCUITS.join(',')} --runs ${N} --warmup-proofs 1 --keypair <key> --rpc-env <env> --json raw/stark-pipeline.json`);
  if (DRY || !live) return;
  const env = { ...process.env, P01_BENCH_RPC_INTERNAL: live.rpcUrl };
  const r = await runChild(process.execPath, [...args, '--keypair', live.keyPath, '--rpc-env', 'P01_BENCH_RPC_INTERNAL'], {
    env, log: path.join(RAW, 'stark-pipeline.log.txt'), echo: true,
  });
  if (r.code !== 0 || !existsSync(json)) throw new Error('stark-pipeline: live-timing failed, see raw/stark-pipeline.log.txt');
  const data = JSON.parse(readFileSync(json, 'utf8')) as { samples: Array<Record<string, any>>; warmup?: Array<{ circuit: number; prove_ms: number }>; prover_state?: string };
  const circuits: Record<string, unknown> = {};
  let nMin = Infinity;
  for (const c of CIRCUITS) {
    const ok = data.samples.filter((s) => s.circuit === c && s.success);
    const failed = data.samples.filter((s) => s.circuit === c && !s.success).length;
    nMin = Math.min(nMin, ok.length);
    const total = stat(ok.map((s) => s.total_ms));
    circuits[`C${c}`] = {
      failed_runs: failed,
      prove: stat(ok.map((s) => s.prove_ms)), pipeline: stat(ok.map((s) => s.pipeline_ms)), total,
      stages: Object.fromEntries(['allocate', 'upload', 'verify', 'close'].map((k) => [k, stat(ok.map((s) => s.stages?.[k]).filter((x) => typeof x === 'number'))])),
    };
    for (const s of data.samples.filter((x) => x.circuit === c)) allSignatures.push(`stark-pipeline C${c} run ${s.run}: ${(s.verify_signatures ?? []).join(' ')}`);
    if (total) summaryRows.push({ flow: 'stark-pipeline', row: `| stark-pipeline | C${c} | prove + pipeline | ${formatSummary(total)} | ${failed} failed |` });
  }
  writeJson('stark-pipeline.json', {
    flow: 'stark-pipeline', rpc_host: live.rpcHost, key: live.keyFingerprint,
    what_is_timed: 'prove (wasm, Node) + allocate + upload (tx v1 chunks) + verify (phase 1 + 2) + close, each to confirmed commitment. The pool instruction that consumes the buffer is NOT included.',
    cold_warm: 'warm prover: one Node process; one discarded warm-up proof per circuit, timed apart in warmup_prove_ms and never in the samples; every timed sample proves a fresh proof and uploads it to a new buffer. The network side has no cache to be cold or warm.',
    prover_state: data.prover_state ?? null,
    warmup_prove_ms: data.warmup ?? [],
    ...verdict('stark-pipeline', nMin === Infinity ? 0 : nMin, busy, true),
    circuits,
    raw: 'raw/stark-pipeline.json',
  });
}

// ------------------------------------------------------------------ live: product flows
async function flowProduct(id: FlowDef['id'], busy: number | null) {
  const def = FLOWS[id];
  const require = createRequire(path.join(WEB, 'package.json'));
  const vitestCli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const config = path.join(HERE, 'flows/vitest.bench.config.mts');
  const baseArgs = [vitestCli, 'run', '--config', config, def.testFile, ...(def.testName ? ['-t', def.testName] : [])];
  // The history cache is read only through liveWorkerShim.ts, which the deposit
  // harness does not import: --cache has no effect there, so the deposit flow
  // runs no warm-up (a warm-up deposit would lock 1 SOL and measure nothing).
  const cacheApplies = id !== 'deposit';
  const cacheMode = cacheApplies ? CACHE : 'not applicable (the deposit harness does not read the history cache)';
  const warmup = cacheApplies && CACHE === 'warm' ? 1 : 0;
  console.log(`\n[${id}] vitest run ${def.testFile}${def.testName ? ` -t "${def.testName}"` : ''}   ${warmup ? '1 warm-up (cache fill, not counted) + ' : ''}${N} run(s), history cache ${cacheApplies ? CACHE : 'n/a'}`);
  if (DRY) {
    // Prove the config resolves, the setup file loads and the harness is found,
    // WITHOUT arming it: every arm flag is removed from the child's environment,
    // so the harness's describe.skipIf(!LIVE) skips and nothing is sent.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
    for (const k of ['P01_LIVE_DEVNET', 'P01_LIVE_BUY', 'P01_LIVE_RELAYED', 'P01_LIVE_RELAY']) delete env[k];
    const r = await runChild(process.execPath, [vitestCli, 'run', '--config', config, def.testFile], { cwd: WEB, env, log: path.join(RAW, `${id}-dry-unarmed.log.txt`) });
    const skipped = /Tests\s+(\d+) skipped/.exec(r.out)?.[1] ?? '0';
    const stamped = r.out.includes('[bench-t ');
    console.log(`  unarmed vitest run: exit ${r.code}, ${skipped} test(s) found and skipped, timestamp setup ${stamped ? 'active' : 'not seen (the harness printed nothing)'}`);
    return;
  }
  if (!live) return;
  const samples: Array<FlowSample & { run: number; counted: boolean; exit: number | null; log: string }> = [];
  let consecutiveFailures = 0;
  for (let i = 1 - warmup; i <= N; i++) {
    const tag = i <= 0 ? 'warmup' : String(i);
    const log = path.join(RAW, `${id}-${tag}.log.txt`);
    // The history cache is keyed by RPC endpoint and holds wallet-side state: it
    // stays in this run's private directory, never under OUT. Cold: this
    // sample's cache file is removed first. Purchase: a record already in place
    // refuses the sample (guards.mts prepareSampleFiles).
    const files = prepareSampleFiles({ privateDir: PRIVATE_DIR, id, tag, cache: CACHE as 'warm' | 'cold' });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [def.armEnv]: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      P01_LIVE_KEYPAIR: live.keyPath,
      P01_LIVE_RPC: live.rpcUrl,
    };
    if (cacheApplies && files.cacheFile) env.P01_LIVE_HISTORY_CACHE = files.cacheFile;
    else delete env.P01_LIVE_HISTORY_CACHE;
    delete env.P01_LIVE_TIMESTAMPS;
    delete env.P01_LIVE_ACK_PUBLIC_PAYER;
    delete env.P01_LIVE_LEAF;
    if (id === 'purchase') {
      env.P01_BASE = live.apiBase;
      // ⛔ NOT under the output directory. While the exchange runs, the record
      // holds the leaf given up, the leaf received and the claim code: a
      // funded-to-issued pair (apps/web/__tests__/lib/docsNoLeafJoin.test.ts)
      // and a bearer code. It stays in this run's private directory, outside the repo.
      env.P01_LIVE_RECORD = files.recordFile!;
    }
    const record = env.P01_LIVE_RECORD;
    const r = await runChild(process.execPath, baseArgs, {
      cwd: WEB, env, log,
      // Every live log loses claim codes, leaf numbers and private paths
      // (flows/scrub.mts); the purchase log also loses, anywhere they appear,
      // the exact claim code, claim proof and sealed note its private record holds.
      scrub: (t) => publishableLog(t, record ? recordSecrets(record) : []),
    });
    const s = parseFlowLog(publishableLog(r.out), def);
    const counted = i >= 1 && s.ok && r.code === 0;
    samples.push({ ...s, run: i, counted, exit: r.code, log: path.relative(OUT, log) });
    allSignatures.push(`${id} run ${tag}: ${s.signatures.join(' ')}`);
    if (s.spend_signature) spendSignatures.push({ flow: id, run: tag, counted, sig: s.spend_signature });
    console.log(`  ${id} ${tag}: ${s.ok && r.code === 0 ? `${(s.product_ms! / 1000).toFixed(2)} s` : `FAILED (exit ${r.code}; ${s.missing.join('; ') || 'test failed'})`}`);
    consecutiveFailures = s.ok && r.code === 0 ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= 3) { console.log(`  ${id}: three failures in a row, stopping this flow.`); break; }
  }
  const good = samples.filter((s) => s.counted);
  const product = stat(good.map((s) => s.product_ms!));
  const phaseNames = def.phases.map((p) => p.name);
  const phases = Object.fromEntries(phaseNames.map((p) => [p, stat(good.map((s) => s.phases[p]).filter((x) => typeof x === 'number'))]));
  const extraNames = (def.extras ?? []).map((e) => e.name);
  const extras = Object.fromEntries(extraNames.map((p) => [p, stat(good.map((s) => s.extras[p]).filter((x) => typeof x === 'number'))]));
  if (product) summaryRows.push({ flow: id, row: `| ${id} | — | product time | ${formatSummary(product)} | ${samples.filter((s) => s.run >= 1 && !s.counted).length} failed |` });
  writeJson(`${id}.json`, {
    flow: id, harness: `apps/web/${def.testFile}`, rpc_host: live.rpcHost, key: live.keyFingerprint, history_cache: cacheMode, warmup_runs: warmup,
    start_marker: String(def.start), stop_marker: String(def.stop),
    ...verdict(id, good.length, busy, true),
    failed_runs: samples.filter((s) => s.run >= 1 && !s.counted).length,
    product, phases, extras, samples,
  });
}

// ------------------------------------------------------------------ post-run probes
/**
 * Plan phase 6: after the live flows, on every spend the run landed,
 *   node verify/p01-verify.mjs --spend <sig> --wallet <measurement key>
 *        --max-root-age 0 --since-slot <first slot of the run> --rpc <url>
 *   node verify/p01-crowd.mjs --spend <sig> --rpc <url>
 * and once `p01-crowd.mjs --pool <the 1 SOL pool>` (the crowd at the end of
 * the run). Logs under raw/probe-*.log.txt, exit codes in probes.json.
 *
 * The verdicts are RECORDED, not claimed. The harnesses fund each ephemeral
 * from the measurement wallet directly (not through the relay), so the probes
 * that trace a funder (P6, P8, P9, P11) are expected to find the measurement
 * key: that is what this benchmark's funding path looks like on chain, not a
 * property of the relay path. The RPC URL is passed on the child's argv (the
 * two tools read no env var), never written to a log, and redacted from their
 * output.
 */
async function runProbes(firstSlot: number | null, poolPda: string | null): Promise<Record<string, unknown>> {
  if (!live) return { skipped: 'no live context' };
  const spends = PROBE_MAX > 0 ? spendSignatures.slice(0, PROBE_MAX) : spendSignatures;
  console.log(`\n[probes] p01-verify + p01-crowd on ${spends.length} spend(s)${firstSlot === null ? ' (no first slot: --since-slot omitted)' : `, --since-slot ${firstSlot}`}`);
  const verify = path.join(ROOT, 'verify/p01-verify.mjs');
  const crowd = path.join(ROOT, 'verify/p01-crowd.mjs');
  const results: Array<Record<string, unknown>> = [];
  const meaning = (c: number | null) => (c === 0 ? 'every probe passed' : c === 1 ? 'a linkage survived (or a channel could not be read)' : 'the tool failed');
  for (const s of spends) {
    const tag = `${s.flow}-${s.run}`;
    const vArgs = [verify, '--spend', s.sig, '--wallet', live.pubkey, '--max-root-age', '0', ...(firstSlot === null ? [] : ['--since-slot', String(firstSlot)]), '--rpc', live.rpcUrl];
    const v = await runChild(process.execPath, vArgs, { log: path.join(RAW, `probe-verify-${tag}.log.txt`) });
    const c = await runChild(process.execPath, [crowd, '--spend', s.sig, '--rpc', live.rpcUrl], { log: path.join(RAW, `probe-crowd-${tag}.log.txt`) });
    results.push({ flow: s.flow, run: s.run, counted: s.counted, spend: s.sig, p01_verify_exit: v.code, p01_verify: meaning(v.code), p01_crowd_exit: c.code, logs: [`raw/probe-verify-${tag}.log.txt`, `raw/probe-crowd-${tag}.log.txt`] });
    console.log(`  ${tag}: p01-verify exit ${v.code} (${meaning(v.code)}), p01-crowd exit ${c.code}`);
  }
  let poolCrowd: number | null = null;
  if (poolPda) poolCrowd = (await runChild(process.execPath, [crowd, '--pool', poolPda, '--rpc', live.rpcUrl], { log: path.join(RAW, 'probe-crowd-pool.log.txt') })).code;
  const out = {
    tools: ['verify/p01-verify.mjs', 'verify/p01-crowd.mjs'],
    since_slot: firstSlot,
    wallet_named: live.keyFingerprint,
    note: 'Verdicts are recorded as printed. The harnesses fund each ephemeral from the measurement wallet directly, so the funder-tracing probes are expected to name it; the relay path is not measured (docs/BENCHMARK-METHOD.md §11).',
    spends_probed: results.length,
    spends_total: spendSignatures.length,
    pool_crowd_exit: poolCrowd,
    results,
  };
  writeJson('probes.json', out);
  return { spends_probed: results.length, file: 'probes.json' };
}

// ------------------------------------------------------------------ main
async function main() {
  mkdirSync(RAW, { recursive: true });
  console.log(`Styx benchmark — flows ${ONLY.join(', ')} — N ${N}${DRY ? ' — DRY RUN (nothing sent, nothing measured)' : ''}`);
  console.log(`output ${OUT}`);
  const busy = DRY ? null : await cpuBusyPercent(3000);
  if (busy !== null) console.log(`machine busy before the run: ${busy.toFixed(1)} % of all logical CPUs${busy > BUSY_LIMIT_PERCENT ? '  (above the limit: results will be marked not publishable)' : ''}`);
  const protocol = readProtocol(ROOT);
  if (protocol.errors.length) console.log(`protocol record incomplete: ${protocol.errors.join('; ')}`);
  const manifest: Record<string, unknown> = {
    tool: 'scripts/bench/run.mts',
    method: 'docs/BENCHMARK-METHOD.md',
    started_at: STARTED_AT,
    dry_run: DRY,
    n: N, cold_n: COLD_N, circuits: CIRCUITS, flows: ONLY, history_cache: CACHE,
    cpu_busy_percent_before: busy,
    // WHICH protocol: v1 as deployed, a pre-v2 (pre-WP10) baseline (protocol.mts).
    protocol,
    founder_fields: {
      rpc_plan_tier: RPC_PLAN,
      node_planned_major: PLANNED_NODE_MAJOR,
      node_running: process.version,
      node_accepted_major: NODE_ACCEPTED,
    },
    live: live ? { cluster: 'devnet', rpc_host: live.rpcHost, key: live.keyFingerprint, api_host: live.apiBase ? new URL(live.apiBase).host : null, first_slot: null as number | null } : null,
    environment: collectEnvironment(ROOT),
  };
  writeJson('manifest.json', manifest);

  let firstSlot: number | null = null;
  if (live && !DRY) {
    await assertDevnetEndpoint(live.rpcUrl);
    console.log(`RPC ${live.rpcHost}: genesis hash is devnet's. Measurement key ${live.keyFingerprint}.`);
    // Read-only: the slot the run starts at (for --since-slot) and which
    // deployment of each program is live.
    firstSlot = await currentSlot(live.rpcUrl);
    (manifest.live as { first_slot: number | null }).first_slot = firstSlot;
    manifest.protocol = { ...protocol, deploy_slots: await readDeploySlots(live.rpcUrl, [protocol.verifier_program_id, protocol.pool_program_id].filter(Boolean)) };
    writeJson('manifest.json', manifest);
    console.log(`first slot of the run ${firstSlot}`);
  }
  if (DRY && liveFlows.length) {
    const plan = fundingReport({
      n: N, cache: CACHE as 'warm' | 'cold', circuits: CIRCUITS,
      flows: liveFlows as LiveFlow[],
      purchaseReusesNote: has('purchase-reuses-note'),
    }, opt('balance') === undefined ? undefined : Number(opt('balance')));
    writeFileSync(path.join(OUT, 'funding-plan.md'), plan + '\n');
    console.log(`\n${plan}\n`);
    console.log(`[probes] after the live flows: p01-verify.mjs --spend <sig> --wallet <key> --max-root-age 0 --since-slot <first slot> and p01-crowd.mjs on every spend${PROBES ? '' : ' — SKIPPED (--probes off)'}`);
  }
  if (DRY && liveFlows.includes('stark-pipeline')) {
    // Proves once per circuit after one discarded warm-up, sends nothing: the live harness itself is sound.
    const r = await runChild(process.execPath, [...TSX, path.join(ROOT, 'packages/stark-prover/scripts/live-timing.ts'), '--dry-run', '--warmup-proofs', '1', '--circuit', CIRCUITS.join(',')], {
      log: path.join(RAW, 'stark-pipeline-dry.log.txt'),
    });
    console.log(`  live-timing --dry-run: exit ${r.code}`);
  }

  const errors: string[] = [];
  startLoadSampler();
  for (const f of ONLY) {
    flowWindowStart = Date.now();
    try {
      if (f === 'native') await flowNative(busy);
      else if (f === 'wasm-node') await flowWasmNode(busy);
      else if (f === 'wasm-browser') await flowWasmBrowser(busy);
      else if (f === 'stark-pipeline') await flowStarkPipeline(busy);
      else await flowProduct(f, busy);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      errors.push(`${f}: ${m}`);
      console.error(`  ${f} FAILED: ${m}`);
    }
  }

  let probes: Record<string, unknown> | string = DRY ? 'dry run' : 'no live product flow';
  if (live && !DRY && liveFlows.some((f) => f !== 'stark-pipeline')) {
    if (!PROBES) probes = 'SKIPPED by --probes off';
    else {
      try {
        probes = await runProbes(firstSlot, protocol.pool?.pool_pda ?? null);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        errors.push(`probes: ${m}`);
        probes = `failed: ${m}`;
      }
    }
  }

  writeJson('manifest.json', { ...manifest, finished_at: new Date().toISOString(), cpu_busy_percent_whole_run: loadSince(0), probes, errors });
  if (allSignatures.length) writeFileSync(path.join(OUT, 'signatures.txt'), allSignatures.join('\n') + '\n');
  // summary.md carries the verdict of every flow (summary.mts): NOT PUBLISHABLE
  // with every reason whenever any flow's JSON says publishable: false, a flow
  // failed or wrote nothing, or the run was dry.
  if (!DRY && (summaryRows.length || errors.length || Object.keys(verdicts).length)) {
    const summary = renderSummary({
      startedAt: STARTED_AT, baseline: protocol.baseline, commit: (manifest.environment as any).tree.commit,
      n: N, coldN: COLD_N, node: process.version, dry: DRY, flows: ONLY, rows: summaryRows, verdicts, errors,
    });
    writeFileSync(path.join(OUT, 'summary.md'), summary);
    if (/NOT PUBLISHABLE/.test(summary)) console.log('summary.md: NOT PUBLISHABLE (reasons in its heading)');
  }
  console.log(`\n${errors.length ? `${errors.length} flow(s) failed` : 'done'} — ${OUT}`);
  // A run that kept nothing private (every dry run, every local-only run) leaves no empty directory behind.
  try { if (readdirSync(PRIVATE_DIR).length === 0) rmSync(PRIVATE_DIR, { recursive: true }); } catch { /* already gone */ }
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL —', e instanceof Error ? e.message : e);
  process.exit(1);
});

