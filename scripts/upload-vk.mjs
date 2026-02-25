/**
 * Upload confidential_balance verification key to devnet.
 *
 * Steps:
 *   1. Convert VK JSON to binary format matching parse_vk()
 *   2. Call init_vk_data to create the VK PDA account
 *   3. Call write_vk_data in chunks to upload binary VK data
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

const PROGRAM_ID = new PublicKey('EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah');
const TOKEN_MINT = SystemProgram.programId; // Native SOL

// Load authority keypair
const keypairPath = process.env.HOME
  ? `${process.env.HOME}/.config/solana/id.json`
  : `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = JSON.parse(readFileSync(keypairPath, 'utf8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// -----------------------------------------------------------------------
// VK JSON → binary conversion
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
  // point = [x, y, "1"] — affine G1
  const buf = new Uint8Array(64);
  buf.set(fieldToBytes(point[0]), 0);
  buf.set(fieldToBytes(point[1]), 32);
  return buf;
}

function g2ToBytes(point) {
  // alt_bn128 (EIP-197) expects G2 as: (x_imag, x_real, y_imag, y_real)
  // snarkjs JSON is: [[x_real, x_imag], [y_real, y_imag], ["1","0"]]
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
// Anchor instruction discriminators via SHA-256
// -----------------------------------------------------------------------

function getDiscriminator(name) {
  const hash = createHash('sha256').update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

// -----------------------------------------------------------------------
// PDA derivation
// -----------------------------------------------------------------------

function deriveMintConfigPDA(tokenMint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('zkspl_mint'), tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

function deriveVkDataPDA(mintConfigKey, vkType) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('zkspl_vk'), mintConfigKey.toBuffer(), Buffer.from([vkType])],
    PROGRAM_ID
  );
}

// -----------------------------------------------------------------------
// Build instructions
// -----------------------------------------------------------------------

function buildInitVkDataIx(authorityKey, mintConfigKey, vkDataKey, vkType, vkSize) {
  const disc = getDiscriminator('init_vk_data');
  // init_vk_data(vk_type: u8, vk_size: u32)
  const data = Buffer.alloc(8 + 1 + 4);
  disc.copy(data, 0);
  data.writeUInt8(vkType, 8);
  data.writeUInt32LE(vkSize, 9);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: true },
      { pubkey: mintConfigKey, isSigner: false, isWritable: false },
      { pubkey: vkDataKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildWriteVkDataIx(authorityKey, mintConfigKey, vkDataKey, vkType, offset, chunk) {
  const disc = getDiscriminator('write_vk_data');
  // write_vk_data(vk_type: u8, offset: u32, data: Vec<u8>)
  // Vec<u8> serialized as: 4-byte LE length + bytes
  const data = Buffer.alloc(8 + 1 + 4 + 4 + chunk.length);
  disc.copy(data, 0);
  data.writeUInt8(vkType, 8);
  data.writeUInt32LE(offset, 9);
  data.writeUInt32LE(chunk.length, 13);
  Buffer.from(chunk).copy(data, 17);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: false },
      { pubkey: mintConfigKey, isSigner: false, isWritable: false },
      { pubkey: vkDataKey, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  console.log('Authority:', authority.publicKey.toBase58());
  console.log('Balance:', (await connection.getBalance(authority.publicKey)) / 1e9, 'SOL');

  // Load VK JSON
  const vkJson = JSON.parse(readFileSync('circuits/build/confidential_balance_vk.json', 'utf8'));
  console.log('VK public inputs:', vkJson.nPublic);
  console.log('IC count:', vkJson.IC.length);

  // Convert to binary
  const vkBinary = vkJsonToBinary(vkJson);
  console.log('VK binary size:', vkBinary.length, 'bytes');

  // Derive PDAs
  const [mintConfigPDA] = deriveMintConfigPDA(TOKEN_MINT);
  console.log('MintConfig PDA:', mintConfigPDA.toBase58());

  const VK_TYPE_BALANCE = 0;
  const [vkDataPDA] = deriveVkDataPDA(mintConfigPDA, VK_TYPE_BALANCE);
  console.log('VK Data PDA:', vkDataPDA.toBase58());

  // Check if VK data account already exists
  const existingAccount = await connection.getAccountInfo(vkDataPDA);
  if (existingAccount) {
    console.log('VK data account already exists, size:', existingAccount.data.length);
    console.log('Skipping init, will write data...');
  } else {
    // Step 1: init_vk_data
    console.log('\n--- Step 1: init_vk_data ---');
    const initIx = buildInitVkDataIx(
      authority.publicKey,
      mintConfigPDA,
      vkDataPDA,
      VK_TYPE_BALANCE,
      vkBinary.length
    );

    const initTx = new Transaction().add(initIx);
    const initSig = await sendAndConfirmTransaction(connection, initTx, [authority]);
    console.log('init_vk_data tx:', initSig);
  }

  // Step 2: write_vk_data in chunks
  console.log('\n--- Step 2: write_vk_data ---');
  const CHUNK_SIZE = 800; // Safe chunk size for Solana tx limits
  const totalChunks = Math.ceil(vkBinary.length / CHUNK_SIZE);
  console.log(`Writing ${vkBinary.length} bytes in ${totalChunks} chunks of max ${CHUNK_SIZE} bytes`);

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = vkBinary.slice(offset, Math.min(offset + CHUNK_SIZE, vkBinary.length));

    const writeIx = buildWriteVkDataIx(
      authority.publicKey,
      mintConfigPDA,
      vkDataPDA,
      VK_TYPE_BALANCE,
      offset,
      chunk
    );

    const writeTx = new Transaction().add(writeIx);
    const writeSig = await sendAndConfirmTransaction(connection, writeTx, [authority]);
    console.log(`  Chunk ${i + 1}/${totalChunks}: offset=${offset}, size=${chunk.length}, tx=${writeSig}`);
  }

  // Verify: read back the account data
  console.log('\n--- Verify ---');
  const vkAccount = await connection.getAccountInfo(vkDataPDA);
  if (vkAccount) {
    console.log('VK account size:', vkAccount.data.length);
    // The actual VK data starts at offset 12 (8 disc + 4 size)
    const storedVk = vkAccount.data.slice(12);
    console.log('Stored VK size:', storedVk.length);
    const match = Buffer.compare(Buffer.from(vkBinary), storedVk.slice(0, vkBinary.length)) === 0;
    console.log('VK data matches:', match);
  }

  console.log('\nDone! VK uploaded successfully.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
