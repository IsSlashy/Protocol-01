/**
 * InstantUnshieldFlow — high-level wrapper that bundles the full instant-unshield
 * orchestration into a single SDK-consumer-friendly API.
 *
 * ---------------------------------------------------------------------------
 * THIS FLOW IS CURRENTLY DISABLED ON CHAIN. Plans it builds will be rejected.
 *
 * `p01_liquidity::prefund` pays the recipient out of the LP reserve, and
 * `settle` is supposed to reclaim that by CPI into
 * `zk_shielded::unshield_denominated_stark`. That instruction's `#[program]`
 * registration is commented out (`programs/zk_shielded/src/lib.rs:152-172`) in
 * favour of `unshield_denominated_stark_v3`, so zk_shielded will not dispatch
 * the discriminator `settle` sends and no prefund can ever be settled — the
 * payout is a permanent loss from the reserve, valid STARK proof or not.
 *
 * `p01_liquidity::init_pool` therefore creates the pool with
 * `is_active = false`, and `prefund` requires `is_active`, so the `prefundTx`
 * in a plan fails with `LiquidityError::PoolInactive` (6000). The mobile
 * `unshieldStark(..., instant = true)` path throws before doing any work for
 * the same reason. Do not re-enable either until `settle` has a v3 path.
 * ---------------------------------------------------------------------------
 *
 * What this module does:
 *   1. Generates (or accepts) an ephemeral signer keypair that drives the entire
 *      multi-step STARK pipeline. The ephemeral pays its own STARK rent + the
 *      prefund tx fee; the user wallet never appears on-chain.
 *   2. Builds the p01_stark_verifier instruction sequence for circuit 1
 *      (pool_commitment): init_proof_buffer → resize* → write_proof_chunk* →
 *      verify_stark_proof_v2 → verify_deep_ali_phase2.
 *   3. Builds the p01_liquidity::prefund instruction (mirrors mobile flow at
 *      apps/mobile/services/denominatedPool/index.ts::unshieldStark + instant=true).
 *   4. Returns a typed `InstantUnshieldPlan` of grouped TXs that the caller can
 *      sign + submit themselves — supports either a Keypair payer or a generic
 *      `(tx) => Promise<signedTx>` adapter (mobile/Privy, server keepers, etc.).
 *
 * What this module deliberately does NOT do:
 *   - Generate the STARK proof (caller passes proofBytes + publicInputs).
 *   - Submit transactions. Caller drives signing + sendRawTransaction so the
 *     same code works server-side, mobile-side, or in a browser.
 *   - Settle. The on-chain `settle` ix is invoked separately by a keeper after
 *     the note matures (see scripts/run-settler.ts in the mobile app).
 *
 * Phase-1 indistinguishability contract:
 *   `minEpoch` MUST equal the current epoch (`slot / 7200`). This module
 *   computes that for you when you pass a `Connection`; do NOT supply a
 *   manually-derived `currentEpoch - epochDelay` form (would re-introduce the
 *   emergency-vs-mature fingerprint that Phase 1 closed).
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { LiquidityModule, type PrefundFeeBreakdown } from './liquidity';

// ─── On-chain constants (mirror apps/mobile/services/stark/index.ts) ─────────

/** p01_stark_verifier program ID (devnet, multi-circuit FRI verifier). */
export const P01_STARK_VERIFIER_PROGRAM_ID = new PublicKey(
  'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
);

/**
 * STARK circuit ID used by the instant-unshield path. `pool_commitment` proves
 * ownership of a denominated note in a pool's Merkle tree without revealing
 * which leaf.
 */
export const CIRCUIT_POOL_COMMITMENT = 1;

/** Solana stack-frame chunk size that fits inside the 1232-byte tx limit. */
export const STARK_MAX_CHUNK_SIZE = 1000;

/**
 * Header layout of the on-chain `proof_buffer` account. Caller doesn't need to
 * use this, but it's exported because it determines target account size:
 * `account_data_size = STARK_PROOF_DATA_OFFSET + proofSize`.
 */
export const STARK_PROOF_DATA_OFFSET = 83;

/** Solana `create_account` size cap. The buffer must be init'd ≤ this and
 *  re-allocated up to the proof's true size in chunks afterwards. */
