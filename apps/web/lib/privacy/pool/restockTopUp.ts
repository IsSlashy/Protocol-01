/**
 * Move the float's surplus to the restock wallet, on the settlement's clock.
 *
 * THE GAP THIS CLOSES
 * ───────────────────
 * Buyers pay the till. `settle-till` moves the till into the float F, and
 * nowhere else by design. The restock workflow deposits notes from a THIRD
 * key, the restock wallet (`P01_TREASURY_KEYPAIR_JSON`), and stops at its
 * floor. Until 2026-09-02 nothing moved F to the restock wallet: the takings
 * reached F and stopped there, the restock wallet drained to its floor, the
 * workflow logged FLOOR every four hours, and `issue-note` answered 503 to
 * paying customers with SOL sitting one hop away. This is the hop.
 *
 * WHY NOT MAKE THE RESTOCK KEY F
 * ─────────────────────────────
 * Because then F would be the deposit payer of every issued note. F's history
 * is what probe P11 walks, and `relay-to-buyer` already warns that P11 becomes
 * unprovable past the walk limit. A transfer per tick grows F's history by one
 * transaction; a deposit per note grows it by about a hundred.
 *
 * WHAT IT MOVES
 * ─────────────
 * The smaller of: what F holds ABOVE ITS OWN FLOOR, and what the restock
 * wallet is BELOW ITS TARGET. F's floor is the number `settle-till` reports to
 * the operator as `floatRequiredForFloorLamports`: the balance the float needs
 * to reach the batch floor without refusing a deposit. Moving F under that is
 * the deadlock `decideSettlement` names, manufactured by the top-up itself, so
 * the top-up never does. The restock target is the wallet's floor plus enough
 * for one run's worth of deposits (`restockWalletTargetLamports`).
 *
 * 🚨 ON THE SAME CLOCK AS THE SETTLEMENT. The transfer is a public edge from
 * F, and the last thing to land on F is a settlement, which carries a batch of
 * buyers. A top-up minutes after it publishes the settlement's onward path in
 * time and amount, and the restock deposit that follows sits beside both. So
 * this refuses until F has been quiet for the settlement's `minQuietSeconds`,
 * decided by the SAME function (`decideQuietTime`), and refuses when F's
 * history cannot be read, because an unknown clock is not an old one. The
 * clock reads F's newest transaction in EITHER direction: F also funds every
 * ephemeral and receives every sweep, so that is the conservative reading and
 * it costs nothing, since a busy float is exactly a float that must not be
 * seen topping up. The randomised start delay is the caller's
 * (`scripts/topUpRestockWallet.mts`), for the same reason the restock has one.
 *
 * PURE WHERE IT CAN BE. `planTopUp` takes numbers and returns a plan; `runTopUp`
 * reads the chain through a narrow interface a test can stub, and in dry-run
 * mode it reads and decides and never sends.
 */

import type { Connection } from '@solana/web3.js';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import {
  DEFAULT_SETTLEMENT_CONFIG,
  ONE_PURCHASE_LAMPORTS,
  decideQuietTime,
  envInt,
  floatRequiredForBatch,
  settlementConfigFromEnv,
  type SettlementConfig,
} from './settlementPolicy';
import {
  DEFAULT_RESTOCK_CONFIG,
  restockConfigFromEnv,
  restockWalletTargetLamports,
  type RestockConfig,
} from './restockConfig';

/**
 * The smallest transfer worth making, by default one note's value.
 *
 * The restock wallet spends in note-sized units, so a transfer smaller than
 * one note is a public edge that buys no deposit. It accumulates nothing that
 * the next tick would not move in one piece once the surplus is there.
 */
export const DEFAULT_MIN_TOP_UP_LAMPORTS = ONE_PURCHASE_LAMPORTS;

