/**
 * [ONE-TX 2026-09-06] concurrency, composition, fallbacks — stark.ts
 *
 * What the 2026-09-06 latency plan changed (docs/PERF-AND-CAPACITY-PLAN):
 *   1. every chunk send of a round goes out at once; ONE status barrier;
 *   2. no `confirmTransaction` anywhere — status polling only;
 *   3. `submitAndConsumeStarkProof`: verify phase 1 + phase 2 + the consuming
 *      instruction + the buffer close in ONE transaction (C7), or phase 1
 *      alone then [phase 2 + consume + close] (C6, whose phase 1 is 1,316,491
 *      CU on its own);
 *   4. two automatic fallbacks to the split shape: packet too large, or the
 *      runtime refusing the composed transaction for compute.
 *
 * Same fake-RPC method as stark.test.ts: transactions are really signed and
 * re-parsed, so the instruction order and compute budgets asserted here are
 * the ones the wire would carry. Environment: node, real @solana/web3.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import {
  submitAndVerifyStarkProof,
  submitAndConsumeStarkProof,
  splitProofIntoChunks,
  findBufferHoles,
  PROOF_DATA_OFFSET,
  STARK_VERIFIER_PROGRAM_ID,
  CIRCUIT_SPEND,
  CIRCUIT_MERKLE_UPDATE,
  type WalletSigner,
  type GenericStarkProof,
} from './stark';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// 5 chunks: offsets 0/1000/2000/3000/4000, sizes 1000×4 + 500.
const PROOF_SIZE = 4500;
const PROOF_BYTES = Uint8Array.from({ length: PROOF_SIZE }, (_, i) => (i % 251) + 1);
const FIXED_BLOCKHASH = new PublicKey(Buffer.alloc(32, 7)).toBase58();

// Anchor discriminators, frozen literals of the deployed verifier.
const DISC = {
  // [L2 2026-09-06] the one-transaction allocation; `init` stays for the
  // legacy PDA path.
  initV3: Buffer.from([239, 25, 230, 31, 173, 116, 84, 51]),
  init: Buffer.from([49, 27, 28, 88, 19, 99, 133, 194]),
  resize: Buffer.from([187, 39, 46, 173, 247, 90, 178, 205]),
  write: Buffer.from([183, 3, 171, 138, 153, 138, 133, 147]),
  verify: Buffer.from([208, 216, 183, 38, 47, 69, 156, 138]),
  verifyV2: Buffer.from([149, 18, 96, 15, 144, 68, 8, 233]),
  deepAli: Buffer.from([217, 239, 203, 65, 109, 182, 70, 115]),
  close: Buffer.from([130, 150, 6, 35, 193, 34, 243, 87]),
};

/** Some other program's instruction: what the pool's spend / shield looks like from here. */
const CONSUME_PROGRAM = Keypair.generate().publicKey;

function consumeIx(dataLen = 40): TransactionInstruction {
  return new TransactionInstruction({
    programId: CONSUME_PROGRAM,
    keys: [],
    data: Buffer.alloc(dataLen, 9),
  });
}

type Label =
  | 'init' | 'resize' | 'write' | 'verify' | 'deepAli' | 'close'
  | 'cu-limit' | 'cu-price' | 'consume' | 'other';

interface DropRule {
  times: number;
}

