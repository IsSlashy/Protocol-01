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
 * ⛔ THREE ADDRESSES, AND THE SEPARATION IS THE MECHANISM
 * ──────────────────────────────────────────────────────
 * A relayed deposit touches three, and no two of them may be the same key:
 *
 *   R  the till     collects from buyers. Funds nothing, ever.
 *   F  the float    funds ephemerals and fronts the refundable proof rent, so
 *                   the residue sweeps back to it. Is paid by no buyer.
 *   FEE the sink    takes 1% of the note, inside the buyer's own transaction.
 *                   Only ever receives.
 *
 * MEASURED 2026-08-18: with R and F collapsed into one address, a subscription
 * passed every probe but P11 and the walk was two hops with no cryptography —
 * the spend's fee payer had been funded by F, and F's own history held a
 * transfer signed by the buyer, one second earlier, for exactly the note's
 * amount. Neither transfer named both ends. The address between them named both.
 *
 * That split was written into an env template, a readiness report and several
 * file headers on 2026-08-19, and wired nowhere: this file still paid F and the
 * route still read F's balance delta. Prose is not a mechanism. The mechanism is
 * `fetchRelayTerms` refusing, and `fundEphemeralForJob` paying the address the
 * relay named.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  forgetRelayPayment,
  recallRelayPayment,
  rememberRelayPayment,
  storageAvailable,
} from './relayPaymentReceipts';

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
// ---------------------------------------------------------------------------
// R != F, the 1% operator fee, and the terms this relay will actually serve
// ---------------------------------------------------------------------------

/**
 * The three addresses a relayed deposit touches, and the two ceilings it must
 * fit inside — as `/api/relay-to-buyer` reports them.
 *
 * 🚨 ONE SOURCE, AND IT IS THE ROUTE THAT READS THE PAYMENT. The relay decides
 * whether a buyer paid by measuring the TILL's balance delta in their
 * transaction. If the address the client pays came from anywhere else — a build
 * inlined `NEXT_PUBLIC_`, a different endpoint, a constant in this file — then a
 * rotated till means the buyer pays one address while the relay reads another,
 * and the answer is a 400 AFTER the money has moved to an address this
 * deployment holds no key for. The payer and the reader must read the same
 * variable.
 *
 * The ceilings travel the same way for the same reason: a second copy of a cap
 * is a cap that drifts, and every buyer between the two numbers pays first and
 * is refused after.
 */
export interface RelayTerms {
  /** F, the float. Fronts the refundable proof rent; the residue sweeps here. */
  funder: string;
  /** R, the till. Collects from buyers and funds nothing. */
  till: string;
  /** The operator's fee sink. See `operatorFeeAtomic` for why it is a sink. */
  feeWallet: string;
  /** The most this relay forwards in one call. */
  maxRelayLamports: number;
  /** The most refundable rent it will front on top of a payment. */
  maxRentSubsidyLamports: number;
  /**
   * What the float holds right now, or `null` when the relay could not read it.
   *
   * ⚠️ `null` IS UNKNOWN, NOT ZERO, AND NOT A REFUSAL. An RPC hiccup at the
   * deployment must not delete the only private deposit path — that mistake has
   * been made in this repository before. Refuse on a shortfall you can see;
   * proceed on one you cannot, where the persisted payment receipt makes the
   * retry free.
   */
  funderLamports: number | null;
  /** What the relay's own transfer costs the float, on top of the job. */
  relayFeeLamports: number;
}

/** Why a deployment's own configuration makes a relayed deposit impossible.
 *  Every one of these is the OPERATOR's env being wrong: a retry never fixes
 *  it, so the UI must not offer one. */
export type TillMisconfiguration =
  | 'till-unset'
  | 'till-equals-funder'
  | 'fee-wallet-unset'
  | 'fee-wallet-equals-funder'
  | 'fee-wallet-equals-till'
  | 'addresses-unreadable';