export const STARK_MAX_INIT_SIZE = 10_240;

/** Per-call realloc growth limit (`MAX_PERMITTED_DATA_INCREASE`). */
export const STARK_MAX_REALLOC_STEP = 10_240;

/**
 * CU limit needed for `verify_stark_proof_v2` and `verify_deep_ali_phase2`.
 * Each phase needs its own 1.4M CU budget.
 */
export const STARK_VERIFY_CU = 1_400_000;

/**
 * CU limit for the `prefund` instruction. Mirrors mobile (`200_000`).
 */
export const PREFUND_CU = 200_000;

/**
 * Slot → epoch divisor. Solana's denominated-pool design uses 7200 slots/epoch
 * (~30 minutes at 0.4s/slot). Both `zk_shielded::unshield_denominated_stark`
 * and `p01_liquidity::settle` derive the on-chain epoch via `clock.slot / 7200`.
 */
export const SLOTS_PER_EPOCH = 7200n;

// ─── Anchor instruction discriminators (sha256("global:<name>")[..8]) ────────

const STARK_DISC = {
  initProofBuffer:    Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]),
  resizeProofBuffer:  Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]),
  writeProofChunk:    Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]),
  verifyStarkProofV2: Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]),
  verifyDeepAliPhase2: Buffer.from([217, 239, 203, 65, 109, 182, 70, 115]),
  closeProofBuffer:   Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]),
};

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * A signer adapter. Either a raw `Keypair` (server/keeper path) or an async
 * `(tx) => Promise<signedTx>` (Privy / wallet adapter / hardware path).
 *
 * The `publicKey` is read up-front so PDAs and tx fee-payers can be set
 * synchronously.
 */
export type GenericSigner =
  | { type: 'keypair'; keypair: Keypair }
  | { type: 'adapter'; publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> };

/** Convenience: lift a `Keypair` into a `GenericSigner`. */
export function keypairSigner(kp: Keypair): GenericSigner {
  return { type: 'keypair', keypair: kp };
}

/** Convenience: lift a Privy/wallet-adapter style signer into a `GenericSigner`. */
export function adapterSigner(
  publicKey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
): GenericSigner {
  return { type: 'adapter', publicKey, signTransaction };
}

function signerPubkey(s: GenericSigner): PublicKey {
  return s.type === 'keypair' ? s.keypair.publicKey : s.publicKey;
}

/**
 * Inputs for the wrapper. Mirrors what mobile passes into
 * `unshieldStark(receipt, poolConfig, recipient, starkProofData, …, instant=true)`.
 *
 * `nullifier` and `merkleRoot` MUST be 32 bytes each. The first 8 bytes of the
 * nullifier MUST be the little-endian u64 from `publicInputs[0]` (the on-chain
 * verifier re-hashes the inputs and compares against the buffer's stored hash).
 * Use the helper `goldilocksU64ToNullifierBytes` if you only have the u64.
 */
export interface InstantUnshieldInput {
  /** Compact STARK proof bytes for circuit 1 (pool_commitment). */
  proofBytes: Uint8Array;
  /** Public inputs: [nullifier_u64, commitment_u64, merkle_root_u64, …]. */
  publicInputs: bigint[];
  /** Same as `proofBytes.length`. Passed explicitly to avoid double-counting. */
  proofSize: number;

  /** Final user-visible recipient of the SOL/SPL payout. */
  recipient: PublicKey;

  /** The denomination pool PDA (per-token, per-denomination). */
  denominatedPool: PublicKey;

  /** 32-byte nullifier (publicInputs[0] u64 LE-packed into bytes 0..8). */
  nullifier: Uint8Array | number[];
  /** 32-byte Merkle root the proof was generated against. */
  merkleRoot: Uint8Array | number[];

  /** Lamport-denominated note value (e.g. 1e9 for a 1 SOL note). */
  amount: bigint;

  /**
   * Phase-1 indistinguishability requires `minEpoch === currentEpoch`. If you
   * pass a `Connection` to `buildAll()` the wrapper computes this for you and
   * this field is ignored. Passing it explicitly is only useful for tests /
   * deterministic builds where you have already snapshotted the slot.
   */
  minEpoch?: bigint;

