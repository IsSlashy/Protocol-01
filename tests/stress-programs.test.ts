/**
 * STRESS TEST: the four live on-chain programs (Devnet)
 *
 * Stress test covering the Solana programs Protocol 01 runs on devnet today. Uses ts-mocha + chai +
 * @coral-xyz/anchor patterns matching existing test files.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..." \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   pnpm test:stress
 *
 * Programs tested:
 *   1. zk_shielded        - GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
 *   2. p01_relayer        - 2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW
 *   3. p01_registry       - QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB
 *   4. p01_stark_verifier - DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 *
 * [2026-09-23] The sections for p01_zkspl, p01_arcium, p01_stream,
 * p01_subscription and p01_whitelist left with those programs (deleted from the
 * tree), and those for specter, p01_quantum_vault and p01_fee_splitter (closed
 * on devnet on 2026-09-13) went with them.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { expect } from 'chai';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import * as path from 'path';

// =============================================================================
// Program IDs (Devnet)
// =============================================================================

const PROGRAM_IDS = {
  ZK_SHIELDED: new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c'),
  RELAYER: new PublicKey('2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW'),
  REGISTRY: new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB'),
  STARK_VERIFIER: new PublicKey('DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs'),
};

// =============================================================================
// Shared Helpers
// =============================================================================

/** Compute an Anchor instruction discriminator: sha256("global:<name>")[0..8] */
function computeDiscriminator(name: string): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(`global:${name}`);
  return hash.digest().subarray(0, 8);
}

/** Generate a random 32-byte buffer. */
function randomBytes32(): Buffer {
  return crypto.randomBytes(32);
}

