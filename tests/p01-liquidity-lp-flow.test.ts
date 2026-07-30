/**
 * p01_liquidity LP flow sanity test (devnet).
 *
 * Round-trips a small LP deposit + partial withdraw against the live pool,
 * asserting share math and reserve_lamports mirror stay coherent.
 *
 * SCOPE: does NOT exercise prefund/settle (requires a STARK proof, tested
 * separately via the mobile integration). This test catches share-math
 * regressions without spinning up a proof generation pipeline.
 *
 * Run (devnet):
 *   ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
 *   ANCHOR_WALLET=~/.config/solana/id.json
 *   npx ts-mocha -p tsconfig.test.json tests/p01-liquidity-lp-flow.test.ts --timeout 120000
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect } from 'chai';

const P01_LIQUIDITY_ID = new PublicKey('6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg');

function disc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function loadWallet(): Keypair {
  const p = process.env.ANCHOR_WALLET || path.join(os.homedir(), '.config/solana/id.json');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

interface PoolState {
  totalShares: bigint;
  reserveLamports: bigint;
  prefundFeeBps: number;
  settlerRewardBps: number;
  isActive: boolean;
}

function parsePool(data: Buffer): PoolState {
  const lo = data.readBigUInt64LE(40);
  const hi = data.readBigUInt64LE(48);
  return {
    totalShares: lo | (hi << 64n),
    reserveLamports: data.readBigUInt64LE(56),
    prefundFeeBps: data.readUInt16LE(64),
    settlerRewardBps: data.readUInt16LE(66),
    isActive: data[68] === 1,
  };
}

interface ShareState {
  owner: PublicKey;
  pool: PublicKey;
  shares: bigint;
}

function parseShare(data: Buffer): ShareState {
  const lo = data.readBigUInt64LE(72);
  const hi = data.readBigUInt64LE(80);
  return {
    owner: new PublicKey(data.subarray(8, 40)),
    pool:  new PublicKey(data.subarray(40, 72)),
    shares: lo | (hi << 64n),
  };
}

function buildDepositIx(depositor: PublicKey, amount: bigint): TransactionInstruction {
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_pool')], P01_LIQUIDITY_ID);
  const [share] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp_share'), depositor.toBuffer(), pool.toBuffer()],
    P01_LIQUIDITY_ID,
  );
  const data = Buffer.alloc(8 + 8);
  disc('deposit').copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return new TransactionInstruction({
    programId: P01_LIQUIDITY_ID,
    keys: [
      { pubkey: depositor, isSigner: true,  isWritable: true  },
      { pubkey: pool,      isSigner: false, isWritable: true  },
      { pubkey: share,     isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildWithdrawIx(depositor: PublicKey, shares: bigint): TransactionInstruction {
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from('liquidity_pool')], P01_LIQUIDITY_ID);
  const [share] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp_share'), depositor.toBuffer(), pool.toBuffer()],
    P01_LIQUIDITY_ID,
  );
  const data = Buffer.alloc(8 + 16);
  disc('withdraw').copy(data, 0);
  const lo = shares & 0xFFFFFFFFFFFFFFFFn;
  const hi = shares >> 64n;
  data.writeBigUInt64LE(lo, 8);
  data.writeBigUInt64LE(hi, 16);
  return new TransactionInstruction({
    programId: P01_LIQUIDITY_ID,
    keys: [
      { pubkey: depositor, isSigner: true,  isWritable: true  },
      { pubkey: pool,      isSigner: false, isWritable: true  },
      { pubkey: share,     isSigner: false, isWritable: true  },
      { pubkey: depositor, isSigner: false, isWritable: false }, // owner (has_one = owner)
    ],
    data,
  });
}

describe('p01_liquidity LP flow', function () {
  this.timeout(120_000);

  const connection = new Connection(
    process.env.ANCHOR_PROVIDER_URL || 'https://api.devnet.solana.com',
    'confirmed',
  );
  const depositor = loadWallet();
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_pool')], P01_LIQUIDITY_ID,
  );
  const [sharePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp_share'), depositor.publicKey.toBuffer(), poolPDA.toBuffer()],
    P01_LIQUIDITY_ID,
  );

  const DEPOSIT_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;

  let pre: PoolState;
  let preShares: bigint;
  let mintedShares: bigint;

  it('pool exists', async () => {
    const acc = await connection.getAccountInfo(poolPDA);
    expect(acc, 'pool not initialized').to.not.be.null;
    pre = parsePool(acc!.data);
    // Deliberately NOT asserting `isActive`. `is_active` gates `prefund` only —
    // deposit and withdraw ignore it — and `init_pool` now creates the pool with
    // `is_active = false` because `settle` cannot return a prefund's lamports
    // (its CPI target `zk_shielded::unshield_denominated_stark` is no longer
    // registered). LP flow must work on a prefund-disabled pool.
    console.log(`  prefunds ${pre.isActive ? 'ENABLED' : 'disabled'} on this pool`);
    const shareAcc = await connection.getAccountInfo(sharePDA);
    preShares = shareAcc ? parseShare(shareAcc.data).shares : 0n;
    console.log(`  pre-state: reserve=${pre.reserveLamports} shares=${pre.totalShares} ours=${preShares}`);
  });

  it('deposit mints pro-rata shares and grows reserve', async () => {
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildDepositIx(depositor.publicKey, BigInt(DEPOSIT_LAMPORTS))),
      [depositor],
    );
    console.log(`  deposit sig: ${sig}`);

    const acc = await connection.getAccountInfo(poolPDA);
    const post = parsePool(acc!.data);

    // Expected shares: deposit * pre.totalShares / pre.reserveLamports (or 1:1 bootstrap)
    const expectedShares = pre.totalShares === 0n || pre.reserveLamports === 0n
      ? BigInt(DEPOSIT_LAMPORTS)
      : (BigInt(DEPOSIT_LAMPORTS) * pre.totalShares) / pre.reserveLamports;

    expect(post.reserveLamports).to.equal(pre.reserveLamports + BigInt(DEPOSIT_LAMPORTS));
    expect(post.totalShares).to.equal(pre.totalShares + expectedShares);

    const shareAcc = await connection.getAccountInfo(sharePDA);
    expect(shareAcc, 'share PDA missing after deposit').to.not.be.null;
    const shareState = parseShare(shareAcc!.data);
    mintedShares = shareState.shares - preShares;
    expect(mintedShares).to.equal(expectedShares);
    console.log(`  minted: ${mintedShares} shares`);
  });

  it('partial withdraw burns shares and returns correct lamports', async () => {
    const burn = mintedShares / 2n;
    expect(burn).to.be.greaterThan(0n);

    const pre = parsePool((await connection.getAccountInfo(poolPDA))!.data);
    const preBalance = await connection.getBalance(depositor.publicKey);

    const expectedPayout = (burn * pre.reserveLamports) / pre.totalShares;

    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildWithdrawIx(depositor.publicKey, burn)),
      [depositor],
    );
    console.log(`  withdraw sig: ${sig}`);

    const post = parsePool((await connection.getAccountInfo(poolPDA))!.data);
    expect(post.totalShares).to.equal(pre.totalShares - burn);
    expect(post.reserveLamports).to.equal(pre.reserveLamports - expectedPayout);

    const postBalance = await connection.getBalance(depositor.publicKey);
    // Post-balance = pre - tx_fee + payout. Tx fee ≈ 5000 lamports, but signature count can vary.
    // Accept up to 50k lamports of fee drift.
    const netDelta = BigInt(postBalance - preBalance);
    expect(netDelta).to.be.greaterThan(expectedPayout - 50_000n);
    expect(netDelta).to.be.lessThanOrEqual(expectedPayout);
    console.log(`  payout: ${expectedPayout} lamports (balance delta ${netDelta})`);
  });
});
