import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import {
  RescueCipher,
  x25519,
  getMXEPublicKey,
  getArciumEnv,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  awaitComputationFinalization,
} from '@arcium-hq/client';
import { randomBytes } from 'crypto';
import { expect } from 'chai';
import type { P01Arcium } from '../target/types/p01_arcium';
import type { ZkShielded } from '../target/types/zk_shielded';

// Program IDs
const P01_ARCIUM_ID = new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT');
const ZK_SHIELDED_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');

const AUCTION_SEED = 'p01_auction';
const ESCROW_SEED = 'auction_escrow';

function getAuctionAddress(auctionId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(AUCTION_SEED), Buffer.from(auctionId)],
    P01_ARCIUM_ID
  );
}

function getEscrowAddress(auctionId: Uint8Array, nullifier: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_SEED), Buffer.from(auctionId), Buffer.from(nullifier)],
    ZK_SHIELDED_ID
  );
}

function nullifierToChunks(nullifier: Uint8Array): bigint[] {
  const view = new DataView(nullifier.buffer, nullifier.byteOffset, 32);
  return [
    view.getBigUint64(0, true),
    view.getBigUint64(8, true),
    view.getBigUint64(16, true),
    view.getBigUint64(24, true),
  ];
}

function chunksToNullifier(chunks: bigint[]): Uint8Array {
  const result = new Uint8Array(32);
  const view = new DataView(result.buffer);
  view.setBigUint64(0, chunks[0], true);
  view.setBigUint64(8, chunks[1], true);
  view.setBigUint64(16, chunks[2], true);
  view.setBigUint64(24, chunks[3], true);
  return result;
}

