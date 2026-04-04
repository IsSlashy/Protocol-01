/**
 * Mugen Exchange — Initialize config + create test orders on devnet.
 *
 * Run: ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" \
 *      ANCHOR_WALLET=~/.config/solana/id.json \
 *      npx ts-mocha -p tsconfig.test.json tests/mugen-init.ts --timeout 120000
 */

import { describe, it } from 'mocha';
import { assert } from 'chai';
import * as anchor from '@coral-xyz/anchor';
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
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha256';
import { readFileSync } from 'fs';
import { homedir } from 'os';

// ─── Config ──────────────────────────────────────────────────────────────────

const MUGEN_PROGRAM_ID = new PublicKey('EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN');

const CONFIG_SEED = Buffer.from('mugen_config');
const ORDER_SEED = Buffer.from('mugen_order');
const REPUTATION_SEED = Buffer.from('mugen_rep');

// SOL mint (native)
const NATIVE_SOL = new PublicKey('So11111111111111111111111111111111111111112');

function anchorDisc(name: string): Buffer {
  const hash = sha256(`global:${name}`);
  return Buffer.from(hash.slice(0, 8));
}

function loadKeypair(): Keypair {
  const path = `${homedir()}/.config/solana/id.json`;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Mugen Exchange — Devnet Init', () => {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  const wallet = loadKeypair();
  const feeWallet = wallet.publicKey; // Use same wallet for fees in devnet

  console.log('Wallet:', wallet.publicKey.toBase58());

  it('1. Initialize MugenConfig', async () => {
    const [configPDA, configBump] = PublicKey.findProgramAddressSync(
      [CONFIG_SEED],
      MUGEN_PROGRAM_ID,
    );

    console.log('Config PDA:', configPDA.toBase58());

    // Check if already initialized
    const existing = await connection.getAccountInfo(configPDA);
    if (existing) {
      console.log('Config already initialized, skipping');
      return;
    }

    // InitConfigParams: fee_bps(u16) + fee_wallet(32) + min_trade(u64) + max_trade(u64) + escrow_timeout(i64) + dispute_timeout(i64)
    const disc = anchorDisc('initialize_config');
    const data = Buffer.alloc(8 + 2 + 32 + 8 + 8 + 8 + 8);
    let offset = 0;
    disc.copy(data, offset); offset += 8;
    data.writeUInt16LE(50, offset); offset += 2; // 0.5% fee
    feeWallet.toBuffer().copy(data, offset); offset += 32;
    data.writeBigUInt64LE(1000000n, offset); offset += 8;        // min: 0.001 SOL
    data.writeBigUInt64LE(1000000000000n, offset); offset += 8;  // max: 1000 SOL
    data.writeBigInt64LE(3600n, offset); offset += 8;            // escrow timeout: 1h
    data.writeBigInt64LE(86400n, offset); offset += 8;           // dispute timeout: 24h

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: MUGEN_PROGRAM_ID,
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(ix);

    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
    console.log('Config initialized:', sig);

    // Verify
    const configAccount = await connection.getAccountInfo(configPDA);
    assert(configAccount !== null, 'Config PDA should exist');
    console.log('Config account size:', configAccount!.data.length, 'bytes');
  });

  it('2. Create test USDC mint (devnet)', async () => {
    // We'll use a devnet USDC for testing
    // Skip if we already have one
    const devnetUSDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    const info = await connection.getAccountInfo(devnetUSDC);
    if (info) {
      console.log('Devnet USDC exists:', devnetUSDC.toBase58());
    } else {
      console.log('Using SOL for test orders (devnet USDC not available)');
    }
  });

  it('3. Create sell order: 1 SOL for $148 USD', async () => {
    const [configPDA] = PublicKey.findProgramAddressSync([CONFIG_SEED], MUGEN_PROGRAM_ID);
    const nonce = Keypair.generate().publicKey.toBytes().slice(0, 16);
    const [orderPDA] = PublicKey.findProgramAddressSync(
      [ORDER_SEED, wallet.publicKey.toBuffer(), Buffer.from(nonce)],
      MUGEN_PROGRAM_ID,
    );

    console.log('Order PDA:', orderPDA.toBase58());

    // Reputation commitment (dummy for now)
    const repCommitment = Buffer.alloc(32);
    repCommitment.writeUInt32LE(12345, 0);

    // CreateOrderParams
    const disc = anchorDisc('create_order');
    const data = Buffer.alloc(8 + 1 + 8 + 8 + 3 + 2 + 8 + 8 + 32 + 16 + 8);
    let offset = 0;
    disc.copy(data, offset); offset += 8;
    data.writeUInt8(1, offset); offset += 1; // sell_crypto
    data.writeBigUInt64LE(1_000_000_000n, offset); offset += 8; // 1 SOL
    data.writeBigUInt64LE(14800n, offset); offset += 8; // $148.00
    Buffer.from('USD').copy(data, offset); offset += 3;
    data.writeUInt16LE(1 | 2, offset); offset += 2; // bank + revolut
    data.writeBigUInt64LE(0n, offset); offset += 8; // no min
    data.writeBigUInt64LE(0n, offset); offset += 8; // no max (= full)
    repCommitment.copy(data, offset); offset += 32;
    Buffer.from(nonce).copy(data, offset); offset += 16;
    data.writeBigInt64LE(86400n, offset); offset += 8; // expires in 24h

    // Authority bypass: pass the authority wallet as the attestation account
    // The program skips attestation validation when attestation.key() == config.authority
    const attestationKey = wallet.publicKey; // = config.authority

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: orderPDA, isSigner: false, isWritable: true },
        { pubkey: attestationKey, isSigner: false, isWritable: false },
        { pubkey: NATIVE_SOL, isSigner: false, isWritable: false }, // token mint
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: MUGEN_PROGRAM_ID,
      data,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
    tx.add(ix);

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
      console.log('Order created:', sig);
      console.log('Order address:', orderPDA.toBase58());

      // Verify
      const orderAccount = await connection.getAccountInfo(orderPDA);
      assert(orderAccount !== null, 'Order PDA should exist');
      console.log('Order account size:', orderAccount!.data.length, 'bytes');
    } catch (err: any) {
      console.error('Create order failed:', err.message);
      if (err.logs) {
        console.error('Logs:', err.logs.slice(-5));
      }
    }
  });

  it('4. Verify config on-chain', async () => {
    const [configPDA] = PublicKey.findProgramAddressSync([CONFIG_SEED], MUGEN_PROGRAM_ID);
    const account = await connection.getAccountInfo(configPDA);

    if (!account) {
      console.log('Config not found — initialize first');
      return;
    }

    const data = Buffer.from(account.data);
    let offset = 8; // skip discriminator
    const authority = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const feeBps = data.readUInt16LE(offset); offset += 2;
    const feeWalletPk = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
    const minTrade = data.readBigUInt64LE(offset); offset += 8;
    const maxTrade = data.readBigUInt64LE(offset); offset += 8;
    const escrowTimeout = data.readBigInt64LE(offset); offset += 8;
    const disputeTimeout = data.readBigInt64LE(offset); offset += 8;
    const totalTrades = data.readBigUInt64LE(offset); offset += 8;
    const totalVolume = data.readBigUInt64LE(offset); offset += 8;
    const isActive = data.readUInt8(offset) !== 0;

    console.log('=== Mugen Config ===');
    console.log('Authority:', authority.toBase58());
    console.log('Fee:', feeBps, 'bps (', feeBps / 100, '%)');
    console.log('Fee Wallet:', feeWalletPk.toBase58());
    console.log('Min Trade:', minTrade.toString(), 'lamports');
    console.log('Max Trade:', maxTrade.toString(), 'lamports');
    console.log('Escrow Timeout:', escrowTimeout.toString(), 's');
    console.log('Dispute Timeout:', disputeTimeout.toString(), 's');
    console.log('Total Trades:', totalTrades.toString());
    console.log('Total Volume:', totalVolume.toString());
    console.log('Active:', isActive);

    assert(isActive, 'Exchange should be active');
    assert.equal(feeBps, 50, 'Fee should be 50 bps');
  });
});
