/**
 * ZK Shielded Pool - E2E Test with Valid Proof Generation
 *
 * Tests the complete flow with actual Poseidon hashes and valid ZK proofs:
 * 1. Initialize pool
 * 2. Shield tokens (create note in Merkle tree)
 * 3. Generate valid transfer proof
 */

import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
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
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from '@solana/spl-token';
import { assert } from 'chai';
import * as snarkjs from 'snarkjs';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Program ID (deployed on devnet)
const ZK_SHIELDED_PROGRAM_ID = new PublicKey('8dK17NxQUFPWsLg7eJphiCjSyVfBk2ywC5GU6ctK4qrY');

// PDA Seeds
const SEEDS = {
  SHIELDED_POOL: Buffer.from('shielded_pool'),
  MERKLE_TREE: Buffer.from('merkle_tree'),
  NULLIFIER_SET: Buffer.from('nullifier_set'),
};

// Merkle tree config
const MERKLE_DEPTH = 20;
const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

// Poseidon hasher - initialized asynchronously
let poseidon: any;
let F: any; // Finite field

// Initialize poseidon (called in before hook)
async function initPoseidon() {
  const circomlibjs = await import('circomlibjs');
  poseidon = await circomlibjs.buildPoseidon();
  F = poseidon.F;
}

// Poseidon hash wrapper (matches circuit)
function poseidonHash(inputs: bigint[]): bigint {
  const hash = poseidon(inputs.map(x => F.e(x)));
  return F.toObject(hash);
}

// Compute Anchor discriminator
function computeDiscriminator(name: string): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(`global:${name}`);
  return hash.digest().slice(0, 8);
}

const DISCRIMINATORS = {
  initialize_pool: computeDiscriminator('initialize_pool'),
  shield: computeDiscriminator('shield'),
  transfer: computeDiscriminator('transfer'),
  unshield: computeDiscriminator('unshield'),
};

// Note structure
interface Note {
  amount: bigint;
  ownerPubkey: bigint;
  randomness: bigint;
  tokenMint: bigint;
  commitment: bigint;
}

// Create a shielded note
function createNote(amount: bigint, ownerPubkey: bigint, randomness: bigint, tokenMint: bigint): Note {
  const commitment = poseidonHash([amount, ownerPubkey, randomness, tokenMint]);
  return { amount, ownerPubkey, randomness, tokenMint, commitment };
}

// Derive owner pubkey from spending key (matches circuit)
function deriveOwnerPubkey(spendingKey: bigint): bigint {
  return poseidonHash([spendingKey]);
}

// Compute spending key hash
function computeSpendingKeyHash(spendingKey: bigint): bigint {
  return poseidonHash([spendingKey]);
}

// Compute nullifier (matches circuit)
function computeNullifier(commitment: bigint, spendingKeyHash: bigint): bigint {
  return poseidonHash([commitment, spendingKeyHash]);
}

// Generate empty Merkle tree (using same zero values as circuit)
function generateEmptyTree(depth: number): bigint[] {
  // Zero value = keccak256("specter") mod p
  const ZERO_VALUE = BigInt('21663839004416932945382355908790599225266501822907911457504978515578255421292');
  const nodes: bigint[] = [ZERO_VALUE];

  for (let i = 0; i < depth; i++) {
    nodes.push(poseidonHash([nodes[i], nodes[i]]));
  }

  return nodes;
}

// Simple Merkle tree class for client-side tracking
class ClientMerkleTree {
  depth: number;
  leaves: bigint[] = [];
  zeroValues: bigint[] = [];
  initialized = false;

  constructor(depth: number) {
    this.depth = depth;
  }

  // Initialize with poseidon (must be called after poseidon is ready)
  init() {
    this.zeroValues = generateEmptyTree(this.depth);
    this.initialized = true;
  }

  // Insert a leaf and return the new root
  insert(leaf: bigint): bigint {
    if (!this.initialized) throw new Error('Tree not initialized');
    this.leaves.push(leaf);
    return this.getRoot();
  }

  // Compute current root
  getRoot(): bigint {
    if (!this.initialized) throw new Error('Tree not initialized');
    if (this.leaves.length === 0) {
      return this.zeroValues[this.depth];
    }

    // Build tree from leaves
    let currentLevel = [...this.leaves];

    // Pad to power of 2
    const size = Math.pow(2, this.depth);
    while (currentLevel.length < size) {
      currentLevel.push(this.zeroValues[0]);
    }

    // Build up levels
    for (let level = 0; level < this.depth; level++) {
      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || this.zeroValues[level];
        nextLevel.push(poseidonHash([left, right]));
      }
      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  // Get Merkle proof for a leaf
  getProof(index: number): { pathElements: bigint[], pathIndices: number[] } {
    if (!this.initialized) throw new Error('Tree not initialized');
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    // Build tree from leaves
    let currentLevel = [...this.leaves];
    const size = Math.pow(2, this.depth);
    while (currentLevel.length < size) {
      currentLevel.push(this.zeroValues[0]);
    }

    let currentIndex = index;

    for (let level = 0; level < this.depth; level++) {
      const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
      pathIndices.push(currentIndex % 2);
      pathElements.push(currentLevel[siblingIndex] || this.zeroValues[level]);

      // Build next level
      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || this.zeroValues[level];
        nextLevel.push(poseidonHash([left, right]));
      }
      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
  }
}

// Convert bigint to 32-byte little-endian buffer
function bigintToLeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let val = value;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  return buf;
}

