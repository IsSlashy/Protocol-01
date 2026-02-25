/**
 * Create a recipient wallet with a zkSPL confidential account for testing transfers.
 * Generates a keypair, airdrops SOL, and creates the on-chain confidential account.
 */

import { readFileSync, writeFileSync } from 'fs';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';

const PROGRAM_ID = new PublicKey('EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah');
const TOKEN_MINT = SystemProgram.programId; // Native SOL
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------------
// Poseidon
// ---------------------------------------------------------------------------
let poseidon;
async function getPoseidon() {
  if (!poseidon) {
    const { buildPoseidon } = await import('circomlibjs');
    poseidon = await buildPoseidon();
  }
  return poseidon;
}

async function poseidonHash(inputs) {
  const p = await getPoseidon();
  const hash = p(inputs.map(i => BigInt(i)));
  return p.F.toObject(hash);
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------
function bytesToField(bytes) {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result % FIELD_MODULUS;
}

function fieldToBytes(field) {
  const bytes = new Uint8Array(32);
  let value = field;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function pubkeyToField(pubkeyBytes) {
  return bytesToField(pubkeyBytes);
}

function randomSalt() {
  const bytes = new Uint8Array(31);
  for (let i = 0; i < 31; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytesToField(bytes);
}

// ---------------------------------------------------------------------------
// Anchor instruction helpers
// ---------------------------------------------------------------------------
function anchorDiscriminator(name) {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  // 1. Generate new keypair
  const recipient = Keypair.generate();
  console.log('=== Recipient Wallet Created ===');
  console.log('  Address:', recipient.publicKey.toBase58());
  console.log('  Secret key (base58):', Buffer.from(recipient.secretKey).toString('base64').slice(0, 20) + '...');

  // Save keypair for later use
  writeFileSync('scripts/recipient-keypair.json', JSON.stringify(Array.from(recipient.secretKey)));
  console.log('  Keypair saved to scripts/recipient-keypair.json');

  // 2. Airdrop SOL
  console.log('\nAirdropping 0.5 SOL...');
  try {
    const sig = await connection.requestAirdrop(recipient.publicKey, 0.5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
    console.log('  Airdrop confirmed:', sig);
  } catch (err) {
    console.log('  Airdrop failed (rate limited), trying smaller amount...');
    try {
      const sig = await connection.requestAirdrop(recipient.publicKey, 0.1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log('  Airdrop confirmed:', sig);
    } catch (err2) {
      console.log('  Airdrop failed again. Will try to fund from deployer wallet.');
      // Try funding from the deployer keypair
      try {
        const deployerKeyJson = readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8');
        const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(deployerKeyJson)));
        const deployerBalance = await connection.getBalance(deployer.publicKey);
        console.log(`  Deployer (${deployer.publicKey.toBase58()}) balance: ${deployerBalance / LAMPORTS_PER_SOL} SOL`);

        if (deployerBalance > 0.1 * LAMPORTS_PER_SOL) {
          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: deployer.publicKey,
              toPubkey: recipient.publicKey,
              lamports: Math.floor(0.05 * LAMPORTS_PER_SOL),
            })
          );
          const sig = await sendAndConfirmTransaction(connection, tx, [deployer]);
          console.log('  Funded from deployer:', sig);
        }
      } catch (e) {
        console.error('  Could not fund from deployer:', e.message);
      }
    }
  }

  const balance = await connection.getBalance(recipient.publicKey);
  console.log(`  Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    console.error('  Not enough SOL to create account. Airdrop manually and re-run.');
    return;
  }

  // 3. Derive spending key and create initial commitment
  const spendingKey = poseidonHash([bytesToField(recipient.secretKey.slice(0, 32))]);
  const ownerPubkey = await poseidonHash([await spendingKey]);
  const tokenMintField = pubkeyToField(TOKEN_MINT.toBytes());

  const salt = randomSalt();
  const initialCommitment = await poseidonHash([0n, salt, ownerPubkey, tokenMintField]);
  const commitmentBytes = fieldToBytes(initialCommitment);

  console.log('\n=== Confidential Account ===');
  console.log('  Spending key:', (await spendingKey).toString().slice(0, 30) + '...');
  console.log('  Owner pubkey:', ownerPubkey.toString().slice(0, 30) + '...');
  console.log('  Initial commitment:', initialCommitment.toString().slice(0, 30) + '...');

  // 4. Derive PDAs
  const [mintConfigPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('zkspl_mint'), TOKEN_MINT.toBuffer()],
    PROGRAM_ID
  );
  const [confAccountPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('zkspl_account'), recipient.publicKey.toBuffer(), TOKEN_MINT.toBuffer()],
    PROGRAM_ID
  );

  console.log('  MintConfig PDA:', mintConfigPDA.toBase58());
  console.log('  ConfAccount PDA:', confAccountPDA.toBase58());

  // 5. Build create_account instruction
  const discriminator = anchorDiscriminator('create_account');
  const data = Buffer.concat([
    Buffer.from(discriminator),
    Buffer.from(commitmentBytes), // initial_commitment: [u8; 32]
  ]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: recipient.publicKey, isSigner: true, isWritable: true },
      { pubkey: mintConfigPDA, isSigner: false, isWritable: false },
      { pubkey: confAccountPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  // 6. Send transaction
  console.log('\nCreating confidential account on-chain...');
  try {
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [recipient]);
    console.log('  Account created! Signature:', sig);
  } catch (err) {
    if (err.message?.includes('already in use')) {
      console.log('  Account already exists on-chain');
    } else {
      console.error('  Error:', err.message);
      // Show logs if available
      if (err.logs) {
        console.error('  Logs:', err.logs);
      }
      return;
    }
  }

  // 7. Verify account exists
  const accountInfo = await connection.getAccountInfo(confAccountPDA);
  if (accountInfo) {
    const commitment = accountInfo.data.slice(72, 104);
    const nonce = accountInfo.data.readBigUInt64LE(104);
    console.log('\n=== Account Verified On-Chain ===');
    console.log('  Commitment:', Buffer.from(commitment).toString('hex'));
    console.log('  Nonce:', nonce.toString());
  }

  console.log('\n========================================');
  console.log('RECIPIENT READY FOR TRANSFER');
  console.log('========================================');
  console.log(`\n  Address: ${recipient.publicKey.toBase58()}`);
  console.log('\n  Send a confidential transfer to this address from the mobile app!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
