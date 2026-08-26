#!/usr/bin/env node
// Drain a per-pool fee_escrow PDA via Phase E v1 sweep_fee_escrow ix.
//
// Only TREASURY_AUTHORITY (admin keypair) can sign. Records each sweep in a
// SweepRecord PDA (idempotent per slot).
//
// Usage:
//   POOL=<denominated_pool_pubkey> \
//   AMOUNT_LAMPORTS=10000000 \
//   DESTINATION=<any_pubkey> \
//   node scripts/sweep-fee-escrow.mjs

import * as web3 from '@solana/web3.js';
import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';

const PROGRAM_ID = new web3.PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

if (RPC.includes('mainnet')) {
  console.error('REFUSING mainnet RPC.');
  process.exit(2);
}

// Anchor discriminator: sha256("global:sweep_fee_escrow")[..8]
const SWEEP_DISCRIMINATOR = Buffer.from([240, 78, 40, 84, 24, 149, 224, 188]);

function loadKeypair(p) {
  return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

async function main() {
  const poolStr = process.env.POOL;
  const amountStr = process.env.AMOUNT_LAMPORTS;
  const destStr = process.env.DESTINATION;
  if (!poolStr || !amountStr || !destStr) {
    console.error('Required env: POOL, AMOUNT_LAMPORTS, DESTINATION');
    process.exit(2);
  }
  const pool = new web3.PublicKey(poolStr);
  const amount = BigInt(amountStr);
  const destination = new web3.PublicKey(destStr);

  const adminPath = process.env.ADMIN_KEYPAIR
    ?? nodePath.join(os.homedir(), '.config', 'solana', 'id.json');
  const admin = loadKeypair(adminPath);
  console.log('RPC      :', RPC);
  console.log('Treasury :', admin.publicKey.toBase58());
  console.log('Pool     :', pool.toBase58());
  console.log('Amount   :', amountStr, 'lamports');
  console.log('Dest     :', destination.toBase58());

  const conn = new web3.Connection(RPC, 'confirmed');

  // Derive PDAs
  const [feeEscrowPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from('fee_escrow'), pool.toBuffer()],
    PROGRAM_ID,
  );
  console.log('FeeEscrow:', feeEscrowPDA.toBase58());

  const escrowBalance = await conn.getBalance(feeEscrowPDA);
  console.log('FeeEscrow balance:', escrowBalance, 'lamports');
  if (BigInt(escrowBalance) < amount) {
    console.error(`Escrow has ${escrowBalance} lamports, requested sweep ${amountStr}`);
    process.exit(2);
  }

  const slot = await conn.getSlot('confirmed');
  console.log('Current slot:', slot);

  const slotBuf = Buffer.alloc(8);
  slotBuf.writeBigUInt64LE(BigInt(slot), 0);
  const [sweepRecordPDA] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from('fee_sweep'), pool.toBuffer(), slotBuf],
    PROGRAM_ID,
  );
  console.log('SweepRecord PDA:', sweepRecordPDA.toBase58());

  // Build raw ix (no IDL required).
  //
  // 🚨 TWO ARGS, NOT ONE, AND THIS SCRIPT SENT ONE UNTIL 2026-08-26.
  // `pub fn sweep_fee_escrow(ctx, amount: u64, slot: u64)` — lib.rs:547-553.
  // Sending 8 bytes of args instead of 16 fails on chain with
  // `InstructionDidNotDeserialize` (Anchor 102, custom program error 0x66),
  // which is what it did every time anyone tried to recover the fees.
  //
  // The slot was already being computed above — for the SweepRecord PDA seed —
  // and simply never made it into the payload. The handler needs it as an
  // ARGUMENT too: it is what makes the sweep idempotent per slot, so a retry
  // after a dropped confirmation cannot double-drain the escrow. The PDA seed
  // and the argument have to agree, which is why both come from the same
  // `slot` binding rather than being read twice.
  //
  // MEASURED when found: 0.268 SOL sitting in the 1 SOL pool's escrow and
  // 0.0326 in the 0.1 pool's, none of it recoverable through this script.
  const argBuf = Buffer.alloc(16);
  argBuf.writeBigUInt64LE(amount, 0);
  argBuf.writeBigUInt64LE(BigInt(slot), 8);
  const data = Buffer.concat([SWEEP_DISCRIMINATOR, argBuf]);

  // Account ordering must match SweepFeeEscrow struct in
  // programs/zk_shielded/src/instructions/sweep_fee_escrow.rs:
  //   treasury_authority (Signer mut), denominated_pool, fee_escrow (mut),
  //   destination (mut), sweep_record (init mut), system_program
  const ix = new web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: false },
      { pubkey: feeEscrowPDA, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: sweepRecordPDA, isSigner: false, isWritable: true },
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new web3.Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(admin);

  console.log('Submitting sweep_fee_escrow...');
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log('Sweep tx:', sig);

  const newEscrowBalance = await conn.getBalance(feeEscrowPDA);
  const destBalance = await conn.getBalance(destination);
  console.log('After:');
  console.log('  FeeEscrow balance:', newEscrowBalance);
  console.log('  Destination balance:', destBalance);

  // Decode SweepRecord manually.
  // Layout: 8 disc + 32 pool + 8 slot + 8 amount + 16 dest_prefix + 1 bump
  const recAcc = await conn.getAccountInfo(sweepRecordPDA);
  if (recAcc) {
    const d = recAcc.data;
    const recPool = new web3.PublicKey(d.subarray(8, 40));
    const recSlot = d.readBigUInt64LE(40);
    const recAmount = d.readBigUInt64LE(48);
    const recDestPrefix = d.subarray(56, 72).toString('hex');
    console.log('SweepRecord:');
    console.log('  pool        :', recPool.toBase58());
    console.log('  slot        :', recSlot.toString());
    console.log('  amount      :', recAmount.toString());
    console.log('  dest_prefix :', recDestPrefix);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