/**
 * Thrown when the deployment cannot name three distinct, parseable addresses.
 *
 * 🚨 NEVER CATCH THIS INTO A WALLET FALLBACK. Each reason is a shape that was
 * measured to leak or to lose money:
 *
 *   till-equals-funder       the 2026-08-18 walk itself. The buyer pays F, so
 *                            F's own history holds a transfer signed by the
 *                            buyer one second before F financed the ephemeral
 *                            that deposits. Two hops, no cryptography.
 *   fee-wallet-equals-funder puts F inside the transaction the buyer signs, so
 *                            the walk loses even its middle step.
 *   fee-wallet-equals-till   web3.js dedupes an identical pubkey into ONE
 *                            account index, so both credits land in one delta:
 *                            the relay reads value + fee as the payment, the
 *                            subsidy merely shrinks, and the operator collects
 *                            no fee at all while believing they do. Nothing
 *                            errors anywhere.
 *   till-unset / unreadable  there is no address to pay. Paying a guessed one
 *                            strands a full denomination.
 */
export class DeploymentTillMisconfiguredError extends Error {
  constructor(readonly reason: TillMisconfiguration, detail: string) {
    super(
      `Stopped before spending anything: this deployment's payment addresses are misconfigured ` +
        `(${reason}). ${detail} Nothing was signed and nothing moved — but only the operator can ` +
        'fix this, so retrying will not help.',
    );
    this.name = 'DeploymentTillMisconfiguredError';
  }
}

/** Why THIS job cannot be relayed. A smaller denomination might be. */
export type RelayRefusal =
  | 'no-funder-configured'
  | 'terms-unreadable'
  | 'deployment-not-ready'
  | 'job-over-relay-cap'
  | 'subsidy-over-cap'
  | 'fee-not-payable-in-lamports'
  | 'fee-basis-missing'
  | 'payment-outstanding'
  | 'no-receipt-store'
  | 'float-too-low';

/**
 * Thrown when the relay cannot serve this particular job.
 *
 * 🚨 NEVER CATCH THIS INTO A WALLET FALLBACK EITHER. A caller that asked to be
 * relayed and silently got the wallet-funded deposit instead has bought the one
 * thing they were avoiding, cannot detect it afterwards, and cannot undo it.
 *
 * MEASURED FROM SOURCE 2026-08-20: a shield needs `denomination * 1.003` plus
 * about 0.57 SOL of refundable proof rent, and the relay forwards at most
 * 2,500,000,000 lamports in one call — so the ceiling binds at a denomination of
 * roughly 1.92 SOL. The 10, 100, 500 and 1000 SOL pools took the buyer's money
 * and delivered NOTHING, 100% of the time, because the refusal happened after
 * the payment instead of before it.
 */
export class RelayCannotServeJobError extends Error {
  constructor(readonly reason: RelayRefusal, detail: string) {
    super(`Stopped before spending anything: this deposit cannot be relayed (${reason}). ${detail}`);
    this.name = 'RelayCannotServeJobError';
  }
}

/**
 * What the 1% is a percentage OF: the pool's own atomic denomination.
 *
 * A structural subset of `PoolConfig`, so the pool table is the only place these
 * numbers are written down.
 */
export interface FeeBasis {
  /** 'SOL' | 'USDC'. Widened to `string` so the pool table can add tokens. */
  token: string;
  /** The denomination in the token's smallest unit — lamports for SOL. */
  denominationAtomic: bigint;
  /** How many of those atoms make one whole token. */
  decimals: number;
}

/** The operator's cut, in basis points of the note. */
export const OPERATOR_FEE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;

/**
 * 1% of the note, in the note's OWN atomic unit.
 *
 * 🚨 THE DEFECT THIS REPLACES, BY ITS NUMBER. The first version of this was
 * `Math.round((denomination * 1e9) / 100)` — the HUMAN denomination times a
 * hard-coded 1e9. That is right for SOL by coincidence, because SOL has nine
 * decimals. On the 1000 USDC pool it charged 10,000,000,000 lamports — TEN SOL —
 * inside a transfer the buyer signs without seeing it itemised.
 *
 * A percentage of atoms needs neither a decimal exponent nor a float, so this
 * function is decimals-blind by construction: `decimals` exists on the basis to
 * let CALLERS decide whether those atoms are lamports, and is deliberately not
 * read here. Integer division floors, which rounds in the buyer's favour by at
 * most one atom.
 *
 * ⛔ THE FEE WALLET IS CO-NAMED WITH EVERY BUYER AND MUST BE A PURE SINK.
 * The fee rides inside the transaction the buyer signs, so the fee wallet
 * appears in an account-key list beside the buyer's own address once per
 * purchase: `getSignaturesForAddress` on it enumerates every buyer this
 * deployment has ever served. That is acceptable ONLY while nothing else it
 * pays for can be joined to a spend. If it ever funds an ephemeral, probe P11
 * walks fee wallet -> ephemeral -> subscription and lands back on the buyer, and
 * the whole R != F split is undone by an accounting convenience. It receives; it
 * never sends into this protocol. `/api/fund-ephemeral` refuses to fund it.
 */
