/**
 * Test the deposit proof generation and verification.
 * Fixes the ownerPubkey derivation: owner_pubkey = Poseidon(spending_key)
 * Tests both local snarkjs and remote Rust prover.
 */

import { readFileSync } from 'fs';
import { SystemProgram } from '@solana/web3.js';
import * as snarkjs from 'snarkjs';

const TOKEN_MINT = SystemProgram.programId; // Native SOL

// BN254 field modulus
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------------
// Poseidon (via circomlibjs — matches circom's Poseidon exactly)
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
// Crypto utils (matching SDK's crypto.ts)
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

function pubkeyToField(pubkeyBytes) {
  return bytesToField(pubkeyBytes);
}

/** FIXED: owner_pubkey = Poseidon(spending_key) — matches circuit OwnerDerivation template */
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
// Test deposit proof: local snarkjs + remote Rust prover
// ---------------------------------------------------------------------------

async function main() {
  const spendingKey = 12345n;
  const ownerPubkey = await deriveOwnerPubkey(spendingKey);
  const tokenMintField = pubkeyToField(TOKEN_MINT.toBytes());

  console.log('Spending key:', spendingKey.toString());
  console.log('Owner pubkey (Poseidon(spending_key)):', ownerPubkey.toString());
  console.log('Token mint field:', tokenMintField.toString());

  const balance = 0n;
  const salt = randomSalt();
  const depositAmount = 100000n;

  const oldCommitment = await createBalanceCommitment(balance, salt, ownerPubkey, tokenMintField);
  const newBalance = balance + depositAmount;
  const newSalt = randomSalt();
  const newCommitment = await createBalanceCommitment(newBalance, newSalt, ownerPubkey, tokenMintField);
  const amountHash = await createAmountCommitment(0n, 0n);

  console.log('\nOld commitment:', oldCommitment.toString());
  console.log('New commitment:', newCommitment.toString());
  console.log('Zero amount hash:', amountHash.toString());

  const circuitInputs = {
    // Public
    old_commitment: oldCommitment.toString(),
    new_commitment: newCommitment.toString(),
    amount_hash: amountHash.toString(),
    public_credit: depositAmount.toString(),
    public_debit: '0',
    token_mint: tokenMintField.toString(),
    nonce: '0',
    // Private
    old_balance: balance.toString(),
    old_salt: salt.toString(),
    new_balance: newBalance.toString(),
    new_salt: newSalt.toString(),
    amount: '0',
    amount_salt: '0',
    spending_key: spendingKey.toString(),
    is_debit: '0',
  };

  console.log('\n--- Circuit Inputs ---');
  console.log(JSON.stringify(circuitInputs, null, 2));

  // Load VK JSON for verification
  const vkJson = JSON.parse(readFileSync('circuits/build/confidential_balance_vk.json', 'utf8'));

  // =========================================================================
  // TEST 1: Local snarkjs proof generation + verification
  // =========================================================================
  console.log('\n========================================');
  console.log('TEST 1: Local snarkjs proof');
  console.log('========================================');

  try {
    const wasmPath = 'circuits/build/confidential_balance_js/confidential_balance.wasm';
    const zkeyPath = 'circuits/build/confidential_balance.zkey';

    console.log('Generating local proof...');
    const startLocal = Date.now();
    const { proof: localProof, publicSignals: localSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      wasmPath,
      zkeyPath
    );
    console.log(`Local proof time: ${Date.now() - startLocal} ms`);
    console.log('Local public signals:', localSignals);

    const localValid = await snarkjs.groth16.verify(vkJson, localSignals, localProof);
    console.log('Local verification:', localValid ? 'PASS' : 'FAIL');
  } catch (err) {
    console.error('Local proof FAILED:', err.message);
  }

  // =========================================================================
  // TEST 2: Remote Rust prover + snarkjs verification
  // =========================================================================
  console.log('\n========================================');
  console.log('TEST 2: Remote Rust prover');
  console.log('========================================');

  try {
    console.log('Generating remote proof...');
    const startRemote = Date.now();
    const response = await fetch('https://p01-relayer-production.up.railway.app/prove/zkspl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ circuit: 'confidential_balance', inputs: circuitInputs }),
    });

    if (!response.ok) {
      console.error('Remote prover HTTP error:', response.status, await response.text());
      return;
    }

    const result = await response.json();
    console.log(`Remote proof time: ${result.proofTimeMs ?? (Date.now() - startRemote)} ms`);
    console.log('Self-verified:', result.selfVerified);
    console.log('Prover:', result.prover);
    console.log('Remote public signals:', result.publicSignals);

    const remoteValid = await snarkjs.groth16.verify(vkJson, result.publicSignals, result.proof);
    console.log('Remote verification:', remoteValid ? 'PASS' : 'FAIL');

    if (!remoteValid) {
      console.log('\nRemote proof failed snarkjs verification!');
      console.log('This means the Rust prover generates invalid proofs.');
      console.log('Possible causes:');
      console.log('  1. zkey on relayer differs from monorepo zkey');
      console.log('  2. Proof serialization bug in prover/serialize.rs');
      console.log('  3. Witness computation differs from snarkjs WASM');
    }
  } catch (err) {
    console.error('Remote proof FAILED:', err.message);
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
