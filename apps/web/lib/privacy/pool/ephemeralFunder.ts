/**
 * ephemeralFunder — ask this deployment's funder to pay for a pool job, so the
 * user's wallet never signs anything and never appears on chain.
 *
 * WHAT THIS CLOSES, AND WHAT IT DOES NOT
 * ──────────────────────────────────────
 * A pool job is signed by a fresh ephemeral key. That key cannot pay a fee from
 * nothing, so something funds it, and the client sweeps the residue back at the
 * end. Both of those are ordinary public `SystemProgram::transfer`s, and when
 * they point at the user's wallet they bracket the entire operation with the
 * user's name on it. Measured on `verify/fixtures/v3-subscribe`: three RPC calls
 * take a stranger from the subscription to the buyer's wallet. That is the
 * cheapest attack on this protocol.
 *
 * Routing both ends through a shared funder replaces one-wallet-per-user with
 * one treasury shared by everyone this deployment has served.
 *
 * ⛔ THIS DOES NOT ADDRESS PROBE P6, AND AN EARLIER VERSION OF THIS HEADER SAID
 * IT DID
 * ─────────────────────────────────────────────────────────────────────────────
 * P6 fails on ANY named counterparty, not on the user's wallet specifically:
 * `verify/p01-verify.mjs:1219-1237` reports FAIL with `measure = edges.length`
 * the moment one System transfer names anybody. Its PASS branch (:1201-1218)
 * requires that NO transfer in the payer's entire life names a counterparty —
 * structurally unreachable for a fee payer, because a key that was never funded
 * cannot pay a fee, and the sweep must land the account on exactly zero. So the
 * edges stay, the measure stays 2, and the probe stays red. What changes is the
 * ADDRESS WRITTEN IN THEM.
 *
 * What that is worth is arithmetic, not rhetoric: the observer's uncertainty
 * grows by log2 of the number of users the funder is serving concurrently. On a
 * deployment with one user that is log2(1) = ZERO BITS, and
 * `getSignaturesForAddress` on the treasury enumerates every job it ever paid
 * for. This becomes a real improvement when the treasury has real traffic and
 * not before; until then its defensible value is that the wallet stops being
 * `accountKeys[0]`, which is a different and much smaller claim.
 *
 * And it is NOT anonymity in any case: the funder sees the request, its timing
 * and its origin IP. If the funder keeps a log, the link is intact and merely
 * moved off chain. That trade is exactly the one Tornado Cash made with its
 * relayers, and it must be stated to the user in those words rather than
 * implied.
 *
 * ⛔ THE HARD BOUNDARY
 * ────────────────────
 * The funder receives an ADDRESS and an AMOUNT. Never a proof, never a secret,
 * never a signature request. This is not modesty about scope — a third party
 * holding verified C1 and C3 buffers can steal the whole note outright
 * (`retailer` is unconstrained, `rate` is a free argument, `claim_period` is
 * permissionless and there is no `cancel`). The ephemeral key stays in the
 * browser and the client sends its own chunks.
 *
 * ⛔ THREE ADDRESSES, AND WHICH ONE DOES WHAT IS THE WHOLE MECHANISM
 * ─────────────────────────────────────────────────────────────────
 *   R, the till       COLLECTS money from buyers. Never funds anything.
 *   F, the float      FUNDS ephemerals and receives the swept residue.
 *                     Never receives a payment from a buyer.
 *   The fee wallet    RECEIVES the 1% operator fee. A PURE SINK: it collects
 *                     and it does nothing else, ever.
 *
 * R != F is not style. MEASURED 2026-08-18: a subscription passed every probe
 * but P11, and the walk was two hops with no cryptography — the spend's fee
 * payer had been funded by F, and F's own history held a transfer SIGNED BY THE
 * BUYER, one second earlier, for exactly the note's amount. Neither transfer
 * named both ends; the address standing between them named both. Until
 * 2026-08-20 this file asserted R != F in prose and then sent the buyer's money
 * straight to F, so the leak survived the sentence that denied it.
 *
 * R and F may settle with each other, but only in batches on a schedule that
 * has nothing to do with any single purchase. One transfer per purchase is the
 * same leak wearing a second address, and the clock rejoins what the topology
 * separated.
 *
 * 🚨 THE FEE WALLET IS THE MOST DANGEROUS OF THE THREE, BECAUSE IT LOOKS LIKE
 * REVENUE AND REVENUE GETS SPENT.
 *
 * The 1% fee rides in the SAME transaction the buyer signs, so the fee wallet is
 * co-named with EVERY buyer this deployment ever serves. Its
 * `getSignaturesForAddress` history is therefore a global index of buyers — the
 * same property the till has, and the reason both must stay inert. If the fee
 * wallet ever funds an ephemeral, pays F, pays R, or pays anything else
 * traceable, probe P11 walks fee-wallet -> that spend -> whatever it bought, and
 * the return leg lands on a buyer. The till is safe because nobody is tempted to
 * spend from it. The fee wallet is not safe, because someone eventually will.
 * If revenue has to move, it moves to a cold address in batches, on a schedule
 * unrelated to purchases.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

export interface FundingGrant {
  /** Where the residual rent must be swept when the job ends. */
  sweepTo: string;
  /** The funding transaction, so the caller can show or verify it. */
  signature: string;
  lamports: number;
}

