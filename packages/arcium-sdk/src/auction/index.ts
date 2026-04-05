import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS, type EncryptedPayload } from '../client';

/**
 * UC7: Sealed-Bid Auction -- Encrypted Bid Matching
 *
 * Bidders submit encrypted bids; MPC determines the winner without
 * revealing individual bid amounts. The winning bidder's escrow nullifier
 * is revealed for escrow release; losing bids remain confidential.
 *
 * Full flow:
 * 1. Seller creates auction (deadline, pool, auction_id)
 * 2. Bidders shield notes into escrow (`escrow_shield` on `zk_shielded`)
 * 3. Bidders submit encrypted bids (`sealed_bid_auction` on `p01_arcium`)
 * 4. After deadline, authority finalizes (MPC reveals winner)
 * 5. Permissionless cranker writes outcomes and releases escrows
 *
 * **Inputs**: Encrypted bid amount + escrow nullifier.
 * **Output**: Winner's nullifier, winning bid amount, total bid count.
 *
 * @module auction
 */

/** Configuration for creating a new sealed-bid auction. */
export interface AuctionConfig {
  /** Unique auction identifier (32 bytes). */
  auctionId: Uint8Array;
  /** Denominated pool address that bids come from. */
  pool: PublicKey;
  /** Bidding deadline as a Unix timestamp (seconds). */
  deadline: number;
  /** Authority wallet (seller) that can finalize the auction. */
  authority: PublicKey;
}

/** Receipt returned after submitting a sealed bid. */
export interface BidReceipt {
  /** Computation offset for tracking this MPC job. */
  computationOffset: anchor.BN;
  /** Bidder's escrow nullifier (links bid to the `AuctionEscrow` PDA). */
  escrowNullifier: Uint8Array;
  /** First ciphertext block of the encrypted bid (opaque after submission). */
  encryptedBid: number[];
  /** Transaction signature of the bid submission. */
  signature: string;
}

/** Finalized auction result with the revealed winner. */
export interface AuctionResult {
  /** Winner's escrow nullifier (links to their `AuctionEscrow` PDA). */
  winnerNullifier: Uint8Array;
  /** Winning bid amount (in denomination units). */
  winningBid: bigint;
  /** Total number of bids submitted. */
  totalBids: bigint;
  /** Finalization callback transaction signature. */
  signature: string;
}

const AUCTION_SEED = 'p01_auction';
const ESCROW_SEED = 'auction_escrow';

/** Derive the Auction PDA on p01_arcium */
export function getAuctionAddress(
  programId: PublicKey,
  auctionId: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(AUCTION_SEED), Buffer.from(auctionId)],
    programId
  );
}

/** Derive the AuctionEscrow PDA on zk_shielded */
export function getEscrowAddress(
  programId: PublicKey,
  auctionId: Uint8Array,
  nullifier: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED), Buffer.from(auctionId), Buffer.from(nullifier)],
    programId
  );
}

/**
 * Split a 32-byte nullifier into 4 u64 chunks for MPC input.
 * Arcium MPC operates on u64 fields, so we split the nullifier.
 */
export function nullifierToChunks(nullifier: Uint8Array): bigint[] {
  const view = new DataView(nullifier.buffer, nullifier.byteOffset, 32);
  return [
    view.getBigUint64(0, true),
    view.getBigUint64(8, true),
    view.getBigUint64(16, true),
    view.getBigUint64(24, true),
  ];
}

/** Reconstruct a 32-byte nullifier from 4 u64 chunks */
export function chunksToNullifier(chunks: bigint[]): Uint8Array {
  const result = new Uint8Array(32);
  const view = new DataView(result.buffer);
  view.setBigUint64(0, chunks[0], true);
  view.setBigUint64(8, chunks[1], true);
  view.setBigUint64(16, chunks[2], true);
  view.setBigUint64(24, chunks[3], true);
  return result;
}

