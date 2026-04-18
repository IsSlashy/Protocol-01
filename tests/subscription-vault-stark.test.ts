/**
 * Subscription Vault — STARK E2E (quantum-resistant path)
 *
 * Exercises the full private subscription lifecycle using STARK proofs
 * (no Groth16, no snarkjs, no circuit artifacts):
 *
 *   1. init_denominated_pool   (fresh denom per run, native SOL)
 *   2. shield_denominated      (1 note)
 *   3. STARK circuit 1 (pool_commitment):
 *      init_proof_buffer → write_proof_chunk(s) → verify_stark_proof_v2
 *   4. subscribe_private_stark — creates SubscriptionVault PDA keyed by
 *      [subscription_vault, retailer, subscriber_commitment, token_mint]
 *   5. STARK circuit 0 (subscriber_ownership):
 *      init_proof_buffer → write_proof_chunk(s) → verify_stark_proof_v2
 *      The same verified buffer is reused by pause, resume, and cancel —
 *      none of those handlers mutate the proof-buffer account (replay
 *      prevention lives in vault state transitions).
 *   6. pause_private_stark
 *   7. resume_private_stark
 *   8. cancel_private_stark (re-shields 1 new note back into the pool)
 *
 * Replaces the Groth16 flow in tests/subscription-vault-e2e.ts which
 * depended on circuit build artifacts (.wasm/.zkey). This test only
 * depends on the p01-stark CLI binary being buildable via cargo.
 *
 * Programs:
 *   zk_shielded:        GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
 *   p01_stark_verifier: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 *
 * Run (devnet):
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..." \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-mocha -p tsconfig.test.json tests/subscription-vault-stark.test.ts --timeout 600000
 *
 * Requires ~0.02 SOL of devnet balance (rent for pool, vault, nullifier
 * records, two STARK proof buffers).
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
  TransactionInstruction,
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
  SUBSCRIPTION_VAULT: Buffer.from('subscription_vault'),
};

const CIRCUIT_SUBSCRIBER_OWNERSHIP = 0;
const CIRCUIT_POOL_COMMITMENT = 1;

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

function deriveSubscriptionVaultPDA(
  retailer: PublicKey,
  subscriberIdBytes: Buffer,
  tokenMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEEDS.SUBSCRIPTION_VAULT, retailer.toBuffer(), subscriberIdBytes, tokenMint.toBuffer()],
    ZK_SHIELDED_ID,
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
// STARK proof generation (off-chain, via cargo)
// ---------------------------------------------------------------------------
interface GeneratedProof {
  circuitId: number;
  publicInputs: bigint[];
  proofBytes: Buffer;
}

function generatePoolCommitmentProof(
  np: bigint,
  secret: bigint,
  epoch: bigint,
  mint: bigint,
): GeneratedProof {
  const projectRoot = path.resolve(__dirname, '..');
  const cmd = `cargo run --bin gen_proof -p p01-stark -- pool ${np} ${secret} ${epoch} ${mint}`;
  const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180000 });
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const inputs = output.match(/"public_inputs":\s*\[(\d+),\s*(\d+)\]/);
  if (!inputs) throw new Error('Could not parse public_inputs from gen_proof (pool)');
  return {
    circuitId: json.circuit_id,
    publicInputs: [BigInt(inputs[1]), BigInt(inputs[2])],
    proofBytes: Buffer.from(json.proof_hex, 'hex'),
  };
}

function generateSubscriberOwnershipProof(secret: bigint): GeneratedProof {
  // Default command: `gen_proof <secret>` → circuit 0 (subscriber_ownership).
  // Output fields differ from the named circuits: `secret`, `commitment`, no
  // `circuit_id` / `public_inputs` keys — we reconstruct them here.
  const projectRoot = path.resolve(__dirname, '..');
  const cmd = `cargo run --bin gen_proof -p p01-stark -- ${secret}`;
  const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180000 });
  const jsonStart = output.indexOf('{');
  const jsonEnd = output.lastIndexOf('}') + 1;
  const json = JSON.parse(output.slice(jsonStart, jsonEnd));
  const commitmentMatch = output.match(/"commitment":\s*(\d+)/);
  if (!commitmentMatch) throw new Error('Could not parse commitment from gen_proof (subscriber)');
  return {
    circuitId: CIRCUIT_SUBSCRIBER_OWNERSHIP,
    publicInputs: [BigInt(commitmentMatch[1])],
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
): TransactionInstruction {
  const disc = Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]);
  const sz = Buffer.alloc(4);
  sz.writeUInt32LE(proofSize, 0);
  const cid = Buffer.from([circuitId]);
  return new TransactionInstruction({
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
): TransactionInstruction {
  const disc = Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]);
  const off = Buffer.alloc(4);
  off.writeUInt32LE(offset, 0);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(chunk.length, 0);
  return new TransactionInstruction({
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
): TransactionInstruction {
  const disc = Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]);
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map((v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  });
  return new TransactionInstruction({
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
): TransactionInstruction {
  const disc = Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]);
  return new TransactionInstruction({
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
): TransactionInstruction {
  const disc = Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]);
  return new TransactionInstruction({
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
    const slice = proofBytes.subarray(
      offset,
      Math.min(offset + MAX_CHUNK_SIZE, proofBytes.length),
    );
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

/**
 * Upload + verify a STARK proof on p01_stark_verifier.
 * Idempotent w.r.t. a prior verified buffer — closes it first if present.
 */
