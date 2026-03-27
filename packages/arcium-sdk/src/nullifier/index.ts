import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS } from '../client';

/**
 * UC3: Hidden Nullifier Commitment
 *
 * Problem: On-chain nullifiers are linkable — an observer can track
 * which shielded notes have been spent by watching nullifier PDAs.
 *
 * Solution: User submits encrypted nullifier to MPC → MPC computes
 * SHA3 commitment → commitment goes on-chain (public), but the actual
 * nullifier is never visible. MPC stores the mapping in encrypted state
 * to prevent double-spend.
 *
 * Flow:
 * 1. User generates nullifier locally (from spending_key + note)
 * 2. Encrypts nullifier with Arcium shared secret
 * 3. MPC computes: commitment = SHA3(nullifier)
 * 4. MPC checks: nullifier not in encrypted spent-set
 * 5. If fresh: adds to spent-set, returns commitment
 * 6. Commitment submitted on-chain (opaque, no nullifier linkage)
 */

export interface NullifierCommitment {
  /** SHA3 commitment of the nullifier (32 bytes, on-chain) */
  commitment: Uint8Array;
  /** Computation offset for tracking */
  computationOffset: anchor.BN;
  /** Transaction signature */
  signature: string;
}

export interface NullifierCheckResult {
  /** Whether the nullifier has already been spent */
  isSpent: boolean;
  /** Computation signature */
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
 * The actual nullifier never appears on-chain.
 * Only the SHA3 commitment is stored publicly.
 * MPC maintains the encrypted spent-set to prevent double-spend.
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

  const sig = await program.methods
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
  const finalizeSig = await client.awaitFinalization(computationOffset);

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
 * User encrypts nullifier → MPC checks encrypted spent-set → returns boolean.
 * The nullifier is never exposed to any single party.
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

  const sig = await program.methods
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

  const finalizeSig = await client.awaitFinalization(computationOffset);

  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const spentLine = logs.find((l) => l.includes('NullifierSpent:'));
  const isSpent = spentLine ? spentLine.includes('true') : false;

  return { isSpent, signature: finalizeSig };
}
