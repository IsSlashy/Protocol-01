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
  if (valueLamports > 0) {
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
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
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
