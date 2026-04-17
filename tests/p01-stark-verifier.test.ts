/**
 * p01_stark_verifier - On-chain STARK Proof Verification Test
 *
 * Tests the quantum-resistant STARK verifier on Solana devnet.
 * The compact proof is generated off-chain (Rust: stark/src/compact.rs)
 * and verified on-chain by the p01_stark_verifier program.
 *
 * Program ID: EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z (devnet, per Anchor.toml)
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
const PROGRAM_ID = new PublicKey('EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z');
const CIRCUIT_SUBSCRIBER_OWNERSHIP = 0;
const CIRCUIT_POOL_COMMITMENT = 1;
const CIRCUIT_BALANCE_PROOF = 2;
const CIRCUIT_MERKLE_PATH = 3;
const CIRCUIT_CONFIDENTIAL_BALANCE = 4;
const CIRCUIT_TRANSFER = 5;
const CIRCUIT_MERKLE_UPDATE = 6;
// 8 discriminator + 32 pubkey + 1 circuit_id + 4 proof_size + 4 bytes_written +
// 1 verified + 32 public_inputs_hash + 1 deep_ali_verified = 83
const PROOF_DATA_OFFSET = 83;
const MAX_CHUNK_SIZE = 900; // Safe chunk size for Solana tx

// ---------------------------------------------------------------------------
// IDL (inline for devnet testing without anchor build)
// ---------------------------------------------------------------------------
const IDL = {
  address: 'EXmAQqmkQmq1vnSmKXY2rnUUrrWHqxddjXaJv8aNEL4Z',
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
          { name: 'public_inputs_hash', type: { array: ['u8', 32] } },
          { name: 'deep_ali_verified', type: 'bool' },
        ],
      },
    },
  ],
} as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a compact STARK proof using the Rust binary */
function generateCompactProof(secret: number): { commitment: bigint; proofBytes: Buffer } {
  const projectRoot = path.resolve(__dirname, '..');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- ${secret}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 60000 }
  );

  // Extract commitment as string first (u64 exceeds Number.MAX_SAFE_INTEGER)
  const commitmentMatch = output.match(/"commitment":\s*(\d+)/);
  if (!commitmentMatch) throw new Error('Could not parse commitment from gen_proof output');

  // Parse the rest via JSON
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));

  return {
    commitment: BigInt(commitmentMatch[1]),
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

/** Generate a compact pool commitment STARK proof using the Rust binary */
function generatePoolCommitmentProof(np: number, secret: number, epoch: number, mint: number): {
  circuitId: number; publicInputs: bigint[]; proofBytes: Buffer;
} {
  const projectRoot = path.resolve(__dirname, '..');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- pool ${np} ${secret} ${epoch} ${mint}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 60000 }
  );
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  // Parse public_inputs as BigInt from the array
  const inputsMatch = output.match(/"public_inputs":\s*\[(\d+),\s*(\d+)\]/);
  if (!inputsMatch) throw new Error('Could not parse public_inputs');
  return {
    circuitId: json.circuit_id,
    publicInputs: [BigInt(inputsMatch[1]), BigInt(inputsMatch[2])],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

/** Generate a compact balance STARK proof using the Rust binary */
function generateBalanceProof(sk: number, balance: number, salt: number, mint: number): {
  circuitId: number; publicInputs: bigint[]; proofBytes: Buffer;
} {
  const projectRoot = path.resolve(__dirname, '..');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- balance ${sk} ${balance} ${salt} ${mint}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 60000 }
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

/** Generate a compact merkle-path STARK proof using the Rust binary.
 *  Public inputs: [leaf, root]. */
function generateMerklePathProof(
  leaf: number, elements: number[], indices: number[],
): { circuitId: number; publicInputs: bigint[]; proofBytes: Buffer } {
  const projectRoot = path.resolve(__dirname, '..');
  const elemsArg = elements.join(',');
  const indicesArg = indices.join(',');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- merkle ${leaf} ${elemsArg} ${indicesArg}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 }
  );
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputsMatch = output.match(/"public_inputs":\s*\[(\d+),\s*(\d+)\]/);
  if (!inputsMatch) throw new Error('Could not parse merkle-path public_inputs');
  return {
    circuitId: json.circuit_id,
    publicInputs: [BigInt(inputsMatch[1]), BigInt(inputsMatch[2])],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

/** Generate a compact confidential-balance STARK proof using the Rust binary.
 *  Public inputs: [old_commit, new_commit, amt_commit, mint]. */
function generateConfidentialBalanceProof(
  sk: number, oldBal: number, oldSalt: number, newBal: number, newSalt: number,
  amount: number, amtSalt: number, mint: number,
): { circuitId: number; publicInputs: bigint[]; proofBytes: Buffer } {
  const projectRoot = path.resolve(__dirname, '..');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- confidential ${sk} ${oldBal} ${oldSalt} ${newBal} ${newSalt} ${amount} ${amtSalt} ${mint}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 }
  );
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputsMatch = output.match(
    /"public_inputs":\s*\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]/
  );
  if (!inputsMatch) throw new Error('Could not parse confidential public_inputs');
  return {
    circuitId: json.circuit_id,
    publicInputs: [
      BigInt(inputsMatch[1]), BigInt(inputsMatch[2]),
      BigInt(inputsMatch[3]), BigInt(inputsMatch[4]),
    ],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

/** Generate a compact transfer STARK proof using the Rust binary.
 *  Public inputs: [in1_nullifier, in2_nullifier, out1_commit, out2_commit, mint, pub_amt]. */
function generateTransferProof(
  sk: number, mint: number,
  in1Amt: number, in1Rand: number, in2Amt: number, in2Rand: number,
  out1Amt: number, out1Rcpt: number, out1Rand: number,
  out2Amt: number, out2Rcpt: number, out2Rand: number,
  pubAmt: number,
): { circuitId: number; publicInputs: bigint[]; proofBytes: Buffer } {
  const projectRoot = path.resolve(__dirname, '..');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- transfer ${sk} ${mint} ${in1Amt} ${in1Rand} ${in2Amt} ${in2Rand} ${out1Amt} ${out1Rcpt} ${out1Rand} ${out2Amt} ${out2Rcpt} ${out2Rand} ${pubAmt}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 180000 }
  );
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputsMatch = output.match(
    /"public_inputs":\s*\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]/
  );
  if (!inputsMatch) throw new Error('Could not parse transfer public_inputs');
  return {
    circuitId: json.circuit_id,
    publicInputs: [
      BigInt(inputsMatch[1]), BigInt(inputsMatch[2]), BigInt(inputsMatch[3]),
      BigInt(inputsMatch[4]), BigInt(inputsMatch[5]), BigInt(inputsMatch[6]),
    ],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

/** Generate a compact merkle-update STARK proof using the Rust binary.
 *  Public inputs: [old_leaf, new_leaf, old_root, new_root, depth]. */
function generateMerkleUpdateProof(
  oldLeaf: number, newLeaf: number, elements: number[], indices: number[],
): { circuitId: number; publicInputs: bigint[]; proofBytes: Buffer } {
  const projectRoot = path.resolve(__dirname, '..');
  const elemsArg = elements.join(',');
  const indicesArg = indices.join(',');
  const output = execSync(
    `cargo run --bin gen_proof -p p01-stark -- merkle-update ${oldLeaf} ${newLeaf} ${elemsArg} ${indicesArg}`,
    { cwd: projectRoot, encoding: 'utf-8', timeout: 120000 }
  );
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputsMatch = output.match(
    /"public_inputs":\s*\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]/
  );
  if (!inputsMatch) throw new Error('Could not parse merkle-update public_inputs');
  return {
    circuitId: json.circuit_id,
    publicInputs: [
      BigInt(inputsMatch[1]), BigInt(inputsMatch[2]), BigInt(inputsMatch[3]),
      BigInt(inputsMatch[4]), BigInt(inputsMatch[5]),
    ],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

/** Build resize_proof_buffer instruction for proofs > 10KB */
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

/** Iteratively resize a proof buffer until it reaches the target size.
 * Solana caps per-tx data growth at 10KB (MAX_PERMITTED_DATA_INCREASE),
 * so larger proofs need multiple resize calls. */
async function resizeProofBufferTo(
  connection: Connection,
  proofBuffer: PublicKey,
  authority: Keypair,
  targetProofSize: number,
): Promise<number> {
  const targetAccountSize = targetProofSize + PROOF_DATA_OFFSET;
  let calls = 0;
  while (true) {
    const info = await connection.getAccountInfo(proofBuffer, 'confirmed');
    if (!info) throw new Error('proof buffer missing');
    if (info.data.length >= targetAccountSize) break;
    const ix = buildResizeProofBufferIx(proofBuffer, authority.publicKey);
    await sendAndConfirmTransaction(
      connection, new Transaction().add(ix), [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
    calls += 1;
  }
  return calls;
}

/** Build verify_stark_proof_v2 instruction manually (bypasses IDL limitations) */
function buildVerifyStarkProofV2Ix(
  proofBuffer: PublicKey,
  authority: PublicKey,
  publicInputs: bigint[],
): anchor.web3.TransactionInstruction {
  // Discriminator: sha256("global:verify_stark_proof_v2")[0..8]
  const discriminator = Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]);
  // Borsh Vec<u64>: 4-byte length prefix + N * 8 bytes
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(v => {
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

/**
 * [P2.2e] Build `verify_merkle_update_deep_ali` — phase 2 of the circuit 6
 * split verify. Must run AFTER `verify_stark_proof_v2` (phase 1) succeeds.
 * Public inputs must match phase 1 byte-for-byte; the on-chain instruction
 * hashes them and compares to the phase-1 stored hash (α derivation depends
 * on pub inputs, so any change invalidates the DEEP-ALI identity).
 */
function buildVerifyMerkleUpdateDeepAliIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
  publicInputs: bigint[],
): anchor.web3.TransactionInstruction {
  // Discriminator: sha256("global:verify_merkle_update_deep_ali")[0..8]
  const discriminator = Buffer.from([32, 153, 189, 232, 187, 32, 161, 142]);
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(v => {
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

/**
 * [P2.2g] Generic phase-2 DEEP-ALI dispatcher — handles circuits 3/4/5/6.
 * Same semantics as `verify_merkle_update_deep_ali` but not pinned to a
 * single circuit ID. C3/C4/C5 exceed 1.4M CU when DEEP-ALI runs inside
 * `verify_stark_proof_v2`, so they now phase-split through this instruction
 * like C6 already did.
 */
function buildVerifyDeepAliPhase2Ix(
  proofBuffer: PublicKey,
  authority: PublicKey,
  publicInputs: bigint[],
): anchor.web3.TransactionInstruction {
  // Discriminator: sha256("global:verify_deep_ali_phase2")[0..8]
  const discriminator = Buffer.from([217, 239, 203, 65, 109, 182, 70, 115]);
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map(v => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  });
  const dataPhase2 = Buffer.concat([discriminator, vecLen, ...inputBufs]);

  return new anchor.web3.TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: dataPhase2,
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
    const tx = await program.methods
      .writeProofChunk(chunk.offset, chunk.data)
      .accounts({
        proofBuffer,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc({ commitment: 'confirmed', skipPreflight: true });

    // Wait for confirmation before sending next chunk
    await connection.confirmTransaction(tx, 'confirmed');
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('p01_stark_verifier', () => {
  // Force confirmed commitment to avoid stale blockhash issues on devnet
  const opts: anchor.web3.ConfirmOptions = {
    preflightCommitment: 'confirmed',
    commitment: 'confirmed',
  };
  const provider = AnchorProvider.env();
  provider.opts = opts;
  anchor.setProvider(provider);

  const program = new Program(IDL, provider);
  const authority = (provider.wallet as anchor.Wallet).payer;

  let proofBytes: Buffer;
  let commitment: bigint;
  let proofBufferPDA: PublicKey;
  let proofBufferBump: number;

  before('Generate compact STARK proof and clean up stale PDA', async () => {
    console.log('    Generating compact STARK proof (secret=42)...');
    const proof = generateCompactProof(42);
    proofBytes = proof.proofBytes;
    commitment = proof.commitment;

    console.log(`    Proof size: ${proofBytes.length} bytes`);
    console.log(`    Commitment: ${commitment}`);

    [proofBufferPDA, proofBufferBump] = getProofBufferPDA(
      authority.publicKey,
      CIRCUIT_SUBSCRIBER_OWNERSHIP,
    );
    console.log(`    ProofBuffer PDA: ${proofBufferPDA.toBase58()}`);

    // Clean up stale PDA from previous failed runs
    const existing = await provider.connection.getAccountInfo(proofBufferPDA);
    if (existing) {
      console.log('    Found stale PDA, closing it...');
      try {
        const cTx = await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: proofBufferPDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
        await provider.connection.confirmTransaction(cTx, 'confirmed');
        console.log('    Stale PDA closed successfully');
      } catch (err: any) {
        console.log(`    Warning: stale PDA cleanup failed: ${err.message}`);
      }
    }
  });

  it('initializes proof buffer', async () => {
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

    // Verify account state
    const account = await (program.account as any).proofBuffer.fetch(proofBufferPDA);
    expect(account.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(account.circuitId).to.equal(CIRCUIT_SUBSCRIBER_OWNERSHIP);
    expect(account.proofSize).to.equal(proofBytes.length);
    expect(account.bytesWritten).to.equal(0);
    expect(account.verified).to.equal(false);
  });

  it('uploads proof in chunks', async () => {
    const numChunks = Math.ceil(proofBytes.length / MAX_CHUNK_SIZE);
    console.log(`    Uploading ${proofBytes.length} bytes in ${numChunks} chunks...`);

    if (proofBytes.length + PROOF_DATA_OFFSET > 10240) {
      const calls = await resizeProofBufferTo(
        provider.connection, proofBufferPDA, authority, proofBytes.length,
      );
      console.log(`    Resized to ${proofBytes.length + PROOF_DATA_OFFSET} bytes (${calls} calls)`);
    }

    await uploadProofChunks(program, proofBufferPDA, authority, proofBytes, provider.connection);

    const account = await (program.account as any).proofBuffer.fetch(proofBufferPDA);
    expect(account.bytesWritten).to.be.gte(proofBytes.length);
    console.log(`    Upload complete: ${account.bytesWritten} bytes written`);
  });

  it('verifies STARK proof on-chain', async () => {
    console.log(`    Verifying proof with commitment=${commitment}...`);

    // Raw instruction: discriminator [208,216,183,38,47,69,156,138] + u64 LE commitment
    const verifyData = Buffer.alloc(8 + 8);
    Buffer.from([208, 216, 183, 38, 47, 69, 156, 138]).copy(verifyData, 0);
    verifyData.writeBigUInt64LE(commitment, 8);
    const verifyIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: proofBufferPDA, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: verifyData,
    });
    const verifyTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(verifyIx);

    const tx = await sendAndConfirmTransaction(
      provider.connection, verifyTx, [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );

    console.log(`    verify_stark_proof tx: ${tx}`);

    const account = await (program.account as any).proofBuffer.fetch(proofBufferPDA);
    expect(account.verified).to.equal(true);
    console.log('    Proof verified on-chain!');
  });

  it('rejects double verification', async () => {
    const verifyData = Buffer.alloc(8 + 8);
    Buffer.from([208, 216, 183, 38, 47, 69, 156, 138]).copy(verifyData, 0);
    verifyData.writeBigUInt64LE(commitment, 8);
    const verifyIx = new anchor.web3.TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: proofBufferPDA, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: verifyData,
    });
    const verifyTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(verifyIx);

    try {
      await sendAndConfirmTransaction(
        provider.connection, verifyTx, [authority],
        { commitment: 'confirmed' },
      );
      expect.fail('Should have thrown AlreadyVerified');
    } catch (err: any) {
      const msg = (err.toString() || '') + ' ' + JSON.stringify(err.logs || []);
      expect(msg).to.match(/AlreadyVerified|custom program error: 0x1770/);
    }
  });

  it('closes proof buffer and recovers rent', async () => {
    const balanceBefore = await provider.connection.getBalance(authority.publicKey);

    const tx = await program.methods
      .closeProofBuffer()
      .accounts({
        proofBuffer: proofBufferPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc({ commitment: 'confirmed', skipPreflight: true });

    console.log(`    close_proof_buffer tx: ${tx}`);

    const balanceAfter = await provider.connection.getBalance(authority.publicKey);
    const recovered = balanceAfter - balanceBefore;
    console.log(`    Recovered ${recovered / 1e9} SOL in rent`);
    expect(recovered).to.be.gt(0);
  });

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
        errStr.includes('UnsupportedCircuit') || errStr.includes('6005') || errStr.includes('Simulation failed')
      ).to.be.true;
    }
  });

  // =========================================================================
  // Pool Commitment Proof (Circuit 1) — end-to-end
  // =========================================================================

  describe('pool commitment proof (circuit 1)', () => {
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

      // Clean up stale PDA
      const existing = await provider.connection.getAccountInfo(poolPDA);
      if (existing) {
        try {
          const cTx = await program.methods
            .closeProofBuffer()
            .accounts({ proofBuffer: poolPDA, authority: authority.publicKey })
            .signers([authority])
            .rpc({ commitment: 'confirmed', skipPreflight: true });
          await provider.connection.confirmTransaction(cTx, 'confirmed');
        } catch (_) {}
      }
    });

    it('init + upload + verify pool proof with v2', async () => {
      // Init — raw instruction
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
      await sendAndConfirmTransaction(
        provider.connection, new Transaction().add(initIx), [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );

      // Resize if proof > 10KB — iterate until target size reached
      if (poolProofBytes.length + PROOF_DATA_OFFSET > 10240) {
        const calls = await resizeProofBufferTo(
          provider.connection, poolPDA, authority, poolProofBytes.length,
        );
        console.log(`    Resized to ${poolProofBytes.length + PROOF_DATA_OFFSET} bytes (${calls} calls)`);
      }

      // Upload chunks
      await uploadProofChunks(program, poolPDA, authority, poolProofBytes, provider.connection);
      console.log(`    Upload complete: ${poolProofBytes.length} bytes written`);

      // Verify with v2 (multiple public inputs)
      const verifyIx = buildVerifyStarkProofV2Ix(poolPDA, authority.publicKey, poolPublicInputs);
      const verifyTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(verifyIx);

      const sig = await sendAndConfirmTransaction(
        provider.connection, verifyTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_stark_proof_v2 tx (phase 1): ${sig}`);

      // Verify account state
      const account = await (program.account as any).proofBuffer.fetch(poolPDA);
      expect(account.verified).to.be.true;
      expect(account.circuitId).to.equal(CIRCUIT_POOL_COMMITMENT);
      console.log('    Phase 1 (verify_stark_proof_v2) OK: FRI + trace-aligned + boundary');

      // [P2.2g] Phase 2 — DEEP-ALI at OOD for C1.
      const deepAliIx = buildVerifyDeepAliPhase2Ix(poolPDA, authority.publicKey, poolPublicInputs);
      const deepAliTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(deepAliIx);
      const deepSig = await sendAndConfirmTransaction(
        provider.connection, deepAliTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_deep_ali_phase2 tx (phase 2): ${deepSig}`);
      const account2 = await (program.account as any).proofBuffer.fetch(poolPDA);
      expect(account2.deepAliVerified).to.be.true;
      console.log('    Phase 2 (DEEP-ALI at OOD) OK — C1 full 4-constraint soundness');
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

  // =========================================================================
  // Balance Proof (Circuit 2) — end-to-end
  // =========================================================================

  describe('balance proof (circuit 2)', () => {
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

      const existing = await provider.connection.getAccountInfo(balPDA);
      if (existing) {
        try {
          const cTx = await program.methods
            .closeProofBuffer()
            .accounts({ proofBuffer: balPDA, authority: authority.publicKey })
            .signers([authority])
            .rpc({ commitment: 'confirmed', skipPreflight: true });
          await provider.connection.confirmTransaction(cTx, 'confirmed');
        } catch (_) {}
      }
    });

    it('init + upload + verify balance proof with v2', async () => {
      // Init — raw instruction
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
      await sendAndConfirmTransaction(
        provider.connection, new Transaction().add(initIx), [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );

      // Resize if proof > 10KB — iterate until target size reached
      if (balProofBytes.length + PROOF_DATA_OFFSET > 10240) {
        const calls = await resizeProofBufferTo(
          provider.connection, balPDA, authority, balProofBytes.length,
        );
        console.log(`    Resized to ${balProofBytes.length + PROOF_DATA_OFFSET} bytes (${calls} calls)`);
      }

      // Upload
      await uploadProofChunks(program, balPDA, authority, balProofBytes, provider.connection);
      console.log(`    Upload complete: ${balProofBytes.length} bytes written`);

      // Verify
      const verifyIx = buildVerifyStarkProofV2Ix(balPDA, authority.publicKey, balPublicInputs);
      const verifyTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(verifyIx);

      const sig = await sendAndConfirmTransaction(
        provider.connection, verifyTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_stark_proof_v2 tx (phase 1): ${sig}`);

      const account = await (program.account as any).proofBuffer.fetch(balPDA);
      expect(account.verified).to.be.true;
      expect(account.circuitId).to.equal(CIRCUIT_BALANCE_PROOF);
      console.log('    Phase 1 (verify_stark_proof_v2) OK: FRI + trace-aligned + boundary');

      // [P2.2g] Phase 2 — DEEP-ALI at OOD for C2.
      const deepAliIx = buildVerifyDeepAliPhase2Ix(balPDA, authority.publicKey, balPublicInputs);
      const deepAliTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(deepAliIx);
      const deepSig = await sendAndConfirmTransaction(
        provider.connection, deepAliTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_deep_ali_phase2 tx (phase 2): ${deepSig}`);
      const account2 = await (program.account as any).proofBuffer.fetch(balPDA);
      expect(account2.deepAliVerified).to.be.true;
      console.log('    Phase 2 (DEEP-ALI at OOD) OK — C2 full 7-constraint soundness');
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

  // =========================================================================
  // Merkle Path (Circuit 3) — end-to-end
  // =========================================================================
  //
  // Proves that leaf hashes up to root via sibling+direction witnesses.
  // Circuit 3 uses width=6 with trace_length=512 and is DEEP-ALI-hardened
  // on-chain since P2.2d-C3 (commit 6c61627).

  describe('merkle path (circuit 3)', () => {
    let mpProofBytes: Buffer;
    let mpPublicInputs: bigint[];
    let mpPDA: PublicKey;

    before('generate merkle-path proof', async () => {
      console.log('    Generating merkle-path STARK proof (depth 15)...');
      // Same depth logic as C6: trace_length=512 ⇒ depth 8-15 all fit.
      const elements = Array.from({ length: 15 }, (_, i) => 200 + i * 17);
      const indices = Array.from({ length: 15 }, (_, i) => (i + 1) % 2);
      const proof = generateMerklePathProof(333, elements, indices);
      mpProofBytes = proof.proofBytes;
      mpPublicInputs = proof.publicInputs;
      console.log(`    Merkle-path proof size: ${mpProofBytes.length} bytes`);
      console.log(`    Public inputs: [leaf=${mpPublicInputs[0]}, root=${mpPublicInputs[1]}]`);

      [mpPDA] = getProofBufferPDA(authority.publicKey, CIRCUIT_MERKLE_PATH);

      const existing = await provider.connection.getAccountInfo(mpPDA);
      if (existing) {
        try {
          const cTx = await program.methods
            .closeProofBuffer()
            .accounts({ proofBuffer: mpPDA, authority: authority.publicKey })
            .signers([authority])
            .rpc({ commitment: 'confirmed', skipPreflight: true });
          await provider.connection.confirmTransaction(cTx, 'confirmed');
        } catch (_) {}
      }
    });

    it('init + upload + verify merkle-path proof with v2', async () => {
      const initData = Buffer.alloc(8 + 4 + 1);
      Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]).copy(initData, 0);
      initData.writeUInt32LE(mpProofBytes.length, 8);
      initData.writeUInt8(CIRCUIT_MERKLE_PATH, 12);

      const initIx = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: mpPDA, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initData,
      });
      await sendAndConfirmTransaction(
        provider.connection, new Transaction().add(initIx), [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );

      if (mpProofBytes.length + PROOF_DATA_OFFSET > 10240) {
        const calls = await resizeProofBufferTo(
          provider.connection, mpPDA, authority, mpProofBytes.length,
        );
        console.log(`    Resized to ${mpProofBytes.length + PROOF_DATA_OFFSET} bytes (${calls} calls)`);
      }

      await uploadProofChunks(program, mpPDA, authority, mpProofBytes, provider.connection);
      console.log(`    Upload complete: ${mpProofBytes.length} bytes written`);

      const verifyIx = buildVerifyStarkProofV2Ix(mpPDA, authority.publicKey, mpPublicInputs);
      const verifyTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(verifyIx);

      const sig = await sendAndConfirmTransaction(
        provider.connection, verifyTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_stark_proof_v2 tx (phase 1): ${sig}`);

      const account = await (program.account as any).proofBuffer.fetch(mpPDA);
      expect(account.verified).to.be.true;
      expect(account.circuitId).to.equal(CIRCUIT_MERKLE_PATH);
      console.log('    Phase 1 (verify_stark_proof_v2) OK: FRI + trace-aligned + boundary');

      // [P2.2g] Phase 2 — DEEP-ALI at OOD for C3 (width=6 trace=512 too heavy
      // for single-ix verify; runs like C6's split-phase flow).
      const deepAliIx = buildVerifyDeepAliPhase2Ix(mpPDA, authority.publicKey, mpPublicInputs);
      const deepAliTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(deepAliIx);
      const deepSig = await sendAndConfirmTransaction(
        provider.connection, deepAliTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_deep_ali_phase2 tx (phase 2): ${deepSig}`);

      const account2 = await (program.account as any).proofBuffer.fetch(mpPDA);
      expect(account2.deepAliVerified).to.be.true;
      console.log('    Phase 2 (DEEP-ALI at OOD) OK — C3 full 11-constraint soundness');
    });

    after('close merkle-path proof buffer', async () => {
      try {
        await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: mpPDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      } catch (_) {}
    });
  });

  // =========================================================================
  // Confidential Balance (Circuit 4) — end-to-end
  // =========================================================================
  //
  // Proves old_bal - amount = new_bal under Poseidon commitments.
  // Width=4, trace=256, DEEP-ALI-hardened since P2.2d-C4 (commit e69d1fa).

  describe('confidential balance (circuit 4)', () => {
    let cbProofBytes: Buffer;
    let cbPublicInputs: bigint[];
    let cbPDA: PublicKey;

    before('generate confidential-balance proof', async () => {
      console.log('    Generating confidential-balance STARK proof...');
      // old_bal (1000) - amount (250) = new_bal (750); mint 42.
      const proof = generateConfidentialBalanceProof(
        555, 1000, 11, 750, 22, 250, 33, 42,
      );
      cbProofBytes = proof.proofBytes;
      cbPublicInputs = proof.publicInputs;
      console.log(`    Confidential proof size: ${cbProofBytes.length} bytes`);
      console.log(
        `    Public inputs: [old=${cbPublicInputs[0]}, new=${cbPublicInputs[1]}, ` +
        `amt=${cbPublicInputs[2]}, mint=${cbPublicInputs[3]}]`,
      );

      [cbPDA] = getProofBufferPDA(authority.publicKey, CIRCUIT_CONFIDENTIAL_BALANCE);

      const existing = await provider.connection.getAccountInfo(cbPDA);
      if (existing) {
        try {
          const cTx = await program.methods
            .closeProofBuffer()
            .accounts({ proofBuffer: cbPDA, authority: authority.publicKey })
            .signers([authority])
            .rpc({ commitment: 'confirmed', skipPreflight: true });
          await provider.connection.confirmTransaction(cTx, 'confirmed');
        } catch (_) {}
      }
    });

    it('init + upload + verify confidential-balance proof with v2', async () => {
      const initData = Buffer.alloc(8 + 4 + 1);
      Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]).copy(initData, 0);
      initData.writeUInt32LE(cbProofBytes.length, 8);
      initData.writeUInt8(CIRCUIT_CONFIDENTIAL_BALANCE, 12);

      const initIx = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: cbPDA, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initData,
      });
      await sendAndConfirmTransaction(
        provider.connection, new Transaction().add(initIx), [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );

      if (cbProofBytes.length + PROOF_DATA_OFFSET > 10240) {
        const calls = await resizeProofBufferTo(
          provider.connection, cbPDA, authority, cbProofBytes.length,
        );
        console.log(`    Resized to ${cbProofBytes.length + PROOF_DATA_OFFSET} bytes (${calls} calls)`);
      }

      await uploadProofChunks(program, cbPDA, authority, cbProofBytes, provider.connection);
      console.log(`    Upload complete: ${cbProofBytes.length} bytes written`);

      const verifyIx = buildVerifyStarkProofV2Ix(cbPDA, authority.publicKey, cbPublicInputs);
      const verifyTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(verifyIx);

      const sig = await sendAndConfirmTransaction(
        provider.connection, verifyTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_stark_proof_v2 tx (phase 1): ${sig}`);

      const account = await (program.account as any).proofBuffer.fetch(cbPDA);
      expect(account.verified).to.be.true;
      expect(account.circuitId).to.equal(CIRCUIT_CONFIDENTIAL_BALANCE);
      console.log('    Phase 1 (verify_stark_proof_v2) OK: FRI + trace-aligned + boundary');

      // [P2.2g] Phase 2 — DEEP-ALI at OOD for C4.
      const deepAliIx = buildVerifyDeepAliPhase2Ix(cbPDA, authority.publicKey, cbPublicInputs);
      const deepAliTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(deepAliIx);
      const deepSig = await sendAndConfirmTransaction(
        provider.connection, deepAliTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_deep_ali_phase2 tx (phase 2): ${deepSig}`);

      const account2 = await (program.account as any).proofBuffer.fetch(cbPDA);
      expect(account2.deepAliVerified).to.be.true;
      console.log('    Phase 2 (DEEP-ALI at OOD) OK — C4 full 10-constraint soundness');
    });

    after('close confidential-balance proof buffer', async () => {
      try {
        await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: cbPDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      } catch (_) {}
    });
  });

  // =========================================================================
  // Transfer (Circuit 5) — end-to-end
  // =========================================================================
  //
  // 2-in/2-out shielded transfer with nullifiers and output commitments.
  // Width=6, trace=512, 23 constraints, DEEP-ALI-hardened since P2.2d-C5
  // (commit 4bd3c28). Largest AIR — may need split verify if CU > 1.4M.

  describe('transfer (circuit 5)', () => {
    let trProofBytes: Buffer;
    let trPublicInputs: bigint[];
    let trPDA: PublicKey;

    before('generate transfer proof', async () => {
      console.log('    Generating transfer STARK proof...');
      // Balanced: in1(100) + in2(50) = out1(80) + out2(70) + pub(0)
      const proof = generateTransferProof(
        42, 999,
        100, 111, 50, 222,     // inputs
        80, 555, 333,          // out1 (amt, recipient, rand)
        70, 666, 444,          // out2
        0,                     // public amount
      );
      trProofBytes = proof.proofBytes;
      trPublicInputs = proof.publicInputs;
      console.log(`    Transfer proof size: ${trProofBytes.length} bytes`);
      console.log(
        `    Public inputs: [in1_null=${trPublicInputs[0]}, in2_null=${trPublicInputs[1]}, ` +
        `out1=${trPublicInputs[2]}, out2=${trPublicInputs[3]}, mint=${trPublicInputs[4]}, ` +
        `pub_amt=${trPublicInputs[5]}]`,
      );

      [trPDA] = getProofBufferPDA(authority.publicKey, CIRCUIT_TRANSFER);

      const existing = await provider.connection.getAccountInfo(trPDA);
      if (existing) {
        try {
          const cTx = await program.methods
            .closeProofBuffer()
            .accounts({ proofBuffer: trPDA, authority: authority.publicKey })
            .signers([authority])
            .rpc({ commitment: 'confirmed', skipPreflight: true });
          await provider.connection.confirmTransaction(cTx, 'confirmed');
        } catch (_) {}
      }
    });

    it('init + upload + verify transfer proof with v2', async () => {
      const initData = Buffer.alloc(8 + 4 + 1);
      Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]).copy(initData, 0);
      initData.writeUInt32LE(trProofBytes.length, 8);
      initData.writeUInt8(CIRCUIT_TRANSFER, 12);

      const initIx = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: trPDA, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initData,
      });
      await sendAndConfirmTransaction(
        provider.connection, new Transaction().add(initIx), [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );

      if (trProofBytes.length + PROOF_DATA_OFFSET > 10240) {
        const calls = await resizeProofBufferTo(
          provider.connection, trPDA, authority, trProofBytes.length,
        );
        console.log(`    Resized to ${trProofBytes.length + PROOF_DATA_OFFSET} bytes (${calls} calls)`);
      }

      await uploadProofChunks(program, trPDA, authority, trProofBytes, provider.connection);
      console.log(`    Upload complete: ${trProofBytes.length} bytes written`);

      // Transfer is the heaviest circuit. If combined verify > 1.4M CU, this
      // will fail and we'll need to split into phase 1 + phase 2 like C6.
      const verifyIx = buildVerifyStarkProofV2Ix(trPDA, authority.publicKey, trPublicInputs);
      const verifyTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(verifyIx);

      const sig = await sendAndConfirmTransaction(
        provider.connection, verifyTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_stark_proof_v2 tx (phase 1): ${sig}`);

      const account = await (program.account as any).proofBuffer.fetch(trPDA);
      expect(account.verified).to.be.true;
      expect(account.circuitId).to.equal(CIRCUIT_TRANSFER);
      console.log('    Phase 1 (verify_stark_proof_v2) OK: FRI + trace-aligned + boundary');

      // [P2.2g] Phase 2 — DEEP-ALI at OOD for C5 (heaviest generic AIR:
      // width=6, trace=512, 23 constraints).
      const deepAliIx = buildVerifyDeepAliPhase2Ix(trPDA, authority.publicKey, trPublicInputs);
      const deepAliTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(deepAliIx);
      const deepSig = await sendAndConfirmTransaction(
        provider.connection, deepAliTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_deep_ali_phase2 tx (phase 2): ${deepSig}`);

      const account2 = await (program.account as any).proofBuffer.fetch(trPDA);
      expect(account2.deepAliVerified).to.be.true;
      console.log('    Phase 2 (DEEP-ALI at OOD) OK — C5 full 23-constraint soundness');
    });

    after('close transfer proof buffer', async () => {
      try {
        await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: trPDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      } catch (_) {}
    });
  });

  // =========================================================================
  // Merkle Update (Circuit 6) — end-to-end
  // =========================================================================
  //
  // Proves that replacing a single leaf in a Merkle tree transforms the
  // old_root into new_root. Both hash chains use the same sibling+direction
  // witnesses, so a malicious prover cannot forge the two paths independently.

  describe('merkle update (circuit 6)', () => {
    let muProofBytes: Buffer;
    let muPublicInputs: bigint[];
    let muPDA: PublicKey;

    before('generate merkle-update proof', async () => {
      console.log('    Generating merkle-update STARK proof (depth 15)...');
      // Depth 15 matches the CONFIG_MERKLE_UPDATE trace_length=512 (largest
      // depth that still fits in 512 rows). The prover's AIR pads the trace
      // to next_pow2(depth*32 + 1), so depth 8-15 all produce the same
      // 512-row trace. Smaller depths produce a smaller trace which the
      // on-chain verifier (fixed config) cannot parse.
      const elements = Array.from({ length: 15 }, (_, i) => 100 + i * 13);
      const indices = Array.from({ length: 15 }, (_, i) => i % 2);
      const proof = generateMerkleUpdateProof(111, 222, elements, indices);
      muProofBytes = proof.proofBytes;
      muPublicInputs = proof.publicInputs;
      console.log(`    Merkle-update proof size: ${muProofBytes.length} bytes`);
      console.log(
        `    Public inputs: [old_leaf=${muPublicInputs[0]}, new_leaf=${muPublicInputs[1]}, ` +
        `old_root=${muPublicInputs[2]}, new_root=${muPublicInputs[3]}, depth=${muPublicInputs[4]}]`,
      );

      [muPDA] = getProofBufferPDA(authority.publicKey, CIRCUIT_MERKLE_UPDATE);

      const existing = await provider.connection.getAccountInfo(muPDA);
      if (existing) {
        try {
          const cTx = await program.methods
            .closeProofBuffer()
            .accounts({ proofBuffer: muPDA, authority: authority.publicKey })
            .signers([authority])
            .rpc({ commitment: 'confirmed', skipPreflight: true });
          await provider.connection.confirmTransaction(cTx, 'confirmed');
        } catch (_) {}
      }
    });

    it('init + upload + verify merkle-update proof with v2', async () => {
      // Init — raw instruction
      const initData = Buffer.alloc(8 + 4 + 1);
      Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]).copy(initData, 0);
      initData.writeUInt32LE(muProofBytes.length, 8);
      initData.writeUInt8(CIRCUIT_MERKLE_UPDATE, 12);

      const initIx = new anchor.web3.TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: muPDA, isSigner: false, isWritable: true },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: initData,
      });
      await sendAndConfirmTransaction(
        provider.connection, new Transaction().add(initIx), [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );

      // Circuit 6 has trace_width=10 so proofs are larger — resize needed
      if (muProofBytes.length + PROOF_DATA_OFFSET > 10240) {
        const calls = await resizeProofBufferTo(
          provider.connection, muPDA, authority, muProofBytes.length,
        );
        console.log(`    Resized to ${muProofBytes.length + PROOF_DATA_OFFSET} bytes (${calls} calls)`);
      }

      // Upload
      await uploadProofChunks(program, muPDA, authority, muProofBytes, provider.connection);
      console.log(`    Upload complete: ${muProofBytes.length} bytes written`);

      // Verify — 5 public inputs. Circuit 6 (merkle_update, lde_size=8192)
      // verifier detects half_lde > 2048 and skips the inv_gen_0_powers
      // precompute, using per-layer inv_gen.exp(pos_low) instead — no extra
      // heap needed, fits in the default 32KB.
      const verifyIx = buildVerifyStarkProofV2Ix(muPDA, authority.publicKey, muPublicInputs);
      const verifyTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(verifyIx);

      const sig = await sendAndConfirmTransaction(
        provider.connection, verifyTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_stark_proof_v2 tx: ${sig}`);

      const account = await (program.account as any).proofBuffer.fetch(muPDA);
      expect(account.verified).to.be.true;
      expect(account.circuitId).to.equal(CIRCUIT_MERKLE_UPDATE);
      console.log('    Phase 1 (verify_stark_proof_v2) OK: FRI + trace-aligned constraints verified');

      // [P2.2e] Phase 2 — DEEP-ALI at OOD, closes the soundness gap left by
      // per-query trace-aligned checks alone (blowup-16 ⇒ 24% of queries hit
      // trace-aligned rows, so the other 76% of rows are unchecked without
      // this identity). Must run in a separate TX because the combined CU
      // budget exceeds Solana's 1.4M per-instruction cap.
      const deepAliIx = buildVerifyMerkleUpdateDeepAliIx(
        muPDA, authority.publicKey, muPublicInputs,
      );
      const deepAliTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(deepAliIx);
      const deepSig = await sendAndConfirmTransaction(
        provider.connection, deepAliTx, [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      console.log(`    verify_merkle_update_deep_ali tx: ${deepSig}`);

      const account2 = await (program.account as any).proofBuffer.fetch(muPDA);
      expect(account2.verified).to.be.true;
      expect(account2.deepAliVerified).to.be.true;
      console.log('    Phase 2 (DEEP-ALI at OOD) OK — full 19-constraint soundness');
    });

    after('close merkle-update proof buffer', async () => {
      try {
        await program.methods
          .closeProofBuffer()
          .accounts({ proofBuffer: muPDA, authority: authority.publicKey })
          .signers([authority])
          .rpc({ commitment: 'confirmed', skipPreflight: true });
      } catch (_) {}
    });
  });
});
