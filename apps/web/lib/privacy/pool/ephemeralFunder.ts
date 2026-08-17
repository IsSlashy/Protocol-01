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

/** Cached across calls: the address cannot change without a redeploy, and
 *  recovery asks for it once per pool per run. `undefined` = not asked yet. */
let cachedFunderPubkey: string | null | undefined;

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
export async function fetchFunderPubkey(signal?: AbortSignal): Promise<string | null> {
  if (cachedFunderPubkey !== undefined) return cachedFunderPubkey;
  try {
    const res = await fetch('/api/fund-ephemeral', { method: 'GET', signal });
    const body: { ok?: boolean; configured?: boolean; funder?: string | null } = await res.json();
    cachedFunderPubkey = res.ok && body.ok && body.configured && body.funder ? body.funder : null;
  } catch {
    // Do NOT cache a network failure as "no funder": a transient outage would
    // then make every later recovery in this session sweep on the assumption
    // that no treasury money can exist, which is the assumption this whole
    // mechanism exists to stop making.
    return null;
  }
  return cachedFunderPubkey;
}

/** Test seam: drop the memoised address. */
export function resetFunderPubkeyCache(): void {
  cachedFunderPubkey = undefined;
}