/**
 * Fake RPC implementing the Connection surface stark.ts touches. Chunk writes
 * are re-parsed from the signed bytes and applied to an in-memory account.
 * Records the instruction list of every transaction and the compute limit
 * each asked for; holds chunk sends behind a gate that opens only once ALL of
 * a round has been issued (a sequential sender deadlocks, a concurrent one
 * passes); and injects two kinds of failure on the consuming transaction.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
class FakeConn {
  account: Uint8Array;
  exists = false;
  confirmedSigs = new Set<string>();
  writesByOffset = new Map<number, number>();
  drops = new Map<number, DropRule>();
  verifyInputs: bigint[][] = [];
  deepAliInputs: bigint[][] = [];
  txs: Label[][] = [];
  cuLimits: (number | null)[] = [];
  rawSizes: number[] = [];
  confirmTransactionCalls = 0;
  /** Hold chunk sends until this many have been issued. */
  gateWrites = 0;
  /** Thrown ONCE for a transaction carrying both a verify phase and a consume ix. */
  rejectCombinedWith: Error | null = null;
  /** Thrown for EVERY transaction carrying a consume ix. */
  rejectConsumeWith: Error | null = null;
  private writeCalls = 0;
  private gateResolve: (() => void) | null = null;
  private gate: Promise<void> | null = null;
  private n = 0;

  constructor(proofSize: number) {
    this.account = new Uint8Array(PROOF_DATA_OFFSET + proofSize);
  }

  async getAccountInfo(_pk: PublicKey) {
    if (!this.exists) return null;
    return { data: Buffer.from(this.account), owner: STARK_VERIFIER_PROGRAM_ID };
  }

  async getMinimumBalanceForRentExemption(_len: number) {
    return 1_000_000;
  }

  async getLatestBlockhash(_commitment?: unknown) {
    return { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: 1_000 };
  }

  async confirmTransaction(_s: unknown, _c?: unknown) {
    this.confirmTransactionCalls++;
    return { value: { err: null } };
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

  async getSignatureStatus(_sig: string, _opts?: unknown) {
    return { context: { slot: 1 }, value: { err: null, confirmationStatus: 'confirmed' } };
  }

  async sendRawTransaction(raw: Buffer | Uint8Array, _opts?: unknown) {
    this.rawSizes.push(raw.length);
    if (raw.length > 1232) throw new Error(`packet too large: ${raw.length}`);
    const tx = Transaction.from(raw);
    const labels: Label[] = [];
    let cuLimit: number | null = null;
    for (const ix of tx.instructions) {
      if (ix.programId.equals(CONSUME_PROGRAM)) labels.push('consume');
      else if (ix.programId.equals(STARK_VERIFIER_PROGRAM_ID)) {
        const disc = ix.data.subarray(0, 8);
        if (disc.equals(DISC.init)) labels.push('init');
        else if (disc.equals(DISC.initV3)) labels.push('init');
        else if (disc.equals(DISC.resize)) labels.push('resize');
        else if (disc.equals(DISC.write)) labels.push('write');
        else if (disc.equals(DISC.verifyV2) || disc.equals(DISC.verify)) labels.push('verify');
        else if (disc.equals(DISC.deepAli)) labels.push('deepAli');
        else if (disc.equals(DISC.close)) labels.push('close');
        else labels.push('other');
      } else if (ix.data[0] === 2 && ix.data.length === 5) {
        labels.push('cu-limit');
        cuLimit = ix.data.readUInt32LE(1);
      } else if (ix.data[0] === 3 && ix.data.length === 9) labels.push('cu-price');
      else labels.push('other');
    }
    this.txs.push(labels);
    this.cuLimits.push(cuLimit);

    const hasVerify = labels.includes('verify') || labels.includes('deepAli');
    if (labels.includes('consume')) {
      if (this.rejectConsumeWith) throw this.rejectConsumeWith;
      if (hasVerify && this.rejectCombinedWith) {
        const e = this.rejectCombinedWith;
        this.rejectCombinedWith = null;
        throw e;
      }
    }

    if (labels.includes('write') && this.gateWrites > 0) {
      this.writeCalls++;
      if (!this.gate) {
        this.gate = new Promise<void>((r) => {
          this.gateResolve = r;
        });
      }
      if (this.writeCalls >= this.gateWrites) this.gateResolve?.();
      await this.gate;
    }

    const sig = `sig_${++this.n}`;
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(STARK_VERIFIER_PROGRAM_ID)) continue;
      const d = ix.data;
      const disc = d.subarray(0, 8);
      if (disc.equals(DISC.init) || disc.equals(DISC.initV3)) {
        this.exists = true;
      } else if (disc.equals(DISC.write)) {
        const offset = d.readUInt32LE(8);
        const len = d.readUInt32LE(12);
        this.writesByOffset.set(offset, (this.writesByOffset.get(offset) ?? 0) + 1);
        const rule = this.drops.get(offset);
        if (rule && rule.times > 0) {
          rule.times--;
          // Lost in flight — never confirms, bytes never written.
          return sig;
        }
        this.account.set(d.subarray(16, 16 + len), PROOF_DATA_OFFSET + offset);
      } else if (disc.equals(DISC.verifyV2)) {
        this.verifyInputs.push(decodePublicInputs(d));
      } else if (disc.equals(DISC.deepAli)) {
        this.deepAliInputs.push(decodePublicInputs(d));
      } else if (disc.equals(DISC.close)) {
        this.exists = false;
      }
    }
    this.confirmedSigs.add(sig);
    return sig;
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}
/* eslint-enable @typescript-eslint/no-unused-vars */

