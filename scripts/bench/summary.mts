/**
 * summary.md, the only file the published tables quote (docs/BENCHMARK-METHOD.md
 * §7). Pure, pinned by summary.test.mts.
 *
 * It carries the publishability verdict of the whole run and of every row: the
 * run is publishable only if it was not a dry run, no flow failed, and every
 * flow it ran recorded `publishable: true` in its <flow>.json. Otherwise the
 * heading says NOT PUBLISHABLE and lists every reason, flow by flow, exactly as
 * the flow's JSON records them (the same objects: run.mts keeps each flow's
 * publishability() result and passes it here).
 */

export interface Verdict { publishable: boolean; why_not: string[] }

export interface SummaryInput {
  startedAt: string;
  baseline: string;
  commit: string;
  n: number;
  coldN: number;
  node: string;
  dry: boolean;
  /** Every flow this run was asked to run, in order. */
  flows: string[];
  /** Table rows, each `| flow | circuit | measure | statistics | note |`, with the flow it belongs to. */
  rows: Array<{ flow: string; row: string }>;
  /** The publishability() result each flow wrote into its JSON. */
  verdicts: Record<string, Verdict>;
  /** `<flow>: <message>` for every flow that threw. */
  errors: string[];
}

/** Every reason the run is not publishable, as `<flow>: <reason>` (or a run-wide reason). Empty: publishable. */
export function runReasons(i: SummaryInput): string[] {
  const out: string[] = [];
  if (i.dry) out.push('run: dry run (nothing was measured)');
  for (const f of i.flows) {
    const err = i.errors.find((e) => e.startsWith(`${f}:`));
    const v = i.verdicts[f];
    if (err) out.push(`${f}: failed (${err.slice(f.length + 1).trim()})`);
    else if (!v) out.push(`${f}: no verdict recorded (the flow wrote no result)`);
    if (v && !v.publishable) for (const w of v.why_not) out.push(`${f}: ${w}`);
  }
  for (const e of i.errors) if (!i.flows.some((f) => e.startsWith(`${f}:`))) out.push(`run: ${e}`);
  return out;
}

export function renderSummary(i: SummaryInput): string {
  const reasons = runReasons(i);
  const rowOk = (flow: string) => !i.dry && i.verdicts[flow]?.publishable === true && !i.errors.some((e) => e.startsWith(`${flow}:`));
  const verdict = reasons.length
    ? [
        '**Verdict: NOT PUBLISHABLE.** No figure below may be quoted as a result. Reasons, as each flow\'s JSON records them:',
        '',
        ...reasons.map((r) => `- ${r}`),
      ]
    : ['**Verdict: publishable.** Every flow of this run passed the checks of docs/BENCHMARK-METHOD.md §5 (`publishable: true` in each flow\'s JSON).'];
  return [
    `# Benchmark run ${i.startedAt}`,
    '',
    `Protocol measured: ${i.baseline}`,
    '',
    `Method: docs/BENCHMARK-METHOD.md. Commit ${i.commit}. N ${i.n}, cold N ${i.coldN}. Node ${i.node}.`,
    '',
    ...verdict,
    '',
    '| flow | circuit | measure | statistics (ms) | note | publishable |',
    '|---|---|---|---|---|---|',
    ...i.rows.map((r) => `${r.row} ${rowOk(r.flow) ? 'yes' : 'no'} |`),
    '',
  ].join('\n');
}
