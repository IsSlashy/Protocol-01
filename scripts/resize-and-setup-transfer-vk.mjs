/**
 * Resize denominated pools + Upload transfer VK
 *
 * Steps:
 *   1. Resize all 8 pools from 3680 → 3712 bytes (adds vk_hash_transfer field)
 *   2. Re-upload unshield VK (update_denominated_vk)
 *   3. Upload transfer VK (update_transfer_vk)
 *
 * Usage:
 *   node scripts/resize-and-setup-transfer-vk.mjs
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const NATIVE_SOL_MINT = SystemProgram.programId;
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const SOL_DENOMINATIONS = [
  100_000_000n,       // 0.1 SOL
  1_000_000_000n,     // 1 SOL
  10_000_000_000n,    // 10 SOL
  100_000_000_000n,   // 100 SOL
];

const USDC_DENOMINATIONS = [
  1_000_000n,         // 1 USDC
  10_000_000n,        // 10 USDC
  100_000_000n,       // 100 USDC
  1_000_000_000n,     // 1000 USDC
];

// ---------------------------------------------------------------------------
// Load authority keypair
// ---------------------------------------------------------------------------

const keypairPath = process.env.HOME
  ? `${process.env.HOME}/.config/solana/id.json`
  : `${process.env.USERPROFILE}\\.config\\solana\\id.json`;
const secretKey = JSON.parse(readFileSync(keypairPath, 'utf8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  'confirmed'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function deriveDenominatedPoolPDA(tokenMint, denomination) {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denomination);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('denominated_pool'), tokenMint.toBuffer(), denomBuf],
    ZK_SHIELDED_PROGRAM_ID
  );
}

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

async function computeKeccakHash(data) {
  const sha3 = (await import('js-sha3')).default;
  const keccak_256 = sha3.keccak_256;
  return Buffer.from(keccak_256.array(data));
}

// ---------------------------------------------------------------------------
// All pools
// ---------------------------------------------------------------------------

function getAllPools() {
  const pools = [];
  for (const denom of SOL_DENOMINATIONS) {
    const [pda] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, denom);
    pools.push({ token: 'SOL', mint: NATIVE_SOL_MINT, denomination: denom, pda, label: `${Number(denom) / 1e9} SOL` });
  }
  for (const denom of USDC_DENOMINATIONS) {
    const [pda] = deriveDenominatedPoolPDA(USDC_DEVNET_MINT, denom);
    pools.push({ token: 'USDC', mint: USDC_DEVNET_MINT, denomination: denom, pda, label: `${Number(denom) / 1e6} USDC` });
  }
  return pools;
}

// ---------------------------------------------------------------------------
// Step 1: Resize pools
// ---------------------------------------------------------------------------

async function resizePools(pools) {
  console.log('\n═══ STEP 1: Resize pools ═══\n');

  const disc = getDiscriminator('resize_denominated_pool');

  for (const pool of pools) {
    const info = await connection.getAccountInfo(pool.pda);
    if (!info) {
      console.log(`  ${pool.label}: NOT FOUND — skipping`);
      continue;
    }

    if (info.data.length >= 3712) {
      console.log(`  ${pool.label}: already ${info.data.length} bytes ✓`);
      continue;
    }

    console.log(`  ${pool.label}: ${info.data.length} → 3712 bytes...`);

    const ix = new TransactionInstruction({
      programId: ZK_SHIELDED_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool.pda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: disc,
    });

    try {
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
      console.log(`    Resize tx: ${sig.slice(0, 20)}...`);
    } catch (err) {
      console.error(`    Resize FAILED: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: Update unshield VK hash
// ---------------------------------------------------------------------------

async function updateUnshieldVk(pools) {
  console.log('\n═══ STEP 2: Update unshield VK ═══\n');

  const vkJson = JSON.parse(readFileSync('circuits/build/denominated_pool_vk.json', 'utf8'));
  const vkBinary = vkJsonToBinary(vkJson);
  const vkHash = await computeKeccakHash(vkBinary);
  console.log(`  Unshield VK: ${vkJson.nPublic} inputs, ${vkBinary.length} bytes`);
  console.log(`  Hash (keccak256): ${vkHash.toString('hex').slice(0, 16)}...`);

  const disc = getDiscriminator('update_denominated_vk');

  for (const pool of pools) {
    const info = await connection.getAccountInfo(pool.pda);
    if (!info) { console.log(`  ${pool.label}: NOT FOUND`); continue; }

    const data = Buffer.alloc(8 + 32);
    disc.copy(data, 0);
    vkHash.copy(data, 8);

    const ix = new TransactionInstruction({
      programId: ZK_SHIELDED_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: pool.pda, isSigner: false, isWritable: true },
      ],
      data,
    });

    try {
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
      console.log(`  ${pool.label}: unshield VK updated ✓ (${sig.slice(0, 16)}...)`);
    } catch (err) {
      console.error(`  ${pool.label}: FAILED — ${err.message.slice(0, 80)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: Update transfer VK hash
// ---------------------------------------------------------------------------

async function updateTransferVk(pools) {
  console.log('\n═══ STEP 3: Update transfer VK ═══\n');

  const vkJson = JSON.parse(readFileSync('circuits/build/denominated_transfer_vk.json', 'utf8'));
  const vkBinary = vkJsonToBinary(vkJson);
  const vkHash = await computeKeccakHash(vkBinary);
  console.log(`  Transfer VK: ${vkJson.nPublic} inputs, ${vkBinary.length} bytes`);
  console.log(`  Hash (keccak256): ${vkHash.toString('hex').slice(0, 16)}...`);

  const disc = getDiscriminator('update_transfer_vk');

  for (const pool of pools) {
    const info = await connection.getAccountInfo(pool.pda);
    if (!info) { console.log(`  ${pool.label}: NOT FOUND`); continue; }

    const data = Buffer.alloc(8 + 32);
    disc.copy(data, 0);
    vkHash.copy(data, 8);

    const ix = new TransactionInstruction({
      programId: ZK_SHIELDED_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: pool.pda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    try {
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
      console.log(`  ${pool.label}: transfer VK updated ✓ (${sig.slice(0, 16)}...)`);
    } catch (err) {
      console.error(`  ${pool.label}: FAILED — ${err.message.slice(0, 80)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

async function verify(pools) {
  console.log('\n═══ VERIFICATION ═══\n');

  for (const pool of pools) {
    const info = await connection.getAccountInfo(pool.pda);
    if (!info) { console.log(`  ${pool.label}: NOT FOUND`); continue; }

    const size = info.data.length;
    // vk_hash is at offset 8+32+32+8+8+32+1+8 = 129
    const vkHash = info.data.slice(129, 161);
    // vk_hash_transfer is at end: offset 3680
    const vkHashTransfer = info.data.slice(size - 32, size);

    const vkNonZero = !vkHash.every(b => b === 0);
    const vtNonZero = !vkHashTransfer.every(b => b === 0);

    console.log(`  ${pool.label}: ${size} bytes | vk_hash=${vkNonZero ? '✓' : '✗'} | vk_hash_transfer=${vtNonZero ? '✓' : '✗'}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║  Resize Pools + Setup Transfer VK                    ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log();
  console.log('Authority:', authority.publicKey.toBase58());
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', (balance / 1e9).toFixed(4), 'SOL');

  const pools = getAllPools();
  console.log(`Pools: ${pools.length}`);

  await resizePools(pools);
  await updateUnshieldVk(pools);
  await updateTransferVk(pools);
  await verify(pools);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
