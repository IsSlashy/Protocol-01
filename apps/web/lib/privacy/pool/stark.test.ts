/**
 * Chunk-upload resume + torn-buffer gate tests — stark.ts
 *
 * Simulates, WITHOUT devnet, the exact failure the deployed verifier cannot
 * see: `bytes_written` on-chain is a high-water mark
 * (`bytes_written = bytes_written.max(offset + len)`, lib.rs:89-90), so a lost
 * middle chunk leaves a hole of zeros that the program's own completeness
 * check (`bytes_written >= proof_size`, lib.rs:118) walks right past. The
 * client-side readback gate added by C3 is the only check that can tell a
 * complete buffer from a torn one.
 *
 * Positive controls (tests that are RED against the pre-C3 implementation):
 *  - "deployed completeness check passes over a torn buffer" proves the
 *    on-chain gate alone — all the old code relied on — is green on a hole.
 *  - "resends only the lost chunks" fails on the old code, which sent each
 *    chunk exactly once and threw `Chunk upload timed out`.
 *  - the lying-statuses tests fail on the old code, which would have sent the
 *    1.4M CU verify transaction on a torn buffer.
 *
 * Environment: node (vitest.pool.config.mts) with the REAL @solana/web3.js —
 * transactions are actually signed and re-parsed by the fake RPC, so the
 * offset/bytes wiring is exercised end to end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import { decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Address, type Instruction } from '@solana/kit';
import nacl from 'tweetnacl';
import { TX_V1_FEATURE_GATE, V1_CHUNK_SIZE, V1_MAX_WIRE_BYTES } from './txv1';
import { Buffer } from 'buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  submitStarkProof,
  submitAndVerifyStarkProof,
  closeStarkProofBuffer,
  splitProofIntoChunks,
  findBufferHoles,
  PROOF_DATA_OFFSET,
  MAX_CHUNK_SIZE,
  STARK_VERIFIER_PROGRAM_ID,
  CIRCUIT_SPEND,
  CIRCUIT_MERKLE_UPDATE,
  CIRCUIT_POOL_COMMITMENT,
  deriveProofBufferKeypair,
  SINGLE_TX_VERIFY_CU,
  CHUNK_SEND_CONCURRENCY,
  type WalletSigner,
  type GenericStarkProof,
  type CompactStarkProof,
} from './stark';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// 5 chunks: offsets 0/1000/2000/3000/4000, sizes 1000×4 + 500.
const PROOF_SIZE = 4500;
// Never-zero fill so a dropped chunk's zero-hole can never accidentally match.
const PROOF_BYTES = Uint8Array.from({ length: PROOF_SIZE }, (_, i) => (i % 251) + 1);

const FIXED_BLOCKHASH = new PublicKey(Buffer.alloc(32, 7)).toBase58();

// Anchor instruction discriminators, copied from stark.ts (frozen literals —
// they identify the deployed program's handlers and can never change).
const DISC = {
  init: Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]),
  write: Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]),
  verify: Buffer.from([208, 216, 183, 38, 47, 69, 156, 138]),
  initV3: Buffer.from([239, 25, 230, 31, 173, 116, 84, 51]),
  reset: Buffer.from([54, 87, 185, 180, 122, 35, 136, 127]),
  resize: Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]),
  close: Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]),
  verifyV2: Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]),
  deepAli: Buffer.from([217, 239, 203, 65, 109, 182, 70, 115]),
};

interface DropRule {
  /** How many sends of this offset to lose before letting one land. */
  times: number;
  /** Lose the write but still report the signature confirmed — the status
   *  race that only the byte-for-byte readback can catch. */
  lieConfirmed?: boolean;
}

/**
 * Fake RPC implementing exactly the Connection surface stark.ts touches.
 * Chunk writes are re-parsed from the signed transaction bytes and applied to
 * an in-memory account, with `bytesWritten` maintained by the DEPLOYED
 * program's own high-water-mark rule (lib.rs:89-90) so tests can assert what
 * the on-chain completeness check would have said.
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- the _-prefixed params mirror the real Connection signatures */
class FakeConn {
  account: Uint8Array;
  bytesWritten = 0;
  exists = false;
  confirmedSigs = new Set<string>();
  /** offset -> number of times a write for it was SENT (any outcome). */
  writesByOffset = new Map<number, number>();
  drops = new Map<number, DropRule>();
  verifySigs: string[] = [];
  deepAliSigs: string[] = [];
  /** Public inputs decoded off each phase-1 / phase-2 instruction, in send
   *  order. The deployed program re-hashes them in phase 2 and refuses a
   *  mismatch (`public_inputs_hash == buffer.public_inputs_hash`), so "phase 2
   *  ran" and "phase 2 ran on the same statement" are two different facts. */
  verifyInputs: bigint[][] = [];
  deepAliInputs: bigint[][] = [];
  /** Every verifier instruction this connection saw, in send order. */
  ixOrder: string[] = [];
  /** Instruction kinds per TRANSACTION, in send order — what shares a transaction with what. */
  txs: string[][] = [];
  owner = STARK_VERIFIER_PROGRAM_ID;
  /** Peak number of chunk sends in flight at once. */
  inFlight = 0;
  peakInFlight = 0;
  /** [TX-V1] whether the fake cluster reports the feature gate as activated. */
  v1Active = false;
  /** Largest raw transaction seen, in bytes. */
  maxRawBytes = 0;
  /** Lamports of every system transfer seen, in order. */
  transferAmounts: number[] = [];
  /** What `getBalance` answers for any address. */
  balance = 1_000_000_000;
  /** Lamports the proof-buffer account holds (its rent). */
  bufferLamports = 500_000_000;
  async getBalance(_pk: PublicKey, _c?: unknown) {
    return this.balance;
  }
  /** Data length of every chunk write, in order. */
  writeLens: number[] = [];
  getAccountInfoCalls = 0;
  /** bytesWritten snapshot at each getAccountInfo call, in call order. */
  bytesWrittenAtReadback: number[] = [];
  private n = 0;

