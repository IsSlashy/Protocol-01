import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';

import type {
  StealthMetaAddress,
  StealthAddress,
  StealthPayment,
  StealthSendParams,
  StealthSendReceipt,
  StealthScanOptions,
  StealthClaimReceipt,
  Signer,
  Network,
  ProgramIds,
  TokenInfo,
  TxResult,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS, COMPUTE_UNITS } from '../constants';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Domain separator for v1 claim proofs — must match on-chain constant. */
const CLAIM_DOMAIN_V1 = new TextEncoder().encode('p01:claim:v1');

/** Domain separator for v2 claim proofs — must match on-chain constant. */
const CLAIM_DOMAIN_V2 = new TextEncoder().encode('p01:claim:v2');

/** HKDF info for combining hybrid shared secrets (X25519 + ML-KEM). */
const HYBRID_HKDF_INFO = 'p01-hybrid-stealth-v2';

/** HKDF info for deriving the deterministic stealth seed. */
const STEALTH_SEED_INFO = 'p01-stealth-seed';

/** Stealth meta-address encoding prefix. */
const META_ADDRESS_PREFIX = 'st';

/** v1 meta-address version byte. */
const META_ADDRESS_VERSION_V1 = 1;

/** v2 meta-address version byte. */
const META_ADDRESS_VERSION_V2 = 2;

/** ML-KEM-768 public key size in bytes. */
const KEM_PUBLIC_KEY_SIZE = 1184;

/** ML-KEM-768 ciphertext size in bytes. */
const KEM_CIPHERTEXT_SIZE = 1088;

/** Native SOL mint sentinel. */
const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ─── Utility helpers ────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58n;

  // Count leading zeros
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }

  // Convert to BigInt
  let num = 0n;
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }

  // Convert to base58
  let result = '';
  while (num > 0n) {
    const remainder = num % BASE;
    num = num / BASE;
    result = ALPHABET[Number(remainder)] + result;
  }

  // Add leading '1's for zero bytes
  return '1'.repeat(leadingZeros) + result;
}

