/**
 * Summary statistics for the benchmark. Pure functions, no dependencies, so the
 * unit test runs on a bare `node --test` (Node 24 strips the type annotations).
 *
 * Definitions (written down in docs/BENCHMARK-METHOD.md, section "Statistics"):
 *
 *   median  the middle value of the sorted samples; for an EVEN n, the mean of
 *           the two middle values. (The Rust bench and live-timing.ts used to
 *           print `sorted[n / 2]`, which for an even n is the upper of the two.)
 *   p90     nearest-rank percentile: the smallest sample such that at least
 *           90 % of the samples are <= it, i.e. sorted[ceil(0.9 * n) - 1]. It is
 *           always a value that was actually observed, never an interpolation.
 *   spread  max - min, in the unit of the samples.
 *   ratio   max / min (how many times slower the slowest sample was).
 */

export interface Summary {
  n: number;
  min: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
  spread: number;
  ratio: number | null;
}

function checked(xs: readonly number[]): number[] {
  if (!Array.isArray(xs) || xs.length === 0) {
    throw new Error('stats: no samples');
  }
  for (const x of xs) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new Error(`stats: non-finite sample ${String(x)}`);
    }
  }
  return [...xs].sort((a, b) => a - b);
}

export function median(xs: readonly number[]): number {
  const s = checked(xs);
  const n = s.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Nearest-rank percentile. `p` is an integer percent in 1..100, so the rank is
 * computed in integers (`ceil(p * n / 100)`) and 0.9 * 30 cannot round to 27.000000000000004.
 */
export function percentile(xs: readonly number[], p: number): number {
  if (!Number.isInteger(p) || p < 1 || p > 100) {
    throw new Error(`stats: percentile must be an integer in 1..100, got ${p}`);
  }
  const s = checked(xs);
  const rank = Math.ceil((p * s.length) / 100);
  return s[rank - 1];
}

export function p90(xs: readonly number[]): number {
  return percentile(xs, 90);
}

export function summarize(xs: readonly number[]): Summary {
  const s = checked(xs);
  const min = s[0];
  const max = s[s.length - 1];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    min,
    median: median(s),
    p90: p90(s),
    max,
    mean,
    spread: max - min,
    ratio: min > 0 ? max / min : null,
  };
}

/** Round every number of a summary for display; the JSON keeps full precision. */
export function formatSummary(sm: Summary, unit = 'ms', digits = 0): string {
  const f = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  return `n ${sm.n}  min ${f(sm.min)}  median ${f(sm.median)}  p90 ${f(sm.p90)}  max ${f(sm.max)}  spread ${f(sm.spread)} ${unit}` +
    (sm.ratio === null ? '' : `  (max/min ${sm.ratio.toFixed(2)})`);
}
