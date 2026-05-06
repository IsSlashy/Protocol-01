/**
 * V3 Relayer Wrapper
 * ──────────────────
 * Routes a fully built V3 transaction (shield / unshield / transfer) through
 * the on-chain `p01_relayer` program instead of submitting directly.
 *
 * Privacy gain (Phase A — Network Privacy Layer):
 *   ✓ L19  Hides the user's RPC submission IP (the relayer node submits the
 *          inner tx; the user only submits the encrypted relay-job ix from
 *          a freshly-derived ephemeral).
 *   ✓ L17  Outer relay-job tx fee_payer = ephemeral noise (no link to user).
 *
 * What it does NOT close (deferred):
 *   ✗ L1   Inner shield ix `depositor: Signer` is still the user — the
 *          relayer cannot rewrite the inner tx's signer set. Closing this
 *          requires a k-anonymous feeder pool (Phase A.5) or universal-
 *          denomination redesign (Phase F).
 *   ✗ L2   The pre-fund SystemProgram.transfer (main wallet → ephemeral)
 *          is on-chain, timing-correlatable with the inner tx. Same fix
 *          path as L1.
 *   ✗ L5/L6/L7  On-chain events still publish recipient / nullifier /
 *          commitment in plain. Closed in Phase B (event scrubbing).
 *
 * Encryption choice:
 *   We force v1 (X25519 + XSalsa20-Poly1305, overhead 73 bytes). The on-chain
 *   `encrypted_tx` Vec is capped at 1280 bytes BUT the outer Solana tx that
 *   carries it (`submit_job` ix) hits the 1232-byte hard limit before that.
 *   See the size budget computation in `inferV1InnerTxBudget`.
 *
 *   v2 hybrid ML-KEM-768 has 1161 bytes overhead which makes the total
 *   submit_job tx exceed 1232 bytes for any non-trivial inner tx. v2 stays
 *   available for tiny payloads (memos) but not V3 zk_shielded txs. Phase
 *   A.3 unblocks v2 via chunked submit_job.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

const V3_RELAYER_TIMEOUT_MS = 180_000;

/**
 * Specific error type so the dispatcher can detect "tx too big" and fall
 * back to direct submission without burning any SOL on a doomed pre-fund.
 */
export class OversizedInnerTxError extends Error {
  constructor(
    public readonly innerTxBytes: number,
    public readonly budgetBytes: number,
  ) {
    super(
      `Inner tx (${innerTxBytes}B) exceeds v1 relay envelope budget (${budgetBytes}B)`,
    );
    this.name = 'OversizedInnerTxError';
  }
}

/**
 * Sign + submit a V3 inner tx via the decentralized relayer.
 *
 * Signature mirrors the existing `signAndSend` helper in
 * `services/denominatedPool/index.ts` so call sites can swap with one line.
 *
 * Throws `OversizedInnerTxError` BEFORE any on-chain side-effect when the
 * inner tx wouldn't fit in the v1 envelope. The caller is expected to catch
 * this specific class and fall back to direct submission.
 */