export function operatorFeeAtomic(basis: FeeBasis): bigint {
  return (basis.denominationAtomic * OPERATOR_FEE_BPS) / BPS_DENOMINATOR;
}

/**
 * Ask the relay who to pay and what it will serve.
 *
 * ⚠️ DELIBERATELY NOT CACHED, unlike `fetchFunderLookup` below. This answer is
 * read at most once per deposit and decides where a full denomination is sent
 * irreversibly; a session-long cache would let a browser tab that loaded before
 * a till rotation keep paying the old address. One HTTP round trip against that
 * is not a trade worth making.
 *
 * Throws — never returns a partial answer. A caller that receives `till: null`
 * and pays anyway is the stranding defect, so the null never leaves this
 * function.
 */
export async function fetchRelayTerms(signal?: AbortSignal): Promise<RelayTerms> {
  let body: Record<string, unknown>;
  try {
    const res = await fetch('/api/relay-to-buyer', { method: 'GET', signal });
    if (!res.ok) {
      throw new RelayCannotServeJobError(
        'terms-unreadable',
        `The relay answered ${res.status} when asked what it can serve. An outage is not an ` +
          'all-clear, and paying a guessed address strands the money.',
      );
    }
    body = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof RelayCannotServeJobError) throw e;
    throw new RelayCannotServeJobError(
      'terms-unreadable',
      `The relay could not be asked what it can serve: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!body || body.ok !== true) {
    throw new RelayCannotServeJobError(
      'terms-unreadable',
      'The relay answered, but not with terms it stands behind.',
    );
  }


  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const till = text(body.till);
  const feeWallet = text(body.feeWallet);
  const funder = text(body.funder);

  // Unset before unparseable: they are different operator mistakes with
  // different cures, and "you set it to nonsense" is not the same message as
  // "you did not set it".
  if (!till) {
    throw new DeploymentTillMisconfiguredError(
      'till-unset',
      'The relay names no till (P01_TILL_ADDRESS), so there is no address to pay.',
    );
  }
  if (!feeWallet) {
    throw new DeploymentTillMisconfiguredError(
      'fee-wallet-unset',
      'The relay names no fee wallet (P01_FEE_WALLET).',
    );
  }
  if (!funder) {
    throw new DeploymentTillMisconfiguredError(
      'addresses-unreadable',
      'The relay names no float, so nothing would fund the deposit and the residue would have ' +
        'nowhere to sweep.',
    );
  }

  // Parsed, then compared in canonical form. Comparing raw strings would let two
  // spellings of one key read as two addresses, which is the fee-wallet-equals-
  // till collision arriving through the back door.
  let tillKey: string;
  let feeKey: string;
  let funderKey: string;
  try {
    tillKey = new PublicKey(till).toBase58();
    feeKey = new PublicKey(feeWallet).toBase58();
    funderKey = new PublicKey(funder).toBase58();
  } catch (e) {
    throw new DeploymentTillMisconfiguredError(
      'addresses-unreadable',
      `At least one of the relay's addresses is not a public key: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  if (tillKey === funderKey) {
    throw new DeploymentTillMisconfiguredError(
      'till-equals-funder',
      'The till IS the float. Every buyer who pays it is then one transaction from the address ' +
        'that funds their own subscription — the two-hop walk measured on 2026-08-18.',
    );
  }
  if (feeKey === funderKey) {
    throw new DeploymentTillMisconfiguredError(
      'fee-wallet-equals-funder',
      'The fee wallet IS the float, so the float would appear in the transaction the buyer signs.',
    );
  }
  if (feeKey === tillKey) {
    throw new DeploymentTillMisconfiguredError(
      'fee-wallet-equals-till',
      'The fee wallet IS the till. web3.js merges them into one account index, so the relay would ' +
        'read value + fee as the payment and the fee would never be collected — with no symptom.',
    );
  }

  const maxRelayLamports = Number(body.maxRelayLamports);
  const maxRentSubsidyLamports = Number(body.maxRentSubsidyLamports);
  if (
    !Number.isFinite(maxRelayLamports) ||
    maxRelayLamports <= 0 ||
    !Number.isFinite(maxRentSubsidyLamports) ||
    maxRentSubsidyLamports < 0
  ) {
    throw new RelayCannotServeJobError(
      'terms-unreadable',
      'The relay did not state both of its ceilings, so this client cannot tell whether it would ' +
        'serve this job. Assuming it would is how a buyer pays first and is refused after.',
    );
  }

  // ⛔ `ready` IS THE FIELD TO ACT ON. `ok` IS NOT — AND IT IS CHECKED LAST.
  //
  // 🚨 THE DEFECT THIS CLOSES, AND IT IS THE ONE THE GET WAS WRITTEN TO
  // PREVENT. `ok: true` is a literal in the route — it means "this handler
  // answered", nothing more — and the route publishes `till` and `feeWallet`
  // even when it has already decided it cannot serve. Everything ABOVE this
  // point re-derives the ADDRESS and CEILING mistakes, so those were caught, and
  // only those. Two of the route's non-readiness reasons are invisible from here
  // and always will be:
  //
  //   - `P01_FUNDER_TICKET` unset SERVER-side. The client reads a different
  //     variable (`NEXT_PUBLIC_P01_FUNDER_TICKET`), so it cannot tell.
  //   - no durable KV store reachable, which the POST refuses on before it
  //     reads the chain at all.
  //
  // In either state the addresses are valid and distinct, every check above
  // passes, the wallet signs, and the POST answers 503 — after a full
  // denomination plus the fee have left for an address this deployment holds no
  // spending key for. The receipt then dies with the call stack.
  //
  // ⚠️ LAST, NOT FIRST, AND THE ORDER IS THE POINT. A misconfigured till makes
  // the route report BOTH `ready: false` and the till reason, so checking
  // readiness first would collapse every operator mistake into one untyped
  // 'deployment-not-ready' — and the UI would offer a buyer a smaller
  // denomination for a problem no denomination fixes. The precise
  // `DeploymentTillMisconfiguredError` is raised above; this is the catch-all
  // for everything the client cannot see, carrying the server's own reasons
  // verbatim because they name the env var to fix.
  if (body.ready !== true) {
    const reasons = Array.isArray(body.reasons)
      ? body.reasons.filter((r): r is string => typeof r === 'string')
      : [];
    throw new RelayCannotServeJobError(
      'deployment-not-ready',
      reasons.length > 0
        ? `The relay reports it cannot serve: ${reasons.join(' ')}`
        : 'The relay reports it is not ready to serve, without saying why. Paying it anyway ' +
          'strands the money at an address only the operator can refund.',
    );
  }

  const funderLamports =
    typeof body.funderLamports === 'number' && Number.isFinite(body.funderLamports)
      ? body.funderLamports
      : null;
  const relayFeeLamports =
    typeof body.relayFeeLamports === 'number' && Number.isFinite(body.relayFeeLamports)
      ? body.relayFeeLamports
      : 0;

  return {
    funder: funderKey,
    till: tillKey,
    feeWallet: feeKey,
    funderLamports,
    relayFeeLamports,
    maxRelayLamports,
    maxRentSubsidyLamports,
  };
}