/**
 * Whether this deployment has a funder configured.
 *
 * 🚨 `NEXT_PUBLIC_` means this value ships in the browser bundle and is public.
 * That is deliberate and it is NOT authentication: it is a deployment switch, so
 * an operator has to turn the funder on consciously and can turn it off without
 * a redeploy of the route. Anyone who reads the bundle can call the endpoint.
 * The endpoint's real bounds are its per-request cap, its empty-target rule, its
 * per-instance ceiling and its devnet-only guard — all of which limit the damage
 * and none of which stop a determined caller. Do not describe this as secured.
 */
export function funderTicket(): string | null {
  const t = process.env.NEXT_PUBLIC_P01_FUNDER_TICKET;
  return t && t.length > 0 ? t : null;
}

export function funderConfigured(): boolean {
  return funderTicket() !== null;
}

/**
 * Ask the funder to pre-fund `ephemeralPubkey` with `lamports`.
 *
 * Throws on every failure, including "no funder here". Callers decide whether to
 * fall back to the wallet — and if they do, they MUST tell the user, because the
 * fallback silently puts their wallet back on chain and that is the one thing
 * this path exists to prevent.
 */
/**
 * The deployment's funding address, as the readiness endpoint reports it.
 *
 * Read at call time rather than inlined at build: a rotated funder key would
 * otherwise be paid at the old address by every browser still running an old
 * bundle, and those lamports are not recoverable.
 */
let cachedFunderAddress: string | null = null;
let cachedTillAddress: string | null = null;
let cachedFeeWallet: string | null = null;

export function funderAddress(): string {
  if (!cachedFunderAddress) throw new Error('The deployment funding address has not been read yet.');
  return cachedFunderAddress;
}

/**
 * R, the till — the address a buyer's money is actually sent to.
 *
 * Returns `null` rather than throwing, unlike `funderAddress()`. That is not
 * inconsistency: the caller of this has to distinguish "the operator never set a
 * till" from "the till is the funder" from "the fee wallet is missing", and each
 * of those has a different cure the operator has to be told. A throw collapses
 * all of them into one opaque message.
 */
export function tillAddress(): string | null {
  return cachedTillAddress;
}

/**
 * The operator's fee wallet. `null` when the deployment did not declare one.
 *
 * ⛔ PURE SINK. See the header: this address is co-named with every buyer, so
 * anything it ever pays for is one hop from a buyer. It collects and nothing
 * else.
 */
export function feeWalletAddress(): string | null {
  return cachedFeeWallet;
}

/** Test seam: module state otherwise leaks between cases in one file. */
export function resetDeploymentAddresses(): void {
  cachedFunderAddress = null;
  cachedTillAddress = null;
  cachedFeeWallet = null;
}

/**
 * Ask the deployment where to pay, and remember it for this session.
 *
 * 🚨 ALL THREE ADDRESSES ARE WRITTEN TOGETHER, AND ALL THREE ARE CLEARED ON ANY
 * FAILURE. An earlier version read only `funder` and returned early on `!res.ok`
 * and on a network throw WITHOUT touching the cache, so a stale address survived
 * a failed refresh. That was nearly harmless while the buyer paid F — the
 * address had not changed. It stopped being harmless the moment the buyer's
 * money started going to the till: an operator who rotates or removes
 * P01_TILL_ADDRESS, plus one failed refresh, would have this browser keep paying
 * the OLD till — lamports to an address the operator may no longer control, with
 * nothing anywhere reporting an error. Clearing makes the relayed path fail
 * closed (see `DeploymentTillMisconfiguredError`) instead of failing stale.
 *
 * The return type stays `Promise<string | null>` deliberately: `shieldClient` is
 * the only caller and ignores the value, so widening it buys nothing.
 */
export async function loadFunderAddress(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/api/fund-ephemeral', { method: 'GET', signal });
    if (!res.ok) {
      resetDeploymentAddresses();
      return null;
    }
    const body = (await res.json()) as { funder?: string; till?: string; feeWallet?: string };
    cachedFunderAddress = body.funder ?? null;
    cachedTillAddress = body.till ?? null;
    cachedFeeWallet = body.feeWallet ?? null;
    return cachedFunderAddress;
  } catch {
    resetDeploymentAddresses();
    return null;
  }
}

