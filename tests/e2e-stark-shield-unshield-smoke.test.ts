/**
 * E2E Smoke: shield → unshield (STARK) on devnet
 *
 * Exercises the full cross-program STARK unshield pipeline:
 *   1. init_denominated_pool  (zk_shielded, fresh denomination per run)
 *   2. shield_denominated     (zk_shielded, 1 native-SOL note)
 *   3. gen_proof pool         (p01-stark CLI, circuit 1 pool_commitment)
 *   4. init_proof_buffer + write_proof_chunk + verify_stark_proof_v2
 *                              (p01_stark_verifier)
 *   5. unshield_denominated_stark
 *                              (zk_shielded, consumes the pre-verified buffer)
 *
 * Goal: prove the wiring end-to-end — two programs agree on a single STARK
 * proof, the nullifier PDA is created, and the recipient receives the net
 * denomination after the 0.5% protocol fee.
 *
 * Programs:
 *   zk_shielded:        GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
 *   p01_stark_verifier: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 *
 * Run (devnet):
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..."
 *   ANCHOR_WALLET=~/.config/solana/id.json
 *   npx ts-mocha -p tsconfig.test.json tests/e2e-stark-shield-unshield-smoke.test.ts --timeout 600000
 *
 * Uses a unique denomination per run (timestamp-based) so repeated runs don't
 * collide on the [denominated_pool, mint, denom] PDA. Requires ~0.02 SOL of
 * devnet balance for fees + rent + 1 note.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import type { ZkShielded } from '../target/types/zk_shielded';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { expect } from 'chai';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ZK_SHIELDED_ID = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const STARK_VERIFIER_ID = new PublicKey('DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs');
const PROTOCOL_FEE_WALLET = new PublicKey('BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN');

const NATIVE_SOL_MINT = SystemProgram.programId;

const SEEDS = {
  DENOMINATED_POOL: Buffer.from('denominated_pool'),
  MERKLE_TREE: Buffer.from('merkle_tree'),
  NULLIFIER: Buffer.from('nullifier'),
  STARK_PROOF: Buffer.from('stark_proof'),
};

const CIRCUIT_POOL_COMMITMENT = 1;
const UNSHIELD_FEE_BPS = 50; // 0.5 %
const SHIELD_FEE_BPS = 30;   // 0.3 %

const MAX_CHUNK_SIZE = 900;
const PROOF_DATA_OFFSET = 82;

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------
function deriveDenominatedPoolPDA(mint: PublicKey, denomination: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.DENOMINATED_POOL, mint.toBuffer(), denomination.toArrayLike(Buffer, 'le', 8)],
    ZK_SHIELDED_ID,
  );
}

function deriveMerkleTreePDA(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.MERKLE_TREE, pool.toBuffer()],
    ZK_SHIELDED_ID,
  );
}

function deriveNullifierPDA(pool: PublicKey, nullifier: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.NULLIFIER, pool.toBuffer(), nullifier],
    ZK_SHIELDED_ID,
  );
}

function deriveProofBufferPDA(authority: PublicKey, circuitId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.STARK_PROOF, authority.toBuffer(), Buffer.from([circuitId])],
    STARK_VERIFIER_ID,
  );
}

// ---------------------------------------------------------------------------
// Retry helper — devnet blockhash flakiness
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
        console.log(`      Retry ${attempt + 1}/${maxRetries} after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// ---------------------------------------------------------------------------
// STARK proof CLI wrapper
// ---------------------------------------------------------------------------
interface PoolProof {
  circuitId: number;
  publicInputs: [bigint, bigint]; // [nullifier_u64, commitment_u64]
  proofBytes: Buffer;
}

function generatePoolCommitmentProof(
  np: bigint,
  secret: bigint,
  epoch: bigint,
  mint: bigint,
): PoolProof {
  const projectRoot = path.resolve(__dirname, '..');
  const cmd = `cargo run --bin gen_proof -p p01-stark -- pool ${np} ${secret} ${epoch} ${mint}`;
  const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180000 });
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputs = output.match(/"public_inputs":\s*\[(\d+),\s*(\d+)\]/);
  if (!inputs) throw new Error('Could not parse public_inputs from gen_proof');
  return {
    circuitId: json.circuit_id,
    publicInputs: [BigInt(inputs[1]), BigInt(inputs[2])],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

// ---------------------------------------------------------------------------
// Manual instruction builders for p01_stark_verifier (IDL inlined)
// ---------------------------------------------------------------------------
function buildInitProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
  proofSize: number,
  circuitId: number,
): anchor.web3.TransactionInstruction {
  const disc = Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]);
  const sz = Buffer.alloc(4);
  sz.writeUInt32LE(proofSize, 0);
  const cid = Buffer.from([circuitId]);
  return new anchor.web3.TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc, sz, cid]),
  });
}

function buildWriteProofChunkIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
  offset: number,
  chunk: Buffer,
): anchor.web3.TransactionInstruction {
  const disc = Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]);
  const off = Buffer.alloc(4);
  off.writeUInt32LE(offset, 0);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(chunk.length, 0);
  return new anchor.web3.TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc, off, len, chunk]),
  });
}

function buildVerifyStarkProofV2Ix(
  proofBuffer: PublicKey,
  authority: PublicKey,
  publicInputs: bigint[],
): anchor.web3.TransactionInstruction {
  const disc = Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]);
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map((v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  });
  return new anchor.web3.TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc, vecLen, ...inputBufs]),
  });
}

function buildResizeProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
): anchor.web3.TransactionInstruction {
  const disc = Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]);
  return new anchor.web3.TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc,
  });
}

function buildCloseProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
): anchor.web3.TransactionInstruction {
  const disc = Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]);
  return new anchor.web3.TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
    ],
    data: disc,
  });
}

async function uploadProofChunks(
  connection: Connection,
  authority: Keypair,
  proofBuffer: PublicKey,
  proofBytes: Buffer,
): Promise<void> {
  for (let offset = 0; offset < proofBytes.length; offset += MAX_CHUNK_SIZE) {
    const slice = proofBytes.subarray(offset, Math.min(offset + MAX_CHUNK_SIZE, proofBytes.length));
    const ix = buildWriteProofChunkIx(proofBuffer, authority.publicKey, offset, slice);
    await withRetry(async () => {
      const sig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(ix),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      await connection.confirmTransaction(sig, 'confirmed');
    });
  }
}

async function cleanupStaleProofBuffer(
  connection: Connection,
  authority: Keypair,
  proofBuffer: PublicKey,
): Promise<void> {
  const existing = await connection.getAccountInfo(proofBuffer);
  if (!existing) return;
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(proofBuffer, authority.publicKey)),
      [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------
function randomBytes32(): Buffer {
  return crypto.randomBytes(32);
}

function nullifierFromU64(nullifierU64: bigint): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64LE(nullifierU64, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('E2E Smoke: shield → unshield with STARK', () => {
  const provider = new AnchorProvider(
    AnchorProvider.env().connection,
    AnchorProvider.env().wallet,
    { commitment: 'confirmed', preflightCommitment: 'confirmed' },
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.ZkShielded as Program<ZkShielded>;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const recipient = Keypair.generate();

  // Unique denomination per run — avoids [pool, mint, denom] PDA collisions.
  // Range: 1_000_000 .. 9_999_999 lamports (0.001–0.01 SOL).
  const denomLamports = 1_000_000 + (Date.now() % 9_000_000);
  const denomination = new BN(denomLamports);
  const epochDelay = new BN(1);
  const vkHash = Array.from(randomBytes32());

  // STARK witness — arbitrary u64 seeds (smoke test, soundness is in separate suites)
  const np = BigInt(Math.floor(Math.random() * 0xffffffff));
  const secret = BigInt(Math.floor(Math.random() * 0xffffffff));
  const epochWitness = 0n; // fine — on-chain only checks current_epoch >= min_epoch + dynamic_delay
  const mintWitness = 1n; // Goldilocks-domain stand-in (not checked on unshield)

  let poolPDA: PublicKey;
  let treePDA: PublicKey;
  let proofBufferPDA: PublicKey;
  let starkProof: PoolProof;
  let nullifier: Buffer;
  let nullifierRecordPDA: PublicKey;
  let shieldRoot: Buffer;

  before(async () => {
    [poolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, denomination);
    [treePDA] = deriveMerkleTreePDA(poolPDA);
    [proofBufferPDA] = deriveProofBufferPDA(authority.publicKey, CIRCUIT_POOL_COMMITMENT);

    // Fund recipient for rent exemption (instruction credits it; no existing account needed
    // because SystemProgram.transfer creates it implicitly)
    // Fund protocol fee wallet if somehow absent
    const feeInfo = await provider.connection.getAccountInfo(PROTOCOL_FEE_WALLET);
    if (!feeInfo) {
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: authority.publicKey,
            toPubkey: PROTOCOL_FEE_WALLET,
            lamports: 0.001 * LAMPORTS_PER_SOL,
          }),
        ),
      );
    }

    console.log(`    denomination: ${denomLamports} lamports`);
    console.log(`    pool PDA:     ${poolPDA.toBase58()}`);
    console.log(`    recipient:    ${recipient.publicKey.toBase58()}`);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 1: Initialize fresh denominated pool
  // ─────────────────────────────────────────────────────────────────
  it('initializes a fresh denominated pool', async () => {
    await withRetry(async () => {
      await program.methods
        .initDenominatedPool(vkHash, NATIVE_SOL_MINT, denomination, epochDelay)
        .accountsPartial({
          authority: authority.publicKey,
          denominatedPool: poolPDA,
          merkleTree: treePDA,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: 'confirmed' });
    });

    const pool = await program.account.denominatedPool.fetch(poolPDA);
    expect(pool.denomination.toString()).to.equal(denomination.toString());
    expect(pool.isActive).to.be.true;
    expect(pool.noteCount.toNumber()).to.equal(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 2: Shield 1 note into the pool
  // ─────────────────────────────────────────────────────────────────
  it('shields 1 note into the pool', async () => {
    // Random commitment + non-zero root (≠ initial root). insert_with_root only
    // rejects zero-root or root-unchanged; actual Merkle hashing is implicit
    // (Poseidon syscall not yet on devnet — client supplies the root).
    const commitment = Array.from(randomBytes32());
    shieldRoot = randomBytes32();

    await withRetry(async () => {
      await program.methods
        .shieldDenominated(commitment, Array.from(shieldRoot))
        .accountsPartial({
          depositor: authority.publicKey,
          denominatedPool: poolPDA,
          merkleTree: treePDA,
          systemProgram: SystemProgram.programId,
          protocolFeeWallet: PROTOCOL_FEE_WALLET,
        })
        .rpc({ commitment: 'confirmed' });
    });

    const pool = await program.account.denominatedPool.fetch(poolPDA);
    expect(pool.noteCount.toNumber()).to.equal(1);
    expect(pool.totalShielded.toString()).to.equal(denomination.toString());
    expect(Buffer.from(pool.merkleRoot).equals(shieldRoot)).to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 3: Generate circuit-1 STARK proof off-chain
  // ─────────────────────────────────────────────────────────────────
  it('generates a pool_commitment STARK proof (circuit 1)', async function () {
    this.timeout(300_000); // cargo build + prove
    starkProof = generatePoolCommitmentProof(np, secret, epochWitness, mintWitness);
    nullifier = nullifierFromU64(starkProof.publicInputs[0]);
    [nullifierRecordPDA] = deriveNullifierPDA(poolPDA, nullifier);

    expect(starkProof.circuitId).to.equal(CIRCUIT_POOL_COMMITMENT);
    expect(starkProof.proofBytes.length).to.be.gte(1024);
    console.log(`    proof size: ${starkProof.proofBytes.length} bytes`);
    console.log(`    nullifier_u64:      ${starkProof.publicInputs[0]}`);
    console.log(`    stark_commitment:   ${starkProof.publicInputs[1]}`);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 4: Upload + verify STARK proof on p01_stark_verifier
  // ─────────────────────────────────────────────────────────────────
  it('uploads + verifies the STARK proof on-chain', async function () {
    this.timeout(300_000);
    await cleanupStaleProofBuffer(provider.connection, authority, proofBufferPDA);

    // Init
    await withRetry(async () => {
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(
          buildInitProofBufferIx(
            proofBufferPDA,
            authority.publicKey,
            starkProof.proofBytes.length,
            CIRCUIT_POOL_COMMITMENT,
          ),
        ),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    // Resize if > 10KB so write_proof_chunk can store the tail bytes
    if (starkProof.proofBytes.length + PROOF_DATA_OFFSET > 10_240) {
      await withRetry(async () => {
        await sendAndConfirmTransaction(
          provider.connection,
          new Transaction().add(buildResizeProofBufferIx(proofBufferPDA, authority.publicKey)),
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
      });
    }

    // Upload
    await uploadProofChunks(provider.connection, authority, proofBufferPDA, starkProof.proofBytes);

    // Verify with v2 (multi-input)
    await withRetry(async () => {
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
          .add(
            buildVerifyStarkProofV2Ix(
              proofBufferPDA,
              authority.publicKey,
              [...starkProof.publicInputs],
            ),
          ),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });

    // Sanity: verified flag must be set
    const info = await provider.connection.getAccountInfo(proofBufferPDA);
    expect(info).to.not.be.null;
    // verified byte offset = 49 (8 disc + 32 auth + 1 circuit + 4 size + 4 written)
    expect(info!.data[49]).to.equal(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 5: Unshield via STARK, consume the verified buffer
  // ─────────────────────────────────────────────────────────────────
  it('unshields via STARK and credits the recipient', async () => {
    const recipientBalBefore = await provider.connection.getBalance(recipient.publicKey);
    const feeBalBefore = await provider.connection.getBalance(PROTOCOL_FEE_WALLET);

    await withRetry(async () => {
      await program.methods
        .unshieldDenominatedStark(
          Array.from(nullifier),
          Array.from(shieldRoot),
          new BN(0), // min_epoch — dynamic_delay=2 with 0 mature notes; 0+2 << current_epoch
          new BN(starkProof.publicInputs[1].toString()), // stark_commitment_u64
        )
        .accountsPartial({
          payer: authority.publicKey,
          recipient: recipient.publicKey,
          denominatedPool: poolPDA,
          merkleTree: treePDA,
          nullifierRecord: nullifierRecordPDA,
          starkProofBuffer: proofBufferPDA,
          systemProgram: SystemProgram.programId,
          protocolFeeWallet: PROTOCOL_FEE_WALLET,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: 'confirmed', skipPreflight: true });
    });

    // Fee math — mirrors fee::calculate_fee in Rust
    const expectedFee = Math.floor((denomLamports * UNSHIELD_FEE_BPS) / 10_000);
    const expectedNet = denomLamports - expectedFee;

    const recipientBalAfter = await provider.connection.getBalance(recipient.publicKey);
    const feeBalAfter = await provider.connection.getBalance(PROTOCOL_FEE_WALLET);

    expect(recipientBalAfter - recipientBalBefore).to.equal(expectedNet);
    expect(feeBalAfter - feeBalBefore).to.equal(expectedFee);

    // Pool decremented
    const pool = await program.account.denominatedPool.fetch(poolPDA);
    expect(pool.noteCount.toNumber()).to.equal(0);
    expect(pool.totalShielded.toNumber()).to.equal(0);

    // Nullifier PDA now exists — double-spend is impossible
    const nullifierInfo = await provider.connection.getAccountInfo(nullifierRecordPDA);
    expect(nullifierInfo).to.not.be.null;
    expect(nullifierInfo!.owner.toBase58()).to.equal(ZK_SHIELDED_ID.toBase58());
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 6: Clean up the STARK proof buffer (recover rent)
  // ─────────────────────────────────────────────────────────────────
  after('close STARK proof buffer', async () => {
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        new Transaction().add(buildCloseProofBufferIx(proofBufferPDA, authority.publicKey)),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
    } catch {
      /* ignore — buffer may not exist if earlier steps failed */
    }
  });
});
