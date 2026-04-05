import { PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ArciumClient, CIRCUITS, type EncryptedPayload } from '../client';

/**
 * UC7: Sealed-Bid Auction
 *
 * Encrypted bids → MPC determines winner → shielded pool escrow releases.
 * Individual bid amounts never disclosed. Only the winning nullifier is revealed.
 *
 * Full flow:
 * 1. Seller creates auction (deadline, pool, auction_id)
 * 2. Bidders shield notes into escrow (escrow_shield on zk_shielded)
 * 3. Bidders submit encrypted bids (sealed_bid_auction on p01_arcium)
 * 4. After deadline, authority finalizes (MPC reveals winner)
 * 5. Permissionless cranker writes outcomes + releases escrows
 */

export interface AuctionConfig {
  /** Unique auction identifier (32 bytes) */
  auctionId: Uint8Array;
  /** Denominated pool address (bids come from this pool) */
  pool: PublicKey;
  /** Bidding deadline (Unix timestamp) */
  deadline: number;
  /** Authority who can finalize (seller) */
  authority: PublicKey;
}

export interface BidReceipt {
  /** Computation offset (for tracking) */
  computationOffset: anchor.BN;
  /** Bidder's escrow nullifier (links to AuctionEscrow PDA) */
  escrowNullifier: Uint8Array;
  /** Encrypted bid (opaque after submission) */
  encryptedBid: number[];
  /** Transaction signature */
  signature: string;
}

export interface AuctionResult {
  /** Winner's nullifier (links to their AuctionEscrow) */
  winnerNullifier: Uint8Array;
  /** Winning bid amount (in denomination units) */
  winningBid: bigint;
  /** Total number of bids */
  totalBids: bigint;
  /** Finalization signature */
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
 */
export async function createAuction(
  client: ArciumClient,
  program: anchor.Program,
  config: AuctionConfig
): Promise<string> {
  const [auctionAddress] = getAuctionAddress(client.programId, config.auctionId);

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
}

/**
 * Submit an encrypted sealed bid to the MPC accumulator.
 *
 * The bid amount and nullifier are encrypted with the Arcium shared secret.
 * MPC compares against current highest bid without revealing individual amounts.
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

  const sig = await program.methods
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

  return {
    computationOffset,
    escrowNullifier,
    encryptedBid: payload.ciphertexts[0],
    signature: sig,
  };
}

/**
 * Finalize the auction — trigger MPC to reveal the winner.
 * Only callable by auction authority after deadline.
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
 * Write escrow outcome for a single escrow PDA.
 * Reads the finalized Auction account and determines win/lose.
 * Permissionless — anyone can crank.
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
 * Release an escrow — insert the correct commitment into the Merkle tree.
 * Permissionless — anyone can crank after outcome is written.
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
