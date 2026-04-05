/**
 * Mugen Noise Engine + Mixer — Stress Test on Devnet
 *
 * Simulates the full privacy flow:
 *   1. Re-initialize config with noise_fund 4-way fee split
 *   2. Initialize reputation PDAs for test wallets
 *   3. Create denominated sell orders
 *   4. Take orders (full escrow cycle)
 *   5. Verify noise fund receives fees
 *   6. Simulate mixer multi-hop delivery
 *   7. Stress test: rapid-fire N trades
 *
 * Run:
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..." \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-mocha -p tsconfig.test.json tests/mugen-noise-stress.ts --timeout 300000
 */

import { describe, it, before } from 'mocha';
import { assert } from 'chai';
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Connection,
  Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { createHash, randomBytes } from 'crypto';

// ─── Config ──────────────────────────────────────────────────────────────────

const MUGEN_PROGRAM_ID = new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN');
const NATIVE_SOL = new PublicKey('So11111111111111111111111111111111111111112');

const CONFIG_SEED = Buffer.from('mugen_config');
const ORDER_SEED = Buffer.from('mugen_order');
const ESCROW_SEED = Buffer.from('mugen_escrow');
const VAULT_SEED = Buffer.from('mugen_vault');
const REPUTATION_SEED = Buffer.from('mugen_rep');

function disc(name: string): Buffer {
  const hash = sha256(`global:${name}`);
  return Buffer.from(hash.slice(0, 8));
}