export type TopUpVerdict =
  /** The restock wallet is at or above its target. Ordinary idle state. */
  | 'restock-at-target'
  /** F holds nothing above its own floor. Moving it would deadlock the settler. */
  | 'float-at-floor'
  /** Both sides have room, but the smaller of the two is under the minimum. */
  | 'below-minimum-move'
  /** F's history could not be read. Refuse, never assume old. */
  | 'float-history-unknown'
  /** Something landed on F too recently; a transfer now would sit beside it. */
  | 'too-soon-after-float-activity'
  /** Quiet long enough, but a stored hold has not expired. */
  | 'holding-off'
  /** Go. */
  | 'move';

export interface TopUpInputs {
  funderLamports: number;
  restockLamports: number;
  /**
   * Seconds since the newest transaction on F, in either direction, or `null`
   * if its history could not be read.
   */
  secondsSinceLastFunderActivity: number | null;
  /** A stored hold deadline, if the caller keeps one. The script does not. */
  holdUntilSeconds?: number | null;
  nowSeconds: number;
  settlement?: SettlementConfig;
  restock?: RestockConfig;
  minMoveLamports?: number;
}

export interface TopUpPlan {
  verdict: TopUpVerdict;
  /** What F must keep: `floatRequiredForBatch(minPurchases)`, as settle-till reports it. */
  funderFloorLamports: number;
  /** What F holds above that floor, 0 when none. */
  funderSurplusLamports: number;
  /** What the restock wallet should hold at the start of a tick. */
  restockTargetLamports: number;
  /** What it is short of that, 0 when none. */
  restockDeficitLamports: number;
  /** Filled only on `move`: lamports to transfer, before the network fee. */
  amountLamports: number;
  /** One sentence, safe to show an operator. Names no key. */
  reason: string;
}

/**
 * The whole decision, from numbers already read.
 *
 * Capacity before timing, as in `decideSettlement`: "nothing to do" and "F is
 * at its floor" need different reactions from a human, and a run that reports
 * a timing refusal over an empty float hides the one that needs capital.
 */
export function planTopUp(input: TopUpInputs): TopUpPlan {
  const settlement = input.settlement ?? DEFAULT_SETTLEMENT_CONFIG;
  const restock = input.restock ?? DEFAULT_RESTOCK_CONFIG;
  const minMove = input.minMoveLamports ?? DEFAULT_MIN_TOP_UP_LAMPORTS;

  const funderFloorLamports = floatRequiredForBatch(settlement.minPurchases);
  const funderSurplusLamports = Math.max(0, input.funderLamports - funderFloorLamports);
  const restockTargetLamports = restockWalletTargetLamports(restock);
  const restockDeficitLamports = Math.max(0, restockTargetLamports - input.restockLamports);

  const base = {
    funderFloorLamports,
    funderSurplusLamports,
    restockTargetLamports,
    restockDeficitLamports,
    amountLamports: 0,
  };
  const sol = (n: number) => (n / 1e9).toFixed(4);

  if (restockDeficitLamports <= 0) {
    return {
      ...base,
      verdict: 'restock-at-target',
      reason:
        `The restock wallet holds ${sol(input.restockLamports)} SOL, at or above its target of ` +
        `${sol(restockTargetLamports)} SOL. Nothing to move.`,
    };
  }

  if (funderSurplusLamports <= 0) {
    return {
      ...base,
      verdict: 'float-at-floor',
      reason:
        `The float holds ${sol(input.funderLamports)} SOL and must keep ${sol(funderFloorLamports)} ` +
        `SOL to reach the batch floor of ${settlement.minPurchases} purchase(s) without refusing a ` +
        `deposit. Moving any of it would deadlock the settler. The restock wallet stays ` +
        `${sol(restockDeficitLamports)} SOL short until the till settles or the operator funds the float.`,
    };
  }

  const amountLamports = Math.min(funderSurplusLamports, restockDeficitLamports);
  if (amountLamports < minMove) {
    return {
      ...base,
      verdict: 'below-minimum-move',
      reason:
        `The float can spare ${sol(funderSurplusLamports)} SOL and the restock wallet is short ` +
        `${sol(restockDeficitLamports)} SOL, so the transfer would be ${sol(amountLamports)} SOL, ` +
        `under the ${sol(minMove)} SOL minimum. A transfer smaller than one note buys no deposit.`,
    };
  }

  const quiet = decideQuietTime(
    {
      secondsSinceLastActivity: input.secondsSinceLastFunderActivity,
      holdUntilSeconds: input.holdUntilSeconds ?? null,
      nowSeconds: input.nowSeconds,
    },
    settlement,
  );
  const since = input.secondsSinceLastFunderActivity;

  if (quiet.verdict === 'history-unknown' || since === null) {
    return {
      ...base,
      verdict: 'float-history-unknown',
      reason:
        'The float\'s recent history could not be read, so how long ago it was last touched is ' +
        'unknown. Refusing: an unknown clock is not an old one.',
    };
  }

  if (quiet.verdict === 'too-soon') {
    return {
      ...base,
      verdict: 'too-soon-after-float-activity',
      reason:
        `The float was last touched ${Math.round(since / 60)} minute(s) ago. A transfer sent now ` +
        `sits beside it on a public clock. Waiting ${Math.ceil(quiet.waitSeconds / 60)} more minute(s).`,
    };
  }

  if (quiet.verdict === 'holding-off') {
    return {
      ...base,
      verdict: 'holding-off',
      reason: 'Eligible, but a stored hold has not expired.',
    };
  }

  return {
    ...base,
    verdict: 'move',
    amountLamports,
    reason:
      `Moving ${sol(amountLamports)} SOL from the float to the restock wallet, ` +
      `${since >= 86400 ? `${Math.floor(since / 86400)} day(s)` : `${Math.round(since / 3600)} hour(s)`} ` +
      `after the float was last touched.`,
  };
}

