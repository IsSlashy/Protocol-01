/**
 * What is timed in each live product flow, as log markers.
 *
 * The four flows run the app's own worker handlers through the live harnesses
 * in `apps/web/lib/privacy/pool/live*.test.ts` (unchanged). `stamp.setup.ts`
 * prefixes every console line those harnesses print with a high-resolution
 * epoch timestamp `[bench-t 1695...123.4]`, taken in the test process at the
 * moment of the call. This module turns such a log into one sample:
 *
 *   product_ms = t(stop marker) - t(start marker)
 *   phases     = consecutive intervals between the listed phase markers
 *
 * Every marker is a line the harness prints; none is inferred. The start and
 * stop points, and what falls between them, are documented per flow in
 * docs/BENCHMARK-METHOD.md ("Live product flows").
 */

export interface PhaseDef { name: string; end: RegExp }

export interface FlowDef {
  id: 'deposit' | 'withdrawal' | 'subscription' | 'purchase';
  /** Harness file, relative to apps/web. */
  testFile: string;
  /** vitest -t filter, when the file holds more than the test we want. */
  testName?: string;
  /** The env flag that arms that harness. */
  armEnv: 'P01_LIVE_DEVNET' | 'P01_LIVE_BUY';
  start: RegExp;
  stop: RegExp;
  phases: PhaseDef[];
  /** Lines whose base58 signatures are recorded in full. */
  signatureLines: RegExp;
  /**
   * The line that carries the SPEND signature (the pool instruction that
   * consumed a note), for the post-run probes (verify/p01-verify.mjs,
   * verify/p01-crowd.mjs). Absent for the deposit flow, which spends nothing.
   */
  spendLine?: RegExp;
  /** Optional side intervals reported apart from product_ms (never added to it). */
  extras?: Array<{ name: string; from: RegExp; to: RegExp }>;
}

