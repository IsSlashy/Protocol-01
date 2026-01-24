/**
 * Initialize Native SOL Shielded Pool on Devnet
 *
 * This script initializes the shielded pool for native SOL on devnet.
 * Run with: npx ts-node scripts/init-sol-pool.ts
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

// Program ID
const ZK_SHIELDED_PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');

// PDA seeds
const SHIELDED_POOL_SEED = Buffer.from('shielded_pool');
const MERKLE_TREE_SEED = Buffer.from('merkle_tree');
const NULLIFIER_SET_SEED = Buffer.from('nullifier_set');

// For native SOL, token_mint is the System Program ID
const NATIVE_SOL_MINT = SystemProgram.programId;

async function main() {
  console.log('===========================================');
  console.log('Initialize Native SOL Shielded Pool');
  console.log('===========================================\n');

  // Connect to devnet
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  console.log('Connected to devnet');

  // Load wallet from default Solana CLI location
  const walletPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  if (!fs.existsSync(walletPath)) {
    console.error('Wallet not found at:', walletPath);
    console.error('Please run: solana-keygen new');
    process.exit(1);
  }

  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const authority = Keypair.fromSecretKey(new Uint8Array(walletData));
  console.log('Authority:', authority.publicKey.toBase58());

  // Check balance
  const balance = await connection.getBalance(authority.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL');

  if (balance < 0.1 * 1e9) {
    console.error('Insufficient balance. Need at least 0.1 SOL for rent.');
    console.log('Request airdrop: solana airdrop 2 --url devnet');
    process.exit(1);
  }

  // Derive PDAs
  const [poolPDA, poolBump] = PublicKey.findProgramAddressSync(
    [SHIELDED_POOL_SEED, NATIVE_SOL_MINT.toBytes()],
    ZK_SHIELDED_PROGRAM_ID
  );
  console.log('\nShielded Pool PDA:', poolPDA.toBase58());

  const [merkleTreePDA, merkleTreeBump] = PublicKey.findProgramAddressSync(
    [MERKLE_TREE_SEED, poolPDA.toBytes()],
    ZK_SHIELDED_PROGRAM_ID
  );
  console.log('Merkle Tree PDA:', merkleTreePDA.toBase58());

  const [nullifierSetPDA, nullifierSetBump] = PublicKey.findProgramAddressSync(
    [NULLIFIER_SET_SEED, poolPDA.toBytes()],
    ZK_SHIELDED_PROGRAM_ID
  );
  console.log('Nullifier Set PDA:', nullifierSetPDA.toBase58());

  // Check if pool already exists
  const poolInfo = await connection.getAccountInfo(poolPDA);
  if (poolInfo) {
    console.log('\n✓ Pool already initialized!');
    console.log('Pool data size:', poolInfo.data.length, 'bytes');
    console.log('Pool owner:', poolInfo.owner.toBase58());
    return;
  }

  console.log('\nPool does not exist. Initializing...');

  // Build initialize_pool instruction
  // Anchor discriminator for "initialize_pool": sha256("global:initialize_pool")[0..8]
  const discriminator = crypto.createHash('sha256')
    .update('global:initialize_pool')
    .digest()
    .slice(0, 8);

  console.log('Discriminator:', Array.from(discriminator).map((b) => '0x' + (b as number).toString(16).padStart(2, '0')).join(', '));

  // vk_hash - 32 bytes (can be zeros for now, update later)
  const vkHash = Buffer.alloc(32);

  // token_mint - 32 bytes (System Program ID for native SOL)
  const tokenMintBytes = NATIVE_SOL_MINT.toBytes();

  // Instruction data: discriminator + vk_hash + token_mint
  const data = Buffer.concat([
    discriminator,
    vkHash,
    Buffer.from(tokenMintBytes),
  ]);

  console.log('Instruction data length:', data.length, 'bytes');

  const ix = new TransactionInstruction({
    programId: ZK_SHIELDED_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
      { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  console.log('\nSending transaction...');

  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [authority], {
      skipPreflight: false,
      commitment: 'confirmed',
    });

    console.log('\n✓ Pool initialized successfully!');
    console.log('Signature:', signature);
    console.log('Explorer:', `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  } catch (error: any) {
    console.error('\n✗ Transaction failed:', error.message);

    if (error.logs) {
      console.log('\nProgram logs:');
      error.logs.forEach((log: string) => console.log('  ', log));
    }

    // Try to get more details
    if (error.signature) {
      const txInfo = await connection.getTransaction(error.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (txInfo?.meta?.logMessages) {
        console.log('\nTransaction logs:');
        txInfo.meta.logMessages.forEach(log => console.log('  ', log));
      }
    }
  }
}

main().catch(console.error);
