import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  Keypair,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import { poseidon2, poseidon3 } from 'poseidon-lite';
import type { Signer, Network, ProgramIds, TokenInfo, TxResult } from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS } from '../constants';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum Merkle tree depth (supports up to 2^20 = 1,048,576 recipients). */
const MAX_TREE_DEPTH = 20;

/** Default campaign expiry: 30 days in seconds. */
const DEFAULT_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

/** Maximum campaign name length in bytes (UTF-8). */
const MAX_NAME_LENGTH = 32;

/** Compute budget for create_airdrop instruction. */
const CREATE_AIRDROP_CU = 300_000;

/** Compute budget for claim_airdrop instruction. */
const CLAIM_AIRDROP_CU = 400_000;

/** Compute budget for close_airdrop instruction. */
const CLOSE_AIRDROP_CU = 200_000;

/** PDA seed prefixes. */
const AIRDROP_SEED = 'airdrop';
const AIRDROP_NULLIFIER_SEED = 'airdrop_nullifier';
const AIRDROP_ESCROW_SEED = 'airdrop_escrow';

/** Native SOL mint sentinel. */
const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// ─── Exported Types ─────────────────────────────────────────────────────────

export interface AirdropRecipient {
  /** Stealth meta-address string (st:...) or PublicKey */
  address: string | PublicKey;
  /** Amount in token base units */
  amount: bigint;
}

export interface AirdropCampaignConfig {
  /** Token to airdrop */
  token: string;
  /** List of recipients with amounts */
  recipients: AirdropRecipient[];
  /** Campaign name (max 32 chars) */
  name?: string;
  /** Expiry in seconds from now (default: 30 days) */
  expiresIn?: number;
  /** Use stealth addresses for recipients (default: true) */
  useStealth?: boolean;
}

export interface AirdropCampaign {
  address: PublicKey;
  creator: PublicKey;
  tokenMint: PublicKey;
  merkleRoot: bigint;
  totalAmount: bigint;
  claimedCount: number;
  totalRecipients: number;
  createdAt: number;
  expiresAt: number;
  name: string;
  isActive: boolean;
}

export interface AirdropLeaf {
  recipient: PublicKey;
  amount: bigint;
  salt: bigint;
  index: number;
  commitment: bigint;
}

export interface AirdropMerkleTree {
  root: bigint;
  leaves: AirdropLeaf[];
  depth: number;
}

export interface AirdropClaimParams {
  campaign: PublicKey;
  leafIndex: number;
  amount: bigint;
  salt: bigint;
  /** Merkle proof path elements */
  proofElements: bigint[];
  /** Merkle proof path indices (0=left, 1=right) */
  proofIndices: number[];
}

export interface AirdropCreateResult {
  tx: TxResult;
  campaignAddress: PublicKey;
  merkleTree: AirdropMerkleTree;
}

export interface AirdropClaimResult {
  tx: TxResult;
  amount: bigint;
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Anchor-style 8-byte instruction discriminator: sha256("global:<name>")[0..8]
 */
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(`global:${name}`).slice(0, 8));
}

/**
 * Encode a u64 as an 8-byte little-endian buffer.
 */
function u64ToLeBytes(value: bigint | number): Buffer {
  const buf = Buffer.alloc(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Read a little-endian u64 from a buffer slice.
 */
function u64FromLeBytes(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[offset + i]!);
  }
  return result;
}

/**
 * Encode a u32 as a 4-byte little-endian buffer.
 */
function u32ToLeBytes(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

/**
 * Read a little-endian u32 from a buffer slice.
 */
function u32FromLeBytes(buf: Uint8Array, offset: number): number {
  return (
    buf[offset]! |
    (buf[offset + 1]! << 8) |
    (buf[offset + 2]! << 16) |
    (buf[offset + 3]! << 24)
  );
}

/**
 * Read a little-endian i64 from a buffer slice as a JS number.
 */
function i64FromLeBytes(buf: Uint8Array, offset: number): number {
  return Number(u64FromLeBytes(buf, offset));
}

/**
 * Convert a bigint to a 32-byte little-endian buffer.
 */
function bigintToBytes32LE(value: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let v = value;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Read a 32-byte little-endian bigint from a buffer slice.
 */
function bigintFromBytes32LE(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 31; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[offset + i]!);
  }
  return result;
}