  constructor(proofSize: number) {
    this.account = new Uint8Array(PROOF_DATA_OFFSET + proofSize);
  }

  async getAccountInfo(_pk: PublicKey) {
    if (_pk.equals(TX_V1_FEATURE_GATE)) {
      return this.v1Active
        ? { data: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0]), owner: PublicKey.default }
        : null;
    }
    this.getAccountInfoCalls++;
    this.bytesWrittenAtReadback.push(this.bytesWritten);
    if (!this.exists) return null;
    return { data: Buffer.from(this.account), owner: this.owner, lamports: this.bufferLamports };
  }

  async getMinimumBalanceForRentExemption(_space: number) {
    return 1_000_000;
  }
  async getLatestBlockhash(_commitment?: unknown) {
    return { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: 1_000 };
  }

  async sendRawTransaction(raw: Buffer | Uint8Array, _opts?: unknown) {
    const sig = `sig_${++this.n}`;
    this.maxRawBytes = Math.max(this.maxRawBytes, raw.length);
    const kinds: string[] = [];
    this.txs.push(kinds);
    for (const ix of decodeInstructions(raw)) {
      if (ix.programId.equals(SystemProgram.programId)) {
        // SystemInstruction::CreateAccount is tag 0.
        if (ix.data.readUInt32LE(0) === 0) kinds.push('createAccount');
        if (ix.data.readUInt32LE(0) === 2) {
          kinds.push('transfer');
          this.transferAmounts.push(Number(ix.data.readBigUInt64LE(4)));
        }
        continue;
      }
      if (!ix.programId.equals(STARK_VERIFIER_PROGRAM_ID)) continue;
      const d = ix.data;
      const disc = d.subarray(0, 8);
      if (disc.equals(DISC.init) || disc.equals(DISC.initV3) || disc.equals(DISC.reset)) {
        const kind = disc.equals(DISC.init) ? 'init' : disc.equals(DISC.initV3) ? 'initV3' : 'reset';
        this.exists = true;
        this.ixOrder.push(kind);
        kinds.push(kind);
        // The header as the program writes it: authority (keys[1]), circuit id,
        // both flags cleared.
        this.account.set(ix.keys[1].pubkey.toBytes(), 8);
        this.account[40] = d.readUInt8(12);
        this.account[49] = 0;
        this.account[82] = 0;
        this.confirmedSigs.add(sig);
      } else if (disc.equals(DISC.write)) {
        this.ixOrder.push('write');
        kinds.push('write');
        this.inFlight += 1;
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
        // Sends resolve on a later tick, so concurrent senders overlap here.
        await new Promise((r) => setTimeout(r, 0));
        this.inFlight -= 1;
        const offset = d.readUInt32LE(8);
        const len = d.readUInt32LE(12);
        this.writeLens.push(len);
        this.writesByOffset.set(offset, (this.writesByOffset.get(offset) ?? 0) + 1);
        const rule = this.drops.get(offset);
        if (rule && rule.times > 0) {
          rule.times--;
          if (rule.lieConfirmed) this.confirmedSigs.add(sig);
          // else: lost in flight — never confirms, bytes never written.
        } else {
          this.account.set(d.subarray(16, 16 + len), PROOF_DATA_OFFSET + offset);
          // lib.rs:89-90 verbatim: a high-water mark, not a count.
          this.bytesWritten = Math.max(this.bytesWritten, offset + len);
          this.confirmedSigs.add(sig);
        }
      } else if (disc.equals(DISC.verify) || disc.equals(DISC.verifyV2)) {
        this.ixOrder.push('verify');
        kinds.push('verify');
        this.account[49] = 1;
        this.verifySigs.push(sig);
        if (disc.equals(DISC.verifyV2)) this.verifyInputs.push(decodePublicInputs(d));
        this.confirmedSigs.add(sig);
      } else if (disc.equals(DISC.deepAli)) {
        this.ixOrder.push('deepAli');
        kinds.push('deepAli');
        this.account[82] = 1;
        this.deepAliSigs.push(sig);
        this.deepAliInputs.push(decodePublicInputs(d));
        this.confirmedSigs.add(sig);
      } else {
        if (disc.equals(DISC.close)) {
          kinds.push('close');
          this.exists = false;
        } else if (disc.equals(DISC.resize)) {
          kinds.push('resize');
        } else {
          kinds.push('other');
        }
        this.confirmedSigs.add(sig);
      }
    }
    return sig;
  }

  async getSignatureStatuses(sigs: string[], _opts?: unknown) {
    return {
      context: { slot: 1 },
      value: sigs.map((s) =>
        this.confirmedSigs.has(s)
          ? { err: null, confirmationStatus: 'confirmed', slot: 1, confirmations: 1 }
          : null,
      ),
    };
  }

  async confirmTransaction(_strategy: unknown, _commitment?: unknown) {
    return { value: { err: null } };
  }

  async getSignatureStatus(_sig: string, _opts?: unknown) {
    return { context: { slot: 1 }, value: { err: null, confirmationStatus: 'confirmed' } };
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}
/* eslint-enable @typescript-eslint/no-unused-vars */

