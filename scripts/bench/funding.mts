/**
 * How much devnet SOL a live run needs, COMPUTED from the constants the app and
 * its harnesses use. Not a measurement: every constant below names its source,
 * and funding.test.mts re-reads those sources so a constant that drifts fails
 * there.
 *
 *   npx tsx scripts/bench/funding.mts                       # N = 30, all live flows
 *   npx tsx scripts/bench/funding.mts --balance 40          # + the largest N that 40 SOL allows
 *   npx tsx scripts/bench/funding.mts --n 30 --flows deposit,withdrawal --cache cold
 *
 * Model, per sample, in lamports:
 *   net   = what leaves the wallet for good (or until swept back by hand);
 *   start = the balance the sample needs when it starts (floors the harnesses
 *           assert, and the pre-fund peak before rent comes back).
 * The minimum starting balance of a run is max over samples of
 *   (net of every sample before it) + (start of that sample).
 *
 * Facts the model rests on (read in the harness sources, 2026-09-22):
 *   - each harness derives its OWN pool identity (meta 'live-devnet-shield',
 *     'live-devnet-unshield-v4', 'live-devnet-subscribe-v4',
 *     'live-note-in-exchange'), so the withdrawal and subscription flows do NOT
 *     spend the deposit flow's notes: each of their samples deposits a note
 *     first, unless that identity still owns an unspent one;
 *   - a withdrawal pays 0.995 SOL to a payee DERIVED from the key: recoverable
 *     by sweeping that payee by hand, so counted apart as `sweepable`;
 *   - a subscription moves the note into a vault that pays the retailer; the
 *     vault's rent does not come back (subscribeFloat.ts SUBSCRIPTION_VAULT_LEN);
 *   - a purchase gives the note to the deployment's till and receives an older
 *     treasury note sealed to the buyer. Whether the next sample's scan reuses
 *     that note is not established, so the default is the worst case (every
 *     sample deposits); `--purchase-reuses-note` gives the best case (one
 *     deposit for the whole flow). Each purchase sample also consumes ONE note
 *     from the deployment's stock.
 */
import { pathToFileURL } from 'node:url';

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Rent exemption of an account holding `len` bytes: (128 + len) × 3,480 × 2 (subscribeFloat.ts:54-58). */
export const rentExempt = (len: number) => (128 + len) * 3_480 * 2;

export const K = {
  /** A measured devnet deposit: pre-fund 1,573,486,080 − returned 570,010,780 (shieldEphemeral.ts, jitterPrefund comment). */
  depositPrefundMeasured: 1_573_486_080,
  depositReturnedMeasured: 570_010_780,
  /** prefundAmount.ts STEP_LAMPORTS × MAX_EXTRA_STEPS: the most jitter adds to a pre-fund. */
  prefundJitterMax: 10_000_000 * 4,
  /** subscribeFloat.ts NULLIFIER_RENT (budget; the record itself is ~0.0009 SOL). Not recovered. */
  nullifierRent: 2_000_000,
  /** subscribeFloat.ts E_TX_FEE_BUDGET: fee headroom per spend. Counted as spent (upper bound). */
  spendFeeBudget: 4_000_000,
  /** subscribeFloat.ts SUBSCRIPTION_VAULT_LEN and PROOF_BUFFER_HEADER_BYTES. */
  vaultLen: 361,
  proofHeader: 83,
  /** liveDevnetUnshieldV4.test.ts: `expect(balance).toBeGreaterThan(1.8e9)` before anything. */
  withdrawalBalanceFloor: 1_800_000_000,
  /** liveDevnetShield.test.ts: `expect(balance).toBeGreaterThan(0.5e9)`. */
  depositBalanceFloor: 500_000_000,
  /** liveNoteInExchange.test.ts EXPECTED_TILL_CREDIT: 1 SOL minus the 0.5 % unshield fee. */
  spendPayout: 995_000_000,
  /** One system transfer (the harness funds the ephemeral from the wallet). */
  txFee: 5_000,
  /** docs/BENCHMARK-2026-09-13.md: "cost per run 0.000855 SOL of fees" (live-timing, rent recovered). */
  pipelineFeePerRun: 855_000,
  /**
   * Proof sizes on the wire from the shipped blob, read from the 2026-09-22
   * smoke run (sizes, not timings; the 2026-09-23 reship kept them). C7 matches subscribeFloat.ts
   * MEASURED_PROOF_BYTES.c7.
   */
  proofBytes: { 0: 74_365, 1: 94_897, 3: 79_597, 6: 82_477, 7: 79_405 } as Record<number, number>,
} as const;

