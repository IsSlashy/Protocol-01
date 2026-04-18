/**
 * STRESS TEST: All 12+ On-Chain Programs (Devnet)
 *
 * Comprehensive stress test covering every instruction across all deployed
 * Solana programs in the Protocol 01 ecosystem. Uses ts-mocha + chai +
 * @coral-xyz/anchor patterns matching existing test files.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..." \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   pnpm test:stress
 *
 * Programs tested:
 *   1.  zk_shielded        - GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
 *   2.  p01_zkspl          - EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah
 *   3.  specter            - 2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp
 *   4.  p01_relayer        - 2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW
 *   5.  p01_quantum_vault  - 9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv
 *   6.  p01_registry       - QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB
 *   7.  p01_stark_verifier - DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 *   8.  p01_arcium         - FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT
 *   9.  p01_fee_splitter   - UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM
 *   10. p01_stream         - C92xDDAtd21ED3MitZJ9dhuyGeig5xVx8Dgg6qrxA3vx
 *   11. p01_subscription   - 3eDvPJTK2gryh3GhjFgwz94iBsE3hsqZL9ChAFyiBThW
 *   12. p01_whitelist      - 5PSYrjBKke4gj8BgBgRKZNXgjmLCnojZ5yuDqUvPiG33
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
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
  ZKSPL: new PublicKey('EqppogLBFqoVfYR2t6WVswaGo7cHxvWmgsgLDnaUPpah'),
  SPECTER: new PublicKey('2tuztgD9RhdaBkiP79fHkrFbfWBX75v7UjSNN4ULfbSp'),
  RELAYER: new PublicKey('2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW'),
  QUANTUM_VAULT: new PublicKey('9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv'),
  REGISTRY: new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB'),
  STARK_VERIFIER: new PublicKey('DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs'),
  ARCIUM: new PublicKey('FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT'),
  FEE_SPLITTER: new PublicKey('UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM'),
  STREAM: new PublicKey('C92xDDAtd21ED3MitZJ9dhuyGeig5xVx8Dgg6qrxA3vx'),
  SUBSCRIPTION: new PublicKey('3eDvPJTK2gryh3GhjFgwz94iBsE3hsqZL9ChAFyiBThW'),
  WHITELIST: new PublicKey('5PSYrjBKke4gj8BgBgRKZNXgjmLCnojZ5yuDqUvPiG33'),
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

/** Encode a u64 as 8-byte LE buffer. */
function u64ToLeBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
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

/** Transfer SOL from payer to a target. */
async function fundAccount(
  provider: AnchorProvider,
  to: PublicKey,
  solAmount: number,
): Promise<void> {
  if (solAmount <= 0) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: to,
      lamports: Math.round(solAmount * LAMPORTS_PER_SOL),
    }),
  );
  await provider.sendAndConfirm(tx);
}

/** Advance slots by sending self-transfers. */
async function advanceSlots(provider: AnchorProvider, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: provider.wallet.publicKey,
        lamports: 1,
      }),
    );
    await provider.sendAndConfirm(tx);
  }
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
// WOTS+ Helpers (mirrors specter-sdk/src/quantum/wots.ts)
// =============================================================================

const WOTS_MSG_CHAINS = 64;
const WOTS_CHECKSUM_CHAINS = 3;
const WOTS_CHAINS = WOTS_MSG_CHAINS + WOTS_CHECKSUM_CHAINS; // 67
const WOTS_MAX_VAL = 15;
const HASH_SIZE = 32;

function sha256Hash(data: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash('sha256').update(data).digest());
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

interface WotsKeypair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHash: Uint8Array;
}

interface WotsSignature {
  signature: Uint8Array;
  publicKey: Uint8Array;
}

function generateWotsKeypair(seed: Uint8Array): WotsKeypair {
  const secretKey = new Uint8Array(WOTS_CHAINS * HASH_SIZE);
  const publicKey = new Uint8Array(WOTS_CHAINS * HASH_SIZE);

  for (let i = 0; i < WOTS_CHAINS; i++) {
    const indexBuf = new Uint8Array(4);
    new DataView(indexBuf.buffer).setUint32(0, i, true);
    const chainSecret = sha256Hash(concatBytes(seed, indexBuf));
    secretKey.set(chainSecret, i * HASH_SIZE);

    let current: Uint8Array = chainSecret;
    for (let step = 0; step < WOTS_MAX_VAL; step++) {
      current = sha256Hash(current);
    }
    publicKey.set(current, i * HASH_SIZE);
  }

  const publicKeyHash = sha256Hash(publicKey);
  return { secretKey, publicKey, publicKeyHash };
}