/**
 * Convert a PublicKey to a field element (first 31 bytes, big-endian).
 * Truncated to 31 bytes to stay within the BN254 scalar field.
 */
function pubkeyToFieldElement(pubkey: PublicKey): bigint {
  const bytes = pubkey.toBytes();
  let result = 0n;
  for (let i = 0; i < 31; i++) {
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}

/**
 * Generate a cryptographically random field element (248 bits, safe for BN254).
 */
function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  let result = 0n;
  for (let i = 0; i < 31; i++) {
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}

/**
 * Encode a Borsh-style string: 4-byte LE length prefix + UTF-8 bytes.
 */
function encodeString(str: string): Buffer {
  const bytes = Buffer.from(str, 'utf-8');
  return Buffer.concat([u32ToLeBytes(bytes.length), bytes]);
}

/**
 * Decode a Borsh-style string from a buffer at the given offset.
 * @returns The decoded string and the number of bytes consumed.
 */
function decodeString(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const len = u32FromLeBytes(buf, offset);
  const value = Buffer.from(buf.subarray(offset + 4, offset + 4 + len)).toString('utf-8');
  return { value, bytesRead: 4 + len };
}

/**
 * Compute ceil(log2(n)). Returns 0 for n <= 1.
 */
function ceilLog2(n: number): number {
  if (n <= 1) return 0;
  return Math.ceil(Math.log2(n));
}

/**
 * Compute the next power of 2 >= n.
 */
function nextPowerOf2(n: number): number {
  if (n <= 1) return 1;
  return 1 << ceilLog2(n);
}

// ─── AirdropModule ──────────────────────────────────────────────────────────

/**
 * Stealth Airdrops module for the Protocol-01 Privacy SDK.
 *
 * Enables private token distribution where the full recipient list stays
 * hidden. Uses a Merkle tree commitment pattern:
 *
 * 1. Creator generates stealth addresses for each recipient using their
 *    meta-addresses (optional — can also use raw PublicKeys).
 * 2. Builds a Poseidon Merkle tree of `leaf = Poseidon3(recipientField, amount, salt)`.
 * 3. Commits the Merkle root + total amount on-chain (creates AirdropCampaign PDA).
 * 4. Tokens are escrowed in the campaign PDA's token account.
 * 5. Recipients claim by providing their Merkle proof + matching leaf data.
 * 6. Claimed leaves are tracked via nullifier PDAs to prevent double-claims.
 *
 * The recipient list is NEVER stored on-chain — only the Merkle root.
 * The creator distributes {@link AirdropLeaf} data to recipients off-chain
 * (via encrypted channels, stealth announcements, etc.).
 *
 * Campaigns expire after a configurable deadline. After expiry, the creator
 * can close the campaign and reclaim any unclaimed tokens + rent.
 */
export class AirdropModule {
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
   * Create a new airdrop campaign.
   *
   * For each recipient, computes a Poseidon leaf commitment and builds a
   * Merkle tree. The root is committed on-chain along with the total amount.
   * Tokens are transferred from the creator's wallet to an escrow account
   * owned by the campaign PDA.
   *
   * If `useStealth` is true (default), recipients whose address is a
   * meta-address string (starting with "st") will have a stealth address
   * derived. If the address is already a PublicKey, it is used directly.
   *
   * @param config - Campaign configuration including recipients, token, and expiry.
   * @returns The transaction result, campaign PDA address, and full Merkle tree
   *   (the tree must be distributed to recipients off-chain for them to claim).
   *
   * @throws {PrivacyError} INVALID_CONFIG if recipients list is empty or too large.
   * @throws {PrivacyError} INVALID_CONFIG if name exceeds 32 characters.
   * @throws {PrivacyError} UNSUPPORTED_TOKEN if the token cannot be resolved.
   * @throws {PrivacyError} TRANSACTION_FAILED on send/confirm failure.
   */
  async createCampaign(config: AirdropCampaignConfig): Promise<AirdropCreateResult> {
    try {
      // ── Validate inputs ──────────────────────────────────────────────
      if (!config.recipients.length) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_CONFIG,
          'Airdrop must have at least one recipient.',
        );
      }

      const maxRecipients = 2 ** MAX_TREE_DEPTH;
      if (config.recipients.length > maxRecipients) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_CONFIG,
          `Airdrop exceeds maximum recipient count (${maxRecipients}).`,
        );
      }

      const name = config.name ?? '';
      if (Buffer.byteLength(name, 'utf-8') > MAX_NAME_LENGTH) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_CONFIG,
          `Campaign name exceeds ${MAX_NAME_LENGTH} bytes (UTF-8).`,
        );
      }

      const useStealth = config.useStealth ?? true;
      const tokenInfo = this.resolveToken(config.token);
      const creator = this.walletPublicKey();

      // ── Build leaves ─────────────────────────────────────────────────
      const leaves: AirdropLeaf[] = [];
      let totalAmount = 0n;

      for (let i = 0; i < config.recipients.length; i++) {
        const recipient = config.recipients[i]!;
        const recipientPubkey = this.resolveRecipientAddress(recipient.address, useStealth);
        const amount = BigInt(recipient.amount);

        if (amount <= 0n) {
          throw new PrivacyError(
            PrivacyErrorCode.INVALID_CONFIG,
            `Recipient ${i} has non-positive amount.`,
          );
        }

        const salt = randomSalt();
        const recipientField = pubkeyToFieldElement(recipientPubkey);
        const commitment = poseidon3([recipientField, amount, salt]);

        leaves.push({
          recipient: recipientPubkey,
          amount,
          salt,
          index: i,
          commitment,
        });

        totalAmount += amount;
      }

      // ── Build Merkle tree ────────────────────────────────────────────
      const commitments = leaves.map((l) => l.commitment);
      const { root, layers } = this.buildMerkleTree(commitments);
      const depth = ceilLog2(nextPowerOf2(leaves.length));

      // ── Derive PDAs ──────────────────────────────────────────────────
      const nonce = crypto.getRandomValues(new Uint8Array(8));
      const [campaignPDA] = this.deriveCampaignPDA(creator, nonce);
      const [escrowPDA] = this.deriveEscrowPDA(campaignPDA);

      // ── Compute expiry ───────────────────────────────────────────────
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresIn = config.expiresIn ?? DEFAULT_EXPIRY_SECONDS;
      const expiresAt = nowSec + expiresIn;

      // ── Build transaction ────────────────────────────────────────────
      const tx = new Transaction();

      // Set compute budget
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_AIRDROP_CU }),
      );

      // Instruction data:
      //   [0..8]    discriminator
      //   [8..40]   merkle_root (32 bytes LE)
      //   [40..48]  total_amount (u64 LE)
      //   [48..52]  total_recipients (u32 LE)
      //   [52..60]  expires_at (i64 LE)
      //   [60..68]  nonce (8 bytes)
      //   [68..72]  depth (u32 LE)
      //   [72..]    name (Borsh string: u32 len + UTF-8)
      const disc = instructionDiscriminator('create_airdrop');
      const data = Buffer.concat([
        disc,
        bigintToBytes32LE(root),
        u64ToLeBytes(totalAmount),
        u32ToLeBytes(leaves.length),
        u64ToLeBytes(BigInt(expiresAt)),
        Buffer.from(nonce),
        u32ToLeBytes(depth),
        encodeString(name),
      ]);

      // Creator's token account (source of tokens)
      const creatorTokenAccount = await getAssociatedTokenAddress(
        tokenInfo.mint,
        creator,
      );

      // Escrow token account (destination for escrowed tokens)
      const escrowTokenAccount = await getAssociatedTokenAddress(
        tokenInfo.mint,
        campaignPDA,
        true, // allowOwnerOffCurve — PDA is not on the ed25519 curve
      );

      // Create escrow ATA if needed
      tx.add(
        createAssociatedTokenAccountInstruction(
          creator,             // payer
          escrowTokenAccount,  // ata
          campaignPDA,         // owner (PDA)
          tokenInfo.mint,      // mint
        ),
      );

      // create_airdrop instruction
      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: creator, isSigner: true, isWritable: true },
            { pubkey: campaignPDA, isSigner: false, isWritable: true },
            { pubkey: escrowPDA, isSigner: false, isWritable: true },
            { pubkey: tokenInfo.mint, isSigner: false, isWritable: false },
            { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
            { pubkey: escrowTokenAccount, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkShielded,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);

      return {
        tx: txResult,
        campaignAddress: campaignPDA,
        merkleTree: {
          root,
          leaves,
          depth,
        },
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `Airdrop campaign creation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Claim an airdrop as a recipient.
   *
   * Verifies the Merkle proof locally (fast fail), then submits a claim
   * transaction. The on-chain program re-verifies the proof, creates a
   * nullifier PDA to prevent double-claims, and transfers the specified
   * amount from the escrow to the claimant.
   *
   * @param params - Claim parameters including the Merkle proof, leaf data, and campaign.
   * @returns The transaction result and claimed amount.
   *
   * @throws {PrivacyError} INVALID_MERKLE_PROOF if local proof verification fails.
   * @throws {PrivacyError} NULLIFIER_ALREADY_SPENT if the leaf has already been claimed.
   * @throws {PrivacyError} TRANSACTION_FAILED on send/confirm failure.
   */
  async claim(params: AirdropClaimParams): Promise<AirdropClaimResult> {
    try {
      const claimant = this.walletPublicKey();

      // ── Compute leaf and nullifier ───────────────────────────────────
      const claimantField = pubkeyToFieldElement(claimant);
      const leaf = poseidon3([claimantField, params.amount, params.salt]);
      const nullifier = poseidon2([leaf, BigInt(params.leafIndex)]);

      // ── Verify Merkle proof locally (fast fail) ──────────────────────
      const campaign = await this.getCampaign(params.campaign);
      if (!campaign) {
        throw new PrivacyError(
          PrivacyErrorCode.POOL_NOT_FOUND,
          `Airdrop campaign ${params.campaign.toBase58()} not found.`,
        );
      }

      if (!campaign.isActive) {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          'Airdrop campaign has expired or been closed.',
        );
      }

      const proofValid = this.verifyMerkleProof(
        campaign.merkleRoot,
        leaf,
        { elements: params.proofElements, indices: params.proofIndices },
      );
      if (!proofValid) {
        throw new PrivacyError(
          PrivacyErrorCode.INVALID_MERKLE_PROOF,
          'Merkle proof verification failed locally. Check your leaf data and proof.',
        );
      }

      // ── Check nullifier doesn't exist (not already claimed) ──────────
      const nullifierBytes = bigintToBytes32LE(nullifier);
      const [nullifierPDA] = this.deriveNullifierPDA(params.campaign, nullifierBytes);

      const nullifierAccount = await this.connection.getAccountInfo(nullifierPDA);
      if (nullifierAccount) {
        throw new PrivacyError(
          PrivacyErrorCode.NULLIFIER_ALREADY_SPENT,
          'This airdrop leaf has already been claimed.',
        );
      }

      // ── Derive accounts ──────────────────────────────────────────────
      const [escrowPDA] = this.deriveEscrowPDA(params.campaign);

      const escrowTokenAccount = await getAssociatedTokenAddress(
        campaign.tokenMint,
        params.campaign,
        true,
      );

      const claimantTokenAccount = await getAssociatedTokenAddress(
        campaign.tokenMint,
        claimant,
      );

      // ── Build transaction ────────────────────────────────────────────
      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CLAIM_AIRDROP_CU }),
      );

      // Ensure claimant has an ATA for the token
      // createAssociatedTokenAccountInstruction is idempotent if the account exists
      // but we check to avoid unnecessary instructions
      const claimantAtaInfo = await this.connection.getAccountInfo(claimantTokenAccount);
      if (!claimantAtaInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            claimant,
            claimantTokenAccount,
            claimant,
            campaign.tokenMint,
          ),
        );
      }

      // Instruction data:
      //   [0..8]    discriminator
      //   [8..12]   leaf_index (u32 LE)
      //   [12..20]  amount (u64 LE)
      //   [20..52]  salt (32 bytes LE)
      //   [52..84]  nullifier (32 bytes LE)
      //   [84..88]  proof_length (u32 LE)
      //   [88..]    proof elements (each 32 bytes LE) interleaved with indices (1 byte each)
      const disc = instructionDiscriminator('claim_airdrop');

      const proofLength = params.proofElements.length;
      const proofBuf = Buffer.alloc(proofLength * 33); // 32 bytes element + 1 byte index each
      for (let i = 0; i < proofLength; i++) {
        const elementBytes = bigintToBytes32LE(params.proofElements[i]!);
        elementBytes.copy(proofBuf, i * 33);
        proofBuf[i * 33 + 32] = params.proofIndices[i]!;
      }

      const data = Buffer.concat([
        disc,
        u32ToLeBytes(params.leafIndex),
        u64ToLeBytes(params.amount),
        bigintToBytes32LE(params.salt),
        nullifierBytes,
        u32ToLeBytes(proofLength),
        proofBuf,
      ]);

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: claimant, isSigner: true, isWritable: true },
            { pubkey: params.campaign, isSigner: false, isWritable: true },
            { pubkey: escrowPDA, isSigner: false, isWritable: true },
            { pubkey: nullifierPDA, isSigner: false, isWritable: true },
            { pubkey: escrowTokenAccount, isSigner: false, isWritable: true },
            { pubkey: claimantTokenAccount, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkShielded,
          data,
        }),
      );

      const txResult = await this.sendTx(tx);

      return {
        tx: txResult,
        amount: params.amount,
      };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `Airdrop claim failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch and parse an airdrop campaign's on-chain state.
   *
   * @param address - Public key of the campaign PDA.
   * @returns Parsed campaign data, or `null` if the account does not exist.
   */
  async getCampaign(address: PublicKey): Promise<AirdropCampaign | null> {
    const accountInfo = await this.connection.getAccountInfo(address);
    if (!accountInfo || !accountInfo.data) {
      return null;
    }
    return this.parseCampaignAccount(address, accountInfo.data);
  }

  /**
   * Check whether a specific airdrop leaf has already been claimed.
   *
   * Computes the leaf commitment and nullifier, then checks whether
   * the nullifier PDA exists on-chain.
   *
   * @param campaign - Campaign PDA address.
   * @param leafIndex - Index of the leaf in the Merkle tree.
   * @param recipient - Recipient public key.
   * @param amount - Leaf amount.
   * @param salt - Leaf salt.
   * @returns `true` if the leaf has been claimed, `false` otherwise.
   */
  async isClaimed(
    campaign: PublicKey,
    leafIndex: number,
    recipient: PublicKey,
    amount: bigint,
    salt: bigint,
  ): Promise<boolean> {
    const recipientField = pubkeyToFieldElement(recipient);
    const leaf = poseidon3([recipientField, amount, salt]);
    const nullifier = poseidon2([leaf, BigInt(leafIndex)]);
    const nullifierBytes = bigintToBytes32LE(nullifier);

    const [nullifierPDA] = this.deriveNullifierPDA(campaign, nullifierBytes);
    const info = await this.connection.getAccountInfo(nullifierPDA);
    return info !== null;
  }

  /**
   * Close an expired airdrop campaign and reclaim unclaimed tokens + rent.
   *
   * Only the original creator can close a campaign. The campaign must
   * have passed its expiry time. Any unclaimed tokens in the escrow
   * are returned to the creator, and all campaign PDAs are closed to
   * recover rent.
   *
   * @param campaign - Public key of the campaign PDA.
   * @returns Transaction result.
   *
   * @throws {PrivacyError} POOL_NOT_FOUND if the campaign does not exist.
   * @throws {PrivacyError} TRANSACTION_FAILED if the campaign is still active or the caller is not the creator.
   */
  async closeCampaign(campaign: PublicKey): Promise<TxResult> {
    try {
      const creator = this.walletPublicKey();
      const campaignData = await this.getCampaign(campaign);

      if (!campaignData) {
        throw new PrivacyError(
          PrivacyErrorCode.POOL_NOT_FOUND,
          `Airdrop campaign ${campaign.toBase58()} not found.`,
        );
      }

      if (!campaignData.creator.equals(creator)) {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          'Only the campaign creator can close the campaign.',
        );
      }

      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec < campaignData.expiresAt) {
        throw new PrivacyError(
          PrivacyErrorCode.TRANSACTION_FAILED,
          `Campaign has not expired yet. Expires at ${new Date(campaignData.expiresAt * 1000).toISOString()}.`,
        );
      }

      const [escrowPDA] = this.deriveEscrowPDA(campaign);

      const escrowTokenAccount = await getAssociatedTokenAddress(
        campaignData.tokenMint,
        campaign,
        true,
      );

      const creatorTokenAccount = await getAssociatedTokenAddress(
        campaignData.tokenMint,
        creator,
      );

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CLOSE_AIRDROP_CU }),
      );

      const disc = instructionDiscriminator('close_airdrop');

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: creator, isSigner: true, isWritable: true },
            { pubkey: campaign, isSigner: false, isWritable: true },
            { pubkey: escrowPDA, isSigner: false, isWritable: true },
            { pubkey: escrowTokenAccount, isSigner: false, isWritable: true },
            { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.zkShielded,
          data: disc,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.TRANSACTION_FAILED,
        `Close airdrop failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Fetch all airdrop campaigns created by a specific wallet.
   *
   * Uses `getProgramAccounts` with a memcmp filter on the creator field
   * to efficiently query matching campaigns.
   *
   * @param creator - Creator public key. Defaults to the connected wallet.
   * @returns Array of parsed campaign data, sorted by creation time (newest first).
   */
  async getCampaignsByCreator(creator?: PublicKey): Promise<AirdropCampaign[]> {
    const creatorKey = creator ?? this.walletPublicKey();

    // The creator field starts at offset 8 (after the Anchor discriminator)
    // and is 32 bytes (PublicKey).
    const accounts = await this.connection.getProgramAccounts(
      this.programIds.zkShielded,
      {
        filters: [
          // Anchor discriminator for AirdropCampaign account type
          {
            memcmp: {
              offset: 0,
              bytes: this.campaignDiscriminatorBase58(),
            },
          },
          // Creator pubkey at offset 8
          {
            memcmp: {
              offset: 8,
              bytes: creatorKey.toBase58(),
            },
          },
        ],
      },
    );

    const campaigns: AirdropCampaign[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        campaigns.push(this.parseCampaignAccount(pubkey, account.data));
      } catch {
        // Skip malformed accounts
      }
    }

    // Sort by creation time, newest first
    campaigns.sort((a, b) => b.createdAt - a.createdAt);
    return campaigns;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Merkle Tree Helpers (public — useful for recipients building proofs)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a Poseidon Merkle tree from an array of leaf commitments.
   *
   * Pads the leaf array to the next power of 2 with zero-valued leaves,
   * then hashes pairs bottom-up using Poseidon2 to produce a single root.
   *
   * @param leaves - Array of leaf commitments (bigint).
   * @returns The root hash and all intermediate layers (layers[0] = leaves, layers[last] = [root]).
   *
   * @example
   * ```ts
   * const { root, layers } = airdrop.buildMerkleTree([leaf0, leaf1, leaf2]);
   * // root is a single bigint
   * // layers[0] has 4 entries (padded to next power of 2)
   * // layers[1] has 2 entries
   * // layers[2] has 1 entry (the root)
   * ```
   */
  buildMerkleTree(leaves: bigint[]): { root: bigint; layers: bigint[][] } {
    if (leaves.length === 0) {
      return { root: 0n, layers: [[0n]] };
    }

    const depth = ceilLog2(nextPowerOf2(leaves.length));

    if (depth > MAX_TREE_DEPTH) {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_CONFIG,
        `Merkle tree depth ${depth} exceeds maximum of ${MAX_TREE_DEPTH}.`,
      );
    }

    // Pad to next power of 2 with zeros
    const paddedSize = nextPowerOf2(leaves.length);
    const paddedLeaves = [...leaves];
    while (paddedLeaves.length < paddedSize) {
      paddedLeaves.push(0n);
    }

    const layers: bigint[][] = [paddedLeaves];

    // Build bottom-up
    let currentLayer = paddedLeaves;
    while (currentLayer.length > 1) {
      const nextLayer: bigint[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i]!;
        const right = currentLayer[i + 1]!;
        nextLayer.push(poseidon2([left, right]));
      }
      layers.push(nextLayer);
      currentLayer = nextLayer;
    }

    return { root: currentLayer[0]!, layers };
  }

  /**
   * Generate a Merkle inclusion proof for a specific leaf index.
   *
   * Given the full tree (as returned by {@link buildMerkleTree}), extracts
   * the sibling elements and path direction bits needed to reconstruct
   * the root from the given leaf.
   *
   * @param tree - The full Merkle tree (layers).
   * @param leafIndex - Zero-based index of the leaf to prove.
   * @returns Proof elements (siblings) and indices (0 = left, 1 = right) from leaf to root.
   *
   * @example
   * ```ts
   * const tree = airdrop.buildMerkleTree(commitments);
   * const proof = airdrop.generateMerkleProof(tree, 2);
   * const valid = airdrop.verifyMerkleProof(tree.root, commitments[2], proof);
   * ```
   */
  generateMerkleProof(
    tree: { layers: bigint[][] },
    leafIndex: number,
  ): { elements: bigint[]; indices: number[] } {
    if (tree.layers.length === 0) {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_MERKLE_PROOF,
        'Cannot generate proof from an empty tree.',
      );
    }

    if (leafIndex < 0 || leafIndex >= tree.layers[0]!.length) {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_MERKLE_PROOF,
        `Leaf index ${leafIndex} out of range [0, ${tree.layers[0]!.length - 1}].`,
      );
    }

    const elements: bigint[] = [];
    const indices: number[] = [];
    let idx = leafIndex;

    // Walk from leaves (layer 0) to just below the root
    for (let layerIdx = 0; layerIdx < tree.layers.length - 1; layerIdx++) {
      const layer = tree.layers[layerIdx]!;

      // Sibling is the paired element
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      elements.push(layer[siblingIdx]!);
      // Index bit: 0 means current node is on the LEFT (sibling on right)
      //            1 means current node is on the RIGHT (sibling on left)
      indices.push(isRight ? 1 : 0);

      // Move up to parent index
      idx = Math.floor(idx / 2);
    }

    return { elements, indices };
  }

  /**
   * Verify a Merkle inclusion proof against a known root.
   *
   * Recomputes the root by hashing the leaf with each proof element
   * according to the path indices, then checks the result matches.
   *
   * @param root - The expected Merkle root.
   * @param leaf - The leaf commitment to verify.
   * @param proof - The sibling elements and path indices.
   * @returns `true` if the proof is valid, `false` otherwise.
   */
  verifyMerkleProof(
    root: bigint,
    leaf: bigint,
    proof: { elements: bigint[]; indices: number[] },
  ): boolean {
    if (proof.elements.length !== proof.indices.length) {
      return false;
    }

    let current = leaf;
    for (let i = 0; i < proof.elements.length; i++) {
      const sibling = proof.elements[i]!;
      const idx = proof.indices[i]!;

      if (idx === 0) {
        // Current is on the left
        current = poseidon2([current, sibling]);
      } else {
        // Current is on the right
        current = poseidon2([sibling, current]);
      }
    }

    return current === root;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PDA Derivation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Derive the campaign PDA from the creator and a random nonce.
   *
   * Seeds: ["airdrop", creator_pubkey, nonce_8_bytes]
   */
  private deriveCampaignPDA(creator: PublicKey, nonce: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(AIRDROP_SEED),
        creator.toBuffer(),
        Buffer.from(nonce),
      ],
      this.programIds.zkShielded,
    );
  }

  /**
   * Derive the nullifier PDA for a claimed leaf.
   *
   * Seeds: ["airdrop_nullifier", campaign_pubkey, nullifier_32_bytes]
   */
  private deriveNullifierPDA(campaign: PublicKey, nullifier: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(AIRDROP_NULLIFIER_SEED),
        campaign.toBuffer(),
        Buffer.from(nullifier),
      ],
      this.programIds.zkShielded,
    );
  }

  /**
   * Derive the escrow authority PDA for a campaign.
   *
   * Seeds: ["airdrop_escrow", campaign_pubkey]
   */
  private deriveEscrowPDA(campaign: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(AIRDROP_ESCROW_SEED),
        campaign.toBuffer(),
      ],
      this.programIds.zkShielded,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Account Parsing
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Parse raw campaign account data into an {@link AirdropCampaign} object.
   *
   * Account layout:
   * ```
   *   [0..8]      Anchor discriminator
   *   [8..40]     creator (Pubkey)
   *   [40..72]    token_mint (Pubkey)
   *   [72..104]   merkle_root (32 bytes LE → bigint)
   *   [104..112]  total_amount (u64 LE)
   *   [112..116]  claimed_count (u32 LE)
   *   [116..120]  total_recipients (u32 LE)
   *   [120..128]  created_at (i64 LE)
   *   [128..136]  expires_at (i64 LE)
   *   [136..137]  is_active (u8 bool)
   *   [137..]     name (Borsh string: u32 len + UTF-8)
   * ```
   */
  private parseCampaignAccount(address: PublicKey, data: Buffer | Uint8Array): AirdropCampaign {
    const creator = new PublicKey(data.subarray(8, 40));
    const tokenMint = new PublicKey(data.subarray(40, 72));
    const merkleRoot = bigintFromBytes32LE(data, 72);
    const totalAmount = u64FromLeBytes(data, 104);
    const claimedCount = u32FromLeBytes(data, 112);
    const totalRecipients = u32FromLeBytes(data, 116);
    const createdAt = i64FromLeBytes(data, 120);
    const expiresAt = i64FromLeBytes(data, 128);
    const isActive = data[136] === 1;
    const { value: name } = decodeString(data, 137);

    return {
      address,
      creator,
      tokenMint,
      merkleRoot,
      totalAmount,
      claimedCount,
      totalRecipients,
      createdAt,
      expiresAt,
      name,
      isActive,
    };
  }

  /**
   * Compute the Anchor account discriminator for AirdropCampaign.
   * Used in getProgramAccounts filters.
   */
  private campaignDiscriminatorBase58(): string {
    const hash = sha256('account:AirdropCampaign');
    const disc = hash.slice(0, 8);
    return new PublicKey(
      Buffer.concat([Buffer.from(disc), Buffer.alloc(24)]),
    ).toBase58();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a recipient address to a PublicKey.
   *
   * If the address is already a PublicKey, returns it directly.
   * If it is a string starting with "st" and `useStealth` is true,
   * hashes the meta-address bytes into a deterministic "claim" address
   * (using Poseidon) so the recipient can later prove ownership.
   * Otherwise, treats the string as a base58 public key.
   */
  private resolveRecipientAddress(address: string | PublicKey, useStealth: boolean): PublicKey {
    if (address instanceof PublicKey) {
      return address;
    }

    // If using stealth and address looks like a meta-address
    if (useStealth && typeof address === 'string' && address.startsWith('st')) {
      // Derive a deterministic claim public key from the meta-address.
      // The recipient can derive the same key using their viewing key
      // to scan and identify which leaf belongs to them.
      // For the Merkle tree, we hash the meta-address string into a
      // 32-byte Ed25519-compatible public key seed.
      const metaBytes = new TextEncoder().encode(address);
      const hash = sha256(metaBytes);
      // Use the first 32 bytes as a deterministic public key
      // NOTE: in production, the caller should derive an actual stealth
      // address via StealthModule.deriveStealthAddress() and pass the
      // resulting PublicKey here. The meta-address string form is a
      // convenience that produces a deterministic proxy key.
      return new PublicKey(hash);
    }

    // Plain base58 public key string
    try {
      return new PublicKey(address);
    } catch {
      throw new PrivacyError(
        PrivacyErrorCode.INVALID_CONFIG,
        `Invalid recipient address: "${address}". Expected a PublicKey or stealth meta-address.`,
      );
    }
  }

  /** Get the connected wallet's public key. */
  private walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Sign and send a transaction.
   *
   * Handles both Keypair (local signing) and WalletAdapter (external signing)
   * patterns, matching the dual-path convention used across all SDK modules.
   */
  private async sendTx(tx: Transaction, signers?: Keypair[]): Promise<TxResult> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;

    let signature: string;
    if ('secretKey' in this.wallet) {
      const allSigners = [this.wallet as Keypair, ...(signers || [])];
      signature = await sendAndConfirmTransaction(this.connection, tx, allSigners);
    } else {
      if (signers?.length) signers.forEach((s) => tx.partialSign(s));
      const signed = await this.wallet.signTransaction(tx);
      signature = await this.connection.sendRawTransaction(signed.serialize());
      await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });
    }

    return { signature };
  }
}
