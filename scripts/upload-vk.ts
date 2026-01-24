/**
 * Upload Verification Key to Devnet
 *
 * This script:
 * 1. Converts verification_key.json to on-chain binary format
 * 2. Initializes the VK data account
 * 3. Writes VK data in chunks (to avoid tx size limits)
 * 4. Updates the pool's vk_hash to match
 *
 * Run with: npx tsx scripts/upload-vk.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

// @ts-ignore - CommonJS import
import jsSha3 from 'js-sha3';
const { keccak256 } = jsSha3;

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Program ID
const ZK_SHIELDED_PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');

// For native SOL, token_mint is the System Program ID
const NATIVE_SOL_MINT = SystemProgram.programId;

// PDA seeds
const SHIELDED_POOL_SEED = Buffer.from('shielded_pool');
const VK_DATA_SEED = Buffer.from('vk_data');

// Chunk size for VK data uploads (stay under tx limit)
const CHUNK_SIZE = 700;

/**
 * Convert a decimal string to a 32-byte big-endian buffer
 */
function decimalToBytes32BE(decimal: string): Buffer {
  const hex = BigInt(decimal).toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * Convert a G1 point [x, y, z] to 64 bytes (uncompressed, big-endian)
 */
function g1ToBytes(point: string[]): Buffer {
  const x = decimalToBytes32BE(point[0]);
  const y = decimalToBytes32BE(point[1]);
  return Buffer.concat([x, y]);
}

/**
 * Convert a G2 point [[x1, x2], [y1, y2], [z1, z2]] to 128 bytes
 * G2 uses Fq2 elements, which are pairs of Fq elements
 * Order: [x2, x1, y2, y1] for compatibility with alt_bn128 precompile
 */
function g2ToBytes(point: string[][]): Buffer {
  const x1 = decimalToBytes32BE(point[0][0]);
  const x2 = decimalToBytes32BE(point[0][1]);
  const y1 = decimalToBytes32BE(point[1][0]);
  const y2 = decimalToBytes32BE(point[1][1]);

  // Order for BN254: coefficients in reverse order (c1, c0) for each Fp2 element
  return Buffer.concat([x2, x1, y2, y1]);
}

/**
 * Convert verification_key.json to binary format
 */
function convertVkToBinary(vkJson: any): Buffer {
  const alpha_g1 = g1ToBytes(vkJson.vk_alpha_1);
  const beta_g2 = g2ToBytes(vkJson.vk_beta_2);
  const gamma_g2 = g2ToBytes(vkJson.vk_gamma_2);
  const delta_g2 = g2ToBytes(vkJson.vk_delta_2);

  // IC points
  const icCount = vkJson.IC.length;
  const icCountBuf = Buffer.alloc(4);
  icCountBuf.writeUInt32LE(icCount);

  const icPoints: Buffer[] = [];
  for (const ic of vkJson.IC) {
    icPoints.push(g1ToBytes(ic));
  }

  return Buffer.concat([
    alpha_g1,
    beta_g2,
    gamma_g2,
    delta_g2,
    icCountBuf,
    ...icPoints,
  ]);
}

/**
 * Compute keccak256 hash of VK data
 */
function hashVkData(vkData: Buffer): Buffer {
  const hash = keccak256(vkData);
  return Buffer.from(hash, 'hex');
}

async function main() {
  console.log('===========================================');
  console.log('Upload Verification Key to Devnet');
  console.log('===========================================\n');

  // Connect to devnet
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  console.log('Connected to devnet');

  // Load wallet
  const walletPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  if (!fs.existsSync(walletPath)) {
    console.error('Wallet not found at:', walletPath);
    process.exit(1);
  }

  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const authority = Keypair.fromSecretKey(new Uint8Array(walletData));
  console.log('Authority:', authority.publicKey.toBase58());

  // Check balance
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL');

  if (balance < 0.05 * 1e9) {
    console.log('\n⚠ Low balance. Requesting airdrop...');
    const sig = await connection.requestAirdrop(authority.publicKey, 1e9);
    await connection.confirmTransaction(sig);
    console.log('Airdrop received');
  }

  // Load verification key
  const vkPath = path.join(__dirname, '..', 'circuits', 'build', 'verification_key.json');
  if (!fs.existsSync(vkPath)) {
    console.error('Verification key not found at:', vkPath);
    process.exit(1);
  }

  const vkJson = JSON.parse(fs.readFileSync(vkPath, 'utf-8'));
  console.log('\nVerification key loaded');
  console.log('Protocol:', vkJson.protocol);
  console.log('Curve:', vkJson.curve);
  console.log('Number of public inputs:', vkJson.nPublic);
  console.log('IC points:', vkJson.IC.length);

  // Convert to binary format
  const vkBinary = convertVkToBinary(vkJson);
  console.log('\nVK binary size:', vkBinary.length, 'bytes');

  // Compute hash
  const vkHash = hashVkData(vkBinary);
  console.log('VK hash (keccak256):', vkHash.toString('hex'));

  // Derive PDAs
  const [poolPDA] = PublicKey.findProgramAddressSync(
    [SHIELDED_POOL_SEED, NATIVE_SOL_MINT.toBytes()],
    ZK_SHIELDED_PROGRAM_ID
  );
  console.log('\nShielded Pool PDA:', poolPDA.toBase58());

  const [vkDataPDA] = PublicKey.findProgramAddressSync(
    [VK_DATA_SEED, poolPDA.toBytes()],
    ZK_SHIELDED_PROGRAM_ID
  );
  console.log('VK Data PDA:', vkDataPDA.toBase58());

  // Check if pool exists
  const poolInfo = await connection.getAccountInfo(poolPDA);
  if (!poolInfo) {
    console.error('\n✗ Pool does not exist! Run init-sol-pool.ts first.');
    process.exit(1);
  }
  console.log('\n✓ Pool exists');

  // Read current VK hash from pool
  const VK_HASH_OFFSET = 8 + 32 + 32 + 32 + 1 + 8;
  const currentVkHash = poolInfo.data.slice(VK_HASH_OFFSET, VK_HASH_OFFSET + 32);
  console.log('Current VK hash in pool:', Buffer.from(currentVkHash).toString('hex'));

  // Check if VK data account exists
  const vkDataInfo = await connection.getAccountInfo(vkDataPDA);

  // Step 1: Initialize VK data account if needed
  if (!vkDataInfo || vkDataInfo.data.length !== vkBinary.length) {
    console.log('\nInitializing VK data account...');

    // Build init_vk_data instruction
    const initVkDiscriminator = crypto.createHash('sha256')
      .update('global:init_vk_data')
      .digest()
      .slice(0, 8);

    // vk_size as u32 (little-endian)
    const vkSizeBuf = Buffer.alloc(4);
    vkSizeBuf.writeUInt32LE(vkBinary.length);

    const initVkData = Buffer.concat([initVkDiscriminator, vkSizeBuf]);

    const initVkIx = new TransactionInstruction({
      programId: ZK_SHIELDED_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: false },
        { pubkey: vkDataPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initVkData,
    });

    const initTx = new Transaction().add(initVkIx);
    initTx.feePayer = authority.publicKey;
    initTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    try {
      const signature = await sendAndConfirmTransaction(connection, initTx, [authority], {
        skipPreflight: false,
        commitment: 'confirmed',
      });

      console.log('✓ VK data account initialized');
      console.log('  Signature:', signature);
    } catch (error: any) {
      console.error('✗ Failed to initialize VK data account:', error.message);
      if (error.logs) {
        error.logs.forEach((log: string) => console.log('  ', log));
      }
      process.exit(1);
    }
  } else {
    console.log('\n✓ VK data account exists with correct size');
  }

  // Step 2: Write VK data in chunks
  console.log('\nWriting VK data in chunks...');

  const numChunks = Math.ceil(vkBinary.length / CHUNK_SIZE);
  console.log(`Total chunks: ${numChunks} (${CHUNK_SIZE} bytes each)`);

  for (let i = 0; i < numChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = vkBinary.slice(offset, Math.min(offset + CHUNK_SIZE, vkBinary.length));

    // Build write_vk_data instruction
    const writeVkDiscriminator = crypto.createHash('sha256')
      .update('global:write_vk_data')
      .digest()
      .slice(0, 8);

    // offset as u32 (little-endian)
    const offsetBuf = Buffer.alloc(4);
    offsetBuf.writeUInt32LE(offset);

    // data length as u32 (little-endian, Borsh Vec encoding)
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32LE(chunk.length);

    const writeVkData = Buffer.concat([writeVkDiscriminator, offsetBuf, lengthBuf, chunk]);

    const writeVkIx = new TransactionInstruction({
      programId: ZK_SHIELDED_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolPDA, isSigner: false, isWritable: false },
        { pubkey: vkDataPDA, isSigner: false, isWritable: true },
      ],
      data: writeVkData,
    });

    const writeTx = new Transaction().add(writeVkIx);
    writeTx.feePayer = authority.publicKey;
    writeTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    try {
      const signature = await sendAndConfirmTransaction(connection, writeTx, [authority], {
        skipPreflight: false,
        commitment: 'confirmed',
      });

      console.log(`  Chunk ${i + 1}/${numChunks}: ${chunk.length} bytes at offset ${offset}`);
    } catch (error: any) {
      console.error(`✗ Failed to write chunk ${i + 1}:`, error.message);
      if (error.logs) {
        error.logs.forEach((log: string) => console.log('  ', log));
      }
      process.exit(1);
    }
  }

  console.log('✓ VK data written successfully');

  // Verify the data
  const vkDataAfter = await connection.getAccountInfo(vkDataPDA);
  if (vkDataAfter) {
    const uploadedHash = hashVkData(Buffer.from(vkDataAfter.data));
    console.log('\nUploaded VK hash:', uploadedHash.toString('hex'));
    console.log('Expected VK hash:', vkHash.toString('hex'));
    if (!uploadedHash.equals(vkHash)) {
      console.error('✗ Hash mismatch! Data may be corrupted.');
      process.exit(1);
    }
    console.log('✓ Hash matches');
  }

  // Step 3: Update pool's vk_hash if different
  if (!Buffer.from(currentVkHash).equals(vkHash)) {
    console.log('\nUpdating pool VK hash...');

    const updateVkDiscriminator = crypto.createHash('sha256')
      .update('global:update_verification_key')
      .digest()
      .slice(0, 8);

    const updateVkData = Buffer.concat([updateVkDiscriminator, vkHash]);

    const updateVkIx = new TransactionInstruction({
      programId: ZK_SHIELDED_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
      ],
      data: updateVkData,
    });

    const updateTx = new Transaction().add(updateVkIx);
    updateTx.feePayer = authority.publicKey;
    updateTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    try {
      const signature = await sendAndConfirmTransaction(connection, updateTx, [authority], {
        skipPreflight: false,
        commitment: 'confirmed',
      });

      console.log('✓ VK hash updated in pool');
      console.log('  Signature:', signature);
    } catch (error: any) {
      console.error('✗ Failed to update VK hash:', error.message);
      if (error.logs) {
        error.logs.forEach((log: string) => console.log('  ', log));
      }
      process.exit(1);
    }
  } else {
    console.log('\n✓ Pool VK hash already matches');
  }

  // Final verification
  console.log('\n===========================================');
  console.log('Final Verification');
  console.log('===========================================');

  const finalPoolInfo = await connection.getAccountInfo(poolPDA);
  if (finalPoolInfo) {
    const finalVkHash = finalPoolInfo.data.slice(VK_HASH_OFFSET, VK_HASH_OFFSET + 32);
    console.log('Pool VK hash:', Buffer.from(finalVkHash).toString('hex'));
    console.log('Expected hash:', vkHash.toString('hex'));
    console.log('Match:', Buffer.from(finalVkHash).equals(vkHash) ? '✓ YES' : '✗ NO');
  }

  const finalVkDataInfo = await connection.getAccountInfo(vkDataPDA);
  if (finalVkDataInfo) {
    console.log('\nVK Data account size:', finalVkDataInfo.data.length, 'bytes');
    const finalDataHash = hashVkData(Buffer.from(finalVkDataInfo.data));
    console.log('VK Data hash:', finalDataHash.toString('hex'));
    console.log('Match:', finalDataHash.equals(vkHash) ? '✓ YES' : '✗ NO');
  }

  console.log('\n===========================================');
  console.log('Done! You can now test unshield.');
  console.log('===========================================');
}

main().catch(console.error);
