import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  type ParsedMessageAccount,
  type PartiallyDecodedInstruction,
  type ParsedInstruction,
  type ConfirmedSignatureInfo,
} from '@solana/web3.js';

/**
 * SPL memo program (v2 — the modern CPI-friendly variant).
 * `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`
 */
export const MEMO_PROGRAM_V2 = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

/**
 * Older v1 memo program — still in use by some legacy clients.
 * `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo`
 */
export const MEMO_PROGRAM_V1 = new PublicKey(
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
);

/**
 * Prefix the mobile client attaches to one-shot payments:
 * `p01:<service-slug>:<caller-suffix>`.
 */
export const MEMO_INVOICE_PREFIX = 'p01:';

export interface ParsedInvoiceMemo {
  /** Full raw memo string. */
  raw: string;
  /** Service slug encoded in the memo (e.g. `netflix-standard`). */
  slug: string;
  /** Remaining components (duration, nonce, ...). */
  extras: string[];
}

/**
 * Parse a Protocol 01 invoice memo (`p01:<slug>:<...>`). Returns `null`
 * if the memo shape does not match.
 */
export function parseInvoiceMemo(memo: string): ParsedInvoiceMemo | null {
  if (!memo.startsWith(MEMO_INVOICE_PREFIX)) return null;
  const rest = memo.slice(MEMO_INVOICE_PREFIX.length);
  const [slug, ...extras] = rest.split(':');
  if (!slug) return null;
  return { raw: memo, slug, extras };
}

// ---------------------------------------------------------------------------
// Single-signature verification
// ---------------------------------------------------------------------------

export interface PaymentReceipt {
  signature: string;
  /** Slot the payment was included in. */
  slot: number;
  /** Block time in seconds (null if not yet confirmed). */
  blockTime: number | null;
  /** Destination pubkey (the retailer). */
  retailer: PublicKey;
  /** Amount credited to the retailer in lamports. */
  lamports: bigint;
  /** Convenience SOL value (may lose precision for large amounts). */
  sol: number;
  /** Parsed invoice memo, if present. */
  memo: ParsedInvoiceMemo | null;
  /** All program IDs invoked in the TX. */
  programsInvoked: string[];
}

export interface VerifyPaymentOptions {
  /** Optional — reject the payment if the memo slug does not match. */
  expectedSlug?: string;
  /** Optional — reject if lamports are less than this. */
  minLamports?: bigint;
  /** RPC commitment to fetch the TX at. `getParsedTransaction` requires a
   *  `Finality` level (no `processed`). Default `confirmed`. */
  commitment?: 'confirmed' | 'finalized';
}

/**
 * Fetch a signature and assert it credited `retailer` with lamports.
 * Returns a `PaymentReceipt` on success; throws on any mismatch.
 *
 * Works for:
 *   - Plain SOL transfers with a memo (wallet one-shot path).
 *   - `unshield_denominated_stark` payments whose recipient is the retailer
 *     (ZK one-shot path) — balance delta on the retailer is inspected
 *     instead of parsing the instruction directly.
 */