function decodePublicInputs(d: Buffer): bigint[] {
  const n = d.readUInt32LE(8);
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) out.push(d.readBigUInt64LE(12 + i * 8));
  return out;
}

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

function proofFor(circuitId: number, publicInputs: bigint[]): GenericStarkProof {
  return { proofBytes: PROOF_BYTES, circuitId, publicInputs, proofSize: PROOF_SIZE };
}

const C7_INPUTS = [1n, 2n, 3n, 4n, 5n, 6n];
const C6_INPUTS = [0n, 1n, 2n, 3n, 11n];

/** Drive a promise to settlement under fake timers (polls and windows are timers). */
async function drive<T>(p: Promise<T>, maxSimMs = 600_000): Promise<T> {
  const state = { done: false, failed: false, value: undefined as T | undefined, error: undefined as unknown };
  p.then(
    (v) => { state.done = true; state.value = v; },
    (e) => { state.done = true; state.failed = true; state.error = e; },
  );
  for (let t = 0; t < maxSimMs && !state.done; t += 500) {
    await vi.advanceTimersByTimeAsync(500);
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
// 1 + 2: concurrency and polling
// ---------------------------------------------------------------------------

describe('[ONE-TX] chunk sends are concurrent and confirmations are polled', () => {
  it('fires every chunk send before any of them returns (a sequential sender never settles here)', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.gateWrites = splitProofIntoChunks(PROOF_BYTES).length;
    await drive(submitAndVerifyStarkProof(proofFor(1, [1n, 2n]), makeSigner(), conn.asConnection()));
    for (const { offset } of splitProofIntoChunks(PROOF_BYTES)) {
      expect(conn.writesByOffset.get(offset)).toBe(1);
    }
    expect(findBufferHoles(PROOF_BYTES, conn.account)).toEqual([]);
  });

  it('never calls confirmTransaction: every wait is a status poll', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    await drive(submitAndVerifyStarkProof(proofFor(1, [1n, 2n]), makeSigner(), conn.asConnection()));
    expect(conn.confirmTransactionCalls).toBe(0);
    expect(conn.txs.length).toBeGreaterThan(5);
  });

  it('still resends only the chunks a concurrent round lost', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.drops.set(2000, { times: 1 });
    await drive(submitAndVerifyStarkProof(proofFor(1, [1n, 2n]), makeSigner(), conn.asConnection()));
    expect(conn.writesByOffset.get(2000)).toBe(2);
    expect(conn.writesByOffset.get(0)).toBe(1);
    expect(findBufferHoles(PROOF_BYTES, conn.account)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3: composition
// ---------------------------------------------------------------------------

describe('[ONE-TX] submitAndConsumeStarkProof composes verify + consume + close', () => {
  it('circuit 7: ONE transaction — [limit, price, phase 1, phase 2, consume, close] at the 1.4M cap', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    const progress: string[] = [];
    const result = await drive(
      submitAndConsumeStarkProof(
        proofFor(CIRCUIT_SPEND, C7_INPUTS),
        makeSigner(),
        conn.asConnection(),
        { instructions: [consumeIx()], computeUnits: 500_000, label: 'withdrawing' },
        (s) => progress.push(s),
      ),
    );
    const composed = conn.txs.filter((t) => t.includes('consume'));
    expect(composed).toHaveLength(1);
    expect(composed[0]).toEqual(['cu-limit', 'cu-price', 'verify', 'deepAli', 'consume', 'close']);
    expect(conn.cuLimits[conn.txs.indexOf(composed[0]!)]).toBe(1_400_000);
    // No verify phase went out on its own.
    expect(conn.txs.filter((t) => t.includes('verify') && !t.includes('consume'))).toHaveLength(0);
    expect(conn.txs.filter((t) => t.includes('deepAli') && !t.includes('consume'))).toHaveLength(0);
    // No separate close either: the rent came back in the same transaction.
    expect(conn.txs.filter((t) => t.length === 1 && t[0] === 'close')).toHaveLength(0);
    expect(conn.exists).toBe(false);
    expect(result.transactions).toBe(1);
    expect(progress.some((s) => /verifying the proof and withdrawing in one transaction/i.test(s))).toBe(true);
  });

  it('carries the same public inputs to both phases inside the composed transaction', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    await drive(
      submitAndConsumeStarkProof(
        proofFor(CIRCUIT_SPEND, C7_INPUTS),
        makeSigner(),
        conn.asConnection(),
        { instructions: [consumeIx()], computeUnits: 500_000, label: 'withdrawing' },
      ),
    );
    expect(conn.verifyInputs[0]).toEqual(C7_INPUTS);
    expect(conn.deepAliInputs[0]).toEqual(C7_INPUTS);
  });

  it('circuit 6: phase 1 alone (1,316,491 CU measured), then [phase 2, consume, close] at the consumer budget', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    const result = await drive(
      submitAndConsumeStarkProof(
        proofFor(CIRCUIT_MERKLE_UPDATE, C6_INPUTS),
        makeSigner(),
        conn.asConnection(),
        { instructions: [consumeIx()], computeUnits: 1_000_000, label: 'shielding the deposit' },
      ),
    );
    const phase1 = conn.txs.findIndex((t) => t.includes('verify'));
    const second = conn.txs.findIndex((t) => t.includes('consume'));
    expect(conn.txs[phase1]).toEqual(['cu-limit', 'cu-price', 'verify']);
    expect(conn.cuLimits[phase1]).toBe(1_400_000);
    expect(conn.txs[second]).toEqual(['cu-limit', 'cu-price', 'deepAli', 'consume', 'close']);
    expect(conn.cuLimits[second]).toBe(1_000_000);
    expect(second).toBeGreaterThan(phase1);
    expect(result.transactions).toBe(2);
  });

  it('fires beforeSend exactly once, before the consuming transaction goes out', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    let firedAtTx = -1;
    let fired = 0;
    await drive(
      submitAndConsumeStarkProof(
        proofFor(CIRCUIT_SPEND, C7_INPUTS),
        makeSigner(),
        conn.asConnection(),
        {
          instructions: [consumeIx()],
          computeUnits: 500_000,
          label: 'opening the subscription',
          beforeSend: () => {
            fired++;
            firedAtTx = conn.txs.length;
          },
        },
      ),
    );
    expect(fired).toBe(1);
    expect(conn.txs.findIndex((t) => t.includes('consume'))).toBe(firedAtTx);
  });

  it('routes the consuming transaction through the caller-supplied send when given one', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    const seen: Label[][] = [];
    const signer = makeSigner();
    await drive(
      submitAndConsumeStarkProof(
        proofFor(CIRCUIT_SPEND, C7_INPUTS),
        signer,
        conn.asConnection(),
        {
          instructions: [consumeIx()],
          computeUnits: 500_000,
          label: 'withdrawing',
          send: async (tx) => {
            tx.recentBlockhash = FIXED_BLOCKHASH;
            tx.feePayer = signer.publicKey;
            const signed = await signer.signTransaction(tx);
            const sig = await conn.sendRawTransaction(signed.serialize());
            seen.push(conn.txs[conn.txs.length - 1]!);
            return sig;
          },
        },
      ),
    );
    expect(seen).toEqual([['cu-limit', 'cu-price', 'verify', 'deepAli', 'consume', 'close']]);
  });
});

