/**
 * recoverFloat — reclaim SOL stranded on a pool ephemeral.
 *
 * WHY THIS IS NEEDED
 * ──────────────────
 * A shield or withdrawal pre-funds an ephemeral E with ~1 SOL, most of which
 * becomes rent on a STARK proof buffer. If the run dies after the buffer is
 * created — browser closed, tab reloaded, RPC failure mid-upload — that rent
 * stays locked, and `CloseProofBuffer` is declared
 * `#[account(mut, has_one = authority, close = authority)]`, so **only E can
 * ever release it**. No crank, no other wallet, no protocol path.
 *
 * The next shield uses a different leaf index, hence a different E, so without
 * this the old E is never derived again and its float is stranded permanently.
 *
 * What makes recovery possible is that E is deterministic in
 * (pool seed, pool, leaf index) — so we simply re-derive the recent ones, close
 * any buffer they still own, and sweep them out.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

import {
  CIRCUIT_MERKLE_PATH,
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_POOL_COMMITMENT,
  type PoolConfig,
  type WalletSigner,
} from './denominatedPool';
import { closeStarkProofBuffer, getProofBufferPDA } from './stark';
import { deriveShieldEphemeral, readTreeLeafCount } from './shieldEphemeral';
import { deriveUnshieldEphemeral } from './unshieldEphemeral';

/** Leave enough for the sweep transaction's own fee. */
const SWEEP_FEE = 5_000;

/**
 * How many leaf indices back to look. A stranded ephemeral is always from a
 * recent attempt: the leaf index it was derived for is at or just below the
 * tree head, because a shield that never landed did not advance the tree.
 */
const DEFAULT_LOOKBACK = 12;

export interface RecoveredFloat {
  ephemeral: string;
  kind: 'shield' | 'unshield';
  leafIndex: number;
  lamports: number;
  closedBuffers: number;
}

/**
 * Re-derive recent ephemerals for this pool, close any proof buffers they still
 * own, and sweep their balances to `owner`.
 *
 * Safe to run at any time: an ephemeral with no buffer and no balance costs one
 * `getBalance` and is skipped. It is NOT safe to run while a shield or
 * withdrawal is in flight for the same pool — it would close the buffer the
 * live run is uploading into, so callers must serialize it against those.
 */
export async function recoverStuckFloat(
  connection: Connection,
  poolConfig: PoolConfig,
  walletSeed: Uint8Array,
  owner: PublicKey,
  opts: { lookback?: number; onProgress?: (step: string) => void } = {},
): Promise<RecoveredFloat[]> {
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK;
  const head = await readTreeLeafCount(connection, poolConfig);

  const recovered: RecoveredFloat[] = [];

  // `head` itself is included: a shield that was prepared but never landed was
  // derived for the current head and left its buffer behind without advancing
  // the tree.
  for (let leafIndex = head; leafIndex >= Math.max(0, head - lookback); leafIndex--) {
    for (const kind of ['shield', 'unshield'] as const) {
      const ephemeral =
        kind === 'shield'
          ? deriveShieldEphemeral(walletSeed, poolConfig.poolPDA, leafIndex)
          : deriveUnshieldEphemeral(walletSeed, poolConfig.poolPDA, leafIndex);

      const circuits =
        kind === 'shield'
          ? [CIRCUIT_MERKLE_UPDATE]
          : [CIRCUIT_POOL_COMMITMENT, CIRCUIT_MERKLE_PATH];

      let closedBuffers = 0;
      const signer = ephemeralSigner(ephemeral, connection);

      for (const circuitId of circuits) {
        const [bufferPDA] = getProofBufferPDA(ephemeral.publicKey, circuitId);
        const info = await connection.getAccountInfo(bufferPDA);
        if (!info) continue;
        opts.onProgress?.(`Closing a stranded proof buffer from leaf #${leafIndex}...`);
        await closeStarkProofBuffer(bufferPDA, signer, connection);
        closedBuffers += 1;
      }

      const balance = await connection.getBalance(ephemeral.publicKey, 'confirmed');
      const sweepable = balance - SWEEP_FEE;
      if (sweepable <= 0) {
        if (closedBuffers > 0) {
          recovered.push({
            ephemeral: ephemeral.publicKey.toBase58(),
            kind,
            leafIndex,
            lamports: 0,
            closedBuffers,
          });
        }
        continue;
      }

      opts.onProgress?.(`Sweeping ${(sweepable / 1e9).toFixed(4)} SOL back to your wallet...`);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: ephemeral.publicKey,
          toPubkey: owner,
          lamports: sweepable,
        }),
      );
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = ephemeral.publicKey;
      tx.sign(ephemeral);
      const sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

      recovered.push({
        ephemeral: ephemeral.publicKey.toBase58(),
        kind,
        leafIndex,
        lamports: sweepable,
        closedBuffers,
      });
    }
  }

  return recovered;
}

function ephemeralSigner(ephemeral: Keypair, connection: Connection): WalletSigner {
  return {
    publicKey: ephemeral.publicKey,
    signTransaction: async (t: Transaction) => {
      if (!t.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        t.recentBlockhash = blockhash;
      }
      if (!t.feePayer) t.feePayer = ephemeral.publicKey;
      t.sign(ephemeral);
      return t;
    },
  };
}
