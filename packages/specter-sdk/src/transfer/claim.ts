import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import type { ClaimResult, StealthPayment, WalletAdapter } from '../types';
import { SpecterError, SpecterErrorCode } from '../types';
import { deriveStealthPrivateKey } from '../stealth/derive';
import { MIN_RENT_EXEMPTION } from '../constants';

// ============================================================================
// Claim proof construction (Ed25519 signature-based)
// ============================================================================

/** Domain separator matching the on-chain v1 verifier. */
const CLAIM_DOMAIN_V1 = new TextEncoder().encode('p01:claim:v1');

/** Domain separator matching the on-chain v2 verifier. */
const CLAIM_DOMAIN_V2 = new TextEncoder().encode('p01:claim:v2');

/**
 * Build an Ed25519 claim proof for a v1 stealth payment.
 *
 * The proof is a 64-byte Ed25519 signature over:
 *   SHA-256("p01:claim:v1" || stealthAddress || spendingPubKey)
 *
 * signed with the stealth private key. The on-chain verifier reconstructs
 * the same challenge and verifies the signature against the stealth address
 * (which is the Ed25519 public key).
 *
 * @param stealthKeypair - The derived stealth keypair (has the private key)
 * @param spendingPubKey - The claimer's spending public key (32 bytes)
 * @returns 64-byte Ed25519 signature
 */
export function buildClaimProof(
  stealthKeypair: Keypair,
  spendingPubKey: Uint8Array,
): Uint8Array {
  const stealthAddressBytes = stealthKeypair.publicKey.toBytes();

  // challenge = SHA-256(domain || stealth_address || spending_key)
  const challengeInput = new Uint8Array(
    CLAIM_DOMAIN_V1.length + 32 + 32
  );
  challengeInput.set(CLAIM_DOMAIN_V1, 0);
  challengeInput.set(stealthAddressBytes, CLAIM_DOMAIN_V1.length);
  challengeInput.set(spendingPubKey, CLAIM_DOMAIN_V1.length + 32);
  const challenge = sha256(challengeInput);

  // Sign the challenge with the stealth private key (Ed25519)
  return nacl.sign.detached(challenge, stealthKeypair.secretKey);
}

/**
 * Build an Ed25519 claim proof for a v2 hybrid stealth payment.
 *
 * The proof is a 64-byte Ed25519 signature over:
 *   SHA-256("p01:claim:v2" || stealthAddress || ephemeralPubKey || spendingPubKey)
 *
 * @param stealthKeypair - The derived stealth keypair
 * @param ephemeralPubKey - The sender's ephemeral public key (32 bytes)
 * @param spendingPubKey - The claimer's spending public key (32 bytes)
 * @returns 64-byte Ed25519 signature
 */
export function buildClaimProofV2(
  stealthKeypair: Keypair,
  ephemeralPubKey: Uint8Array,
  spendingPubKey: Uint8Array,
): Uint8Array {
  const stealthAddressBytes = stealthKeypair.publicKey.toBytes();

  // challenge = SHA-256(domain || stealth_address || ephemeral_pub_key || spending_key)
  const challengeInput = new Uint8Array(
    CLAIM_DOMAIN_V2.length + 32 + 32 + 32
  );
  challengeInput.set(CLAIM_DOMAIN_V2, 0);
  challengeInput.set(stealthAddressBytes, CLAIM_DOMAIN_V2.length);
  challengeInput.set(ephemeralPubKey, CLAIM_DOMAIN_V2.length + 32);
  challengeInput.set(spendingPubKey, CLAIM_DOMAIN_V2.length + 64);
  const challenge = sha256(challengeInput);

  return nacl.sign.detached(challenge, stealthKeypair.secretKey);
}

/**
 * Options for claiming a stealth payment
 */
