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
import { Keypair, PublicKey, Transaction, type Connection } from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  submitStarkProof,
  submitAndVerifyStarkProof,
  splitProofIntoChunks,
  findBufferHoles,
  PROOF_DATA_OFFSET,
  MAX_CHUNK_SIZE,
  STARK_VERIFIER_PROGRAM_ID,
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
  getAccountInfoCalls = 0;
  /** bytesWritten snapshot at each getAccountInfo call, in call order. */
  bytesWrittenAtReadback: number[] = [];
  private n = 0;

  constructor(proofSize: number) {
    this.account = new Uint8Array(PROOF_DATA_OFFSET + proofSize);
  }

  async getAccountInfo(_pk: PublicKey) {
    this.getAccountInfoCalls++;
    this.bytesWrittenAtReadback.push(this.bytesWritten);
    if (!this.exists) return null;
    return { data: Buffer.from(this.account) };
  }

  async getLatestBlockhash(_commitment?: unknown) {
    return { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: 1_000 };
  }

  async sendRawTransaction(raw: Buffer | Uint8Array, _opts?: unknown) {
    const sig = `sig_${++this.n}`;
    const tx = Transaction.from(raw);
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(STARK_VERIFIER_PROGRAM_ID)) continue;
      const d = ix.data;
      const disc = d.subarray(0, 8);
      if (disc.equals(DISC.init)) {
        this.exists = true;
        this.confirmedSigs.add(sig);
      } else if (disc.equals(DISC.write)) {
        const offset = d.readUInt32LE(8);
        const len = d.readUInt32LE(12);
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
        this.verifySigs.push(sig);
        this.confirmedSigs.add(sig);
      } else if (disc.equals(DISC.deepAli)) {
        this.deepAliSigs.push(sig);
        this.confirmedSigs.add(sig);
      } else {
        // close / resize — always land.
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

function makeSigner(): WalletSigner {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.sign(kp);
      return tx;
    },
  };
}

function makeGenericProof(): GenericStarkProof {
  return {
    proofBytes: PROOF_BYTES,
    circuitId: 1,
    publicInputs: [1n, 2n],
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
