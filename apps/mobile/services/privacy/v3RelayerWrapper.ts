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
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

const V3_RELAYER_TIMEOUT_MS = 180_000;

/** Phase A.2 — Address Lookup Table for V3 static accounts (devnet).
 * Contains ZK_SHIELDED + STARK_VERIFIER + Token + Memo + ComputeBudget +
 * SystemProgram + 4 SOL pools (pool/tree/fee_escrow each).
 * Created via scripts/create-v3-lut.mjs. */
const V3_STATIC_LUT = new PublicKey('J8zM2zwmx8zNMkWeej55P59EWsy9Rz6zgxxA2uCX4pTm');

let cachedLut: AddressLookupTableAccount | null = null;
async function getLutAccount(connection: Connection): Promise<AddressLookupTableAccount> {
  if (cachedLut) return cachedLut;
  const res = await connection.getAddressLookupTable(V3_STATIC_LUT);
  if (!res.value) throw new Error(`V3 static LUT ${V3_STATIC_LUT.toBase58()} not found on-chain`);
  cachedLut = res.value;
  return cachedLut;
}

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

  // Phase A.2 — for keypair signers, build V0 versioned tx with the V3 static
  // LUT to compress static account keys (saves ~150-200B). Closes the v0.9.11
  // shield V3 oversize gap (~947B legacy → ~750-800B versioned). WalletSigner
  // path (Privy etc) keeps legacy until those wallets support v0 sign.
  const useVersioned = keypair !== null;
  let innerBytes: Uint8Array;

  if (useVersioned) {
    const lut = await getLutAccount(connection);
    console.log('[V3-Relay] Step 3 (v0): using LUT ' + V3_STATIC_LUT.toBase58().slice(0, 8) + '... (' + lut.state.addresses.length + ' static accounts)');
    const message = new TransactionMessage({
      payerKey: userPubkey,
      recentBlockhash: blockhash,
      instructions: tx.instructions,
    }).compileToV0Message([lut]);
    const versionedTx = new VersionedTransaction(message);
    versionedTx.sign([keypair!]);
    innerBytes = versionedTx.serialize();
  } else {
    tx.recentBlockhash = blockhash;
    tx.feePayer = userPubkey;
    console.log('[V3-Relay] Step 3 (legacy): walletSigner path, no LUT compression');
    const signed = await walletSigner!.signTransaction(tx);
    innerBytes = signed.serialize();
  }
  const budget = inferV1InnerTxBudget();
  console.log('[V3-Relay] Step 4: inner tx signed, size=' + innerBytes.length + 'B (v1 budget=' + budget + 'B' + (useVersioned ? ', v0+LUT' : ', legacy') + ')');

  // PREFLIGHT — Phase A.3 auto-routing :
  // - if innerBytes ≤ budget → legacy single-shot submitRelayJob (cheaper)
  // - if innerBytes > budget → chunked submitChunkedRelayJob (unlocks any size,
  //   plus v2 hybrid ML-KEM-768 envelope when relayer publishes a KEM key)
  //
  // We don't throw OversizedInnerTxError anymore in the chunked-capable build —
  // that path was for v0.9.11 fallback to direct, which is no longer needed
  // because chunked carries arbitrary payloads via N submit_chunk calls.
  const useChunked = innerBytes.length > budget;
  if (useChunked) {
    console.log('[V3-Relay] PREFLIGHT: ' + innerBytes.length + 'B > ' + budget + 'B → routing chunked');
  }

  const signFn = async (fundTx: Transaction): Promise<Transaction> => {
    console.log('[V3-Relay] Step 5: signing fund tx (main → ephemeral pre-fund)');
    if (keypair) {
      fundTx.sign(keypair);
      return fundTx;
    }
    return walletSigner!.signTransaction(fundTx);
  };

  console.log('[V3-Relay] Step 6: calling relayTransaction (path=' + (useChunked ? 'chunked' : 'legacy') + ', timeout=' + V3_RELAYER_TIMEOUT_MS + 'ms)');
  const {
    relayTransaction,
    InnerBlockhashExpiredError,
    fetchActiveRelayers,
    submitChunkedRelayJob,
    monitorJob,
    cancelRelayJob,
  } = await import('../relay');

  // Fetch active count once for the failover budget. We'll try at most
  // `activeCount` distinct relayers before giving up.
  const activeRelayers = await fetchActiveRelayers(connection);
  const maxAttempts = Math.max(1, activeRelayers.length);
  const excludedOperators = new Set<string>();
  console.log(`[V3-Relay] Step 6: ${activeRelayers.length} active relayers on-chain, maxAttempts=${maxAttempts}`);
  activeRelayers.forEach((r, i) => {
    const ageSlots = r.lastActiveSlot;
    console.log(`[V3-Relay]   relayer ${i}: op=${r.operator.toBase58().slice(0, 8)}… stake=${(r.stake / 1e9).toFixed(2)} SOL last_active_slot=${ageSlots} active=${r.isActive}`);
  });

  const reSign = async (bh: string): Promise<Uint8Array> => {
    if (useVersioned) {
      const lut = await getLutAccount(connection);
      const message = new TransactionMessage({
        payerKey: userPubkey,
        recentBlockhash: bh,
        instructions: tx.instructions,
      }).compileToV0Message([lut]);
      const versionedTx = new VersionedTransaction(message);
      versionedTx.sign([keypair!]);
      return versionedTx.serialize();
    }
    tx.recentBlockhash = bh;
    tx.signatures = [];
    const signed = await walletSigner!.signTransaction(tx);
    return signed.serialize();
  };

  /** Legacy single-shot (innerBytes ≤ 845B) path. */
  const callRelayLegacy = async (innerSerialized: Uint8Array, innerBh: string) =>
    relayTransaction(innerSerialized, userPubkey, signFn, {
      forceV1Encryption: true,
      timeoutMs: V3_RELAYER_TIMEOUT_MS,
      innerBlockhash: innerBh,
      excludedOperators: excludedOperators.size > 0 ? excludedOperators : undefined,
    });

  /** Chunked path (Phase A.3) — supports v2 hybrid ML-KEM-768 because the
   * envelope is split across N submit_chunk calls. monitorJob is invoked
   * separately so we share the InnerBlockhashExpiredError surface for
   * multi-relayer failover. */
  const callRelayChunked = async (innerSerialized: Uint8Array, innerBh: string): Promise<string> => {
    const job = await submitChunkedRelayJob(innerSerialized, userPubkey, signFn, {
      forceV1Encryption: false, // chunked unlocks v2 hybrid by default
      excludedOperators: excludedOperators.size > 0 ? excludedOperators : undefined,
    });
    try {
      const result = await monitorJob(job.jobAddress, V3_RELAYER_TIMEOUT_MS, innerBh);
      if (!result.success) {
        throw new Error(`Chunked relay job failed with status ${result.status}`);
      }
      return job.signature;
    } catch (e) {
      if (e instanceof InnerBlockhashExpiredError) {
        e.failedOperator = job.selectedOperator;
        try {
          await cancelRelayJob(job.jobAddress, job.ephemeralKeypair);
        } catch (cancelErr) {
          console.warn('[V3-Relay] cancel chunked job after expiry failed: ' + (cancelErr as Error).message);
        }
      }
      throw e;
    }
  };

  const callRelay = (innerSerialized: Uint8Array, innerBh: string) =>
    useChunked
      ? callRelayChunked(innerSerialized, innerBh)
      : callRelayLegacy(innerSerialized, innerBh);

  let currentBytes = innerBytes;
  let currentBh = blockhash;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sig = await callRelay(currentBytes, currentBh);
      console.log('[V3-Relay] Step 7: DONE in ' + (Date.now() - t0) + 'ms (attempt ' + attempt + '/' + maxAttempts + '), outer sig=' + sig.slice(0, 12) + '...');
      return sig;
    } catch (e) {
      lastError = e as Error;
      if (!(e instanceof InnerBlockhashExpiredError)) {
        // Non-retryable error (oversize, no active, etc.) — bubble up immediately.
        throw e;
      }
      const failedOp = e.failedOperator?.toBase58();
      if (failedOp) excludedOperators.add(failedOp);
      console.log('[V3-Relay] attempt ' + attempt + '/' + maxAttempts + ' timed out (op=' + (failedOp?.slice(0, 8) ?? '?') + ') — excluding + retrying');

      if (attempt === maxAttempts) {
        console.warn('[V3-Relay] all ' + maxAttempts + ' relayers exhausted — failing closed');
        const exhausted = new Error(
          `All ${maxAttempts} active relayers timed out — privacy path unavailable. Excluded: ${Array.from(excludedOperators).map(o => o.slice(0, 8)).join(', ')}`,
        );
        (exhausted as Error & { code?: string }).code = 'RELAYERS_EXHAUSTED';
        throw exhausted;
      }

      // Refresh blockhash + re-sign for the next attempt.
      currentBh = (await connection.getLatestBlockhash('confirmed')).blockhash;
      currentBytes = await reSign(currentBh);
    }
  }
  // Unreachable.
  throw lastError ?? new Error('relayTransaction loop exited unexpectedly');
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