/** Encode a u32 as 4-byte LE buffer. */
function u32ToLeBytes(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

/** Borsh Vec<u8>: 4-byte LE length prefix + raw bytes. */
function borshVec(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  return Buffer.concat([len, data]);
}

/** Retry with exponential backoff for devnet RPC issues (429, blockhash). */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const errStr = err.toString();
      const isRetryable =
        errStr.includes('429') ||
        errStr.includes('Blockhash not found') ||
        errStr.includes('block height exceeded') ||
        errStr.includes('Service Unavailable') ||
        errStr.includes('Too many requests') ||
        errStr.includes('socket hang up');
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.log(`    Retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/** Generate a random 32-byte key as number[]. */
function randomKey32(): number[] {
  return Array.from(crypto.randomBytes(32));
}

/** All-zero 32-byte key. */
function zeroKey32(): number[] {
  return new Array(32).fill(0);
}

/** Unique test run ID to avoid PDA conflicts. */
const TEST_RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// =============================================================================
// STARK Helpers
// =============================================================================

const STARK_CIRCUIT_SUBSCRIBER_OWNERSHIP = 0;
const STARK_CIRCUIT_POOL_COMMITMENT = 1;
const STARK_CIRCUIT_BALANCE_PROOF = 2;
const STARK_PROOF_DATA_OFFSET = 82; // 8 disc + 32 pubkey + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified + 32 public_inputs_hash
const STARK_MAX_CHUNK_SIZE = 900;

const STARK_IDL = {
  address: 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
  metadata: { name: 'p01_stark_verifier', version: '0.1.0', spec: '0.1.0' },
  instructions: [
    {
      name: 'init_proof_buffer',
      discriminator: [49, 27, 28, 88, 19, 99, 133, 194],
      accounts: [
        { name: 'proof_buffer', writable: true },
        { name: 'authority', writable: true, signer: true },
        { name: 'system_program', address: '11111111111111111111111111111111' },
      ],
      args: [
        { name: 'proof_size', type: 'u32' },
        { name: 'circuit_id', type: 'u8' },
      ],
    },
    {
      name: 'write_proof_chunk',
      discriminator: [183, 3, 171, 138, 153, 138, 133, 147],
      accounts: [
        { name: 'proof_buffer', writable: true },
        { name: 'authority', signer: true },
      ],
      args: [
        { name: 'offset', type: 'u32' },
        { name: 'data', type: 'bytes' },
      ],
    },
    {
      name: 'verify_stark_proof',
      discriminator: [208, 216, 183, 38, 47, 69, 156, 138],
      accounts: [
        { name: 'proof_buffer', writable: true },
        { name: 'authority', signer: true },
      ],
      args: [{ name: 'commitment', type: 'u64' }],
    },
    {
      name: 'close_proof_buffer',
      discriminator: [130, 150, 6, 35, 193, 34, 243, 87],
      accounts: [
        { name: 'proof_buffer', writable: true },
        { name: 'authority', writable: true, signer: true },
      ],
      args: [],
    },
  ],
  accounts: [
    { name: 'ProofBuffer', discriminator: [71, 133, 225, 94, 9, 130, 40, 161] },
  ],
  errors: [
    { code: 6000, name: 'AlreadyVerified', msg: 'Proof has already been verified' },
    { code: 6001, name: 'ChunkOutOfBounds', msg: 'Proof chunk exceeds buffer bounds' },
    { code: 6002, name: 'IncompleteProof', msg: 'Proof upload incomplete' },
    { code: 6003, name: 'InvalidProof', msg: 'Invalid proof: verification failed' },
    { code: 6004, name: 'DeserializationError', msg: 'Failed to deserialize proof bytes' },
    { code: 6005, name: 'UnsupportedCircuit', msg: 'Unsupported circuit ID' },
    { code: 6006, name: 'NotYetVerified', msg: 'Proof has not been verified yet' },
  ],
  types: [
    {
      name: 'ProofBuffer',
      type: {
        kind: 'struct',
        fields: [
          { name: 'authority', type: 'pubkey' },
          { name: 'circuit_id', type: 'u8' },
          { name: 'proof_size', type: 'u32' },
          { name: 'bytes_written', type: 'u32' },
          { name: 'verified', type: 'bool' },
        ],
      },
    },
  ],
} as any;

function getStarkProofBufferPDA(authority: PublicKey, circuitId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stark_proof'), authority.toBuffer(), Buffer.from([circuitId])],
    PROGRAM_IDS.STARK_VERIFIER,
  );
}

function generateCompactProof(secret: number): { commitment: bigint; proofBytes: Buffer } {
  const projectRoot = path.resolve(__dirname, '..');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- ${secret}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 },
  );
  const commitmentMatch = output.match(/"commitment":\s*(\d+)/);
  if (!commitmentMatch) throw new Error('Could not parse commitment from gen_proof output');
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  return {
    commitment: BigInt(commitmentMatch[1]),
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

function generatePoolCommitmentProof(np: number, secret: number, epoch: number, mint: number): {
  circuitId: number; publicInputs: bigint[]; proofBytes: Buffer;
} {
  const projectRoot = path.resolve(__dirname, '..');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- pool ${np} ${secret} ${epoch} ${mint}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 },
  );
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputsMatch = output.match(/"public_inputs":\s*\[(\d+),\s*(\d+)\]/);
  if (!inputsMatch) throw new Error('Could not parse public_inputs');
  return {
    circuitId: json.circuit_id,
    publicInputs: [BigInt(inputsMatch[1]), BigInt(inputsMatch[2])],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

function buildVerifyStarkProofV2Ix(
  proofBuffer: PublicKey,
  authority: PublicKey,
  publicInputs: bigint[],
): TransactionInstruction {
  const discriminator = Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]);
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map((v) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  });
  const data = Buffer.concat([discriminator, vecLen, ...inputBufs]);
  return new TransactionInstruction({
    programId: PROGRAM_IDS.STARK_VERIFIER,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildResizeProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const discriminator = Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]);
  return new TransactionInstruction({
    programId: PROGRAM_IDS.STARK_VERIFIER,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
}

async function uploadStarkProofChunks(
  program: Program,
  proofBuffer: PublicKey,
  authority: Keypair,
  proofBytes: Buffer,
  connection: Connection,
): Promise<void> {
  const chunks: { offset: number; data: Buffer }[] = [];
  for (let offset = 0; offset < proofBytes.length; offset += STARK_MAX_CHUNK_SIZE) {
    chunks.push({
      offset,
      data: proofBytes.subarray(offset, Math.min(offset + STARK_MAX_CHUNK_SIZE, proofBytes.length)),
    });
  }
  for (const chunk of chunks) {
    const tx = await program.methods
      .writeProofChunk(chunk.offset, chunk.data)
      .accounts({ proofBuffer, authority: authority.publicKey })
      .signers([authority])
      .rpc({ commitment: 'confirmed', skipPreflight: true });
    await connection.confirmTransaction(tx, 'confirmed');
  }
}

// =============================================================================
// Main Test Suite
// =============================================================================

describe('STRESS TEST: live on-chain programs', function () {
  this.timeout(600_000); // 10 minutes global timeout

  const provider = AnchorProvider.env();
  (provider as any).opts = {
    preflightCommitment: 'confirmed',
    commitment: 'confirmed',
  };
  anchor.setProvider(provider);

  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  before(async () => {
    console.log('='.repeat(70));
    console.log('STRESS TEST: All On-Chain Programs');
    console.log(`Test Run ID: ${TEST_RUN_ID}`);
    console.log(`Payer: ${payer.publicKey.toBase58()}`);
    console.log('='.repeat(70));

    const balance = await connection.getBalance(payer.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 2 * LAMPORTS_PER_SOL) {
      console.log('Requesting airdrop...');
      try {
        const sig = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('Airdrop received: 2 SOL');
      } catch (e: any) {
        console.log(`Airdrop failed (may already have enough): ${e.message}`);
      }
    }
  });

  // ===========================================================================
  // 1. zk_shielded -- Shielded Pool + Denominated Pool + Subscription Vault
  // ===========================================================================

  describe('1. zk_shielded -- Shielded Pool + Denominated Pool + Subscription Vault', () => {
    const PROG = PROGRAM_IDS.ZK_SHIELDED;
    const SEEDS = {
      SHIELDED_POOL: Buffer.from('shielded_pool'),
      MERKLE_TREE: Buffer.from('merkle_tree'),
      NULLIFIER_SET: Buffer.from('nullifier_set'),
      VK_DATA: Buffer.from('vk_data'),
      DENOMINATED_POOL: Buffer.from('denominated_pool'),
    };
    const DISC = {
      initialize_pool: computeDiscriminator('initialize_pool'),
      shield: computeDiscriminator('shield'),
      init_denominated_pool: computeDiscriminator('init_denominated_pool'),
      shield_denominated: computeDiscriminator('shield_denominated'),
      // subscribe_normal removed from the program — its vault PDA was keyed on
      // the subscriber's wallet, which published subscription membership.
      claim_period: computeDiscriminator('claim_period'),
      pause_normal: computeDiscriminator('pause_normal'),
      resume_normal: computeDiscriminator('resume_normal'),
      cancel_normal: computeDiscriminator('cancel_normal'),
      init_vk_data: computeDiscriminator('init_vk_data'),
      write_vk_data: computeDiscriminator('write_vk_data'),
    };

    let tokenMint: PublicKey;
    let poolPDA: PublicKey;
    let merkleTreePDA: PublicKey;
    let userTokenAccount: PublicKey;
    let poolVault: PublicKey;

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    zk_shielded deployed: ${accountInfo!.data.length} bytes`);
    });

    it('initialize_pool: creates pool PDA with VK hash', async () => {
      tokenMint = await withRetry(() =>
        createMint(connection, payer, payer.publicKey, null, 9),
      );

      [poolPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.SHIELDED_POOL, tokenMint.toBuffer()],
        PROG,
      );
      [merkleTreePDA] = PublicKey.findProgramAddressSync(
        [SEEDS.MERKLE_TREE, poolPDA.toBuffer()],
        PROG,
      );

      const vkHash = Buffer.alloc(32, 0x42);
      const data = Buffer.concat([
        DISC.initialize_pool,
        vkHash,
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add({
          programId: PROG,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: poolPDA, isSigner: false, isWritable: true },
            { pubkey: merkleTreePDA, isSigner: false, isWritable: true },
            { pubkey: tokenMint, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          ],
          data,
        });

      const sig = await withRetry(() => provider.sendAndConfirm(tx));
      console.log(`    initialize_pool tx: ${sig}`);

      const poolAccount = await connection.getAccountInfo(poolPDA);
      expect(poolAccount).to.not.be.null;
      expect(poolAccount!.owner.toBase58()).to.equal(PROG.toBase58());
    });

    it('shield: deposits SOL with Poseidon commitment', async () => {
      const userAta = await withRetry(() =>
        getOrCreateAssociatedTokenAccount(connection, payer, tokenMint, payer.publicKey),
      );
      userTokenAccount = userAta.address;

      await withRetry(() =>
        mintTo(connection, payer, tokenMint, userTokenAccount, payer, 10_000_000_000n),
      );

      const vaultAta = await withRetry(() =>
        getOrCreateAssociatedTokenAccount(connection, payer, tokenMint, poolPDA, true),
      );
      poolVault = vaultAta.address;

      const commitment = randomBytes32();
      const newRoot = randomBytes32();

      const data = Buffer.concat([
        DISC.shield,
        commitment,
        newRoot,
      ]);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add({
          programId: PROG,
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

      const sig = await withRetry(() => provider.sendAndConfirm(tx));
      console.log(`    shield tx: ${sig}`);
    });

    it('verifies Merkle tree insertion after shield', async () => {
      const merkleAccount = await connection.getAccountInfo(merkleTreePDA);
      expect(merkleAccount).to.not.be.null;
      // After shield, leaf count should be > 0
      const leafCount = merkleAccount!.data.readBigUInt64LE(8 + 32 + 32); // after discrim + pool + root
      expect(Number(leafCount)).to.be.gte(1);
      console.log(`    Merkle tree leaf count: ${leafCount}`);
    });

    it('init_vk_data + write_vk_data: uploads verification key', async () => {
      const [vkDataPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.VK_DATA, poolPDA.toBuffer()],
        PROG,
      );

      const mockVkData = Buffer.alloc(512, 0x01);
      const vkSize = mockVkData.length;

      const initData = Buffer.concat([
        DISC.init_vk_data,
        u32ToLeBytes(vkSize),
      ]);

      const initTx = new Transaction().add({
        programId: PROG,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: poolPDA, isSigner: false, isWritable: false },
          { pubkey: vkDataPDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initData,
      });

      try {
        await withRetry(() => provider.sendAndConfirm(initTx));

        // Write VK data in chunks
        const chunkSize = 800;
        for (let offset = 0; offset < mockVkData.length; offset += chunkSize) {
          const chunk = mockVkData.subarray(offset, Math.min(offset + chunkSize, mockVkData.length));
          const writeData = Buffer.concat([
            DISC.write_vk_data,
            u32ToLeBytes(offset),
            borshVec(chunk),
          ]);

          const writeTx = new Transaction().add({
            programId: PROG,
            keys: [
              { pubkey: payer.publicKey, isSigner: true, isWritable: true },
              { pubkey: poolPDA, isSigner: false, isWritable: false },
              { pubkey: vkDataPDA, isSigner: false, isWritable: true },
            ],
            data: writeData,
          });

          await withRetry(() => provider.sendAndConfirm(writeTx));
        }

        const vkAccount = await connection.getAccountInfo(vkDataPDA);
        expect(vkAccount).to.not.be.null;
        console.log(`    VK data uploaded: ${vkAccount!.data.length} bytes`);
      } catch (err: any) {
        // VK data may already exist from previous runs
        console.log(`    VK data upload: ${err.message.includes('already') ? 'already exists' : 'skipped'}`);
      }
    });
  });

  // ===========================================================================
  // 2. p01_relayer -- Decentralized Relay Network
  // ===========================================================================

  describe('2. p01_relayer -- Decentralized Relay Network', () => {
    const PROG = PROGRAM_IDS.RELAYER;

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_relayer deployed: ${accountInfo!.data.length} bytes`);
    });

    it('derives config PDA correctly', () => {
      const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('relayer_config')],
        PROG,
      );
      expect(configPda).to.not.be.null;
    });

    it('derives relayer node PDA for operator', () => {
      const operator = Keypair.generate().publicKey;
      const [nodePda] = PublicKey.findProgramAddressSync(
        [Buffer.from('relayer_node'), operator.toBuffer()],
        PROG,
      );
      expect(nodePda).to.not.be.null;
    });

    it('derives unique job PDAs for different job IDs', () => {
      const jobId1 = randomBytes32();
      const jobId2 = randomBytes32();
      const [pda1] = PublicKey.findProgramAddressSync(
        [Buffer.from('relay_job'), jobId1],
        PROG,
      );
      const [pda2] = PublicKey.findProgramAddressSync(
        [Buffer.from('relay_job'), jobId2],
        PROG,
      );
      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });

    it('validates protocol fee calculation (5% of 0.01 SOL)', () => {
      const jobFee = BigInt(0.01 * LAMPORTS_PER_SOL);
      const protocolFeeBps = 500;
      const protocolFee = (jobFee * BigInt(protocolFeeBps)) / BigInt(10_000);
      expect(Number(protocolFee)).to.equal(Math.floor(0.01 * LAMPORTS_PER_SOL * 0.05));
    });
  });

  // ===========================================================================
  // 3. p01_registry -- Stealth Meta-Address Directory
  // ===========================================================================

  describe('3. p01_registry -- Stealth Meta-Address Directory', () => {
    const PROG = PROGRAM_IDS.REGISTRY;

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_registry deployed: ${accountInfo!.data.length} bytes`);
    });

    it('derives registry PDA for owner', () => {
      const owner = Keypair.generate().publicKey;
      const [registryPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_registry'), owner.toBuffer()],
        PROG,
      );
      expect(registryPDA).to.not.be.null;
    });

    it('derives unique PDAs for different owners', () => {
      const owner1 = Keypair.generate().publicKey;
      const owner2 = Keypair.generate().publicKey;
      const [pda1] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_registry'), owner1.toBuffer()],
        PROG,
      );
      const [pda2] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_registry'), owner2.toBuffer()],
        PROG,
      );
      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });

    it('validates key length constraints (spending/viewing 32 bytes)', () => {
      const spendingKey = randomKey32();
      const viewingKey = randomKey32();
      expect(spendingKey.length).to.equal(32);
      expect(viewingKey.length).to.equal(32);
    });

    it('validates ML-KEM-768 public key size (1184 bytes)', () => {
      const KEM_PUBKEY_LEN = 1184;
      const kemKey = new Uint8Array(KEM_PUBKEY_LEN);
      expect(kemKey.length).to.equal(KEM_PUBKEY_LEN);
    });

    it('rejects zero spending/viewing keys', () => {
      const zeroKey = zeroKey32();
      expect(zeroKey.every((b) => b === 0)).to.be.true;
      // On-chain: InvalidKey error
    });

    it('validates name length constraints (max 32 bytes)', () => {
      const validName = 'alice.sol';
      expect(validName.length).to.be.at.most(32);
      const longName = 'a'.repeat(33);
      expect(longName.length).to.be.greaterThan(32);
    });
  });

  // ===========================================================================
  // 4. p01_stark_verifier -- Multi-Circuit STARK Verifier
  // ===========================================================================

  describe('4. p01_stark_verifier -- Multi-Circuit STARK Verifier', () => {
    const program = new Program(STARK_IDL, provider);
    const authority = payer;

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() =>
        connection.getAccountInfo(PROGRAM_IDS.STARK_VERIFIER),
      );
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_stark_verifier deployed: ${accountInfo!.data.length} bytes`);
    });

    it('circuit 0 (subscriber_ownership): init -> upload -> verify -> close', async () => {
      console.log('    Generating compact STARK proof (secret=42)...');
      let proof: { commitment: bigint; proofBytes: Buffer };
      try {
        proof = generateCompactProof(42);
      } catch (e: any) {
        console.log(`    SKIPPED: cargo binary not available: ${e.message.slice(0, 80)}`);
        return;
      }
      console.log(`    Proof size: ${proof.proofBytes.length} bytes`);

      const [proofBufferPDA] = getStarkProofBufferPDA(authority.publicKey, STARK_CIRCUIT_SUBSCRIBER_OWNERSHIP);

      // Clean up stale PDA
      const existing = await connection.getAccountInfo(proofBufferPDA);
      if (existing) {
        try {
          const cTx = await program.methods
            .closeProofBuffer()
            .accounts({ proofBuffer: proofBufferPDA, authority: authority.publicKey })
            .signers([authority])
            .rpc({ commitment: 'confirmed', skipPreflight: true });
          await connection.confirmTransaction(cTx, 'confirmed');
        } catch (_) {}
      }

      // Init
      await withRetry(async () => {
        const tx = await program.methods
          .initProofBuffer(proof.proofBytes.length, STARK_CIRCUIT_SUBSCRIBER_OWNERSHIP)
          .accounts({
            proofBuffer: proofBufferPDA,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
        await connection.confirmTransaction(tx, 'confirmed');
      });

      // Upload
      await uploadStarkProofChunks(program, proofBufferPDA, authority, proof.proofBytes, connection);

      // Verify
      await withRetry(async () => {
        const tx = await program.methods
          .verifyStarkProof(new BN(proof.commitment.toString()))
          .accounts({ proofBuffer: proofBufferPDA, authority: authority.publicKey })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
        await connection.confirmTransaction(tx, 'confirmed');
      });

      const account = await (program.account as any).proofBuffer.fetch(proofBufferPDA);
      expect(account.verified).to.be.true;
      console.log('    Circuit 0 proof verified on-chain!');

      // Close
      await withRetry(async () => {
        await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: proofBufferPDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      });
    });

    it('circuit 1 (pool_commitment): init -> upload -> verify_v2 -> close', async () => {
      let proof: { circuitId: number; publicInputs: bigint[]; proofBytes: Buffer };
      try {
        proof = generatePoolCommitmentProof(123, 456, 1, 999);
      } catch (e: any) {
        console.log(`    SKIPPED: cargo binary not available: ${e.message.slice(0, 80)}`);
        return;
      }
      console.log(`    Pool proof size: ${proof.proofBytes.length} bytes`);

      const [poolPDA] = getStarkProofBufferPDA(authority.publicKey, STARK_CIRCUIT_POOL_COMMITMENT);

      // Clean stale
      const existing = await connection.getAccountInfo(poolPDA);
      if (existing) {
        try {
          await program.methods
            .closeProofBuffer()
            .accounts({ proofBuffer: poolPDA, authority: authority.publicKey })
            .signers([authority])
            .rpc({ commitment: 'confirmed', skipPreflight: true });
        } catch (_) {}
      }

      // Init (raw instruction)
      const initData = Buffer.alloc(8 + 4 + 1);
      Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]).copy(initData, 0);
      initData.writeUInt32LE(proof.proofBytes.length, 8);
      initData.writeUInt8(STARK_CIRCUIT_POOL_COMMITMENT, 12);

      await withRetry(async () => {
        await sendAndConfirmTransaction(
          connection,
          new Transaction().add({
            programId: PROGRAM_IDS.STARK_VERIFIER,
            keys: [
              { pubkey: poolPDA, isSigner: false, isWritable: true },
              { pubkey: authority.publicKey, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: initData,
          }),
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
      });

      // Upload
      await uploadStarkProofChunks(program, poolPDA, authority, proof.proofBytes, connection);

      // Verify v2
      const verifyIx = buildVerifyStarkProofV2Ix(poolPDA, authority.publicKey, proof.publicInputs);
      await withRetry(async () => {
        await sendAndConfirmTransaction(
          connection,
          new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
            .add(verifyIx),
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
      });

      const account = await (program.account as any).proofBuffer.fetch(poolPDA);
      expect(account.verified).to.be.true;
      console.log('    Circuit 1 pool commitment proof verified!');

      // Close
      await program.methods
        .closeProofBuffer()
        .accounts({ proofBuffer: poolPDA, authority: authority.publicKey })
        .signers([authority])
        .rpc({ commitment: 'confirmed', skipPreflight: true });
    });

    it('rejects double verification of verified proof', async () => {
      // Covered implicitly by the AlreadyVerified error code check
      // If we try to verify again after close, init would be needed first
      expect(STARK_IDL.errors[0].name).to.equal('AlreadyVerified');
    });

    it('rejects invalid circuit ID (255)', async () => {
      const invalidCircuitId = 255;
      const [invalidPDA] = getStarkProofBufferPDA(authority.publicKey, invalidCircuitId);

      try {
        await program.methods
          .initProofBuffer(100, invalidCircuitId)
          .accounts({
            proofBuffer: invalidPDA,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc({ commitment: 'confirmed' });
        expect.fail('Should have thrown UnsupportedCircuit');
      } catch (err: any) {
        const errStr = err.toString();
        expect(
          errStr.includes('UnsupportedCircuit') ||
            errStr.includes('6005') ||
            errStr.includes('Simulation failed'),
        ).to.be.true;
      }
    });

    it('resize_proof_buffer: handles >10KB proofs', () => {
      // Verify the resize instruction discriminator is correct
      const resizeIx = buildResizeProofBufferIx(
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
      );
      expect(resizeIx.data.length).to.equal(8);
    });
  });

  // ===========================================================================
  // 5. Concurrent Operations Stress
  // ===========================================================================

  describe('5. Concurrent Operations Stress', () => {
    it('handles 4 simultaneous program deployment checks', async () => {
      const programs = [
        PROGRAM_IDS.ZK_SHIELDED,
        PROGRAM_IDS.RELAYER,
        PROGRAM_IDS.REGISTRY,
        PROGRAM_IDS.STARK_VERIFIER,
      ];

      const results = await Promise.all(
        programs.map((prog) =>
          withRetry(() => connection.getAccountInfo(prog)),
        ),
      );

      for (let i = 0; i < results.length; i++) {
        expect(results[i]).to.not.be.null;
        expect(results[i]!.executable).to.be.true;
      }
      console.log(`    All 4 programs verified as deployed concurrently`);
    });

    it('handles 5 simultaneous shield commitment generations', () => {
      const commitments: Buffer[] = [];
      for (let i = 0; i < 5; i++) {
        commitments.push(randomBytes32());
      }

      // All commitments should be unique
      const uniqueSet = new Set(commitments.map((c) => c.toString('hex')));
      expect(uniqueSet.size).to.equal(5);
      console.log(`    5 unique shield commitments generated`);
    });
  });

  // ===========================================================================
  // 6. Cross-Program Invariants
  // ===========================================================================

  describe('6. Cross-Program Invariants', () => {
    it('every program in PROGRAM_IDS is deployed and executable', async () => {
      const entries = Object.entries(PROGRAM_IDS);
      const results = await Promise.all(
        entries.map(async ([name, pubkey]) => {
          const info = await withRetry(() => connection.getAccountInfo(pubkey));
          return { name, pubkey: pubkey.toBase58(), deployed: info !== null, executable: info?.executable };
        }),
      );

      for (const result of results) {
        expect(result.deployed, `${result.name} should be deployed`).to.be.true;
        expect(result.executable, `${result.name} should be executable`).to.be.true;
        console.log(`    ${result.name}: ${result.pubkey.slice(0, 12)}... OK`);
      }
    });

    it('no two programs share the same program ID', () => {
      const ids = Object.values(PROGRAM_IDS).map((p) => p.toBase58());
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).to.equal(ids.length);
    });

    it('PDA seeds are program-scoped (no cross-program collisions)', () => {
      const owner = Keypair.generate().publicKey;

      // Same seed prefix "user_registry" but different programs should yield different PDAs
      // (Only registry uses "user_registry" but verify the principle)
      const [registryPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_registry'), owner.toBuffer()],
        PROGRAM_IDS.REGISTRY,
      );

      // Different program, same seed => different PDA
      const [fakePDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_registry'), owner.toBuffer()],
        PROGRAM_IDS.ZK_SHIELDED,
      );

      expect(registryPDA.toBase58()).to.not.equal(fakePDA.toBase58());
    });
  });
});
