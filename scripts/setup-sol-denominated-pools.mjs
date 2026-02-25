/**
 * Setup Native SOL Denominated Pools on Devnet
 *
 * Creates denominated pools for native SOL with fixed denominations:
 * 0.1, 1, 10, 100 SOL.
 *
 * Native SOL pools do NOT need vault ATAs — the pool PDA holds SOL directly.
 *
 * Prerequisites:
 *   - Authority keypair at ~/.config/solana/id.json
 *   - circuits/build/denominated_pool_vk.json exists
 *   - zk_shielded program deployed to devnet
 *
 * Usage:
 *   node scripts/setup-sol-denominated-pools.mjs [--dry-run]
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
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');

/** Native SOL uses SystemProgram ID as token_mint */
const NATIVE_SOL_MINT = SystemProgram.programId;

/** Pool denominations in SOL (human-readable) */
const DENOMINATIONS_SOL = [0.1, 1, 10, 100];

/** Epoch delay: 1 epoch (~1 hour on Solana) */
const EPOCH_DELAY = 1n;

const DRY_RUN = process.argv.includes('--dry-run');

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
  // EIP-197 order: (x_imag, x_real, y_imag, y_real)
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
// Anchor instruction helpers
// ---------------------------------------------------------------------------

function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function deriveDenominatedPoolPDA(tokenMint, denominationBN) {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denominationBN);
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

function buildInitDenominatedPoolIx(
  authorityKey,
  poolPDA,
  treePDA,
  vkHash,
  tokenMint,
  denomination,
  epochDelay
) {
  const disc = getDiscriminator('init_denominated_pool');

  // Args: vk_hash: [u8;32], token_mint: Pubkey, denomination: u64, epoch_delay: u64
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8);
  disc.copy(data, 0);
  Buffer.from(vkHash).copy(data, 8);
  tokenMint.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(denomination, 72);
  data.writeBigUInt64LE(epochDelay, 80);

  return new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: authorityKey, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: treePDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Setup Native SOL Denominated Pools on Devnet       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log();

  if (DRY_RUN) {
    console.log('*** DRY RUN — no transactions will be sent ***\n');
  }

  console.log('Authority:', authority.publicKey.toBase58());
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', (balance / LAMPORTS_PER_SOL).toFixed(4), 'SOL');
  console.log('Token Mint: SystemProgram (native SOL)');
  console.log();

  // Load and convert denominated pool VK
  const vkJson = JSON.parse(readFileSync('circuits/build/denominated_pool_vk.json', 'utf8'));
  const vkBinary = vkJsonToBinary(vkJson);
  console.log(`VK: ${vkJson.nPublic} public inputs, ${vkJson.IC.length} IC points, ${vkBinary.length} bytes`);

  // Compute VK hash
  let vkHash;
  try {
    const { keccak_256 } = await import('js-sha3');
    vkHash = Buffer.from(keccak_256.array(vkBinary));
  } catch {
    console.log('  Note: js-sha3 not available, using SHA256');
    vkHash = createHash('sha256').update(vkBinary).digest();
  }
  console.log('VK Hash:', vkHash.toString('hex').slice(0, 16) + '...');
  console.log();

  // Process each denomination
  for (const solAmount of DENOMINATIONS_SOL) {
    const lamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    console.log(`─── ${solAmount} SOL Pool (${lamports} lamports) ───`);

    // 1. Derive PDAs
    const [poolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, lamports);
    const [treePDA] = deriveMerkleTreePDA(poolPDA);
    console.log(`  Pool PDA: ${poolPDA.toBase58()}`);
    console.log(`  Tree PDA: ${treePDA.toBase58()}`);

    // 2. Check if pool already exists
    const existingPool = await connection.getAccountInfo(poolPDA);
    if (existingPool) {
      console.log(`  Pool already exists (${existingPool.data.length} bytes). Skipping.`);
    } else if (!DRY_RUN) {
      // 3. Initialize pool (no ATA needed for native SOL)
      console.log('  Initializing pool...');
      const initIx = buildInitDenominatedPoolIx(
        authority.publicKey,
        poolPDA,
        treePDA,
        Array.from(vkHash),
        NATIVE_SOL_MINT,
        lamports,
        EPOCH_DELAY
      );
      const initTx = new Transaction().add(initIx);
      try {
        const sig = await sendAndConfirmTransaction(connection, initTx, [authority]);
        console.log(`  Init tx: ${sig}`);
      } catch (err) {
        console.error(`  Init FAILED: ${err.message}`);
      }
    } else {
      console.log('  [DRY RUN] Would initialize pool');
    }

    // Native SOL: no vault ATA needed
    console.log('  (Native SOL — no vault ATA needed)');
    console.log();
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════');
  console.log('SOL Pools configured:');
  for (const solAmount of DENOMINATIONS_SOL) {
    const lamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    const [poolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, lamports);
    const existingPool = await connection.getAccountInfo(poolPDA);
    const status = existingPool ? 'ACTIVE' : 'NOT FOUND';
    console.log(`  ${solAmount} SOL: ${poolPDA.toBase58().slice(0, 12)}... [${status}]`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
