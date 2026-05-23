/**
 * Auth proof orchestration for the quantum wallet.
 *
 * The wallet's spending commitment is `Poseidon(secret, 0)` over Goldilocks
 * (matches STARK circuit 0 — `subscriber_ownership`). Knowing the secret is
 * the spending capability. We prove that knowledge once via STARK + upload +
 * verify, then **reuse the same on-chain `ProofBuffer`** for as many sends as
 * needed until the user rotates their secret.
 *
 * This is the single biggest UX lever: per-send proof generation is ~30-60s,
 * but the second-and-onwards send only needs the withdraw ix (~3-5s) once a
 * verified ProofBuffer exists.
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import {
  GenericStarkProof,
  WalletSigner,
  submitAndVerifyStarkProof,
  closeStarkProofBuffer,
  getProofBufferStatus,
} from '../stark';

const CIRCUIT_SUBSCRIBER_OWNERSHIP = 0;

export interface AuthProofRecord {
  /** Verified ProofBuffer PDA on `p01_stark_verifier`. */
  proofBuffer: PublicKey;
  /** Authority that signed the verify tx — must equal payer on consumption. */
  authority: PublicKey;
  /** Slot at verification time (for staleness checks). */
  verifiedAtSlot: number;
  /** Commitment string at the time the proof was built. Lets us invalidate
   *  the cached record if the on-chain commitment rotated. */
  commitmentFelt: string;
}

export type ProverHandle = {
  /** Generate a STARK proof for circuit 0 (subscriber_ownership). */
  generateProof: (secret: string) => Promise<{
    commitment: string;
    proofHex: string;
    proofSize: number;
    durationMs: number;
  }>;
  /** Compute the Poseidon commitment of a secret without proving. */
  computeCommitment: (secret: string) => Promise<string>;
  isReady: boolean;
};

/**
 * Build a fresh circuit 0 auth proof and submit + verify it on-chain.
 *
 * The returned record represents a verified `ProofBuffer` PDA that any
 * downstream quantum-wallet spend ix can read. Call sites should cache it
 * in `quantumWalletStore.authProofRecord` and only call this again on:
 *   - first use after app boot
 *   - after a `rotate_secret` (commitment changed)
 *   - after manual invalidation (e.g. paranoia button)
 *   - if `getProofBufferStatus` shows the buffer no longer exists
 */
export async function buildAndSubmitAuthProof(args: {
  prover: ProverHandle;
  secret: string;
  walletSigner: WalletSigner;
  connection: Connection;
  onProgress?: (step: string) => void;
}): Promise<AuthProofRecord> {
  if (!args.prover.isReady) {
    throw new Error('STARK prover not ready yet — wait for WebView to load');
  }

  args.onProgress?.('Generating STARK proof (circuit 0)...');
  const { commitment, proofHex, proofSize } = await args.prover.generateProof(args.secret);

  // The compact-proof format used by C0 stores commitment as the only public
  // input (u64 felt). submitAndVerifyStarkProof routes C0 through the legacy
  // verify_stark_proof ix automatically.
  const proof: GenericStarkProof = {
    circuitId: CIRCUIT_SUBSCRIBER_OWNERSHIP,
    publicInputs: [BigInt(commitment)],
    proofBytes: Uint8Array.from(Buffer.from(proofHex, 'hex')),
    proofSize,
  };

  args.onProgress?.('Uploading + verifying proof on-chain...');
  const { proofBuffer, authority } = await submitAndVerifyStarkProof(
    proof,
    args.walletSigner,
    args.onProgress,
    args.connection,
  );

  const verifiedAtSlot = await args.connection.getSlot('confirmed');

  return {
    proofBuffer,
    authority,
    verifiedAtSlot,
    commitmentFelt: commitment,
  };
}

/**
 * Quickly check whether a cached AuthProofRecord is still consumable on-chain.
 * Returns true if the PDA exists + has the verifier program as its owner.
 *
 * We don't deserialize the discriminator / verified flag here — the
 * `withdraw` ix does that anyway. A simple existence check is enough to know
 * we don't need to re-prove yet.
 */
export async function isAuthProofStillFresh(
  connection: Connection,
  record: AuthProofRecord,
  currentCommitmentFelt: string,
): Promise<boolean> {
  if (record.commitmentFelt !== currentCommitmentFelt) {
    // Commitment was rotated — the cached buffer's inputs_hash no longer
    // matches what the new on-chain wallet expects.
    return false;
  }
  try {
    const status = await getProofBufferStatus(record.proofBuffer, connection);
    return status?.verified === true;
  } catch {
    return false;
  }
}

/**
 * Explicit invalidation — closes the on-chain ProofBuffer and refunds rent.
 * Call this after `rotate_secret` or when the user opts out of cached proof.
 */
export async function invalidateAuthProof(
  record: AuthProofRecord,
  walletSigner: WalletSigner,
  connection: Connection,
): Promise<void> {
  try {
    await closeStarkProofBuffer(record.proofBuffer, walletSigner, connection);
  } catch {
    // Buffer may already be closed; swallow.
  }
}
