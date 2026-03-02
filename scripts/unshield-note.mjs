/**
 * Unshield a denominated pool note.
 *
 * Decodes a shareable note, generates a ZK proof, and sends the
 * unshield_denominated transaction to withdraw funds.
 *
 * Usage:
 *   node scripts/unshield-note.mjs <base64_note> [recipient_pubkey]
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
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const NATIVE_SOL_MINT = SystemProgram.programId;
const TREE_DEPTH = 15;

// Circuit files
const WASM_PATH = 'circuits/build/denominated_pool_js/denominated_pool.wasm';
const ZKEY_PATH = 'circuits/build/denominated_pool_final.zkey';

// ---------------------------------------------------------------------------
// Load authority keypair
// ---------------------------------------------------------------------------

const keypairPath = process.env.HOME
  ? `${process.env.HOME}/.config/solana/id.json`
  : `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = JSON.parse(readFileSync(keypairPath, 'utf8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// ---------------------------------------------------------------------------
// Poseidon
// ---------------------------------------------------------------------------

let poseidon;
const F = { e: (v) => BigInt(v) }; // placeholder, replaced after init

async function initPoseidon() {
  poseidon = await buildPoseidon();
  return poseidon;
}

function poseidonHash(inputs) {
  const hash = poseidon(inputs.map(i => poseidon.F.e(i)));
  return poseidon.F.toObject(hash);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bigintToLeBytes32(n) {
  const bytes = new Uint8Array(32);
  let val = BigInt(n);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xFFn);
    val >>= 8n;
  }
  return bytes;
}

function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function slotToEpoch(slot) {
  return BigInt(Math.floor(slot / 7200));
}

function deriveDenominatedPoolPDA(tokenMint, denomination) {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denomination);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('denominated_pool'), tokenMint.toBuffer(), denomBuf],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveMerkleTreePDA(poolPDA) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('merkle_tree'), poolPDA.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveNullifierPDA(poolPDA, nullifierBytes) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('nullifier'), poolPDA.toBuffer(), Buffer.from(nullifierBytes)],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveShieldedPoolPDA(tokenMint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('shielded_pool'), tokenMint.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveVkDataPDA(shieldedPoolKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vk_data'), shieldedPoolKey.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Merkle tree: compute path from filledSubtrees
// ---------------------------------------------------------------------------

const ZERO_VALUE = 21663839004416932945382355908790599225266501822907911457504978515578255421292n;

function computeZeroHashes(depth) {
  const zeros = [ZERO_VALUE];
  for (let i = 1; i <= depth; i++) {
    zeros.push(poseidonHash([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

function reconstructProofFromSubtrees(leafIndex, subtrees, depth) {
  const zeroHashes = computeZeroHashes(depth);
  const pathElements = [];
  const pathIndices = [];
  let idx = leafIndex;

  for (let level = 0; level < depth; level++) {
    const isRight = idx % 2;
    pathIndices.push(isRight);

    if (isRight === 0) {
      // leaf is on the left; sibling is the zero hash at this level
      pathElements.push(zeroHashes[level]);
    } else {
      // leaf is on the right; sibling is the filled subtree
      pathElements.push(subtrees[level] || zeroHashes[level]);
    }

    idx = Math.floor(idx / 2);
  }

  return { pathElements, pathIndices };
}

function computeMerkleRoot(commitment, pathElements, pathIndices) {
  let current = BigInt(commitment);
  for (let i = 0; i < pathElements.length; i++) {
    if (pathIndices[i] === 0) {
      current = poseidonHash([current, pathElements[i]]);
    } else {
      current = poseidonHash([pathElements[i], current]);
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Parse on-chain tree state
// ---------------------------------------------------------------------------

function parseFilledSubtrees(treeData) {
  const leafCount = Number(treeData.readBigUInt64LE(8 + 32 + 32));
  const depth = treeData[8 + 32 + 32 + 8];
  const vecLen = treeData.readUInt32LE(8 + 32 + 32 + 8 + 1);

  const subtrees = [];
  let offset = 8 + 32 + 32 + 8 + 1 + 4;
  for (let i = 0; i < vecLen; i++) {
    let val = 0n;
    for (let b = 31; b >= 0; b--) {
      val = (val << 8n) | BigInt(treeData[offset + b]);
    }
    subtrees.push(val);
    offset += 32;
  }

  // Read current root
  let rootVal = 0n;
  const rootOffset = 8; // after discriminator
  for (let b = 31; b >= 0; b--) {
    rootVal = (rootVal << 8n) | BigInt(treeData[rootOffset + b]);
  }

  return { leafCount, subtrees, depth, root: rootVal };
}

// ---------------------------------------------------------------------------
// Parse pool info
// ---------------------------------------------------------------------------

function parsePoolInfo(data) {
  let offset = 8; // discriminator
  offset += 32; // authority
  offset += 32; // token_mint
  const denomination = data.readBigUInt64LE(offset); offset += 8;
  const epochDelay = data.readBigUInt64LE(offset); offset += 8;
  offset += 32; // merkle_root
  offset += 1; // tree_depth
  offset += 8; // next_leaf_index
  offset += 32; // vk_hash
  offset += 8; // total_shielded
  offset += 8; // note_count
  offset += 1; // is_active

  // Historical roots Vec
  const vecLen = data.readUInt32LE(offset); offset += 4;
  const historicalRoots = [];
  for (let i = 0; i < vecLen; i++) {
    let val = 0n;
    for (let b = 31; b >= 0; b--) {
      val = (val << 8n) | BigInt(data[offset + b]);
    }
    historicalRoots.push(val);
    offset += 32;
  }

  offset += 1; // max_historical_roots
  offset += 8; // created_at
  offset += 8; // last_tx_at
  offset += 1; // bump
  const matureNoteCount = Number(data.readBigUInt64LE(offset)); offset += 8;

  let dynamicDelay;
  if (matureNoteCount >= 1000) dynamicDelay = 0;
  else if (matureNoteCount >= 100) dynamicDelay = 1;
  else if (matureNoteCount >= 10) dynamicDelay = 1;
  else dynamicDelay = 2;

  return { denomination, epochDelay, historicalRoots, matureNoteCount, dynamicDelay };
}

// ---------------------------------------------------------------------------
// Proof conversion (snarkjs → on-chain bytes)
// ---------------------------------------------------------------------------

function fieldToBytes(str) {
  let n = BigInt(str);
  const b = new Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(n & 0xFFn);
    n >>= 8n;
  }
  return b;
}

function proofToOnChainBytes(proof) {
  const bytes = [];
  // pi_a (G1)
  bytes.push(...fieldToBytes(proof.pi_a[0]));
  bytes.push(...fieldToBytes(proof.pi_a[1]));
  // pi_b (G2) — swap real/imag per EIP-197
  bytes.push(...fieldToBytes(proof.pi_b[0][1])); // x_imag
  bytes.push(...fieldToBytes(proof.pi_b[0][0])); // x_real
  bytes.push(...fieldToBytes(proof.pi_b[1][1])); // y_imag
  bytes.push(...fieldToBytes(proof.pi_b[1][0])); // y_real
  // pi_c (G1)
  bytes.push(...fieldToBytes(proof.pi_c[0]));
  bytes.push(...fieldToBytes(proof.pi_c[1]));
  return bytes;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const noteB64 = process.argv[2];
  const recipientStr = process.argv[3] || authority.publicKey.toBase58();

  if (!noteB64) {
    console.error('Usage: node scripts/unshield-note.mjs <base64_note> [recipient_pubkey]');
    process.exit(1);
  }

  console.log('=== Unshield Denominated Pool Note ===\n');

  // Decode note
  const noteJson = JSON.parse(Buffer.from(noteB64, 'base64').toString('utf8'));
  console.log('Note:', {
    pool: noteJson.pool,
    token: noteJson.token,
    denomination: noteJson.denominationHuman,
    leafIndex: noteJson.leafIndex,
    deposit_epoch: noteJson.deposit_epoch,
  });

  const poolPDA = new PublicKey(noteJson.pool);
  const recipient = new PublicKey(recipientStr);
  console.log('Recipient:', recipient.toBase58());
  console.log('Authority:', authority.publicKey.toBase58());

  // Init Poseidon
  console.log('\nInitializing Poseidon...');
  await initPoseidon();

  // Parse note values
  const secret = BigInt(noteJson.secret);
  const nullifierPreimage = BigInt(noteJson.nullifier_preimage);
  const depositEpoch = BigInt(noteJson.deposit_epoch);
  const tokenMint = BigInt(noteJson.token_mint);
  const commitment = BigInt(noteJson.commitment);
  const leafIndex = noteJson.leafIndex;

  // Verify commitment
  const computedCommitment = poseidonHash([nullifierPreimage, secret, depositEpoch, tokenMint]);
  console.log('Commitment valid:', computedCommitment === commitment);
  if (computedCommitment !== commitment) {
    console.error('COMMITMENT MISMATCH!');
    process.exit(1);
  }

  // Compute nullifier
  const nullifier = poseidonHash([nullifierPreimage, secret]);
  const nullifierBytes = bigintToLeBytes32(nullifier);
  console.log('Nullifier:', nullifier.toString().slice(0, 20) + '...');

  // Check if nullifier already spent
  const [nullifierPDA] = deriveNullifierPDA(poolPDA, nullifierBytes);
  const nullifierAccount = await connection.getAccountInfo(nullifierPDA);
  if (nullifierAccount) {
    console.error('NOTE ALREADY SPENT! Nullifier PDA exists.');
    process.exit(1);
  }
  console.log('Nullifier not spent ✓');

  // Read pool info
  const poolAccount = await connection.getAccountInfo(poolPDA);
  if (!poolAccount) { console.error('Pool not found!'); process.exit(1); }
  const poolInfo = parsePoolInfo(poolAccount.data);
  console.log('Pool denomination:', poolInfo.denomination.toString());
  console.log('Pool epochDelay:', poolInfo.epochDelay.toString());
  console.log('Pool dynamicDelay:', poolInfo.dynamicDelay);
  console.log('Pool matureNoteCount:', poolInfo.matureNoteCount);

  // Read Merkle tree
  const [treePDA] = deriveMerkleTreePDA(poolPDA);
  const treeAccount = await connection.getAccountInfo(treePDA);
  if (!treeAccount) { console.error('Tree not found!'); process.exit(1); }
  const treeState = parseFilledSubtrees(treeAccount.data);
  console.log('Tree leafCount:', treeState.leafCount);
  console.log('Tree depth:', treeState.depth);

  // Compute Merkle proof
  const { pathElements, pathIndices } = reconstructProofFromSubtrees(
    leafIndex, treeState.subtrees, TREE_DEPTH
  );
  const computedRoot = computeMerkleRoot(commitment, pathElements, pathIndices);
  console.log('Computed Merkle root:', computedRoot.toString().slice(0, 20) + '...');

  // Check root is valid (current OR in historical roots)
  // Pool's current merkle_root is at Borsh offset 88 (8+32+32+8+8)
  let poolCurrentRoot = 0n;
  for (let b = 31; b >= 0; b--) {
    poolCurrentRoot = (poolCurrentRoot << 8n) | BigInt(poolAccount.data[88 + b]);
  }
  const rootIsCurrentRoot = computedRoot === poolCurrentRoot;
  const rootInHistorical = poolInfo.historicalRoots.some(r => r === computedRoot);
  const rootValid = rootIsCurrentRoot || rootInHistorical;
  console.log('Root matches current:', rootIsCurrentRoot);
  console.log('Root in historical:', rootInHistorical);
  console.log('Root valid:', rootValid);

  // Compute epochs
  const slot = await connection.getSlot('confirmed');
  const currentEpoch = slotToEpoch(slot);
  const totalDelay = poolInfo.epochDelay + BigInt(poolInfo.dynamicDelay);
  const minEpoch = currentEpoch - totalDelay;
  console.log('\nCurrent epoch:', currentEpoch.toString());
  console.log('Total delay:', totalDelay.toString());
  console.log('min_epoch:', minEpoch.toString());
  console.log('deposit_epoch:', depositEpoch.toString());

  if (depositEpoch > minEpoch) {
    const remaining = Number(depositEpoch - minEpoch);
    const minutesPerEpoch = (7200 * 0.4) / 60; // ~48 min
    console.log(`Note not mature yet. Need ${remaining} more epoch(s) (~${Math.ceil(remaining * minutesPerEpoch)} min).`);
    console.log('Run this script again after the maturity period.');
    process.exit(0);
  }
  console.log('Note maturity ✓');

  // Build circuit inputs
  const circuitInputs = {
    merkle_root: computedRoot.toString(),
    nullifier: nullifier.toString(),
    min_epoch: minEpoch.toString(),
    token_mint: tokenMint.toString(),
    enforce_maturity: '1',
    secret: secret.toString(),
    nullifier_preimage: nullifierPreimage.toString(),
    deposit_epoch: depositEpoch.toString(),
    path_elements: pathElements.map(e => e.toString()),
    path_indices: pathIndices.map(i => i.toString()),
  };

  console.log('\nGenerating ZK proof...');
  const proofStart = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInputs,
    WASM_PATH,
    ZKEY_PATH
  );
  console.log(`Proof generated in ${Date.now() - proofStart}ms`);
  console.log('Public signals:', publicSignals);

  // Verify proof locally
  const vkJson = JSON.parse(readFileSync('circuits/build/denominated_pool_vk.json', 'utf8'));
  const verified = await snarkjs.groth16.verify(vkJson, publicSignals, proof);
  console.log('Proof locally verified:', verified);
  if (!verified) {
    console.error('PROOF VERIFICATION FAILED!');
    process.exit(1);
  }

  // Build on-chain transaction
  console.log('\nBuilding transaction...');
  const proofBytes = proofToOnChainBytes(proof);
  const merkleRootBytes = bigintToLeBytes32(computedRoot);

  // VK data PDA (uses SOL ShieldedPool)
  const [shieldedPoolPDA] = deriveShieldedPoolPDA(NATIVE_SOL_MINT);
  const [vkDataPDA] = deriveVkDataPDA(shieldedPoolPDA);
  console.log('VK Data PDA:', vkDataPDA.toBase58());

  // Build instruction data: disc(8) + proof(256) + nullifier(32) + merkle_root(32) + min_epoch(8)
  const disc = getDiscriminator('unshield_denominated');
  const data = Buffer.alloc(8 + 256 + 32 + 32 + 8);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  Buffer.from(proofBytes).copy(data, offset); offset += 256;
  Buffer.from(Array.from(nullifierBytes)).copy(data, offset); offset += 32;
  Buffer.from(merkleRootBytes).copy(data, offset); offset += 32;
  data.writeBigUInt64LE(minEpoch, offset);

  // Account ordering per IDL: payer, recipient, pool, tree, nullifier_record, vk_data,
  // system_program, token_program (optional), pool_vault (optional), recipient_token_account (optional)
  // Anchor 0.32: optional accounts use the calling program's ID as "None" sentinel
  const keys = [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: poolPDA, isSigner: false, isWritable: true },
    { pubkey: treePDA, isSigner: false, isWritable: false },
    { pubkey: nullifierPDA, isSigner: false, isWritable: true },
    { pubkey: vkDataPDA, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // Optional accounts: program ID = None sentinel for native SOL
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program = None
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // pool_vault = None
    { pubkey: ZK_SHIELDED_PROGRAM_ID, isSigner: false, isWritable: false }, // recipient_token_account = None
  ];

  const ix = new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys,
    data,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }));
  tx.add(ix);

  console.log('Sending transaction...');
  const balanceBefore = await connection.getBalance(recipient);
  const txSig = await sendAndConfirmTransaction(connection, tx, [authority], {
    skipPreflight: false,
    commitment: 'confirmed',
  });
  const balanceAfter = await connection.getBalance(recipient);

  console.log('\n=== SUCCESS ===');
  console.log('Transaction:', txSig);
  console.log('Recipient:', recipient.toBase58());
  console.log('Balance before:', (balanceBefore / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
  console.log('Balance after:', (balanceAfter / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
  console.log('Received:', ((balanceAfter - balanceBefore) / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
}

main().catch(err => {
  console.error('\nError:', err.message || err);
  if (err.logs) console.error('Logs:', err.logs);
  process.exit(1);
});