export const FLOWS: Record<FlowDef['id'], FlowDef> = {
  deposit: {
    id: 'deposit',
    testFile: 'lib/privacy/pool/liveDevnetShield.test.ts',
    testName: 'deposits into the 1 SOL V3 pool',
    armEnv: 'P01_LIVE_DEVNET',
    start: /^wallet \S+ — /,
    stop: /SHIELD LANDED:/,
    phases: [
      { name: 'identity_and_prepare', end: /^\s*ephemeral \S+ needs / },
      { name: 'fund_ephemeral', end: /^\s*funded: / },
      { name: 'execute', end: /SHIELD LANDED:/ },
    ],
    signatureLines: /SHIELD LANDED:|^\s*funded: /,
  },
  withdrawal: {
    id: 'withdrawal',
    testFile: 'lib/privacy/pool/liveDevnetUnshieldV4.test.ts',
    armEnv: 'P01_LIVE_DEVNET',
    start: /^\s*payee \S+ \(re-derivable/,
    stop: /V4 WITHDRAWAL LANDED:/,
    phases: [
      { name: 'prepare', end: /^\s*route: v4 / },
      { name: 'fund_ephemeral', end: /^\s*funded \S+ with / },
      { name: 'execute', end: /V4 WITHDRAWAL LANDED:/ },
    ],
    signatureLines: /LANDED:/,
    spendLine: /V4 WITHDRAWAL LANDED:/,
    extras: [
      { name: 'scan', from: /^\s*scan: /, to: /reusing unspent note|no unspent note/ },
      { name: 'shield_leg', from: /no unspent note/, to: /SHIELD LANDED:/ },
    ],
  },
  subscription: {
    id: 'subscription',
    testFile: 'lib/privacy/pool/liveDevnetSubscribeV4.test.ts',
    armEnv: 'P01_LIVE_DEVNET',
    start: /^\s*retailer \S+/,
    stop: /V4 SUBSCRIPTION LANDED:/,
    phases: [
      { name: 'prepare', end: /^\s*route: v4 / },
      { name: 'fund_ephemeral', end: /^\s*funded \S+ with / },
      { name: 'execute', end: /V4 SUBSCRIPTION LANDED:/ },
    ],
    signatureLines: /LANDED:/,
    spendLine: /V4 SUBSCRIPTION LANDED:/,
    extras: [
      { name: 'shield_leg', from: /^\s*funded shield signer /, to: /SHIELD LANDED:/ },
    ],
  },
  purchase: {
    id: 'purchase',
    testFile: 'lib/privacy/pool/liveNoteInExchange.test.ts',
    armEnv: 'P01_LIVE_BUY',
    start: /^\s*unshield-prepare: /,
    stop: /issue-note -> 200/,
    phases: [
      { name: 'prepare', end: /^\s*route v4 / },
      { name: 'fund_ephemeral', end: /^\s*funded \S+ with / },
      { name: 'withdraw_to_till', end: /WITHDRAWAL TO THE TILL:/ },
      { name: 'claim', end: /^\s*CLAIM / },
      { name: 'issue_note', end: /issue-note -> / },
    ],
    signatureLines: /SHIELD LANDED:|WITHDRAWAL TO THE TILL:/,
    spendLine: /WITHDRAWAL TO THE TILL:/,
    extras: [
      { name: 'shield_leg', from: /no unspent note/, to: /SHIELD LANDED:/ },
    ],
  },
};

const STAMP = /^\[bench-t (\d+(?:\.\d+)?)\] ?(.*)$/;
const BASE58_SIG = /\b[1-9A-HJ-NP-Za-km-z]{64,90}\b/g;

export interface StampedLine { t: number; text: string }

export function stampedLines(log: string): StampedLine[] {
  const out: StampedLine[] = [];
  for (const raw of log.split(/\r?\n/)) {
    // vitest may indent or prefix console lines ("stdout | file > test"); find the stamp anywhere.
    const i = raw.indexOf('[bench-t ');
    if (i < 0) continue;
    const m = STAMP.exec(raw.slice(i));
    if (m) out.push({ t: Number(m[1]), text: m[2] });
  }
  return out;
}

export interface FlowSample {
  ok: boolean;
  missing: string[];
  start_epoch_ms: number | null;
  stop_epoch_ms: number | null;
  product_ms: number | null;
  phases: Record<string, number>;
  extras: Record<string, number>;
  signatures: string[];
  /** The spend transaction (see FlowDef.spendLine), or null. */
  spend_signature: string | null;
}

export function parseFlowLog(log: string, def: FlowDef): FlowSample {
  const lines = stampedLines(log);
  const missing: string[] = [];
  const startIdx = lines.findIndex((l) => def.start.test(l.text));
  if (startIdx < 0) missing.push(`start ${def.start}`);
  const stopIdx = startIdx < 0 ? -1 : lines.findIndex((l, i) => i > startIdx && def.stop.test(l.text));
  if (startIdx >= 0 && stopIdx < 0) missing.push(`stop ${def.stop}`);

  const phases: Record<string, number> = {};
  if (startIdx >= 0) {
    let prevT = lines[startIdx].t;
    let from = startIdx;
    for (const ph of def.phases) {
      const j = lines.findIndex((l, i) => i > from && ph.end.test(l.text));
      if (j < 0) { missing.push(`phase ${ph.name}`); break; }
      phases[ph.name] = lines[j].t - prevT;
      prevT = lines[j].t;
      from = j;
    }
  }

  const extras: Record<string, number> = {};
  for (const ex of def.extras ?? []) {
    const a = lines.findIndex((l) => ex.from.test(l.text));
    if (a < 0) continue;
    const b = lines.findIndex((l, i) => i > a && ex.to.test(l.text));
    if (b >= 0) extras[ex.name] = lines[b].t - lines[a].t;
  }

  const signatures: string[] = [];
  for (const l of lines) {
    if (!def.signatureLines.test(l.text)) continue;
    for (const s of l.text.match(BASE58_SIG) ?? []) if (!signatures.includes(s)) signatures.push(s);
  }

  let spend_signature: string | null = null;
  if (def.spendLine) {
    const re = def.spendLine;
    const l = lines.find((x) => re.test(x.text));
    spend_signature = l?.text.match(BASE58_SIG)?.[0] ?? null;
  }

  const ok = missing.length === 0;
  return {
    ok,
    missing,
    start_epoch_ms: startIdx >= 0 ? lines[startIdx].t : null,
    stop_epoch_ms: stopIdx >= 0 ? lines[stopIdx].t : null,
    product_ms: ok ? lines[stopIdx].t - lines[startIdx].t : null,
    phases,
    extras,
    signatures,
    spend_signature,
  };
}
