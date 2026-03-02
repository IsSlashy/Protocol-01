/**
 * Update denominated pool VK hashes on devnet.
 *
 * After rebuilding the denominated_pool circuit (4→5 public inputs),
 * existing pools have stale vk_hash. This script:
 *   1. Converts the new VK JSON to binary
 *   2. Uploads VK data to the VK data PDA (init/resize + write chunks)
 *   3. Calls update_denominated_vk on each pool with the new hash
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
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const NATIVE_SOL_MINT = SystemProgram.programId;
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

// Load authority keypair
const keypairPath = process.env.HOME
  ? `${process.env.HOME}/.config/solana/id.json`
  : `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = JSON.parse(readFileSync(keypairPath, 'utf8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// ---------------------------------------------------------------------------
// VK binary conversion (same as setup scripts)
// ---------------------------------------------------------------------------

function fieldToBytes(decimalStr) {
  let n = BigInt(decimalStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xFFn);
    n >>= 8n;
  }
  return bytes;
}

function g1ToBytes(point) {
  const buf = new Uint8Array(64);
  buf.set(fieldToBytes(point[0]), 0);
  buf.set(fieldToBytes(point[1]), 32);
  return buf;
}

function g2ToBytes(point) {
  const buf = new Uint8Array(128);
  buf.set(fieldToBytes(point[0][1]), 0);   // x_imag
  buf.set(fieldToBytes(point[0][0]), 32);  // x_real
  buf.set(fieldToBytes(point[1][1]), 64);  // y_imag
  buf.set(fieldToBytes(point[1][0]), 96);  // y_real
  return buf;
}

function vkJsonToBinary(vkJson) {
  const parts = [];
  parts.push(g1ToBytes(vkJson.vk_alpha_1));
  parts.push(g2ToBytes(vkJson.vk_beta_2));
  parts.push(g2ToBytes(vkJson.vk_gamma_2));
  parts.push(g2ToBytes(vkJson.vk_delta_2));

  const icCount = new Uint8Array(4);
  const count = vkJson.IC.length;
  icCount[0] = count & 0xFF;
  icCount[1] = (count >> 8) & 0xFF;
  icCount[2] = (count >> 16) & 0xFF;
  icCount[3] = (count >> 24) & 0xFF;
  parts.push(icCount);

  for (const ic of vkJson.IC) {
    parts.push(g1ToBytes(ic));
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Anchor discriminators
// ---------------------------------------------------------------------------

function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

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

function deriveDenominatedPoolPDA(tokenMint, denominationBN) {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denominationBN);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('denominated_pool'), tokenMint.toBuffer(), denomBuf],
    ZK_SHIELDED_PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

function buildInitVkDataIx(authorityKey, shieldedPoolKey, vkDataKey, vkSize) {
  const disc = getDiscriminator('init_vk_data');
  const data = Buffer.alloc(8 + 4);
  disc.copy(data, 0);
  data.writeUInt32LE(vkSize, 8);

  return new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: true },
      { pubkey: shieldedPoolKey, isSigner: false, isWritable: false },
      { pubkey: vkDataKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildWriteVkDataIx(authorityKey, shieldedPoolKey, vkDataKey, offset, chunk) {
  const disc = getDiscriminator('write_vk_data');
  const data = Buffer.alloc(8 + 4 + 4 + chunk.length);
  disc.copy(data, 0);
  data.writeUInt32LE(offset, 8);
  data.writeUInt32LE(chunk.length, 12);
  Buffer.from(chunk).copy(data, 16);

  return new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: false },
      { pubkey: shieldedPoolKey, isSigner: false, isWritable: false },
      { pubkey: vkDataKey, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function buildUpdateDenominatedVkIx(authorityKey, poolPDA, newVkHash) {
  const disc = getDiscriminator('update_denominated_vk');
  const data = Buffer.alloc(8 + 32);
  disc.copy(data, 0);
  Buffer.from(newVkHash).copy(data, 8);

  return new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: false },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Update Denominated Pool VK Hashes ===\n');
  console.log('Authority:', authority.publicKey.toBase58());
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', (balance / LAMPORTS_PER_SOL).toFixed(4), 'SOL\n');

  // Load and convert new VK
  const vkJson = JSON.parse(readFileSync('circuits/build/denominated_pool_vk.json', 'utf8'));
  const vkBinary = vkJsonToBinary(vkJson);
  console.log(`New VK: ${vkJson.nPublic} public inputs, ${vkJson.IC.length} IC points, ${vkBinary.length} bytes`);

  // Compute VK hash (keccak256 or sha256 fallback)
  let vkHash;
  try {
    const sha3 = (await import('js-sha3')).default;
    vkHash = Buffer.from(sha3.keccak_256.array(vkBinary));
    console.log('Hash algo: keccak256');
  } catch (e) {
    console.log('js-sha3 import error:', e.message);
    vkHash = createHash('sha256').update(vkBinary).digest();
    console.log('Hash algo: sha256 (js-sha3 not available)');
  }
  console.log('New VK hash:', vkHash.toString('hex').slice(0, 32) + '...\n');

  // Step 1: Upload VK data to the VK data PDA
  // The VK data PDA is derived from the shielded pool PDA for native SOL
  const [shieldedPoolPDA] = deriveShieldedPoolPDA(NATIVE_SOL_MINT);
  const [vkDataPDA] = deriveVkDataPDA(shieldedPoolPDA);
  console.log('Shielded Pool PDA:', shieldedPoolPDA.toBase58());
  console.log('VK Data PDA:', vkDataPDA.toBase58());

  // Check if shielded pool exists (needed for init_vk_data/write_vk_data instructions)
  const shieldedPoolAccount = await connection.getAccountInfo(shieldedPoolPDA);
  if (!shieldedPoolAccount) {
    console.error('ERROR: ShieldedPool for SOL does not exist. Cannot upload VK data via init_vk_data.');
    console.log('The VK data account must already exist or a shielded pool must be initialized first.');
    // We'll try to proceed anyway — maybe the VK data already exists with old data
  }

  // Check current VK data account
  const existingVkAccount = await connection.getAccountInfo(vkDataPDA);
  if (existingVkAccount) {
    console.log(`VK data account exists: ${existingVkAccount.data.length} bytes`);

    if (existingVkAccount.data.length === vkBinary.length) {
      console.log('Size matches, will overwrite with new VK data');
    } else {
      console.log(`Size mismatch: existing=${existingVkAccount.data.length}, new=${vkBinary.length}`);
      // Need to resize via init_vk_data
      if (shieldedPoolAccount) {
        console.log('Resizing VK data account...');
        const initIx = buildInitVkDataIx(authority.publicKey, shieldedPoolPDA, vkDataPDA, vkBinary.length);
        const initTx = new Transaction().add(initIx);
        const initSig = await sendAndConfirmTransaction(connection, initTx, [authority]);
        console.log('Resize tx:', initSig);
      }
    }

    // Write new VK data in chunks
    console.log('\nWriting new VK data...');
    const CHUNK_SIZE = 800;
    const totalChunks = Math.ceil(vkBinary.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const offset = i * CHUNK_SIZE;
      const chunk = vkBinary.slice(offset, Math.min(offset + CHUNK_SIZE, vkBinary.length));
      const writeIx = buildWriteVkDataIx(authority.publicKey, shieldedPoolPDA, vkDataPDA, offset, chunk);
      const writeTx = new Transaction().add(writeIx);
      const writeSig = await sendAndConfirmTransaction(connection, writeTx, [authority]);
      console.log(`  Chunk ${i + 1}/${totalChunks}: offset=${offset}, size=${chunk.length}, tx=${writeSig}`);
    }
    console.log('VK data uploaded successfully!\n');
  } else {
    console.log('VK data account does not exist.');
    if (shieldedPoolAccount) {
      console.log('Creating and uploading VK data...');
      const initIx = buildInitVkDataIx(authority.publicKey, shieldedPoolPDA, vkDataPDA, vkBinary.length);
      const initTx = new Transaction().add(initIx);
      const initSig = await sendAndConfirmTransaction(connection, initTx, [authority]);
      console.log('Init tx:', initSig);

      const CHUNK_SIZE = 800;
      const totalChunks = Math.ceil(vkBinary.length / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const offset = i * CHUNK_SIZE;
        const chunk = vkBinary.slice(offset, Math.min(offset + CHUNK_SIZE, vkBinary.length));
        const writeIx = buildWriteVkDataIx(authority.publicKey, shieldedPoolPDA, vkDataPDA, offset, chunk);
        const writeTx = new Transaction().add(writeIx);
        const writeSig = await sendAndConfirmTransaction(connection, writeTx, [authority]);
        console.log(`  Chunk ${i + 1}/${totalChunks}: offset=${offset}, size=${chunk.length}, tx=${writeSig}`);
      }
      console.log('VK data uploaded successfully!\n');
    } else {
      console.error('Cannot upload VK data — no ShieldedPool exists and no VK data account exists.');
      console.log('Proceeding to update pool hashes anyway (you may need to upload VK data separately).\n');
    }
  }

  // Step 2: Update vk_hash on all denominated pools
  console.log('--- Updating pool VK hashes ---\n');

  // SOL pools
  const SOL_DENOMINATIONS = [0.1, 1, 10, 100];
  for (const solAmount of SOL_DENOMINATIONS) {
    const lamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    const [poolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, lamports);
    const poolAccount = await connection.getAccountInfo(poolPDA);

    if (!poolAccount) {
      console.log(`  ${solAmount} SOL: Pool not found, skipping`);
      continue;
    }

    console.log(`  ${solAmount} SOL (${poolPDA.toBase58().slice(0, 12)}...): updating VK hash...`);
    const ix = buildUpdateDenominatedVkIx(authority.publicKey, poolPDA, Array.from(vkHash));
    const tx = new Transaction().add(ix);
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
      console.log(`    OK: ${sig}`);
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
    }
  }

  // USDC pools
  const USDC_DENOMINATIONS = [1, 10, 100, 1000];
  for (const usdcAmount of USDC_DENOMINATIONS) {
    const atomicAmount = BigInt(usdcAmount) * 1_000_000n; // 6 decimals
    const [poolPDA] = deriveDenominatedPoolPDA(USDC_DEVNET_MINT, atomicAmount);
    const poolAccount = await connection.getAccountInfo(poolPDA);

    if (!poolAccount) {
      console.log(`  ${usdcAmount} USDC: Pool not found, skipping`);
      continue;
    }

    console.log(`  ${usdcAmount} USDC (${poolPDA.toBase58().slice(0, 12)}...): updating VK hash...`);
    const ix = buildUpdateDenominatedVkIx(authority.publicKey, poolPDA, Array.from(vkHash));
    const tx = new Transaction().add(ix);
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
      console.log(`    OK: ${sig}`);
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
    }
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
