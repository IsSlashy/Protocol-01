/**
 * E2E: STARK Proof Full Flow
 *
 * Tests the complete STARK proof lifecycle across p01_stark_verifier:
 *   - Initialize proof buffer
 *   - Upload proof chunks (multi-tx)
 *   - Verify subscriber_ownership proof (circuit 0)
 *   - Verify pool_commitment proof (circuit 1)
 *   - Verify balance_proof proof (circuit 2)
 *   - Close proof buffer and recover rent
 *   - Reject double verification
 *   - Reject invalid circuit ID
 *   - Handle proof buffer resize for >10KB proofs
 *
 * Program ID: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 *
 * Run:
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..."
 *   ANCHOR_WALLET=~/.config/solana/id.json
 *   ts-mocha -p tsconfig.test.json tests/e2e-stark-flow.test.ts --timeout 300000
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  Connection,
  ComputeBudgetProgram,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import { execSync } from 'child_process';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PROGRAM_ID = new PublicKey('DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs');
const CIRCUIT_SUBSCRIBER_OWNERSHIP = 0;
const CIRCUIT_POOL_COMMITMENT = 1;
const CIRCUIT_BALANCE_PROOF = 2;
const PROOF_DATA_OFFSET = 50; // 8 disc + 32 pubkey + 1 circuit_id + 4 proof_size + 4 bytes_written + 1 verified
const MAX_CHUNK_SIZE = 900;

// ---------------------------------------------------------------------------
// IDL (inline — no anchor build required for devnet testing)
// ---------------------------------------------------------------------------
const IDL = {
  address: 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
  metadata: {
    name: 'p01_stark_verifier',
    version: '0.1.0',
    spec: '0.1.0',
  },
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
    {
      name: 'ProofBuffer',
      discriminator: [71, 133, 225, 94, 9, 130, 40, 161],
    },
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Retry an async operation with exponential backoff (handles blockhash errors) */
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

/** Generate a compact STARK proof using the Rust binary */
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

/** Generate a compact pool commitment STARK proof */
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