export interface ClaimOptions {
  /** Solana connection */
  connection: Connection;
  /** The stealth payment to claim */
  payment: StealthPayment;
  /** Spending public key (32 bytes, used as HKDF salt for stealth seed derivation) */
  spendingPubKey: Uint8Array;
  /** Viewing private key (for deriving shared secret via ECDH) */
  viewingPrivateKey: Uint8Array;
  /** Destination address (defaults to sender's main wallet) */
  destination?: PublicKey;
  /** External wallet for signing destination transaction */
  destinationWallet?: Keypair | WalletAdapter;
  /** ML-KEM-768 secret key for hybrid v2 payments */
  kemSecretKey?: Uint8Array;
  /** Skip preflight checks */
  skipPreflight?: boolean;
}

/**
 * Claim a stealth payment
 * This derives the spending key and transfers funds to the destination
 *
 * @param options - Claim options
 */
export async function claimStealth(options: ClaimOptions): Promise<ClaimResult> {
  const {
    connection,
    payment,
    spendingPubKey,
    viewingPrivateKey,
    destination,
    destinationWallet,
    kemSecretKey,
    skipPreflight = false,
  } = options;

  // Check if already claimed
  if (payment.claimed) {
    throw new SpecterError(
      SpecterErrorCode.CLAIM_FAILED,
      'Payment has already been claimed'
    );
  }

  try {
    // Derive the stealth private key for this payment
    const stealthKeypair = deriveStealthPrivateKey(
      spendingPubKey,
      viewingPrivateKey,
      payment.ephemeralPubKey,
      kemSecretKey,
      payment.kemCiphertext
    );

    // Verify the derived key matches the stealth address
    if (!stealthKeypair.publicKey.equals(payment.stealthAddress)) {
      throw new SpecterError(
        SpecterErrorCode.CLAIM_FAILED,
        'Derived stealth key does not match payment address'
      );
    }

    // Determine destination address
    const destinationPubKey =
      destination ||
      (destinationWallet
        ? destinationWallet.publicKey
        : stealthKeypair.publicKey);

    // Get current balance at stealth address
    const balance = await getStealthBalance(
      connection,
      payment.stealthAddress,
      payment.tokenMint
    );

    if (balance <= 0n) {
      throw new SpecterError(
        SpecterErrorCode.CLAIM_FAILED,
        'No balance available to claim'
      );
    }

    // Create claim transaction
    const transaction = new Transaction();

    // Add compute budget
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 })
    );

    if (payment.tokenMint) {
      // Claim SPL tokens
      await addTokenClaimInstructions(
        connection,
        transaction,
        stealthKeypair.publicKey,
        payment.tokenMint,
        destinationPubKey,
        balance
      );
    } else {
      // Claim SOL
      // Leave minimum for rent if not closing account
      const amountToClaim = balance - MIN_RENT_EXEMPTION;

      if (amountToClaim <= 0n) {
        throw new SpecterError(
          SpecterErrorCode.CLAIM_FAILED,
          'Balance too low to claim (below rent exemption)'
        );
      }

      transaction.add(
        SystemProgram.transfer({
          fromPubkey: stealthKeypair.publicKey,
          toPubkey: destinationPubKey,
          lamports: amountToClaim,
        })
      );
    }

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = stealthKeypair.publicKey;

    // Sign with stealth keypair and send
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [stealthKeypair],
      { skipPreflight }
    );

    return {
      signature,
      amount: balance,
      destination: destinationPubKey,
      confirmed: true,
    };
  } catch (error) {
    if (error instanceof SpecterError) {
      throw error;
    }
    throw new SpecterError(
      SpecterErrorCode.CLAIM_FAILED,
      'Failed to claim stealth payment. This may be caused by an RPC error, insufficient SOL for fees, ' +
      'or the stealth account already being closed. Check your network connection and account balance.',
      error as Error
    );
  }
}

/**
 * Claim multiple stealth payments in a batch
 */
export async function claimMultiple(
  connection: Connection,
  payments: StealthPayment[],
  spendingPubKey: Uint8Array,
  viewingPrivateKey: Uint8Array,
  destination: PublicKey,
  kemSecretKey?: Uint8Array
): Promise<ClaimResult[]> {
  const results: ClaimResult[] = [];

  for (const payment of payments) {
    try {
      const result = await claimStealth({
        connection,
        payment,
        spendingPubKey,
        viewingPrivateKey,
        destination,
        kemSecretKey,
      });
      results.push(result);
    } catch (error) {
      console.error(`Failed to claim payment ${payment.signature}:`, error);
      // Continue with other payments
    }
  }

  return results;
}