function makeSigner(opts: { signBytes?: boolean } = {}): WalletSigner {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.sign(kp);
      return tx;
    },
    ...(opts.signBytes === false
      ? {}
      : { signBytes: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey) }),
  };
}

/** Instructions of a legacy OR a v1 wire transaction, in the shape the fake reads. */
function decodeInstructions(raw: Buffer | Uint8Array): { programId: PublicKey; data: Buffer; keys: { pubkey: PublicKey }[] }[] {
  try {
    return Transaction.from(raw).instructions.map((ix) => ({ programId: ix.programId, data: Buffer.from(ix.data), keys: ix.keys }));
  } catch {
    const tx = getTransactionDecoder().decode(raw);
    const msg = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes));
    const ixs = msg.instructions as readonly Instruction[];
    return ixs.map((ix: Instruction) => ({
      programId: new PublicKey(String(ix.programAddress)),
      data: Buffer.from(ix.data ?? new Uint8Array()),
      keys: (ix.accounts ?? []).map((a: { address: Address }) => ({ pubkey: new PublicKey(String(a.address)) })),
    }));
  }
}

/**
 * `Vec<u64>` Borsh payload of `verify_stark_proof_v2` / `verify_deep_ali_phase2`:
 * 8-byte discriminator, u32 length, then that many little-endian u64s.
 */
function decodePublicInputs(d: Buffer): bigint[] {
  const n = d.readUInt32LE(8);
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) out.push(d.readBigUInt64LE(12 + i * 8));
  return out;
}

function makeGenericProof(
  circuitId = 1,
  publicInputs: bigint[] = [1n, 2n],
): GenericStarkProof {
  return {
    proofBytes: PROOF_BYTES,
    circuitId,
    publicInputs,
    proofSize: PROOF_SIZE,
  };
}

/**
 * Drive a promise to settlement under fake timers. The upload loop sleeps in
 * 2.5 s polls and 90 s confirm windows, so real time would make these tests
 * take minutes; instead the clock is advanced until the promise settles.
 */