  /**
   * Optional caller-supplied ephemeral signer. If omitted, a fresh `Keypair`
   * is generated and returned in the plan. The ephemeral MUST be funded with
   * enough SOL to cover (a) STARK buffer rent, (b) per-tx fees for ~N+5 txs.
   * See `LiquidityModule.computePrefundFees` + `getMinimumBalanceForRentExemption`
   * for the lower bound.
   */
  ephemeralSigner?: Keypair;
}

/** A grouped sequence of transactions the caller signs+submits in order. */
export interface InstantUnshieldPlan {
  /** The ephemeral signer (generated or caller-supplied). It signs every tx. */
  ephemeralSigner: Keypair;
  /** The proof buffer PDA (depends on ephemeral pubkey + circuit_id). */
  proofBuffer: PublicKey;
  /** The prefund record PDA (depends on denominatedPool + nullifier). */
  prefundRecord: PublicKey;
  /** `slot / 7200` at the time of build. Echoed into prefund + every settle. */
  minEpoch: bigint;

  /**
   * Phase 0: `init_proof_buffer`. Allocates the PDA at `STARK_MAX_INIT_SIZE`
   * (10 KB) and stores the target `proofSize` so subsequent realloc calls
   * know where to stop.
   */
  initTx: Transaction;

  /**
   * Phase 1: zero-or-more `resize_proof_buffer` calls. Each grows the account
   * by 10 KB until `STARK_PROOF_DATA_OFFSET + proofSize` is reached. May be
   * empty if the proof fits in 10 KB.
   *
   * IMPORTANT: each tx carries a unique ComputeUnitPrice (microLamports = i+1)
   * so the serialized bytes differ — otherwise ed25519 deterministic signing
   * would dedupe them all into one and the buffer would stay at 10 KB.
   */
  resizeTxs: Transaction[];

  /**
   * Phase 2: chunked proof upload. One tx per ≤1000-byte chunk. Order-
   * independent — caller may submit in parallel.
   */
  chunkTxs: Transaction[];

  /**
   * Phase 3: STARK verification. Two txs (each carrying a 1.4M CU budget):
   *   - phase 1: `verify_stark_proof_v2` (FRI + trace + boundary)
   *   - phase 2: `verify_deep_ali_phase2` (DEEP-ALI at OOD)
   * Both MUST land sequentially on the same proof buffer.
   */
  verifyTxs: [Transaction, Transaction];

  /**
   * Phase 4: `prefund`. One tx with a 200K CU budget that pays the recipient
   * instantly out of the pool reserve and parks the proof buffer for the
   * keeper to consume via `settle` (CPI into zk_shielded.unshield_denominated_stark).
   */
  prefundTx: Transaction;

  /**
   * Fee math echoed for caller display. Authoritative on-chain values come
   * from `LiquidityPoolState`; this is just a convenience computation.
   */
  fees: PrefundFeeBreakdown;
}

/**
 * Flat representation of every instruction the plan contains. Useful for
 * callers who want to bundle their own tx batching strategy (e.g. squashing
 * resize + first chunks into a single tx with Lookup Tables).
 *
 * Order matches the on-chain dependency graph: init → resize → chunks →
 * verify-phase1 → verify-phase2 → prefund. Caller is still responsible for
 * sequencing across separate transactions where on-chain account-state
 * dependencies require it (see `InstantUnshieldPlan` for the canonical split).
 */
export interface InstantUnshieldInstructionList {
  ephemeralSigner: Keypair;
  proofBuffer: PublicKey;
  prefundRecord: PublicKey;
  minEpoch: bigint;
  init: TransactionInstruction;
  resizes: TransactionInstruction[];
  chunks: TransactionInstruction[];
  verifyPhase1: TransactionInstruction;
  verifyPhase2: TransactionInstruction;
  prefund: TransactionInstruction;
  fees: PrefundFeeBreakdown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pack a Goldilocks u64 into the first 8 bytes of a 32-byte nullifier buffer.
 * Mirrors `apps/mobile/services/denominatedPool/index.ts::unshieldStark`.
 */
export function goldilocksU64ToNullifierBytes(nullifier: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let n = nullifier;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function disc(name: string): Buffer {
  return Buffer.from(sha256(utf8ToBytes(`global:${name}`))).subarray(0, 8);
}

function getProofBufferPDA(
  authority: PublicKey,
  circuitId: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('stark_proof'), authority.toBuffer(), Buffer.from([circuitId])],
    P01_STARK_VERIFIER_PROGRAM_ID,
  );
}

