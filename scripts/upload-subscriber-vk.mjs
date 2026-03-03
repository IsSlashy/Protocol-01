/**
 * Upload subscriber_ownership verification key to devnet.
 *
 * Steps:
 *   1. Convert VK JSON to binary format matching Groth16Verifier::parse_vk()
 *   2. Call init_subscriber_vk_data to create the VK PDA account
 *   3. Call write_subscriber_vk_data in chunks to upload binary VK data
 *
 * Usage:
 *   node scripts/upload-subscriber-vk.mjs
 *
 * Requires:
 *   cd circuits && npm run build:subowner
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
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');

// Load authority keypair
const keypairPath = process.env.HOME
  ? `${process.env.HOME}/.config/solana/id.json`
  : `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = JSON.parse(readFileSync(keypairPath, 'utf8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  'confirmed'
);

// -----------------------------------------------------------------------
// VK JSON → binary conversion (reused from upload-vk.mjs)
// -----------------------------------------------------------------------

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
  // alt_bn128 (EIP-197) order: (x_imag, x_real, y_imag, y_real)
  // snarkjs JSON: [[x_real, x_imag], [y_real, y_imag], ["1","0"]]
  const buf = new Uint8Array(128);
  buf.set(fieldToBytes(point[0][1]), 0);   // x_imag
  buf.set(fieldToBytes(point[0][0]), 32);  // x_real
  buf.set(fieldToBytes(point[1][1]), 64);  // y_imag
  buf.set(fieldToBytes(point[1][0]), 96);  // y_real
  return buf;
}

function vkJsonToBinary(vkJson) {
  const parts = [];

  parts.push(g1ToBytes(vkJson.vk_alpha_1));    // 64
  parts.push(g2ToBytes(vkJson.vk_beta_2));      // 128
  parts.push(g2ToBytes(vkJson.vk_gamma_2));     // 128
  parts.push(g2ToBytes(vkJson.vk_delta_2));     // 128

  // IC count as u32 LE
  const icCount = new Uint8Array(4);
  const count = vkJson.IC.length;
  icCount[0] = count & 0xFF;
  icCount[1] = (count >> 8) & 0xFF;
  icCount[2] = (count >> 16) & 0xFF;
  icCount[3] = (count >> 24) & 0xFF;
  parts.push(icCount);                           // 4

  // IC points
  for (const ic of vkJson.IC) {
    parts.push(g1ToBytes(ic));                   // 64 each
  }

  // Concatenate
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

// -----------------------------------------------------------------------
// Anchor instruction discriminators
// -----------------------------------------------------------------------

function getDiscriminator(name) {
  const hash = createHash('sha256').update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

// -----------------------------------------------------------------------
// PDA derivation
// -----------------------------------------------------------------------

function deriveSubscriberVkPDA(authorityKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vk_data_subscriber'), authorityKey.toBuffer()],
    PROGRAM_ID
  );
}

// -----------------------------------------------------------------------
// Build instructions
// -----------------------------------------------------------------------

function buildInitSubscriberVkDataIx(authorityKey, vkDataKey, vkSize) {
  const disc = getDiscriminator('init_subscriber_vk_data');
  // init_subscriber_vk_data(vk_size: u32)
  const data = Buffer.alloc(8 + 4);
  disc.copy(data, 0);
  data.writeUInt32LE(vkSize, 8);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: true },
      { pubkey: vkDataKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildWriteSubscriberVkDataIx(authorityKey, vkDataKey, offset, chunk) {
  const disc = getDiscriminator('write_subscriber_vk_data');
  // write_subscriber_vk_data(offset: u32, data: Vec<u8>)
  const data = Buffer.alloc(8 + 4 + 4 + chunk.length);
  disc.copy(data, 0);
  data.writeUInt32LE(offset, 8);
  data.writeUInt32LE(chunk.length, 12);
  Buffer.from(chunk).copy(data, 16);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: false },
      { pubkey: vkDataKey, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  console.log('=== Upload Subscriber Ownership VK ===\n');
  console.log('Program:', PROGRAM_ID.toBase58());
  console.log('Authority:', authority.publicKey.toBase58());
  console.log('Balance:', (await connection.getBalance(authority.publicKey)) / 1e9, 'SOL');

  // Load VK JSON
  const vkPath = 'circuits/build/subscriber_ownership_vk.json';
  const vkJson = JSON.parse(readFileSync(vkPath, 'utf8'));
  console.log('\nVK file:', vkPath);
  console.log('Protocol:', vkJson.protocol);
  console.log('Public inputs:', vkJson.nPublic);
  console.log('IC count:', vkJson.IC.length);

  // Convert to binary
  const vkBinary = vkJsonToBinary(vkJson);
  console.log('VK binary size:', vkBinary.length, 'bytes');

  // Compute VK hash (keccak256)
  const vkHash = createHash('sha3-256').update(Buffer.from(vkBinary)).digest();
  console.log('VK hash (keccak256):', vkHash.toString('hex'));

  // Derive PDA
  const [vkDataPDA] = deriveSubscriberVkPDA(authority.publicKey);
  console.log('VK Data PDA:', vkDataPDA.toBase58());

  // Check if account already exists
  const existingAccount = await connection.getAccountInfo(vkDataPDA);
  if (existingAccount) {
    console.log('\nVK data account already exists, size:', existingAccount.data.length);
    console.log('Will overwrite with new data...');
  } else {
    // Step 1: init_subscriber_vk_data
    console.log('\n--- Step 1: init_subscriber_vk_data ---');
    const initIx = buildInitSubscriberVkDataIx(
      authority.publicKey,
      vkDataPDA,
      vkBinary.length
    );

    const initTx = new Transaction().add(initIx);
    const initSig = await sendAndConfirmTransaction(connection, initTx, [authority]);
    console.log('init_subscriber_vk_data tx:', initSig);
  }

  // Step 2: write_subscriber_vk_data in chunks
  console.log('\n--- Step 2: write_subscriber_vk_data ---');
  const CHUNK_SIZE = 800;
  const totalChunks = Math.ceil(vkBinary.length / CHUNK_SIZE);
  console.log(`Writing ${vkBinary.length} bytes in ${totalChunks} chunks`);

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = vkBinary.slice(offset, Math.min(offset + CHUNK_SIZE, vkBinary.length));

    const writeIx = buildWriteSubscriberVkDataIx(
      authority.publicKey,
      vkDataPDA,
      offset,
      chunk
    );

    const writeTx = new Transaction().add(writeIx);
    const writeSig = await sendAndConfirmTransaction(connection, writeTx, [authority]);
    console.log(`  Chunk ${i + 1}/${totalChunks}: offset=${offset}, size=${chunk.length}, tx=${writeSig}`);
  }

  // Verify
  console.log('\n--- Verify ---');
  const vkAccount = await connection.getAccountInfo(vkDataPDA);
  if (vkAccount) {
    console.log('VK account size:', vkAccount.data.length);
    const match = Buffer.compare(Buffer.from(vkBinary), vkAccount.data.slice(0, vkBinary.length)) === 0;
    console.log('VK data matches:', match);
  }

  console.log('\n=== VK hash for on-chain vaults ===');
  console.log('Use this vk_hash_subscriber when creating subscription vaults:');
  console.log(`  ${JSON.stringify(Array.from(vkHash))}`);
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