async function drive<T>(p: Promise<T>, maxSimMs = 1_200_000): Promise<T> {
  const state = { done: false, failed: false, value: undefined as T | undefined, error: undefined as unknown };
  p.then(
    (v) => { state.done = true; state.value = v; },
    (e) => { state.done = true; state.failed = true; state.error = e; },
  );
  for (let t = 0; t < maxSimMs && !state.done; t += 2_500) {
    await vi.advanceTimersByTimeAsync(2_500);
  }
  if (!state.done) throw new Error('promise did not settle under fake timers');
  if (state.failed) throw state.error;
  return state.value as T;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pure chunk geometry
// ---------------------------------------------------------------------------

describe('splitProofIntoChunks', () => {
  it('binds index, offset and bytes for a partial last chunk', () => {
    const chunks = splitProofIntoChunks(PROOF_BYTES);
    expect(chunks).toHaveLength(5);
    for (const { index, offset, bytes } of chunks) {
      expect(offset).toBe(index * MAX_CHUNK_SIZE);
      expect(bytes).toEqual(PROOF_BYTES.slice(offset, offset + bytes.length));
    }
    expect(chunks[4].bytes).toHaveLength(500);
  });

  it('handles an exact multiple and a sub-chunk proof', () => {
    expect(splitProofIntoChunks(new Uint8Array(2000)).map((c) => c.bytes.length)).toEqual([1000, 1000]);
    expect(splitProofIntoChunks(new Uint8Array(999)).map((c) => c.bytes.length)).toEqual([999]);
  });
});

// ---------------------------------------------------------------------------
// Torn-buffer detection (pure)
// ---------------------------------------------------------------------------

describe('findBufferHoles', () => {
  function accountWithChunks(skip: number[]): { account: Uint8Array; bytesWritten: number } {
    const account = new Uint8Array(PROOF_DATA_OFFSET + PROOF_SIZE);
    let bytesWritten = 0;
    for (const { index, offset, bytes } of splitProofIntoChunks(PROOF_BYTES)) {
      if (skip.includes(index)) continue;
      account.set(bytes, PROOF_DATA_OFFSET + offset);
      // lib.rs:89-90 verbatim.
      bytesWritten = Math.max(bytesWritten, offset + bytes.length);
    }
    return { account, bytesWritten };
  }

  it('returns no holes for a faithful upload', () => {
    const { account } = accountWithChunks([]);
    expect(findBufferHoles(PROOF_BYTES, account)).toEqual([]);
  });

  it('POSITIVE CONTROL: the deployed completeness check passes over a torn buffer that findBufferHoles catches', () => {
    // Chunk 2 lost in flight, chunks 3 and 4 landed after it.
    const { account, bytesWritten } = accountWithChunks([2]);
    // The program's own gate (lib.rs:118, `bytes_written >= proof_size`) is
    // GREEN on the hole — this is everything the pre-C3 implementation
    // checked, so it would have sent the 1.4M CU verify transaction here.
    expect(bytesWritten).toBeGreaterThanOrEqual(PROOF_SIZE);
    // The client gate is RED. If this assertion ever weakens, the readback
    // gate has stopped guarding anything.
    expect(findBufferHoles(PROOF_BYTES, account)).toEqual([2]);
  });

  it('flags all chunks when the account does not exist', () => {
    expect(findBufferHoles(PROOF_BYTES, null)).toEqual([0, 1, 2, 3, 4]);
  });

  it('flags the unreadable tail of a truncated account', () => {
    const { account } = accountWithChunks([]);
    expect(findBufferHoles(PROOF_BYTES, account.slice(0, PROOF_DATA_OFFSET + 1500))).toEqual([1, 2, 3, 4]);
  });

  it('flags a single corrupted byte', () => {
    const { account } = accountWithChunks([]);
    account[PROOF_DATA_OFFSET + 3200] ^= 0xff;
    expect(findBufferHoles(PROOF_BYTES, account)).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// Upload with resume — integration against the lossy fake RPC
// ---------------------------------------------------------------------------

describe('submitAndVerifyStarkProof — per-chunk resume', () => {
  it('uploads, reads back, and verifies when nothing is lost', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    const result = await drive(
      submitAndVerifyStarkProof(makeGenericProof(), makeSigner(), conn.asConnection()),
    );

    expect(conn.verifySigs).toHaveLength(1);
    expect(conn.deepAliSigs).toHaveLength(1);
    expect(result.txSignature).toBe(conn.verifySigs[0]);
    for (const { offset } of splitProofIntoChunks(PROOF_BYTES)) {
      expect(conn.writesByOffset.get(offset)).toBe(1);
    }
    // Stale-buffer check + the completeness readback: exactly one extra RPC
    // read against a 1.4M CU failed verification.
    expect(conn.getAccountInfoCalls).toBe(2);
    expect(findBufferHoles(PROOF_BYTES, conn.account)).toEqual([]);
  });

  it('resends only the lost chunks and still verifies (RED on the pre-C3 code, which threw "Chunk upload timed out")', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.drops.set(1000, { times: 1 });
    conn.drops.set(3000, { times: 1 });
    const progress: string[] = [];

    await drive(
      submitAndVerifyStarkProof(makeGenericProof(), makeSigner(), conn.asConnection(), (s) =>
        progress.push(s),
      ),
    );

    // Only the two lost offsets were re-sent; the other three went up once.
    expect(conn.writesByOffset.get(0)).toBe(1);
    expect(conn.writesByOffset.get(1000)).toBe(2);
    expect(conn.writesByOffset.get(2000)).toBe(1);
    expect(conn.writesByOffset.get(3000)).toBe(2);
    expect(conn.writesByOffset.get(4000)).toBe(1);
    expect(conn.verifySigs).toHaveLength(1);
    expect(progress.some((s) => /Resending chunk \(round 1\/3\)/.test(s))).toBe(true);
    expect(findBufferHoles(PROOF_BYTES, conn.account)).toEqual([]);
  });

  it('gives a chunk four blockhash lifetimes, then fails WITHOUT sending the verify transaction', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.drops.set(2000, { times: Infinity });

    await expect(
      drive(submitAndVerifyStarkProof(makeGenericProof(), makeSigner(), conn.asConnection())),
    ).rejects.toThrow(/unconfirmed after 3 resend round/);

    // Initial send + 3 resend rounds = 4 attempts, then stop: an RPC that
    // loses the same chunk four times is down, not congested.
    expect(conn.writesByOffset.get(2000)).toBe(4);
    // The old code sent each chunk exactly once; 4 here is the resume proof.
    expect(conn.verifySigs).toHaveLength(0);
  });

  it('repairs a hole the signature statuses lied about (only the readback can see it)', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.drops.set(2000, { times: 1, lieConfirmed: true });

    await drive(
      submitAndVerifyStarkProof(makeGenericProof(), makeSigner(), conn.asConnection()),
    );

    // At the first completeness readback (call index 1; index 0 is the
    // stale-buffer check) the on-chain high-water mark had already reached
    // proof_size over the hole — the deployed gate was green while the buffer
    // was torn. Only the byte compare caught it.
    expect(conn.bytesWrittenAtReadback[1]).toBeGreaterThanOrEqual(PROOF_SIZE);
    expect(conn.writesByOffset.get(2000)).toBe(2);
    expect(conn.verifySigs).toHaveLength(1);
    expect(findBufferHoles(PROOF_BYTES, conn.account)).toEqual([]);
  });

  it('POSITIVE CONTROL: a hole that survives repair aborts BEFORE the 1.4M CU verify (RED on the pre-C3 code, which verified a torn buffer)', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.drops.set(2000, { times: Infinity, lieConfirmed: true });

    await expect(
      drive(submitAndVerifyStarkProof(makeGenericProof(), makeSigner(), conn.asConnection())),
    ).rejects.toThrow(/torn on-chain/);

    // The deployed completeness check would have passed on this exact state…
    expect(conn.bytesWritten).toBeGreaterThanOrEqual(PROOF_SIZE);
    // …and the old implementation, trusting statuses alone, would have spent
    // the verify fee. The gate refuses.
    expect(conn.verifySigs).toHaveLength(0);
    // Initial send + exactly one repair pass — the resend budget is bounded.
    expect(conn.writesByOffset.get(2000)).toBe(2);
  });
});