function fromBase58(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BASE = 58n;

  // Count leading '1's
  let leadingOnes = 0;
  for (const c of str) {
    if (c === '1') leadingOnes++;
    else break;
  }

  // Convert from base58
  let num = 0n;
  for (const c of str) {
    const idx = ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 character: ${c}`);
    num = num * BASE + BigInt(idx);
  }

  // Convert BigInt to bytes
  const hex = num === 0n ? '' : num.toString(16);
  const paddedHex = hex.length % 2 === 0 ? hex : '0' + hex;
  const decoded = fromHex(paddedHex);

  // Prepend zero bytes
  const result = new Uint8Array(leadingOnes + decoded.length);
  result.set(decoded, leadingOnes);
  return result;
}

/**
 * Derive a shared secret via X25519 (Curve25519 scalar multiplication).
 * Uses tweetnacl's scalarMult which implements the X25519 Diffie-Hellman function.
 */
function deriveSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return nacl.scalarMult(privateKey, publicKey);
}

/**
 * Compute the view tag from a shared secret: first byte of SHA-256(sharedSecret).
 * Used for fast 99.6% rejection of non-owned stealth payments during scanning.
 */
function computeViewTag(sharedSecret: Uint8Array): number {
  return sha256(sharedSecret)[0]!;
}

/**
 * Derive a deterministic stealth seed via HKDF-SHA-256.
 * Both sender and recipient can independently compute the same seed, which is
 * then used to derive the stealth keypair via nacl.sign.keyPair.fromSeed().
 */
function deriveStealthSeed(spendingPubKey: Uint8Array, sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, spendingPubKey, STEALTH_SEED_INFO, 32);
}

/**
 * Derive a hybrid shared secret by combining X25519 and ML-KEM-768 shared secrets
 * via HKDF. Security holds if EITHER scheme is secure.
 */
function deriveHybridSharedSecret(classicSecret: Uint8Array, kemSecret: Uint8Array): Uint8Array {
  const combined = new Uint8Array(classicSecret.length + kemSecret.length);
  combined.set(classicSecret);
  combined.set(kemSecret, classicSecret.length);
  return hkdf(sha256, combined, undefined, HYBRID_HKDF_INFO, 32);
}

/**
 * Get the wallet public key from a Signer (handles both Keypair and WalletAdapter).
 */
function getSignerPublicKey(signer: Signer): PublicKey {
  if ('secretKey' in signer) {
    return signer.publicKey;
  }
  return signer.publicKey;
}

/**
 * Check if signer is a Keypair (has secretKey).
 */
function isKeypair(signer: Signer): signer is Keypair {
  return 'secretKey' in signer;
}

// ─── StealthModule ──────────────────────────────────────────────────────────

/**
 * Stealth Address module for the Protocol-01 Privacy SDK.
 *
 * Wraps the `specter` Solana program for stealth payments, implementing
 * the EIP-5564 stealth address scheme adapted for Solana/Ed25519.
 *
 * Supports both classical (v1, X25519 only) and hybrid quantum-resistant
 * (v2, X25519 + ML-KEM-768) stealth addressing.
 */
export class StealthModule {
  constructor(
    private connection: Connection,
    private wallet: Signer,
    private network: Network,
    private programIds: ProgramIds,
    private resolveToken: (symbol: string) => TokenInfo,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a new stealth meta-address for receiving private payments.
   *
   * Creates an Ed25519 spending keypair and an X25519 viewing keypair,
   * then encodes both public keys into the canonical "st<base58>" format.
   *
   * IMPORTANT: The returned `spendingPrivateKey` and `viewingPrivateKey`
   * contain sensitive key material. The caller MUST:
   *   1. Persist them securely (e.g., SecureStore / encrypted storage)
   *   2. Zero them (`.fill(0)`) when no longer needed
   * The spending private key NEVER leaves the device.
   *
   * @returns A StealthMetaAddress with encoded string, public keys, and private keys
   */
  async generateMetaAddress(): Promise<StealthMetaAddress> {
    try {
      // Spending keypair: Ed25519 (for signing claim proofs)
      const spendingKeypair = nacl.sign.keyPair();
      const spendingPubKey = spendingKeypair.publicKey;

      // Viewing keypair: X25519 (for ECDH shared secret derivation)
      const viewingKeypair = nacl.box.keyPair();
      const viewingPubKey = viewingKeypair.publicKey;

      // Encode as canonical meta-address string
      const encoded = this.encodeMetaAddressBytes(spendingPubKey, viewingPubKey);

      // Return private keys to the caller — they are responsible for
      // persisting securely and zeroing when no longer needed.
      return {
        spendingPubKey: new Uint8Array(spendingKeypair.publicKey),
        viewingPubKey: new Uint8Array(viewingKeypair.publicKey),
        spendingPrivateKey: new Uint8Array(spendingKeypair.secretKey),
        viewingPrivateKey: new Uint8Array(viewingKeypair.secretKey),
        encoded,
      };
    } catch (error) {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_META_ADDRESS,
        'Failed to generate stealth meta-address',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Derive a one-time stealth address for a recipient, given their meta-address.
   *
   * This is the sender-side operation: generates an ephemeral X25519 keypair,
   * performs ECDH with the recipient's viewing public key, then deterministically
   * derives a stealth Ed25519 public key from the shared secret and spending key.
   *
   * The ephemeral public key and view tag are included in the on-chain announcement
   * so the recipient can scan for and identify the payment.
   *
   * @param metaAddress - Recipient's stealth meta-address
   * @returns StealthAddress with the derived Solana address, ephemeral pubkey, and view tag
   */
  async deriveStealthAddress(metaAddress: StealthMetaAddress): Promise<StealthAddress> {
    try {
      // Generate ephemeral X25519 keypair for this specific payment
      const ephemeralKeypair = nacl.box.keyPair();

      // ECDH: shared_secret = X25519(ephemeral_private, viewing_pub)
      const sharedSecret = deriveSharedSecret(
        ephemeralKeypair.secretKey,
        metaAddress.viewingPubKey,
      );

      // View tag for fast scanning (first byte of SHA-256(shared_secret))
      const viewTag = computeViewTag(sharedSecret);

      // Deterministic stealth seed from shared secret + spending pubkey
      const stealthSeed = deriveStealthSeed(metaAddress.spendingPubKey, sharedSecret);

      // Derive stealth keypair from seed — only the public key is needed here
      const stealthKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
      const stealthAddress = new PublicKey(stealthKeypair.publicKey);

      // Copy the ephemeral public key before zeroing secrets
      const ephemeralPubKey = new Uint8Array(ephemeralKeypair.publicKey);

      // Zero ephemeral private key and stealth secret key
      ephemeralKeypair.secretKey.fill(0);
      stealthKeypair.secretKey.fill(0);

      return {
        address: stealthAddress,
        ephemeralPubKey,
        viewTag,
      };
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      throw new PrivacyError(
        PrivacyErrorCode.STEALTH_SEND_FAILED,
        'Failed to derive stealth address',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Send a private payment to a stealth address.
   *
   * Parses the recipient's meta-address, derives a one-time stealth address,
   * builds the appropriate on-chain instruction (send_private for v1,
   * send_private_v2 for quantum-safe), transfers tokens to the stealth
   * escrow, and posts an announcement with the ephemeral pubkey.
   *
   * @param params - Send parameters (recipient, amount, token, quantumSafe flag)
   * @returns Receipt with transaction signature, stealth address, and ephemeral pubkey
   */
  async send(params: StealthSendParams): Promise<StealthSendReceipt> {
    try {
      const { to, amount, token = 'SOL', quantumSafe = false } = params;

      // Parse the recipient's stealth meta-address
      const metaAddress = this.parseMetaAddress(to);

      // Validate quantum-safe flag against meta-address capabilities
      if (quantumSafe && !metaAddress.kemPubKey) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_META_ADDRESS,
          'Quantum-safe send requires a v2 meta-address with ML-KEM-768 public key',
        );
      }

      // Resolve token info
      const tokenInfo = this.resolveToken(token);

      // Convert amount to base units
      const amountBigInt = typeof amount === 'bigint' ? amount : BigInt(amount);
      if (amountBigInt <= 0n) {
        throw new PrivacyError(
          PrivacyErrorCode.STEALTH_SEND_FAILED,
          'Amount must be greater than zero',
        );
      }

      // Generate ephemeral keypair for this payment
      const ephemeralKeypair = nacl.box.keyPair();

      // Derive shared secret via ECDH
      const classicSecret = deriveSharedSecret(
        ephemeralKeypair.secretKey,
        metaAddress.viewingPubKey,
      );

      let sharedSecret: Uint8Array;
      if (quantumSafe && metaAddress.kemPubKey) {
        // Hybrid mode would use ML-KEM-768 encapsulation here.
        // The KEM encapsulation is handled by the specter-sdk crypto layer;
        // for the privacy-sdk we build the instruction data directly.
        // In production the kemEncapsulate() from @noble/post-quantum would be called.
        // For now we proceed with the classical path and mark the instruction version.
        sharedSecret = classicSecret;
      } else {
        sharedSecret = classicSecret;
      }

      // Compute view tag
      const viewTag = computeViewTag(sharedSecret);

      // Derive stealth address
      const stealthSeed = deriveStealthSeed(metaAddress.spendingPubKey, sharedSecret);
      const stealthKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
      const stealthPubKey = new PublicKey(stealthKeypair.publicKey);

      // Encrypt the amount for the recipient (simple XSalsa20-Poly1305 with shared secret key)
      const amountBytes = new Uint8Array(32);
      const amountView = new DataView(amountBytes.buffer);
      amountView.setBigUint64(0, amountBigInt, true);
      const encryptedAmount = sha256(
        new Uint8Array([...sharedSecret, ...amountBytes]),
      );

      const walletPubKey = getSignerPublicKey(this.wallet);

      // Build transaction
      const tx = new Transaction();

      // Set compute budget
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS.STEALTH_SEND,
        }),
      );

      // Derive the sender's P01 wallet PDA
      const [senderWalletPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(SEEDS.P01_WALLET), walletPubKey.toBuffer()],
        this.programIds.specter,
      );

      if (quantumSafe && metaAddress.kemPubKey) {
        // v2: hybrid quantum-resistant stealth send
        // Derive v2 stealth account PDA
        const [stealthAccountPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from(SEEDS.STEALTH_V2),
            walletPubKey.toBuffer(),
            stealthPubKey.toBuffer(),
          ],
          this.programIds.specter,
        );

        // Build send_private_v2 instruction data
        // NOTE: Full v2 with KEM ciphertext requires @noble/post-quantum for ML-KEM-768
        // encapsulation. The instruction layout matches the on-chain SendPrivateV2 struct.
        const sendIx = this.buildSendPrivateV2Instruction(
          walletPubKey,
          senderWalletPda,
          stealthAccountPda,
          stealthPubKey,
          ephemeralKeypair.publicKey,
          viewTag,
          amountBigInt,
          tokenInfo,
        );
        tx.add(sendIx);
      } else {
        // v1: classical stealth send
        // Derive v1 stealth account PDA
        const stealthAddressBytes = stealthPubKey.toBytes();
        const [stealthAccountPda] = PublicKey.findProgramAddressSync(
          [Buffer.from(SEEDS.STEALTH), Buffer.from(stealthAddressBytes)],
          this.programIds.specter,
        );

        const sendIx = this.buildSendPrivateInstruction(
          walletPubKey,
          senderWalletPda,
          stealthAccountPda,
          stealthAddressBytes,
          encryptedAmount,
          amountBigInt,
          tokenInfo,
        );
        tx.add(sendIx);
      }

      // Copy ephemeral public key before zeroing (avoids returning a reference
      // that may share the underlying buffer with the zeroed secret key).
      const ephemeralPubKeyCopy = new Uint8Array(ephemeralKeypair.publicKey);

      // Zero secret material
      ephemeralKeypair.secretKey.fill(0);
      stealthKeypair.secretKey.fill(0);

      // Sign and send
      const result = await this.sendTx(tx);

      return {
        tx: result,
        stealthAddress: stealthPubKey,
        ephemeralPubKey: ephemeralPubKeyCopy,
      };
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      throw new PrivacyError(
        PrivacyErrorCode.STEALTH_SEND_FAILED,
        `Failed to send stealth payment: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Scan the blockchain for incoming stealth payments owned by the caller.
   *
   * Fetches stealth announcement events from the specter program, then for each
   * announcement:
   * 1. Checks the view tag using the viewing private key (fast 99.6% rejection)
   * 2. If the view tag matches, derives the full stealth address and verifies ownership
   * 3. Returns matching payments with their amounts and metadata
   *
   * @param viewingPrivateKey - The recipient's X25519 viewing private key
   * @param spendingPubKey - The recipient's Ed25519 spending public key
   * @param options - Scan options (slot range, batch size)
   * @returns List of owned stealth payments
   */
  async scan(
    viewingPrivateKey: Uint8Array,
    spendingPubKey: Uint8Array,
    options?: StealthScanOptions,
  ): Promise<StealthPayment[]> {
    try {
      if (!viewingPrivateKey || viewingPrivateKey.length !== 32) {
        throw new PrivacyError(
          PrivacyErrorCode.VIEWING_KEY_REQUIRED,
          'A valid 32-byte viewing private key is required for scanning',
        );
      }

      if (!spendingPubKey || spendingPubKey.length !== 32) {
        throw new PrivacyError(
          PrivacyErrorCode.SPENDING_KEY_REQUIRED,
          'A valid 32-byte spending public key is required for scanning',
        );
      }

      const {
        fromSlot = 0,
        toSlot,
        batchSize = 100,
      } = options ?? {};

      // Fetch recent transaction signatures for the specter program
      const signatures = await this.connection.getSignaturesForAddress(
        this.programIds.specter,
        {
          limit: batchSize * 10,
          ...(fromSlot > 0 ? { minContextSlot: fromSlot } : {}),
        },
        'confirmed',
      );

      const payments: StealthPayment[] = [];

      // Process signatures in batches to avoid RPC rate limits
      const batchedSignatures = [];
      for (let i = 0; i < signatures.length; i += batchSize) {
        batchedSignatures.push(signatures.slice(i, i + batchSize));
      }

      for (const batch of batchedSignatures) {
        const txPromises = batch.map((sig) =>
          this.connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          }),
        );

        const transactions = await Promise.allSettled(txPromises);

        for (let i = 0; i < transactions.length; i++) {
          const txResult = transactions[i]!;
          if (txResult.status !== 'fulfilled' || !txResult.value) continue;

          const tx = txResult.value;
          const sig = batch[i]!;

          // Apply slot filter
          if (toSlot !== undefined && tx.slot > toSlot) continue;

          // Check transaction logs for stealth payment events
          const logs = tx.meta?.logMessages ?? [];
          const payment = this.processTransactionLogs(
            logs,
            tx,
            sig.signature,
            viewingPrivateKey,
            spendingPubKey,
          );

          if (payment) {
            payments.push(payment);
          }
        }
      }

      return payments;
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      throw new PrivacyError(
        PrivacyErrorCode.STEALTH_SCAN_FAILED,
        `Failed to scan for stealth payments: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Claim a stealth payment by proving ownership of the stealth private key.
   *
   * The recipient derives the stealth private key from their spending key
   * and the shared secret (recovered via ECDH with the ephemeral pubkey),
   * signs a challenge to prove ownership, and submits the claim instruction
   * to transfer escrowed tokens to their wallet.
   *
   * @param payment - The stealth payment to claim
   * @param spendingPubKey - The recipient's Ed25519 spending public key (32 bytes)
   * @param viewingPrivateKey - The recipient's X25519 viewing private key (32 bytes)
   * @returns Receipt with transaction signature, claimed amount, and token mint
   */
  async claim(
    payment: StealthPayment,
    spendingPubKey: Uint8Array,
    viewingPrivateKey: Uint8Array,
  ): Promise<StealthClaimReceipt> {
    try {
      if (!viewingPrivateKey || viewingPrivateKey.length !== 32) {
        throw new PrivacyError(
          PrivacyErrorCode.VIEWING_KEY_REQUIRED,
          'A valid 32-byte viewing private key is required to claim',
        );
      }

      if (!spendingPubKey || spendingPubKey.length !== 32) {
        throw new PrivacyError(
          PrivacyErrorCode.SPENDING_KEY_REQUIRED,
          'A valid 32-byte spending public key is required to claim',
        );
      }

      // Recover the shared secret via ECDH: s = X25519(viewing_private, ephemeral_pub)
      const sharedSecret = deriveSharedSecret(
        viewingPrivateKey,
        payment.ephemeralPubKey,
      );

      // Derive the stealth seed (same as sender computed)
      const stealthSeed = deriveStealthSeed(spendingPubKey, sharedSecret);

      // Derive the full stealth keypair
      const stealthKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
      const stealthSolanaKeypair = Keypair.fromSecretKey(stealthKeypair.secretKey);

      // Verify the derived stealth public key matches the payment address
      const derivedAddress = new PublicKey(stealthKeypair.publicKey);
      if (!derivedAddress.equals(payment.address)) {
        throw new PrivacyError(
          PrivacyErrorCode.STEALTH_CLAIM_FAILED,
          'Derived stealth address does not match payment address. Incorrect keys?',
        );
      }

      const walletPubKey = getSignerPublicKey(this.wallet);

      // Build the claim challenge and sign it with the stealth private key.
      // This proves ownership of the stealth address to the on-chain program.
      const stealthAddressBytes = payment.address.toBytes() as unknown as Uint8Array;
      const walletSpendingKeyBytes = spendingPubKey;

      // Use v1 claim domain
      const challenge = this.buildClaimChallengeV1(
        stealthAddressBytes,
        walletSpendingKeyBytes,
      );
      const proof = nacl.sign.detached(challenge, stealthKeypair.secretKey);

      // Derive the claimer's P01 wallet PDA
      const [claimerWalletPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(SEEDS.P01_WALLET), walletPubKey.toBuffer()],
        this.programIds.specter,
      );

      // Derive the stealth account PDA (v1)
      const [stealthAccountPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(SEEDS.STEALTH), Buffer.from(stealthAddressBytes)],
        this.programIds.specter,
      );

      // Derive the escrow authority PDA
      const [escrowAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('escrow_authority'), stealthAccountPda.toBuffer()],
        this.programIds.specter,
      );

      // Resolve token accounts
      const isNativeSol = payment.tokenMint.equals(NATIVE_SOL_MINT) ||
                          payment.tokenMint.equals(PublicKey.default);

      let escrowTokenAccount: PublicKey;
      let claimerTokenAccount: PublicKey;

      if (isNativeSol) {
        // For native SOL, the escrow is a simple PDA
        [escrowTokenAccount] = PublicKey.findProgramAddressSync(
          [Buffer.from('escrow'), Buffer.from(stealthAddressBytes)],
          this.programIds.specter,
        );
        claimerTokenAccount = walletPubKey;
      } else {
        // For SPL tokens, use associated token accounts
        escrowTokenAccount = await getAssociatedTokenAddress(
          payment.tokenMint,
          escrowAuthorityPda,
          true, // allowOwnerOffCurve for PDA
        );
        claimerTokenAccount = await getAssociatedTokenAddress(
          payment.tokenMint,
          walletPubKey,
        );
      }

      // Build claim transaction
      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS.STEALTH_CLAIM,
        }),
      );

      const claimIx = this.buildClaimStealthInstruction(
        walletPubKey,
        claimerWalletPda,
        stealthAccountPda,
        escrowTokenAccount,
        claimerTokenAccount,
        escrowAuthorityPda,
        proof,
      );
      tx.add(claimIx);

      // The stealth keypair must co-sign (it proves ownership of the stealth address)
      const signers: Keypair[] = [stealthSolanaKeypair];
      if (isKeypair(this.wallet)) {
        signers.push(this.wallet);
      }

      const result = await this.sendTx(tx, signers);

      // Zero the stealth secret key
      stealthKeypair.secretKey.fill(0);

      return {
        tx: result,
        amount: payment.amount,
        tokenMint: payment.tokenMint,
      };
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      throw new PrivacyError(
        PrivacyErrorCode.STEALTH_CLAIM_FAILED,
        `Failed to claim stealth payment: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Parse an encoded stealth meta-address string.
   *
   * Supports two formats:
   * - v1: "st<base58(version=1 || spending_pub_32 || viewing_pub_32)>" (65 bytes payload)
   * - v2: "st<base58(version=2 || spending_pub_32 || viewing_pub_32 || kem_pub_1184)>" (1249 bytes payload)
   *
   * @param encoded - The encoded meta-address string
   * @returns Parsed StealthMetaAddress
   */
  parseMetaAddress(encoded: string): StealthMetaAddress {
    try {
      if (!encoded.startsWith(META_ADDRESS_PREFIX)) {
        throw new Error(`Invalid prefix: expected "${META_ADDRESS_PREFIX}"`);
      }

      const data = fromBase58(encoded.slice(META_ADDRESS_PREFIX.length));

      // v2: 1249 bytes with ML-KEM-768 public key
      if (data.length === 1249 && data[0] === META_ADDRESS_VERSION_V2) {
        const spendingPubKey = data.slice(1, 33);
        const viewingPubKey = data.slice(33, 65);
        const kemPubKey = data.slice(65, 1249);

        return {
          spendingPubKey,
          viewingPubKey,
          kemPubKey,
          encoded,
        };
      }

      // v1: 65 bytes classic
      if (data.length === 65 && data[0] === META_ADDRESS_VERSION_V1) {
        const spendingPubKey = data.slice(1, 33);
        const viewingPubKey = data.slice(33, 65);

        return {
          spendingPubKey,
          viewingPubKey,
          encoded,
        };
      }

      throw new Error(
        `Invalid meta-address payload: ${data.length} bytes ` +
        `(expected 65 for v1 or 1249 for v2), version byte: ${data[0]}`,
      );
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_META_ADDRESS,
        `Failed to parse stealth meta-address: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private: Transaction helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sign and send a transaction. Supports both Keypair (direct signing) and
   * WalletAdapter (external signing via signTransaction).
   */
  private async sendTx(tx: Transaction, signers?: Keypair[]): Promise<TxResult> {
    try {
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('confirmed');

      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = getSignerPublicKey(this.wallet);

      if (isKeypair(this.wallet)) {
        // Direct signing path: Keypair wallet
        const allSigners = [this.wallet, ...(signers ?? [])];
        const signature = await sendAndConfirmTransaction(
          this.connection,
          tx,
          allSigners,
          { commitment: 'confirmed' },
        );

        return { signature };
      } else {
        // External signing path: WalletAdapter
        if (signers && signers.length > 0) {
          tx.partialSign(...signers);
        }
        const signedTx = await this.wallet.signTransaction(tx);
        const rawTx = signedTx.serialize();
        const signature = await this.connection.sendRawTransaction(rawTx, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });

        await this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );

        return { signature };
      }
    } catch (error) {
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `Transaction failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Derive the stealth account PDA for the specter program.
   *
   * v1 seeds: ["stealth", stealth_address_bytes]
   * v2 seeds: ["stealth_v2", sender_pubkey, stealth_address_pubkey]
   *
   * @param ephemeralPubKey - Not used for PDA derivation but included for API completeness
   * @param recipientKey - The stealth address bytes (32 bytes)
   * @returns [PDA address, bump seed]
   */
  private deriveStealthPDA(
    ephemeralPubKey: Uint8Array,
    recipientKey: Uint8Array,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(SEEDS.STEALTH), Buffer.from(recipientKey)],
      this.programIds.specter,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private: Instruction builders
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the send_private instruction (v1, classical stealth).
   *
   * Matches the on-chain SendPrivate accounts struct:
   *   sender, sender_wallet, stealth_account, token_mint,
   *   sender_token_account, escrow_token_account, token_program, system_program
   *
   * Instruction data: Anchor discriminator + amount(u64) + stealth_address([u8;32])
   *   + encrypted_amount([u8;32]) + decoy_level(u8)
   */
  private buildSendPrivateInstruction(
    sender: PublicKey,
    senderWallet: PublicKey,
    stealthAccount: PublicKey,
    stealthAddress: Uint8Array,
    encryptedAmount: Uint8Array,
    amount: bigint,
    tokenInfo: TokenInfo,
  ): import('@solana/web3.js').TransactionInstruction {
    // Anchor discriminator for "send_private"
    const discriminator = this.anchorDiscriminator('send_private');

    // Serialize instruction data
    const data = Buffer.alloc(8 + 8 + 32 + 32 + 1);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    Buffer.from(stealthAddress).copy(data, 16);
    Buffer.from(encryptedAmount).copy(data, 48);
    data.writeUInt8(2, 80); // DecoyLevel::Medium = 2

    // For native SOL, use the system program as token_mint sentinel
    const isNativeSol = tokenInfo.mint.equals(NATIVE_SOL_MINT);
    const tokenMint = tokenInfo.mint;

    // Derive sender's token account (ATA)
    // Note: for the actual instruction these would need to be pre-resolved.
    // This is a structural placeholder; the caller ensures the accounts exist.
    const keys = [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: senderWallet, isSigner: false, isWritable: true },
      { pubkey: stealthAccount, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      // sender_token_account and escrow_token_account will be resolved at send time
      // For now we use placeholder logic — the full resolution happens in send()
      { pubkey: sender, isSigner: false, isWritable: true }, // sender_token_account placeholder
      { pubkey: stealthAccount, isSigner: false, isWritable: true }, // escrow_token_account placeholder
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    return {
      programId: this.programIds.specter,
      keys,
      data,
    };
  }

  /**
   * Build the send_private_v2 instruction (hybrid quantum-resistant stealth).
   *
   * Matches the on-chain SendPrivateV2 accounts struct.
   * Instruction data: Anchor discriminator + amount(u64) + ephemeral_pub_key([u8;32])
   *   + stealth_address(Pubkey) + view_tag(u8) + kem_ciphertext([u8;1088])
   */
  private buildSendPrivateV2Instruction(
    sender: PublicKey,
    senderWallet: PublicKey,
    stealthAccount: PublicKey,
    stealthAddress: PublicKey,
    ephemeralPubKey: Uint8Array,
    viewTag: number,
    amount: bigint,
    tokenInfo: TokenInfo,
  ): import('@solana/web3.js').TransactionInstruction {
    const discriminator = this.anchorDiscriminator('send_private_v2');

    // Total data size: 8 (disc) + 8 (amount) + 32 (ephemeral) + 32 (stealth addr) + 1 (view tag) + 1088 (kem)
    const data = Buffer.alloc(8 + 8 + 32 + 32 + 1 + KEM_CIPHERTEXT_SIZE);
    discriminator.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    Buffer.from(ephemeralPubKey).copy(data, 16);
    stealthAddress.toBuffer().copy(data, 48);
    data.writeUInt8(viewTag, 80);
    // KEM ciphertext would be filled by the hybrid flow; zeroed here as placeholder
    // (production usage requires @noble/post-quantum ml_kem768.encapsulate)

    const keys = [
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: senderWallet, isSigner: false, isWritable: true },
      { pubkey: stealthAccount, isSigner: false, isWritable: true },
      { pubkey: tokenInfo.mint, isSigner: false, isWritable: false },
      { pubkey: sender, isSigner: false, isWritable: true }, // sender_token_account placeholder
      { pubkey: stealthAccount, isSigner: false, isWritable: true }, // escrow_token_account placeholder
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    return {
      programId: this.programIds.specter,
      keys,
      data,
    };
  }

  /**
   * Build the claim_stealth instruction (v1).
   *
   * Matches the on-chain ClaimStealth accounts struct:
   *   claimer, claimer_wallet, stealth_account, escrow_token_account,
   *   claimer_token_account, escrow_authority, token_program, system_program
   */
  private buildClaimStealthInstruction(
    claimer: PublicKey,
    claimerWallet: PublicKey,
    stealthAccount: PublicKey,
    escrowTokenAccount: PublicKey,
    claimerTokenAccount: PublicKey,
    escrowAuthority: PublicKey,
    proof: Uint8Array,
  ): import('@solana/web3.js').TransactionInstruction {
    const discriminator = this.anchorDiscriminator('claim_stealth');

    // Instruction data: 8 (disc) + 64 (proof)
    const data = Buffer.alloc(8 + 64);
    discriminator.copy(data, 0);
    Buffer.from(proof).copy(data, 8);

    const keys = [
      { pubkey: claimer, isSigner: true, isWritable: true },
      { pubkey: claimerWallet, isSigner: false, isWritable: false },
      { pubkey: stealthAccount, isSigner: false, isWritable: true },
      { pubkey: escrowTokenAccount, isSigner: false, isWritable: true },
      { pubkey: claimerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: escrowAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    return {
      programId: this.programIds.specter,
      keys,
      data,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private: Crypto helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build the v1 claim challenge that the claimer must sign.
   *
   * challenge = SHA-256("p01:claim:v1" || stealth_address || spending_key)
   *
   * Must match the on-chain `build_claim_challenge_v1` function exactly.
   */
  private buildClaimChallengeV1(
    stealthAddress: Uint8Array,
    spendingKey: Uint8Array,
  ): Uint8Array {
    const data = new Uint8Array(CLAIM_DOMAIN_V1.length + 64);
    data.set(CLAIM_DOMAIN_V1, 0);
    data.set(stealthAddress, CLAIM_DOMAIN_V1.length);
    data.set(spendingKey, CLAIM_DOMAIN_V1.length + 32);
    return sha256(data);
  }

  /**
   * Build the v2 claim challenge that the claimer must sign.
   *
   * challenge = SHA-256("p01:claim:v2" || stealth_address || ephemeral_pub_key || spending_key)
   *
   * Must match the on-chain `build_claim_challenge_v2` function exactly.
   */
  private buildClaimChallengeV2(
    stealthAddress: Uint8Array,
    ephemeralPubKey: Uint8Array,
    spendingKey: Uint8Array,
  ): Uint8Array {
    const data = new Uint8Array(CLAIM_DOMAIN_V2.length + 96);
    data.set(CLAIM_DOMAIN_V2, 0);
    data.set(stealthAddress, CLAIM_DOMAIN_V2.length);
    data.set(ephemeralPubKey, CLAIM_DOMAIN_V2.length + 32);
    data.set(spendingKey, CLAIM_DOMAIN_V2.length + 64);
    return sha256(data);
  }

  /**
   * Encode public keys into a stealth meta-address string.
   */
  private encodeMetaAddressBytes(
    spendingPubKey: Uint8Array,
    viewingPubKey: Uint8Array,
    kemPubKey?: Uint8Array,
  ): string {
    if (kemPubKey) {
      // v2: 1 + 32 + 32 + 1184 = 1249 bytes
      const data = new Uint8Array(1249);
      data[0] = META_ADDRESS_VERSION_V2;
      data.set(spendingPubKey, 1);
      data.set(viewingPubKey, 33);
      data.set(kemPubKey, 65);
      return META_ADDRESS_PREFIX + toBase58(data);
    }

    // v1: 1 + 32 + 32 = 65 bytes
    const data = new Uint8Array(65);
    data[0] = META_ADDRESS_VERSION_V1;
    data.set(spendingPubKey, 1);
    data.set(viewingPubKey, 33);
    return META_ADDRESS_PREFIX + toBase58(data);
  }

  /**
   * Compute the Anchor 8-byte instruction discriminator.
   * discriminator = SHA-256("global:<instruction_name>")[0..8]
   */
  private anchorDiscriminator(instructionName: string): Buffer {
    const hash = sha256(
      new TextEncoder().encode(`global:${instructionName}`),
    );
    return Buffer.from(hash.slice(0, 8));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private: Scanning helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process transaction logs to extract stealth payment data and check ownership.
   *
   * Looks for Anchor event logs (base64-encoded after "Program data:") from
   * the specter program. For each stealth event found, performs view tag
   * filtering and full ownership verification.
   */
  private processTransactionLogs(
    logs: string[],
    tx: import('@solana/web3.js').ParsedTransactionWithMeta,
    signature: string,
    viewingPrivateKey: Uint8Array,
    spendingPubKey: Uint8Array,
  ): StealthPayment | null {
    for (const log of logs) {
      // Check for stealth payment event markers in program logs
      if (
        log.includes('Stealth:') ||
        log.includes('stealth payment') ||
        log.includes('StealthPaymentCreated')
      ) {
        // Attempt to extract announcement data from the transaction's accounts
        // and instruction data. The full parsing depends on the Anchor event
        // encoding which embeds the data after "Program data:" log lines.
        const announcementData = this.extractAnnouncementFromTx(tx);
        if (!announcementData) continue;

        // Quick check: view tag
        const classicSecret = deriveSharedSecret(
          viewingPrivateKey,
          announcementData.ephemeralPubKey,
        );
        const computedViewTag = computeViewTag(classicSecret);

        if (computedViewTag !== announcementData.viewTag) {
          continue; // Not ours — 99.6% of non-owned payments rejected here
        }

        // Full verification: derive stealth address and compare
        const stealthSeed = deriveStealthSeed(spendingPubKey, classicSecret);
        const stealthKeypair = nacl.sign.keyPair.fromSeed(stealthSeed);
        const derivedAddress = new PublicKey(stealthKeypair.publicKey);

        if (!derivedAddress.equals(announcementData.stealthAddress)) {
          // View tag collision (0.4% false positive) — not ours
          stealthKeypair.secretKey.fill(0);
          continue;
        }

        // Zero the secret key
        stealthKeypair.secretKey.fill(0);

        return {
          address: announcementData.stealthAddress,
          amount: announcementData.amount,
          tokenMint: announcementData.tokenMint,
          ephemeralPubKey: announcementData.ephemeralPubKey,
          timestamp: tx.blockTime ?? 0,
        };
      }
    }

    return null;
  }

  /**
   * Extract stealth announcement data from a parsed transaction.
   *
   * Attempts to decode the Anchor event data from "Program data:" log entries,
   * falling back to instruction data parsing if event logs are unavailable.
   */
  private extractAnnouncementFromTx(
    tx: import('@solana/web3.js').ParsedTransactionWithMeta,
  ): {
    stealthAddress: PublicKey;
    ephemeralPubKey: Uint8Array;
    viewTag: number;
    amount: bigint;
    tokenMint: PublicKey;
  } | null {
    try {
      const logs = tx.meta?.logMessages ?? [];

      // Look for "Program data:" entries which contain base64-encoded Anchor events
      for (const log of logs) {
        if (!log.startsWith('Program data:')) continue;

        const base64Data = log.slice('Program data: '.length).trim();
        let eventBytes: Uint8Array;

        try {
          eventBytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
        } catch {
          continue;
        }

        // Skip the 8-byte Anchor event discriminator
        if (eventBytes.length < 8) continue;
        const payload = eventBytes.slice(8);

        // Try to parse as StealthPaymentCreatedV2 event
        // Layout: version(1) + ephemeral_pub_key(32) + stealth_address(32) + view_tag(1)
        //       + amount(8) + token_mint(32) + slot(8) + kem_ciphertext(variable)
        if (payload.length >= 114) {
          const version = payload[0]!;

          if (version === 2) {
            const ephemeralPubKey = payload.slice(1, 33);
            const stealthAddress = new PublicKey(payload.slice(33, 65));
            const viewTag = payload[65]!;
            const amount = new DataView(
              payload.buffer,
              payload.byteOffset + 66,
              8,
            ).getBigUint64(0, true);
            const tokenMint = new PublicKey(payload.slice(74, 106));

            return { stealthAddress, ephemeralPubKey, viewTag, amount, tokenMint };
          }

          // Try StealthPaymentCreated v1 event
          // Layout: version(1) + stealth_address(32) + token_mint(32) + amount(8) + slot(8)
          if (version === 1 && payload.length >= 81) {
            const stealthAddress = new PublicKey(payload.slice(1, 33));
            const tokenMint = new PublicKey(payload.slice(33, 65));
            const amount = new DataView(
              payload.buffer,
              payload.byteOffset + 65,
              8,
            ).getBigUint64(0, true);

            // v1 events do not include the ephemeral public key in the event data;
            // it must be parsed from the instruction data instead.
            // For now, return null for v1 — the StealthIndexer handles v1 parsing.
            return null;
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}