/** Generate a compact balance STARK proof */
function generateBalanceProof(sk: number, balance: number, salt: number, mint: number): {
  circuitId: number; publicInputs: bigint[]; proofBytes: Buffer;
} {
  const projectRoot = path.resolve(__dirname, '..');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- balance ${sk} ${balance} ${salt} ${mint}`,
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

/** Build resize_proof_buffer instruction */
function buildResizeProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
): anchor.web3.TransactionInstruction {
  const discriminator = Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]);
  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
}

/** Build verify_stark_proof_v2 instruction manually */
function buildVerifyStarkProofV2Ix(
  proofBuffer: PublicKey,
  authority: PublicKey,
  publicInputs: bigint[],
): anchor.web3.TransactionInstruction {
  const discriminator = Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]);
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map((v) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  });
  const data = Buffer.concat([discriminator, vecLen, ...inputBufs]);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Derive the ProofBuffer PDA */
function getProofBufferPDA(authority: PublicKey, circuitId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stark_proof'), authority.toBuffer(), Buffer.from([circuitId])],
    PROGRAM_ID,
  );
}

/** Upload proof in chunks with confirmation between each */
async function uploadProofChunks(
  program: Program,
  proofBuffer: PublicKey,
  authority: Keypair,
  proofBytes: Buffer,
  connection: Connection,
): Promise<void> {
  const chunks: { offset: number; data: Buffer }[] = [];
  for (let offset = 0; offset < proofBytes.length; offset += MAX_CHUNK_SIZE) {
    chunks.push({
      offset,
      data: proofBytes.subarray(offset, Math.min(offset + MAX_CHUNK_SIZE, proofBytes.length)),
    });
  }

  for (const chunk of chunks) {
    await withRetry(async () => {
      const tx = await program.methods
        .writeProofChunk(chunk.offset, chunk.data)
        .accounts({
          proofBuffer,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc({ commitment: 'confirmed', skipPreflight: true });

      await connection.confirmTransaction(tx, 'confirmed');
    });
  }
}

/** Clean up stale PDA from previous failed runs */
async function cleanupStalePDA(
  program: Program,
  pda: PublicKey,
  authority: Keypair,
  provider: AnchorProvider,
): Promise<void> {
  const existing = await provider.connection.getAccountInfo(pda);
  if (existing) {
    console.log('    Found stale PDA, closing it...');
    try {
      const cTx = await program.methods
        .closeProofBuffer()
        .accounts({ proofBuffer: pda, authority: authority.publicKey })
        .signers([authority])
        .rpc({ commitment: 'confirmed', skipPreflight: true });
      await provider.connection.confirmTransaction(cTx, 'confirmed');
      console.log('    Stale PDA closed successfully');
    } catch (err: any) {
      console.log(`    Warning: stale PDA cleanup failed: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('E2E: STARK Proof Flow', () => {
  const provider = new AnchorProvider(
    AnchorProvider.env().connection,
    AnchorProvider.env().wallet,
    {
      preflightCommitment: 'confirmed',
      commitment: 'confirmed',
    },
  );
  anchor.setProvider(provider);

  const program = new Program(IDL, provider);
  const authority = (provider.wallet as anchor.Wallet).payer;

  // ─────────────────────────────────────────────────────────────────
  // Circuit 0: subscriber_ownership — full lifecycle
  // ─────────────────────────────────────────────────────────────────
  describe('subscriber_ownership (circuit 0)', () => {
    let proofBytes: Buffer;
    let commitment: bigint;
    let proofBufferPDA: PublicKey;

    before('generate compact proof and clean up stale PDA', async () => {
      console.log('    Generating compact STARK proof (secret=42)...');
      const proof = generateCompactProof(42);
      proofBytes = proof.proofBytes;
      commitment = proof.commitment;
      console.log(`    Proof size: ${proofBytes.length} bytes, commitment: ${commitment}`);

      [proofBufferPDA] = getProofBufferPDA(authority.publicKey, CIRCUIT_SUBSCRIBER_OWNERSHIP);
      await cleanupStalePDA(program, proofBufferPDA, authority, provider);
    });

    it('initializes proof buffer', async () => {
      await withRetry(async () => {
        const tx = await program.methods
          .initProofBuffer(proofBytes.length, CIRCUIT_SUBSCRIBER_OWNERSHIP)
          .accounts({
            proofBuffer: proofBufferPDA,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });

        console.log(`    init_proof_buffer tx: ${tx}`);
      });

      const account = await (program.account as any).proofBuffer.fetch(proofBufferPDA);
      expect(account.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(account.circuitId).to.equal(CIRCUIT_SUBSCRIBER_OWNERSHIP);
      expect(account.proofSize).to.equal(proofBytes.length);
      expect(account.bytesWritten).to.equal(0);
      expect(account.verified).to.equal(false);
    });

    it('uploads proof chunks (multi-tx)', async () => {
      const numChunks = Math.ceil(proofBytes.length / MAX_CHUNK_SIZE);
      console.log(`    Uploading ${proofBytes.length} bytes in ${numChunks} chunks...`);

      await uploadProofChunks(program, proofBufferPDA, authority, proofBytes, provider.connection);

      const account = await (program.account as any).proofBuffer.fetch(proofBufferPDA);
      expect(account.bytesWritten).to.be.gte(proofBytes.length);
      console.log(`    Upload complete: ${account.bytesWritten} bytes written`);
    });

    it('verifies subscriber_ownership proof (circuit 0)', async () => {
      console.log(`    Verifying proof with commitment=${commitment}...`);

      await withRetry(async () => {
        const tx = await program.methods
          .verifyStarkProof(new BN(commitment.toString()))
          .accounts({
            proofBuffer: proofBufferPDA,
            authority: authority.publicKey,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ])
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });

        console.log(`    verify_stark_proof tx: ${tx}`);
      });

      const account = await (program.account as any).proofBuffer.fetch(proofBufferPDA);
      expect(account.verified).to.equal(true);
      console.log('    Proof verified on-chain!');
    });

    it('rejects double verification of same proof', async () => {
      try {
        await program.methods
          .verifyStarkProof(new BN(commitment.toString()))
          .accounts({
            proofBuffer: proofBufferPDA,
            authority: authority.publicKey,
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ])
          .signers([authority])
          .rpc({ commitment: 'confirmed' });
        expect.fail('Should have thrown AlreadyVerified');
      } catch (err: any) {
        expect(err.toString()).to.include('AlreadyVerified');
      }
    });

    it('closes proof buffer and recovers rent', async () => {
      const balanceBefore = await provider.connection.getBalance(authority.publicKey);

      await withRetry(async () => {
        const tx = await program.methods
          .closeProofBuffer()
          .accounts({
            proofBuffer: proofBufferPDA,
            authority: authority.publicKey,
          })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });

        console.log(`    close_proof_buffer tx: ${tx}`);
      });

      const balanceAfter = await provider.connection.getBalance(authority.publicKey);
      const recovered = balanceAfter - balanceBefore;
      console.log(`    Recovered ${recovered / 1e9} SOL in rent`);
      expect(recovered).to.be.gt(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Circuit 1: pool_commitment — verify with v2 (multi-input)
  // ─────────────────────────────────────────────────────────────────
  describe('pool_commitment (circuit 1)', () => {
    let poolProofBytes: Buffer;
    let poolPublicInputs: bigint[];
    let poolPDA: PublicKey;

    before('generate pool commitment proof', async () => {
      console.log('    Generating pool commitment STARK proof...');
      const proof = generatePoolCommitmentProof(123, 456, 1, 999);
      poolProofBytes = proof.proofBytes;
      poolPublicInputs = proof.publicInputs;
      console.log(`    Pool proof size: ${poolProofBytes.length} bytes`);
      console.log(`    Public inputs: [${poolPublicInputs[0]}, ${poolPublicInputs[1]}]`);

      [poolPDA] = getProofBufferPDA(authority.publicKey, CIRCUIT_POOL_COMMITMENT);
      await cleanupStalePDA(program, poolPDA, authority, provider);
    });

    it('verifies pool_commitment proof (circuit 1)', async () => {
      // Init
      const initData = Buffer.alloc(8 + 4 + 1);
      Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]).copy(initData, 0);
      initData.writeUInt32LE(poolProofBytes.length, 8);
      initData.writeUInt8(CIRCUIT_POOL_COMMITMENT, 12);

      const initIx = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: poolPDA, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initData,
      });
      await withRetry(async () => {
        await sendAndConfirmTransaction(
          provider.connection,
          new Transaction().add(initIx),
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
      });

      // Resize if needed
      if (poolProofBytes.length + PROOF_DATA_OFFSET > 10240) {
        const resizeIx = buildResizeProofBufferIx(poolPDA, authority.publicKey);
        await withRetry(async () => {
          await sendAndConfirmTransaction(
            provider.connection,
            new Transaction().add(resizeIx),
            [authority],
            { commitment: 'confirmed', skipPreflight: true },
          );
        });
        console.log('    Resized proof buffer');
      }

      // Upload
      await uploadProofChunks(program, poolPDA, authority, poolProofBytes, provider.connection);
      console.log(`    Upload complete: ${poolProofBytes.length} bytes written`);

      // Verify with v2
      const verifyIx = buildVerifyStarkProofV2Ix(poolPDA, authority.publicKey, poolPublicInputs);
      const verifyTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(verifyIx);

      await withRetry(async () => {
        const sig = await sendAndConfirmTransaction(
          provider.connection,
          verifyTx,
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
        console.log(`    verify_stark_proof_v2 tx: ${sig}`);
      });

      const account = await (program.account as any).proofBuffer.fetch(poolPDA);
      expect(account.verified).to.be.true;
      expect(account.circuitId).to.equal(CIRCUIT_POOL_COMMITMENT);
      console.log('    Pool commitment proof verified on-chain!');
    });

    after('close pool proof buffer', async () => {
      try {
        await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: poolPDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      } catch (_) {}
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Circuit 2: balance_proof — verify with v2
  // ─────────────────────────────────────────────────────────────────
  describe('balance_proof (circuit 2)', () => {
    let balProofBytes: Buffer;
    let balPublicInputs: bigint[];
    let balPDA: PublicKey;

    before('generate balance proof', async () => {
      console.log('    Generating balance STARK proof...');
      const proof = generateBalanceProof(777, 1000000, 42, 888);
      balProofBytes = proof.proofBytes;
      balPublicInputs = proof.publicInputs;
      console.log(`    Balance proof size: ${balProofBytes.length} bytes`);
      console.log(`    Public inputs: [${balPublicInputs[0]}, ${balPublicInputs[1]}]`);

      [balPDA] = getProofBufferPDA(authority.publicKey, CIRCUIT_BALANCE_PROOF);
      await cleanupStalePDA(program, balPDA, authority, provider);
    });

    it('verifies balance_proof proof (circuit 2)', async () => {
      // Init
      const initData = Buffer.alloc(8 + 4 + 1);
      Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]).copy(initData, 0);
      initData.writeUInt32LE(balProofBytes.length, 8);
      initData.writeUInt8(CIRCUIT_BALANCE_PROOF, 12);

      const initIx = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: balPDA, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initData,
      });
      await withRetry(async () => {
        await sendAndConfirmTransaction(
          provider.connection,
          new Transaction().add(initIx),
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
      });

      // Resize if needed
      if (balProofBytes.length + PROOF_DATA_OFFSET > 10240) {
        const resizeIx = buildResizeProofBufferIx(balPDA, authority.publicKey);
        await withRetry(async () => {
          await sendAndConfirmTransaction(
            provider.connection,
            new Transaction().add(resizeIx),
            [authority],
            { commitment: 'confirmed', skipPreflight: true },
          );
        });
        console.log('    Resized proof buffer');
      }

      // Upload
      await uploadProofChunks(program, balPDA, authority, balProofBytes, provider.connection);
      console.log(`    Upload complete: ${balProofBytes.length} bytes written`);

      // Verify
      const verifyIx = buildVerifyStarkProofV2Ix(balPDA, authority.publicKey, balPublicInputs);
      const verifyTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(verifyIx);

      await withRetry(async () => {
        const sig = await sendAndConfirmTransaction(
          provider.connection,
          verifyTx,
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
        console.log(`    verify_stark_proof_v2 tx: ${sig}`);
      });

      const account = await (program.account as any).proofBuffer.fetch(balPDA);
      expect(account.verified).to.be.true;
      expect(account.circuitId).to.equal(CIRCUIT_BALANCE_PROOF);
      console.log('    Balance proof verified on-chain!');
    });

    after('close balance proof buffer', async () => {
      try {
        await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: balPDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      } catch (_) {}
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Error cases
  // ─────────────────────────────────────────────────────────────────
  describe('error cases', () => {
    it('rejects invalid circuit ID', async () => {
      const invalidCircuitId = 255;
      const [invalidPDA] = getProofBufferPDA(authority.publicKey, invalidCircuitId);

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

    it('handles proof buffer resize for >10KB proofs', async () => {
      // Test that resize instruction works on a buffer that needs expansion
      const circuitId = CIRCUIT_SUBSCRIBER_OWNERSHIP;
      const [resizePDA] = getProofBufferPDA(authority.publicKey, circuitId);

      await cleanupStalePDA(program, resizePDA, authority, provider);

      // Init with a small size first
      const smallSize = 100;
      await withRetry(async () => {
        await program.methods
          .initProofBuffer(smallSize, circuitId)
          .accounts({
            proofBuffer: resizePDA,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      });

      // Verify initial size
      const accountBefore = await (program.account as any).proofBuffer.fetch(resizePDA);
      expect(accountBefore.proofSize).to.equal(smallSize);

      // Resize
      const resizeIx = buildResizeProofBufferIx(resizePDA, authority.publicKey);
      await withRetry(async () => {
        await sendAndConfirmTransaction(
          provider.connection,
          new Transaction().add(resizeIx),
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
      });

      console.log('    Resize instruction executed successfully');

      // Clean up
      try {
        await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: resizePDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      } catch (_) {}
    });
  });
});