// Convert buffer to field element (mod p)
function bufferToFieldElement(buf: Buffer): bigint {
  let value = BigInt(0);
  for (let i = 0; i < Math.min(buf.length, 31); i++) {
    value |= BigInt(buf[i]) << BigInt(i * 8);
  }
  return value % FIELD_MODULUS;
}

describe('ZK Shielded Pool E2E', () => {
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

  let wallet: Wallet;
  let provider: AnchorProvider;
  let payer: Keypair;

  let tokenMint: PublicKey;
  let poolPDA: PublicKey;
  let merkleTreePDA: PublicKey;
  let nullifierSetPDA: PublicKey;
  let userTokenAccount: PublicKey;
  let poolVault: PublicKey;

  // Circuit paths
  const circuitDir = path.join(__dirname, '..', 'circuits', 'build');
  const wasmPath = path.join(circuitDir, 'transfer_js', 'transfer.wasm');
  const zkeyPath = path.join(circuitDir, 'transfer_final.zkey');
  const vkPath = path.join(circuitDir, 'verification_key.json');

  // Spending key (in production, derive from wallet seed)
  let spendingKey: bigint;
  let ownerPubkey: bigint;
  let spendingKeyHash: bigint;

  // Token mint as field element
  let tokenMintField: bigint;

  // Client-side Merkle tree
  const clientTree = new ClientMerkleTree(MERKLE_DEPTH);

  // Stored notes
  const notes: Note[] = [];

  before(async () => {
    // Initialize poseidon first
    console.log('Initializing Poseidon...');
    await initPoseidon();
    console.log('Poseidon initialized');

    // Initialize Merkle tree
    clientTree.init();

    // Generate spending key and derive owner pubkey
    spendingKey = BigInt('0x' + crypto.randomBytes(31).toString('hex'));
    ownerPubkey = deriveOwnerPubkey(spendingKey);
    spendingKeyHash = computeSpendingKeyHash(spendingKey);

    // Load payer
    const os = await import('os');
    const keypairPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

    wallet = new Wallet(payer);
    provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    anchor.setProvider(provider);

    console.log('='.repeat(60));
    console.log('ZK Shielded Pool E2E Test');
    console.log('='.repeat(60));
    console.log(`Payer: ${payer.publicKey.toBase58()}`);
    console.log(`Spending Key: ${spendingKey.toString().slice(0, 20)}...`);
    console.log(`Owner Pubkey: ${ownerPubkey.toString().slice(0, 20)}...`);

    const balance = await connection.getBalance(payer.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 0.5 * LAMPORTS_PER_SOL) {
      throw new Error('Need at least 0.5 SOL for E2E tests');
    }
  });

  describe('1. Setup', () => {
    it('should create token mint and derive PDAs', async () => {
      console.log('\n--- Creating token mint ---');

      tokenMint = await createMint(connection, payer, payer.publicKey, null, 9);
      console.log(`Token Mint: ${tokenMint.toBase58()}`);

      // Convert to field element
      tokenMintField = bufferToFieldElement(Buffer.from(tokenMint.toBytes()));
      console.log(`Token Mint (field): ${tokenMintField.toString().slice(0, 20)}...`);

      // Derive PDAs
      [poolPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.SHIELDED_POOL, tokenMint.toBytes()],
        ZK_SHIELDED_PROGRAM_ID
      );
      [merkleTreePDA] = PublicKey.findProgramAddressSync(
        [SEEDS.MERKLE_TREE, poolPDA.toBytes()],
        ZK_SHIELDED_PROGRAM_ID
      );
      [nullifierSetPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.NULLIFIER_SET, poolPDA.toBytes()],
        ZK_SHIELDED_PROGRAM_ID
      );

      console.log(`Pool PDA: ${poolPDA.toBase58()}`);
    });

    it('should initialize pool', async () => {
      console.log('\n--- Initializing Pool ---');

      // Load VK and compute hash
      const vkJson = JSON.parse(fs.readFileSync(vkPath, 'utf-8'));
      const vkBytes = Buffer.from(JSON.stringify(vkJson));
      const vkHash = crypto.createHash('sha3-256').update(vkBytes).digest();

      const data = Buffer.concat([DISCRIMINATORS.initialize_pool, vkHash]);

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
      console.log(`Initialize TX: ${signature}`);
    });

    it('should setup token accounts', async () => {
      console.log('\n--- Setting up token accounts ---');

      const userAta = await getOrCreateAssociatedTokenAccount(
        connection, payer, tokenMint, payer.publicKey
      );
      userTokenAccount = userAta.address;

      const poolVaultAta = await getOrCreateAssociatedTokenAccount(
        connection, payer, tokenMint, poolPDA, true
      );
      poolVault = poolVaultAta.address;

      // Mint tokens
      await mintTo(connection, payer, tokenMint, userTokenAccount, payer, 10_000_000_000n);

      console.log(`User Token Account: ${userTokenAccount.toBase58()}`);
      console.log(`Pool Vault: ${poolVault.toBase58()}`);
      console.log(`Minted: 10 tokens`);
    });
  });

  describe('2. Shield Tokens', () => {
    it('should shield 1 token', async () => {
      console.log('\n--- Shielding 1 Token ---');

      const amount = 1_000_000_000n; // 1 token with 9 decimals
      const randomness = BigInt('0x' + crypto.randomBytes(31).toString('hex'));

      // Create note
      const note = createNote(amount, ownerPubkey, randomness, tokenMintField);
      notes.push(note);

      // Add to client tree and get new root
      const newRoot = clientTree.insert(note.commitment);

      console.log(`Note amount: ${amount}`);
      console.log(`Note commitment: ${note.commitment.toString().slice(0, 20)}...`);
      console.log(`New Merkle root: ${newRoot.toString().slice(0, 20)}...`);

      // Convert commitment to bytes
      const commitmentBytes = bigintToLeBytes(note.commitment);
      const newRootBytes = bigintToLeBytes(newRoot);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(amount);

      // Data now includes new_root (computed off-chain since Poseidon syscall not yet enabled)
      const data = Buffer.concat([DISCRIMINATORS.shield, amountBuffer, commitmentBytes, newRootBytes]);

      const tx = new anchor.web3.Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }))
        .add({
          programId: ZK_SHIELDED_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolVault, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data,
        });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Shield TX: ${signature}`);

      // Verify vault balance
      const vaultAccount = await getAccount(connection, poolVault);
      console.log(`Pool vault balance: ${vaultAccount.amount}`);
    });

    it('should shield another 0.5 token', async () => {
      console.log('\n--- Shielding 0.5 Token ---');

      const amount = 500_000_000n; // 0.5 token
      const randomness = BigInt('0x' + crypto.randomBytes(31).toString('hex'));

      // Create note
      const note = createNote(amount, ownerPubkey, randomness, tokenMintField);
      notes.push(note);

      // Add to client tree and get new root
      const newRoot = clientTree.insert(note.commitment);

      const commitmentBytes = bigintToLeBytes(note.commitment);
      const newRootBytes = bigintToLeBytes(newRoot);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(amount);

      // Data now includes new_root
      const data = Buffer.concat([DISCRIMINATORS.shield, amountBuffer, commitmentBytes, newRootBytes]);

      const tx = new anchor.web3.Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }))
        .add({
          programId: ZK_SHIELDED_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolVault, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data,
        });

      const signature = await provider.sendAndConfirm(tx);
      console.log(`Shield TX: ${signature}`);

      console.log(`Total shielded notes: ${notes.length}`);
      console.log(`Client tree root: ${clientTree.getRoot().toString().slice(0, 20)}...`);
    });
  });

  describe('3. Generate Transfer Proof', () => {
    it('should generate a valid ZK proof locally', async function() {
      this.timeout(180000); // 3 minutes for proof generation

      console.log('\n--- Generating Transfer Proof ---');

      // Check circuit files
      if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
        console.log('Circuit files not found, skipping');
        this.skip();
        return;
      }

      // Use the two shielded notes as inputs
      const note1 = notes[0];
      const note2 = notes[1];

      console.log(`Input note 1: ${note1.amount} (index 0)`);
      console.log(`Input note 2: ${note2.amount} (index 1)`);

      // Get Merkle proofs
      const proof1 = clientTree.getProof(0);
      const proof2 = clientTree.getProof(1);
      const merkleRoot = clientTree.getRoot();

      console.log(`Merkle root: ${merkleRoot.toString().slice(0, 20)}...`);

      // Compute nullifiers
      const nullifier1 = computeNullifier(note1.commitment, spendingKeyHash);
      const nullifier2 = computeNullifier(note2.commitment, spendingKeyHash);

      console.log(`Nullifier 1: ${nullifier1.toString().slice(0, 20)}...`);
      console.log(`Nullifier 2: ${nullifier2.toString().slice(0, 20)}...`);

      // Create output notes
      // Transfer 1 token to a "recipient" (different pubkey)
      // Return 0.5 token as change to self
      const recipientPubkey = BigInt('0x' + crypto.randomBytes(31).toString('hex'));
      const outRandomness1 = BigInt('0x' + crypto.randomBytes(31).toString('hex'));
      const outRandomness2 = BigInt('0x' + crypto.randomBytes(31).toString('hex'));

      const outNote1 = createNote(1_000_000_000n, recipientPubkey, outRandomness1, tokenMintField);
      const outNote2 = createNote(500_000_000n, ownerPubkey, outRandomness2, tokenMintField);

      console.log(`Output note 1: ${outNote1.amount} to recipient`);
      console.log(`Output note 2: ${outNote2.amount} change to self`);

      // Value conservation check
      const totalIn = note1.amount + note2.amount;
      const totalOut = outNote1.amount + outNote2.amount;
      console.log(`Value conservation: ${totalIn} in = ${totalOut} out`);
      assert.equal(totalIn, totalOut, 'Value must be conserved');

      // Prepare circuit inputs
      const circuitInputs = {
        // Public inputs
        merkle_root: merkleRoot.toString(),
        nullifier_1: nullifier1.toString(),
        nullifier_2: nullifier2.toString(),
        output_commitment_1: outNote1.commitment.toString(),
        output_commitment_2: outNote2.commitment.toString(),
        public_amount: '0', // Private transfer (no public in/out)
        token_mint: tokenMintField.toString(),

        // Private inputs - Note 1
        in_amount_1: note1.amount.toString(),
        in_owner_pubkey_1: ownerPubkey.toString(),
        in_randomness_1: note1.randomness.toString(),
        in_path_indices_1: proof1.pathIndices.map(x => x.toString()),
        in_path_elements_1: proof1.pathElements.map(x => x.toString()),

        // Private inputs - Note 2
        in_amount_2: note2.amount.toString(),
        in_owner_pubkey_2: ownerPubkey.toString(),
        in_randomness_2: note2.randomness.toString(),
        in_path_indices_2: proof2.pathIndices.map(x => x.toString()),
        in_path_elements_2: proof2.pathElements.map(x => x.toString()),

        // Output notes
        out_amount_1: outNote1.amount.toString(),
        out_recipient_1: recipientPubkey.toString(),
        out_randomness_1: outRandomness1.toString(),
        out_amount_2: outNote2.amount.toString(),
        out_recipient_2: ownerPubkey.toString(),
        out_randomness_2: outRandomness2.toString(),

        // Spending key
        spending_key: spendingKey.toString()
      };

      console.log('\nGenerating proof...');
      const startTime = Date.now();

      try {
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          circuitInputs,
          wasmPath,
          zkeyPath
        );

        const duration = (Date.now() - startTime) / 1000;
        console.log(`Proof generated in ${duration.toFixed(2)}s`);

        // Log public signals
        console.log('\nPublic signals:');
        console.log(`  merkle_root: ${publicSignals[0].slice(0, 20)}...`);
        console.log(`  nullifier_1: ${publicSignals[1].slice(0, 20)}...`);
        console.log(`  nullifier_2: ${publicSignals[2].slice(0, 20)}...`);
        console.log(`  output_commitment_1: ${publicSignals[3].slice(0, 20)}...`);
        console.log(`  output_commitment_2: ${publicSignals[4].slice(0, 20)}...`);
        console.log(`  public_amount: ${publicSignals[5]}`);
        console.log(`  token_mint: ${publicSignals[6].slice(0, 20)}...`);

        // Verify proof locally
        console.log('\nVerifying proof locally...');
        const vk = JSON.parse(fs.readFileSync(vkPath, 'utf-8'));
        const isValid = await snarkjs.groth16.verify(vk, publicSignals, proof);

        console.log(`Proof valid: ${isValid}`);
        assert.ok(isValid, 'Proof should be valid');

        // Save proof for on-chain verification
        const proofData = {
          proof,
          publicSignals,
          outNote1: {
            amount: outNote1.amount.toString(),
            ownerPubkey: outNote1.ownerPubkey.toString(),
            randomness: outNote1.randomness.toString(),
            commitment: outNote1.commitment.toString()
          },
          outNote2: {
            amount: outNote2.amount.toString(),
            ownerPubkey: outNote2.ownerPubkey.toString(),
            randomness: outNote2.randomness.toString(),
            commitment: outNote2.commitment.toString()
          }
        };
        fs.writeFileSync(
          path.join(circuitDir, 'last_proof.json'),
          JSON.stringify(proofData, null, 2)
        );
        console.log('\nProof saved to circuits/build/last_proof.json');

      } catch (error: any) {
        console.error('Proof generation failed:', error.message);
        throw error;
      }
    });
  });
});

async function main() {
  console.log('Running ZK E2E tests...\n');
}

main().catch(console.error);
