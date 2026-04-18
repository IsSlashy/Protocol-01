import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import nacl from 'tweetnacl';
import type {
  Network,
  ProgramIds,
  Signer,
  TokenInfo,
  TxResult,
  MPCCreateProposalParams,
  MPCVoteParams,
  MPCAuditParams,
  MPCSealedBidParams,
  MPCProposalInfo,
  MPCAuctionInfo,
} from '../types';
import { PrivacyError, PrivacyErrorCode } from '../errors';
import { SEEDS, COMPUTE_UNITS } from '../constants';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Arcium MXE public key for encrypting MPC inputs (x25519) */
const MXE_ENCRYPTION_KEY = new Uint8Array(32); // Set at runtime from config

/** Polling interval when waiting for MPC callback (3 seconds) */
const MPC_POLL_INTERVAL_MS = 3_000;

/** Maximum wait time for MPC finalization (120 seconds) */
const MPC_FINALIZE_TIMEOUT_MS = 120_000;

// ── Utility Functions ──────────────────────────────────────────────────────────

/**
 * Anchor-style 8-byte instruction discriminator: sha256(utf8ToBytes("global:<name>"))[0..8]
 */
function instructionDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`)).slice(0, 8));
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
 * Encode a u32 as a 4-byte little-endian buffer.
 */
function u32ToLeBytes(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
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
 * Read a little-endian i64 as a JS number.
 */
function i64FromLeBytes(buf: Uint8Array, offset: number): number {
  return Number(u64FromLeBytes(buf, offset));
}

/**
 * Encode a Borsh string with a 4-byte length prefix.
 */
function encodeBorshString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/**
 * Encode a byte array with a 4-byte Borsh length prefix.
 */
function encodeBorshBytes(data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  return Buffer.concat([len, Buffer.from(data)]);
}

/**
 * Encrypt data for the Arcium MXE using x25519 + nacl.box.
 * Returns the full encrypted payload: [ephemeral_pubkey (32)] [nonce (24)] [ciphertext]
 */
function encryptForMXE(plaintext: Uint8Array, mxeKey: Uint8Array): Uint8Array {
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(plaintext, nonce, mxeKey, ephemeral.secretKey);

  if (!ciphertext) {
    throw new Error('MXE encryption failed: nacl.box returned null');
  }

  return Buffer.concat([
    Buffer.from(ephemeral.publicKey),
    Buffer.from(nonce),
    Buffer.from(ciphertext),
  ]);
}

/**
 * MPCModule wraps the p01_arcium program to provide multi-party
 * computation operations powered by the Arcium MPC network.
 *
 * All sensitive inputs (votes, balances, bids) are encrypted client-side
 * with the MXE's x25519 public key before being sent on-chain.
 * The Arcium cluster processes them in encrypted form and posts
 * only the aggregated result back on-chain.
 *
 * Supported operations:
 * - **Private voting**: Binary and multi-option voting with encrypted tallies
 * - **Balance audit**: Prove aggregate balance without revealing individual amounts
 * - **Sealed-bid auctions**: Encrypted bids with winner determination via MPC
 */
export class MPCModule {
  private readonly connection: Connection;
  private readonly wallet: Signer;
  private readonly network: Network;
  private readonly programIds: ProgramIds;
  private readonly resolveToken: (symbol: string) => TokenInfo;

  /** Cached MXE config PDA data (encryption key) */
  private mxeEncryptionKey: Uint8Array | null = null;

  constructor(
    connection: Connection,
    wallet: Signer,
    network: Network,
    programIds: ProgramIds,
    resolveToken: (symbol: string) => TokenInfo,
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.network = network;
    this.programIds = programIds;
    this.resolveToken = resolveToken;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Create a new private voting proposal.
   *
   * Initializes a proposal account with the specified number of options
   * and a deadline (Unix timestamp). Votes are encrypted and tallied
   * by the Arcium MPC network.
   *
   * @param params - Proposal ID, option count, and deadline.
   * @returns Transaction result.
   */
  async createProposal(params: MPCCreateProposalParams): Promise<TxResult> {
    try {
      const creator = this.walletPublicKey();
      const [proposalPDA] = this.deriveProposalPDA(params.proposalId);

      const disc = instructionDiscriminator('create_proposal');
      const data = Buffer.concat([
        disc,
        encodeBorshString(params.proposalId),
        u32ToLeBytes(params.optionCount),
        u64ToLeBytes(params.deadline),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.MPC_VOTE }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: creator, isSigner: true, isWritable: true },
            { pubkey: proposalPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.arcium,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.MPC_VOTE_FAILED,
        `Proposal creation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Cast an encrypted vote on a proposal.
   *
   * The vote choice is encrypted with the MXE public key so that
   * individual votes are never visible on-chain. Supports both
   * binary (yes/no) and multi-option voting.
   *
   * @param params - Proposal ID, choice index, and optional weight.
   * @returns Transaction result.
   */
  async vote(params: MPCVoteParams): Promise<TxResult> {
    try {
      const voter = this.walletPublicKey();
      const [proposalPDA] = this.deriveProposalPDA(params.proposalId);
      const [voterRecordPDA] = this.deriveVoterRecordPDA(
        params.proposalId,
        voter,
      );

      // Check for double voting
      const existingRecord = await this.connection.getAccountInfo(voterRecordPDA);
      if (existingRecord) {
        throw new PrivacyError(
          PrivacyErrorCode.MPC_ALREADY_VOTED,
          `Already voted on proposal "${params.proposalId}".`,
        );
      }

      // Encrypt the vote choice for the MXE
      const mxeKey = await this.getMXEEncryptionKey();
      const votePlaintext = Buffer.alloc(16);
      votePlaintext.writeUInt32LE(params.choice, 0);
      if (params.weight !== undefined) {
        const weightBuf = u64ToLeBytes(params.weight);
        weightBuf.copy(votePlaintext, 4);
      }

      const encryptedVote = encryptForMXE(votePlaintext, mxeKey);

      const disc = instructionDiscriminator('private_vote');
      const data = Buffer.concat([
        disc,
        encodeBorshString(params.proposalId),
        encodeBorshBytes(encryptedVote),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.MPC_VOTE }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: voter, isSigner: true, isWritable: true },
            { pubkey: proposalPDA, isSigner: false, isWritable: true },
            { pubkey: voterRecordPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.arcium,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.MPC_VOTE_FAILED,
        `Vote failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Finalize the tally of a voting proposal.
   *
   * Triggers the Arcium MPC network to decrypt and aggregate all
   * votes, then waits for the callback with the results. The results
   * are written on-chain and returned.
   *
   * @param proposalId - The proposal to finalize.
   * @returns The aggregated vote counts per option.
   */
  async finalizeTally(proposalId: string): Promise<{ results: number[] }> {
    try {
      const caller = this.walletPublicKey();
      const [proposalPDA] = this.deriveProposalPDA(proposalId);

      // Check proposal exists and is past deadline
      const proposalInfo = await this.getProposal(proposalPDA);
      if (proposalInfo.isFinalized) {
        return { results: proposalInfo.results ?? [] };
      }

      const now = Math.floor(Date.now() / 1000);
      if (now < proposalInfo.deadline) {
        throw new PrivacyError(
          PrivacyErrorCode.MPC_PROPOSAL_EXPIRED,
          `Proposal deadline is ${new Date(proposalInfo.deadline * 1000).toISOString()}; cannot finalize yet.`,
        );
      }

      const disc = instructionDiscriminator('finalize_tally');
      const data = Buffer.concat([disc, encodeBorshString(proposalId)]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.MPC_VOTE }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: caller, isSigner: true, isWritable: true },
            { pubkey: proposalPDA, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.arcium,
          data,
        }),
      );

      await this.sendTx(tx);

      // Wait for Arcium callback to update the proposal with results
      const finalResult = await this.awaitProposalFinalized(proposalPDA);
      return { results: finalResult.results ?? [] };
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.MPC_VOTE_FAILED,
        `Tally finalization failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Submit an encrypted balance for a privacy-preserving audit.
   *
   * The balance is encrypted so that the MPC network can compute
   * the aggregate without seeing individual balances.
   *
   * @param params - The encrypted balance data.
   * @returns Transaction result.
   */
  async submitAuditBalance(params: MPCAuditParams): Promise<TxResult> {
    try {
      const submitter = this.walletPublicKey();
      const [auditPDA] = this.deriveAuditPDA(submitter);

      const disc = instructionDiscriminator('balance_audit');
      const data = Buffer.concat([
        disc,
        encodeBorshBytes(params.encryptedBalance),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.MPC_VOTE }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: submitter, isSigner: true, isWritable: true },
            { pubkey: auditPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.arcium,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.MPC_AUDIT_FAILED,
        `Audit balance submission failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Finalize a balance audit and retrieve the aggregate total.
   *
   * Triggers the MPC network to compute the sum of all submitted
   * encrypted balances and return only the aggregate.
   *
   * @returns The total aggregate balance (individual amounts remain hidden).
   */
  async finalizeAudit(): Promise<{ totalBalance: bigint }> {
    try {
      const caller = this.walletPublicKey();
      const [auditConfigPDA] = this.deriveAuditConfigPDA();

      const disc = instructionDiscriminator('finalize_audit');
      const data = Buffer.from(disc);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.MPC_VOTE }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: caller, isSigner: true, isWritable: true },
            { pubkey: auditConfigPDA, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.arcium,
          data,
        }),
      );

      await this.sendTx(tx);

      // Poll for the finalized result
      const deadline = Date.now() + MPC_FINALIZE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const accountInfo = await this.connection.getAccountInfo(auditConfigPDA);
        if (accountInfo && accountInfo.data) {
          // Check if finalized flag is set (offset 8 after discriminator)
          if (accountInfo.data[8] === 1) {
            const totalBalance = u64FromLeBytes(accountInfo.data, 9);
            return { totalBalance };
          }
        }
        await new Promise((r) => setTimeout(r, MPC_POLL_INTERVAL_MS));
      }

      throw new PrivacyError(
        PrivacyErrorCode.TIMEOUT,
        'Audit finalization timed out waiting for MPC callback.',
      );
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.MPC_AUDIT_FAILED,
        `Audit finalization failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Submit an encrypted sealed bid to an auction.
   *
   * The bid amount is encrypted with the MXE key so that bids
   * remain confidential until the auction is finalized.
   *
   * @param params - Auction address and bid amount.
   * @returns Transaction result.
   */
  async submitSealedBid(params: MPCSealedBidParams): Promise<TxResult> {
    try {
      const bidder = this.walletPublicKey();
      const [bidPDA] = this.deriveBidPDA(params.auctionId, bidder);

      // Encrypt the bid amount for MXE
      const mxeKey = await this.getMXEEncryptionKey();
      const bidPlaintext = Buffer.alloc(8);
      const bidAmount = BigInt(params.bidAmount);
      for (let i = 0; i < 8; i++) {
        bidPlaintext[i] = Number((bidAmount >> BigInt(i * 8)) & 0xffn);
      }

      const encryptedBid = encryptForMXE(bidPlaintext, mxeKey);

      const disc = instructionDiscriminator('sealed_bid_auction');
      const data = Buffer.concat([
        disc,
        params.auctionId.toBuffer(),
        encodeBorshBytes(encryptedBid),
      ]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.MPC_VOTE }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: bidder, isSigner: true, isWritable: true },
            { pubkey: params.auctionId, isSigner: false, isWritable: true },
            { pubkey: bidPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          programId: this.programIds.arcium,
          data,
        }),
      );

      return await this.sendTx(tx);
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.MPC_AUCTION_FAILED,
        `Sealed bid submission failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Finalize an auction and determine the winner.
   *
   * Triggers the Arcium MPC network to compare all encrypted bids
   * and determine the highest bidder without revealing individual amounts.
   *
   * @param auctionId - The auction account to finalize.
   * @returns Auction result with winner commitment.
   */
  async finalizeAuction(auctionId: PublicKey): Promise<MPCAuctionInfo> {
    try {
      const caller = this.walletPublicKey();

      const disc = instructionDiscriminator('finalize_auction');
      const data = Buffer.concat([disc, auctionId.toBuffer()]);

      const tx = new Transaction();

      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS.MPC_VOTE }),
      );

      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey: caller, isSigner: true, isWritable: true },
            { pubkey: auctionId, isSigner: false, isWritable: true },
          ],
          programId: this.programIds.arcium,
          data,
        }),
      );

      await this.sendTx(tx);

      // Poll for finalization
      const deadline = Date.now() + MPC_FINALIZE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const info = await this.getAuction(auctionId);
        if (info.isFinalized) {
          return info;
        }
        await new Promise((r) => setTimeout(r, MPC_POLL_INTERVAL_MS));
      }

      throw new PrivacyError(
        PrivacyErrorCode.TIMEOUT,
        'Auction finalization timed out waiting for MPC callback.',
      );
    } catch (err) {
      if (err instanceof PrivacyError) throw err;
      throw new PrivacyError(
        PrivacyErrorCode.MPC_AUCTION_FAILED,
        `Auction finalization failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Check whether the Arcium MPC network is reachable and operational.
   *
   * Returns false gracefully if the network is unavailable, rather than
   * throwing an error. Useful for UI feature gating.
   *
   * @returns True if the MPC network is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const [mxeConfigPDA] = this.deriveMXEConfigPDA();
      const accountInfo = await this.connection.getAccountInfo(mxeConfigPDA);

      if (!accountInfo || !accountInfo.data) {
        return false;
      }

      // Check if the MXE config is active (byte at offset 8)
      return accountInfo.data[8] === 1;
    } catch {
      return false;
    }
  }

  // ── PDA Derivation ──────────────────────────────────────────────────────────

  private deriveProposalPDA(proposalId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('proposal'), Buffer.from(proposalId, 'utf-8')],
      this.programIds.arcium,
    );
  }

  private deriveVoterRecordPDA(
    proposalId: string,
    voter: PublicKey,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('voter_record'),
        Buffer.from(proposalId, 'utf-8'),
        voter.toBuffer(),
      ],
      this.programIds.arcium,
    );
  }

  private deriveAuditPDA(submitter: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('audit_entry'), submitter.toBuffer()],
      this.programIds.arcium,
    );
  }

  private deriveAuditConfigPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('audit_config')],
      this.programIds.arcium,
    );
  }

  private deriveBidPDA(
    auctionId: PublicKey,
    bidder: PublicKey,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('sealed_bid'), auctionId.toBuffer(), bidder.toBuffer()],
      this.programIds.arcium,
    );
  }

  private deriveMXEConfigPDA(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('mxe_config')],
      this.programIds.arcium,
    );
  }

  // ── Internal Helpers ────────────────────────────────────────────────────────

  /**
   * Fetch the MXE encryption key from the on-chain config.
   * Cached after first retrieval.
   */
  private async getMXEEncryptionKey(): Promise<Uint8Array> {
    if (this.mxeEncryptionKey) {
      return this.mxeEncryptionKey;
    }

    const [mxeConfigPDA] = this.deriveMXEConfigPDA();
    const accountInfo = await this.connection.getAccountInfo(mxeConfigPDA);

    if (!accountInfo || !accountInfo.data) {
      throw new PrivacyError(
        PrivacyErrorCode.MPC_NOT_AVAILABLE,
        'Arcium MPC network is not available. MXE config account not found.',
      );
    }

    // MXE config layout: [0..8] discriminator, [8] is_active, [9..41] encryption_key
    if (accountInfo.data[8] !== 1) {
      throw new PrivacyError(
        PrivacyErrorCode.MPC_NOT_AVAILABLE,
        'Arcium MPC network is currently inactive.',
      );
    }

    this.mxeEncryptionKey = new Uint8Array(accountInfo.data.subarray(9, 41));
    return this.mxeEncryptionKey;
  }

  /**
   * Fetch proposal info from the on-chain account.
   */
  private async getProposal(address: PublicKey): Promise<MPCProposalInfo> {
    const accountInfo = await this.connection.getAccountInfo(address);

    if (!accountInfo || !accountInfo.data) {
      throw new PrivacyError(
        PrivacyErrorCode.MPC_VOTE_FAILED,
        `Proposal account ${address.toBase58()} not found.`,
      );
    }

    return this.parseProposalAccount(address, accountInfo.data);
  }

  /**
   * Fetch auction info from the on-chain account.
   */
  private async getAuction(address: PublicKey): Promise<MPCAuctionInfo> {
    const accountInfo = await this.connection.getAccountInfo(address);

    if (!accountInfo || !accountInfo.data) {
      throw new PrivacyError(
        PrivacyErrorCode.MPC_AUCTION_FAILED,
        `Auction account ${address.toBase58()} not found.`,
      );
    }

    return this.parseAuctionAccount(address, accountInfo.data);
  }

  /**
   * Wait for a proposal to be finalized by the Arcium callback.
   */
  private async awaitProposalFinalized(
    proposalPDA: PublicKey,
  ): Promise<MPCProposalInfo> {
    const deadline = Date.now() + MPC_FINALIZE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const info = await this.getProposal(proposalPDA);
      if (info.isFinalized) {
        return info;
      }
      await new Promise((r) => setTimeout(r, MPC_POLL_INTERVAL_MS));
    }

    throw new PrivacyError(
      PrivacyErrorCode.TIMEOUT,
      'Tally finalization timed out waiting for MPC callback.',
    );
  }

  // ── Account Parsing ─────────────────────────────────────────────────────────

  /**
   * Parse raw proposal account data.
   *
   * Account layout:
   *   [0..8]     discriminator
   *   [8..40]    creator (Pubkey)
   *   [40..44]   option_count (u32)
   *   [44..52]   deadline (i64)
   *   [52]       is_finalized (bool)
   *   [53..57]   proposal_id_len (u32)
   *   [57..var]  proposal_id (string)
   *   [var..]    results (u32 array, option_count entries, if finalized)
   */
  private parseProposalAccount(
    address: PublicKey,
    data: Buffer | Uint8Array,
  ): MPCProposalInfo {
    const optionCount = u32FromLeBytes(data, 40);
    const deadline = i64FromLeBytes(data, 44);
    const isFinalized = data[52] === 1;

    // Read proposal ID (Borsh string)
    const idLen = u32FromLeBytes(data, 53);
    const proposalId = Buffer.from(data.subarray(57, 57 + idLen)).toString('utf-8');
    let offset = 57 + idLen;

    let results: number[] | undefined;
    if (isFinalized) {
      results = [];
      for (let i = 0; i < optionCount; i++) {
        results.push(u32FromLeBytes(data, offset));
        offset += 4;
      }
    }

    return {
      address,
      proposalId,
      optionCount,
      deadline,
      isFinalized,
      results,
    };
  }

  /**
   * Parse raw auction account data.
   *
   * Account layout:
   *   [0..8]    discriminator
   *   [8..40]   creator (Pubkey)
   *   [40]      is_finalized (bool)
   *   [41..73]  winner_commitment (32 bytes, if finalized)
   */
  private parseAuctionAccount(
    address: PublicKey,
    data: Buffer | Uint8Array,
  ): MPCAuctionInfo {
    const isFinalized = data[40] === 1;

    let winnerCommitment: bigint | undefined;
    if (isFinalized) {
      let result = 0n;
      for (let i = 72; i >= 41; i--) {
        result = (result << 8n) | BigInt(data[i]!);
      }
      winnerCommitment = result;
    }

    return {
      address,
      isFinalized,
      winnerCommitment,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private walletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  /**
   * Sign and send a transaction. Handles both Keypair and WalletAdapter signers.
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