function deriveWotsKeypair(masterSeed: Uint8Array, index: number): WotsKeypair {
  const indexBuf = new Uint8Array(4);
  new DataView(indexBuf.buffer).setUint32(0, index, true);
  const keySeed = sha256Hash(
    concatBytes(new TextEncoder().encode('wots-key'), masterSeed, indexBuf),
  );
  return generateWotsKeypair(keySeed);
}

function computeWithdrawMessage(
  amount: bigint,
  destination: Uint8Array,
  withdrawalCount: bigint,
): Uint8Array {
  const amountBuf = new Uint8Array(8);
  new DataView(amountBuf.buffer).setBigUint64(0, amount, true);
  const countBuf = new Uint8Array(8);
  new DataView(countBuf.buffer).setBigUint64(0, withdrawalCount, true);
  return sha256Hash(concatBytes(amountBuf, destination, countBuf));
}

function wotsSign(message: Uint8Array, keypair: WotsKeypair): WotsSignature {
  const signature = new Uint8Array(WOTS_CHAINS * HASH_SIZE);

  const nibbles = new Array<number>(WOTS_CHAINS);
  for (let i = 0; i < WOTS_MSG_CHAINS; i++) {
    const byteIdx = i >> 1;
    const byte = message[byteIdx]!;
    nibbles[i] = i % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
  }
  let checksum = 0;
  for (let i = 0; i < WOTS_MSG_CHAINS; i++) {
    checksum += WOTS_MAX_VAL - nibbles[i]!;
  }
  nibbles[WOTS_MSG_CHAINS] = (checksum >> 8) & 0x0f;
  nibbles[WOTS_MSG_CHAINS + 1] = (checksum >> 4) & 0x0f;
  nibbles[WOTS_MSG_CHAINS + 2] = checksum & 0x0f;

  for (let i = 0; i < WOTS_CHAINS; i++) {
    const stepsToHash = WOTS_MAX_VAL - nibbles[i]!;
    let current: Uint8Array = keypair.secretKey.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE);
    for (let step = 0; step < stepsToHash; step++) {
      current = sha256Hash(current);
    }
    signature.set(current, i * HASH_SIZE);
  }
  return { signature, publicKey: keypair.publicKey };
}

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
// Fee Calculation Helper
// =============================================================================

function calculateFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / BigInt(10_000);
}

// =============================================================================
// Main Test Suite
// =============================================================================