describe('submitStarkProof (circuit 0) — shares the resume path', () => {
  it('recovers a lost first chunk and completes', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.drops.set(0, { times: 1 });
    const proof: CompactStarkProof = {
      proofBytes: PROOF_BYTES,
      commitment: 42n,
      proofSize: PROOF_SIZE,
    };

    const result = await drive(submitStarkProof(proof, makeSigner(), conn.asConnection()));

    expect(result.verified).toBe(true);
    expect(conn.writesByOffset.get(0)).toBe(2);
    expect(conn.verifySigs).toHaveLength(1);
    expect(result.txSignature).toBe(conn.verifySigs[0]);
    expect(findBufferHoles(PROOF_BYTES, conn.account)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 🚨 THE PHASE-2 (DEEP-ALI) GATE — stark.ts, inside submitAndVerifyStarkProof
// ---------------------------------------------------------------------------
//
// WHAT PHASE 2 IS, because a guard that pins the wrong thing is worse than none.
//
// Phase 1 (`verify_stark_proof_v2`) checks Merkle openings, FRI, and the AIR
// transitions at the QUERY positions. Phase 2 (`verify_deep_ali_phase2`) is the
// DEEP-ALI identity at an out-of-domain point z: it binds the whole AIR —
// transitions AND the circuit's boundary assertions — to the opened OOD trace by
// Schwartz-Zippel. They are two transactions only because the sum exceeds
// Solana's 1.4M CU per-instruction cap.
//
// The two phases are NOT redundant, and for circuit 7 they are not even
// comparable:
//
//   * only ~24% of blowup-16 query positions land on trace-aligned rows, so
//     without the OOD check a prover may fabricate transitions on the other 76%
//     (`lib.rs`, the doc comment on `verify_deep_ali_phase2`);
//   * and C7 in particular has a VACUOUS per-query arm with no step 5, so phase
//     1 alone marks the buffer `verified = true` with C7's six boundary
//     assertions never checked against the trace at all. `lib.rs` says exactly
//     that on the `7 =>` dispatch arm.
//
// So on circuit 7 the phase-2 transaction is not "extra rigour". It is the
// entire binding between the published `[nullifier, root, rh0..rh3]` and the
// trace that supposedly produced them — and every C7 spend this app makes goes
// through this branch.
//
// ⛔ WHAT WENT UNCAUGHT. `proof.circuitId <= 7` was changed to `<= 6`. The
// client then uploads, runs phase 1, skips phase 2, and RETURNS SUCCESS. All 655
// pool tests stayed green, because the only assertion on `deepAliSigs` in this
// file rode on `makeGenericProof()`, whose circuit id is 1 — inside the mutated
// range, so it never moved.
//
// The tests below therefore (a) drive circuit 7 specifically, and (b) derive the
// admissible set from the DEPLOYED PROGRAM'S OWN GATE rather than restating it,
// so narrowing the client below the program and widening it past the program are
// both red.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '../../../../..');
const VERIFIER_LIB = 'programs/p01_stark_verifier/src/lib.rs';

/** The body of `verify_deep_ali_phase2`, as text. */
function phase2Source(): string {
  const src = readFileSync(join(REPO, VERIFIER_LIB), 'utf8');
  const start = src.indexOf('pub fn verify_deep_ali_phase2');
  expect(start, `${VERIFIER_LIB} no longer declares verify_deep_ali_phase2`).toBeGreaterThan(-1);
  // Up to the next top-level `pub fn`, so the dispatch `match` is included and
  // the next instruction's is not.
  const rest = src.slice(start + 1);
  const end = rest.indexOf('\n    pub fn ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The circuit ids the DEPLOYED program will run phase 2 for, read off its own
 * `require!(matches!(circuit_id, ...))`.
 *
 * ⛔ Deliberately parsed rather than written out here. A list retyped in this
 * file would agree with the client by construction, which is precisely the
 * failure being guarded: the client and the program have to be compared against
 * each other, not against one author's memory of both.
 */
function circuitsTheProgramRunsPhase2For(): number[] {
  const m = phase2Source().match(/matches!\(\s*circuit_id\s*,([^)]*)\)/);
  expect(
    m,
    'the `matches!(circuit_id, ...)` gate in verify_deep_ali_phase2 was restructured',
  ).not.toBeNull();
  const ids = m![1]
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => Number(t));
  for (const id of ids) {
    expect(Number.isInteger(id), `unparsed arm in the gate: ${m![1]}`).toBe(true);
  }
  return ids.sort((a, b) => a - b);
}

/** The circuit ids THIS CLIENT sends a phase-2 transaction for — observed, not read. */
async function circuitsTheClientRunsPhase2For(range: number[]): Promise<number[]> {
  const sent: number[] = [];
  for (const circuitId of range) {
    const conn = new FakeConn(PROOF_SIZE);
    await drive(
      submitAndVerifyStarkProof(makeGenericProof(circuitId), makeSigner(), conn.asConnection()),
    );
    if (conn.deepAliSigs.length > 0) sent.push(circuitId);
  }
  return sent;
}

describe('🚨 DEEP-ALI phase 2 is sent for circuit 7', () => {
  // The real shape: C7 publishes six inputs and no commitment.
  const C7_PUBLIC_INPUTS = [
    0x0123_4567_89ab_cdefn, // nullifier
    0x0fed_cba9_8765_4321n, // subtree root
    1n,
    2n,
    3n,
    4n, // rh0..rh3 — the binding digest limbs
  ];

  it('POSITIVE CONTROL: a C7 spend that skipped phase 2 would report SUCCESS anyway', async () => {
    // Nothing in the client's return value can distinguish a two-phase C7 verify
    // from a one-phase one — `{ proofBuffer, authority, txSignature }` is the
    // PHASE 1 signature either way. That is why the branch has to be observed on
    // the wire, and why a caller cannot be made to notice this on its own.
    const conn = new FakeConn(PROOF_SIZE);
    const result = await drive(
      submitAndVerifyStarkProof(
        makeGenericProof(CIRCUIT_SPEND, C7_PUBLIC_INPUTS),
        makeSigner(),
        conn.asConnection(),
      ),
    );
    expect(result.txSignature).toBe(conn.verifySigs[0]);
    // [L2-CLIENT 2026-09-12] For C7 the two phases share ONE transaction (the
    // measured sum fits, `SINGLE_TX_VERIFY_CU`), so the returned signature is
    // also the phase-2 signature — and still says nothing about whether the
    // phase-2 INSTRUCTION was in it.
    expect(conn.deepAliSigs[0]).toBe(result.txSignature);
  });

  it('sends the phase-2 transaction, which is where ALL of C7 binding lives', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    await drive(
      submitAndVerifyStarkProof(
        makeGenericProof(CIRCUIT_SPEND, C7_PUBLIC_INPUTS),
        makeSigner(),
        conn.asConnection(),
      ),
    );

    expect(
      conn.deepAliSigs,
      'the client uploaded a circuit-7 spend, ran phase 1, and returned SUCCESS without ever ' +
        'sending verify_deep_ali_phase2. C7 per-query checking is vacuous and it has no step 5, ' +
        'so its six boundary assertions were never checked against the trace — the buffer is ' +
        'marked verified on an unbound proof. Check the circuit-id range in ' +
        'submitAndVerifyStarkProof.',
    ).toHaveLength(1);
  });

  it('sends it AFTER phase 1, in the SAME transaction for C7 (measured 1,080,683 CU) and in its own for C1 (1,429,650)', async () => {
    // Ordering is a program requirement, not a preference: phase 2 opens with
    // `require!(buffer.verified)`. [L2-CLIENT 2026-09-12] Whether they share a
    // transaction is a MEASUREMENT: C7's two phases sum to 1,080,683 CU in
    // litesvm, under the 1,400,000 a transaction may request, so they ride
    // together; C1's sum to 1,429,650 and stay apart. `SINGLE_TX_VERIFY_CU`
    // is the table, and this test reads it rather than hard-coding either.
    expect(SINGLE_TX_VERIFY_CU[CIRCUIT_SPEND]).toBeLessThan(1_400_000);
    expect(SINGLE_TX_VERIFY_CU[CIRCUIT_POOL_COMMITMENT]).toBeUndefined();

    const c7 = new FakeConn(PROOF_SIZE);
    await drive(
      submitAndVerifyStarkProof(
        makeGenericProof(CIRCUIT_SPEND, C7_PUBLIC_INPUTS),
        makeSigner(),
        c7.asConnection(),
      ),
    );
    expect(c7.ixOrder.filter((k) => k === 'verify' || k === 'deepAli')).toEqual([
      'verify',
      'deepAli',
    ]);
    const c7VerifyTxs = c7.txs.filter((k) => k.includes('verify') || k.includes('deepAli'));
    expect(c7VerifyTxs).toEqual([['verify', 'deepAli']]);
    expect(c7.deepAliSigs[0]).toBe(c7.verifySigs[0]);

    const c1 = new FakeConn(PROOF_SIZE);
    await drive(
      submitAndVerifyStarkProof(
        makeGenericProof(CIRCUIT_POOL_COMMITMENT, [1n, 2n, 3n]),
        makeSigner(),
        c1.asConnection(),
      ),
    );
    const c1VerifyTxs = c1.txs.filter((k) => k.includes('verify') || k.includes('deepAli'));
    expect(c1VerifyTxs).toEqual([['verify'], ['deepAli']]);
    expect(c1.deepAliSigs[0]).not.toBe(c1.verifySigs[0]);
  });

  it('carries the SAME public inputs to both phases, or the program refuses phase 2', async () => {
    // Phase 1 stores `hash_public_inputs(inputs)`; phase 2 re-hashes what it is
    // given and requires equality. Sending a phase-2 transaction with different
    // inputs is indistinguishable, from this side, from sending none: the
    // instruction fails and the buffer keeps `deep_ali_verified = false`.
    const conn = new FakeConn(PROOF_SIZE);
    await drive(
      submitAndVerifyStarkProof(
        makeGenericProof(CIRCUIT_SPEND, C7_PUBLIC_INPUTS),
        makeSigner(),
        conn.asConnection(),
      ),
    );
    expect(conn.verifyInputs[0]).toEqual(C7_PUBLIC_INPUTS);
    expect(conn.deepAliInputs[0]).toEqual(C7_PUBLIC_INPUTS);
  });
});

describe('[L2-CLIENT 2026-09-12] pre-sized buffers, one transaction instead of nine', () => {
  // 30,083 bytes of account: the PDA path needed init + two resizes here, the
  // C7 proof (79,405 B) needed init + seven.
  const BIG = 30_000;
  const BIG_BYTES = Uint8Array.from({ length: BIG }, (_, i) => (i * 7) % 253);
  const bigProof = (circuitId = CIRCUIT_MERKLE_UPDATE): GenericStarkProof => ({
    proofBytes: BIG_BYTES,
    circuitId,
    publicInputs: [5n, 6n],
    proofSize: BIG,
  });

  it('allocates the buffer with createAccount + init_proof_buffer_v3 in ONE transaction and never resizes', async () => {
    const conn = new FakeConn(BIG);
    await drive(submitAndVerifyStarkProof(bigProof(), makeSigner(), conn.asConnection()));
    expect(conn.txs[0]).toEqual(['createAccount', 'initV3']);
    expect(conn.ixOrder).not.toContain('init');
    expect(conn.txs.flat()).not.toContain('resize');
    // The whole proof landed in the buffer the one transaction allocated.
    expect(findBufferHoles(BIG_BYTES, conn.account)).toEqual([]);
  });

  it('the buffer address is a pure function of (authority, circuit id, attempt), like a PDA', () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const k = (auth: PublicKey, cid: number, attempt = 0) =>
      deriveProofBufferKeypair(auth, cid, attempt).publicKey.toBase58();
    expect(k(a, 7)).toBe(k(a, 7));
    expect(k(a, 7)).not.toBe(k(a, 6));
    expect(k(a, 7)).not.toBe(k(b, 7));
    expect(k(a, 7, 1)).not.toBe(k(a, 7, 0));
  });

  it('uses the derived address, so the buffer the pool instruction reads is the one that was allocated', async () => {
    const conn = new FakeConn(BIG);
    const signer = makeSigner();
    const { proofBuffer } = await drive(
      submitAndVerifyStarkProof(bigProof(), signer, conn.asConnection()),
    );
    expect(proofBuffer.toBase58()).toBe(
      deriveProofBufferKeypair(signer.publicKey, CIRCUIT_MERKLE_UPDATE).publicKey.toBase58(),
    );
  });

  it('rearms its OWN earlier buffer with reset_proof_buffer instead of allocating a second one', async () => {
    const conn = new FakeConn(BIG);
    const signer = makeSigner();
    // A buffer from a previous run: exists, owned by the verifier, our authority,
    // big enough, and already marked verified from that run.
    conn.exists = true;
    conn.account.set(signer.publicKey.toBytes(), 8);
    conn.account[40] = CIRCUIT_MERKLE_UPDATE;
    conn.account[49] = 1;
    conn.account[82] = 1;
    await drive(submitAndVerifyStarkProof(bigProof(), signer, conn.asConnection()));
    expect(conn.txs[0]).toEqual(['reset']);
    expect(conn.txs.flat()).not.toContain('createAccount');
    expect(conn.txs.flat()).not.toContain('initV3');
    expect(findBufferHoles(BIG_BYTES, conn.account)).toEqual([]);
  });

  it("steps to the next derived address when the first is occupied by an account that is not ours", async () => {
    const conn = new FakeConn(BIG);
    const signer = makeSigner();
    // Same shape, but somebody else's authority.
    conn.exists = true;
    conn.account.set(Keypair.generate().publicKey.toBytes(), 8);
    // FakeConn answers every address with the same account, so make the
    // occupant vanish once the client has looked at attempt 0.
    const seen: PublicKey[] = [];
    const orig = conn.getAccountInfo.bind(conn);
    conn.getAccountInfo = async (pk: PublicKey) => {
      seen.push(pk);
      // Second look = attempt 1: nobody there. Later looks (the readback after
      // the upload) see whatever the client wrote.
      if (seen.length === 2) conn.exists = false;
      return orig(pk);
    };
    const { proofBuffer } = await drive(
      submitAndVerifyStarkProof(bigProof(), signer, conn.asConnection()),
    );
    expect(seen[0].toBase58()).toBe(
      deriveProofBufferKeypair(signer.publicKey, CIRCUIT_MERKLE_UPDATE, 0).publicKey.toBase58(),
    );
    expect(proofBuffer.toBase58()).toBe(
      deriveProofBufferKeypair(signer.publicKey, CIRCUIT_MERKLE_UPDATE, 1).publicKey.toBase58(),
    );
    expect(conn.txs[0]).toEqual(['createAccount', 'initV3']);
  });

  it('sends chunks CHUNK_SEND_CONCURRENCY at a time, and every chunk still lands exactly once', async () => {
    const conn = new FakeConn(BIG);
    await drive(submitAndVerifyStarkProof(bigProof(), makeSigner(), conn.asConnection()));
    expect(CHUNK_SEND_CONCURRENCY).toBeGreaterThan(1);
    expect(conn.peakInFlight).toBe(CHUNK_SEND_CONCURRENCY);
    for (const { offset } of splitProofIntoChunks(BIG_BYTES)) {
      expect(conn.writesByOffset.get(offset)).toBe(1);
    }
  });

  it('merges phase 1 and phase 2 for exactly the circuits whose measured sum fits', () => {
    for (const [cid, cu] of Object.entries(SINGLE_TX_VERIFY_CU)) {
      expect(cu, `C${cid}`).toBeLessThan(1_400_000);
    }
    // C2 is 97% of the cap and C1 / C5 exceed it: none of the three may be merged.
    expect(SINGLE_TX_VERIFY_CU[1]).toBeUndefined();
    expect(SINGLE_TX_VERIFY_CU[2]).toBeUndefined();
    expect(SINGLE_TX_VERIFY_CU[5]).toBeUndefined();
  });
});

describe('[TX-V1 2026-09-13] 4,096-byte transaction-v1 proof chunks', () => {
  const BIG = 30_000;
  const BIG_BYTES = Uint8Array.from({ length: BIG }, (_, i) => (i * 11) % 251);
  const bigProof = (): GenericStarkProof => ({
    proofBytes: BIG_BYTES,
    circuitId: CIRCUIT_MERKLE_UPDATE,
    publicInputs: [5n, 6n],
    proofSize: BIG,
  });

  it('sends 3,840-byte chunks in v1 transactions when the gate is active and the signer signs bytes', async () => {
    const conn = new FakeConn(BIG);
    conn.v1Active = true;
    await drive(submitAndVerifyStarkProof(bigProof(), makeSigner(), conn.asConnection()));
    const writes = conn.txs.filter((k) => k.includes('write'));
    expect(writes).toHaveLength(Math.ceil(BIG / V1_CHUNK_SIZE)); // 8, not 30
    expect(Math.max(...conn.writeLens)).toBe(V1_CHUNK_SIZE);
    expect(conn.maxRawBytes).toBeLessThanOrEqual(V1_MAX_WIRE_BYTES);
    expect(conn.maxRawBytes).toBeGreaterThan(1_232);
    expect(findBufferHoles(BIG_BYTES, conn.account)).toEqual([]);
  });

  it('falls back to 1,000-byte legacy chunks when the feature gate is not activated', async () => {
    const conn = new FakeConn(BIG);
    conn.v1Active = false;
    await drive(submitAndVerifyStarkProof(bigProof(), makeSigner(), conn.asConnection()));
    expect(conn.txs.filter((k) => k.includes('write'))).toHaveLength(Math.ceil(BIG / 1_000));
    expect(conn.maxRawBytes).toBeLessThanOrEqual(1_232);
    expect(findBufferHoles(BIG_BYTES, conn.account)).toEqual([]);
  });

  it('falls back to legacy chunks for a signer that cannot sign raw bytes (a browser wallet)', async () => {
    const conn = new FakeConn(BIG);
    conn.v1Active = true;
    await drive(submitAndVerifyStarkProof(bigProof(), makeSigner({ signBytes: false }), conn.asConnection()));
    expect(conn.txs.filter((k) => k.includes('write'))).toHaveLength(Math.ceil(BIG / 1_000));
    expect(findBufferHoles(BIG_BYTES, conn.account)).toEqual([]);
  });

  it('repairs a torn v1 chunk the signature statuses lied about (readback maps 1,000-byte holes to v1 chunks)', async () => {
    const conn = new FakeConn(BIG);
    conn.v1Active = true;
    // The second v1 chunk (offset 3,840) is "confirmed" once but never written.
    conn.drops.set(V1_CHUNK_SIZE, { times: 1, lieConfirmed: true });
    await drive(submitAndVerifyStarkProof(bigProof(), makeSigner(), conn.asConnection()));
    expect(conn.writesByOffset.get(V1_CHUNK_SIZE)).toBe(2);
    expect(findBufferHoles(BIG_BYTES, conn.account)).toEqual([]);
    expect(conn.verifySigs).toHaveLength(1);
  });
});

describe('[CLOSE-SWEEP 2026-09-13] the buffer close carries the rent sweep', () => {
  it('closes the buffer and sweeps balance + rent - fee to `sweepTo` in ONE transaction', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.exists = true;
    const signer = makeSigner();
    const sweepTo = Keypair.generate().publicKey;
    await drive(closeStarkProofBuffer(Keypair.generate().publicKey, signer, conn.asConnection(), { sweepTo }));
    expect(conn.txs).toEqual([['close', 'transfer']]);
    expect(conn.transferAmounts).toEqual([conn.balance + conn.bufferLamports - 5_000]);
  });

  it('without `sweepTo` it is the plain close, as before', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.exists = true;
    await drive(closeStarkProofBuffer(Keypair.generate().publicKey, makeSigner(), conn.asConnection()));
    expect(conn.txs).toEqual([['close']]);
  });

  it('never sweeps a signer to itself', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.exists = true;
    const signer = makeSigner();
    await drive(closeStarkProofBuffer(Keypair.generate().publicKey, signer, conn.asConnection(), { sweepTo: signer.publicKey }));
    expect(conn.txs).toEqual([['close']]);
  });
});

