/**
 * End-to-end test: Denominated pool transfer (ZK-to-ZK note transfer)
 *
 * Flow:
 *   1. Shield 0.1 SOL into the denominated pool (deposit)
 *   2. Wait for maturity (or skip if already mature)
 *   3. Generate ZK proof for transfer (client-side snarkjs)
 *   4. Send transfer_denominated transaction
 *   5. Verify: old note nullified, new commitment in tree
 *   6. Export the new note as shareable data
 *
 * Prerequisites:
 *   - Denominated pools initialized on devnet
 *   - circuits/build/denominated_transfer.wasm + denominated_transfer.zkey
 *   - At least 0.15 SOL in the authority wallet
 *
 * Usage:
 *   node scripts/test-denominated-transfer.mjs [--skip-shield]
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
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { poseidon2, poseidon4 } from 'poseidon-lite';
import * as snarkjs from 'snarkjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const NATIVE_SOL_MINT = SystemProgram.programId;
const MERKLE_DEPTH = 15;
const SLOTS_PER_EPOCH = 7200;
const DENOMINATION = BigInt(0.1 * LAMPORTS_PER_SOL); // 0.1 SOL

const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);
const ZERO_VALUE = BigInt(
  '21663839004416932945382355908790599225266501822907911457504978515578255421292'
);

const SKIP_SHIELD = process.argv.includes('--skip-shield');

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

function randomFieldElement() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (let i = 0; i < 32; i++) {
    n = (n << 8n) | BigInt(bytes[i]);
  }
  return n % FIELD_ORDER;
}

function pubkeyToField(pubkey) {
  const bytes = pubkey.toBytes();
  let n = 0n;
  for (let i = 0; i < 32; i++) {
    n = (n << 8n) | BigInt(bytes[i]);
  }
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

function bigintToBeBytes32(n) {
  const bytes = new Uint8Array(32);
  let tmp = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(tmp & 0xFFn);
    tmp >>= 8n;
  }
  return bytes;
}

function slotToEpoch(slot) {
  return BigInt(Math.floor(slot / SLOTS_PER_EPOCH));
}

// ---------------------------------------------------------------------------
// Merkle
// ---------------------------------------------------------------------------

function computeZeroHashes() {
  const zeros = [ZERO_VALUE];
  for (let i = 1; i <= MERKLE_DEPTH; i++) {
    zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

const ZERO_HASHES = computeZeroHashes();

function computeNewRootFromSubtrees(leaf, leafIndex, filledSubtrees) {
  const subtrees = [...filledSubtrees];
  const pathElements = [];
  const pathIndices = [];

  let current = leaf;
  let idx = leafIndex;

  for (let level = 0; level < MERKLE_DEPTH; level++) {
    const isRight = idx & 1;
    pathIndices.push(isRight);

    if (isRight === 0) {
      pathElements.push(ZERO_HASHES[level]);
      subtrees[level] = current;
      current = poseidon2([current, ZERO_HASHES[level]]);
    } else {
      pathElements.push(subtrees[level]);
      current = poseidon2([subtrees[level], current]);
    }
    idx >>= 1;
  }

  return { newRoot: current, updatedSubtrees: subtrees, pathElements, pathIndices };
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

function deriveNullifierPDA(poolKey, nullifierBytes) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), poolKey.toBuffer(), nullifierBytes],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveVkDataPDA(poolKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vk_data'), poolKey.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Anchor discriminator
// ---------------------------------------------------------------------------

function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

// ---------------------------------------------------------------------------
// Read on-chain Merkle tree state
// ---------------------------------------------------------------------------

async function readMerkleTree(treePDA) {
  const account = await connection.getAccountInfo(treePDA);
  if (!account) throw new Error('Merkle tree account not found');

  const data = account.data;
  const leafCount = Number(data.readBigUInt64LE(8 + 32 + 32));
  const depth = data[8 + 32 + 32 + 8];
  const vecLen = data.readUInt32LE(8 + 32 + 32 + 8 + 1);

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

  // Read on-chain root (32 bytes after disc + pool pubkey)
  let onChainRoot = 0n;
  for (let b = 31; b >= 0; b--) {
    onChainRoot = (onChainRoot << 8n) | BigInt(data[8 + 32 + b]);
  }

  return { leafCount, depth, filledSubtrees, onChainRoot };
}

// ---------------------------------------------------------------------------
// Proof helpers
// ---------------------------------------------------------------------------

function proofToOnChainBytes(proof) {
  const piA = new Uint8Array(64);
  piA.set(bigintToBeBytes32(BigInt(proof.pi_a[0])), 0);
  piA.set(bigintToBeBytes32(BigInt(proof.pi_a[1])), 32);

  const piB = new Uint8Array(128);
  piB.set(bigintToBeBytes32(BigInt(proof.pi_b[0][1])), 0);
  piB.set(bigintToBeBytes32(BigInt(proof.pi_b[0][0])), 32);
  piB.set(bigintToBeBytes32(BigInt(proof.pi_b[1][1])), 64);
  piB.set(bigintToBeBytes32(BigInt(proof.pi_b[1][0])), 96);

  const piC = new Uint8Array(64);
  piC.set(bigintToBeBytes32(BigInt(proof.pi_c[0])), 0);
  piC.set(bigintToBeBytes32(BigInt(proof.pi_c[1])), 32);

  return { piA: Array.from(piA), piB: Array.from(piB), piC: Array.from(piC) };
}

// ---------------------------------------------------------------------------
// Build shield_denominated instruction
// ---------------------------------------------------------------------------

function buildShieldDenominatedIx(depositor, poolPDA, treePDA, commitmentBytes, newRootBytes) {
  const disc = getDiscriminator('shield_denominated');
  const data = Buffer.alloc(8 + 32 + 32);
  disc.copy(data, 0);
  Buffer.from(commitmentBytes).copy(data, 8);
  Buffer.from(newRootBytes).copy(data, 40);

  return new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: treePDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Build transfer_denominated instruction
// ---------------------------------------------------------------------------

function buildTransferDenominatedIx(
  payer, poolPDA, treePDA, nullifierPDA, vkDataPDA,
  proofBytes, nullifierBytes, merkleRootBytes, minEpoch,
  newCommitmentBytes, newRootBytes
) {
  const disc = getDiscriminator('transfer_denominated');
  // proof (64+128+64) + nullifier (32) + merkle_root (32) + min_epoch (8) + new_commitment (32) + new_root (32)
  const data = Buffer.alloc(8 + 256 + 32 + 32 + 8 + 32 + 32);
  let offset = 0;

  disc.copy(data, offset); offset += 8;

  // Groth16Proof: pi_a (64) + pi_b (128) + pi_c (64)
  Buffer.from(proofBytes.piA).copy(data, offset); offset += 64;
  Buffer.from(proofBytes.piB).copy(data, offset); offset += 128;
  Buffer.from(proofBytes.piC).copy(data, offset); offset += 64;

  // nullifier [u8; 32]
  Buffer.from(nullifierBytes).copy(data, offset); offset += 32;

  // merkle_root [u8; 32]
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;

  // min_epoch u64 (LE)
  data.writeBigUInt64LE(minEpoch, offset); offset += 8;

  // new_commitment [u8; 32]
  Buffer.from(newCommitmentBytes).copy(data, offset); offset += 32;

  // new_root [u8; 32]
  Buffer.from(newRootBytes).copy(data, offset); offset += 32;

  return new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: treePDA, isSigner: false, isWritable: true },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: vkDataPDA, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Denominated Transfer E2E Test ===\n');
  console.log('Authority:', authority.publicKey.toBase58());
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', (balance / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
  console.log('Pool: 0.1 SOL denominated\n');

  const tokenMintField = pubkeyToField(NATIVE_SOL_MINT);
  const [poolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, DENOMINATION);
  const [treePDA] = deriveMerkleTreePDA(poolPDA);
  const [vkDataPDA] = deriveVkDataPDA(poolPDA);

  console.log('Pool PDA:', poolPDA.toBase58());
  console.log('Tree PDA:', treePDA.toBase58());

  // -----------------------------------------------------------------------
  // Step 1: Shield (deposit) — unless --skip-shield
  // -----------------------------------------------------------------------
  let receipt;

  if (SKIP_SHIELD) {
    console.log('\n--- Skipping shield (--skip-shield) ---');
    console.log('You must provide a receipt JSON via stdin or have a recent deposit.\n');
    // In practice, you'd load from a file or env var
    throw new Error('--skip-shield requires a receipt JSON file. Not yet implemented.');
  }

  console.log('\n--- Step 1: Shield 0.1 SOL ---');

  const slot = await connection.getSlot('confirmed');
  const depositEpoch = slotToEpoch(slot);
  console.log('Current slot:', slot, 'epoch:', depositEpoch.toString());

  const secret = randomFieldElement();
  const nullifierPreimage = randomFieldElement();
  const commitment = poseidon4([nullifierPreimage, secret, depositEpoch, tokenMintField]);
  console.log('Commitment:', commitment.toString().slice(0, 20) + '...');

  // Read Merkle tree state
  const treeState = await readMerkleTree(treePDA);
  console.log('Leaf count:', treeState.leafCount);

  const { newRoot: shieldRoot, pathElements, pathIndices } =
    computeNewRootFromSubtrees(commitment, treeState.leafCount, treeState.filledSubtrees);

  // Build and send shield transaction
  const commitmentBytes = bigintToLeBytes32(commitment);
  const shieldRootBytes = bigintToLeBytes32(shieldRoot);

  const shieldIx = buildShieldDenominatedIx(
    authority.publicKey, poolPDA, treePDA, commitmentBytes, shieldRootBytes
  );
  const shieldTx = new Transaction().add(shieldIx);
  const shieldSig = await sendAndConfirmTransaction(connection, shieldTx, [authority]);
  console.log('Shield tx:', shieldSig);

  receipt = {
    secret,
    nullifierPreimage,
    depositEpoch,
    tokenMint: tokenMintField,
    commitment,
    leafIndex: treeState.leafCount,
    denomination: DENOMINATION,
    pool: poolPDA.toBase58(),
    merklePathElements: pathElements,
    merklePathIndices: pathIndices,
    merkleRoot: shieldRoot,
  };

  console.log('Note shielded. Leaf index:', receipt.leafIndex);

  // -----------------------------------------------------------------------
  // Step 2: Check maturity
  // -----------------------------------------------------------------------
  console.log('\n--- Step 2: Check maturity ---');

  // Read pool account to get epoch_delay
  const poolAccount = await connection.getAccountInfo(poolPDA);
  if (!poolAccount) throw new Error('Pool account not found');
  // epoch_delay is at offset: 8 (disc) + 32 (authority) + 32 (token_mint) + 8 (denomination) + 32 (vk_hash) + 1 (is_active) + 8 (note_count) + 8 (total_shielded)
  const epochDelay = poolAccount.data.readBigUInt64LE(8 + 32 + 32 + 8 + 32 + 1 + 8 + 8);
  console.log('Pool epoch_delay:', epochDelay.toString());

  const currentSlot = await connection.getSlot('confirmed');
  const currentEpoch = slotToEpoch(currentSlot);
  const minEpoch = currentEpoch - epochDelay;

  if (receipt.depositEpoch > minEpoch) {
    const remaining = Number(receipt.depositEpoch - minEpoch + 1n);
    console.log(`Note not mature yet. Need ${remaining} more epoch(s).`);
    console.log('For testing, the pool epoch_delay may be set to 0.');

    if (epochDelay > 0n) {
      console.log('\nTIP: To test without waiting, set epoch_delay=0 during pool init.');
      console.log('Proceeding anyway (proof may still work if epoch_delay=0 on devnet)...');
    }
  } else {
    console.log('Note is mature. Proceeding with transfer.');
  }

  // -----------------------------------------------------------------------
  // Step 3: Generate transfer proof (snarkjs)
  // -----------------------------------------------------------------------
  console.log('\n--- Step 3: Generate transfer proof ---');

  const nullifier = poseidon2([receipt.nullifierPreimage, receipt.secret]);

  // Generate new note secrets for the recipient
  const newSecret = randomFieldElement();
  const newNullifierPreimage = randomFieldElement();
  const newDepositEpoch = currentEpoch;
  const newCommitment = poseidon4([
    newNullifierPreimage, newSecret, newDepositEpoch, receipt.tokenMint,
  ]);

  console.log('Nullifier:', nullifier.toString().slice(0, 20) + '...');
  console.log('New commitment:', newCommitment.toString().slice(0, 20) + '...');

  // Circuit inputs (denominated_transfer.circom — 5 public, 8 private)
  const circuitInputs = {
    // Public
    merkle_root: receipt.merkleRoot.toString(),
    nullifier: nullifier.toString(),
    min_epoch: minEpoch.toString(),
    token_mint: receipt.tokenMint.toString(),
    new_commitment: newCommitment.toString(),
    // Private
    secret: receipt.secret.toString(),
    nullifier_preimage: receipt.nullifierPreimage.toString(),
    deposit_epoch: receipt.depositEpoch.toString(),
    path_elements: receipt.merklePathElements.map(e => e.toString()),
    path_indices: receipt.merklePathIndices.map(i => i.toString()),
    new_secret: newSecret.toString(),
    new_nullifier_preimage: newNullifierPreimage.toString(),
    new_deposit_epoch: newDepositEpoch.toString(),
  };

  console.log('Generating Groth16 proof...');
  const wasmPath = 'circuits/build/denominated_transfer_js/denominated_transfer.wasm';
  const zkeyPath = 'circuits/build/denominated_transfer.zkey';

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs, wasmPath, zkeyPath
  );

  console.log('Proof generated! Public signals:');
  publicSignals.forEach((s, i) => console.log(`  [${i}]: ${s.slice(0, 30)}...`));

  // Verify proof locally
  const vkJson = JSON.parse(readFileSync('circuits/build/denominated_transfer_vk.json', 'utf8'));
  const isValid = await snarkjs.groth16.verify(vkJson, publicSignals, proof);
  console.log('Local verification:', isValid ? 'PASS' : 'FAIL');
  if (!isValid) throw new Error('Proof verification failed locally!');

  // -----------------------------------------------------------------------
  // Step 4: Send transfer_denominated transaction
  // -----------------------------------------------------------------------
  console.log('\n--- Step 4: Send transfer_denominated tx ---');

  const proofBytes = proofToOnChainBytes(proof);
  const nullifierBeBytes = bigintToBeBytes32(nullifier);
  const merkleRootLeBytes = bigintToLeBytes32(receipt.merkleRoot);

  // Compute new Merkle root after inserting new commitment
  const treeState2 = await readMerkleTree(treePDA);
  const { newRoot: transferNewRoot } =
    computeNewRootFromSubtrees(newCommitment, treeState2.leafCount, treeState2.filledSubtrees);

  const newCommitmentLeBytes = bigintToLeBytes32(newCommitment);
  const transferNewRootLeBytes = bigintToLeBytes32(transferNewRoot);

  const [nullifierPDA] = deriveNullifierPDA(poolPDA, nullifierBeBytes);
  console.log('Nullifier PDA:', nullifierPDA.toBase58());

  const transferIx = buildTransferDenominatedIx(
    authority.publicKey,
    poolPDA,
    treePDA,
    nullifierPDA,
    vkDataPDA,
    proofBytes,
    Array.from(nullifierBeBytes),
    merkleRootLeBytes,
    minEpoch,
    newCommitmentLeBytes,
    transferNewRootLeBytes,
  );

  // Compute budget IXs
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
  const transferTx = new Transaction().add(computeIx, transferIx);

  const transferSig = await sendAndConfirmTransaction(connection, transferTx, [authority]);
  console.log('Transfer tx:', transferSig);

  // -----------------------------------------------------------------------
  // Step 5: Verify on-chain
  // -----------------------------------------------------------------------
  console.log('\n--- Step 5: Verify on-chain ---');

  // Check nullifier account exists
  const nullifierAccount = await connection.getAccountInfo(nullifierPDA);
  console.log('Nullifier PDA exists:', !!nullifierAccount);

  // Check new leaf count
  const treeState3 = await readMerkleTree(treePDA);
  console.log('New leaf count:', treeState3.leafCount, '(was', treeState2.leafCount, ')');

  // -----------------------------------------------------------------------
  // Step 6: Export shareable note
  // -----------------------------------------------------------------------
  console.log('\n--- Step 6: Shareable note ---');

  const shareableNote = {
    version: 1,
    pool: receipt.pool,
    secret: newSecret.toString(),
    nullifier_preimage: newNullifierPreimage.toString(),
    deposit_epoch: newDepositEpoch.toString(),
    token_mint: receipt.tokenMint.toString(),
    commitment: newCommitment.toString(),
    leafIndex: treeState2.leafCount,
    token: 'SOL',
    denominationHuman: 0.1,
  };

  const encoded = Buffer.from(JSON.stringify(shareableNote)).toString('base64');
  console.log('Shareable note (base64):');
  console.log(encoded.slice(0, 80) + '...');
  console.log(`\nTotal length: ${encoded.length} chars`);

  console.log('\n=== TEST PASSED ===');
  console.log('Shield tx:', shieldSig);
  console.log('Transfer tx:', transferSig);
}

main().catch(err => {
  console.error('\n=== TEST FAILED ===');
  console.error(err);
  process.exit(1);
});