/**
 * Hand the deployment a payment receipt and have it fund the deposit ephemeral.
 *
 * The receipt is a signature, not an amount: the route reads what was actually
 * paid from the chain, because an amount the caller states is an amount the
 * caller chooses.
 */
export async function relayToBuyer(
  paymentSignature: string,
  buyerPubkey: string,
  requiredLamports: number,
  signal?: AbortSignal,
): Promise<{ signature: string; sweepTo: string; lamports: number }> {
  const ticket = funderTicket();
  if (!ticket) throw new Error('This deployment has no funder configured.');
  const res = await fetch('/api/relay-to-buyer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': ticket },
    body: JSON.stringify({ paymentSignature, buyerPubkey, requiredLamports }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    signature?: string;
    lamports?: number;
  };
  if (!res.ok || !body.ok || !body.signature) {
    throw new Error(body.error ?? `the deployment refused to fund the deposit (${res.status})`);
  }
  return {
    signature: body.signature,
    // ⛔ STAYS THE FUNDER, even though the buyer now pays the TILL. F fronted the
    // refundable proof rent, so the residue that comes back IS F's money.
    // "Fixing this for consistency" with the payment target would hand F's rent
    // to an address that never lent it.
    sweepTo: funderAddress(),
    lamports: body.lamports ?? 0,
  };
}

export async function requestFunding(
  ephemeralPubkey: string,
  lamports: number,
  signal?: AbortSignal,
): Promise<FundingGrant> {
  const ticket = funderTicket();
  if (!ticket) throw new Error('This deployment has no funder configured.');

  const res = await fetch('/api/fund-ephemeral', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': ticket },
    body: JSON.stringify({ ephemeralPubkey, lamports }),
    signal,
  });

  // Read the body before checking status: the route reports its refusals as
  // JSON with a reason, and swallowing them would turn "devnet-only guard
  // tripped" into a bare 403 the user cannot act on.
  let body: { ok?: boolean; error?: string; signature?: string; sweepTo?: string; lamports?: number };
  try {
    body = await res.json();
  } catch {
    throw new Error(`The funder replied with a non-JSON ${res.status}.`);
  }
  if (!res.ok || !body.ok) {
    throw new Error(body.error ? `The funder refused: ${body.error}` : `The funder replied ${res.status}.`);
  }
  if (!body.signature || !body.sweepTo) {
    throw new Error('The funder replied without a signature or a sweep address.');
  }

  return { sweepTo: body.sweepTo, signature: body.signature, lamports: body.lamports ?? lamports };
}

/**
 * What the server said about the funder.
 *
 * 🚨 THREE STATES, NOT TWO, AND COLLAPSING THEM COSTS THE USER THEIR PRIVACY.
 * `'none'` and `'unknown'` are different facts with opposite safe behaviours:
 * with no funder, no third-party money can exist and a recovery sweep may go
 * home; with an unreadable answer, treasury money MIGHT be on the key and a
 * sweep home writes the buyer's wallet onto the ephemeral that signed their
 * subscription. That ephemeral is `accountKeys[0]` of the subscribe, so the
 * wallet lands on the subscription itself — and it happens on a Recover click,
 * which is to say AFTER the verification run that said it was clean.
 *
 * An earlier version returned `string | null` and mapped every network failure
 * to `null`, which `resolveSweepDestination` reads as "no funder configured".
 * One transient fetch error was enough.
 */
export type FunderLookup =
  | { state: 'configured'; pubkey: string }
  | { state: 'none' }
  | { state: 'unknown'; reason: string };

/** Cached across calls: the address cannot change without a redeploy, and
 *  recovery asks for it once per pool per run. `undefined` = not asked yet.
 *  Only definitive answers are cached — see `fetchFunderLookup`. */
let cachedFunderPubkey: FunderLookup | undefined;

/**
 * This deployment's funder ADDRESS, or `null` when there is none.
 *
 * Recovery needs this and cannot get it any other way: `recoverFloat` decides
 * where a stranded ephemeral's residue may go from a two-element allowlist —
 * the user's wallet, or the funder — and an unattributable ephemeral is refused
 * rather than swept. Without this call every treasury-funded job that crashed
 * would be refused forever, so a missing answer costs recoveries, not safety.
 *
 * 🚨 It must NOT be read from `funderTicket()`-style `NEXT_PUBLIC_` config. That
 * is inlined at build time, so a deployment that switched its funder on without
 * rebuilding would serve a client that cannot name it — the exact failure that
 * already keeps `funderConfigured()` false in production. This asks the server.
 *
 * Never throws: every caller's fallback for "unknown" is to refuse to attribute
 * a sweep, which is also the right behaviour when the network is down.
 */
