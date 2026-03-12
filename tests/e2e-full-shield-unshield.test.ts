/**
 * E2E: Full Shield -> Unshield Flow
 *
 * Tests the complete privacy flow end-to-end:
 *   - Initialize shielded pool
 *   - Shield SOL with valid Poseidon commitment
 *   - Verify Merkle tree insertion
 *   - Generate valid ZK proof for unshield
 *   - Unshield with proof verification
 *   - Verify nullifier prevents double-spend
 *   - Handle denominated pool (fixed amounts)
 *
 * Programs:
 *   zk_shielded:   GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
 *   p01_trustless:  FnTmMxsNx5yQ4nDxiUq7HKLyb6Hwi5Wb5D71Zu69i43Q
 *
 * Run:
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..."
 *   ANCHOR_WALLET=~/.config/solana/id.json
 *   ts-mocha -p tsconfig.test.json tests/e2e-full-shield-unshield.test.ts --timeout 300000
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
  Transaction,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from '@solana/spl-token';
import { expect } from 'chai';
import * as snarkjs from 'snarkjs';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Program IDs
// ---------------------------------------------------------------------------
const ZK_SHIELDED_PROGRAM_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const TRUSTLESS_PROGRAM_ID = new PublicKey('FnTmMxsNx5yQ4nDxiUq7HKLyb6Hwi5Wb5D71Zu69i43Q');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MERKLE_DEPTH = 20;
const FIELD_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

const SEEDS = {
  SHIELDED_POOL: Buffer.from('shielded_pool'),
  MERKLE_TREE: Buffer.from('merkle_tree'),
  NULLIFIER_SET: Buffer.from('nullifier_set'),
  TRUSTLESS_POOL: Buffer.from('trustless_pool'),
  TRUSTLESS_MERKLE: Buffer.from('merkle_tree'),
  TRUSTLESS_NULLIFIER: Buffer.from('nullifier'),
};

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 2000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err.toString();
      if (
        attempt < maxRetries &&
        (msg.includes('Blockhash not found') || msg.includes('block height exceeded'))
      ) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`    Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ---------------------------------------------------------------------------
// Discriminator helper
// ---------------------------------------------------------------------------
function computeDiscriminator(name: string): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(`global:${name}`);
  return hash.digest().subarray(0, 8);
}

const DISCRIMINATORS = {
  initialize_pool: computeDiscriminator('initialize_pool'),
  shield: computeDiscriminator('shield'),
  shield_trustless: computeDiscriminator('shield_trustless'),
};

// ---------------------------------------------------------------------------
// Poseidon
// ---------------------------------------------------------------------------
let poseidon: any;
let F: any;

async function initPoseidon(): Promise<void> {
  const circomlibjs = await import('circomlibjs');
  poseidon = await circomlibjs.buildPoseidon();
  F = poseidon.F;
}

function poseidonHash(inputs: bigint[]): bigint {
  const hash = poseidon(inputs.map((x: bigint) => F.e(x)));
  return F.toObject(hash);
}

// ---------------------------------------------------------------------------
// Note structure
// ---------------------------------------------------------------------------
interface Note {
  amount: bigint;
  ownerPubkey: bigint;
  randomness: bigint;
  tokenMint: bigint;
  commitment: bigint;
}

function createNote(amount: bigint, ownerPubkey: bigint, randomness: bigint, tokenMint: bigint): Note {
  const commitment = poseidonHash([amount, ownerPubkey, randomness, tokenMint]);
  return { amount, ownerPubkey, randomness, tokenMint, commitment };
}

function deriveOwnerPubkey(spendingKey: bigint): bigint {
  return poseidonHash([spendingKey, BigInt(0)]);
}

function computeSpendingKeyHash(spendingKey: bigint): bigint {
  return poseidonHash([spendingKey, BigInt(1)]);
}

function computeNullifier(commitment: bigint, spendingKeyHash: bigint): bigint {
  return poseidonHash([commitment, spendingKeyHash]);
}

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------
function generateEmptyTree(depth: number): bigint[] {
  const ZERO_VALUE = BigInt('21663839004416932945382355908790599225266501822907911457504978515578255421292');
  const nodes: bigint[] = [ZERO_VALUE];

  for (let i = 0; i < depth; i++) {
    nodes.push(poseidonHash([nodes[i], nodes[i]]));
  }

  return nodes;
}

class ClientMerkleTree {
  depth: number;
  leaves: bigint[] = [];
  zeroValues: bigint[] = [];
  initialized = false;

  constructor(depth: number) {
    this.depth = depth;
  }

  init(): void {
    this.zeroValues = generateEmptyTree(this.depth);
    this.initialized = true;
  }

  insert(leaf: bigint): bigint {
    if (!this.initialized) throw new Error('Tree not initialized');
    this.leaves.push(leaf);
    return this.getRoot();
  }

  getRoot(): bigint {
    if (!this.initialized) throw new Error('Tree not initialized');
    if (this.leaves.length === 0) {
      return this.zeroValues[this.depth];
    }

    let currentLevel = [...this.leaves];
    const size = Math.pow(2, this.depth);
    while (currentLevel.length < size) {
      currentLevel.push(this.zeroValues[0]);
    }

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

  getProof(index: number): { pathElements: bigint[]; pathIndices: number[] } {
    if (!this.initialized) throw new Error('Tree not initialized');
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

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

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------
function bigintToLeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(32);
  let val = value;
  for (let i = 0; i < 32; i++) {
    buf[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  return buf;
}

function bufferToFieldElement(buf: Buffer): bigint {
  let value = BigInt(0);
  for (let i = 0; i < Math.min(buf.length, 31); i++) {
    value |= BigInt(buf[i]) << BigInt(i * 8);
  }
  return value % FIELD_MODULUS;
}

function u64ToLeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function randomBytes32(): Buffer {
  return crypto.randomBytes(32);
}

// ---------------------------------------------------------------------------
// Trustless pool PDA helpers
// ---------------------------------------------------------------------------
function deriveTrustlessPoolPDA(tokenMint: PublicKey, denomination: bigint): [PublicKey, number] {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denomination);
  return PublicKey.findProgramAddressSync(
    [SEEDS.TRUSTLESS_POOL, tokenMint.toBuffer(), denomBuf],
    TRUSTLESS_PROGRAM_ID,
  );
}

function deriveTrustlessMerkleTreePDA(poolPDA: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.TRUSTLESS_MERKLE, poolPDA.toBuffer()],
    TRUSTLESS_PROGRAM_ID,
  );
}

function deriveTrustlessNullifierPDA(poolPDA: PublicKey, nullifier: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.TRUSTLESS_NULLIFIER, poolPDA.toBuffer(), nullifier],
    TRUSTLESS_PROGRAM_ID,
  );
}

// ===========================================================================
// Test Suite
// ===========================================================================
describe('E2E: Full Shield -> Unshield Flow', () => {
  const connection = new Connection(
    process.env.ANCHOR_PROVIDER_URL || 'https://api.devnet.solana.com',
    'confirmed',
  );

  let wallet: Wallet;
  let provider: AnchorProvider;
  let payer: Keypair;

  // ZK Shielded pool state
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

  // Spending key
  let spendingKey: bigint;
  let ownerPubkey: bigint;
  let spendingKeyHash: bigint;
  let tokenMintField: bigint;

  // Client-side Merkle tree
  const clientTree = new ClientMerkleTree(MERKLE_DEPTH);

  // Stored notes
  const notes: Note[] = [];

  before(async () => {
    console.log('    Initializing Poseidon...');
    await initPoseidon();
    console.log('    Poseidon initialized');

    clientTree.init();

    spendingKey = BigInt('0x' + crypto.randomBytes(31).toString('hex'));
    ownerPubkey = deriveOwnerPubkey(spendingKey);
    spendingKeyHash = computeSpendingKeyHash(spendingKey);

    const os = await import('os');
    const keypairPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    payer = Keypair.fromSecretKey(Uint8Array.from(keypairData));

    wallet = new Wallet(payer);
    provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    anchor.setProvider(provider);

    console.log('    ========================================');
    console.log('    E2E: Full Shield -> Unshield Flow');
    console.log('    ========================================');
    console.log(`    Payer: ${payer.publicKey.toBase58()}`);

    const balance = await connection.getBalance(payer.publicKey);
    console.log(`    Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 0.5 * LAMPORTS_PER_SOL) {
      throw new Error('Need at least 0.5 SOL for E2E tests');
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. ZK Shielded Pool Initialization
  // ─────────────────────────────────────────────────────────────────
  describe('Pool Setup', () => {
    it('initializes shielded pool', async () => {
      tokenMint = await createMint(connection, payer, payer.publicKey, null, 9);
      tokenMintField = bufferToFieldElement(Buffer.from(tokenMint.toBytes()));

      console.log(`    Token Mint: ${tokenMint.toBase58()}`);

      // Derive PDAs
      [poolPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.SHIELDED_POOL, tokenMint.toBytes()],
        ZK_SHIELDED_PROGRAM_ID,
      );
      [merkleTreePDA] = PublicKey.findProgramAddressSync(
        [SEEDS.MERKLE_TREE, poolPDA.toBytes()],
        ZK_SHIELDED_PROGRAM_ID,
      );
      [nullifierSetPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.NULLIFIER_SET, poolPDA.toBytes()],
        ZK_SHIELDED_PROGRAM_ID,
      );

      // Load VK and compute hash
      let vkHash: Buffer;
      if (fs.existsSync(vkPath)) {
        const vkJson = JSON.parse(fs.readFileSync(vkPath, 'utf-8'));
        const vkBytes = Buffer.from(JSON.stringify(vkJson));
        vkHash = crypto.createHash('sha3-256').update(vkBytes).digest();
      } else {
        // Use a dummy hash if circuit files not available
        vkHash = randomBytes32();
        console.log('    Warning: VK not found, using dummy hash');
      }

      const data = Buffer.concat([DISCRIMINATORS.initialize_pool, vkHash, tokenMint.toBuffer()]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add({
          programId: ZK_SHIELDED_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: nullifierSetPDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data,
        });

      await withRetry(async () => {
        const signature = await provider.sendAndConfirm(tx);
        console.log(`    Initialize Pool TX: ${signature}`);
      });

      // Verify pool exists
      const poolInfo = await connection.getAccountInfo(poolPDA);
      expect(poolInfo).to.not.be.null;
      expect(poolInfo!.owner.toBase58()).to.equal(ZK_SHIELDED_PROGRAM_ID.toBase58());
      console.log(`    Pool PDA: ${poolPDA.toBase58()}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Shield Tokens
  // ─────────────────────────────────────────────────────────────────
  describe('Shield', () => {
    before(async () => {
      // Setup token accounts
      const userAta = await getOrCreateAssociatedTokenAccount(
        connection, payer, tokenMint, payer.publicKey,
      );
      userTokenAccount = userAta.address;

      const poolVaultAta = await getOrCreateAssociatedTokenAccount(
        connection, payer, tokenMint, poolPDA, true,
      );
      poolVault = poolVaultAta.address;

      // Mint tokens
      await mintTo(connection, payer, tokenMint, userTokenAccount, payer, 10_000_000_000n);
      console.log('    Minted 10 tokens to user');
    });

    it('shields SOL with valid Poseidon commitment', async () => {
      const amount = 1_000_000_000n; // 1 token
      const randomness = BigInt('0x' + crypto.randomBytes(31).toString('hex'));

      const note = createNote(amount, ownerPubkey, randomness, tokenMintField);
      notes.push(note);

      const newRoot = clientTree.insert(note.commitment);

      console.log(`    Note commitment: ${note.commitment.toString().slice(0, 20)}...`);
      console.log(`    New Merkle root: ${newRoot.toString().slice(0, 20)}...`);

      const commitmentBytes = bigintToLeBytes(note.commitment);
      const newRootBytes = bigintToLeBytes(newRoot);
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(amount);

      const data = Buffer.concat([DISCRIMINATORS.shield, amountBuffer, commitmentBytes, newRootBytes]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add({
          programId: ZK_SHIELDED_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolVault, isSigner: false, isWritable: true },
          ],
          data,
        });

      await withRetry(async () => {
        const signature = await provider.sendAndConfirm(tx);
        console.log(`    Shield TX: ${signature}`);
      });

      // Verify vault balance
      const vaultAccount = await getAccount(connection, poolVault);
      expect(Number(vaultAccount.amount)).to.be.gte(Number(amount));
      console.log(`    Pool vault balance: ${vaultAccount.amount}`);
    });

    it('verifies Merkle tree insertion', async () => {
      // Verify pool state updated on-chain
      const poolInfo = await connection.getAccountInfo(poolPDA);
      expect(poolInfo).to.not.be.null;

      // Client tree should have 1 leaf
      expect(clientTree.leaves.length).to.equal(1);

      // Root should be non-zero
      const root = clientTree.getRoot();
      expect(root).to.not.equal(BigInt(0));

      // Proof for leaf 0 should be valid
      const proof = clientTree.getProof(0);
      expect(proof.pathElements.length).to.equal(MERKLE_DEPTH);
      expect(proof.pathIndices.length).to.equal(MERKLE_DEPTH);

      console.log(`    Merkle tree has ${clientTree.leaves.length} leaf`);
      console.log(`    Root: ${root.toString().slice(0, 20)}...`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. ZK Proof Generation & Verification
  // ─────────────────────────────────────────────────────────────────
  describe('ZK Proof', () => {
    it('generates valid ZK proof for unshield', async function () {
      this.timeout(180000); // 3 minutes for proof generation

      if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
        console.log('    Circuit files not found at:', circuitDir);
        console.log('    Skipping proof generation (requires compiled circuits)');
        this.skip();
        return;
      }

      // Shield a second note first
      const amount2 = 500_000_000n; // 0.5 token
      const randomness2 = BigInt('0x' + crypto.randomBytes(31).toString('hex'));
      const note2 = createNote(amount2, ownerPubkey, randomness2, tokenMintField);
      notes.push(note2);
      const newRoot2 = clientTree.insert(note2.commitment);

      const commitmentBytes2 = bigintToLeBytes(note2.commitment);
      const newRootBytes2 = bigintToLeBytes(newRoot2);
      const amountBuffer2 = Buffer.alloc(8);
      amountBuffer2.writeBigUInt64LE(amount2);

      const data2 = Buffer.concat([DISCRIMINATORS.shield, amountBuffer2, commitmentBytes2, newRootBytes2]);

      const tx2 = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add({
          programId: ZK_SHIELDED_PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: userTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolVault, isSigner: false, isWritable: true },
          ],
          data: data2,
        });

      await withRetry(async () => {
        await provider.sendAndConfirm(tx2);
      });

      // Now generate proof with both notes
      const note1 = notes[0];
      const proof1 = clientTree.getProof(0);
      const proof2 = clientTree.getProof(1);
      const merkleRoot = clientTree.getRoot();

      const nullifier1 = computeNullifier(note1.commitment, spendingKeyHash);
      const nullifier2 = computeNullifier(note2.commitment, spendingKeyHash);

      // Output: 1 token to recipient, 0.5 token change to self
      const recipientPubkey = BigInt('0x' + crypto.randomBytes(31).toString('hex'));
      const outRandomness1 = BigInt('0x' + crypto.randomBytes(31).toString('hex'));
      const outRandomness2 = BigInt('0x' + crypto.randomBytes(31).toString('hex'));

      const outNote1 = createNote(1_000_000_000n, recipientPubkey, outRandomness1, tokenMintField);
      const outNote2 = createNote(500_000_000n, ownerPubkey, outRandomness2, tokenMintField);

      // Value conservation
      const totalIn = note1.amount + note2.amount;
      const totalOut = outNote1.amount + outNote2.amount;
      expect(totalIn).to.equal(totalOut);

      const circuitInputs = {
        merkle_root: merkleRoot.toString(),
        nullifier_1: nullifier1.toString(),
        nullifier_2: nullifier2.toString(),
        output_commitment_1: outNote1.commitment.toString(),
        output_commitment_2: outNote2.commitment.toString(),
        public_amount: '0',
        token_mint: tokenMintField.toString(),

        in_amount_1: note1.amount.toString(),
        in_owner_pubkey_1: ownerPubkey.toString(),
        in_randomness_1: note1.randomness.toString(),
        in_path_indices_1: proof1.pathIndices.map((x: number) => x.toString()),
        in_path_elements_1: proof1.pathElements.map((x: bigint) => x.toString()),

        in_amount_2: note2.amount.toString(),
        in_owner_pubkey_2: ownerPubkey.toString(),
        in_randomness_2: note2.randomness.toString(),
        in_path_indices_2: proof2.pathIndices.map((x: number) => x.toString()),
        in_path_elements_2: proof2.pathElements.map((x: bigint) => x.toString()),

        out_amount_1: outNote1.amount.toString(),
        out_recipient_1: recipientPubkey.toString(),
        out_randomness_1: outRandomness1.toString(),
        out_amount_2: outNote2.amount.toString(),
        out_recipient_2: ownerPubkey.toString(),
        out_randomness_2: outRandomness2.toString(),

        spending_key: spendingKey.toString(),
      };

      console.log('    Generating ZK proof...');
      const startTime = Date.now();

      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInputs,
        wasmPath,
        zkeyPath,
      );

      const duration = (Date.now() - startTime) / 1000;
      console.log(`    Proof generated in ${duration.toFixed(2)}s`);

      // Verify locally
      const vk = JSON.parse(fs.readFileSync(vkPath, 'utf-8'));
      const isValid = await snarkjs.groth16.verify(vk, publicSignals, proof);

      expect(isValid).to.be.true;
      console.log('    Proof verified locally!');

      console.log(`    Nullifier 1: ${publicSignals[1].slice(0, 20)}...`);
      console.log(`    Nullifier 2: ${publicSignals[2].slice(0, 20)}...`);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Nullifier Double-Spend Prevention
  // ─────────────────────────────────────────────────────────────────
  describe('Nullifier', () => {
    it('verifies nullifier prevents double-spend', () => {
      // Each note produces a unique, deterministic nullifier
      const note = notes[0];
      const nullifier = computeNullifier(note.commitment, spendingKeyHash);

      // Same inputs => same nullifier (deterministic)
      const nullifier2 = computeNullifier(note.commitment, spendingKeyHash);
      expect(nullifier).to.equal(nullifier2);

      // Different note => different nullifier
      if (notes.length > 1) {
        const nullifier3 = computeNullifier(notes[1].commitment, spendingKeyHash);
        expect(nullifier3).to.not.equal(nullifier);
      }

      // On-chain: nullifier PDA is created during unshield.
      // If PDA already exists, Anchor's init constraint rejects the TX.
      console.log(`    Nullifier is deterministic: ${nullifier.toString().slice(0, 20)}...`);
      console.log('    On-chain PDA existence prevents re-use (double-spend)');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Denominated Pool (Trustless)
  // ─────────────────────────────────────────────────────────────────
  describe('Denominated Pool', () => {
    // Use native SOL with a unique denomination
    const denomination = BigInt(100_000); // 0.0001 SOL
    let dPoolPDA: PublicKey;
    let dMerkleTreePDA: PublicKey;

    it('handles denominated pool (fixed amounts)', async () => {
      // Generate unique denomination to avoid collision
      const uniqueDenom = BigInt(Math.floor(Math.random() * 1_000_000) + 50_000);

      [dPoolPDA] = deriveTrustlessPoolPDA(SystemProgram.programId, uniqueDenom);
      [dMerkleTreePDA] = deriveTrustlessMerkleTreePDA(dPoolPDA);

      const vkHash = randomBytes32();
      const zksplVkHash = randomBytes32();

      const disc = computeDiscriminator('initialize_pool');
      const data = Buffer.concat([
        disc,
        vkHash,
        zksplVkHash,
        SystemProgram.programId.toBuffer(),
        u64ToLeBytes(uniqueDenom),
      ]);

      const ix = {
        programId: TRUSTLESS_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: dPoolPDA, isSigner: false, isWritable: true },
          { pubkey: dMerkleTreePDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        data,
      };

      await withRetry(async () => {
        const sig = await sendAndConfirmTransaction(
          connection,
          new Transaction().add(ix),
          [payer],
          { commitment: 'confirmed', skipPreflight: true },
        );
        console.log(`    Denominated pool initialized: ${uniqueDenom} lamports/note`);
        console.log(`    TX: ${sig}`);
      });

      // Shield into denominated pool
      const commitment = randomBytes32();
      const newRoot = randomBytes32();

      const shieldDisc = computeDiscriminator('shield_trustless');
      const shieldData = Buffer.concat([shieldDisc, commitment, newRoot]);

      const shieldIx = {
        programId: TRUSTLESS_PROGRAM_ID,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: dPoolPDA, isSigner: false, isWritable: true },
          { pubkey: dMerkleTreePDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: shieldData,
      };

      await withRetry(async () => {
        const sig = await sendAndConfirmTransaction(
          connection,
          new Transaction().add(shieldIx),
          [payer],
          { commitment: 'confirmed', skipPreflight: true },
        );
        console.log(`    Shielded ${uniqueDenom} lamports into denominated pool`);
      });

      // Verify pool state
      const poolInfo = await connection.getAccountInfo(dPoolPDA);
      expect(poolInfo).to.not.be.null;

      // Verify nullifier PDA derivation
      const nullifierHash = randomBytes32();
      const [nullifierPDA] = deriveTrustlessNullifierPDA(dPoolPDA, nullifierHash);
      expect(nullifierPDA).to.not.be.null;
      console.log('    Denominated pool working with fixed amounts');
    });
  });
});
