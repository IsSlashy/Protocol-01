/**
 * End-to-end test for zkSPL confidential transfer flow.
 * Tests: deposit → confidential_transfer → apply_pending
 *
 * Uses remote Rust prover + local snarkjs verification.
 */

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import * as snarkjs from 'snarkjs';

const PROGRAM_ID = new PublicKey('EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah');
const TOKEN_MINT = SystemProgram.programId;
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const PROVER_URL = 'https://p01-relayer-production.up.railway.app/prove/zkspl';

// ---------------------------------------------------------------------------
// Poseidon (via circomlibjs)
// ---------------------------------------------------------------------------
let poseidon;
async function getPoseidon() {
  if (!poseidon) {
    const { buildPoseidon } = await import('circomlibjs');
    poseidon = await buildPoseidon();
  }
  return poseidon;
}

async function poseidonHash(inputs) {
  const p = await getPoseidon();
  const hash = p(inputs.map(i => BigInt(i)));
  return p.F.toObject(hash);
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
function bytesToField(bytes) {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result % FIELD_MODULUS;
}

function fieldToBytes(field) {
  const bytes = new Uint8Array(32);
  let value = field;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function fieldToBytesBE(field) {
  const bytes = new Uint8Array(32);
  let value = field;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function pubkeyToField(pubkeyBytes) {
  return bytesToField(pubkeyBytes);
}

async function deriveOwnerPubkey(spendingKey) {
  return poseidonHash([spendingKey]);
}

async function createBalanceCommitment(balance, salt, ownerPubkey, tokenMint) {
  return poseidonHash([balance, salt, ownerPubkey, tokenMint]);
}

async function createAmountCommitment(amount, amountSalt) {
  return poseidonHash([amount, amountSalt]);
}

function randomSalt() {
  const bytes = new Uint8Array(31);
  for (let i = 0; i < 31; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytesToField(bytes);
}

// ---------------------------------------------------------------------------
// Proof generation via remote prover + local verification
// ---------------------------------------------------------------------------
async function generateAndVerifyProof(circuitInputs, label) {
  console.log(`\n--- ${label}: Generating proof ---`);

  const response = await fetch(PROVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ circuit: 'confidential_balance', inputs: circuitInputs }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Remote prover error ${response.status}: ${text}`);
  }

  const result = await response.json();
  console.log(`  Proof time: ${result.proofTimeMs} ms | Prover: ${result.prover}`);

  // Verify with snarkjs
  const vkJson = JSON.parse(readFileSync('circuits/build/confidential_balance_vk.json', 'utf8'));
  const valid = await snarkjs.groth16.verify(vkJson, result.publicSignals, result.proof);
  console.log(`  snarkjs verification: ${valid ? 'PASS' : 'FAIL'}`);

  if (!valid) throw new Error(`${label}: Proof failed snarkjs verification!`);

  return { proof: result.proof, publicSignals: result.publicSignals };
}

// ---------------------------------------------------------------------------
// Main test flow
// ---------------------------------------------------------------------------
async function main() {
  const tokenMintField = pubkeyToField(TOKEN_MINT.toBytes());

  // Two test users
  const spendingKeyA = 12345n;
  const spendingKeyB = 67890n;
  const ownerPubkeyA = await deriveOwnerPubkey(spendingKeyA);
  const ownerPubkeyB = await deriveOwnerPubkey(spendingKeyB);

  console.log('=== User A ===');
  console.log('  Spending key:', spendingKeyA.toString());
  console.log('  Owner pubkey:', ownerPubkeyA.toString().slice(0, 30) + '...');
  console.log('=== User B ===');
  console.log('  Spending key:', spendingKeyB.toString());
  console.log('  Owner pubkey:', ownerPubkeyB.toString().slice(0, 30) + '...');

  // =========================================================================
  // STEP 1: DEPOSIT — User A deposits 1,000,000 lamports (0.001 SOL)
  // =========================================================================
  console.log('\n========================================');
  console.log('STEP 1: DEPOSIT (User A, 0.001 SOL)');
  console.log('========================================');

  const saltA0 = randomSalt();
  const saltA1 = randomSalt();
  const depositAmount = 1000000n;

  const commitA0 = await createBalanceCommitment(0n, saltA0, ownerPubkeyA, tokenMintField);
  const commitA1 = await createBalanceCommitment(depositAmount, saltA1, ownerPubkeyA, tokenMintField);
  const zeroAmountHash = await createAmountCommitment(0n, 0n);

  const depositInputs = {
    old_commitment: commitA0.toString(),
    new_commitment: commitA1.toString(),
    amount_hash: zeroAmountHash.toString(),
    public_credit: depositAmount.toString(),
    public_debit: '0',
    token_mint: tokenMintField.toString(),
    nonce: '0',
    old_balance: '0',
    old_salt: saltA0.toString(),
    new_balance: depositAmount.toString(),
    new_salt: saltA1.toString(),
    amount: '0',
    amount_salt: '0',
    spending_key: spendingKeyA.toString(),
    is_debit: '0',
  };

  await generateAndVerifyProof(depositInputs, 'DEPOSIT');
  console.log('  User A balance after deposit: 1,000,000 lamports');

  // =========================================================================
  // STEP 2: TRANSFER — User A sends 300,000 lamports to User B
  // =========================================================================
  console.log('\n========================================');
  console.log('STEP 2: TRANSFER (A → B, 300,000 lamports)');
  console.log('========================================');

  const transferAmount = 300000n;
  const amountSalt = randomSalt();
  const amountHash = await createAmountCommitment(transferAmount, amountSalt);

  const balanceA_after_transfer = depositAmount - transferAmount; // 700,000
  const saltA2 = randomSalt();
  const commitA2 = await createBalanceCommitment(balanceA_after_transfer, saltA2, ownerPubkeyA, tokenMintField);

  const transferInputs = {
    old_commitment: commitA1.toString(),
    new_commitment: commitA2.toString(),
    amount_hash: amountHash.toString(),
    public_credit: '0',
    public_debit: '0',
    token_mint: tokenMintField.toString(),
    nonce: '1', // after deposit, nonce = 1
    old_balance: depositAmount.toString(),
    old_salt: saltA1.toString(),
    new_balance: balanceA_after_transfer.toString(),
    new_salt: saltA2.toString(),
    amount: transferAmount.toString(),
    amount_salt: amountSalt.toString(),
    spending_key: spendingKeyA.toString(),
    is_debit: '1', // SENDING
  };

  await generateAndVerifyProof(transferInputs, 'TRANSFER (sender)');
  console.log(`  User A balance after transfer: ${balanceA_after_transfer} lamports`);
  console.log(`  Amount hash: ${amountHash.toString().slice(0, 30)}...`);

  // =========================================================================
  // STEP 3: APPLY PENDING — User B receives the transfer
  // =========================================================================
  console.log('\n========================================');
  console.log('STEP 3: APPLY PENDING (User B receives)');
  console.log('========================================');

  const saltB0 = randomSalt();
  const saltB1 = randomSalt();
  const commitB0 = await createBalanceCommitment(0n, saltB0, ownerPubkeyB, tokenMintField);
  const commitB1 = await createBalanceCommitment(transferAmount, saltB1, ownerPubkeyB, tokenMintField);

  const applyInputs = {
    old_commitment: commitB0.toString(),
    new_commitment: commitB1.toString(),
    amount_hash: amountHash.toString(), // SAME hash from sender
    public_credit: '0',
    public_debit: '0',
    token_mint: tokenMintField.toString(),
    nonce: '0', // User B's nonce is 0 (first tx)
    old_balance: '0',
    old_salt: saltB0.toString(),
    new_balance: transferAmount.toString(),
    new_salt: saltB1.toString(),
    amount: transferAmount.toString(),
    amount_salt: amountSalt.toString(), // SAME salt from sender
    spending_key: spendingKeyB.toString(),
    is_debit: '0', // RECEIVING
  };

  await generateAndVerifyProof(applyInputs, 'APPLY PENDING (recipient)');
  console.log(`  User B balance after receiving: ${transferAmount} lamports`);

  // =========================================================================
  // STEP 4: WITHDRAW — User A withdraws 200,000 lamports
  // =========================================================================
  console.log('\n========================================');
  console.log('STEP 4: WITHDRAW (User A, 200,000 lamports)');
  console.log('========================================');

  const withdrawAmount = 200000n;
  const balanceA_after_withdraw = balanceA_after_transfer - withdrawAmount; // 500,000
  const saltA3 = randomSalt();
  const commitA3 = await createBalanceCommitment(balanceA_after_withdraw, saltA3, ownerPubkeyA, tokenMintField);

  const withdrawInputs = {
    old_commitment: commitA2.toString(),
    new_commitment: commitA3.toString(),
    amount_hash: zeroAmountHash.toString(),
    public_credit: '0',
    public_debit: withdrawAmount.toString(),
    token_mint: tokenMintField.toString(),
    nonce: '2', // after deposit(1) + transfer(2)
    old_balance: balanceA_after_transfer.toString(),
    old_salt: saltA2.toString(),
    new_balance: balanceA_after_withdraw.toString(),
    new_salt: saltA3.toString(),
    amount: '0',
    amount_salt: '0',
    spending_key: spendingKeyA.toString(),
    is_debit: '0',
  };

  await generateAndVerifyProof(withdrawInputs, 'WITHDRAW');
  console.log(`  User A balance after withdraw: ${balanceA_after_withdraw} lamports`);

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n========================================');
  console.log('ALL 4 OPERATIONS PASSED');
  console.log('========================================');
  console.log('  1. DEPOSIT   (public credit)    — PASS');
  console.log('  2. TRANSFER  (private, sender)  — PASS');
  console.log('  3. APPLY     (private, receiver) — PASS');
  console.log('  4. WITHDRAW  (public debit)     — PASS');
  console.log('\n  All proofs verified with snarkjs.');
  console.log('  The remote Rust prover correctly handles all 4 operation types.');
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  process.exit(1);
});