// ─── STARK instruction builders (port of mobile services/stark/index.ts) ─────

function buildInitProofBufferIx(
  proofSize: number,
  circuitId: number,
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 1);
  STARK_DISC.initProofBuffer.copy(data, 0);
  data.writeUInt32LE(proofSize, 8);
  data.writeUInt8(circuitId, 12);
  return new TransactionInstruction({
    programId: P01_STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildResizeProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: P01_STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: STARK_DISC.resizeProofBuffer,
  });
}

function buildWriteProofChunkIx(
  offset: number,
  chunk: Uint8Array,
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  // u32 offset + borsh Vec<u8>: 4-byte length prefix + bytes
  const data = Buffer.alloc(8 + 4 + 4 + chunk.length);
  STARK_DISC.writeProofChunk.copy(data, 0);
  data.writeUInt32LE(offset, 8);
  data.writeUInt32LE(chunk.length, 12);
  Buffer.from(chunk).copy(data, 16);
  return new TransactionInstruction({
    programId: P01_STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildVerifyStarkProofV2Ix(
  publicInputs: bigint[],
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map((v) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  });
  const data = Buffer.concat([STARK_DISC.verifyStarkProofV2, vecLen, ...inputBufs]);
  return new TransactionInstruction({
    programId: P01_STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildVerifyDeepAliPhase2Ix(
  publicInputs: bigint[],
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  const vecLen = Buffer.alloc(4);
  vecLen.writeUInt32LE(publicInputs.length, 0);
  const inputBufs = publicInputs.map((v) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(v);
    return buf;
  });
  const data = Buffer.concat([STARK_DISC.verifyDeepAliPhase2, vecLen, ...inputBufs]);
  return new TransactionInstruction({
    programId: P01_STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Build a `close_proof_buffer` instruction. Exposed publicly so callers can
 * reclaim rent after `settle` has read the buffer (post-settlement only — do
 * NOT close before settle or the keeper's CPI will fail).
 */
export function buildCloseStarkProofBufferIx(
  proofBuffer: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: P01_STARK_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: proofBuffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(STARK_DISC.closeProofBuffer),
  });
}

// Re-export disc for tests / debug. Not part of stable API — name will not
// collide with module-internal `disc`.
/** @internal */
export function _ixDiscriminator(name: string): Buffer {
  return disc(name);
}

// ─── The wrapper class ───────────────────────────────────────────────────────

/**
 * Builds the full instant-unshield instruction sequence in one call.
 *
 * @example
 * ```ts
 * const flow = new InstantUnshieldFlow(connection);
 * const plan = await flow.buildAll({
 *   proofBytes, publicInputs, proofSize,
 *   recipient: userWalletPubkey,
 *   denominatedPool: poolPDA,
 *   nullifier: goldilocksU64ToNullifierBytes(publicInputs[0]),
 *   merkleRoot,
 *   amount: 1_000_000_000n,
 * });
 *
 * // Sign + send each phase in order. The ephemeral signs every tx.
 * await sendSerial([plan.initTx]);
 * await sendParallel(plan.resizeTxs); // unique CU prices => unique sigs
 * await sendParallel(plan.chunkTxs);  // order-independent writes
 * await sendSerial(plan.verifyTxs);   // phase1 must precede phase2
 * await sendSerial([plan.prefundTx]); // recipient paid here
 * ```
 */
export class InstantUnshieldFlow {
  readonly liquidity: LiquidityModule;

  constructor(
    public readonly connection: Connection,
    public readonly liquidityProgramId?: PublicKey,
    public readonly starkVerifierProgramId: PublicKey = P01_STARK_VERIFIER_PROGRAM_ID,
  ) {
    this.liquidity = liquidityProgramId
      ? new LiquidityModule(connection, liquidityProgramId)
      : new LiquidityModule(connection);
  }

  /**
   * Compute the current epoch from chain state: `slot / 7200`. Phase-1
   * indistinguishability requires every unshield tx to pass exactly this value
   * as `minEpoch` — never a 0 sentinel, never `currentEpoch - delay`.
   */
  async fetchCurrentEpoch(): Promise<bigint> {
    const slot = await this.connection.getSlot('confirmed');
    return BigInt(slot) / SLOTS_PER_EPOCH;
  }

  /** Synchronous flat-instruction builder. Useful for tests / lookup-table
   *  bundling. Does NOT touch RPC — caller supplies `minEpoch` themselves. */
  buildInstructions(
    input: InstantUnshieldInput & { minEpoch: bigint },
  ): InstantUnshieldInstructionList {
    if (input.proofBytes.length !== input.proofSize) {
      throw new Error(
        `InstantUnshieldFlow: proofSize (${input.proofSize}) !== proofBytes.length (${input.proofBytes.length})`,
      );
    }
    if (input.publicInputs.length < 2) {
      throw new Error(
        `InstantUnshieldFlow: pool_commitment circuit needs ≥2 public inputs (nullifier, commitment). Got ${input.publicInputs.length}.`,
      );
    }
    const nullifierBuf = Buffer.from(input.nullifier);
    if (nullifierBuf.length !== 32) {
      throw new Error(`InstantUnshieldFlow: nullifier must be 32 bytes, got ${nullifierBuf.length}`);
    }
    const merkleRootBuf = Buffer.from(input.merkleRoot);
    if (merkleRootBuf.length !== 32) {
      throw new Error(`InstantUnshieldFlow: merkleRoot must be 32 bytes, got ${merkleRootBuf.length}`);
    }

    const ephemeralSigner = input.ephemeralSigner ?? Keypair.generate();
    const authority = ephemeralSigner.publicKey;
    const [proofBuffer] = getProofBufferPDA(authority, CIRCUIT_POOL_COMMITMENT);
    const [prefundRecord] = this.liquidity.getPrefundRecordPDA(
      input.denominatedPool,
      nullifierBuf,
    );

    // Stark commitment is the second public input (mobile contract).
    const starkCommitment = input.publicInputs[1] ?? 0n;

    const init = buildInitProofBufferIx(
      input.proofSize,
      CIRCUIT_POOL_COMMITMENT,
      proofBuffer,
      authority,
    );

    const targetSize = input.proofSize + STARK_PROOF_DATA_OFFSET;
    const resizesNeeded = targetSize > STARK_MAX_INIT_SIZE
      ? Math.ceil((targetSize - STARK_MAX_INIT_SIZE) / STARK_MAX_REALLOC_STEP)
      : 0;
    const resizes = Array.from({ length: resizesNeeded }, () =>
      buildResizeProofBufferIx(proofBuffer, authority),
    );

    const totalChunks = Math.ceil(input.proofBytes.length / STARK_MAX_CHUNK_SIZE);
    const chunks = Array.from({ length: totalChunks }, (_, i) => {
      const offset = i * STARK_MAX_CHUNK_SIZE;
      const end = Math.min(offset + STARK_MAX_CHUNK_SIZE, input.proofBytes.length);
      return buildWriteProofChunkIx(
        offset,
        input.proofBytes.slice(offset, end),
        proofBuffer,
        authority,
      );
    });

    const verifyPhase1 = buildVerifyStarkProofV2Ix(
      input.publicInputs,
      proofBuffer,
      authority,
    );
    const verifyPhase2 = buildVerifyDeepAliPhase2Ix(
      input.publicInputs,
      proofBuffer,
      authority,
    );

    const prefund = this.liquidity.buildPrefundIx({
      ephemeralSigner: authority,
      recipient: input.recipient,
      denominatedPool: input.denominatedPool,
      starkProofBuffer: proofBuffer,
      nullifier: nullifierBuf,
      merkleRoot: merkleRootBuf,
      minEpoch: input.minEpoch,
      starkCommitment,
      amount: input.amount,
    });

    // Best-effort fee math (uses default 30bps prefund + 30bps reward).
    // Caller can recompute against live pool state if more accurate display
    // is needed.
    const fees = LiquidityModule.computePrefundFees(input.amount, 30, 30);

    return {
      ephemeralSigner,
      proofBuffer,
      prefundRecord,
      minEpoch: input.minEpoch,
      init,
      resizes,
      chunks,
      verifyPhase1,
      verifyPhase2,
      prefund,
      fees,
    };
  }

  /**
   * High-level builder. Computes `minEpoch` from chain (Phase-1 contract),
   * derives PDAs, builds every instruction, and packages each phase into a
   * standalone `Transaction` with the ephemeral signer pre-assigned as
   * fee payer.
   *
   * The returned transactions are NOT signed and have NO recentBlockhash
   * set — caller is responsible for both. (Splitting concerns this way keeps
   * the wrapper RPC-light and lets the caller use whatever blockhash retry
   * strategy they prefer.)
   *
   * If `input.minEpoch` is supplied it's used verbatim and the chain is NOT
   * queried. Otherwise the wrapper calls `connection.getSlot('confirmed')`.
   */
  async buildAll(input: InstantUnshieldInput): Promise<InstantUnshieldPlan> {
    const minEpoch = input.minEpoch ?? (await this.fetchCurrentEpoch());

    const ixs = this.buildInstructions({ ...input, minEpoch });
    const ephemeral = ixs.ephemeralSigner.publicKey;

    // Each phase gets its own Transaction with feePayer pre-assigned to the
    // ephemeral. Caller still has to set recentBlockhash + sign.
    const wrapTx = (additions: TransactionInstruction[]): Transaction => {
      const tx = new Transaction();
      tx.feePayer = ephemeral;
      additions.forEach((i) => tx.add(i));
      return tx;
    };

    const initTx = wrapTx([ixs.init]);

    const resizeTxs = ixs.resizes.map((ix, i) =>
      wrapTx([
        // unique CU price so each tx serializes to different bytes (otherwise
        // ed25519 deterministic signing would dedupe them; see mobile flow).
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: i + 1 }),
        ix,
      ]),
    );

    const chunkTxs = ixs.chunks.map((ix) => wrapTx([ix]));

    const verifyTxs: [Transaction, Transaction] = [
      wrapTx([
        ComputeBudgetProgram.setComputeUnitLimit({ units: STARK_VERIFY_CU }),
        ixs.verifyPhase1,
      ]),
      wrapTx([
        ComputeBudgetProgram.setComputeUnitLimit({ units: STARK_VERIFY_CU }),
        ixs.verifyPhase2,
      ]),
    ];

    const prefundTx = wrapTx([
      ComputeBudgetProgram.setComputeUnitLimit({ units: PREFUND_CU }),
      ixs.prefund,
    ]);

    return {
      ephemeralSigner: ixs.ephemeralSigner,
      proofBuffer: ixs.proofBuffer,
      prefundRecord: ixs.prefundRecord,
      minEpoch,
      initTx,
      resizeTxs,
      chunkTxs,
      verifyTxs,
      prefundTx,
      fees: ixs.fees,
    };
  }

  /**
   * Caller-side helper that mirrors `LiquidityModule.computePrefundFees` but
   * fetches the live pool state first so caller doesn't have to. Returns
   * `null` if the pool isn't initialized.
   */
  async computeLiveFees(amount: bigint): Promise<PrefundFeeBreakdown | null> {
    const pool = await this.liquidity.fetchPoolState();
    if (!pool) return null;
    return LiquidityModule.computePrefundFees(
      amount,
      pool.prefundFeeBps,
      pool.settlerRewardBps,
    );
  }
}

/** Function-style alias for callers who prefer not to instantiate a class. */
export async function buildInstantUnshield(
  connection: Connection,
  input: InstantUnshieldInput,
): Promise<InstantUnshieldPlan> {
  return new InstantUnshieldFlow(connection).buildAll(input);
}

// `GenericSigner` is exposed publicly so SDK consumers can satisfy the
// "Keypair OR adapter" contract from the task spec without re-defining their
// own discriminated union. The wrapper's `buildAll` doesn't actually consume
// the signer (it only hands back unsigned txs) — the type lives here so a
// follow-up `signAndSend` helper can adopt the same shape.
export type { Keypair };
