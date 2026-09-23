/**
 * Where a run may write. resolveOutDir and smallestSampleCount are pure (path
 * arithmetic only); the private-directory helpers touch the file system. All
 * pinned by guards.test.mts.
 *
 *   - A dry run measures nothing publishable, but `live-timing.ts --dry-run`
 *     still prints proving times. So a dry run NEVER writes under docs/bench:
 *     with no --out it goes to <temp>/styx-bench-dry/<date>, and an --out under
 *     docs/bench is refused.
 *   - A measuring run with N below the publishable minimum never writes under
 *     docs/bench either: smoke runs go to a scratch directory. "N" is the
 *     smallest sample count any row of the run gets (smallestSampleCount):
 *     --cold-n counts too when a wasm flow writes cold rows.
 *   - The comparison is made with the platform's path rules: on Windows,
 *     case-insensitive, and a path on another drive is never "under".
 *
 * And the private directory (history caches, purchase records, unscrubbed logs):
 *   - every run gets a NEW, empty one (makePrivateRunDir), so a --cache cold
 *     sample never reads a cache an earlier run left, and a purchase sample
 *     never resumes an earlier run's record (liveNoteInExchange.test.ts resumes
 *     from <record>.progress.json when it exists);
 *   - before each sample (prepareSampleFiles) a cold sample's cache file is
 *     removed; a purchase record already in place refuses the sample instead of
 *     being deleted, because it may hold an unredeemed claim code.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface OutDirInput {
  root: string;
  out?: string;
  dry: boolean;
  n: number;
  minN: number;
  date: string;
  /** One directory per run under docs/bench/<date>/, so two runs of one day never mix (re-verifier r2). */
  runId?: string;
  tmpDir: string;
  /** path.win32 or path.posix in tests; the platform's own by default. */
  pathApi?: typeof path;
}

export function isUnder(parent: string, child: string, p: typeof path = path): boolean {
  const rel = p.relative(p.resolve(parent), p.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

export function resolveOutDir(i: OutDirInput): { out: string; refused?: string } {
  const p = i.pathApi ?? path;
  const docsBench = p.join(i.root, 'docs', 'bench');
  const out = p.resolve(i.out ?? (i.dry ? p.join(i.tmpDir, 'styx-bench-dry', i.date) : (i.runId ? p.join(docsBench, i.date, i.runId) : p.join(docsBench, i.date))));
  const under = isUnder(docsBench, out, p);
  if (i.dry && under) {
    return { out, refused: '--dry-run never writes under docs/bench (a dry run still prints proving times). Pass --out <a scratch directory>, or leave --out out to use the temp directory.' };
  }
  if (!i.dry && under && i.n < i.minN) {
    return { out, refused: `${i.n} samples per row is below ${i.minN} (--n, and --cold-n when a wasm flow runs). Smoke runs go to --out <a scratch directory>, never under docs/bench.` };
  }
  return { out };
}

/** The wasm flows write cold rows with --cold-n samples; every other row has N (native: at least N). */
const COLD_ROW_FLOWS = new Set(['wasm-node', 'wasm-browser']);

/** The smallest number of samples any row of this run can get: what the docs/bench guard must check. */
export function smallestSampleCount(i: { n: number; coldN: number; flows: readonly string[] }): number {
  return i.flows.some((f) => COLD_ROW_FLOWS.has(f)) ? Math.min(i.n, i.coldN) : i.n;
}

/**
 * A new, empty private directory for this run under `base`: `<started_at>-XXXXXX`
 * (mkdtemp, so two runs started in the same millisecond still differ). Never
 * reused, never shared with another run.
 */
export function makePrivateRunDir(base: string, startedAt: string): string {
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, `run-${startedAt.replace(/[:.]/g, '-')}-`));
}

export interface SampleFiles {
  /** P01_LIVE_HISTORY_CACHE for this sample; null where the harness reads none (deposit). */
  cacheFile: string | null;
  /** P01_LIVE_RECORD for a purchase sample; null otherwise. */
  recordFile: string | null;
}

/**
 * The private files one live sample uses, made safe to use:
 *   - warm: one cache file per flow, shared by the warm-up and every sample (a
 *     returning user); it is what a warm sample measures, so it is kept;
 *   - cold: one cache file per sample, REMOVED if present, so the sample starts
 *     with an empty pool-history cache;
 *   - purchase: if the record or its .progress.json already exists, the harness
 *     would resume from it (skip the withdrawal, the claim and the issue), so
 *     the sample is refused; the file is left in place (it may hold a claim code).
 */
export function prepareSampleFiles(i: { privateDir: string; id: string; tag: string; cache: 'warm' | 'cold' }): SampleFiles {
  let cacheFile: string | null = null;
  if (i.id !== 'deposit') {
    cacheFile = i.cache === 'warm'
      ? path.join(i.privateDir, `${i.id}-history-cache.json`)
      : path.join(i.privateDir, `${i.id}-history-cache-${i.tag}.json`);
    if (i.cache === 'cold') rmSync(cacheFile, { force: true });
  }
  let recordFile: string | null = null;
  if (i.id === 'purchase') {
    recordFile = path.join(i.privateDir, `purchase-record-${i.tag}.json`);
    for (const f of [recordFile, `${recordFile}.progress.json`]) {
      if (existsSync(f)) {
        throw new Error(`purchase sample ${i.tag}: ${path.basename(f)} already exists in the private directory; the harness would resume from it instead of measuring a whole purchase. Left in place (it may hold a claim code).`);
      }
    }
  }
  return { cacheFile, recordFile };
}

/**
 * A run never writes into a directory that already holds files: a second run
 * into the same --out used to overwrite manifest.json and summary.md and leave
 * the first run's <flow>.json and raw logs behind with nothing describing them.
 */
export function nonEmptyOutRefusal(out: string, entries: readonly string[]): string | undefined {
  return entries.length
    ? `--out ${out} is not empty (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}). Every run writes into a directory of its own; pass a new --out.`
    : undefined;
}

/**
 * The processes left by this run's headless browser, found by the run's own
 * --user-data-dir: taskkill /T misses Chrome children whose parent already
 * exited (measured 2026-09-22: 5 chrome.exe left behind). Matches the exact
 * profile path, quoted or not, and never another profile that shares a prefix.
 */
export function pidsForProfile(
  procs: readonly { pid: number; commandLine: string | null }[],
  profile: string,
): number[] {
  const want = profile.toLowerCase();
  return procs
    .filter((x) => {
      const cl = (x.commandLine ?? '').toLowerCase();
      for (const m of cl.matchAll(/--user-data-dir=("([^"]*)"|(\S+))/g)) {
        if ((m[2] ?? m[3]) === want) return true;
      }
      return false;
    })
    .map((x) => x.pid);
}
