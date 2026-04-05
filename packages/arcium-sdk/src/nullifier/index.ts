import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC3: Hidden Nullifier Commitment -- Unlinkable Spent-Note Tracking
 *
 * Prevents double-spending of shielded notes without revealing which
 * notes have been spent. The user encrypts a nullifier (derived from
 * spending_key + note), MPC computes SHA3(nullifier) as a commitment,
 * and only the opaque commitment is stored on-chain.
 *
 * **Inputs**: Encrypted nullifier (32 bytes as 4 x u64 chunks), pool ID.
 * **Output**: SHA3 commitment (32 bytes, on-chain) or spent/fresh boolean.
 *
 * @module nullifier
 */

/** Result of a successful nullifier commitment. */
export interface NullifierCommitment {
  /** SHA3 commitment of the nullifier (32 bytes). Stored on-chain as a PDA. */
  commitment: Uint8Array;
  /** Computation offset for tracking this MPC job. */
  computationOffset: anchor.BN;
  /** Finalization callback transaction signature. */
  signature: string;
}

/** Result of checking whether a nullifier has been spent. */
export interface NullifierCheckResult {
  /** `true` if the nullifier has already been committed (note is spent). */
  isSpent: boolean;
  /** Finalization callback transaction signature. */
  signature: string;
}

const NULLIFIER_SET_SEED = 'p01_nullifier_set';
const NULLIFIER_COMMITMENT_SEED = 'p01_null_commit';

/** Derive the encrypted nullifier set PDA (MXE-encrypted state) */
export function getNullifierSetAddress(
  programId: PublicKey,
  poolId: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(NULLIFIER_SET_SEED), poolId],
    programId
  );
}

/** Derive the nullifier commitment PDA (public, on-chain) */
export function getNullifierCommitmentAddress(
  programId: PublicKey,
  commitment: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(NULLIFIER_COMMITMENT_SEED), commitment],
    programId
  );
}

/**
 * Submit a nullifier for hidden commitment.
 *
 * The actual nullifier never appears on-chain -- only the SHA3
 * commitment is stored publicly. MPC maintains the encrypted
 * spent-set to prevent double-spend.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param poolId - The denominated pool identifier.
 * @param nullifier - 32-byte nullifier derived from `spending_key + note`.
 * @returns The on-chain commitment and finalization signature.
 * @throws {Error} "Nullifier MPC computation failed: ..." if submission or finalization fails.
 */
export async function commitNullifier(
  client: ArciumClient,
  program: anchor.Program,
  poolId: Uint8Array,
  nullifier: Uint8Array
): Promise<NullifierCommitment> {
  // Encrypt the nullifier as 4 × u64 chunks (each fits within the 254-bit field).
  // A single 256-bit bigint overflows the Poseidon field (~75% of nullifiers fail).
  const chunks: bigint[] = [];
  for (let i = 0; i < 32; i += 8) {
    chunks.push(BigInt('0x' + Buffer.from(nullifier.slice(i, i + 8)).reverse().toString('hex')));
  }
  const payload = client.encrypt(chunks);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.NULLIFIER_COMMIT, computationOffset);

  const [nullifierSetAddress] = getNullifierSetAddress(client.programId, poolId);

  let finalizeSig: string;
  try {
    await program.methods
      .commitNullifier(
        computationOffset,
        Array.from(poolId),
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce)
      )
      .accountsPartial({
        ...accounts,
        nullifierSet: nullifierSetAddress,
        payer: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });

    // Wait for MPC to compute commitment and invoke callback
    finalizeSig = await client.awaitFinalization(computationOffset);
  } catch (err) {
    throw new Error(
      `Nullifier MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  // Parse commitment from callback logs
  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const commitLine = logs.find((l) => l.includes('NullifierCommitment:'));
  const commitmentHex = commitLine
    ? commitLine.split('NullifierCommitment:')[1].trim()
    : '';
  const commitment = Buffer.from(commitmentHex, 'hex');

  return { commitment, computationOffset, signature: finalizeSig };
}

/**
 * Check if a nullifier has been spent (without revealing which one).
 *
 * The user encrypts the nullifier, MPC checks the encrypted spent-set,
 * and returns a boolean. The nullifier is never exposed to any single party.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param poolId - The denominated pool identifier.
 * @param nullifier - 32-byte nullifier to check.
 * @returns Whether the nullifier has been spent.
 * @throws {Error} "Nullifier MPC computation failed: ..." if the MPC check fails.
 */
export async function checkNullifierSpent(
  client: ArciumClient,
  program: anchor.Program,
  poolId: Uint8Array,
  nullifier: Uint8Array
): Promise<NullifierCheckResult> {
  const chunks: bigint[] = [];
  for (let i = 0; i < 32; i += 8) {
    chunks.push(BigInt('0x' + Buffer.from(nullifier.slice(i, i + 8)).reverse().toString('hex')));
  }
  const payload = client.encrypt(chunks);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(CIRCUITS.NULLIFIER_COMMIT, computationOffset);
  const [nullifierSetAddress] = getNullifierSetAddress(client.programId, poolId);

  let finalizeSig: string;
  try {
    await program.methods
      .checkNullifier(
        computationOffset,
        Array.from(poolId),
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce)
      )
      .accountsPartial({
        ...accounts,
        nullifierSet: nullifierSetAddress,
        payer: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });

    finalizeSig = await client.awaitFinalization(computationOffset);
  } catch (err) {
    throw new Error(
      `Nullifier MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const spentLine = logs.find((l) => l.includes('NullifierSpent:'));
  const isSpent = spentLine ? spentLine.includes('true') : false;

  return { isSpent, signature: finalizeSig };
}
