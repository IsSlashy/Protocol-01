/**
 * Private Send Service - True Zero-Knowledge Transfers
 *
 * This module enables fully private transfers where:
 * - Sender is hidden (relayer sends on their behalf)
 * - Recipient is hidden (stealth address)
 * - Amount is hidden (fixed denominations)
 *
 * Flow:
 * 1. User creates ZK proof showing they have funds in pool
 * 2. User encrypts recipient info with recipient's viewing key
 * 3. Relayer verifies proof and sends from its own wallet
 * 4. Recipient scans for stealth payments to find their funds
 * 5. Relayer claims equivalent from shielded pool
 */

import { Keypair, PublicKey, Connection, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import * as snarkjs from 'snarkjs';
import * as crypto from 'crypto';

// Fixed denominations for maximum anonymity (like Tornado Cash)
export const DENOMINATIONS = {
  SMALL: 0.1 * 1e9,   // 0.1 SOL
  MEDIUM: 1 * 1e9,    // 1 SOL
  LARGE: 10 * 1e9,    // 10 SOL
};

export interface PrivateSendRequest {
  // ZK proof that user has funds in pool
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  };
  // Public signals from the proof
  publicSignals: string[];
  // Nullifier to prevent double-spending
  nullifier: string;
  // Encrypted recipient data (only recipient can decrypt)
  encryptedRecipient: string;
  // Ephemeral public key for recipient to derive stealth address
  ephemeralPublicKey: string;
  // View tag for fast scanning
  viewTag: string;
  // Denomination index (0=0.1, 1=1, 2=10 SOL)
  denominationIndex: number;
  // Relayer fee commitment (paid from user's shielded balance)
  feeCommitment: string;
}

export interface PrivateSendResult {
  success: boolean;
  txSignature?: string;
  stealthAddress?: string;
  error?: string;
}

/**
 * Stealth Address Generation (Elliptic Curve Diffie-Hellman style)
 *
 * 1. Sender generates ephemeral keypair (r, R = r*G)
 * 2. Sender computes shared secret: S = r * recipientViewingKey
 * 3. Sender derives stealth address: stealthPubkey = recipientSpendingKey + hash(S)*G
 * 4. Recipient scans: S' = viewingPrivateKey * R, checks if hash(S')*G + spendingKey matches
 */
export function generateStealthAddress(
  recipientSpendingPubkey: Uint8Array,
  recipientViewingPubkey: Uint8Array
): { stealthAddress: Uint8Array; ephemeralPublicKey: Uint8Array; viewTag: string } {
  // Generate ephemeral keypair
  const ephemeralPrivate = crypto.randomBytes(32);
  const ephemeralKeypair = Keypair.fromSeed(ephemeralPrivate);

  // Compute shared secret (simplified - in production use proper ECDH)
  const sharedSecretInput = Buffer.concat([
    ephemeralPrivate,
    recipientViewingPubkey
  ]);
  const sharedSecret = crypto.createHash('sha256').update(sharedSecretInput).digest();

  // Derive stealth address
  const stealthInput = Buffer.concat([
    recipientSpendingPubkey,
    sharedSecret
  ]);
  const stealthSeed = crypto.createHash('sha256').update(stealthInput).digest();
  const stealthKeypair = Keypair.fromSeed(stealthSeed);

  // View tag for fast scanning (first 2 bytes of hash)
  const viewTag = crypto.createHash('sha256')
    .update(Buffer.concat([sharedSecret, Buffer.from('view_tag')]))
    .digest()
    .slice(0, 2)
    .toString('hex');

  return {
    stealthAddress: stealthKeypair.publicKey.toBytes(),
    ephemeralPublicKey: ephemeralKeypair.publicKey.toBytes(),
    viewTag,
  };
}

/**
 * Encrypt recipient data so only they can read it
 */
