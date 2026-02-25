/**
 * Setup USDC (devnet) for zkSPL confidential operations.
 *
 * One-time admin script that:
 *   1. Initializes MintConfig PDA for USDC devnet mint
 *   2. Uploads confidential_balance VK (type 0) for USDC
 *   3. Uploads balance_proof VK (type 1) for USDC
 *   4. Creates pool vault token account (ATA for the vault PDA)
 *
 * Usage:
 *   node scripts/setup-usdc-zkspl.mjs
 *
 * Requires:
 *   - Authority keypair at ~/.config/solana/id.json (must match SOL MintConfig authority)
 *   - Sufficient SOL for rent (~0.05 SOL)
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
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';

const PROGRAM_ID = new PublicKey('EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah');
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Load authority keypair
const keypairPath = process.env.HOME
  ? `${process.env.HOME}/.config/solana/id.json`
  : `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = JSON.parse(readFileSync(keypairPath, 'utf8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// -----------------------------------------------------------------------
// VK JSON → binary conversion (matches upload-vk.mjs)
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
  // alt_bn128: (x_imag, x_real, y_imag, y_real)
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

function deriveVaultPDA(tokenMint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('zkspl_vault'), tokenMint.toBuffer()],
    PROGRAM_ID
  );
}

function deriveATA(owner, tokenMint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), tokenMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

// -----------------------------------------------------------------------
// Build instructions
// -----------------------------------------------------------------------

function buildInitializeMintIx(authorityKey, tokenMint, mintConfigKey, balanceVkHash, proofVkHash) {
  const disc = getDiscriminator('initialize_mint');
  // initialize_mint(balance_vk_hash: [u8; 32], proof_vk_hash: [u8; 32])
  const data = Buffer.alloc(8 + 32 + 32);
  disc.copy(data, 0);
  Buffer.from(balanceVkHash).copy(data, 8);
  Buffer.from(proofVkHash).copy(data, 40);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: mintConfigKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildInitVkDataIx(authorityKey, mintConfigKey, vkDataKey, vkType, vkSize) {
  const disc = getDiscriminator('init_vk_data');
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

function buildCreateATAIx(payer, ataAddress, owner, tokenMint) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataAddress, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

// -----------------------------------------------------------------------
// Upload VK helper
// -----------------------------------------------------------------------

async function uploadVk(mintConfigPDA, vkBinary, vkType, vkTypeName) {
  const [vkDataPDA] = deriveVkDataPDA(mintConfigPDA, vkType);
  console.log(`  VK Data PDA (${vkTypeName}):`, vkDataPDA.toBase58());

  // Check if already exists
  const existing = await connection.getAccountInfo(vkDataPDA);
  if (existing) {
    console.log(`  VK data account already exists (size ${existing.data.length}), skipping init.`);
  } else {
    console.log(`  Initializing VK data account (${vkBinary.length} bytes)...`);
    const initIx = buildInitVkDataIx(
      authority.publicKey, mintConfigPDA, vkDataPDA, vkType, vkBinary.length
    );
    const initTx = new Transaction().add(initIx);
    const initSig = await sendAndConfirmTransaction(connection, initTx, [authority]);
    console.log(`  init_vk_data tx: ${initSig}`);
  }

  // Write in chunks
  const CHUNK_SIZE = 800;
  const totalChunks = Math.ceil(vkBinary.length / CHUNK_SIZE);
  console.log(`  Writing ${vkBinary.length} bytes in ${totalChunks} chunks...`);

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const chunk = vkBinary.slice(offset, Math.min(offset + CHUNK_SIZE, vkBinary.length));
    const writeIx = buildWriteVkDataIx(
      authority.publicKey, mintConfigPDA, vkDataPDA, vkType, offset, chunk
    );
    const writeTx = new Transaction().add(writeIx);
    const writeSig = await sendAndConfirmTransaction(connection, writeTx, [authority]);
    console.log(`    Chunk ${i + 1}/${totalChunks}: offset=${offset}, size=${chunk.length}, tx=${writeSig}`);
  }

  // Verify
  const vkAccount = await connection.getAccountInfo(vkDataPDA);
  if (vkAccount) {
    const storedVk = vkAccount.data.slice(12);
    const match = Buffer.compare(Buffer.from(vkBinary), storedVk.slice(0, vkBinary.length)) === 0;
    console.log(`  VK data verification: ${match ? 'PASS' : 'FAIL'}`);
    if (!match) throw new Error(`VK data mismatch for ${vkTypeName}`);
  }
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  console.log('=== zkSPL USDC Devnet Setup ===\n');
  console.log('Authority:', authority.publicKey.toBase58());
  console.log('USDC Mint:', USDC_DEVNET_MINT.toBase58());
  console.log('Program:', PROGRAM_ID.toBase58());

  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL\n');

  if (balance < 0.05 * 1e9) {
    console.error('Insufficient SOL! Need at least 0.05 SOL for rent.');
    process.exit(1);
  }

  // Load VK JSONs and convert to binary
  const balanceVkJson = JSON.parse(readFileSync('circuits/build/confidential_balance_vk.json', 'utf8'));
  const proofVkJson = JSON.parse(readFileSync('circuits/build/balance_proof_vk.json', 'utf8'));
  const balanceVkBinary = vkJsonToBinary(balanceVkJson);
  const proofVkBinary = vkJsonToBinary(proofVkJson);
  console.log('Balance VK binary:', balanceVkBinary.length, 'bytes');
  console.log('Proof VK binary:', proofVkBinary.length, 'bytes');

  // Compute VK hashes (SHA-256 of binary VK data)
  const balanceVkHash = createHash('sha256').update(balanceVkBinary).digest();
  const proofVkHash = createHash('sha256').update(proofVkBinary).digest();
  console.log('Balance VK hash:', balanceVkHash.toString('hex').slice(0, 16) + '...');
  console.log('Proof VK hash:', proofVkHash.toString('hex').slice(0, 16) + '...');

  // Derive PDAs
  const [mintConfigPDA] = deriveMintConfigPDA(USDC_DEVNET_MINT);
  console.log('\nMintConfig PDA:', mintConfigPDA.toBase58());

  // =====================================================================
  // Step 1: Initialize MintConfig for USDC
  // =====================================================================
  console.log('\n--- Step 1: Initialize MintConfig ---');

  const existingConfig = await connection.getAccountInfo(mintConfigPDA);
  if (existingConfig) {
    console.log('MintConfig already exists, skipping initialization.');
  } else {
    const initMintIx = buildInitializeMintIx(
      authority.publicKey,
      USDC_DEVNET_MINT,
      mintConfigPDA,
      balanceVkHash,
      proofVkHash,
    );
    const initMintTx = new Transaction().add(initMintIx);
    const initMintSig = await sendAndConfirmTransaction(connection, initMintTx, [authority]);
    console.log('initialize_mint tx:', initMintSig);
  }

  // =====================================================================
  // Step 2: Upload confidential_balance VK (type 0)
  // =====================================================================
  console.log('\n--- Step 2: Upload Balance VK (type 0) ---');
  await uploadVk(mintConfigPDA, balanceVkBinary, 0, 'balance');

  // =====================================================================
  // Step 3: Upload balance_proof VK (type 1)
  // =====================================================================
  console.log('\n--- Step 3: Upload Proof VK (type 1) ---');
  await uploadVk(mintConfigPDA, proofVkBinary, 1, 'proof');

  // =====================================================================
  // Step 4: Create pool vault token account (ATA for vault PDA)
  // =====================================================================
  console.log('\n--- Step 4: Create Pool Vault Token Account ---');

  const [vaultPDA] = deriveVaultPDA(USDC_DEVNET_MINT);
  const [vaultATA] = deriveATA(vaultPDA, USDC_DEVNET_MINT);
  console.log('Vault PDA:', vaultPDA.toBase58());
  console.log('Vault ATA:', vaultATA.toBase58());

  const existingATA = await connection.getAccountInfo(vaultATA);
  if (existingATA) {
    console.log('Vault ATA already exists, skipping creation.');
  } else {
    const createATAIx = buildCreateATAIx(
      authority.publicKey,
      vaultATA,
      vaultPDA,
      USDC_DEVNET_MINT,
    );
    const createATATx = new Transaction().add(createATAIx);
    const createATASig = await sendAndConfirmTransaction(connection, createATATx, [authority]);
    console.log('create_ata tx:', createATASig);
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.log('\n=== Setup Complete ===');
  console.log('USDC MintConfig:', mintConfigPDA.toBase58());
  console.log('Balance VK (type 0):', deriveVkDataPDA(mintConfigPDA, 0)[0].toBase58());
  console.log('Proof VK (type 1):', deriveVkDataPDA(mintConfigPDA, 1)[0].toBase58());
  console.log('Vault PDA:', vaultPDA.toBase58());
  console.log('Vault ATA:', vaultATA.toBase58());
  console.log('\nUSDC is now ready for zkSPL confidential operations on devnet!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
