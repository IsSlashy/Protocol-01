/**
 * Initialize the shielded pool on devnet
 */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';

const PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');
const RPC_URL = 'https://api.devnet.solana.com';

// Seeds for PDAs
const SHIELDED_POOL_SEED = Buffer.from('shielded_pool');
const MERKLE_TREE_SEED = Buffer.from('merkle_tree');
const NULLIFIER_SET_SEED = Buffer.from('nullifier_set');

async function main() {
  console.log('Initializing shielded pool on devnet...');

  // Load keypair from default Solana config
  const keypairPath = process.env.HOME
    ? path.join(process.env.HOME, '.config/solana/id.json')
    : path.join(process.env.USERPROFILE || '', '.config/solana/id.json');

  let keypair: Keypair;
  try {
    const secretKey = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
    keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    console.log('Authority:', keypair.publicKey.toBase58());
  } catch (e) {
    console.error('Failed to load keypair from', keypairPath);
    console.error('Make sure you have a Solana keypair configured');
    process.exit(1);
  }

  const connection = new Connection(RPC_URL, 'confirmed');

  // Check balance
  const balance = await connection.getBalance(keypair.publicKey);
  console.log('Balance:', balance / 1e9, 'SOL');

  if (balance < 0.5 * 1e9) {
    console.error('Insufficient balance. Need at least 0.5 SOL for rent');
    console.log('Run: solana airdrop 2 -u devnet');
    process.exit(1);
  }

  // Native SOL mint = System Program ID
  const tokenMint = SystemProgram.programId;

  // Derive PDAs
  const [shieldedPoolPda] = PublicKey.findProgramAddressSync(
    [SHIELDED_POOL_SEED, tokenMint.toBuffer()],
    PROGRAM_ID
  );
  console.log('Shielded Pool PDA:', shieldedPoolPda.toBase58());

  const [merkleTreePda] = PublicKey.findProgramAddressSync(
    [MERKLE_TREE_SEED, shieldedPoolPda.toBuffer()],
    PROGRAM_ID
  );
  console.log('Merkle Tree PDA:', merkleTreePda.toBase58());

  const [nullifierSetPda] = PublicKey.findProgramAddressSync(
    [NULLIFIER_SET_SEED, shieldedPoolPda.toBuffer()],
    PROGRAM_ID
  );
  console.log('Nullifier Set PDA:', nullifierSetPda.toBase58());

  // Check if pool already exists
  const poolAccount = await connection.getAccountInfo(shieldedPoolPda);
  if (poolAccount) {
    console.log('Pool already initialized!');
    console.log('Pool data length:', poolAccount.data.length);
    return;
  }

  console.log('Pool not found, initializing...');

  // VK hash (32 bytes) - this should match your verification key
  // Using a placeholder for now
  const vkHash = Buffer.alloc(32);

  // Build the instruction data
  // Anchor discriminator for initialize_pool
  const discriminator = Buffer.from([0x52, 0xca, 0xc3, 0x15, 0x8c, 0x2a, 0x97, 0xa0]); // initialize_pool
  const instructionData = Buffer.concat([
    discriminator,
    vkHash,
    tokenMint.toBuffer()
  ]);

  const instruction = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: shieldedPoolPda, isSigner: false, isWritable: true },
      { pubkey: merkleTreePda, isSigner: false, isWritable: true },
      { pubkey: nullifierSetPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  };

  const transaction = new Transaction().add(instruction);

  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [keypair],
      { commitment: 'confirmed' }
    );
    console.log('Pool initialized successfully!');
    console.log('Signature:', signature);
    console.log('Explorer: https://explorer.solana.com/tx/' + signature + '?cluster=devnet');
  } catch (e) {
    console.error('Failed to initialize pool:', e);
  }
}

main().catch(console.error);