export async function fetchFunderLookup(signal?: AbortSignal): Promise<FunderLookup> {
  if (cachedFunderPubkey !== undefined) return cachedFunderPubkey;
  let answer: FunderLookup;
  try {
    const res = await fetch('/api/fund-ephemeral', { method: 'GET', signal });
    const body: { ok?: boolean; configured?: boolean; funder?: string | null } = await res.json();
    if (!res.ok || !body.ok) {
      // A 500, an error page, a proxy interstitial. The deployment did not say
      // "no funder" — it failed to answer, which is a different thing.
      return { state: 'unknown', reason: `the funder endpoint replied ${res.status}` };
    }
    answer = body.configured && body.funder
      ? { state: 'configured', pubkey: body.funder }
      : { state: 'none' };
  } catch (e) {
    // Do NOT cache a network failure: a transient outage would otherwise make
    // every later call in this session act on the assumption that no treasury
    // money can exist, which is the assumption this whole mechanism exists to
    // stop making.
    return { state: 'unknown', reason: e instanceof Error ? e.message : String(e) };
  }
  // Only a definitive answer is memoised.
  cachedFunderPubkey = answer;
  return answer;
}

/**
 * The funder's address, or `null`.
 *
 * ⚠️ Callers that must distinguish "no funder" from "could not tell" MUST use
 * `fetchFunderLookup` instead. This convenience form collapses the two, which
 * is only safe where the consequence of being wrong is cosmetic — rendering a
 * checkbox, say, and not deciding where money goes.
 */
export async function fetchFunderPubkey(signal?: AbortSignal): Promise<string | null> {
  const r = await fetchFunderLookup(signal);
  return r.state === 'configured' ? r.pubkey : null;
}

/** Test seam: drop the memoised answer. */
export function resetFunderPubkeyCache(): void {
  cachedFunderPubkey = undefined;
}

// ---------------------------------------------------------------------------
// The funding decision — one place, every leg
// ---------------------------------------------------------------------------

/** Minimal surface of the things this needs, so it is testable without a chain. */
export interface JobFundingRequest {
  ephemeralPubkey: string;
  /** Total lamports the ephemeral needs before the job can run. */
  requiredLamports: number;
  /**
   * How much of `requiredLamports` is the user's own VALUE rather than float.
   *
   * Non-zero forbids the funder outright. This is the deposit: its pre-fund
   * embeds the denomination plus the 0.3% protocol fee, and 1,003,475,300 of a
   * 1 SOL deposit's 1,573,486,080 never comes back. A treasury covering that is
   * not lending rent, it is buying the user's note — a mint-your-own-note
   * faucet with a public ticket in front of it.
   *
   * ⚠️ The 2 SOL per-request cap does NOT catch this: it refuses only pools of
   * 10 SOL and up, so both demo pools sail under it. The refusal has to be
   * structural and it has to be here.
   */
  valueLamports: number;
  /**
   * The operator's 1% fee, in lamports. Relayed path only.
   *
   * 1% OF THE NOTE DENOMINATION. Never of `valueLamports` (which already carries
   * the 0.3% protocol fee, so a percentage of it would compound) and never of
   * `requiredLamports` (which is mostly refundable rent the deployment fronts).
   *
   * 🚨 IT IS A SEPARATE INSTRUCTION AND IT NEVER ENTERS THE POOL. Folding it
   * into `valueLamports` would deposit denomination + 1%, and the note would
   * stop being exactly the denomination — which is the entire amount-correlation
   * defence: every note in a pool has to be indistinguishable by size. The fee
   * therefore rides as a second `SystemProgram.transfer` in the SAME transaction
   * the buyer already signs, so it costs no extra signature and no extra
   * transaction.
   *
   * ⚠️ Its destination is co-named with the buyer by that transaction. See the
   * pure-sink warning in this file's header before doing anything with it.
   */
  operatorFeeLamports?: number;
  /** The user's wallet: the fallback payer, and the fallback sweep target. */
  owner: PublicKey;
  /**
   * Refuse the job outright rather than let the wallet pay for it.
   *
   * 🚨 WHY THIS IS NOT PARANOIA. Every reason the funder does not serve — a
   * rotated ticket, a drained treasury, a 429, an operator switching it off, a
   * missing KV backend — arrives here as one `catch`, and the fallback then
   * SUCCEEDS. The subscription exists, the user is charged, nothing errors, and
   * their wallet is now `accountKeys[0]` of a public transfer that brackets the
   * whole operation. The failure is not that the funder was unavailable; it is
   * that being unavailable silently changed what the user bought.
   *
   * A user who has been told "your wallet stays off chain" has made a decision.
   * Quietly delivering the other thing because the first was unavailable is the
   * one outcome they cannot detect afterwards and cannot undo. Refusing costs
   * them a retry; falling back costs them the property they came for.
   *
   * Default false, because a deployment with no funder must still work.
   */
  neverExposeWallet?: boolean;
  connection: Connection;
  /** Sign one transaction with the connected wallet. */
  signOne: (tx: Transaction) => Promise<Transaction>;
  /**
   * Route a value-bearing job's funding through the deployment.
   *
   * Without it, the wallet funds the deposit ephemeral directly and is one hop
   * from the deposit — which the spend then republishes. With it, the wallet
   * pays the deployment and the deployment funds the ephemeral: two transfers,
   * neither naming both ends.
   *
   * ⚠️ The residue sweeps to the deployment rather than home, because sweeping
   * home would rebuild the edge. Callers must say so on screen.
   */
  relayThroughDeployment?: boolean;
  onProgress?: (step: string) => void;
}