/**
 * The part of a `Connection` this needs, so a test can stub it without a
 * network and a real `Connection` satisfies it without a wrapper.
 */
export type TopUpChain = Pick<
  Connection,
  | 'getBalance'
  | 'getSignaturesForAddress'
  | 'getLatestBlockhash'
  | 'getFeeForMessage'
  | 'sendTransaction'
  | 'confirmTransaction'
>;

export interface RunTopUpOptions {
  chain: TopUpChain;
  /** The float. The only signer, and the only thing that leaves it is the transfer. */
  funder: Keypair;
  /** The restock wallet's PUBLIC key. Its secret is never needed here. */
  restockWallet: PublicKey;
  /** Read and decide, never send. */
  dryRun: boolean;
  nowSeconds?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TopUpResult {
  plan: TopUpPlan;
  dryRun: boolean;
  funder: string;
  restockWallet: string;
  funderLamports: number;
  restockLamports: number;
  secondsSinceLastFunderActivity: number | null;
  /** The network fee the transfer paid, or `null` when nothing was sent. */
  feeLamports: number | null;
  /** Lamports actually sent, after the fee. 0 when nothing moved. */
  sentLamports: number;
  signature: string | null;
}

/**
 * How long ago F was last touched, in seconds.
 *
 * Newest-first is the RPC's default and, as in `settle-till`, the one place
 * it is wanted. Any direction counts (see the header), and an empty history
 * reads as unknown: a float with no transactions has nothing to move anyway.
 */
async function secondsSinceLastFunderActivity(
  chain: TopUpChain,
  funder: PublicKey,
  nowSeconds: number,
): Promise<number | null> {
  try {
    const sigs = await chain.getSignaturesForAddress(funder, { limit: 1 });
    const t = sigs[0]?.blockTime;
    if (typeof t !== 'number') return null;
    return Math.max(0, nowSeconds - t);
  } catch {
    return null;
  }
}

/** Read the balances and the clock, decide, and (unless dry) send. */
export async function runTopUp(o: RunTopUpOptions): Promise<TopUpResult> {
  const env = o.env ?? process.env;
  const nowSeconds = o.nowSeconds ?? Math.floor(Date.now() / 1000);
  const settlement = settlementConfigFromEnv(env);
  const restock = restockConfigFromEnv(env);
  const minMoveLamports = envInt('P01_TOPUP_MIN_LAMPORTS', DEFAULT_MIN_TOP_UP_LAMPORTS, env);

  const [funderLamports, restockLamports] = await Promise.all([
    o.chain.getBalance(o.funder.publicKey),
    o.chain.getBalance(o.restockWallet),
  ]);
  const since = await secondsSinceLastFunderActivity(o.chain, o.funder.publicKey, nowSeconds);

  const plan = planTopUp({
    funderLamports,
    restockLamports,
    secondsSinceLastFunderActivity: since,
    nowSeconds,
    settlement,
    restock,
    minMoveLamports,
  });

  const result: TopUpResult = {
    plan,
    dryRun: o.dryRun,
    funder: o.funder.publicKey.toBase58(),
    restockWallet: o.restockWallet.toBase58(),
    funderLamports,
    restockLamports,
    secondsSinceLastFunderActivity: since,
    feeLamports: null,
    sentLamports: 0,
    signature: null,
  };

  if (plan.verdict !== 'move' || o.dryRun) return result;

  const { blockhash, lastValidBlockHeight } = await o.chain.getLatestBlockhash('finalized');
  const build = (lamports: number) =>
    new Transaction({
      feePayer: o.funder.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: o.funder.publicKey,
        // The destination is the public key the caller derived from the
        // restock keypair, never a request field. There is no third party
        // this can pay.
        toPubkey: o.restockWallet,
        lamports,
      }),
    );