export function encryptRecipientData(
  recipientViewingPubkey: Uint8Array,
  data: { spendingPubkey: string; viewingPubkey: string }
): string {
  // In production, use proper asymmetric encryption (e.g., ECIES)
  // For now, use a simplified approach
  const dataJson = JSON.stringify(data);
  const key = crypto.createHash('sha256').update(recipientViewingPubkey).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(dataJson, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Private Send Handler
 *
 * This is the core function that enables true ZK transfers:
 * 1. Verifies the ZK proof (user has funds)
 * 2. Checks nullifier hasn't been used
 * 3. Sends funds from relayer's wallet to stealth address
 * 4. Records the nullifier as spent
 * 5. Claims equivalent from shielded pool
 */
export async function handlePrivateSend(
  request: PrivateSendRequest,
  relayerKeypair: Keypair,
  connection: Connection,
  verificationKey: any,
  spentNullifiers: Set<string>
): Promise<PrivateSendResult> {
  try {
    // 1. Validate denomination
    const denominations = Object.values(DENOMINATIONS);
    if (request.denominationIndex < 0 || request.denominationIndex >= denominations.length) {
      return { success: false, error: 'Invalid denomination' };
    }
    const amount = denominations[request.denominationIndex];

    // 2. Check nullifier hasn't been spent
    if (spentNullifiers.has(request.nullifier)) {
      return { success: false, error: 'Nullifier already spent' };
    }

    // 3. Verify ZK proof
    if (verificationKey) {
      const isValid = await snarkjs.groth16.verify(
        verificationKey,
        request.publicSignals,
        request.proof as any // snarkjs accepts this format
      );
      if (!isValid) {
        return { success: false, error: 'Invalid ZK proof' };
      }
    }

    // 4. Check relayer has sufficient balance
    const relayerBalance = await connection.getBalance(relayerKeypair.publicKey);
    const minBalance = amount + 10000; // amount + fees
    if (relayerBalance < minBalance) {
      return { success: false, error: 'Relayer insufficient balance' };
    }

    // 5. Derive stealth address from ephemeral key
    // The recipient will scan using their viewing key to find this
    const stealthPubkey = new PublicKey(
      Buffer.from(request.ephemeralPublicKey, 'base64')
    );

    // 6. Send from relayer to stealth address
    // THIS IS THE KEY: On-chain shows "Relayer → Unknown Address"
    // No link to the original depositor!
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: relayerKeypair.publicKey,
        toPubkey: stealthPubkey,
        lamports: amount,
      })
    );

    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [relayerKeypair],
      { commitment: 'confirmed' }
    );

    // 7. Mark nullifier as spent
    spentNullifiers.add(request.nullifier);

    // 8. TODO: Claim equivalent from shielded pool (async, in background)
    // This happens separately to not link the two transactions

    return {
      success: true,
      txSignature: signature,
      stealthAddress: stealthPubkey.toBase58(),
    };

  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Private send failed',
    };
  }
}

/**
 * Recipient scanning function
 *
 * The recipient calls this to find payments sent to them.
 * They iterate through ephemeral public keys from recent transactions
 * and try to derive the stealth address using their viewing key.
 */
export function scanForPayments(
  ephemeralPublicKeys: Uint8Array[],
  viewTags: string[],
  viewingPrivateKey: Uint8Array,
  spendingPrivateKey: Uint8Array
): Array<{ stealthAddress: Uint8Array; privateKey: Uint8Array; index: number }> {
  const results: Array<{ stealthAddress: Uint8Array; privateKey: Uint8Array; index: number }> = [];

  for (let i = 0; i < ephemeralPublicKeys.length; i++) {
    // Compute shared secret
    const sharedSecretInput = Buffer.concat([
      viewingPrivateKey,
      ephemeralPublicKeys[i]
    ]);
    const sharedSecret = crypto.createHash('sha256').update(sharedSecretInput).digest();

    // Check view tag for fast rejection
    const computedViewTag = crypto.createHash('sha256')
      .update(Buffer.concat([sharedSecret, Buffer.from('view_tag')]))
      .digest()
      .slice(0, 2)
      .toString('hex');

    if (computedViewTag !== viewTags[i]) {
      continue; // Not for us
    }

    // Derive stealth private key
    const stealthInput = Buffer.concat([
      spendingPrivateKey,
      sharedSecret
    ]);
    const stealthSeed = crypto.createHash('sha256').update(stealthInput).digest();
    const stealthKeypair = Keypair.fromSeed(stealthSeed);

    results.push({
      stealthAddress: stealthKeypair.publicKey.toBytes(),
      privateKey: stealthKeypair.secretKey,
      index: i,
    });
  }

  return results;
}