/**
 * Get the balance of a stealth address
 */
export async function getStealthBalance(
  connection: Connection,
  stealthAddress: PublicKey,
  tokenMint?: PublicKey | null
): Promise<bigint> {
  if (tokenMint) {
    try {
      const ata = await getAssociatedTokenAddress(tokenMint, stealthAddress);
      const account = await getAccount(connection, ata);
      return account.amount;
    } catch {
      return 0n;
    }
  } else {
    const balance = await connection.getBalance(stealthAddress);
    return BigInt(balance);
  }
}

/**
 * Check if a stealth payment can be claimed
 */
export async function canClaim(
  connection: Connection,
  payment: StealthPayment
): Promise<{ canClaim: boolean; balance: bigint; reason?: string }> {
  const balance = await getStealthBalance(
    connection,
    payment.stealthAddress,
    payment.tokenMint
  );

  if (balance <= 0n) {
    return {
      canClaim: false,
      balance: 0n,
      reason: 'No balance available',
    };
  }

  if (!payment.tokenMint && balance <= MIN_RENT_EXEMPTION) {
    return {
      canClaim: false,
      balance,
      reason: 'Balance below rent exemption',
    };
  }

  return {
    canClaim: true,
    balance,
  };
}

/**
 * Estimate claim transaction fee
 */
export async function estimateClaimFee(
  connection: Connection,
  payment: StealthPayment,
  destination: PublicKey
): Promise<bigint> {
  const baseFee = 5000n;

  if (payment.tokenMint) {
    // Check if destination ATA exists
    const ata = await getAssociatedTokenAddress(payment.tokenMint, destination);
    try {
      await getAccount(connection, ata);
      return baseFee; // ATA exists, just transfer fee
    } catch {
      // Need to create ATA
      const rentExemption = await connection.getMinimumBalanceForRentExemption(165);
      return baseFee + BigInt(rentExemption);
    }
  }

  return baseFee;
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Add instructions for claiming SPL tokens
 */
async function addTokenClaimInstructions(
  connection: Connection,
  transaction: Transaction,
  stealthAddress: PublicKey,
  tokenMint: PublicKey,
  destination: PublicKey,
  amount: bigint
): Promise<void> {
  const sourceAta = await getAssociatedTokenAddress(tokenMint, stealthAddress);
  const destinationAta = await getAssociatedTokenAddress(tokenMint, destination);

  // Check if destination ATA exists
  try {
    await getAccount(connection, destinationAta);
  } catch {
    // Create destination ATA
    transaction.add(
      createAssociatedTokenAccountInstruction(
        stealthAddress, // payer
        destinationAta,
        destination,
        tokenMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer tokens
  transaction.add(
    createTransferInstruction(
      sourceAta,
      destinationAta,
      stealthAddress,
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );
}

/**
 * Close a claimed stealth account to reclaim rent
 */
export async function closeStealthAccount(
  connection: Connection,
  stealthKeypair: Keypair,
  destination: PublicKey,
  tokenMint?: PublicKey
): Promise<string> {
  const transaction = new Transaction();

  if (tokenMint) {
    const { createCloseAccountInstruction } = await import('@solana/spl-token');
    const ata = await getAssociatedTokenAddress(tokenMint, stealthKeypair.publicKey);

    transaction.add(
      createCloseAccountInstruction(
        ata,
        destination,
        stealthKeypair.publicKey,
        [],
        TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer remaining SOL
  const balance = await connection.getBalance(stealthKeypair.publicKey);
  const fee = 5000; // Estimated fee

  if (balance > fee) {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: stealthKeypair.publicKey,
        toPubkey: destination,
        lamports: balance - fee,
      })
    );
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = stealthKeypair.publicKey;

  return sendAndConfirmTransaction(connection, transaction, [stealthKeypair]);
}