  // The fee comes out of F on top of the transfer, so it is taken off the
  // amount to keep F at or above its floor exactly. Asked rather than assumed,
  // as the settler does.
  let fee = 5000;
  try {
    const got = await o.chain.getFeeForMessage(build(1).compileMessage(), 'confirmed');
    if (typeof got.value === 'number' && got.value > 0) fee = got.value;
  } catch {
    /* keep the default */
  }

  const lamports = plan.amountLamports - fee;
  if (lamports <= 0) {
    throw new Error(`the top-up (${plan.amountLamports} lamports) is smaller than the network fee (${fee})`);
  }

  const signature = await o.chain.sendTransaction(build(lamports), [o.funder], {
    skipPreflight: false,
    maxRetries: 3,
  });
  await o.chain.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

  return { ...result, feeLamports: fee, sentLamports: lamports, signature };
}

/** One line for a log. Public keys and amounts only; nothing here can be a secret. */
export function formatTopUpLine(r: TopUpResult): string {
  const sol = (n: number) => (n / 1e9).toFixed(4);
  const quiet =
    r.secondsSinceLastFunderActivity === null
      ? 'unknown'
      : `${Math.floor(r.secondsSinceLastFunderActivity / 3600)}h${Math.floor((r.secondsSinceLastFunderActivity % 3600) / 60)}m`;
  return (
    `top-up ${r.dryRun ? 'dry-run' : 'live'} verdict=${r.plan.verdict} ` +
    `float=${r.funder} ${sol(r.funderLamports)} SOL (floor ${sol(r.plan.funderFloorLamports)}, ` +
    `surplus ${sol(r.plan.funderSurplusLamports)}) ` +
    `restock=${r.restockWallet} ${sol(r.restockLamports)} SOL (target ${sol(r.plan.restockTargetLamports)}, ` +
    `deficit ${sol(r.plan.restockDeficitLamports)}) quiet=${quiet} ` +
    `moved=${sol(r.sentLamports)} SOL sig=${r.signature ?? 'none'}: ${r.plan.reason}`
  );
}
