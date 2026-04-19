/**
 * E2E: instant-unshield via p01_liquidity (prefund → settle) on devnet.
 *
 * Exercises the full cross-program pipeline that mobile's
 * `unshieldStark({ instant: true })` triggers:
 *   1. init_denominated_pool    (zk_shielded)         — fresh pool per run
 *   2. shield_denominated       (zk_shielded)         — 1 note deposited
 *   3. gen_proof pool           (p01-stark CLI)       — circuit 1
 *   4. init + resize + upload + verify_stark_proof_v2 + deep_ali_phase2
 *                                (p01_stark_verifier)
 *   5. prefund                  (p01_liquidity)       — recipient paid instantly
 *   6. settle                   (p01_liquidity → CPI into zk_shielded
 *                                .unshield_denominated_stark)
 *                                — nullifier burned, pool reimbursed, settler reward paid
 *
 * Conservation (asserted):
 *   LP profit = prefund_fee_bps − unshield_fee_bps = 80 − 50 = 30 bps of `amount`
 *   Recipient = amount − prefund_fee − settler_reward
 *   Settler   = settler_reward + tx-fee-refund (ignored in checks)
 *
 * Programs:
 *   zk_shielded:        GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c
 *   p01_stark_verifier: DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs
 *   p01_liquidity:      6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg
 *
 * Run (devnet):
 *   ANCHOR_PROVIDER_URL="https://devnet.helius-rpc.com/?api-key=..."
 *   ANCHOR_WALLET=~/.config/solana/id.json
 *   npx ts-mocha -p tsconfig.test.json tests/p01-liquidity-prefund-settle.test.ts --timeout 900000
 *
 * Requires ~0.02 SOL for fees + the denomination being shielded.
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
// Program IDs + constants
// ---------------------------------------------------------------------------
const ZK_SHIELDED_ID    = new PublicKey('GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
const STARK_VERIFIER_ID = new PublicKey('DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs');
const P01_LIQUIDITY_ID  = new PublicKey('6PfFkvjXmSV42MMVWoDrJvz6tgEpbLPvx1bznY7C5pMg');
const PROTOCOL_FEE_WALLET = new PublicKey('BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN');

const NATIVE_SOL_MINT = SystemProgram.programId;

const SEEDS = {
  DENOMINATED_POOL: Buffer.from('denominated_pool'),
  MERKLE_TREE:      Buffer.from('merkle_tree'),
  NULLIFIER:        Buffer.from('nullifier'),
  STARK_PROOF:      Buffer.from('stark_proof'),
  LIQUIDITY_POOL:   Buffer.from('liquidity_pool'),
  PREFUND:          Buffer.from('prefund'),
};

const CIRCUIT_POOL_COMMITMENT = 1;
const UNSHIELD_FEE_BPS = 50;   // zk_shielded fee
// Pool fee params — asserted against on-chain state during setup
const EXPECTED_PREFUND_FEE_BPS   = 80;
const EXPECTED_SETTLER_REWARD_BPS = 20;

const MAX_CHUNK_SIZE = 900;
const PROOF_DATA_OFFSET = 83;
const MAX_REALLOC_STEP = 10_240;

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------
const deriveDenominatedPoolPDA = (mint: PublicKey, denom: BN) =>
  PublicKey.findProgramAddressSync(
    [SEEDS.DENOMINATED_POOL, mint.toBuffer(), denom.toArrayLike(Buffer, 'le', 8)],
    ZK_SHIELDED_ID,
  );

const deriveMerkleTreePDA = (pool: PublicKey) =>
  PublicKey.findProgramAddressSync([SEEDS.MERKLE_TREE, pool.toBuffer()], ZK_SHIELDED_ID);

const deriveNullifierPDA = (pool: PublicKey, nullifier: Buffer) =>
  PublicKey.findProgramAddressSync([SEEDS.NULLIFIER, pool.toBuffer(), nullifier], ZK_SHIELDED_ID);

const deriveProofBufferPDA = (authority: PublicKey, circuitId: number) =>
  PublicKey.findProgramAddressSync(
    [SEEDS.STARK_PROOF, authority.toBuffer(), Buffer.from([circuitId])],
    STARK_VERIFIER_ID,
  );

const deriveLiquidityPoolPDA = () =>
  PublicKey.findProgramAddressSync([SEEDS.LIQUIDITY_POOL], P01_LIQUIDITY_ID);

const derivePrefundRecordPDA = (denomPool: PublicKey, nullifier: Buffer) =>
  PublicKey.findProgramAddressSync(
    [SEEDS.PREFUND, denomPool.toBuffer(), nullifier],
    P01_LIQUIDITY_ID,
  );

// ---------------------------------------------------------------------------
// Anchor discriminator helper
// ---------------------------------------------------------------------------
const disc8 = (name: string): Buffer =>
  crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

// ---------------------------------------------------------------------------
// Retry helper — devnet blockhash flakiness
// ---------------------------------------------------------------------------
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelay = 2000): Promise<T> {
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
// STARK proof CLI wrapper — same as smoke test
// ---------------------------------------------------------------------------
interface PoolProof {
  circuitId: number;
  publicInputs: [bigint, bigint];
  proofBytes: Buffer;
}

function generatePoolCommitmentProof(
  np: bigint, secret: bigint, epoch: bigint, mint: bigint,
): PoolProof {
  const projectRoot = path.resolve(__dirname, '..');
  const cmd = `cargo run --bin gen_proof -p p01-stark -- pool ${np} ${secret} ${epoch} ${mint}`;
  const output = execSync(cmd, { cwd: projectRoot, encoding: 'utf-8', timeout: 180_000 });
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
// p01_stark_verifier ix builders (IDL-free)
// ---------------------------------------------------------------------------
function buildInitProofBufferIx(buf: PublicKey, auth: PublicKey, size: number, cid: number) {
  const d = Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]);
  const s = Buffer.alloc(4); s.writeUInt32LE(size, 0);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: auth, isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([d, s, Buffer.from([cid])]),
  });
}
function buildWriteProofChunkIx(buf: PublicKey, auth: PublicKey, offset: number, chunk: Buffer) {
  const d = Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]);
  const o = Buffer.alloc(4); o.writeUInt32LE(offset, 0);
  const l = Buffer.alloc(4); l.writeUInt32LE(chunk.length, 0);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: auth, isSigner: true,  isWritable: false },
    ],
    data: Buffer.concat([d, o, l, chunk]),
  });
}
function buildResizeProofBufferIx(buf: PublicKey, auth: PublicKey) {
  const d = Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: auth, isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: d,
  });
}
function buildVerifyStarkProofV2Ix(buf: PublicKey, auth: PublicKey, publicInputs: bigint[]) {
  const d = Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]);
  const vl = Buffer.alloc(4); vl.writeUInt32LE(publicInputs.length, 0);
  const bufs = publicInputs.map((v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; });
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: auth, isSigner: true,  isWritable: false },
    ],
    data: Buffer.concat([d, vl, ...bufs]),
  });
}
function buildVerifyDeepAliPhase2Ix(buf: PublicKey, auth: PublicKey, publicInputs: bigint[]) {
  const d = Buffer.from([217, 239, 203, 65, 109, 182, 70, 115]);
  const vl = Buffer.alloc(4); vl.writeUInt32LE(publicInputs.length, 0);
  const bufs = publicInputs.map((v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; });
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: auth, isSigner: true,  isWritable: false },
    ],
    data: Buffer.concat([d, vl, ...bufs]),
  });
}
function buildCloseProofBufferIx(buf: PublicKey, auth: PublicKey) {
  const d = Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]);
  return new TransactionInstruction({
    programId: STARK_VERIFIER_ID,
    keys: [
      { pubkey: buf, isSigner: false, isWritable: true },
      { pubkey: auth, isSigner: true,  isWritable: true },
    ],
    data: d,
  });
}

async function uploadProofChunks(
  connection: Connection, authority: Keypair, buf: PublicKey, bytes: Buffer,
) {
  for (let off = 0; off < bytes.length; off += MAX_CHUNK_SIZE) {
    const slice = bytes.subarray(off, Math.min(off + MAX_CHUNK_SIZE, bytes.length));
    await withRetry(async () => {
      const sig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(buildWriteProofChunkIx(buf, authority.publicKey, off, slice)),
        [authority],
        { commitment: 'confirmed', skipPreflight: true },
      );
      await connection.confirmTransaction(sig, 'confirmed');
    });
  }
}

async function cleanupStaleProofBuffer(
  connection: Connection, authority: Keypair, buf: PublicKey,
) {
  const info = await connection.getAccountInfo(buf);
  if (!info) return;
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(buildCloseProofBufferIx(buf, authority.publicKey)),
      [authority],
      { commitment: 'confirmed', skipPreflight: true },
    );
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// p01_liquidity ix builders (mirrors scripts/run-settler.ts + init-liquidity-pool.ts)
// ---------------------------------------------------------------------------
interface PrefundIxArgs {
  ephemeralSigner: PublicKey;
  recipient: PublicKey;
  poolPDA: PublicKey;
  starkProofBuffer: PublicKey;
  denominatedPool: PublicKey;
  prefundRecord: PublicKey;
  nullifier: Buffer;
  merkleRoot: Buffer;
  minEpoch: bigint;
  starkCommitment: bigint;
  amount: bigint;
}
function buildPrefundIx(args: PrefundIxArgs): TransactionInstruction {
  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8 + 8);
  let off = 0;
  disc8('prefund').copy(data, off); off += 8;
  args.nullifier.copy(data, off);   off += 32;
  args.merkleRoot.copy(data, off);  off += 32;
  data.writeBigUInt64LE(args.minEpoch, off);        off += 8;
  data.writeBigUInt64LE(args.starkCommitment, off); off += 8;
  data.writeBigUInt64LE(args.amount, off);
  return new TransactionInstruction({
    programId: P01_LIQUIDITY_ID,
    keys: [
      { pubkey: args.ephemeralSigner,  isSigner: true,  isWritable: true  },
      { pubkey: args.recipient,        isSigner: false, isWritable: true  },
      { pubkey: args.poolPDA,          isSigner: false, isWritable: true  },
      { pubkey: args.starkProofBuffer, isSigner: false, isWritable: false },
      { pubkey: args.denominatedPool,  isSigner: false, isWritable: false },
      { pubkey: args.prefundRecord,    isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

interface SettleIxArgs {
  settler: PublicKey;
  poolPDA: PublicKey;
  prefundRecord: PublicKey;
  denominatedPool: PublicKey;
  merkleTree: PublicKey;
  nullifierRecord: PublicKey;
  starkProofBuffer: PublicKey;
}
function buildSettleIx(a: SettleIxArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId: P01_LIQUIDITY_ID,
    keys: [
      { pubkey: a.settler,           isSigner: true,  isWritable: true  },
      { pubkey: a.poolPDA,           isSigner: false, isWritable: true  },
      { pubkey: a.prefundRecord,     isSigner: false, isWritable: true  },
      { pubkey: a.denominatedPool,   isSigner: false, isWritable: true  },
      { pubkey: a.merkleTree,        isSigner: false, isWritable: false },
      { pubkey: a.nullifierRecord,   isSigner: false, isWritable: true  },
      { pubkey: a.starkProofBuffer,  isSigner: false, isWritable: false },
      { pubkey: PROTOCOL_FEE_WALLET, isSigner: false, isWritable: true  },
      { pubkey: ZK_SHIELDED_ID,      isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc8('settle'),
  });
}

// ---------------------------------------------------------------------------
// Pool state parser (mirror of parseLiquidityPoolState)
// ---------------------------------------------------------------------------
function parsePoolReserve(data: Buffer): { reserveLamports: bigint; feeBps: number; rewardBps: number } {
  return {
    reserveLamports: data.readBigUInt64LE(56),
    feeBps:          data.readUInt16LE(64),
    rewardBps:       data.readUInt16LE(66),
  };
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------
const randomBytes32 = () => crypto.randomBytes(32);
function nullifierFromU64(u64: bigint): Buffer {
  const b = Buffer.alloc(32);
  b.writeBigUInt64LE(u64, 0);
  return b;
}

async function logErrorDetails(err: any, label: string, connection: Connection) {
  const sig = err?.signature ?? err?.txSignature;
  console.error(`${label} ERROR: ${err?.message ?? err}`);
  if (sig) console.error(`${label} SIG: ${sig}`);
  if (err?.logs?.length) {
    console.error(`${label} LOGS (preflight):\n${err.logs.slice(-40).join('\n')}`);
    return;
  }
  if (sig) {
    try {
      const tx = await connection.getTransaction(sig, {
        commitment: 'confirmed', maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages?.length) {
        console.error(`${label} LOGS (getTransaction):\n${tx.meta.logMessages.slice(-40).join('\n')}`);
      }
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('p01_liquidity instant-unshield (prefund → settle)', () => {
  const envProvider = AnchorProvider.env();
  const rpcUrl = (envProvider.connection as any)._rpcEndpoint as string;
  const connection = new Connection(rpcUrl, 'confirmed');
  const provider = new AnchorProvider(connection, envProvider.wallet, {
    commitment: 'confirmed', preflightCommitment: 'confirmed',
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.ZkShielded as Program<ZkShielded>;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const recipient = Keypair.generate();

  // Unique denomination to avoid pool PDA collisions. 2M–11M lamports (0.002–0.011 SOL).
  const denomLamports = 2_000_000 + (Date.now() % 9_000_000);
  const denomination = new BN(denomLamports);
  const amount = BigInt(denomLamports);
  const epochDelay = new BN(1);
  const vkHash = Array.from(randomBytes32());

  const np            = BigInt(Math.floor(Math.random() * 0xffffffff));
  const secret        = BigInt(Math.floor(Math.random() * 0xffffffff));
  const epochWitness  = 0n;
  const mintWitness   = 1n;

  let poolPDA: PublicKey;
  let treePDA: PublicKey;
  let proofBufferPDA: PublicKey;
  let liquidityPoolPDA: PublicKey;
  let prefundRecordPDA: PublicKey;
  let nullifierRecordPDA: PublicKey;

  let starkProof: PoolProof;
  let nullifier: Buffer;
  let shieldRoot: Buffer;

  // Fee math — fixed once we read the live pool in `before`.
  let prefundFee = 0n;
  let settlerReward = 0n;
  let recipientAmount = 0n;
  let unshieldFee = 0n;

  before(async () => {
    [poolPDA]          = deriveDenominatedPoolPDA(NATIVE_SOL_MINT, denomination);
    [treePDA]          = deriveMerkleTreePDA(poolPDA);
    [proofBufferPDA]   = deriveProofBufferPDA(authority.publicKey, CIRCUIT_POOL_COMMITMENT);
    [liquidityPoolPDA] = deriveLiquidityPoolPDA();

    // Seed fee wallet if absent so fee credits don't require account creation mid-tx.
    const feeInfo = await connection.getAccountInfo(PROTOCOL_FEE_WALLET);
    if (!feeInfo) {
      await provider.sendAndConfirm(
        new Transaction().add(SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey:   PROTOCOL_FEE_WALLET,
          lamports:   0.001 * LAMPORTS_PER_SOL,
        })),
      );
    }

    // Liquidity pool must be initialized + have ≥ recipient_amount in reserve.
    const lp = await connection.getAccountInfo(liquidityPoolPDA);
    if (!lp) throw new Error('p01_liquidity pool not initialized — run scripts/init-liquidity-pool.ts first');
    const { reserveLamports, feeBps, rewardBps } = parsePoolReserve(lp.data);
    expect(feeBps, 'pool prefund_fee_bps drifted').to.equal(EXPECTED_PREFUND_FEE_BPS);
    expect(rewardBps, 'pool settler_reward_bps drifted').to.equal(EXPECTED_SETTLER_REWARD_BPS);

    prefundFee      = (amount * BigInt(feeBps))    / 10_000n;
    settlerReward   = (amount * BigInt(rewardBps)) / 10_000n;
    recipientAmount = amount - prefundFee - settlerReward;
    unshieldFee     = (amount * BigInt(UNSHIELD_FEE_BPS)) / 10_000n;

    if (reserveLamports < recipientAmount) {
      throw new Error(`Pool reserve ${reserveLamports} < recipient_amount ${recipientAmount} — seed more LP`);
    }

    console.log(`    denom:            ${denomLamports} lamports`);
    console.log(`    pool reserve:     ${reserveLamports} lamports`);
    console.log(`    prefund_fee:      ${prefundFee} (${feeBps} bps)`);
    console.log(`    settler_reward:   ${settlerReward} (${rewardBps} bps)`);
    console.log(`    unshield_fee:     ${unshieldFee} (${UNSHIELD_FEE_BPS} bps)`);
    console.log(`    recipient_amount: ${recipientAmount}`);
    console.log(`    lp_profit:        ${prefundFee - unshieldFee} (net 30 bps)`);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 1: fresh denominated pool
  // ─────────────────────────────────────────────────────────────────
  it('initializes a fresh denominated pool', async () => {
    await withRetry(async () => {
      await program.methods
        .initDenominatedPool(vkHash, NATIVE_SOL_MINT, denomination, epochDelay)
        .accountsPartial({
          authority:        authority.publicKey,
          denominatedPool:  poolPDA,
          merkleTree:       treePDA,
          systemProgram:    SystemProgram.programId,
          rent:             SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: 'confirmed' });
    });
    const pool = await program.account.denominatedPool.fetch(poolPDA);
    expect(pool.isActive).to.be.true;
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 2: shield 1 note
  // ─────────────────────────────────────────────────────────────────
  it('shields 1 note', async () => {
    const commitment = Array.from(randomBytes32());
    shieldRoot = randomBytes32();
    await withRetry(async () => {
      await program.methods
        .shieldDenominated(commitment, Array.from(shieldRoot))
        .accountsPartial({
          depositor:         authority.publicKey,
          denominatedPool:   poolPDA,
          merkleTree:        treePDA,
          systemProgram:     SystemProgram.programId,
          tokenProgram:      null,
          userTokenAccount:  null,
          poolVault:         null,
          protocolFeeWallet: PROTOCOL_FEE_WALLET,
        })
        .rpc({ commitment: 'confirmed' });
    });
    const pool = await program.account.denominatedPool.fetch(poolPDA);
    expect(pool.noteCount.toNumber()).to.equal(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 3: generate circuit-1 STARK proof
  // ─────────────────────────────────────────────────────────────────
  it('generates a pool_commitment STARK proof', async function () {
    this.timeout(300_000);
    starkProof = generatePoolCommitmentProof(np, secret, epochWitness, mintWitness);
    nullifier = nullifierFromU64(starkProof.publicInputs[0]);
    [nullifierRecordPDA] = deriveNullifierPDA(poolPDA, nullifier);
    [prefundRecordPDA]   = derivePrefundRecordPDA(poolPDA, nullifier);
    expect(starkProof.circuitId).to.equal(CIRCUIT_POOL_COMMITMENT);
    expect(starkProof.proofBytes.length).to.be.gte(1024);
    console.log(`    proof size:    ${starkProof.proofBytes.length} bytes`);
    console.log(`    nullifier_u64: ${starkProof.publicInputs[0]}`);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 4: upload + verify STARK proof on-chain
  // ─────────────────────────────────────────────────────────────────
  it('uploads + verifies the STARK proof', async function () {
    this.timeout(300_000);
    await cleanupStaleProofBuffer(connection, authority, proofBufferPDA);

    await withRetry(async () => {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(
          buildInitProofBufferIx(proofBufferPDA, authority.publicKey, starkProof.proofBytes.length, CIRCUIT_POOL_COMMITMENT),
        ),
        [authority], { commitment: 'confirmed', skipPreflight: true },
      );
    });

    const targetSize = starkProof.proofBytes.length + PROOF_DATA_OFFSET;
    let currentSize = Math.min(targetSize, 10_240);
    while (currentSize < targetSize) {
      await withRetry(async () => {
        await sendAndConfirmTransaction(
          connection,
          new Transaction().add(buildResizeProofBufferIx(proofBufferPDA, authority.publicKey)),
          [authority], { commitment: 'confirmed', skipPreflight: true },
        );
      });
      currentSize = Math.min(currentSize + MAX_REALLOC_STEP, targetSize);
    }

    await uploadProofChunks(connection, authority, proofBufferPDA, starkProof.proofBytes);

    // Phase 1 — FRI/main verification
    await withRetry(async () => {
      try {
        await sendAndConfirmTransaction(
          connection,
          new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
            .add(buildVerifyStarkProofV2Ix(proofBufferPDA, authority.publicKey, [...starkProof.publicInputs])),
          [authority], { commitment: 'confirmed', skipPreflight: true },
        );
      } catch (err: any) { await logErrorDetails(err, 'PHASE 1', connection); throw err; }
    });

    // Phase 2 — DEEP-ALI
    await withRetry(async () => {
      try {
        await sendAndConfirmTransaction(
          connection,
          new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
            .add(buildVerifyDeepAliPhase2Ix(proofBufferPDA, authority.publicKey, [...starkProof.publicInputs])),
          [authority], { commitment: 'confirmed', skipPreflight: true },
        );
      } catch (err: any) { await logErrorDetails(err, 'PHASE 2', connection); throw err; }
    });

    const info = await connection.getAccountInfo(proofBufferPDA);
    expect(info).to.not.be.null;
    expect(info!.data[49]).to.equal(1); // verified
    expect(info!.data[82]).to.equal(1); // deep_ali_verified
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 5: prefund — p01_liquidity pays recipient instantly
  // ─────────────────────────────────────────────────────────────────
  it('prefunds: recipient receives (amount − fee − reward) immediately', async () => {
    const lpBefore = parsePoolReserve((await connection.getAccountInfo(liquidityPoolPDA))!.data).reserveLamports;
    const recipBefore = await connection.getBalance(recipient.publicKey);

    // stark_commitment u64 = public inputs [1]
    const starkCommitment = starkProof.publicInputs[1];

    await withRetry(async () => {
      try {
        await sendAndConfirmTransaction(
          connection,
          new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
            .add(buildPrefundIx({
              ephemeralSigner:  authority.publicKey,
              recipient:        recipient.publicKey,
              poolPDA:          liquidityPoolPDA,
              starkProofBuffer: proofBufferPDA,
              denominatedPool:  poolPDA,
              prefundRecord:    prefundRecordPDA,
              nullifier,
              merkleRoot:       shieldRoot,
              minEpoch:         0n,
              starkCommitment,
              amount,
            })),
          [authority], { commitment: 'confirmed', skipPreflight: true },
        );
      } catch (err: any) { await logErrorDetails(err, 'PREFUND', connection); throw err; }
    });

    const lpAfter = parsePoolReserve((await connection.getAccountInfo(liquidityPoolPDA))!.data).reserveLamports;
    const recipAfter = await connection.getBalance(recipient.publicKey);

    // Recipient got exactly recipient_amount
    expect(recipAfter - recipBefore).to.equal(Number(recipientAmount));

    // Pool reserve decreased by exactly recipient_amount
    expect(lpBefore - lpAfter).to.equal(recipientAmount);

    // PrefundRecord now exists
    const rec = await connection.getAccountInfo(prefundRecordPDA);
    expect(rec, 'prefund record missing').to.not.be.null;
    expect(rec!.owner.toBase58()).to.equal(P01_LIQUIDITY_ID.toBase58());
    expect(rec!.data.length).to.equal(273);

    console.log(`    recipient +${recipAfter - recipBefore} lamports`);
    console.log(`    pool      -${lpBefore - lpAfter} lamports (reserve)`);
  });

  // ─────────────────────────────────────────────────────────────────
  // Step 6: settle — CPI into zk_shielded.unshield_denominated_stark
  // ─────────────────────────────────────────────────────────────────
  it('settles: nullifier burned, pool reimbursed, PrefundRecord closed', async () => {
    const lpBefore = parsePoolReserve((await connection.getAccountInfo(liquidityPoolPDA))!.data).reserveLamports;
    const settlerBefore = await connection.getBalance(authority.publicKey);

    await withRetry(async () => {
      try {
        await sendAndConfirmTransaction(
          connection,
          new Transaction()
            .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
            .add(buildSettleIx({
              settler:         authority.publicKey,
              poolPDA:         liquidityPoolPDA,
              prefundRecord:   prefundRecordPDA,
              denominatedPool: poolPDA,
              merkleTree:      treePDA,
              nullifierRecord: nullifierRecordPDA,
              starkProofBuffer: proofBufferPDA,
            })),
          [authority], { commitment: 'confirmed', skipPreflight: true },
        );
      } catch (err: any) { await logErrorDetails(err, 'SETTLE', connection); throw err; }
    });

    const lpAfter = parsePoolReserve((await connection.getAccountInfo(liquidityPoolPDA))!.data).reserveLamports;

    // Pool delta = +(amount − unshield_fee) − settler_reward = +amount - unshield_fee - settler_reward
    // Over full cycle (prefund+settle): pool delta = prefund_fee − unshield_fee (LP profit = 30 bps)
    const poolDelta = lpAfter - lpBefore;
    const expectedPoolDelta = amount - unshieldFee - settlerReward;
    expect(poolDelta, 'pool reserve delta after settle').to.equal(expectedPoolDelta);

    // PrefundRecord closed (close = settler)
    const rec = await connection.getAccountInfo(prefundRecordPDA);
    expect(rec, 'prefund record should be closed').to.be.null;

    // Nullifier PDA now exists (double-spend blocked)
    const nulInfo = await connection.getAccountInfo(nullifierRecordPDA);
    expect(nulInfo, 'nullifier record missing').to.not.be.null;
    expect(nulInfo!.owner.toBase58()).to.equal(ZK_SHIELDED_ID.toBase58());

    // denominated_pool state cleared for this note
    const dp = await program.account.denominatedPool.fetch(poolPDA);
    expect(dp.noteCount.toNumber()).to.equal(0);
    expect(dp.totalShielded.toNumber()).to.equal(0);

    // Full-cycle conservation: pool's LP profit over the cycle = prefund_fee − unshield_fee
    // (pool reserve net change = +prefund_fee − unshield_fee; settler_reward net zero vs prefund pocketed it then settle paid it back out)
    // Recompute from the initial before-prefund reserve isn't tracked here; the two-step delta checks above suffice.

    const settlerAfter = await connection.getBalance(authority.publicKey);
    console.log(`    pool delta: +${poolDelta} lamports (expected ${expectedPoolDelta})`);
    console.log(`    settler net (fees−reward): ${settlerAfter - settlerBefore} lamports`);
  });

  // ─────────────────────────────────────────────────────────────────
  // Cleanup: close the proof buffer, recover rent
  // ─────────────────────────────────────────────────────────────────
  after('close STARK proof buffer', async () => {
    try {
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(buildCloseProofBufferIx(proofBufferPDA, authority.publicKey)),
        [authority], { commitment: 'confirmed', skipPreflight: true },
      );
    } catch { /* best-effort */ }
  });
});