export async function signAndSendViaRelayer(
  connection: Connection,
  tx: Transaction,
  keypair: Keypair | null,
  walletSigner: WalletSigner | undefined,
): Promise<string> {
  const t0 = Date.now();
  console.log('[V3-Relay] Step 1: signAndSendViaRelayer entry, ix count=' + tx.instructions.length);

  if (!keypair && !walletSigner) {
    throw new Error('signAndSendViaRelayer: no signer (keypair or walletSigner) provided');
  }

  const userPubkey = keypair ? keypair.publicKey : walletSigner!.publicKey;
  console.log('[V3-Relay] Step 2: signer = ' + userPubkey.toBase58().slice(0, 8) + '... (kind=' + (keypair ? 'keypair' : 'walletSigner') + ')');

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = userPubkey;
  console.log('[V3-Relay] Step 3: blockhash + feePayer set');

  // Sign in-memory (no RPC side-effect yet) then measure.
  let signedInner: Transaction;
  if (keypair) {
    tx.sign(keypair);
    signedInner = tx;
  } else {
    signedInner = await walletSigner!.signTransaction(tx);
  }
  const innerBytes = signedInner.serialize();
  const budget = inferV1InnerTxBudget();
  console.log('[V3-Relay] Step 4: inner tx signed, size=' + innerBytes.length + 'B (v1 budget=' + budget + 'B)');

  // PREFLIGHT — fail loud BEFORE any on-chain side-effect (no pre-fund tx,
  // no relay-job submission, nothing). The caller handles fallback.
  if (innerBytes.length > budget) {
    console.warn('[V3-Relay] PREFLIGHT FAIL: ' + innerBytes.length + 'B > ' + budget + 'B — caller must fall back to direct');
    throw new OversizedInnerTxError(innerBytes.length, budget);
  }

  const signFn = async (fundTx: Transaction): Promise<Transaction> => {
    console.log('[V3-Relay] Step 5: signing fund tx (main → ephemeral pre-fund)');
    if (keypair) {
      fundTx.sign(keypair);
      return fundTx;
    }
    return walletSigner!.signTransaction(fundTx);
  };

  console.log('[V3-Relay] Step 6: calling relayTransaction (forceV1, timeout=' + V3_RELAYER_TIMEOUT_MS + 'ms)');
  const { relayTransaction } = await import('../relay');
  const sig = await relayTransaction(
    innerBytes,
    userPubkey,
    signFn,
    {
      forceV1Encryption: true,
      timeoutMs: V3_RELAYER_TIMEOUT_MS,
    },
  );
  console.log('[V3-Relay] Step 7: DONE in ' + (Date.now() - t0) + 'ms, outer sig=' + sig.slice(0, 12) + '...');
  return sig;
}

/**
 * Compute the maximum signed inner tx size that, once v1-encrypted and
 * wrapped in a `submit_job` ix, fits inside Solana's 1232-byte tx cap.
 *
 * Outer `submit_job` tx breakdown:
 *   sig[64] + sig_count(1) + header(3) + acct_count(1) + 5*acct_keys(160)
 *   + recent_blockhash(32) + ix_count(1) + ix_overhead(8)
 *   = 270 bytes fixed.
 * Then ix data = disc(8) + jobId(32) + encLen(4) + encrypted_tx
 *   = 44 bytes fixed + encrypted_tx.
 * v1 encryption overhead = 73 bytes (version + ephemeral pubkey + nonce + tag).
 *
 *   1232 - 270 - 44 - 73 = 845 bytes for the signed inner tx.
 *
 * Empirical (devnet 2026-05-06):
 *   shield V3 native SOL inner    ≈ 947B  → DOES NOT fit (oversized)
 *   unshield V3 native SOL inner  ≈ 700B  → fits (estimated)
 *   transfer V3 inner             ≈ 700B  → fits (estimated)
 *
 * Phase A.2 (Versioned tx + LUT) compresses static account keys (~250B
 * savings) → all V3 flows fit. Phase A.3 (chunked submit_job) unblocks v2
 * hybrid ML-KEM and arbitrary tx sizes.
 */
export function inferV1InnerTxBudget(): number {
  const SOLANA_TX_CAP = 1232;
  const OUTER_SUBMIT_JOB_FIXED = 270;
  const IX_DATA_FIXED = 44;
  const V1_ENCRYPT_OVERHEAD = 73;
  return SOLANA_TX_CAP - OUTER_SUBMIT_JOB_FIXED - IX_DATA_FIXED - V1_ENCRYPT_OVERHEAD;
}

/**
 * @deprecated Use `inferV1InnerTxBudget()` directly + an inequality. Kept
 * for backward compat; the original 1207B figure was wrong (omitted outer
 * tx overhead).
 */
export function fitsInRelayerEnvelope(serializedTxBytes: number): boolean {
  return serializedTxBytes <= inferV1InnerTxBudget();
}