/**
 * Hand the deployment a payment receipt and have it fund the deposit ephemeral.
 *
 * The receipt is a signature, not an amount: the route reads what was actually
 * paid from the chain, because an amount the caller states is an amount the
 * caller chooses.
 *
 * Returns the float the relay actually sent from, so the caller sweeps the
 * residue to the address that fronted the rent rather than to one it assumed.
 */
export async function relayToBuyer(
  paymentSignature: string,
  buyerPubkey: string,
  requiredLamports: number,
  signal?: AbortSignal,
): Promise<{ signature: string; funder: string | null; lamports: number }> {
  const ticket = funderTicket();
  if (!ticket) throw new Error('This deployment has no funder configured.');
  const res = await fetch('/api/relay-to-buyer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-p01-funder-ticket': ticket },
    // ⚠️ `requiredLamports` UNCHANGED, with no fee folded into it. The fee never
    // passes through the ephemeral: money forwarded there ends up either inside
    // the note — breaking the exact denomination every other note in the pool
    // shares — or swept to the float, which is not the operator.
    body: JSON.stringify({ paymentSignature, buyerPubkey, requiredLamports }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    signature?: string;
    lamports?: number;
    funder?: string;
  };
  if (!res.ok || !body.ok || !body.signature) {
    throw new Error(body.error ?? `the deployment refused to fund the deposit (${res.status})`);
  }
  return {
    signature: body.signature,
    funder: typeof body.funder === 'string' ? body.funder : null,
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

/**
 * Drop every remembered address for this deployment.
 *
 * The relay's terms are not cached at all (see `fetchRelayTerms`), so this only
 * has the funder lookup to clear — but callers should not have to know which of
 * the two is memoised, and a future cache added here would otherwise leak
 * between tests and between deployments an operator has just rotated.
 */
export function resetDeploymentAddresses(): void {
  resetFunderPubkeyCache();
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
  /**
   * What the 1% operator fee is a percentage of: the pool's own atomic
   * denomination and its own decimals, straight out of the pool table.
   *
   * REQUIRED for a relayed deposit, and its absence is a refusal rather than a
   * fee of zero. Charging nothing silently is invisible revenue loss, and it is
   * a CLIENT bug — the pool table always has these numbers — so it should be
   * loud where a developer will see it rather than quiet where an accountant
   * will not.
   */
  feeBasis?: FeeBasis;
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
  /**
   * The operator's 1%, in lamports, when a relayed deposit charged it.
   *
   * A RESULT, so the screen can itemise what the buyer's single signature
   * actually moved. It is paid to a third address and never enters the pool, so
   * it appears in no other total the user sees.
   */
  operatorFeeLamports?: number;
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
  let operatorFeeLamports: number | undefined;
  let sweepTo = owner.toBase58();

  // ── Guard 2: never let the treasury buy a note ───────────────────────────
  //
  // Honest about what it is: this stops a future contributor wiring the deposit
  // leg to the funder by analogy. It does NOT stop a stranger — the ticket
  // ships in the browser bundle and anyone can POST the route directly with any
  // amount under the cap. The endpoint's own anti-abuse story is the rate
  // limiter and the devnet guard, not this line.
  if (req.relayThroughDeployment && valueLamports > 0) {
    // ── The relayed deposit ──────────────────────────────────────────────
    //
    // 🚨 THE EDGE THIS EXISTS TO REMOVE. A deposit's ephemeral is funded by
    // somebody, and that somebody is one hop from the deposit — which is one
    // hop from the subscription, because the spend republishes the deposit's
    // commitment in cleartext. MEASURED 2026-08-18: P9 found four edges naming
    // the buyer's wallet from the deposit payer, and P11 found the wallet by
    // listing account keys alone.
    //
    // So the wallet pays the TILL, and the FLOAT funds the ephemeral. Two
    // transfers, neither naming both ends, and — this is the half that was
    // missing until 2026-08-20 — no single address standing in both of them.
    // The wallet is still asked to sign, it is the user's money, but what it
    // signs no longer points at the pool or at the float.
    //
    // ✅ THE RESIDUE GOES TO THE FLOAT AND OWES NOBODY ANYTHING, because the
    // wallet pays only `valueLamports` and the float fronts the refundable
    // proof rent on top. The residue that comes back IS that rent.
    //
    // The alternative shapes are both wrong: if the wallet pre-funded the whole
    // amount, sweeping to the deployment would be taking their change, and
    // sweeping home would rebuild the `ephemeral → wallet` edge P9 walked on
    // 2026-08-18 — undoing the entire detour for the sake of returning money
    // that need never have left.
    //
    // ⛔ THERE IS NO FALLBACK OUT OF THIS BRANCH, AND THE PREVIOUS ATTEMPT
    // CLAIMED THE SAME THING ONE LINE ABOVE AN `else if` THAT WAS ONE. Every
    // exit below is a throw. A caller that asked to be relayed and silently got
    // a wallet-funded deposit instead has bought exactly the linkability they
    // paid a detour to avoid, has no way to detect it afterwards, and no way to
    // undo it. Refusing costs them a retry.
    //
    // ⛔ AND EVERY CHECK COMES BEFORE `signOne`. The buyer's payment is the only
    // irreversible step in this flow — a full denomination sent to an address
    // this deployment holds no spending key for by design — so anything that
    // could refuse must refuse first. The order below is: is the relay
    // reachable at all, is this job priceable, what are the terms, does this job
    // fit them, and only then ask the wallet.
    if (!funderConfigured()) {
      // The stale-bundle case, which this repository has already been bitten by:
      // `NEXT_PUBLIC_P01_FUNDER_TICKET` is inlined at BUILD time, so a
      // deployment that switched the relay on without rebuilding serves a
      // browser that cannot call it. That used to fall through to the wallet.
      throw new RelayCannotServeJobError(
        'no-funder-configured',
        'This browser bundle carries no funder ticket, so the relay cannot be called at all. ' +
          '(NEXT_PUBLIC_P01_FUNDER_TICKET is inlined at build time — setting it without ' +
          'redeploying leaves the bundle unable to reach the relay.)',
      );
    }

    // Priceable before payable: both of these are decided from the job alone,
    // so they cost no round trip and refuse before the network is even touched.
    const basis = req.feeBasis;
    if (!basis) {
      throw new RelayCannotServeJobError(
        'fee-basis-missing',
        'This deposit states no fee basis, so the 1% cannot be computed from the pool it is ' +
          'going into. Charging nothing instead would be silent revenue loss.',
      );
    }
    if (basis.token !== 'SOL' || basis.decimals !== 9) {
      // The fee is a `SystemProgram.transfer` inside the buyer's own
      // transaction, and that instruction moves LAMPORTS. Sending a USDC pool's
      // atoms through it would send 10 SOL-millionths per USDC-millionth of
      // nothing at all; sending their lamport equivalent would need a price
      // feed this deployment does not have. Refusing explicitly is the only
      // honest third option — and it is the shape of the defect it replaces,
      // which charged TEN SOL on a 1000 USDC deposit.
      throw new RelayCannotServeJobError(
        'fee-not-payable-in-lamports',
        `The ${basis.token} pool's fee is ${operatorFeeAtomic(basis)} of its own atoms, and a ` +
          'lamport transfer cannot pay it. Only SOL pools can be relayed until the fee has a ' +
          'token leg of its own.',
      );
    }
    const feeLamports = Number(operatorFeeAtomic(basis));

    req.onProgress?.('Asking the deployment what it can serve...');
    const terms = await fetchRelayTerms();

    // PORTE 2's engine half. MEASURED FROM SOURCE 2026-08-20: the relay forwards
    // at most 2,500,000,000 lamports per call, so the ceiling binds at a
    // denomination of about 1.92 SOL — and the 10, 100, 500 and 1000 SOL pools
    // therefore took the money and delivered nothing, every single time,
    // because this comparison was made by the server AFTER the payment.
    //
    // The numbers come from the deployment rather than from a constant here, on
    // purpose: a second copy of a cap is a cap that drifts, and every buyer
    // between the two copies pays first and is refused after.
    if (requiredLamports > terms.maxRelayLamports) {
      throw new RelayCannotServeJobError(
        'job-over-relay-cap',
        `This deposit needs ${requiredLamports} lamports pre-funded and this relay forwards at ` +
          `most ${terms.maxRelayLamports} in one call. A smaller denomination will go through.`,
      );
    }
    // `subsidy = required - received`, and `received` is what the buyer is about
    // to pay the till: exactly `valueLamports`. The float fronts the rest, which
    // is refundable proof rent and nothing else.
    const subsidy = requiredLamports - valueLamports;
    if (subsidy > terms.maxRentSubsidyLamports) {
      throw new RelayCannotServeJobError(
        'subsidy-over-cap',
        `This deposit asks the deployment to front ${subsidy} lamports of rent and it fronts at ` +
          `most ${terms.maxRentSubsidyLamports}.`,
      );
    }

    // ── Can the float actually pay? ─────────────────────────────────────────
    //
    // 🚨 THE FLOAT SENDS THE WHOLE JOB AND THE BUYER CREDITS IT NOTHING. Before
    // the R != F split the buyer's lamports landed on the float itself, so the
    // call that spent it also topped it up. Now the value goes to the till and
    // the float drains by one pre-fund per deposit until the operator settles R
    // into F in batches — which nothing here implements.
    //
    // MEASURED 2026-08-21: the devnet authority held 1,455,800,000 lamports
    // while one 1 SOL deposit needs 1,573,486,080. Without this check the buyer
    // pays the till, the relay tries to send from an empty float, and they learn
    // it from a 502 with their money already gone.
    //
    // ⚠️ ONLY ON A SHORTFALL THAT CAN BE SEEN. `null` is "the relay could not
    // read its own balance", which is an outage, not a verdict — refusing on it
    // would let one RPC hiccup delete the only private deposit path, and that
    // exact overreach has cost this project a working journey before. On null
    // the deposit proceeds and the persisted receipt is what makes a failure
    // recoverable.
    const floatNeeds = requiredLamports + terms.relayFeeLamports;
    if (terms.funderLamports !== null && terms.funderLamports < floatNeeds) {
      throw new RelayCannotServeJobError(
        'float-too-low',
        `This deployment's float holds ${terms.funderLamports} lamports and this deposit needs ` +
          `${floatNeeds} (${requiredLamports} pre-fund plus ${terms.relayFeeLamports} of relay ` +
          `fee). Nothing was signed and nothing moved. A smaller denomination may fit, or the ` +
          'operator has to settle the till into the float.',
      );
    }

    // ── The receipt for a payment that may already exist ─────────────────
    //
    // 🚨 THE SECOND CHARGE THIS PREVENTS. Everything from here to the relay
    // call is one atomic intention split across two steps that cannot be one
    // transaction. If the second step throws — a confirmation timeout, a 429, a
    // 502, or the relay's own 404 'not on chain yet; confirm it and retry' —
    // the buyer's lamports are already gone. The ephemeral received nothing, so
    // the "already holds lamports" guard above does NOT bite, the Deposit
    // button re-enables, and the naive retry signs a second full denomination
    // plus a second fee. The first payment sits at the till, which this
    // deployment holds no spending key for.
    //
    // The relay releases its one-shot claim on every path that hands nothing
    // over, precisely so the SAME receipt can be presented again. This is the
    // half that makes that reachable.
    const prior = recallRelayPayment(ephemeralPubkey);
    if (prior && (prior.requiredLamports !== requiredLamports || prior.till !== terms.till)) {
      // ⛔ NOT a second payment. The job or the till moved under an outstanding
      // receipt, so neither reusing it nor paying again is safe: reusing it
      // presents a payment for a different job, paying again charges twice. The
      // signature is named so the money is findable.
      throw new RelayCannotServeJobError(
        'payment-outstanding',
        `A payment for this deposit is already on chain (${prior.signature}) for ` +
          `${prior.valueLamports} lamports to ${prior.till}, but this attempt asks for ` +
          `${requiredLamports} to ${terms.till}. Paying again would charge you twice. Settle or ` +
          'clear the outstanding payment first.',
      );
    }
    if (!prior && !storageAvailable()) {
      // Refusing to take money we might not be able to redeem. This browser
      // context cannot keep a receipt (private mode, or storage disabled), so a
      // failure between the payment and the relay would be unrecoverable rather
      // than merely annoying. A refusal costs a retry elsewhere; the
      // alternative costs a denomination.
      throw new RelayCannotServeJobError(
        'no-receipt-store',
        'This browser cannot store the payment receipt, and a relayed deposit pays before it is ' +
          'forwarded. Without somewhere to keep the receipt, an interrupted deposit could not be ' +
          'resumed and would have to be paid for twice. Nothing was signed.',
      );
    }

    let paySig: string;
    if (prior) {
      // Same job, same till, same amount: the money already moved. Present the
      // receipt again rather than making a second one.
      req.onProgress?.('Resuming: your payment already went through, asking the deployment again...');
      paySig = prior.signature;
    } else {
      req.onProgress?.('Paying the deployment, which will fund the deposit (your wallet stays off the pool)...');
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
      const payTx = new Transaction()
        .add(
          SystemProgram.transfer({
            fromPubkey: owner,
            // ⛔ THE TILL, NEVER THE FLOAT. The address the buyer pays must be the
            // one the relay measures — it reads `received` from this account's
            // balance delta — and it must never be the address that funds the
            // ephemeral, or the buyer is one transaction from their own spend.
            toPubkey: new PublicKey(terms.till),
            // ⚠️ THE VALUE, NOT THE WHOLE PRE-FUND, AND NOT THE VALUE PLUS THE
            // FEE. The rest is refundable proof rent the float fronts, so the
            // residue that comes back is the float's own and sweeping it there
            // owes the user nothing. Adding the fee here would put it inside the
            // note, and the note must be EXACTLY the denomination or it stops
            // being indistinguishable from every other note in the pool.
            lamports: valueLamports,
          }),
        )
        .add(
          SystemProgram.transfer({
            fromPubkey: owner,
            // The operator's cut, in the SAME transaction the buyer already
            // signs: no second popup, and — the reason that matters — no way to
            // approve the deposit and drop the fee, which two transactions would
            // hand every buyer for free.
            toPubkey: new PublicKey(terms.feeWallet),
            lamports: feeLamports,
          }),
        );
      payTx.recentBlockhash = blockhash;
      payTx.feePayer = owner;
      const signedPay = await signOne(payTx);
      const sent = await connection.sendRawTransaction(signedPay.serialize());

      // ⛔ WRITTEN BEFORE THE CONFIRMATION, NOT AFTER. `sendRawTransaction` has
      // returned a signature, so the transfer is on the wire and may land whether
      // or not this process ever hears about it. A receipt written only on a
      // successful confirm would be missing in exactly the case it is needed:
      // the confirmation timing out on a payment that landed.
      //
      // Recording a payment that ultimately FAILED on chain is the harmless
      // direction — the relay reads the till's real balance delta and answers
      // 400 'that transaction paid the till nothing', which names the problem.
      rememberRelayPayment({
        ephemeralPubkey,
        signature: sent,
        valueLamports,
        feeLamports,
        requiredLamports,
        till: terms.till,
        createdAt: new Date().toISOString(),
      });
      paySig = sent;

      const payConf = await connection.confirmTransaction(
        { signature: paySig, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (payConf.value.err) {
        // Landed and failed: nothing moved, so the receipt is worthless and
        // keeping it would block the retry that should happen.
        forgetRelayPayment(ephemeralPubkey);
        throw new Error(`Payment to the deployment failed: ${JSON.stringify(payConf.value.err)}`);
      }
    }

    req.onProgress?.('The deployment is funding the deposit...');
    const relayed = await relayToBuyer(paySig, ephemeralPubkey, requiredLamports);
    // The lamports have moved. From here the receipt has done its job and
    // keeping it would make a future deposit on this key resume a spent
    // payment.
    forgetRelayPayment(ephemeralPubkey);
    fundedBy = 'funder';
    funderSignature = relayed.signature;
    operatorFeeLamports = feeLamports;
    // ⛔ NOT `owner`, and NOT the till. The float fronted the rent, so the
    // residue is the float's. The relay names the address it actually sent
    // from; the terms are the fallback for a relay that does not say.
    sweepTo = relayed.funder ?? terms.funder;
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

  return { fundedBy, sweepTo, funderSignature, funderFallbackReason, operatorFeeLamports };
}