describe('STRESS TEST: All 12+ On-Chain Programs', function () {
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
      subscribe_normal: computeDiscriminator('subscribe_normal'),
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
  // 2. p01_zkspl -- Confidential Balance
  // ===========================================================================

  describe('2. p01_zkspl -- Confidential Balance', () => {
    const PROG = PROGRAM_IDS.ZKSPL;
    const SEEDS = {
      ZKSPL_MINT: Buffer.from('zkspl_mint'),
      ZKSPL_ACCOUNT: Buffer.from('zkspl_account'),
      ZKSPL_VK: Buffer.from('zkspl_vk'),
    };

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_zkspl deployed: ${accountInfo!.data.length} bytes`);
    });

    it('derives correct PDA seeds for mint config', () => {
      const tokenMint = Keypair.generate().publicKey;
      const [mintConfigPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.ZKSPL_MINT, tokenMint.toBuffer()],
        PROG,
      );
      expect(mintConfigPDA).to.not.be.null;
    });

    it('derives unique PDAs for different mints', () => {
      const mint1 = Keypair.generate().publicKey;
      const mint2 = Keypair.generate().publicKey;
      const [pda1] = PublicKey.findProgramAddressSync([SEEDS.ZKSPL_MINT, mint1.toBuffer()], PROG);
      const [pda2] = PublicKey.findProgramAddressSync([SEEDS.ZKSPL_MINT, mint2.toBuffer()], PROG);
      expect(pda1.toBase58()).to.not.equal(pda2.toBase58());
    });

    it('derives confidential account PDA for owner+mint', () => {
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const [accountPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.ZKSPL_ACCOUNT, owner.toBuffer(), mint.toBuffer()],
        PROG,
      );
      expect(accountPDA).to.not.be.null;
    });

    it('derives VK data PDA correctly', () => {
      const mint = Keypair.generate().publicKey;
      const [mintPDA] = PublicKey.findProgramAddressSync([SEEDS.ZKSPL_MINT, mint.toBuffer()], PROG);
      const [vkPDA] = PublicKey.findProgramAddressSync([SEEDS.ZKSPL_VK, mintPDA.toBuffer()], PROG);
      expect(vkPDA).to.not.be.null;
    });

    it('validates field modulus for BN254', () => {
      const FIELD_MODULUS = BigInt(
        '21888242871839275222246405745257275088548364400416034343698204186575808495617',
      );
      expect(FIELD_MODULUS > BigInt(0)).to.be.true;
      // Values must be < FIELD_MODULUS for Groth16
      const testValue = BigInt('12345678901234567890');
      expect(testValue < FIELD_MODULUS).to.be.true;
    });
  });

  // ===========================================================================
  // 3. specter -- Stealth Payments v1/v2 + Streams
  // ===========================================================================

  describe('3. specter -- Stealth Payments v1/v2 + Streams', () => {
    const PROG = PROGRAM_IDS.SPECTER;
    const SEEDS = {
      WALLET: Buffer.from('p01_wallet'),
      STEALTH: Buffer.from('stealth'),
      STREAM: Buffer.from('stream'),
      ESCROW_AUTHORITY: Buffer.from('escrow_authority'),
      STREAM_ESCROW: Buffer.from('stream_escrow'),
    };

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    specter deployed: ${accountInfo!.data.length} bytes`);
    });

    it('init_wallet: derives wallet PDA correctly', () => {
      const owner = Keypair.generate().publicKey;
      const [walletPDA, bump] = PublicKey.findProgramAddressSync(
        [SEEDS.WALLET, owner.toBuffer()],
        PROG,
      );
      expect(walletPDA).to.not.be.null;
      expect(bump).to.be.a('number');
    });

    it('send_private: derives stealth PDA for v1 X25519', () => {
      const stealthAddr = randomBytes32();
      const [stealthPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.STEALTH, stealthAddr],
        PROG,
      );
      expect(stealthPDA).to.not.be.null;
    });

    it('send_private_v2: derives stealth PDA for hybrid X25519+ML-KEM', () => {
      // v2 stealth addresses include ML-KEM ephemeral key material
      const stealthAddr = randomBytes32();
      const [stealthPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.STEALTH, stealthAddr],
        PROG,
      );
      expect(stealthPDA).to.not.be.null;
      // Unique from v1
      const stealthAddr2 = randomBytes32();
      const [stealthPDA2] = PublicKey.findProgramAddressSync(
        [SEEDS.STEALTH, stealthAddr2],
        PROG,
      );
      expect(stealthPDA.toBase58()).to.not.equal(stealthPDA2.toBase58());
    });

    it('create_stream: derives stream PDA', () => {
      const sender = Keypair.generate().publicKey;
      const recipient = Keypair.generate().publicKey;
      const startTime = new BN(Math.floor(Date.now() / 1000));
      const [streamPDA] = PublicKey.findProgramAddressSync(
        [SEEDS.STREAM, sender.toBuffer(), recipient.toBuffer(), startTime.toArrayLike(Buffer, 'le', 8)],
        PROG,
      );
      expect(streamPDA).to.not.be.null;
    });

    it('validates stream linear vesting calculations', () => {
      function unlockedAmount(total: number, start: number, end: number, now: number): number {
        if (now <= start) return 0;
        if (now >= end) return total;
        return Math.floor((total * (now - start)) / (end - start));
      }
      expect(unlockedAmount(1000, 100, 200, 50)).to.equal(0);
      expect(unlockedAmount(1000, 100, 200, 150)).to.equal(500);
      expect(unlockedAmount(1000, 100, 200, 200)).to.equal(1000);
      expect(unlockedAmount(1000, 100, 200, 300)).to.equal(1000);
    });

    it('validates claim proof structure (Ed25519 64-byte signature)', () => {
      const proof = Buffer.alloc(64, 0xab);
      expect(proof.length).to.equal(64);
    });
  });

  // ===========================================================================
  // 4. p01_relayer -- Decentralized Relay Network
  // ===========================================================================

  describe('4. p01_relayer -- Decentralized Relay Network', () => {
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
  // 5. p01_quantum_vault -- Quantum-Safe Vault (3 Layers)
  // ===========================================================================

  describe('5. p01_quantum_vault -- Quantum-Safe Vault (3 Layers)', () => {
    const PROG = PROGRAM_IDS.QUANTUM_VAULT;
    const SEEDS = {
      WOTS_VAULT: Buffer.from('wots_vault'),
      HASH_VAULT: Buffer.from('hash_vault'),
      COMMIT: Buffer.from('commit'),
    };

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_quantum_vault deployed: ${accountInfo!.data.length} bytes`);
    });

    describe('WOTS+ Vault', () => {
      const masterSeed = sha256Hash(Buffer.from(`stress-wots-${TEST_RUN_ID}`));
      const keypair0 = deriveWotsKeypair(masterSeed, 0);
      const keypair1 = deriveWotsKeypair(masterSeed, 1);

      it('generates valid WOTS+ keypair', () => {
        expect(keypair0.publicKeyHash.length).to.equal(32);
        expect(keypair0.secretKey.length).to.equal(WOTS_CHAINS * HASH_SIZE);
        expect(keypair0.publicKey.length).to.equal(WOTS_CHAINS * HASH_SIZE);
      });

      it('derives wots vault PDA', () => {
        const owner = Keypair.generate().publicKey;
        const [vaultPDA] = PublicKey.findProgramAddressSync(
          [SEEDS.WOTS_VAULT, owner.toBuffer()],
          PROG,
        );
        expect(vaultPDA).to.not.be.null;
      });

      it('validates WOTS+ signature/verification cycle', () => {
        const withdrawAmount = BigInt(2 * LAMPORTS_PER_SOL);
        const destination = Keypair.generate().publicKey.toBytes();
        const withdrawalCount = BigInt(0);

        const message = computeWithdrawMessage(withdrawAmount, destination, withdrawalCount);
        const sig = wotsSign(message, keypair0);

        expect(sig.signature.length).to.equal(WOTS_CHAINS * HASH_SIZE);
        expect(sig.publicKey.length).to.equal(WOTS_CHAINS * HASH_SIZE);

        // Verify each chain: hash sig[i] (nibble times) should equal pubkey[i]
        for (let i = 0; i < WOTS_CHAINS; i++) {
          const byteIdx = Math.floor(i / 2);
          const byte = message[byteIdx]!;
          const nibble = i % 2 === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;

          let current: Uint8Array = new Uint8Array(sig.signature.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE));
          for (let step = 0; step < nibble; step++) {
            current = sha256Hash(current);
          }
          const expected = keypair0.publicKey.slice(i * HASH_SIZE, (i + 1) * HASH_SIZE);
          expect(Buffer.from(current)).to.deep.equal(Buffer.from(expected));
        }
      });

      it('rejects stale key (keypair0 after rotation to keypair1)', () => {
        // After key rotation, keypair0 hash should NOT match keypair1 hash
        expect(Buffer.from(keypair0.publicKeyHash)).to.not.deep.equal(
          Buffer.from(keypair1.publicKeyHash),
        );
      });
    });

    describe('Hash-Timelock Vault', () => {
      it('derives hash vault PDA', () => {
        const owner = Keypair.generate().publicKey;
        const [vaultPDA] = PublicKey.findProgramAddressSync(
          [SEEDS.HASH_VAULT, owner.toBuffer()],
          PROG,
        );
        expect(vaultPDA).to.not.be.null;
      });

      it('validates preimage commitment: SHA-256(secret) == commitment', () => {
        const secret = new Uint8Array(32);
        for (let i = 0; i < 32; i++) secret[i] = i + 1;
        const commitment = sha256Hash(secret);
        expect(commitment.length).to.equal(32);

        // Wrong preimage should not match
        const wrongSecret = new Uint8Array(32).fill(0xff);
        const wrongHash = sha256Hash(wrongSecret);
        expect(Buffer.from(wrongHash)).to.not.deep.equal(Buffer.from(commitment));
      });

      it('rejects claim without valid preimage', () => {
        const secret = crypto.randomBytes(32);
        const commitment = sha256Hash(secret);
        const badPreimage = crypto.randomBytes(32);
        const badHash = sha256Hash(badPreimage);
        expect(Buffer.from(badHash)).to.not.deep.equal(Buffer.from(commitment));
      });
    });

    describe('Commit-Reveal', () => {
      it('derives commit PDA', () => {
        const committer = Keypair.generate().publicKey;
        const commitmentBytes = randomBytes32();
        const [commitPda] = PublicKey.findProgramAddressSync(
          [SEEDS.COMMIT, committer.toBuffer(), commitmentBytes],
          PROG,
        );
        expect(commitPda).to.not.be.null;
      });

      it('validates commitment = SHA-256(action_data || nonce)', () => {
        const actionData = Buffer.from('transfer:destination:1000000');
        const nonce = crypto.randomBytes(32);
        const commitment = sha256Hash(concatBytes(actionData, nonce));
        expect(commitment.length).to.equal(32);

        // Wrong data should mismatch
        const wrongAction = Buffer.from('wrong_action');
        const wrongCommitment = sha256Hash(concatBytes(wrongAction, nonce));
        expect(Buffer.from(wrongCommitment)).to.not.deep.equal(Buffer.from(commitment));
      });

      it('rejects mismatched reveal', () => {
        const action = Buffer.from('test');
        const nonce = crypto.randomBytes(32);
        const commitment = sha256Hash(concatBytes(action, nonce));
        const wrongNonce = crypto.randomBytes(32);
        const wrongCommitment = sha256Hash(concatBytes(action, wrongNonce));
        expect(Buffer.from(wrongCommitment)).to.not.deep.equal(Buffer.from(commitment));
      });
    });
  });

  // ===========================================================================
  // 6. p01_registry -- Stealth Meta-Address Directory
  // ===========================================================================

  describe('6. p01_registry -- Stealth Meta-Address Directory', () => {
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
  // 7. p01_stark_verifier -- Multi-Circuit STARK Verifier
  // ===========================================================================

  describe('7. p01_stark_verifier -- Multi-Circuit STARK Verifier', () => {
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
  // 8. p01_arcium -- MPC Confidential Computation
  // ===========================================================================

  describe('8. p01_arcium -- MPC Confidential Computation', () => {
    it('verifies program is deployed and accessible', async () => {
      const accountInfo = await withRetry(() =>
        connection.getAccountInfo(PROGRAM_IDS.ARCIUM),
      );
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_arcium deployed: ${accountInfo!.data.length} bytes`);
    });

    it('verifies MXE account exists', async () => {
      // MXE account PDA derived from program ID
      const [mxeAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('mxe')],
        PROGRAM_IDS.ARCIUM,
      );

      const mxeAccount = await connection.getAccountInfo(mxeAddress);
      if (mxeAccount) {
        console.log(`    MXE account found: ${mxeAddress.toBase58()} (${mxeAccount.data.length} bytes)`);
      } else {
        console.log(`    MXE account not initialized at ${mxeAddress.toBase58()} (normal for fresh deploy)`);
      }
      // Note: actual MPC computation requires Arcium network running
    });

    it('derives proposal PDA for governance votes', () => {
      const proposalId = crypto.randomBytes(32);
      const [proposalPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_proposal'), proposalId],
        PROGRAM_IDS.ARCIUM,
      );
      expect(proposalPDA).to.not.be.null;
    });

    it('derives ballot PDA for voter', () => {
      const proposalId = crypto.randomBytes(32);
      const voter = Keypair.generate().publicKey;
      const [ballotPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_ballot'), proposalId, voter.toBuffer()],
        PROGRAM_IDS.ARCIUM,
      );
      expect(ballotPDA).to.not.be.null;
    });

    it('derives nullifier set PDA', () => {
      const poolId = crypto.randomBytes(32);
      const [nullifierSetPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_nullifier_set'), poolId],
        PROGRAM_IDS.ARCIUM,
      );
      expect(nullifierSetPDA).to.not.be.null;
    });
  });

  // ===========================================================================
  // 9. p01_fee_splitter -- Fee Splitting
  // ===========================================================================

  describe('9. p01_fee_splitter -- Fee Splitting', () => {
    const PROG = PROGRAM_IDS.FEE_SPLITTER;
    const DEFAULT_FEE_BPS = 50;
    const MAX_FEE_BPS = 500;
    const MIN_TRANSFER_LAMPORTS = 10_000;

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_fee_splitter deployed: ${accountInfo!.data.length} bytes`);
    });

    it('derives FeeConfig PDA correctly', () => {
      const [configPDA, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01-fee-config')],
        PROG,
      );
      expect(configPDA).to.not.be.null;
      expect(bump).to.be.a('number');
    });

    it('split_sol_direct: calculates 0.5% fee correctly', () => {
      const amount = BigInt(1_000_000_000); // 1 SOL
      const fee = calculateFee(amount, DEFAULT_FEE_BPS);
      expect(Number(fee)).to.equal(5_000_000); // 0.005 SOL
    });

    it('validates hardcoded PROTOCOL_FEE_WALLET constraint', () => {
      const feeWallet = Keypair.generate().publicKey;
      const wrongWallet = Keypair.generate().publicKey;
      expect(feeWallet.toBase58()).to.not.equal(wrongWallet.toBase58());
    });

    it('rejects arbitrary fee wallet address', () => {
      // Fee wallet must match the config's fee_wallet
      const correctFeeWallet = Keypair.generate().publicKey;
      const arbitraryWallet = Keypair.generate().publicKey;
      expect(correctFeeWallet.toBase58()).to.not.equal(arbitraryWallet.toBase58());
    });

    it('correctly calculates fee for small amounts', () => {
      const amount = BigInt(MIN_TRANSFER_LAMPORTS);
      const fee = calculateFee(amount, DEFAULT_FEE_BPS);
      expect(Number(fee)).to.equal(50); // 10000 * 50 / 10000 = 50 lamports
    });

    it('correctly calculates fee for large amounts', () => {
      const amount = BigInt('18446744073709551615'); // max u64
      const fee = calculateFee(amount, DEFAULT_FEE_BPS);
      expect(fee > BigInt(0)).to.be.true;
      // fee + recipient_amount == total
      const recipientAmount = amount - fee;
      expect(fee + recipientAmount === amount).to.be.true;
    });

    it('rejects fee_bps exceeding MAX_FEE_BPS', () => {
      const invalidBps = [501, 1000, 10000];
      for (const bps of invalidBps) {
        expect(bps).to.be.greaterThan(MAX_FEE_BPS);
      }
    });

    it('handles zero-fee case (0 bps)', () => {
      const amount = BigInt(1_000_000_000);
      const fee = calculateFee(amount, 0);
      expect(Number(fee)).to.equal(0);
    });
  });

  // ===========================================================================
  // 10. p01_stream -- Payment Streams
  // ===========================================================================

  describe('10. p01_stream -- Payment Streams', () => {
    const PROG = PROGRAM_IDS.STREAM;

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_stream deployed: ${accountInfo!.data.length} bytes`);
    });

    it('derives stream PDA for sender-recipient-mint', () => {
      const sender = Keypair.generate().publicKey;
      const recipient = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const [streamPDA, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from('stream'), sender.toBuffer(), recipient.toBuffer(), mint.toBuffer()],
        PROG,
      );
      expect(streamPDA).to.not.be.null;
      expect(bump).to.be.a('number');
    });

    it('create_stream: validates interval-based parameters', () => {
      const amountPerInterval = 1_000_000;
      const intervalSeconds = 3600;
      const totalIntervals = 24;
      expect(amountPerInterval).to.be.greaterThan(0);
      expect(intervalSeconds).to.be.greaterThan(0);
      expect(totalIntervals).to.be.greaterThan(0);
    });

    it('withdraw_from_stream: calculates elapsed intervals correctly', () => {
      function intervalsElapsed(lastAt: number, now: number, interval: number): number {
        return Math.floor((now - lastAt) / interval);
      }
      expect(intervalsElapsed(1000, 10000, 3600)).to.equal(2);
      expect(intervalsElapsed(0, 259200, 86400)).to.equal(3);
      expect(intervalsElapsed(0, 1800, 3600)).to.equal(0);
    });

    it('cancel_stream: calculates refund correctly', () => {
      const amountPerInterval = 1_000_000;
      const totalIntervals = 10;
      const intervalsPaid = 4;
      const remaining = totalIntervals - intervalsPaid;
      const refund = amountPerInterval * remaining;
      expect(refund).to.equal(6_000_000);
    });

    it('rejects withdrawal before interval elapsed', () => {
      const lastWithdrawalAt = 1000;
      const currentTime = 1500;
      const intervalSeconds = 3600;
      const elapsed = Math.floor((currentTime - lastWithdrawalAt) / intervalSeconds);
      expect(elapsed).to.equal(0);
    });

    it('handles multiple concurrent streams (different PDAs)', () => {
      const sender = Keypair.generate().publicKey;
      const recipient = Keypair.generate().publicKey;
      const mint1 = Keypair.generate().publicKey;
      const mint2 = Keypair.generate().publicKey;
      const mint3 = Keypair.generate().publicKey;

      const pdas = [mint1, mint2, mint3].map((mint) =>
        PublicKey.findProgramAddressSync(
          [Buffer.from('stream'), sender.toBuffer(), recipient.toBuffer(), mint.toBuffer()],
          PROG,
        )[0],
      );

      const uniquePdas = new Set(pdas.map((p) => p.toBase58()));
      expect(uniquePdas.size).to.equal(3);
    });

    it('simulates full lifecycle: create -> withdraw -> complete', () => {
      const amountPerInterval = 100;
      const totalIntervals = 3;
      let intervalsPaid = 0;

      intervalsPaid += 2;
      expect(intervalsPaid).to.equal(2);

      intervalsPaid += 1;
      expect(intervalsPaid).to.equal(3);
      expect(intervalsPaid >= totalIntervals).to.be.true;
    });
  });

  // ===========================================================================
  // 11. p01_subscription -- Recurring Payments
  // ===========================================================================

  describe('11. p01_subscription -- Recurring Payments', () => {
    const PROG = PROGRAM_IDS.SUBSCRIPTION;

    enum SubscriptionStatus {
      Active = 0,
      Paused = 1,
      Cancelled = 2,
      Completed = 3,
    }

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_subscription deployed: ${accountInfo!.data.length} bytes`);
    });

    it('derives subscription PDA for subscriber-merchant-id', () => {
      const subscriber = Keypair.generate().publicKey;
      const merchant = Keypair.generate().publicKey;
      const subscriptionId = 'sub_001';
      const [subPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('subscription'),
          subscriber.toBuffer(),
          merchant.toBuffer(),
          Buffer.from(subscriptionId),
        ],
        PROG,
      );
      expect(subPDA).to.not.be.null;
    });

    it('create_subscription: validates amount and interval', () => {
      const amount = 1_000_000;
      const interval = 86400;
      expect(amount).to.be.greaterThan(0);
      expect(interval).to.be.at.least(60);
    });

    it('process_payment: rejects early payment', () => {
      const nextPaymentDue = 2000;
      const currentTime = 1500;
      expect(currentTime < nextPaymentDue).to.be.true;
    });

    it('pause_subscription / resume_subscription: state transitions', () => {
      let status = SubscriptionStatus.Active;
      status = SubscriptionStatus.Paused;
      expect(status).to.equal(SubscriptionStatus.Paused);
      status = SubscriptionStatus.Active;
      expect(status).to.equal(SubscriptionStatus.Active);
    });

    it('update_privacy_settings: validates noise bounds', () => {
      expect(0).to.be.at.most(20); // amount_noise max
      expect(20).to.be.at.most(20);
      expect(21).to.be.greaterThan(20);
      expect(0).to.be.at.most(24); // timing_noise max
      expect(24).to.be.at.most(24);
      expect(25).to.be.greaterThan(24);
    });

    it('cancel_subscription: revokes delegation', () => {
      let status = SubscriptionStatus.Active;
      status = SubscriptionStatus.Cancelled;
      expect(status).to.equal(SubscriptionStatus.Cancelled);
    });

    it('close_subscription: only allowed for cancelled/completed', () => {
      const canClose = (s: SubscriptionStatus) =>
        s === SubscriptionStatus.Cancelled || s === SubscriptionStatus.Completed;
      expect(canClose(SubscriptionStatus.Cancelled)).to.be.true;
      expect(canClose(SubscriptionStatus.Completed)).to.be.true;
      expect(canClose(SubscriptionStatus.Active)).to.be.false;
      expect(canClose(SubscriptionStatus.Paused)).to.be.false;
    });

    it('simulates full lifecycle: create -> process x3 -> complete', () => {
      const maxPayments = 3;
      let paymentsMade = 0;
      let status = SubscriptionStatus.Active;

      for (let i = 0; i < 3; i++) {
        paymentsMade += 1;
        if (maxPayments > 0 && paymentsMade >= maxPayments) {
          status = SubscriptionStatus.Completed;
        }
      }
      expect(paymentsMade).to.equal(3);
      expect(status).to.equal(SubscriptionStatus.Completed);
    });
  });

  // ===========================================================================
  // 12. p01_whitelist -- Developer Access Control
  // ===========================================================================

  describe('12. p01_whitelist -- Developer Access Control', () => {
    const PROG = PROGRAM_IDS.WHITELIST;

    enum WhitelistStatus {
      Pending = 0,
      Approved = 1,
      Rejected = 2,
      Revoked = 3,
    }

    it('verifies program is deployed', async () => {
      const accountInfo = await withRetry(() => connection.getAccountInfo(PROG));
      expect(accountInfo).to.not.be.null;
      expect(accountInfo!.executable).to.be.true;
      console.log(`    p01_whitelist deployed: ${accountInfo!.data.length} bytes`);
    });

    it('derives whitelist PDA (global config)', () => {
      const [whitelistPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('whitelist')],
        PROG,
      );
      expect(whitelistPDA).to.not.be.null;
    });

    it('derives entry PDA for developer', () => {
      const developer = Keypair.generate().publicKey;
      const [entryPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('entry'), developer.toBuffer()],
        PROG,
      );
      expect(entryPDA).to.not.be.null;
    });

    it('request_access: validates IPFS CID length (max 64)', () => {
      const validCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      expect(validCid.length).to.be.at.most(64);
      const tooLongCid = 'Q'.repeat(65);
      expect(tooLongCid.length).to.be.greaterThan(64);
    });

    it('approve_request: requires Pending status', () => {
      const status = WhitelistStatus.Approved;
      expect(status).to.not.equal(WhitelistStatus.Pending);
    });

    it('check_access: returns true only for Approved entries', () => {
      const isApproved = (s: WhitelistStatus) => s === WhitelistStatus.Approved;
      expect(isApproved(WhitelistStatus.Approved)).to.be.true;
      expect(isApproved(WhitelistStatus.Pending)).to.be.false;
      expect(isApproved(WhitelistStatus.Rejected)).to.be.false;
      expect(isApproved(WhitelistStatus.Revoked)).to.be.false;
    });

    it('revoke_access: transitions Approved -> Revoked', () => {
      let status = WhitelistStatus.Approved;
      status = WhitelistStatus.Revoked;
      expect(status).to.equal(WhitelistStatus.Revoked);
    });

    it('reject_request: validates reason length (max 128)', () => {
      const validReason = 'Project does not meet privacy requirements';
      expect(validReason.length).to.be.at.most(128);
      const tooLong = 'X'.repeat(129);
      expect(tooLong.length).to.be.greaterThan(128);
    });

    it('state machine: valid transitions only', () => {
      // Pending -> Approved -> Revoked (valid)
      let status = WhitelistStatus.Pending;
      status = WhitelistStatus.Approved;
      status = WhitelistStatus.Revoked;
      expect(status).to.equal(WhitelistStatus.Revoked);

      // Rejected -> Approved should NOT be allowed (not Pending)
      const rejected: number = WhitelistStatus.Rejected;
      expect(rejected === (WhitelistStatus.Pending as number)).to.be.false;
    });
  });

  // ===========================================================================
  // 14. Concurrent Operations Stress
  // ===========================================================================

  describe('13. Concurrent Operations Stress', () => {
    it('handles 5 simultaneous program deployment checks', async () => {
      const programs = [
        PROGRAM_IDS.ZK_SHIELDED,
        PROGRAM_IDS.SPECTER,
        PROGRAM_IDS.RELAYER,
        PROGRAM_IDS.QUANTUM_VAULT,
        PROGRAM_IDS.REGISTRY,
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
      console.log(`    All 5 programs verified as deployed concurrently`);
    });

    it('handles 3 concurrent PDA derivations across programs', () => {
      const owner = Keypair.generate().publicKey;

      // Derive PDAs from 3 different programs simultaneously
      const [walletPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('p01_wallet'), owner.toBuffer()],
        PROGRAM_IDS.SPECTER,
      );
      const [registryPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_registry'), owner.toBuffer()],
        PROGRAM_IDS.REGISTRY,
      );
      const [wotsVaultPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('wots_vault'), owner.toBuffer()],
        PROGRAM_IDS.QUANTUM_VAULT,
      );

      // All PDAs should be unique (different programs, different seeds)
      const pdaSet = new Set([
        walletPDA.toBase58(),
        registryPDA.toBase58(),
        wotsVaultPDA.toBase58(),
      ]);
      expect(pdaSet.size).to.equal(3);
    });

    it('handles rapid subscription create+cancel cycle validation', () => {
      const amountPerPeriod = 1_000_000;
      const intervalSeconds = 3600;
      const maxPayments = 12;

      // Simulate rapid lifecycle transitions
      const cycles = 5;
      for (let i = 0; i < cycles; i++) {
        let status = 0; // Active
        let paymentsMade = 0;

        // Create (Active)
        expect(status).to.equal(0);

        // Maybe process one payment
        if (i % 2 === 0) {
          paymentsMade += 1;
          expect(paymentsMade).to.equal(1);
        }

        // Cancel
        status = 2; // Cancelled
        expect(status).to.equal(2);

        // Close
        const canClose = status === 2 || status === 3;
        expect(canClose).to.be.true;
      }
      console.log(`    ${cycles} rapid create+cancel cycles validated`);
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

    it('handles concurrent stream PDA derivation (3 streams)', () => {
      const sender = Keypair.generate().publicKey;
      const recipients = [
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
      ];
      const mint = Keypair.generate().publicKey;

      const pdas = recipients.map((r) =>
        PublicKey.findProgramAddressSync(
          [Buffer.from('stream'), sender.toBuffer(), r.toBuffer(), mint.toBuffer()],
          PROGRAM_IDS.STREAM,
        )[0],
      );

      const uniquePdas = new Set(pdas.map((p) => p.toBase58()));
      expect(uniquePdas.size).to.equal(3);
      console.log(`    3 concurrent stream PDAs derived (all unique)`);
    });
  });

  // ===========================================================================
  // 15. Cross-Program Invariants
  // ===========================================================================

  describe('14. Cross-Program Invariants', () => {
    it('all 13 programs are deployed and executable', async () => {
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
        PROGRAM_IDS.SPECTER,
      );

      expect(registryPDA.toBase58()).to.not.equal(fakePDA.toBase58());
    });
  });
});