describe('⛔ the client phase-2 range IS the deployed program range', () => {
  it('is actually reading the program, not an empty parse', () => {
    const body = phase2Source();
    expect(body.length).toBeGreaterThan(500);
    expect(body).toMatch(/require!\(\s*[\s\S]{0,40}matches!\(\s*circuit_id/);
    // Anti-vacuity on the parse itself.
    const ids = circuitsTheProgramRunsPhase2For();
    expect(ids.length).toBeGreaterThan(0);
    // C0 runs DEEP-ALI inside phase 1 and must never appear here.
    expect(ids).not.toContain(0);
  });

  it('the program admits circuit 7 AND has an arm to run for it', () => {
    expect(circuitsTheProgramRunsPhase2For()).toContain(CIRCUIT_SPEND);
    // A gate that admits an id with no dispatch arm is the shape `lib.rs` calls
    // out on its `_ =>` catch-all. If this ever fails, the client sending phase 2
    // is not the bug — the program is.
    expect(phase2Source()).toMatch(/7\s*=>\s*verify::verify_deep_ali_circuit_7/);
  });

  it('sends phase 2 for exactly those circuits — not fewer, not more', async () => {
    const accepted = circuitsTheProgramRunsPhase2For();
    // 0 through 8: one below the program's lowest arm and one above its highest,
    // so a range that is narrowed OR widened both show up as a set difference.
    const observed = await circuitsTheClientRunsPhase2For([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      observed,
      `the client sends DEEP-ALI phase 2 for circuits [${observed}] while ${VERIFIER_LIB} runs it ` +
        `for [${accepted}]. A circuit the client skips is verified on phase 1 alone; a circuit it ` +
        'adds fails UnsupportedCircuit after the whole upload is paid for.',
    ).toEqual(accepted);
  }, 60_000);
});