export const depositNet = K.depositPrefundMeasured - K.depositReturnedMeasured; // 1,003,475,300
const depositStart = Math.max(K.depositBalanceFloor, K.depositPrefundMeasured + K.prefundJitterMax + K.txFee);
const c7BufferRent = rentExempt(K.proofHeader + K.proofBytes[7]!);
const spendFloat = c7BufferRent + K.nullifierRent + K.spendFeeBudget + K.prefundJitterMax + K.txFee;
const spendNet = K.nullifierRent + K.spendFeeBudget + K.txFee;
const vaultRent = rentExempt(K.vaultLen);

export type LiveFlow = 'stark-pipeline' | 'deposit' | 'withdrawal' | 'subscription' | 'purchase';
export const LIVE_ORDER: LiveFlow[] = ['stark-pipeline', 'deposit', 'withdrawal', 'subscription', 'purchase'];

export interface Sample { flow: LiveFlow; net: number; start: number; sweepable: number; stockNotes: number }

export interface PlanOptions {
  n: number;
  flows: LiveFlow[];
  cache: 'warm' | 'cold';
  circuits: number[];
  purchaseReusesNote?: boolean;
}

/** Runs per flow, warm-up included: the history cache applies to the three spend flows only. */
export function runsFor(flow: LiveFlow, n: number, cache: 'warm' | 'cold'): number {
  if (flow === 'stark-pipeline' || flow === 'deposit') return n;
  return n + (cache === 'warm' ? 1 : 0);
}

export function samplesFor(flow: LiveFlow, o: PlanOptions): Sample[] {
  const runs = runsFor(flow, o.n, o.cache);
  const out: Sample[] = [];
  for (let i = 0; i < runs; i++) {
    switch (flow) {
      case 'stark-pipeline':
        for (const c of o.circuits) {
          out.push({ flow, net: K.pipelineFeePerRun, start: rentExempt(K.proofHeader + (K.proofBytes[c] ?? 100_000)) + K.pipelineFeePerRun, sweepable: 0, stockNotes: 0 });
        }
        break;
      case 'deposit':
        out.push({ flow, net: depositNet + K.txFee, start: depositStart, sweepable: 0, stockNotes: 0 });
        break;
      case 'withdrawal':
        out.push({
          flow, net: depositNet + K.txFee + spendNet,
          start: Math.max(K.withdrawalBalanceFloor, depositStart, depositNet + K.txFee + spendFloat),
          sweepable: K.spendPayout, stockNotes: 0,
        });
        break;
      case 'subscription':
        out.push({
          flow, net: depositNet + K.txFee + spendNet + vaultRent,
          start: Math.max(depositStart, depositNet + K.txFee + spendFloat + vaultRent),
          sweepable: 0, stockNotes: 0,
        });
        break;
      case 'purchase': {
        const deposits = !o.purchaseReusesNote || i === 0;
        out.push({
          flow, net: (deposits ? depositNet + K.txFee : 0) + spendNet,
          start: Math.max(deposits ? depositStart : 0, (deposits ? depositNet + K.txFee : 0) + spendFloat),
          sweepable: 0, stockNotes: 1,
        });
        break;
      }
    }
  }
  return out;
}

export interface Need { samples: number; net: number; minStart: number; sweepable: number; stockNotes: number }