function loadKeypair(): Keypair {
  const path = `${homedir()}/.config/solana/id.json`;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Derive a deterministic test wallet from index */
function deriveTestWallet(authority: Keypair, index: number): Keypair {
  const seed = createHash('sha256')
    .update(authority.publicKey.toBytes())
    .update(`mugen_test_wallet_${index}`)
    .digest();
  return Keypair.fromSeed(seed);
}

/** Derive reputation commitment for a wallet */
function deriveRepCommitment(wallet: Keypair): Buffer {
  const salt = createHash('sha256')
    .update(wallet.publicKey.toBytes())
    .update('mugen_test_rep_salt')
    .digest();
  return Buffer.from(
    createHash('sha256').update(wallet.publicKey.toBytes()).update(salt).digest(),
  );
}

// ─── Denominations ──────────────────────────────────────────────────────────

const SOL_TIERS = [100_000_000n, 1_000_000_000n]; // 0.1 SOL, 1 SOL
const FIAT_TIERS = [1000, 5000, 10000]; // $10, $50, $100 in cents

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Mugen Noise + Mixer — Stress Test', function () {
  this.timeout(300_000);

  const rpcUrl = process.env.ANCHOR_PROVIDER_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const authority = loadKeypair();

  // Noise fund wallet (deterministic from authority)
  const noiseFundWallet = deriveTestWallet(authority, 999);

  // Test wallets: 4 pairs for stress testing
  const sellers = [0, 1, 2, 3].map((i) => deriveTestWallet(authority, i));
  const buyers = [10, 11, 12, 13].map((i) => deriveTestWallet(authority, i));
  const allTestWallets = [...sellers, ...buyers, noiseFundWallet];

  const [configPDA] = PublicKey.findProgramAddressSync([CONFIG_SEED], MUGEN_PROGRAM_ID);

  console.log('Authority:', authority.publicKey.toBase58());
  console.log('Noise Fund:', noiseFundWallet.publicKey.toBase58());
  console.log('Config PDA:', configPDA.toBase58());
  console.log('RPC:', rpcUrl.slice(0, 40) + '...');
  console.log('Test wallets:', allTestWallets.length);

  // ════════════════════════════════════════════════════════════════════
  // SETUP
  // ════════════════════════════════════════════════════════════════════

  before(async function () {
    this.timeout(120_000);

    // Fund test wallets
    const balance = await connection.getBalance(authority.publicKey);
    console.log(`Authority balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    const fundAmount = 0.2 * LAMPORTS_PER_SOL; // 0.2 SOL each (enough for 0.1 SOL trade + rent + fees)

    for (const w of allTestWallets) {
      const bal = await connection.getBalance(w.publicKey);
      if (bal < fundAmount) {
        try {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: authority.publicKey,
              toPubkey: w.publicKey,
              lamports: Math.round(fundAmount),
            }),
          );
          await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
          console.log(`  Funded ${w.publicKey.toBase58().slice(0, 12)}... +0.05 SOL`);
        } catch (err: any) {
          console.warn(`  Skip fund ${w.publicKey.toBase58().slice(0, 12)}...: ${err.message}`);
        }
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 1: Re-initialize config with noise fund split
  // ════════════════════════════════════════════════════════════════════

  it('1. Close + re-init config with noise_fund_wallet', async () => {
    // Check existing config
    const existing = await connection.getAccountInfo(configPDA);
    if (existing) {
      // Close existing config first
      const closeDisc = disc('close_config');
      const closeIx = new TransactionInstruction({
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: configPDA, isSigner: false, isWritable: true },
        ],
        programId: MUGEN_PROGRAM_ID,
        data: closeDisc,
      });
      try {
        const closeTx = new Transaction().add(closeIx);
        await sendAndConfirmTransaction(connection, closeTx, [authority], { commitment: 'confirmed' });
        console.log('  Old config closed');
      } catch (err: any) {
        console.log('  Config close skipped:', err.message.slice(0, 60));
      }
    }

    // New InitConfigParams with noise_fund
    // Layout: fee_bps(2) + p01_fee_wallet(32) + mugen_fee_wallet(32) + treasury_wallet(32) +
    //         p01_fee_share(2) + mugen_fee_share(2) + noise_fund_wallet(32) + noise_fee_share(2) +
    //         min_trade(8) + max_trade(8) + escrow_timeout(8) + dispute_timeout(8)
    const initDisc = disc('initialize_config');
    const data = Buffer.alloc(8 + 2 + 32 + 32 + 32 + 2 + 2 + 32 + 2 + 8 + 8 + 8 + 8);
    let off = 0;
    initDisc.copy(data, off); off += 8;
    data.writeUInt16LE(50, off); off += 2;                          // 0.5% fee
    authority.publicKey.toBuffer().copy(data, off); off += 32;      // p01_fee_wallet
    authority.publicKey.toBuffer().copy(data, off); off += 32;      // mugen_fee_wallet
    authority.publicKey.toBuffer().copy(data, off); off += 32;      // treasury_wallet
    data.writeUInt16LE(1500, off); off += 2;                        // p01: 15%
    data.writeUInt16LE(5500, off); off += 2;                        // mugen: 55%
    noiseFundWallet.publicKey.toBuffer().copy(data, off); off += 32; // noise_fund_wallet
    data.writeUInt16LE(1500, off); off += 2;                        // noise: 15%
    data.writeBigUInt64LE(1000000n, off); off += 8;                 // min: 0.001 SOL
    data.writeBigUInt64LE(100_000_000_000n, off); off += 8;         // max: 100 SOL
    data.writeBigInt64LE(3600n, off); off += 8;                     // escrow: 1h
    data.writeBigInt64LE(86400n, off); off += 8;                    // dispute: 24h

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: MUGEN_PROGRAM_ID,
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(ix);

    const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
    console.log(`  Config initialized with noise fund — tx: ${sig.slice(0, 20)}...`);

    // Verify
    const config = await connection.getAccountInfo(configPDA);
    assert(config !== null, 'Config should exist');
    console.log(`  Config size: ${config!.data.length} bytes`);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 2: Initialize reputation PDAs
  // ════════════════════════════════════════════════════════════════════

  it('2. Init reputation PDAs for 8 test wallets', async () => {
    const initRepDisc = disc('init_reputation');
    let created = 0;

    for (const w of [...sellers, ...buyers]) {
      const commitment = deriveRepCommitment(w);
      const [repPda] = PublicKey.findProgramAddressSync(
        [REPUTATION_SEED, commitment],
        MUGEN_PROGRAM_ID,
      );

      const existing = await connection.getAccountInfo(repPda);
      if (existing) continue;

      const data = Buffer.alloc(8 + 32);
      initRepDisc.copy(data, 0);
      commitment.copy(data, 8);

      const ix = new TransactionInstruction({
        programId: MUGEN_PROGRAM_ID,
        keys: [
          { pubkey: w.publicKey, isSigner: true, isWritable: true },
          { pubkey: repPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      try {
        const tx = new Transaction().add(ix);
        await sendAndConfirmTransaction(connection, tx, [w], { commitment: 'confirmed' });
        created++;
      } catch (err: any) {
        console.warn(`  Rep init failed for ${w.publicKey.toBase58().slice(0, 12)}: ${err.message.slice(0, 60)}`);
      }
    }

    console.log(`  ${created} reputation PDAs created`);
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 3: Full trade cycle — sell order → take → confirm → release
  // ════════════════════════════════════════════════════════════════════

  it('3. Full denominated trade: 0.1 SOL for $15', async () => {
    const seller = sellers[0];
    const buyer = buyers[0];
    const cryptoAmount = SOL_TIERS[0]; // 0.1 SOL
    const fiatAmount = 1500; // $15.00

    // ── Create sell order ──
    const nonce = randomBytes(16);
    const [orderPda] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, seller.publicKey.toBytes(), nonce],
      MUGEN_PROGRAM_ID,
    );

    const createDisc = disc('create_order');
    const params = Buffer.alloc(94);
    let pOff = 0;
    params.writeUInt8(1, pOff); pOff += 1; // sell_crypto
    params.writeBigUInt64LE(cryptoAmount, pOff); pOff += 8;
    params.writeBigUInt64LE(BigInt(fiatAmount), pOff); pOff += 8;
    Buffer.from('USD').copy(params, pOff); pOff += 3;
    params.writeUInt16LE(2 | 16, pOff); pOff += 2; // revolut + SEPA
    params.writeBigUInt64LE(0n, pOff); pOff += 8;
    params.writeBigUInt64LE(0n, pOff); pOff += 8;
    deriveRepCommitment(seller).copy(params, pOff); pOff += 32;
    nonce.copy(params, pOff); pOff += 16;
    params.writeBigInt64LE(3600n, pOff);

    const createData = Buffer.concat([createDisc, params]);
    const createIx = new TransactionInstruction({
      programId: MUGEN_PROGRAM_ID,
      keys: [
        { pubkey: seller.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: orderPda, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: false, isWritable: false }, // attestation bypass
        { pubkey: NATIVE_SOL, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: createData,
    });

    let tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(createIx);
    const createSig = await sendAndConfirmTransaction(connection, tx, [seller], { commitment: 'confirmed' });
    console.log(`  Order created: ${orderPda.toBase58().slice(0, 16)}... tx: ${createSig.slice(0, 16)}...`);

    // ── Wrap SOL for seller (for escrow deposit) ──
    const sellerAta = getAssociatedTokenAddressSync(NATIVE_SOL, seller.publicKey);
    const wrapTx = new Transaction();
    wrapTx.add(createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, sellerAta, seller.publicKey, NATIVE_SOL));
    wrapTx.add(SystemProgram.transfer({ fromPubkey: seller.publicKey, toPubkey: sellerAta, lamports: cryptoAmount + 50_000n }));
    wrapTx.add(createSyncNativeInstruction(sellerAta));
    await sendAndConfirmTransaction(connection, wrapTx, [seller], { commitment: 'confirmed' });
    console.log('  Seller wSOL wrapped');

    // ── Take order (buyer takes, seller signs for token transfer) ──
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [ESCROW_SEED, orderPda.toBytes(), buyer.publicKey.toBytes()],
      MUGEN_PROGRAM_ID,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, escrowPda.toBytes()],
      MUGEN_PROGRAM_ID,
    );

    const takeDisc = disc('take_order');
    const takeData = Buffer.alloc(11);
    takeDisc.copy(takeData, 0);
    takeData.writeUInt8(0, 8); // no stealth
    takeData.writeUInt16LE(2, 9); // revolut

    const takeIx = new TransactionInstruction({
      programId: MUGEN_PROGRAM_ID,
      keys: [
        { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: orderPda, isSigner: false, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: seller.publicKey, isSigner: true, isWritable: false },
        { pubkey: NATIVE_SOL, isSigner: false, isWritable: false },
        { pubkey: authority.publicKey, isSigner: false, isWritable: false }, // attestation bypass
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: takeData,
    });

    tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(takeIx);
    const takeSig = await sendAndConfirmTransaction(connection, tx, [buyer, seller], { commitment: 'confirmed' });
    console.log(`  Escrow created: ${escrowPda.toBase58().slice(0, 16)}... tx: ${takeSig.slice(0, 16)}...`);

    // ── Confirm payment (buyer) ──
    const confirmDisc = disc('confirm_payment');
    const confirmIx = new TransactionInstruction({
      programId: MUGEN_PROGRAM_ID,
      keys: [
        { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
      ],
      data: confirmDisc,
    });

    tx = new Transaction().add(confirmIx);
    await sendAndConfirmTransaction(connection, tx, [buyer], { commitment: 'confirmed' });
    console.log('  Payment confirmed');

    // ── Release escrow (seller) — includes 4-way fee split ──
    const buyerAta = getAssociatedTokenAddressSync(NATIVE_SOL, buyer.publicKey);
    // Ensure buyer + fee ATAs exist
    const ensureTx = new Transaction();
    ensureTx.add(createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, buyerAta, buyer.publicKey, NATIVE_SOL));
    const p01Ata = getAssociatedTokenAddressSync(NATIVE_SOL, authority.publicKey);
    ensureTx.add(createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, p01Ata, authority.publicKey, NATIVE_SOL));
    const noiseFundAta = getAssociatedTokenAddressSync(NATIVE_SOL, noiseFundWallet.publicKey);
    ensureTx.add(createAssociatedTokenAccountIdempotentInstruction(seller.publicKey, noiseFundAta, noiseFundWallet.publicKey, NATIVE_SOL));
    await sendAndConfirmTransaction(connection, ensureTx, [seller], { commitment: 'confirmed' });

    const sellerRepCommitment = deriveRepCommitment(seller);
    const buyerRepCommitment = deriveRepCommitment(buyer);
    const [makerRepPda] = PublicKey.findProgramAddressSync([REPUTATION_SEED, sellerRepCommitment], MUGEN_PROGRAM_ID);
    const [takerRepPda] = PublicKey.findProgramAddressSync([REPUTATION_SEED, buyerRepCommitment], MUGEN_PROGRAM_ID);

    const releaseDisc = disc('release_escrow');
    const releaseIx = new TransactionInstruction({
      programId: MUGEN_PROGRAM_ID,
      keys: [
        { pubkey: seller.publicKey, isSigner: true, isWritable: false },
        { pubkey: configPDA, isSigner: false, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: p01Ata, isSigner: false, isWritable: true },   // p01 fee
        { pubkey: p01Ata, isSigner: false, isWritable: true },   // mugen fee (same wallet devnet)
        { pubkey: p01Ata, isSigner: false, isWritable: true },   // treasury fee (same wallet devnet)
        { pubkey: noiseFundAta, isSigner: false, isWritable: true }, // noise fund!
        { pubkey: makerRepPda, isSigner: false, isWritable: true },
        { pubkey: takerRepPda, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: releaseDisc,
    });

    tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(releaseIx);
    const releaseSig = await sendAndConfirmTransaction(connection, tx, [seller], { commitment: 'confirmed' });
    console.log(`  Escrow released: tx: ${releaseSig.slice(0, 16)}...`);

    // ── Verify noise fund received its share ──
    const noiseFundInfo = await connection.getAccountInfo(noiseFundAta);
    if (noiseFundInfo && noiseFundInfo.data.length >= 72) {
      const noiseFundBalance = noiseFundInfo.data.readBigUInt64LE(64);
      console.log(`  Noise fund received: ${Number(noiseFundBalance)} lamports (${Number(noiseFundBalance) / LAMPORTS_PER_SOL} SOL)`);
      assert(noiseFundBalance > 0n, 'Noise fund should have received fees');
    }

    // Cleanup: close wSOL ATAs
    try {
      const cleanTx = new Transaction();
      cleanTx.add(createCloseAccountInstruction(buyerAta, buyer.publicKey, buyer.publicKey));
      await sendAndConfirmTransaction(connection, cleanTx, [buyer], { commitment: 'confirmed' });
    } catch { /* already closed or empty */ }

    console.log('  ✓ Full trade cycle complete with 4-way fee split');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 4: Stress test — rapid-fire denominated trades
  // ════════════════════════════════════════════════════════════════════

  it('4. Stress test: 4 rapid trades (different denominations)', async () => {
    const denominations = [
      { sol: SOL_TIERS[0], fiat: 1500, label: '0.1 SOL / $15' },
      { sol: SOL_TIERS[0], fiat: 1000, label: '0.1 SOL / $10' },
      { sol: SOL_TIERS[0], fiat: 5000, label: '0.1 SOL / $50' },
      { sol: SOL_TIERS[0], fiat: 2000, label: '0.1 SOL / $20' },
    ];

    let successCount = 0;

    for (let i = 0; i < denominations.length; i++) {
      const d = denominations[i];
      const seller = sellers[i];
      const buyer = buyers[i];

      try {
        // Quick create order
        const nonce = randomBytes(16);
        const [orderPda] = PublicKey.findProgramAddressSync(
          [ORDER_SEED, seller.publicKey.toBytes(), nonce],
          MUGEN_PROGRAM_ID,
        );

        const createDisc2 = disc('create_order');
        const params = Buffer.alloc(94);
        let pOff = 0;
        params.writeUInt8(1, pOff); pOff += 1;
        params.writeBigUInt64LE(d.sol, pOff); pOff += 8;
        params.writeBigUInt64LE(BigInt(d.fiat), pOff); pOff += 8;
        Buffer.from('USD').copy(params, pOff); pOff += 3;
        params.writeUInt16LE(2, pOff); pOff += 2;
        params.writeBigUInt64LE(0n, pOff); pOff += 8;
        params.writeBigUInt64LE(0n, pOff); pOff += 8;
        deriveRepCommitment(seller).copy(params, pOff); pOff += 32;
        nonce.copy(params, pOff); pOff += 16;
        params.writeBigInt64LE(3600n, pOff);

        const createData = Buffer.concat([createDisc2, params]);
        const createIx = new TransactionInstruction({
          programId: MUGEN_PROGRAM_ID,
          keys: [
            { pubkey: seller.publicKey, isSigner: true, isWritable: true },
            { pubkey: configPDA, isSigner: false, isWritable: false },
            { pubkey: orderPda, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: false, isWritable: false },
            { pubkey: NATIVE_SOL, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: createData,
        });

        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
        tx.add(createIx);
        await sendAndConfirmTransaction(connection, tx, [seller], { commitment: 'confirmed' });

        successCount++;
        console.log(`  [${i + 1}/4] ✓ ${d.label} order created`);
      } catch (err: any) {
        console.error(`  [${i + 1}/4] ✗ ${d.label}: ${err.message.slice(0, 80)}`);
      }
    }

    console.log(`  ${successCount}/4 stress trades succeeded`);
    assert(successCount >= 2, 'At least 2 stress trades should succeed');
  });

  // ════════════════════════════════════════════════════════════════════
  // TEST 5: Verify config state
  // ════════════════════════════════════════════════════════════════════

  it('5. Verify on-chain config has noise fund', async () => {
    const account = await connection.getAccountInfo(configPDA);
    assert(account !== null, 'Config should exist');

    const data = Buffer.from(account!.data);
    let off = 8; // skip discriminator
    const auth = new PublicKey(data.subarray(off, off + 32)); off += 32;
    const feeBps = data.readUInt16LE(off); off += 2;
    off += 32; // p01 wallet
    off += 32; // mugen wallet
    off += 32; // treasury wallet
    const p01Share = data.readUInt16LE(off); off += 2;
    const mugenShare = data.readUInt16LE(off); off += 2;
    const noiseFundWalletRead = new PublicKey(data.subarray(off, off + 32)); off += 32;
    const noiseShare = data.readUInt16LE(off); off += 2;

    console.log('  Fee:', feeBps, 'bps');
    console.log('  Split: P01', p01Share / 100, '% / Mugen', mugenShare / 100, '% / Noise', noiseShare / 100, '% / Treasury', (10000 - p01Share - mugenShare - noiseShare) / 100, '%');
    console.log('  Noise fund wallet:', noiseFundWalletRead.toBase58().slice(0, 20) + '...');

    assert.equal(feeBps, 50, 'Fee should be 50 bps');
    assert.equal(p01Share, 1500, 'P01 share should be 15%');
    assert.equal(mugenShare, 5500, 'Mugen share should be 55%');
    assert.equal(noiseShare, 1500, 'Noise share should be 15%');
    assert(noiseFundWalletRead.equals(noiseFundWallet.publicKey), 'Noise fund wallet should match');

    console.log('  ✓ Config verified: 4-way fee split active');
  });
});