// ---------------------------------------------------------------------------
// 4: the fallbacks
// ---------------------------------------------------------------------------

describe('[ONE-TX] the two fallbacks to the split shape', () => {
  it('falls back to [phase 1] [phase 2] [consume + close] when the runtime refuses the composed transaction for compute', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.rejectCombinedWith = new Error(
      'Transaction simulation failed: Error processing Instruction 4: Program failed to complete: exceeded CUs meter at BPF instruction',
    );
    let fired = 0;
    const progress: string[] = [];
    const result = await drive(
      submitAndConsumeStarkProof(
        proofFor(CIRCUIT_SPEND, C7_INPUTS),
        makeSigner(),
        conn.asConnection(),
        {
          instructions: [consumeIx()],
          computeUnits: 500_000,
          label: 'withdrawing',
          beforeSend: () => fired++,
        },
        (s) => progress.push(s),
      ),
    );
    const afterRefusal = conn.txs.slice(conn.txs.findIndex((t) => t.includes('consume')) + 1);
    expect(afterRefusal).toEqual([
      ['cu-limit', 'cu-price', 'verify'],
      ['cu-limit', 'cu-price', 'deepAli'],
      ['cu-limit', 'cu-price', 'consume', 'close'],
    ]);
    expect(result.transactions).toBe(3);
    // The hook is a one-time write for the caller; a retry must not repeat it.
    expect(fired).toBe(1);
    expect(progress.some((s) => /over the compute cap/i.test(s))).toBe(true);
  });

  it('splits BEFORE sending when the composed transaction cannot fit a 1,232-byte packet', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    const progress: string[] = [];
    const result = await drive(
      submitAndConsumeStarkProof(
        proofFor(CIRCUIT_SPEND, C7_INPUTS),
        makeSigner(),
        conn.asConnection(),
        // 880 data bytes: on its own the consume + close transaction is ~1,180
        // bytes and fits; with the two verify phases in front it is ~1,310 and
        // does not. The split has to be decided by arithmetic, before a send.
        { instructions: [consumeIx(880)], computeUnits: 500_000, label: 'withdrawing' },
        (s) => progress.push(s),
      ),
    );
    // Nothing over the cap was ever handed to the transport (the fake throws on it).
    expect(Math.max(...conn.rawSizes)).toBeLessThanOrEqual(1232);
    expect(conn.txs.filter((t) => t.includes('consume'))).toEqual([['cu-limit', 'cu-price', 'consume', 'close']]);
    expect(result.transactions).toBe(3);
    expect(progress.some((s) => /does not fit a packet/i.test(s))).toBe(true);
  });

  it('any other failure of the consuming transaction closes the buffer and rethrows as is', async () => {
    const conn = new FakeConn(PROOF_SIZE);
    conn.rejectConsumeWith = new Error('Transaction simulation failed: custom program error: 0x1773');
    await expect(
      drive(
        submitAndConsumeStarkProof(
          proofFor(CIRCUIT_SPEND, C7_INPUTS),
          makeSigner(),
          conn.asConnection(),
          { instructions: [consumeIx()], computeUnits: 500_000, label: 'withdrawing' },
        ),
      ),
    ).rejects.toThrow(/0x1773/);
    // The last thing sent is a bare close: the signer's rent, reclaimed.
    expect(conn.txs[conn.txs.length - 1]).toEqual(['close']);
    expect(conn.exists).toBe(false);
    // And it did not try the split shape on a non-compute error.
    expect(conn.txs.filter((t) => t.includes('verify') && !t.includes('consume'))).toHaveLength(0);
  });
});
