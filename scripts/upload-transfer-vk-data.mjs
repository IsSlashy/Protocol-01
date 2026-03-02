/**
 * Upload transfer circuit VK binary data to devnet.
 *
 * Creates and fills VK data accounts using the new
 * init_transfer_vk_data / write_transfer_vk_data instructions.
 * PDA seed: [b"vk_data_transfer", shielded_pool_key]
 *
 * Usage:
 *   node scripts/upload-transfer-vk-data.mjs
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

// Load authority keypair
const keypairPath = process.env.HOME
  ? `${process.env.HOME}/.config/solana/id.json`
  : `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = JSON.parse(readFileSync(keypairPath, 'utf8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// ---------------------------------------------------------------------------
// VK binary conversion
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
// Discriminators + PDA
// ---------------------------------------------------------------------------

function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function deriveShieldedPoolPDA(tokenMint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('shielded_pool'), tokenMint.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

function deriveTransferVkDataPDA(shieldedPoolKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vk_data_transfer'), shieldedPoolKey.toBuffer()],
    ZK_SHIELDED_PROGRAM_ID
  );
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

function buildInitTransferVkDataIx(authorityKey, shieldedPoolKey, vkDataKey, vkSize) {
  const disc = getDiscriminator('init_transfer_vk_data');
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

function buildWriteTransferVkDataIx(authorityKey, shieldedPoolKey, vkDataKey, offset, chunk) {
  const disc = getDiscriminator('write_transfer_vk_data');
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Upload Transfer VK Data ===\n');
  console.log('Authority:', authority.publicKey.toBase58());
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', (balance / LAMPORTS_PER_SOL).toFixed(4), 'SOL\n');

  // Load transfer VK
  const vkJson = JSON.parse(readFileSync('circuits/build/denominated_transfer_vk.json', 'utf8'));
  const vkBinary = vkJsonToBinary(vkJson);
  console.log(`Transfer VK: ${vkJson.nPublic} public inputs, ${vkJson.IC.length} IC points, ${vkBinary.length} bytes`);

  // Compute hash for verification
  let vkHash;
  try {
    const sha3 = (await import('js-sha3')).default;
    vkHash = Buffer.from(sha3.keccak_256.array(vkBinary));
  } catch {
    vkHash = createHash('sha256').update(vkBinary).digest();
  }
  console.log('VK hash:', vkHash.toString('hex').slice(0, 32) + '...\n');

  // Derive PDAs
  const [shieldedPoolPDA] = deriveShieldedPoolPDA(NATIVE_SOL_MINT);
  const [transferVkDataPDA] = deriveTransferVkDataPDA(shieldedPoolPDA);
  console.log('Shielded Pool PDA:', shieldedPoolPDA.toBase58());
  console.log('Transfer VK Data PDA:', transferVkDataPDA.toBase58());

  // Check if account exists
  const existing = await connection.getAccountInfo(transferVkDataPDA);
  if (existing) {
    console.log(`Transfer VK data account exists: ${existing.data.length} bytes`);
    if (existing.data.length === vkBinary.length) {
      console.log('Size matches, will overwrite');
    } else {
      console.log(`Size mismatch (${existing.data.length} vs ${vkBinary.length}), resizing...`);
      const initIx = buildInitTransferVkDataIx(authority.publicKey, shieldedPoolPDA, transferVkDataPDA, vkBinary.length);
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [authority]);
      console.log('Resize tx:', sig);
    }
  } else {
    console.log('Creating transfer VK data account...');
    const initIx = buildInitTransferVkDataIx(authority.publicKey, shieldedPoolPDA, transferVkDataPDA, vkBinary.length);
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [authority]);
    console.log('Init tx:', sig);
  }

  // Write VK data in chunks
  console.log('\nWriting transfer VK data...');
  const CHUNK_SIZE = 800;
  const totalChunks = Math.ceil(vkBinary.length / CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = vkBinary.slice(offset, Math.min(offset + CHUNK_SIZE, vkBinary.length));
    const writeIx = buildWriteTransferVkDataIx(authority.publicKey, shieldedPoolPDA, transferVkDataPDA, offset, chunk);
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(writeIx), [authority]);
    console.log(`  Chunk ${i + 1}/${totalChunks}: offset=${offset}, size=${chunk.length}, tx=${sig.slice(0, 20)}...`);
  }

  // Verify
  console.log('\n--- Verify ---');
  const vkAccount = await connection.getAccountInfo(transferVkDataPDA);
  if (vkAccount) {
    console.log('Account size:', vkAccount.data.length);
    const match = Buffer.compare(Buffer.from(vkBinary), vkAccount.data.slice(0, vkBinary.length)) === 0;
    console.log('VK data matches:', match);
  }

  console.log('\nTransfer VK Data PDA (use this in client):', transferVkDataPDA.toBase58());
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