export interface JobFundingDecision {
  /** Who paid. `'wallet'` means the user's address is on chain for this job. */
  fundedBy: 'wallet' | 'funder';
  /**
   * Where the residual rent must be swept. NON-OPTIONAL on purpose.
   *
   * The two decisions — who funds, where the sweep goes — are one decision.
   * Funding through a third party and then sweeping home is strictly worse than
   * not using a funder at all: it spends someone else's SOL AND still writes the
   * wallet into the newest transaction of the ephemeral's life. An optional
   * field invites exactly that, by omission, silently.
   */
  sweepTo: string;
  /** The funding transaction, when a funder paid. */
  funderSignature?: string;
  /** Why the funder was not used, when one was configured but did not serve. */
  funderFallbackReason?: string;
}

/** Thrown when the ephemeral already holds lamports. Named so callers can
 *  recognise it and point the user at Recover rather than at a retry. */
export class DirtyEphemeralError extends Error {
  constructor(readonly balance: number) {
    super(
      `This job's signing key already holds ${balance} lamports from an earlier attempt. ` +
        'Run Recover first — funding on top of it would mix two parties’ money on a key ' +
        'that can only be swept to one of them.',
    );
    this.name = 'DirtyEphemeralError';
  }
}

/**
 * Thrown when `neverExposeWallet` was set and the funder could not serve.
 *
 * Named so the UI can say the right thing: this is NOT "the subscription
 * failed", it is "the subscription was not made, because making it would have
 * put your wallet on chain and you asked it not to". Nothing was spent and
 * nothing is stranded — the refusal happens before any lamport moves.
 */
export class WalletExposureRefusedError extends Error {
  constructor(readonly funderReason: string) {
    super(
      'Stopped before spending anything: the funder could not cover this job, and paying for it ' +
        `from your own wallet would put your address on chain — which you asked to avoid. The ` +
        `funder said: ${funderReason}`,
    );
    this.name = 'WalletExposureRefusedError';
  }
}

/** Which of the deployment's three addresses is wrong. One reason per cure. */
export type DeploymentTillProblem =
  | 'till-unset'
  | 'till-equals-funder'
  | 'fee-wallet-unset'
  | 'fee-wallet-equals-funder'
  | 'fee-wallet-equals-till'
  | 'addresses-unreadable';

const TILL_PROBLEM_TEXT: Record<DeploymentTillProblem, string> = {
  'till-unset':
    'this deployment did not say which address buyers pay (P01_TILL_ADDRESS is unset), so the ' +
    'only address left to pay is the one that funds the spends — the two-hop walk measured on ' +
    '2026-08-18.',
  'till-equals-funder':
    'the address buyers pay is the SAME address that funds the spends, so paying it puts you one ' +
    'transaction from your own subscription. Two separate keys are required.',
  'fee-wallet-unset':
    'this deployment charges a 1% operator fee but did not say where it goes (P01_FEE_WALLET is ' +
    'unset).',
  'fee-wallet-equals-funder':
    'the operator fee wallet IS the address that funds the spends, so your payment transaction ' +
    'would name that funder directly — exactly the edge this path removes.',
  'fee-wallet-equals-till':
    'the operator fee wallet IS the till. Both credits then land on one account, the deployment ' +
    'reads your payment as larger than it was, and the fee is silently never collected.',
  'addresses-unreadable':
    'this deployment answered with an address that is not a public key, so there is no verified ' +
    'destination to send to.',
};