export async function verifyOneShotPayment(
  connection: Connection,
  signature: string,
  retailer: PublicKey,
  opts: VerifyPaymentOptions = {},
): Promise<PaymentReceipt> {
  const parsed = await connection.getParsedTransaction(signature, {
    commitment: opts.commitment ?? 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed) {
    throw new Error(`transaction ${signature} not found (may still be pending)`);
  }
  if (parsed.meta?.err) {
    throw new Error(
      `transaction ${signature} failed on-chain: ${JSON.stringify(parsed.meta.err)}`,
    );
  }

  const accountKeys = parsed.transaction.message.accountKeys;
  const retailerIdx = findAccountIndex(accountKeys, retailer);
  if (retailerIdx < 0) {
    throw new Error(`retailer ${retailer.toBase58()} not referenced in TX ${signature}`);
  }

  const pre = parsed.meta?.preBalances?.[retailerIdx] ?? 0;
  const post = parsed.meta?.postBalances?.[retailerIdx] ?? 0;
  const delta = BigInt(post) - BigInt(pre);
  if (delta <= 0n) {
    throw new Error(
      `retailer balance did not increase (delta=${delta}) in TX ${signature}`,
    );
  }

  if (opts.minLamports !== undefined && delta < opts.minLamports) {
    throw new Error(
      `payment amount ${delta} lamports below minimum ${opts.minLamports}`,
    );
  }

  const memoRaw = extractMemo(parsed.transaction.message.instructions);
  const memo = memoRaw ? parseInvoiceMemo(memoRaw) : null;

  if (opts.expectedSlug) {
    if (!memo || memo.slug !== opts.expectedSlug) {
      throw new Error(
        `memo mismatch: expected slug='${opts.expectedSlug}', got ${memo?.raw ?? '(none)'}`,
      );
    }
  }

  const programsInvoked = uniqueProgramIds(parsed.transaction.message.instructions);

  return {
    signature,
    slot: parsed.slot,
    blockTime: parsed.blockTime ?? null,
    retailer,
    lamports: delta,
    sol: Number(delta) / LAMPORTS_PER_SOL,
    memo,
    programsInvoked,
  };
}

// ---------------------------------------------------------------------------
// Incoming-payment polling
// ---------------------------------------------------------------------------

export interface WatchPaymentsOptions {
  /** Only surface TXs newer than this signature (like `before`/`until`). */
  since?: string;
  /** Hard cap on how many signatures to inspect per poll. Default 25. */
  limit?: number;
  /** Require this slug in the memo. If unset, accepts any `p01:` memo. */
  slugFilter?: string;
  /** Reject payments with less than N lamports. */
  minLamports?: bigint;
  /** RPC commitment. `getSignaturesForAddress` accepts `Finality` only
   *  (no `processed`). Default `confirmed`. */
  commitment?: 'confirmed' | 'finalized';
  /**
   * Called once per signature that was inspected and NOT returned as a receipt.
   *
   * Exists because the silence was the defect. This function used to drop every
   * non-match without a word, so a merchant polling correctly, against the right
   * wallet, while customers really paid, saw an empty array forever and had no
   * channel to learn why. MEASURED 2026-08-04: no shipped client writes
   * {@link MEMO_INVOICE_PREFIX} at all, so the honest result today IS empty —
   * but "empty because nobody paid" and "empty because the memo format nobody
   * writes did not match" are opposite problems and looked identical.
   *
   * Optional, and never throws into the caller's loop: an exception raised here
   * is swallowed, because a diagnostic hook must not be able to break polling.
   */
  onSkipped?: (info: { signature: string; reason: string }) => void;
}

/**
 * Poll the retailer wallet and return any new payments matching the filters.
 *
 * Typical cadence: call every 30–60 s from a background job. Persist the
 * most recent signature you processed and pass it back in `opts.since` to
 * make the poll cheap.
 */
export async function pollPaymentsForRetailer(
  connection: Connection,
  retailer: PublicKey,
  opts: WatchPaymentsOptions = {},
): Promise<PaymentReceipt[]> {
  const sigs = await connection.getSignaturesForAddress(
    retailer,
    {
      limit: opts.limit ?? 25,
      until: opts.since,
    },
    opts.commitment ?? 'confirmed',
  );

  const skipped = (signature: string, reason: string): void => {
    if (!opts.onSkipped) return;
    try {
      opts.onSkipped({ signature, reason });
    } catch {
      // A diagnostic hook must never break the poll it is diagnosing.
    }
  };

  const receipts: PaymentReceipt[] = [];
  for (const sig of sigs) {
    if (sig.err) {
      skipped(sig.signature, 'transaction failed on chain');
      continue;
    }
    try {
      const r = await verifyOneShotPayment(connection, sig.signature, retailer, {
        expectedSlug: opts.slugFilter,
        minLamports: opts.minLamports,
        commitment: opts.commitment ?? 'confirmed',
      });
      receipts.push(r);
    } catch (e) {
      // Still returns only valid receipts — but the reason is now reachable.
      // Dropping these without a word is what made a correctly-configured
      // merchant unable to distinguish "nobody paid" from "the memo format
      // nobody writes did not match".
      skipped(sig.signature, e instanceof Error ? e.message : String(e));
    }
  }

  // Chronological order (oldest first) so the caller's ledger applies cleanly.
  receipts.sort((a, b) => a.slot - b.slot);
  return receipts;
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

function findAccountIndex(
  keys: ParsedMessageAccount[],
  target: PublicKey,
): number {
  const b = target.toBase58();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i]?.pubkey?.toBase58?.() === b) return i;
  }
  return -1;
}

function extractMemo(
  instructions: (ParsedInstruction | PartiallyDecodedInstruction)[],
): string | null {
  for (const ix of instructions) {
    const pid = (ix as ParsedInstruction | PartiallyDecodedInstruction).programId?.toBase58?.();
    if (pid !== MEMO_PROGRAM_V1.toBase58() && pid !== MEMO_PROGRAM_V2.toBase58()) continue;

    const parsed = (ix as ParsedInstruction).parsed;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && typeof parsed.info === 'string') {
      return parsed.info;
    }
    const data = (ix as PartiallyDecodedInstruction).data;
    if (typeof data === 'string') {
      try {
        return Buffer.from(data, 'base64').toString('utf-8');
      } catch {
        // Not base64 — try direct UTF-8.
        return data;
      }
    }
  }
  return null;
}

function uniqueProgramIds(
  instructions: (ParsedInstruction | PartiallyDecodedInstruction)[],
): string[] {
  const out = new Set<string>();
  for (const ix of instructions) {
    const pid = ix.programId?.toBase58?.();
    if (pid) out.add(pid);
  }
  return Array.from(out);
}

// Ensure the confirmed-signature import is not purged by tree-shaking.
export type { ConfirmedSignatureInfo };
