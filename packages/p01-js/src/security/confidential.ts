/**
 * Confidential Transactions Module
 *
 * Pedersen-style commitments over ed25519, plus a confidential-transfer API
 * that is NOT IMPLEMENTED.
 *
 * WARNING — read before using anything in this file:
 *  - There is no range proof and no transfer proof in this package.
 *    `createConfidentialTransfer` therefore refuses (throws) and
 *    `verifyConfidentialTransfer` always returns false. Until 2026-09 they
 *    returned a placeholder "proof" whose public inputs were sha256 of each
 *    amount (anyone could enumerate the amounts back) and a verifier that
 *    accepted any object of the right shape (audit v1, round 4).
 *  - Since audit v1 (F76) the second generator H of the commitments from
 *    `createConfidentialAmount` comes from the RFC 9380 hash-to-curve under
 *    `PEDERSEN_H_DST` (see `PEDERSEN_H_POINT` in ./crypto), so no discrete log
 *    of H to G is known. Commitments made by p01-js 0.3.2 and earlier used
 *    H = h·G with a public h and are not binding: anyone could open one to any
 *    value. They do not verify against the new H. There is still no range
 *    proof, so a commitment alone says nothing about the amount being in range.
 *
 * Styx payments do not use this module: the pool uses client-side STARK
 * proofs (see @protocol-01/stark-prover).
 */

import type {
  ConfidentialAmount,
  ConfidentialTransfer,
} from './types';
import {
  createCommitment,
  verifyCommitment,
  addCommitments,
  subtractCommitments,
  generateRandomBytes,
  bytesToHex,
  hexToBytes,
  bigIntToBytes,
  bytesToBigInt,
} from './crypto';

// ============ Constants ============

/** Maximum value for range proofs (64-bit) */
const MAX_VALUE = BigInt('18446744073709551615'); // 2^64 - 1

/** Bit length for range proofs */
const RANGE_BITS = 64;

// ============ Confidential Amounts ============

/**
 * Create a confidential amount (Pedersen commitment)
 *
 * @param value - The amount to commit to
 * @returns ConfidentialAmount with commitment and blinding factor
 *
 * @example
 * ```typescript
 * const amount = createConfidentialAmount(1000n); // 1000 tokens
 * // amount.commitment hides the value
 * // Keep amount.blindingFactor secret!
 * ```
 */
export function createConfidentialAmount(value: bigint): ConfidentialAmount {
  if (value < 0n) {
    throw new Error('Value must be non-negative');
  }
  if (value > MAX_VALUE) {
    throw new Error(`Value must be less than 2^${RANGE_BITS}`);
  }

  // Generate random blinding factor
  const blindingFactor = generateRandomBytes(32);

  // Create Pedersen commitment: C = vG + rH
  const pedersenCommitment = createCommitment(value, blindingFactor);

  return {
    commitment: pedersenCommitment.commitment,
    blindingFactor,
    // Range proof would go here in production
    rangeProof: undefined,
  };
}

/**
 * Open (reveal) a confidential amount
 *
 * @param confidential - The confidential amount
 * @param expectedValue - The expected value
 * @returns True if the value matches
 */
export function openConfidentialAmount(
  confidential: ConfidentialAmount,
  expectedValue: bigint
): boolean {
  return verifyCommitment(
    confidential.commitment,
    expectedValue,
    confidential.blindingFactor
  );
}

/**
 * Add two confidential amounts
 * C1 + C2 = (v1 + v2)G + (r1 + r2)H
 *
 * @param a - First confidential amount
 * @param b - Second confidential amount
 * @returns Combined confidential amount
 */
export function addConfidentialAmounts(
  a: ConfidentialAmount,
  b: ConfidentialAmount
): ConfidentialAmount {
  const commitment = addCommitments(a.commitment, b.commitment);

  // Add blinding factors (mod curve order)
  const curveOrder = BigInt(
    '7237005577332262213973186563042994240857116359379907606001950938285454250989'
  );
  const r1 = bytesToBigInt(a.blindingFactor);
  const r2 = bytesToBigInt(b.blindingFactor);
  const rSum = (r1 + r2) % curveOrder;

  return {
    commitment,
    blindingFactor: bigIntToBytes(rSum, 32),
    rangeProof: undefined,
  };
}

/**
 * Subtract confidential amounts
 * C1 - C2 = (v1 - v2)G + (r1 - r2)H
 *
 * @param a - First confidential amount
 * @param b - Second confidential amount (to subtract)
 * @returns Difference confidential amount
 */
export function subtractConfidentialAmounts(
  a: ConfidentialAmount,
  b: ConfidentialAmount
): ConfidentialAmount {
  const commitment = subtractCommitments(a.commitment, b.commitment);

  // Subtract blinding factors (mod curve order)
  const curveOrder = BigInt(
    '7237005577332262213973186563042994240857116359379907606001950938285454250989'
  );
  const r1 = bytesToBigInt(a.blindingFactor);
  const r2 = bytesToBigInt(b.blindingFactor);
  let rDiff = (r1 - r2) % curveOrder;
  if (rDiff < 0n) {
    rDiff += curveOrder;
  }

  return {
    commitment,
    blindingFactor: bigIntToBytes(rDiff, 32),
    rangeProof: undefined,
  };
}