/**
 * Thrown when the relayed deposit path cannot name three distinct addresses.
 *
 * 🚨 WHY THIS IS ITS OWN ERROR AND NOT `WalletExposureRefusedError`, AND WHY THE
 * DISTINCTION IS LOAD-BEARING RATHER THAN COSMETIC.
 *
 * The reasoning is the same as `SpendFunderNamesWalletError`'s in
 * `shieldClient.ts`. `WalletExposureRefusedError` means "the funder could not
 * serve" — a transient state whose cure is a retry, and the UI treats it that
 * way. This means "the OPERATOR's environment is wrong", and no retry and no
 * different note fixes it: someone has to set P01_TILL_ADDRESS and
 * P01_FEE_WALLET to two fresh keys distinct from the funder. Reusing the other
 * name would send the panel into a retry loop for a problem no retry touches,
 * and would report a treasury problem for a configuration problem.
 *
 * ⛔ THIS MUST NEVER BE CAUGHT INTO A WALLET FALLBACK. Falling back would send
 * the buyer's deposit to the funder — the exact leak this path exists to remove
 * — while every readiness surface still said R != F was wired. A silent fallback
 * makes the founder believe a property holds when it does not, which is worse
 * than the leak, because the leak would at least be looked for.
 *
 * Nothing has moved when this throws: it fires before the blockhash is fetched
 * and before the wallet is asked to sign.
 */
export class DeploymentTillMisconfiguredError extends Error {
  constructor(
    readonly reason: DeploymentTillProblem,
    readonly addresses: { funder: string | null; till: string | null; feeWallet: string | null },
  ) {
    super(
      'Stopped before spending anything: this deployment is misconfigured and ' +
        `${TILL_PROBLEM_TEXT[reason]} Nothing was sent. This is an operator setting, not ` +
        'something a retry or a different note can fix.',
    );
    this.name = 'DeploymentTillMisconfiguredError';
  }
}

/**
 * Decide who pays for one pool job, and pay.
 *
 * WHY THIS IS ONE FUNCTION AND NOT THREE COPIES
 * ─────────────────────────────────────────────
 * This logic lived inline in `subscribeFromPool` and nowhere else, which is
 * precisely why the deposit and withdrawal legs never got it. Three copies of a
 * decision this consequential drift, and the drift is invisible: a leg that
 * forgets the `sweepTo` half still works, still looks right, and quietly puts
 * the wallet back on chain.
 *
 * ⛔ THE HARD BOUNDARY, RESTATED BECAUSE THIS IS WHERE IT WOULD BE CROSSED.
 * This function must never grow a parameter carrying a proof, a secret, or a
 * signature request. A third party holding verified C1 and C3 buffers steals the
 * whole note outright: `retailer` is unconstrained, `rate` and `interval_slots`
 * are free arguments bound to no proof, `claim_period` is permissionless, and
 * there is no `cancel`. The funder gets an ADDRESS and an AMOUNT.
 */
