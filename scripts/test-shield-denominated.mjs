/**
 * Test shield_denominated on the 0.1 SOL pool
 *
 * Verifies the full deposit flow:
 *   1. Generate secret + nullifier_preimage
 *   2. Compute Poseidon commitment
 *   3. Read on-chain Merkle tree state
 *   4. Compute new root from filledSubtrees
 *   5. Send shield_denominated transaction
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { poseidon2, poseidon4 } from 'poseidon-lite';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const NATIVE_SOL_MINT = SystemProgram.programId;
const MERKLE_DEPTH = 15;
const SLOTS_PER_EPOCH = 7200;

const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);
const ZERO_VALUE = BigInt(
  '21663839004416932945382355908790599225266501822907911457504978515578255421292'
);

// Test pool: 0.1 SOL
const DENOMINATION = BigInt(0.1 * LAMPORTS_PER_SOL);

// ---------------------------------------------------------------------------
// Load authority
// ---------------------------------------------------------------------------

const keypairPath = process.env.USERPROFILE
  ? `${process.env.USERPROFILE}\\.config\\solana\\id.json`
  : `${process.env.HOME}/.config/solana/id.json`;
const secretKey = JSON.parse(readFileSync(keypairPath, 'utf8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(secretKey));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function randomField() {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n % FIELD_ORDER;
}

function pubkeyToField(pubkey) {
  const bytes = pubkey.toBytes();
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n % FIELD_ORDER;
}

function bigintToLeBytes32(n) {
  const bytes = new Array(32);
  let tmp = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(tmp & 0xFFn);
    tmp >>= 8n;
  }
  return bytes;
}

function slotToEpoch(slot) {
  return BigInt(Math.floor(slot / SLOTS_PER_EPOCH));
}

function computeZeroHashes() {
  const zeros = [ZERO_VALUE];
  for (let i = 1; i <= MERKLE_DEPTH; i++) {
    zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

function computeNewRootFromSubtrees(leaf, leafIndex, filledSubtrees) {
  const zeros = computeZeroHashes();
  const subtrees = [...filledSubtrees];
  let current = leaf;
  let idx = leafIndex;

  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const isRight = idx & 1;
    if (isRight === 0) {
      subtrees[level] = current;
      current = poseidon2([current, zeros[level]]);
    } else {
      current = poseidon2([subtrees[level], current]);
    }
    idx >>= 1;
  }

  return { newRoot: current, updatedSubtrees: subtrees };
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

function deriveDenominatedPoolPDA(tokenMint, denomination) {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denomination);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('denominated_pool'), tokenMint.toBuffer(), denomBuf],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveMerkleTreePDA(poolKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), poolKey.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('═══ Test: shield_denominated (0.1 SOL) ═══\n');

  const [poolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, DENOMINATION);
  const [treePDA] = deriveMerkleTreePDA(poolPDA);
  console.log('Pool PDA:', poolPDA.toBase58());
  console.log('Tree PDA:', treePDA.toBase58());

  // Check pool exists
  const poolAccount = await connection.getAccountInfo(poolPDA);
  if (!poolAccount) {
    console.error('Pool not found! Run setup-sol-denominated-pools.mjs first.');
    process.exit(1);
  }
  console.log('Pool exists:', poolAccount.data.length, 'bytes');

  // Check balance
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Authority balance:', (balance / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
  if (balance < Number(DENOMINATION) + 10000) {
    console.error('Insufficient balance for 0.1 SOL deposit + fees');
    process.exit(1);
  }

  // Get current slot for epoch
  const slot = await connection.getSlot('confirmed');
  const depositEpoch = slotToEpoch(slot);
  const tokenMintField = pubkeyToField(NATIVE_SOL_MINT);
  console.log('Current slot:', slot, '→ epoch:', depositEpoch.toString());

  // Generate note secrets
  const secret = randomField();
  const nullifierPreimage = randomField();
  console.log('Secret generated (first 8 hex):', secret.toString(16).slice(0, 8) + '...');

  // Compute commitment = Poseidon(nullifierPreimage, secret, depositEpoch, tokenMint)
  const commitment = poseidon4([nullifierPreimage, secret, depositEpoch, tokenMintField]);
  console.log('Commitment:', commitment.toString().slice(0, 20) + '...');

  // Read on-chain Merkle tree
  const treeAccount = await connection.getAccountInfo(treePDA);
  if (!treeAccount) {
    console.error('Merkle tree account not found!');
    process.exit(1);
  }

  const data = treeAccount.data;
  const leafCount = Number(data.readBigUInt64LE(8 + 32 + 32));
  const depth = data[8 + 32 + 32 + 8];
  const vecLen = data.readUInt32LE(8 + 32 + 32 + 8 + 1);
  console.log('Tree state: leafCount =', leafCount, ', depth =', depth, ', subtrees =', vecLen);

  // Parse filledSubtrees
  const filledSubtrees = [];
  let offset = 8 + 32 + 32 + 8 + 1 + 4;
  for (let i = 0; i < vecLen; i++) {
    let val = 0n;
    for (let b = 31; b >= 0; b--) {
      val = (val << 8n) | BigInt(data[offset + b]);
    }
    filledSubtrees.push(val);
    offset += 32;
  }

  // Compute new root
  const { newRoot } = computeNewRootFromSubtrees(commitment, leafCount, filledSubtrees);
  console.log('New root:', newRoot.toString().slice(0, 20) + '...');

  // Build shield_denominated instruction
  const disc = createHash('sha256').update('global:shield_denominated').digest().slice(0, 8);
  const commitmentBytes = bigintToLeBytes32(commitment);
  const newRootBytes = bigintToLeBytes32(newRoot);

  const ixData = Buffer.alloc(8 + 32 + 32);
  disc.copy(ixData, 0);
  Buffer.from(commitmentBytes).copy(ixData, 8);
  Buffer.from(newRootBytes).copy(ixData, 40);

  const ix = new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: treePDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // Optional accounts — pass program ID as "None" sentinel (Anchor 0.32)
      { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program = None
      { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // user_token_account = None
      { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // pool_vault = None
    ],
    data: ixData,
  });

  console.log('\nSending shield_denominated tx...');
  const tx = new Transaction().add(ix);

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
      commitment: 'confirmed',
    });
    console.log('\n✓ shield_denominated SUCCESS!');
    console.log('Signature:', sig);
    console.log('Explorer:', `https://explorer.solana.com/tx/${sig}?cluster=devnet`);

    // Verify tree updated
    const treeAfter = await connection.getAccountInfo(treePDA);
    const newLeafCount = Number(treeAfter.data.readBigUInt64LE(8 + 32 + 32));
    console.log('Leaf count: before =', leafCount, ', after =', newLeafCount);
  } catch (err) {
    console.error('\n✗ shield_denominated FAILED:', err.message);
    if (err.logs) {
      console.log('\nProgram logs:');
      err.logs.forEach(log => console.log('  ', log));
    }
  }
}

main().catch(console.error);