/**
 * Create a new sealed-bid auction.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param config - Auction configuration (ID, pool, deadline, authority).
 * @returns Transaction signature of the auction creation.
 * @throws {Error} "Auction MPC computation failed: ..." if creation fails.
 */
export async function createAuction(
  client: ArciumClient,
  program: anchor.Program,
  config: AuctionConfig
): Promise<string> {
  const [auctionAddress] = getAuctionAddress(client.programId, config.auctionId);

  try {
    const sig = await program.methods
      .createAuction(
        Array.from(config.auctionId),
        config.pool,
        new anchor.BN(config.deadline)
      )
      .accountsPartial({
        auction: auctionAddress,
        authority: config.authority,
        payer: client.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });

    return sig;
  } catch (err) {
    throw new Error(
      `Auction MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }
}

/**
 * Submit an encrypted sealed bid to the MPC accumulator.
 *
 * The bid amount and nullifier are encrypted with the Arcium shared secret.
 * MPC compares against the current highest bid without revealing individual amounts.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param auctionId - The auction to bid on (32 bytes).
 * @param bidAmount - Bid amount in denomination units.
 * @param escrowNullifier - 32-byte nullifier linking this bid to an escrow.
 * @returns Bid receipt with computation offset and encrypted bid.
 * @throws {Error} "Auction MPC computation failed: ..." if the bid fails.
 */
export async function submitSealedBid(
  client: ArciumClient,
  program: anchor.Program,
  auctionId: Uint8Array,
  bidAmount: bigint,
  escrowNullifier: Uint8Array
): Promise<BidReceipt> {
  // Split nullifier into u64 chunks for encryption
  const nullChunks = nullifierToChunks(escrowNullifier);

  // Encrypt: [bid_amount, null_0, null_1, null_2, null_3]
  const payload = client.encrypt([bidAmount, ...nullChunks]);
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(
    CIRCUITS.SEALED_BID_AUCTION,
    computationOffset
  );

  let sig: string;
  try {
    sig = await program.methods
      .sealedBidAuction(
        computationOffset,
        Array.from(payload.ciphertexts[0]),
        Array.from(payload.ciphertexts[1]),
        Array.from(payload.publicKey),
        client.nonceToU128(payload.nonce)
      )
      .accountsPartial({
        ...accounts,
      })
      .rpc({ commitment: 'confirmed' });
  } catch (err) {
    throw new Error(
      `Auction MPC computation failed: ${err instanceof Error ? err.message : String(err)}. ` +
      'This may indicate the Arcium cluster is unavailable or the circuit inputs are invalid.'
    );
  }

  return {
    computationOffset,
    escrowNullifier,
    encryptedBid: payload.ciphertexts[0],
    signature: sig,
  };
}

/**
 * Finalize the auction and reveal the winner.
 *
 * Only callable by the auction authority after the deadline.
 * MPC reveals the winning nullifier and bid amount.
 *
 * @param client - Initialized {@link ArciumClient}.
 * @param program - Anchor program instance for `p01_arcium`.
 * @param auctionId - The auction to finalize (32 bytes).
 * @returns Winner's nullifier, winning bid, total bids, and signature.
 * @throws {Error} "Auction MPC computation failed: ..." if finalization fails.
 */
export async function finalizeAuction(
  client: ArciumClient,
  program: anchor.Program,
  auctionId: Uint8Array
): Promise<AuctionResult> {
  const computationOffset = client.newComputationOffset();
  const accounts = client.getComputationAccounts(
    CIRCUITS.FINALIZE_AUCTION,
    computationOffset
  );
  const [auctionAddress] = getAuctionAddress(client.programId, auctionId);

  const sig = await program.methods
    .finalizeAuction(computationOffset)
    .accountsPartial({
      ...accounts,
    })
    .remainingAccounts([
      { pubkey: auctionAddress, isSigner: false, isWritable: true },
    ])
    .rpc({ commitment: 'confirmed' });

  // Wait for MPC callback
  const finalizeSig = await client.awaitFinalization(computationOffset);

  // Parse result from callback logs
  const tx = await client.connection.getTransaction(finalizeSig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  const logs = tx?.meta?.logMessages || [];
  const settleLine = logs.find((l) => l.includes('AuctionSettled:'));

  let winningBid = 0n;
  let totalBids = 0n;
  if (settleLine) {
    const match = settleLine.match(
      /winning_bid=(\d+), total_bids=(\d+)/
    );
    if (match) {
      winningBid = BigInt(match[1]);
      totalBids = BigInt(match[2]);
    }
  }

  // Read the auction account to get the winner nullifier
  const auctionData = await (program.account as any).auction.fetch(auctionAddress);
  const winnerNullifier = new Uint8Array(auctionData.winnerNullifier as number[]);

  return {
    winnerNullifier,
    winningBid,
    totalBids,
    signature: finalizeSig,
  };
}

/**
 * Write the escrow outcome for a single bidder.
 *
 * Reads the finalized Auction account and sets win/lose status on the
 * AuctionEscrow PDA. Permissionless -- anyone can crank this instruction.
 *
 * @param shieldedProgram - Anchor program instance for `zk_shielded`.
 * @param auctionId - The auction ID (32 bytes).
 * @param nullifier - The bidder's escrow nullifier.
 * @param auctionPda - The finalized Auction account PDA.
 * @param shieldedProgramId - The `zk_shielded` program ID.
 * @param payer - Transaction fee payer.
 * @returns Transaction signature.
 */
export async function writeEscrowOutcome(
  shieldedProgram: anchor.Program,
  auctionId: Uint8Array,
  nullifier: Uint8Array,
  auctionPda: PublicKey,
  shieldedProgramId: PublicKey,
  payer: PublicKey
): Promise<string> {
  const [escrowAddress] = getEscrowAddress(shieldedProgramId, auctionId, nullifier);

  const sig = await shieldedProgram.methods
    .writeEscrowOutcome()
    .accountsPartial({
      payer,
      auctionEscrow: escrowAddress,
      auctionAccount: auctionPda,
    })
    .rpc({ commitment: 'confirmed' });

  return sig;
}

/**
 * Release an escrow by inserting the correct commitment into the Merkle tree.
 *
 * Permissionless -- anyone can crank after the outcome is written by
 * {@link writeEscrowOutcome}. The winner's commitment is inserted into
 * the pool's Merkle tree; losers get their original commitment back.
 *
 * @param shieldedProgram - Anchor program instance for `zk_shielded`.
 * @param auctionId - The auction ID (32 bytes).
 * @param nullifier - The bidder's escrow nullifier.
 * @param poolAddress - The denominated pool account.
 * @param merkleTreeAddress - The pool's Merkle tree account.
 * @param shieldedProgramId - The `zk_shielded` program ID.
 * @param newRoot - New Merkle root after insertion (32 bytes).
 * @param payer - Transaction fee payer.
 * @returns Transaction signature.
 */
export async function releaseEscrow(
  shieldedProgram: anchor.Program,
  auctionId: Uint8Array,
  nullifier: Uint8Array,
  poolAddress: PublicKey,
  merkleTreeAddress: PublicKey,
  shieldedProgramId: PublicKey,
  newRoot: Uint8Array,
  payer: PublicKey
): Promise<string> {
  const [escrowAddress] = getEscrowAddress(shieldedProgramId, auctionId, nullifier);

  const sig = await shieldedProgram.methods
    .escrowRelease(Array.from(newRoot))
    .accountsPartial({
      payer,
      denominatedPool: poolAddress,
      merkleTree: merkleTreeAddress,
      auctionEscrow: escrowAddress,
    })
    .rpc({ commitment: 'confirmed' });

  return sig;
}