export async function fundEphemeralForJob(
  req: JobFundingRequest,
): Promise<JobFundingDecision> {
  const { ephemeralPubkey, requiredLamports, valueLamports, owner, connection, signOne } = req;

  // ── Guard 1: an ephemeral that is not empty ──────────────────────────────
  //
  // E is deterministic in (seed, pool, leafIndex), so a retry lands on the SAME
  // key a previous attempt stranded money on. The route refuses a non-empty
  // target with a 409, and the old code caught that and fell back to the
  // wallet with `sweepTo = owner` — so a wallet pre-fund landed on top of a
  // stranded treasury grant, and the single-destination sweep at the end handed
  // the whole pile to one party.
  //
  // There is no correct split: every sweep must land a 0-data account on
  // exactly zero, so two destinations means two fees and a residue that fails
  // silently. Refusing BOTH paths is the only outcome where nobody loses, and
  // it costs a Recover click on a key that stays re-derivable forever.
  const existing = await connection.getBalance(new PublicKey(ephemeralPubkey), 'confirmed');
  if (existing > 0) throw new DirtyEphemeralError(existing);

  // Pessimistic defaults: if anything below throws or is skipped, the answer is
  // "the wallet paid and the sweep goes home", which is the true statement
  // about a job nobody else funded.
  let fundedBy: 'wallet' | 'funder' = 'wallet';
  let funderSignature: string | undefined;
  let funderFallbackReason: string | undefined;
  let sweepTo = owner.toBase58();

  // ── Guard 2: never let the treasury buy a note ───────────────────────────
  //
  // Honest about what it is: this stops a future contributor wiring the deposit
  // leg to the funder by analogy. It does NOT stop a stranger — the ticket
  // ships in the browser bundle and anyone can POST the route directly with any
  // amount under the cap. The endpoint's own anti-abuse story is the rate
  // limiter and the devnet guard, not this line.
  if (valueLamports > 0 && req.relayThroughDeployment && funderConfigured()) {
    // ── The relayed deposit ──────────────────────────────────────────────
    //
    // 🚨 THE EDGE THIS EXISTS TO REMOVE. A deposit's ephemeral is funded by
    // somebody, and that somebody is one hop from the deposit — which is one
    // hop from the subscription, because the spend republishes the deposit's
    // commitment in cleartext. MEASURED 2026-08-18: P9 found four edges naming
    // the buyer's wallet from the deposit payer, and P11 found the wallet by
    // listing account keys alone.
    //
    // So the wallet pays R (THE TILL), and F (the float) funds the ephemeral.
    // Two transfers between two DIFFERENT deployment addresses, neither naming
    // both ends — one address in the middle would name both, which is exactly
    // what P11 walked. The wallet is still asked to sign — it is the user's
    // money — but what it signs no longer points at the pool.
    //
    // ✅ THE RESIDUE GOES TO THE DEPLOYMENT AND OWES NOBODY ANYTHING, because
    // the wallet pays only `valueLamports` and the deployment fronts the
    // refundable proof rent on top. The residue that comes back IS that rent.
    //
    // The alternative shapes are both wrong: if the wallet pre-funded the whole
    // amount, sweeping to the deployment would be taking their change, and
    // sweeping home would rebuild the `ephemeral → wallet` edge P9 walked on
    // 2026-08-18 — undoing the entire detour for the sake of returning money
    // that need never have left.
    //
    // ── FAIL CLOSED, BEFORE ANYTHING MOVES ───────────────────────────────
    //
    // Resolved FIRST: before the blockhash, before the wallet is asked to sign,
    // before a single lamport is committed. Until 2026-08-20 this branch sent
    // the buyer's money to `funderAddress()` — that is, to F — while the
    // readiness prose, the env documentation and this file's own header all said
    // the buyer pays R. The assertion existed; the wiring did not.
    //
    // ⛔ THERE IS DELIBERATELY NO `else` HERE THAT FALLS THROUGH TO PAYING F.
    // A fallback would restore precisely the shape that leaked, silently, on a
    // deployment whose operator believes the split is wired. Refusing costs a
    // deposit; falling back costs the property and hides that it is gone.
    const till = tillAddress();
    const feeWallet = feeWalletAddress();
    const addresses = { funder: cachedFunderAddress, till, feeWallet };
    if (!cachedFunderAddress) {
      throw new DeploymentTillMisconfiguredError('addresses-unreadable', addresses);
    }
    if (!till) throw new DeploymentTillMisconfiguredError('till-unset', addresses);
    if (till === cachedFunderAddress) {
      throw new DeploymentTillMisconfiguredError('till-equals-funder', addresses);
    }
    if (!feeWallet) throw new DeploymentTillMisconfiguredError('fee-wallet-unset', addresses);
    if (feeWallet === cachedFunderAddress) {
      throw new DeploymentTillMisconfiguredError('fee-wallet-equals-funder', addresses);
    }
    // 🚨 NOT COSMETIC. web3.js dedupes two identical pubkeys into ONE account
    // index, so a fee wallet equal to the till makes the relay read
    // `value + fee` as the payment: `subsidy = required - received` merely
    // shrinks, nothing errors, and the operator collects no fee while believing
    // they do. A configuration error with no symptom.
    if (feeWallet === till) {
      throw new DeploymentTillMisconfiguredError('fee-wallet-equals-till', addresses);
    }
    let tillKey: PublicKey;
    let feeKey: PublicKey;
    try {
      tillKey = new PublicKey(till);
      feeKey = new PublicKey(feeWallet);
    } catch {
      throw new DeploymentTillMisconfiguredError('addresses-unreadable', addresses);
    }

    // The 1% is the founder's decision and its shape is fixed: it is charged, it
    // is charged on the note's denomination, and it never touches the pool. A
    // missing or nonsensical amount is a CLIENT bug rather than an operator one,
    // and it must be loud — silently charging nothing is invisible revenue loss.
    const operatorFeeLamports = req.operatorFeeLamports ?? 0;
    if (!Number.isSafeInteger(operatorFeeLamports) || operatorFeeLamports <= 0) {
      throw new Error(
        'The relayed deposit path requires a positive operatorFeeLamports (1% of the note ' +
          `denomination); got ${String(req.operatorFeeLamports)}.`,
      );
    }

    req.onProgress?.('Paying the deployment, which will fund the deposit (your wallet stays off the pool)...');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    const payTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner,
        // ⛔ THE TILL, NOT THE FUNDER. This one line is the R != F wiring; the
        // rest of the split is documentation about it.
        toPubkey: tillKey,
        // ⚠️ THE VALUE, NOT THE WHOLE PRE-FUND. The rest is refundable proof
        // rent and the deployment fronts it, so the residue that comes back is
        // the deployment's own and sweeping it there owes the user nothing.
        // Paying it all here would make the residue theirs, and then the only
        // two choices are taking it or rebuilding the edge to send it home.
        //
        // ⛔ AND THE FEE IS NOT IN IT. `/api/relay-to-buyer` reads what was paid
        // from the TILL's balance delta, and the deposited note must be exactly
        // the denomination or notes stop being indistinguishable by size.
        lamports: valueLamports,
      }),
      // The 1% operator fee: a SECOND instruction in the SAME transaction, so
      // the buyer signs once. Separate destination, so the two credits land at
      // two distinct account indices and the relay's till delta is untouched by
      // it — that separation is enforced by the `fee-wallet-equals-till` refusal
      // above, because key equality is the only way web3.js would merge them.
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: feeKey,
        lamports: operatorFeeLamports,
      }),
    );
    payTx.recentBlockhash = blockhash;
    payTx.feePayer = owner;
    const signedPay = await signOne(payTx);
    const paySig = await connection.sendRawTransaction(signedPay.serialize());
    const payConf = await connection.confirmTransaction(
      { signature: paySig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (payConf.value.err) {
      throw new Error(`Payment to the deployment failed: ${JSON.stringify(payConf.value.err)}`);
    }

    req.onProgress?.('The deployment is funding the deposit...');
    // ⚠️ `requiredLamports` UNCHANGED, and the operator fee must never be added
    // to it. Inflating it would forward the fee into the ephemeral, and the
    // ephemeral's whole balance ends up split between the deposited note and the
    // swept residue — so the fee would either land in the pool (breaking the
    // exact-denomination property) or be handed to F instead of the operator.
    const relayed = await relayToBuyer(paySig, ephemeralPubkey, requiredLamports);
    fundedBy = 'funder';
    funderSignature = relayed.signature;
    // ⛔ NOT `owner`. See the residue note above.
    sweepTo = relayed.sweepTo;
  } else if (valueLamports > 0) {
    funderFallbackReason =
      `this job moves ${valueLamports} lamports of your own value, not just rent, so the ` +
      'funder is not asked — covering it would mean the deployment buying your note.';
  } else if (funderConfigured()) {
    try {
      req.onProgress?.('Asking the funder to cover this job (your wallet stays off chain)...');
      const grant = await requestFunding(ephemeralPubkey, requiredLamports);
      fundedBy = 'funder';
      funderSignature = grant.signature;
      sweepTo = grant.sweepTo;
    } catch (e) {
      funderFallbackReason = e instanceof Error ? e.message : String(e);
      req.onProgress?.('The funder could not cover this job — falling back to your wallet.');
    }
  }

  // The refusal, before any lamport moves and before the wallet is even asked
  // to sign. Placed here rather than inside the catch above so it covers BOTH
  // reasons the wallet would otherwise pay: the funder failing, and the funder
  // never having been asked (no funder configured, or a value-bearing job).
  if (fundedBy === 'wallet' && req.neverExposeWallet) {
    throw new WalletExposureRefusedError(
      funderFallbackReason ?? 'this deployment has no funder configured.',
    );
  }

  if (fundedBy === 'wallet') {
    req.onProgress?.('Approve the funding transaction in your wallet...');
    // 🚨 `finalized`, NOT `confirmed`, and only on the transaction a WALLET signs.
    //
    // "Transaction simulation failed: Blockhash not found" with empty logs is
    // what `confirmed` produces here, and the reason is that two different nodes
    // are involved. We fetch the blockhash from OUR RPC; the wallet extension
    // simulates with ITS OWN. A `confirmed` blockhash is seconds old and may not
    // have reached the wallet's node yet — and the gap is not milliseconds, it
    // is however long the human takes to read the popup and press approve.
    //
    // A `finalized` blockhash is one every node already has. It costs a little
    // validity window (~60-90s instead of the full ~120s) and buys the thing
    // that actually matters: the transaction can be simulated by a node we do
    // not control.
    //
    // ⚠️ THIS PARAGRAPH USED TO SAY the ephemeral's own transactions keep
    // `confirmed` deliberately, because we build, sign and submit those through
    // one connection with no human and no second node in between. The premise
    // was wrong: one Connection is one ENDPOINT, not one node, and the provider
    // behind it is load balanced. Measured twice — 2026-08-18 on the proof
    // buffers, 2026-08-19 on the funding route — so every send now takes a
    // `finalized` blockhash through `sendWithFreshBlockhash`.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: new PublicKey(ephemeralPubkey),
        lamports: requiredLamports,
      }),
    );
    fundTx.recentBlockhash = blockhash;
    fundTx.feePayer = owner;

    const signed = await signOne(fundTx);
    const fundSig = await connection.sendRawTransaction(signed.serialize());
    const conf = await connection.confirmTransaction(
      { signature: fundSig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (conf.value.err) {
      throw new Error(`Funding transaction failed: ${JSON.stringify(conf.value.err)}`);
    }
  }

  return { fundedBy, sweepTo, funderSignature, funderFallbackReason };
}
