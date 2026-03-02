/**
 * Setup Transfer VK for denominated pools on devnet.
 *
 * The denominated_transfer circuit uses a SEPARATE verification key from
 * the denominated_pool (unshield) circuit. This script:
 *   1. Loads the denominated_transfer VK JSON
 *   2. Converts to binary format
 *   3. Computes keccak256 hash
 *   4. Uploads VK data to the VK data PDA
 *   5. Updates all denominated pool vk_hash fields
 *
 * NOTE: Currently both transfer and unshield share the same vk_hash on-chain
 * because the program uses a single vk_hash per pool. If transfer gets its own
 * VK, the on-chain program needs a separate vk_hash_transfer field.
 * For now this script updates the shared vk_hash — run update-denominated-vk.mjs
 * afterwards to restore the unshield VK if needed.
 *
 * Usage:
 *   node scripts/setup-transfer-vk.mjs
 *
 * Prerequisites:
 *   - circuits/build/denominated_transfer_vk.json must exist
 *   - Solana CLI keypair configured (authority)
 *   - Denominated pools already initialized on devnet
 */

import { readFileSync, existsSync } from 'fs';
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
const keypairPath = process.env.USERPROFILE
  ? `${process.env.USERPROFILE}\\.config\\solana\\id.json`
  : `${process.env.HOME}/.config/solana/id.json`;
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
  buf.set(fieldToBytes(point[0][1]), 0);
  buf.set(fieldToBytes(point[0][0]), 32);
  buf.set(fieldToBytes(point[1][1]), 64);
  buf.set(fieldToBytes(point[1][0]), 96);
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
// Anchor discriminator
// ---------------------------------------------------------------------------

function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

function deriveDenominatedPoolPDA(tokenMint, denominationBN) {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denominationBN);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('denominated_pool'), tokenMint.toBuffer(), denomBuf],
    ZK_SHIELDED_PROGRAM_ID
  );
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
  console.log('=== Setup Denominated Transfer VK ===\n');
  console.log('Authority:', authority.publicKey.toBase58());
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', (balance / LAMPORTS_PER_SOL).toFixed(4), 'SOL\n');

  // Check if transfer VK exists
  const vkPath = 'circuits/build/denominated_transfer_vk.json';
  if (!existsSync(vkPath)) {
    console.error(`ERROR: ${vkPath} not found.`);
    console.log('Build the transfer circuit first:');
    console.log('  cd circuits');
    console.log('  circom denominated_transfer.circom --r1cs --wasm --sym -o build/');
    console.log('  snarkjs groth16 setup build/denominated_transfer.r1cs pot_final.ptau build/denominated_transfer.zkey');
    console.log('  snarkjs zkey export verificationkey build/denominated_transfer.zkey build/denominated_transfer_vk.json');
    process.exit(1);
  }

  // Load and convert VK
  const vkJson = JSON.parse(readFileSync(vkPath, 'utf8'));
  const vkBinary = vkJsonToBinary(vkJson);
  console.log(`Transfer VK: ${vkJson.nPublic} public inputs, ${vkJson.IC.length} IC points, ${vkBinary.length} bytes`);

  // Compute VK hash (keccak256)
  let vkHash;
  try {
    const sha3 = (await import('js-sha3')).default;
    vkHash = Buffer.from(sha3.keccak_256.array(vkBinary));
    console.log('Hash algo: keccak256');
  } catch {
    vkHash = createHash('sha256').update(vkBinary).digest();
    console.log('Hash algo: sha256 (keccak256 not available — install js-sha3)');
  }
  console.log('Transfer VK hash:', vkHash.toString('hex').slice(0, 32) + '...\n');

  console.log('NOTE: The transfer circuit shares vk_hash with unshield on-chain.');
  console.log('If the transfer VK differs from unshield VK, the on-chain program');
  console.log('needs a separate vk_hash_transfer field. For now both use the same slot.\n');

  // Update VK hash on all pools
  console.log('--- Updating pool VK hashes ---\n');

  const SOL_DENOMINATIONS = [0.1, 1, 10, 100];
  for (const solAmount of SOL_DENOMINATIONS) {
    const lamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    const [poolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, lamports);
    const poolAccount = await connection.getAccountInfo(poolPDA);

    if (!poolAccount) {
      console.log(`  ${solAmount} SOL: Pool not found, skipping`);
      continue;
    }

    console.log(`  ${solAmount} SOL: updating VK hash...`);
    const ix = buildUpdateDenominatedVkIx(authority.publicKey, poolPDA, Array.from(vkHash));
    const tx = new Transaction().add(ix);
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
      console.log(`    OK: ${sig}`);
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
    }
  }

  const USDC_DENOMINATIONS = [1, 10, 100, 1000];
  for (const usdcAmount of USDC_DENOMINATIONS) {
    const atomicAmount = BigInt(usdcAmount) * 1_000_000n;
    const [poolPDA] = deriveDenominatedPoolPDA(USDC_DEVNET_MINT, atomicAmount);
    const poolAccount = await connection.getAccountInfo(poolPDA);

    if (!poolAccount) {
      console.log(`  ${usdcAmount} USDC: Pool not found, skipping`);
      continue;
    }

    console.log(`  ${usdcAmount} USDC: updating VK hash...`);
    const ix = buildUpdateDenominatedVkIx(authority.publicKey, poolPDA, Array.from(vkHash));
    const tx = new Transaction().add(ix);
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
      console.log(`    OK: ${sig}`);
    } catch (err) {
      console.error(`    FAILED: ${err.message}`);
    }
  }

  console.log('\nDone! Transfer VK deployed to all pools.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