/** The minimum starting balance for these samples, in this order. */
export function need(samples: Sample[]): Need {
  let cum = 0;
  let minStart = 0;
  let sweepable = 0;
  let stockNotes = 0;
  for (const s of samples) {
    minStart = Math.max(minStart, cum + s.start);
    cum += s.net;
    sweepable += s.sweepable;
    stockNotes += s.stockNotes;
  }
  return { samples: samples.length, net: cum, minStart, sweepable, stockNotes };
}

export function planNeed(o: PlanOptions): Need & { perFlow: Record<string, Need> } {
  const ordered = LIVE_ORDER.filter((f) => o.flows.includes(f));
  const perFlow: Record<string, Need> = {};
  const all: Sample[] = [];
  for (const f of ordered) {
    const s = samplesFor(f, o);
    perFlow[f] = need(s);
    all.push(...s);
  }
  return { ...need(all), perFlow };
}

/** The largest N (≤ cap) whose minimum starting balance fits in `balanceLamports`; 0 if none. */
export function maxN(balanceLamports: number, o: Omit<PlanOptions, 'n'>, cap = 1000): number {
  let lo = 0;
  let hi = cap;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (planNeed({ ...o, n: mid }).minStart <= balanceLamports) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(3);

export function fundingReport(o: PlanOptions, balanceSol?: number): string {
  const p = planNeed(o);
  const lines = [
    `Devnet SOL needed, COMPUTED from harness constants (scripts/bench/funding.mts), not measured.`,
    `N ${o.n} per flow, history cache ${o.cache}${o.flows.includes('stark-pipeline') ? `, stark-pipeline circuits ${o.circuits.join(',')}` : ''}${o.flows.includes('purchase') ? `, purchase ${o.purchaseReusesNote ? 'best case (the received note is reused)' : 'worst case (every sample deposits)'}` : ''}.`,
    '',
    '| flow | samples (warm-up incl.) | spent SOL | min. starting balance, flow alone | sweepable by hand | deployment stock notes |',
    '|---|---|---|---|---|---|',
    ...Object.entries(p.perFlow).map(([f, x]) => `| ${f} | ${x.samples} | ${sol(x.net)} | ${sol(x.minStart)} | ${sol(x.sweepable)} | ${x.stockNotes} |`),
    `| **all, in run order** | ${p.samples} | ${sol(p.net)} | **${sol(p.minStart)}** | ${sol(p.sweepable)} | ${p.stockNotes} |`,
  ];
  if (balanceSol !== undefined) {
    const b = Math.floor(balanceSol * LAMPORTS_PER_SOL);
    lines.push('', `With ${balanceSol} SOL on the key, the largest N per flow:`, '');
    lines.push('| flow | largest N, flow alone |', '|---|---|');
    const show = (m: number) => (m >= 1000 ? "1000 or more" : String(m));
    for (const f of LIVE_ORDER.filter((x) => o.flows.includes(x))) lines.push(`| ${f} | ${show(maxN(b, { ...o, flows: [f] }))} |`);
    lines.push(`| **all flows in one run, same N** | **${show(maxN(b, o))}** |`);
    lines.push('', 'N below 30 is not publishable (docs/BENCHMARK-METHOD.md §5): a smaller N is a smoke run, or the flows run one at a time with the key refilled in between.');
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const flows = (opt('flows') ?? LIVE_ORDER.join(',')).split(',').map((s) => s.trim()) as LiveFlow[];
  for (const f of flows) if (!LIVE_ORDER.includes(f)) { console.error(`--flows: unknown live flow ${f}`); process.exit(2); }
  const cache = (opt('cache') ?? 'warm') as 'warm' | 'cold';
  const balance = opt('balance');
  console.log(fundingReport({
    n: Number(opt('n') ?? 30), flows, cache,
    circuits: (opt('circuits') ?? '0,1,3,6,7').split(',').map(Number),
    purchaseReusesNote: argv.includes('--purchase-reuses-note'),
  }, balance === undefined ? undefined : Number(balance)));
}
