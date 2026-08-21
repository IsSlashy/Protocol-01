/**
 * relayPaymentReceipts — the receipt for a payment that has already left the
 * buyer's wallet, kept until the relay has actually forwarded it.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A relayed deposit is two steps that cannot be one transaction: the buyer pays
 * the till, and then the deployment funds the depositing ephemeral. Between them
 * sits an HTTP call, and that call fails for entirely ordinary reasons — a
 * confirmation timeout, a 429, a 502, or the relay's own 404 "that payment is
 * not on chain yet; confirm it and retry".
 *
 * 🚨 THE BUG THIS CLOSES, AND IT CHARGED THE BUYER TWICE. The payment signature
 * lived in a local `const` and nowhere else. When the relay call threw, the
 * receipt died with the call stack. The ephemeral had received nothing, so the
 * "already holds lamports" guard did not bite, the Deposit button re-enabled,
 * and the retry built and signed a SECOND payment — another full denomination,
 * plus another operator fee. The first payment stayed at the till, which the
 * deployment holds no spending key for, so only an out-of-band refund could
 * return it.
 *
 * The server side was already correct and unreachable: `/api/relay-to-buyer`
 * releases its one-shot claim on every path that hands nothing over, precisely
 * so the same receipt can be presented again. This module is the half that
 * makes that reachable — it keeps the receipt so the retry re-presents it
 * instead of paying again.
 *
 * ⛔ KEYED BY THE EPHEMERAL, NOT BY A RANDOM ID. `deriveShieldEphemeral` is
 * deterministic in (seed, pool, leafIndex), so a retry of the same deposit lands
 * on the SAME key — which is exactly the property that makes it a durable job
 * identity. A random id would be a new job every retry and would remember
 * nothing.
 *
 * ⚠️ MAIN THREAD ONLY, AND THAT IS LOAD-BEARING. `relayEphemeralRecovery`'s
 * store falls back to a module-scope Map inside a Worker, where it dies with the
 * worker — its own header says nothing in apps/web reads it back. Payments are
 * made from `fundEphemeralForJob`, which runs on the main thread because it
 * holds the wallet, so `localStorage` is really there. `storageAvailable()`
 * exists so the caller can REFUSE rather than take money it might not be able to
 * redeem.
 */

const KEY = 'p01_relay_payment_receipts_v1';

export interface RelayPaymentReceipt {
  /** The job identity: deterministic in (seed, pool, leafIndex). */
  ephemeralPubkey: string;
  /** The buyer's payment transaction — the thing the relay is presented. */
  signature: string;
  /** What the buyer paid the till, in lamports. */
  valueLamports: number;
  /** What the buyer paid the fee wallet, in lamports. */
  feeLamports: number;
  /** What the job asked the relay to forward. Part of the reuse identity. */
  requiredLamports: number;
  /** The address that was paid. A rotated till must not be paid twice. */
  till: string;
  /** ISO 8601. For the operator, when a receipt has to be settled by hand. */
  createdAt: string;
}

/**
 * Is there somewhere durable to put a receipt?
 *
 * Probed by writing, not by feature-detecting: Safari in private mode exposes
 * `localStorage` and throws on `setItem`, which a presence check reads as
 * available and a payment discovers afterwards.
 */
export function storageAvailable(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probe = `${KEY}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function readAll(): RelayPaymentReceipt[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RelayPaymentReceipt =>
        !!e &&
        typeof (e as RelayPaymentReceipt).ephemeralPubkey === 'string' &&
        typeof (e as RelayPaymentReceipt).signature === 'string',
    );
  } catch {
    return [];
  }
}

function writeAll(list: RelayPaymentReceipt[]): void {
  // Throws on a full or blocked store, deliberately. The caller writes the
  // receipt BEFORE presenting it to the relay, so a silent failure here would
  // reintroduce exactly the defect this module exists for.
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Record a payment that has already landed. Call before presenting it. */
export function rememberRelayPayment(receipt: RelayPaymentReceipt): void {
  const list = readAll().filter((e) => e.ephemeralPubkey !== receipt.ephemeralPubkey);
  list.push(receipt);
  writeAll(list);
}

/** The receipt for this job, if one is outstanding. */
export function recallRelayPayment(ephemeralPubkey: string): RelayPaymentReceipt | null {
  return readAll().find((e) => e.ephemeralPubkey === ephemeralPubkey) ?? null;
}

/**
 * Drop a receipt once the relay has forwarded it.
 *
 * ⛔ ONLY after the relay reports the lamports moved. Dropping it on a refusal
 * would strand the payment again — the refusal is precisely when the receipt is
 * the only way back to the money.
 */
export function forgetRelayPayment(ephemeralPubkey: string): void {
  const list = readAll().filter((e) => e.ephemeralPubkey !== ephemeralPubkey);
  try {
    writeAll(list);
  } catch {
    // Best effort on the way OUT. A receipt that outlives its use costs a stale
    // entry; failing loudly here would turn a completed deposit into an error.
  }
}

/** Every outstanding receipt, oldest first. For an operator-facing list. */
export function listRelayPayments(): RelayPaymentReceipt[] {
  return readAll().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