describe('Sealed-Bid Auction — Full Integration', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  let arciumProgram: Program<P01Arcium>;
  let shieldedProgram: Program<ZkShielded>;
  let ephemeralPrivKey: Uint8Array;
  let ephemeralPubKey: Uint8Array;
  let sharedSecret: Uint8Array;
  let cipher: RescueCipher;

  // Test auction
  const auctionId = randomBytes(32);
  const deadline = Math.floor(Date.now() / 1000) + 60; // 1 minute from now

  before(async () => {
    arciumProgram = await anchor.workspace.P01Arcium;
    shieldedProgram = await anchor.workspace.ZkShielded;

    // Setup x25519 key exchange with MXE
    ephemeralPrivKey = x25519.utils.randomSecretKey();
    ephemeralPubKey = x25519.getPublicKey(ephemeralPrivKey);
    const mxePubKey = await getMXEPublicKey(provider, P01_ARCIUM_ID);
    if (!mxePubKey) throw new Error('MXE public key not found');
    sharedSecret = x25519.getSharedSecret(ephemeralPrivKey, mxePubKey);
    cipher = new RescueCipher(sharedSecret);
  });

  function encrypt(values: bigint[]) {
    const nonce = randomBytes(16);
    const ciphertexts = cipher.encrypt(values, nonce);
    return { ciphertexts, nonce, pubKey: ephemeralPubKey };
  }

  function getArciumAccounts(circuitName: string, computationOffset: anchor.BN) {
    const env = getArciumEnv();
    return {
      computationAccount: getComputationAccAddress(env.arciumClusterOffset, computationOffset),
      clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
      mxeAccount: getMXEAccAddress(P01_ARCIUM_ID),
      mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(P01_ARCIUM_ID, Buffer.from(getCompDefAccOffset(circuitName)).readUInt32LE(0)),
    };
  }

  // =========================================================================
  // Test 1: Create Auction
  // =========================================================================

  it('creates a sealed-bid auction', async () => {
    const [auctionAddress] = getAuctionAddress(auctionId);

    // Use a mock pool address for testing
    const mockPool = Keypair.generate().publicKey;

    const sig = await arciumProgram.methods
      .createAuction(
        Array.from(auctionId),
        mockPool,
        new anchor.BN(deadline)
      )
      .accountsPartial({
        auction: auctionAddress,
        authority: provider.wallet.publicKey,
        payer: provider.wallet.publicKey,
      })
      .rpc({ commitment: 'confirmed' });

    console.log('  createAuction sig:', sig);

    // Verify auction PDA
    const auction = await arciumProgram.account.auction.fetch(auctionAddress);
    expect(auction.finalized).to.be.false;
    expect(auction.totalBids.toNumber()).to.equal(0);
    expect(auction.deadline.toNumber()).to.equal(deadline);
    console.log('  ✓ Auction PDA created, finalized=false, totalBids=0');
  });

  // =========================================================================
  // Test 2: Submit Sealed Bids (3 bidders)
  // =========================================================================

  const bidder1Nullifier = randomBytes(32);
  const bidder2Nullifier = randomBytes(32);
  const bidder3Nullifier = randomBytes(32);

  it('submits 3 encrypted sealed bids', async () => {
    const bids = [
      { nullifier: bidder1Nullifier, amount: 100n },
      { nullifier: bidder2Nullifier, amount: 250n }, // Winner
      { nullifier: bidder3Nullifier, amount: 150n },
    ];

    for (const bid of bids) {
      const chunks = nullifierToChunks(bid.nullifier);
      const payload = encrypt([bid.amount, ...chunks]);
      const computationOffset = new anchor.BN(Date.now());
      const accounts = getArciumAccounts('sealed_bid_auction', computationOffset);

      const sig = await arciumProgram.methods
        .sealedBidAuction(
          computationOffset,
          Array.from(payload.ciphertexts[0]),
          Array.from(payload.ciphertexts[1]),
          Array.from(payload.pubKey),
          new anchor.BN(Buffer.from(payload.nonce).toString('hex'), 16)
        )
        .accountsPartial({
          ...accounts,
          payer: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      console.log(`  Bid ${bid.amount} submitted: ${sig.slice(0, 20)}...`);
    }

    console.log('  ✓ 3 encrypted bids submitted to MPC accumulator');
  });

  // =========================================================================
  // Test 3: AuctionEscrow PDA structure
  // =========================================================================

  it('verifies AuctionEscrow PDA derivation', () => {
    const [escrow1] = getEscrowAddress(auctionId, bidder1Nullifier);
    const [escrow2] = getEscrowAddress(auctionId, bidder2Nullifier);
    const [escrow3] = getEscrowAddress(auctionId, bidder3Nullifier);

    // All escrows should be unique
    expect(escrow1.toBase58()).to.not.equal(escrow2.toBase58());
    expect(escrow2.toBase58()).to.not.equal(escrow3.toBase58());

    console.log('  Escrow PDAs:');
    console.log('    Bidder 1:', escrow1.toBase58());
    console.log('    Bidder 2:', escrow2.toBase58());
    console.log('    Bidder 3:', escrow3.toBase58());
    console.log('  ✓ All escrow PDAs are unique');
  });

  // =========================================================================
  // Test 4: Nullifier chunk encoding roundtrip
  // =========================================================================

  it('roundtrips nullifier ↔ u64 chunks', () => {
    const original = randomBytes(32);
    const chunks = nullifierToChunks(original);
    const reconstructed = chunksToNullifier(chunks);

    expect(Buffer.from(reconstructed)).to.deep.equal(Buffer.from(original));
    console.log('  ✓ Nullifier encoding roundtrip OK');
  });

  // =========================================================================
  // Test 5: Cannot create duplicate auction
  // =========================================================================

  it('rejects duplicate auction creation', async () => {
    const [auctionAddress] = getAuctionAddress(auctionId);
    const mockPool = Keypair.generate().publicKey;

    try {
      await arciumProgram.methods
        .createAuction(
          Array.from(auctionId),
          mockPool,
          new anchor.BN(deadline)
        )
        .accountsPartial({
          auction: auctionAddress,
          authority: provider.wallet.publicKey,
          payer: provider.wallet.publicKey,
        })
        .rpc({ commitment: 'confirmed' });

      expect.fail('Should have thrown');
    } catch (e: any) {
      // PDA already initialized
      expect(e.toString()).to.include('already in use');
      console.log('  ✓ Duplicate auction creation rejected');
    }
  });

  // =========================================================================
  // Test 6: Auction account data layout
  // =========================================================================

  it('verifies Auction account has correct layout', async () => {
    const [auctionAddress] = getAuctionAddress(auctionId);
    const info = await provider.connection.getAccountInfo(auctionAddress);

    expect(info).to.not.be.null;
    expect(info!.owner.toBase58()).to.equal(P01_ARCIUM_ID.toBase58());

    // Layout: 8 (disc) + 32 (authority) + 32 (auction_id) + 32 (pool) + 8 (deadline)
    //       + 1 (finalized) + 32 (winner_nullifier) + 8 (winning_bid) + 8 (total_bids) + 1 (bump)
    // Total: 162
    expect(info!.data.length).to.equal(162);

    // Parse finalized flag (byte 112)
    expect(info!.data[112]).to.equal(0); // Not finalized yet

    console.log('  ✓ Auction account layout verified (162 bytes)');
  });

  // =========================================================================
  // NOTE: Full end-to-end test (finalize → write outcome → release)
  // requires MPC cluster execution which is only available on devnet
  // with active Arcium ARX nodes. The tests above verify the on-chain
  // logic, PDA derivation, and data encoding independently.
  // =========================================================================
});
