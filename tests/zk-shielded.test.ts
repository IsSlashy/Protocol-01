/**
 * ZK Shielded Pool - Devnet Tests
 *
 * Tests the zk_shielded program instructions on Solana devnet:
 * 1. initialize_pool - Create a new shielded pool
 * 2. shield - Deposit tokens into the pool
 * 3. transfer - Private transfer within the pool
 * 4. unshield - Withdraw tokens from the pool
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { assert } from 'chai';

// Program ID (deployed on devnet)
const ZK_SHIELDED_PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');

// PDA Seeds
const SEEDS = {
  SHIELDED_POOL: Buffer.from('shielded_pool'),
  MERKLE_TREE: Buffer.from('merkle_tree'),
  NULLIFIER_SET: Buffer.from('nullifier_set'),
};

describe('ZK Shielded Pool', () => {
  // Connection to devnet
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  // Load wallet from keypair file
  let wallet: Wallet;
  let provider: AnchorProvider;
  let payer: Keypair;

  // Test token mint
  let tokenMint: PublicKey;

  // PDAs
  let poolPDA: PublicKey;
  let poolBump: number;
  let merkleTreePDA: PublicKey;
  let merkleTreeBump: number;
  let nullifierSetPDA: PublicKey;
  let nullifierSetBump: number;

  before(async () => {
    // Load payer keypair from file
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const keypairPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

    wallet = new Wallet(payer);
    provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
    });
    anchor.setProvider(provider);

    console.log('='.repeat(60));
    console.log('ZK Shielded Pool - Devnet Test');
    console.log('='.repeat(60));
    console.log(`Payer: ${payer.publicKey.toBase58()}`);

    // Check balance
    const balance = await connection.getBalance(payer.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 0.1 * LAMPORTS_PER_SOL) {
      throw new Error('Insufficient balance for tests. Need at least 0.1 SOL');
    }
  });

  describe('1. Initialize Pool', () => {
    it('should create a test token mint', async () => {
      console.log('\n--- Creating test token mint ---');

      // Create a new token mint for testing
      tokenMint = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        9, // 9 decimals like SOL
      );

      console.log(`Token Mint: ${tokenMint.toBase58()}`);
      assert.ok(tokenMint, 'Token mint should be created');
    });

    it('should derive PDAs correctly', async () => {
      console.log('\n--- Deriving PDAs ---');

      // Derive pool PDA
      [poolPDA, poolBump] = PublicKey.findProgramAddressSync(
        [SEEDS.SHIELDED_POOL, tokenMint.toBytes()],
        ZK_SHIELDED_PROGRAM_ID
      );
      console.log(`Pool PDA: ${poolPDA.toBase58()} (bump: ${poolBump})`);

      // Derive merkle tree PDA
      [merkleTreePDA, merkleTreeBump] = PublicKey.findProgramAddressSync(
        [SEEDS.MERKLE_TREE, poolPDA.toBytes()],
        ZK_SHIELDED_PROGRAM_ID
      );
      console.log(`Merkle Tree PDA: ${merkleTreePDA.toBase58()} (bump: ${merkleTreeBump})`);

      // Derive nullifier set PDA
      [nullifierSetPDA, nullifierSetBump] = PublicKey.findProgramAddressSync(
        [SEEDS.NULLIFIER_SET, poolPDA.toBytes()],
        ZK_SHIELDED_PROGRAM_ID
      );
      console.log(`Nullifier Set PDA: ${nullifierSetPDA.toBase58()} (bump: ${nullifierSetBump})`);

      assert.ok(poolPDA, 'Pool PDA should be derived');
      assert.ok(merkleTreePDA, 'Merkle tree PDA should be derived');
      assert.ok(nullifierSetPDA, 'Nullifier set PDA should be derived');
    });

    it('should initialize a shielded pool', async () => {
      console.log('\n--- Initializing Shielded Pool ---');

      // Create a dummy verification key hash (32 bytes)
      const vkHash = Buffer.alloc(32);
      vkHash.fill(0x42); // Dummy VK hash for testing

      try {
        // Build the instruction manually since we don't have the IDL loaded
        // Discriminator = sha256("global:initialize_pool")[0..8]
        const discriminator = Buffer.from([
          0x5f, 0xb4, 0x0a, 0xac, 0x54, 0xae, 0xe8, 0x28 // initialize_pool discriminator
        ]);

        const data = Buffer.concat([discriminator, vkHash]);

        // Request more compute units for initialization (needs ~500k for merkle tree setup)
        const tx = new anchor.web3.Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
          .add({
          programId: ZK_SHIELDED_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: tokenMint, isSigner: false, isWritable: false },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data,
        });

        const signature = await provider.sendAndConfirm(tx);
        console.log(`Transaction: ${signature}`);
        console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

        // Verify pool was created
        const poolAccount = await connection.getAccountInfo(poolPDA);
        assert.ok(poolAccount, 'Pool account should exist');
        console.log(`Pool account size: ${poolAccount.data.length} bytes`);

      } catch (error: any) {
        console.log('Error:', error.message);
        if (error.logs) {
          console.log('Logs:', error.logs);
        }
        throw error;
      }
    });
  });

  describe('2. Pool State', () => {
    it('should fetch pool state', async () => {
      console.log('\n--- Fetching Pool State ---');

      const poolAccount = await connection.getAccountInfo(poolPDA);
      if (!poolAccount) {
        console.log('Pool not initialized yet');
        return;
      }

      // Parse pool data (simplified)
      const data = poolAccount.data;
      console.log(`Pool data length: ${data.length} bytes`);

      // First 8 bytes are discriminator
      const discriminator = data.slice(0, 8);
      console.log(`Discriminator: ${discriminator.toString('hex')}`);

      // Authority (32 bytes)
      const authority = new PublicKey(data.slice(8, 40));
      console.log(`Authority: ${authority.toBase58()}`);

      // Token mint (32 bytes)
      const mint = new PublicKey(data.slice(40, 72));
      console.log(`Token Mint: ${mint.toBase58()}`);
    });

    it('should fetch merkle tree state', async () => {
      console.log('\n--- Fetching Merkle Tree State ---');

      const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
      if (!merkleAccount) {
        console.log('Merkle tree not initialized yet');
        return;
      }

      console.log(`Merkle tree data length: ${merkleAccount.data.length} bytes`);
    });

    it('should fetch nullifier set state', async () => {
      console.log('\n--- Fetching Nullifier Set State ---');

      const nullifierAccount = await connection.getAccountInfo(nullifierSetPDA);
      if (!nullifierAccount) {
        console.log('Nullifier set not initialized yet');
        return;
      }

      console.log(`Nullifier set data length: ${nullifierAccount.data.length} bytes`);
    });
  });

  describe('3. Shield', () => {
    let userTokenAccount: PublicKey;
    let poolVault: PublicKey;

    it('should create user token account and mint tokens', async () => {
      console.log('\n--- Setting up token accounts for shield test ---');

      // Get or create user's token account
      const userAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        tokenMint,
        payer.publicKey
      );
      userTokenAccount = userAta.address;
      console.log(`User token account: ${userTokenAccount.toBase58()}`);

      // Mint some tokens to the user
      const mintAmount = 1_000_000_000n; // 1 token with 9 decimals
      await mintTo(
        connection,
        payer,
        tokenMint,
        userTokenAccount,
        payer, // mint authority
        mintAmount
      );
      console.log(`Minted ${mintAmount} tokens to user`);

      // Create pool vault (ATA owned by pool PDA)
      const poolVaultAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        tokenMint,
        poolPDA,
        true // allowOwnerOffCurve - required for PDAs
      );
      poolVault = poolVaultAta.address;
      console.log(`Pool vault: ${poolVault.toBase58()}`);

      assert.ok(userTokenAccount, 'User token account should exist');
      assert.ok(poolVault, 'Pool vault should exist');
    });

    it('should shield tokens into the pool', async () => {
      console.log('\n--- Shielding tokens ---');

      const shieldAmount = 100_000_000n; // 0.1 token

      // Create a dummy commitment (in production, this would be Poseidon hash)
      const commitment = Buffer.alloc(32);
      commitment.fill(0x01);
      // Make it unique by adding random bytes
      const randomBytes = Buffer.alloc(8);
      for (let i = 0; i < 8; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
      randomBytes.copy(commitment, 0);

      try {
        // Build the shield instruction
        // Discriminator = sha256("global:shield")[0..8]
        const discriminator = Buffer.from([
          0xdc, 0xc6, 0xfd, 0xf6, 0xe7, 0x54, 0x93, 0x62
        ]);

        // Serialize amount as u64 little-endian
        const amountBuffer = Buffer.alloc(8);
        amountBuffer.writeBigUInt64LE(shieldAmount);

        const data = Buffer.concat([discriminator, amountBuffer, commitment]);

        const tx = new anchor.web3.Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
          .add({
            programId: ZK_SHIELDED_PROGRAM_ID,
            keys: [
              { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // depositor
              { pubkey: poolPDA, isSigner: false, isWritable: true }, // shielded_pool
              { pubkey: merkleTreePDA, isSigner: false, isWritable: true }, // merkle_tree
              { pubkey: userTokenAccount, isSigner: false, isWritable: true }, // user_token_account
              { pubkey: poolVault, isSigner: false, isWritable: true }, // pool_vault
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
            ],
            data,
          });

        const signature = await provider.sendAndConfirm(tx);
        console.log(`Transaction: ${signature}`);
        console.log(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

        // Verify pool state was updated
        const poolAccount = await connection.getAccountInfo(poolPDA);
        assert.ok(poolAccount, 'Pool account should exist');
        console.log('Shield successful!');

      } catch (error: any) {
        console.log('Error:', error.message);
        if (error.logs) {
          console.log('Logs:', error.logs);
        }
        throw error;
      }
    });
  });
});

// Helper to run tests
async function main() {
  console.log('Running ZK Shielded Pool tests on devnet...\n');
}

main().catch(console.error);