// ============ Confidential Transfers ============

/**
 * Create a confidential transfer — NOT IMPLEMENTED, always throws.
 *
 * A confidential transfer needs a range proof and a conservation proof over
 * the commitments. This package has neither, so after the input checks this
 * function throws instead of returning a transfer that would look
 * confidential without being so. (The former placeholder published
 * sha256(amount) for each amount, which revealed the amounts.)
 *
 * @param transferAmount - Amount to transfer
 * @param senderBalance - Sender's current balance
 * @param recipientBalance - Recipient's current balance
 * @throws Error always: invalid inputs first, then "no range proof"
 */
export function createConfidentialTransfer(
  transferAmount: bigint,
  senderBalance: bigint,
  recipientBalance: bigint
): ConfidentialTransfer {
  if (transferAmount <= 0n) {
    throw new Error('Transfer amount must be positive');
  }
  if (transferAmount > senderBalance) {
    throw new Error('Insufficient balance');
  }
  void recipientBalance;

  throw new Error(
    'createConfidentialTransfer is not implemented: this package has no range proof ' +
      'or transfer proof, so it cannot produce a confidential transfer. ' +
      'Do not treat any output of this module as private or verified.'
  );
}

/**
 * Verify a confidential transfer — NOT IMPLEMENTED, fails closed.
 *
 * Checking range, sufficient balance and conservation of funds needs a proof
 * verifier this package does not have. It therefore returns false for every
 * input. (The former version checked only the shape of the object and
 * accepted forgeries such as zero commitments with a 1-byte proof.)
 *
 * @param transfer - The confidential transfer to verify
 * @returns Always false
 */
export function verifyConfidentialTransfer(
  transfer: ConfidentialTransfer
): boolean {
  void transfer;
  return false;
}

// ============ Serialization ============

/**
 * Serialize a confidential amount for storage/transmission
 */
export function serializeConfidentialAmount(
  amount: ConfidentialAmount
): string {
  return JSON.stringify({
    commitment: bytesToHex(amount.commitment),
    blindingFactor: bytesToHex(amount.blindingFactor),
    rangeProof: amount.rangeProof
      ? bytesToHex(amount.rangeProof)
      : undefined,
  });
}

/**
 * Deserialize a confidential amount
 */
export function deserializeConfidentialAmount(
  serialized: string
): ConfidentialAmount {
  const data = JSON.parse(serialized);
  return {
    commitment: hexToBytes(data.commitment),
    blindingFactor: hexToBytes(data.blindingFactor),
    rangeProof: data.rangeProof ? hexToBytes(data.rangeProof) : undefined,
  };
}

/**
 * Serialize a confidential transfer
 */
export function serializeConfidentialTransfer(
  transfer: ConfidentialTransfer
): string {
  return JSON.stringify({
    senderCommitment: bytesToHex(transfer.senderCommitment),
    recipientCommitment: bytesToHex(transfer.recipientCommitment),
    transferCommitment: bytesToHex(transfer.transferCommitment),
    proof: {
      type: transfer.proof.type,
      proof: bytesToHex(transfer.proof.proof),
      publicInputs: transfer.proof.publicInputs.map(bytesToHex),
      verificationKeyHash: transfer.proof.verificationKeyHash,
    },
  });
}

/**
 * Deserialize a confidential transfer
 */
export function deserializeConfidentialTransfer(
  serialized: string
): ConfidentialTransfer {
  const data = JSON.parse(serialized);
  return {
    senderCommitment: hexToBytes(data.senderCommitment),
    recipientCommitment: hexToBytes(data.recipientCommitment),
    transferCommitment: hexToBytes(data.transferCommitment),
    proof: {
      type: data.proof.type,
      proof: hexToBytes(data.proof.proof),
      publicInputs: data.proof.publicInputs.map(hexToBytes),
      verificationKeyHash: data.proof.verificationKeyHash,
    },
  };
}

// ============ Light Protocol Integration (Future) ============

/**
 * Light Protocol configuration for full ZK support
 * This is a placeholder for future integration
 */
export interface LightProtocolConfig {
  /** Light Protocol program ID on Solana */
  programId: string;
  /** RPC endpoint */
  rpcEndpoint: string;
  /** Merkle tree address */
  merkleTreeAddress?: string;
}

/**
 * Initialize Light Protocol integration
 * TODO: Implement full Light Protocol support
 */
export async function initializeLightProtocol(
  config: LightProtocolConfig
): Promise<boolean> {
  // In production, this would:
  // 1. Connect to Light Protocol's compressed token program
  // 2. Initialize the Merkle tree for storing commitments
  // 3. Set up the prover/verifier
  return true;
}

/**
 * Create a private transfer using Light Protocol
 * TODO: Implement full Light Protocol support
 */
export async function createPrivateTransferWithLight(
  _amount: bigint,
  _recipient: string,
  _config: LightProtocolConfig
): Promise<{ signature: string; nullifier: Uint8Array }> {
  // Placeholder - would integrate with Light Protocol SDK
  throw new Error(
    'Light Protocol integration not yet implemented. This package has no private transfer.'
  );
}