async function uploadAndVerifyProof(
  connection: Connection,
  authority: Keypair,
  proof: GeneratedProof,
): Promise<PublicKey> {
  const [proofBufferPDA] = deriveProofBufferPDA(authority.publicKey, proof.circuitId);
  await cleanupStaleProofBuffer(connection, authority, proofBufferPDA);

  // Init
  await withRetry(async () => {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        buildInitProofBufferIx(
          proofBufferPDA,
          authority.publicKey,
          proof.proofBytes.length,
          proof.circuitId,
        ),
      ),
      [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  // Resize if > 10KB
  if (proof.proofBytes.length + PROOF_DATA_OFFSET > 10_240) {
    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(buildResizeProofBufferIx(proofBufferPDA, authority.publicKey)),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
    });
  }

  // Upload chunks
  await uploadProofChunks(connection, authority, proofBufferPDA, proof.proofBytes);

  // Verify
  await withRetry(async () => {
    await sendAndConfirmTransaction(
      connection,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(
          buildVerifyStarkProofV2Ix(
            proofBufferPDA,
            authority.publicKey,
            proof.publicInputs,
          ),
        ),
      [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
  });

  const info = await connection.getAccountInfo(proofBufferPDA);
  if (!info) throw new Error('Proof buffer missing after verify');
  // verified flag byte = 49
  if (info.data[49] !== 1) throw new Error('Proof buffer not marked verified');

  return proofBufferPDA;
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------
function randomBytes32(): Buffer {
  return crypto.randomBytes(32);
}

function u64LeTo32(u: bigint): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64LE(u, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Subscription Vault — STARK lifecycle (native SOL)', () => {
  const provider = new AnchorProvider(
    AnchorProvider.env().connection,
    AnchorProvider.env().wallet,
    { commitment: 'confirmed', preflightCommitment: 'confirmed' },
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.ZkShielded as Program<ZkShielded>;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const retailer = Keypair.generate();

  // Unique denomination per run — avoids PDA collisions on retries.
  const denomLamports = 2_000_000 + (Date.now() % 8_000_000); // 0.002–0.01 SOL
  const denomination = new BN(denomLamports);
  const epochDelay = new BN(1);
  const vkHashPool = Array.from(randomBytes32());
  const vkHashSubscriber = Array.from(randomBytes32());

  // Subscription params — rate × 1 < denomination so the full denom
  // stays refundable; interval huge so claimable is 0 by the time we cancel.
  const rate = new BN(1000);
  const intervalSlots = new BN(1_000_000);

  // STARK witness seeds (random u32 range stays in Goldilocks safely)
  const poolNp = BigInt(Math.floor(Math.random() * 0xffffffff));
  const poolSecret = BigInt(Math.floor(Math.random() * 0xffffffff));
  const poolEpochWitness = 0n;
  const poolMintWitness = 1n;
  const subscriberSecret = BigInt(Math.floor(Math.random() * 0xffffffff));

  let poolPDA: PublicKey;
  let treePDA: PublicKey;
  let vaultPDA: PublicKey;
  let nullifierRecordPDA: PublicKey;
  let poolProof: GeneratedProof;
  let ownershipProof: GeneratedProof;
  let poolProofBuffer: PublicKey;
  let ownershipProofBuffer: PublicKey;
  let nullifier32: Buffer;
  let subscriberCommitment32: Buffer;
  let shieldRoot: Buffer;

  before(async function () {
    this.timeout(600_000);
    [poolPDA] = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, denomination);
    [treePDA] = deriveMerkleTreePDA(poolPDA);

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

    // Generate both proofs up front so we know the subscriber commitment bytes
    // before `subscribe_private_stark` is called (the on-chain handler reads
    // `vault.subscriber_commitment[..8]` as a u64 and checks it against the
    // circuit-0 proof's stored inputs hash).
    console.log(`    denomination: ${denomLamports} lamports`);
    console.log('    generating circuit-1 (pool_commitment) STARK proof...');
    poolProof = generatePoolCommitmentProof(poolNp, poolSecret, poolEpochWitness, poolMintWitness);
    nullifier32 = u64LeTo32(poolProof.publicInputs[0]);
    [nullifierRecordPDA] = deriveNullifierPDA(poolPDA, nullifier32);
    console.log(`    nullifier_u64=${poolProof.publicInputs[0]} stark_commitment_u64=${poolProof.publicInputs[1]}`);

    console.log('    generating circuit-0 (subscriber_ownership) STARK proof...');
    ownershipProof = generateSubscriberOwnershipProof(subscriberSecret);
    subscriberCommitment32 = u64LeTo32(ownershipProof.publicInputs[0]);
    [vaultPDA] = deriveSubscriptionVaultPDA(retailer.publicKey, subscriberCommitment32, NATIVE_SOL_MINT);
    console.log(`    subscriber_commitment_u64=${ownershipProof.publicInputs[0]}`);
    console.log(`    pool PDA:      ${poolPDA.toBase58()}`);
    console.log(`    vault PDA:     ${vaultPDA.toBase58()}`);
    console.log(`    retailer:      ${retailer.publicKey.toBase58()}`);
  });

  after('close STARK proof buffers', async () => {
    for (const buf of [poolProofBuffer, ownershipProofBuffer]) {
      if (!buf) continue;
      try {
        await sendAndConfirmTransaction(
          provider.connection,
          new Transaction().add(buildCloseProofBufferIx(buf, authority.publicKey)),
          [authority],
          { commitment: 'confirmed', skipPreflight: true },
        );
      } catch {
        /* ignore */
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 1: Initialize fresh denominated pool
  // ─────────────────────────────────────────────────────────────────
  it('initializes a fresh denominated pool', async () => {
    await withRetry(async () => {
      await program.methods
        .initDenominatedPool(vkHashPool, NATIVE_SOL_MINT, denomination, epochDelay)
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
  // Step 2: Shield 1 note
  // ─────────────────────────────────────────────────────────────────
  it('shields 1 note into the pool', async () => {
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
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 3: Upload + verify the pool_commitment STARK proof
  // ─────────────────────────────────────────────────────────────────
  it('uploads + verifies the pool_commitment STARK proof (circuit 1)', async function () {
    this.timeout(300_000);
    poolProofBuffer = await uploadAndVerifyProof(provider.connection, authority, poolProof);
    console.log(`    pool proof buffer: ${poolProofBuffer.toBase58()}`);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 4: subscribe_private_stark — creates the vault
  // ─────────────────────────────────────────────────────────────────
  it('subscribes privately via STARK proof', async () => {
    const poolBalBefore = await provider.connection.getBalance(poolPDA);

    await withRetry(async () => {
      await program.methods
        .subscribePrivateStark(
          Array.from(nullifier32),
          Array.from(shieldRoot),
          new BN(0), // minEpoch — dynamic_delay check is lenient on devnet
          Array.from(subscriberCommitment32),
          rate,
          intervalSlots,
          vkHashSubscriber,
          new BN(poolProof.publicInputs[1].toString()),
        )
        .accountsPartial({
          payer: authority.publicKey,
          retailer: retailer.publicKey,
          vault: vaultPDA,
          denominatedPool: poolPDA,
          merkleTree: treePDA,
          nullifierRecord: nullifierRecordPDA,
          starkProofBuffer: poolProofBuffer,
          systemProgram: SystemProgram.programId,
          tokenProgram: null,
          poolVault: null,
          vaultTokenAccount: null,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: 'confirmed', skipPreflight: true });
    });

    const vault = await program.account.subscriptionVault.fetch(vaultPDA);
    expect(vault.isActive).to.be.true;
    expect(vault.isPaused).to.be.false;
    expect(vault.totalDeposited.toString()).to.equal(denomination.toString());
    expect(vault.rate.toString()).to.equal(rate.toString());
    expect(vault.intervalSlots.toString()).to.equal(intervalSlots.toString());
    expect(vault.retailer.toBase58()).to.equal(retailer.publicKey.toBase58());
    expect(vault.subscriberPubkey).to.be.null;
    expect(vault.subscriberCommitment).to.not.be.null;
    expect(Buffer.from(vault.subscriberCommitment as number[]).equals(subscriberCommitment32)).to.be.true;
    expect(vault.sourcePool?.toBase58()).to.equal(poolPDA.toBase58());

    // Pool drained by one note
    const pool = await program.account.denominatedPool.fetch(poolPDA);
    expect(pool.noteCount.toNumber()).to.equal(0);
    expect(pool.totalShielded.toNumber()).to.equal(0);

    // Vault received the denomination (pool lamports are in both the pool
    // PDA and its rent-exempt reserve — here we just confirm it moved out)
    const poolBalAfter = await provider.connection.getBalance(poolPDA);
    expect(poolBalBefore - poolBalAfter).to.equal(denomLamports);

    // Nullifier PDA exists now (double-spend blocked)
    const nullifierInfo = await provider.connection.getAccountInfo(nullifierRecordPDA);
    expect(nullifierInfo).to.not.be.null;
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 5: Upload + verify the subscriber_ownership STARK proof
  // ─────────────────────────────────────────────────────────────────
  it('uploads + verifies the subscriber_ownership STARK proof (circuit 0)', async function () {
    this.timeout(300_000);
    ownershipProofBuffer = await uploadAndVerifyProof(
      provider.connection,
      authority,
      ownershipProof,
    );
    console.log(`    ownership proof buffer: ${ownershipProofBuffer.toBase58()}`);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 6: pause_private_stark
  // ─────────────────────────────────────────────────────────────────
  it('pauses the vault via STARK proof', async () => {
    await withRetry(async () => {
      await program.methods
        .pausePrivateStark()
        .accountsPartial({
          payer: authority.publicKey,
          vault: vaultPDA,
          starkProofBuffer: ownershipProofBuffer,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })])
        .rpc({ commitment: 'confirmed', skipPreflight: true });
    });

    const vault = await program.account.subscriptionVault.fetch(vaultPDA);
    expect(vault.isPaused).to.be.true;
    expect(vault.pauseSlot).to.not.be.null;
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 7: resume_private_stark (reuses the same verified buffer —
  // the pause handler does not invalidate the proof)
  // ─────────────────────────────────────────────────────────────────
  it('resumes the vault via STARK proof', async () => {
    await withRetry(async () => {
      await program.methods
        .resumePrivateStark()
        .accountsPartial({
          payer: authority.publicKey,
          vault: vaultPDA,
          starkProofBuffer: ownershipProofBuffer,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })])
        .rpc({ commitment: 'confirmed', skipPreflight: true });
    });

    const vault = await program.account.subscriptionVault.fetch(vaultPDA);
    expect(vault.isPaused).to.be.false;
    expect(vault.pauseSlot).to.be.null;
    expect(vault.totalPausedSlots.toNumber()).to.be.gte(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 8: cancel_private_stark — re-shield 1 note back into the pool
  // ─────────────────────────────────────────────────────────────────
  it('cancels the vault and re-shields one note', async () => {
    // interval_slots is huge and no period has elapsed, so refundable ≈ total
    // deposited = one full denomination → exactly one note to re-shield.
    const newCommitment = Array.from(randomBytes32());
    const newRoot = Array.from(randomBytes32());

    const retailerBalBefore = await provider.connection.getBalance(retailer.publicKey);
    const poolBalBefore = await provider.connection.getBalance(poolPDA);

    await withRetry(async () => {
      await program.methods
        .cancelPrivateStark([newCommitment], [newRoot])
        .accountsPartial({
          payer: authority.publicKey,
          retailer: retailer.publicKey,
          vault: vaultPDA,
          denominatedPool: poolPDA,
          merkleTree: treePDA,
          starkProofBuffer: ownershipProofBuffer,
          systemProgram: SystemProgram.programId,
          tokenProgram: null,
          vaultTokenAccount: null,
          poolVault: null,
          retailerTokenAccount: null,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: 'confirmed', skipPreflight: true });
    });

    // Vault closed (close = payer)
    const vaultInfo = await provider.connection.getAccountInfo(vaultPDA);
    expect(vaultInfo).to.be.null;

    // Retailer owed 0 (interval_slots is huge, no period elapsed), so no payout.
    const retailerBalAfter = await provider.connection.getBalance(retailer.publicKey);
    expect(retailerBalAfter).to.equal(retailerBalBefore);

    // Pool regained one denomination from the re-shield
    const poolBalAfter = await provider.connection.getBalance(poolPDA);
    expect(poolBalAfter - poolBalBefore).to.equal(denomLamports);

    const pool = await program.account.denominatedPool.fetch(poolPDA);
    expect(pool.noteCount.toNumber()).to.equal(1);
    expect(pool.totalShielded.toString()).to.equal(denomination.toString());
    expect(Buffer.from(pool.merkleRoot).equals(Buffer.from(newRoot))).to.be.true;
  });
});
