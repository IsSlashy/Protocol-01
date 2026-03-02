/**
 * Setup USDC Denominated Pools on Devnet
 *
 * Creates denominated pools for USDC (and optionally other SPL tokens)
 * with fixed denominations: 1, 10, 100, 1000 USDC.
 *
 * Steps per pool:
 *   1. init_denominated_pool(vk_hash, usdc_mint, denomination, epoch_delay)
 *   2. Create pool vault ATA (Associated Token Account for pool PDA)
 *   3. Upload VK data via ShieldedPool's init_vk_data / write_vk_data
 *
 * Prerequisites:
 *   - Authority keypair at ~/.config/solana/id.json
 *   - circuits/build/denominated_pool_vk.json exists
 *   - zk_shielded program deployed to devnet
 *
 * Usage:
 *   node scripts/setup-usdc-denominated-pools.mjs [--dry-run]
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
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');

/** Devnet USDC mint */
const USDC_DEVNET_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const USDC_DECIMALS = 6;

/** Pool denominations in USDC (human-readable) */
const DENOMINATIONS_USDC = [1, 10, 100, 1000];

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
// VK binary conversion (same as upload-vk.mjs)
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

async function hashVkBinary(vkBinary) {
  // Keccak256 via js-sha3 (matches on-chain)
  // Fallback to SHA256 if keccak not available
  try {
    const sha3 = (await import('js-sha3')).default;
    const keccak_256 = sha3.keccak_256;
    return Buffer.from(keccak_256.array(vkBinary));
  } catch {
    // SHA256 fallback (won't match on-chain, but useful for testing)
    return createHash('sha256').update(vkBinary).digest();
  }
}

// ---------------------------------------------------------------------------
// Anchor instruction helpers
// ---------------------------------------------------------------------------

function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

// PDA derivation for denominated pool
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

// ShieldedPool PDA (needed for VK upload)
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
// Build init_denominated_pool instruction
// ---------------------------------------------------------------------------

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
  console.log('║  Setup USDC Denominated Pools on Devnet             ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log();

  if (DRY_RUN) {
    console.log('*** DRY RUN — no transactions will be sent ***\n');
  }

  console.log('Authority:', authority.publicKey.toBase58());
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', (balance / 1e9).toFixed(4), 'SOL');
  console.log('USDC Mint:', USDC_DEVNET_MINT.toBase58());
  console.log();

  // Load and convert denominated pool VK (unshield/emergency circuit)
  const vkJson = JSON.parse(readFileSync('circuits/build/denominated_pool_vk.json', 'utf8'));
  const vkBinary = vkJsonToBinary(vkJson);
  console.log(`Unshield VK: ${vkJson.nPublic} public inputs, ${vkJson.IC.length} IC points, ${vkBinary.length} bytes`);

  // Compute VK hash (keccak256)
  let vkHash;
  try {
    const sha3 = (await import('js-sha3')).default;
    const keccak_256 = sha3.keccak_256;
    vkHash = Buffer.from(keccak_256.array(vkBinary));
  } catch {
    console.log('  Note: js-sha3 not available, using SHA256 (won\'t match on-chain keccak)');
    vkHash = createHash('sha256').update(vkBinary).digest();
  }
  console.log('VK Hash:', vkHash.toString('hex').slice(0, 16) + '...');
  console.log();

  // Process each denomination
  for (const usdcAmount of DENOMINATIONS_USDC) {
    const atomicAmount = BigInt(usdcAmount) * BigInt(10 ** USDC_DECIMALS);
    console.log(`─── ${usdcAmount} USDC Pool (${atomicAmount} atomic) ───`);

    // 1. Derive PDAs
    const [poolPDA, poolBump] = deriveDenominatedPoolPDA(USDC_DEVNET_MINT, atomicAmount);
    const [treePDA] = deriveMerkleTreePDA(poolPDA);
    console.log(`  Pool PDA: ${poolPDA.toBase58()}`);
    console.log(`  Tree PDA: ${treePDA.toBase58()}`);

    // 2. Check if pool already exists
    const existingPool = await connection.getAccountInfo(poolPDA);
    if (existingPool) {
      console.log(`  Pool already exists (${existingPool.data.length} bytes). Skipping init.`);
    } else if (!DRY_RUN) {
      // 3. Initialize pool
      console.log('  Initializing pool...');
      const initIx = buildInitDenominatedPoolIx(
        authority.publicKey,
        poolPDA,
        treePDA,
        Array.from(vkHash),
        USDC_DEVNET_MINT,
        atomicAmount,
        EPOCH_DELAY
      );
      const initTx = new Transaction().add(initIx);
      try {
        const sig = await sendAndConfirmTransaction(connection, initTx, [authority]);
        console.log(`  Init tx: ${sig}`);
      } catch (err) {
        console.error(`  Init FAILED: ${err.message}`);
        continue;
      }
    } else {
      console.log('  [DRY RUN] Would initialize pool');
    }

    // 4. Create pool vault ATA
    const poolVaultATA = await getAssociatedTokenAddress(
      USDC_DEVNET_MINT,
      poolPDA,
      true // allowOwnerOffCurve = true (PDA)
    );
    console.log(`  Vault ATA: ${poolVaultATA.toBase58()}`);

    const existingVault = await connection.getAccountInfo(poolVaultATA);
    if (existingVault) {
      console.log('  Vault ATA already exists. Skipping.');
    } else if (!DRY_RUN) {
      console.log('  Creating vault ATA...');
      const createAtaIx = createAssociatedTokenAccountInstruction(
        authority.publicKey,  // payer
        poolVaultATA,         // ATA address
        poolPDA,              // owner (pool PDA)
        USDC_DEVNET_MINT      // mint
      );
      const ataTx = new Transaction().add(createAtaIx);
      try {
        const sig = await sendAndConfirmTransaction(connection, ataTx, [authority]);
        console.log(`  ATA tx: ${sig}`);
      } catch (err) {
        console.error(`  ATA creation FAILED: ${err.message}`);
      }
    } else {
      console.log('  [DRY RUN] Would create vault ATA');
    }

    console.log();
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════');
  console.log('Pools configured:');
  for (const usdcAmount of DENOMINATIONS_USDC) {
    const atomicAmount = BigInt(usdcAmount) * BigInt(10 ** USDC_DECIMALS);
    const [poolPDA] = deriveDenominatedPoolPDA(USDC_DEVNET_MINT, atomicAmount);
    const existingPool = await connection.getAccountInfo(poolPDA);
    const status = existingPool ? 'ACTIVE' : 'NOT FOUND';
    console.log(`  ${usdcAmount} USDC: ${poolPDA.toBase58().slice(0, 12)}... [${status}]`);
  }
  console.log();
  console.log('Next steps:');
  console.log('  1. Upload VK data for each pool (if needed)');
  console.log('  2. Test shield/unshield with USDC tokens');
  console.log('  3. Fund users with devnet USDC (spl-token mint)');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
