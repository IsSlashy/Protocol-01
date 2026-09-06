/**
 * The upload pipeline after 2026-09-06 (L1 + L3 of
 * docs/PERF-AND-CAPACITY-PLAN-2026-09-06.md), pinned against a fake chain.
 *
 * What is asserted here, and why each line exists:
 *
 *   - pacing: a paid endpoint (Helius) is never throttled; the public cluster
 *     endpoints keep a small batch pacing. The July doc measured 30 s of pure
 *     wave sleep per proof; this is the line that keeps it from coming back.
 *   - one barrier: every chunk is SENT before any status is polled.
 *   - resend: a chunk the fake drops on round 0 is resent under a fresh
 *     blockhash and nothing else is.
 *   - readback: a chunk that "confirmed" but never reached the account is
 *     found by the byte-for-byte readback and repaired; a hole that survives
 *     the repair aborts BEFORE any verify CU is spent.
 *   - the composed transaction: [cu limit, cu price, phase 1?, phase 2,
 *     ...consume, close], phase 1 only under the 'single' plan, close last,
 *     the 1.4M cap enforced.
 *
 * `@solana/web3.js` is the repo's mock here (vitest alias), whose
 * `Transaction.serialize` encodes the instruction list as JSON; the fake
 * connection replays chunk writes off that. Signing is a stub. Nothing here
 * is a statement about the chain accepting anything.
 */
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, type Connection } from '@solana/web3.js';
import {
  C6_PHASE1_CU,
  C7_PHASE1_CU,
  C7_PHASE2_CU,
  FAST_PACING,
  MAX_TX_CU,
  PUBLIC_RPC_PACING,
  composeConsumeTransaction,
  confirmSignatureFast,
  confirmSignaturesSoft,
  findBufferHoles,
  pacingForEndpoint,
  planForCircuit,
  splitProofIntoChunks,
  uploadProofChunks,
  audible,
} from './index';
import { isPrivateRpcEndpoint } from '../solana/connection';

const PROOF_DATA_OFFSET = 83;
const MAX_CHUNK_SIZE = 1000;

// Discriminators, copied from the module (which does not export them).
const DISC_WRITE_CHUNK = [183, 3, 171, 138, 153, 138, 133, 147];
const DISC_VERIFY_V2 = [149, 18, 96, 15, 144, 68, 8, 233];
const DISC_VERIFY_LEGACY = [208, 216, 183, 38, 47, 69, 156, 138];
const DISC_PHASE2 = [217, 239, 203, 65, 109, 182, 70, 115];
const DISC_CLOSE = [130, 150, 6, 35, 193, 34, 243, 87];

function proofOf(len: number, seed = 7): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

interface FakeChainOptions {
  rpcEndpoint?: string;
  /** Chunk indices whose FIRST send is silently dropped (never confirms). */
  dropOnce?: number[];
  /** Chunk indices that confirm but whose bytes never reach the account
   * (until a repair write lands). */
  tearOnce?: number[];
  /** Chunk indices whose bytes NEVER reach the account, even after repair. */
  tearForever?: number[];
}

/** A fake cluster: applies write_proof_chunk instructions to an in-memory
 * buffer and answers status polls. Counts calls so the tests can assert on
 * ORDER (all sends before the first poll) and on what was resent. */
function fakeChain(proofLen: number, opts: FakeChainOptions = {}) {
  const account = new Uint8Array(PROOF_DATA_OFFSET + proofLen);
  const sent: Array<{ sig: string; offset: number; len: number; blockhash: string }> = [];
  const confirmed = new Set<string>();
  const dropOnce = new Set(opts.dropOnce ?? []);
  const tearOnce = new Set(opts.tearOnce ?? []);
  const tearForever = new Set(opts.tearForever ?? []);
  let blockhashCounter = 0;
  let statusPolls = 0;
  let firstPollAfterSends = -1;

  const conn = {
    rpcEndpoint: opts.rpcEndpoint ?? 'https://devnet.helius-rpc.com/?api-key=test',
    async getLatestBlockhash() {
      blockhashCounter += 1;
      return { blockhash: `bh-${blockhashCounter}`, lastValidBlockHeight: 1000 };
    },
    async sendRawTransaction(raw: Buffer) {
      const parsed = JSON.parse(Buffer.from(raw).toString()) as {
        recentBlockhash: string;
        instructions: Array<{ data: number[] }>;
      };
      const ix = parsed.instructions[0];
      const data = Buffer.from(ix.data);
      expect(Array.from(data.subarray(0, 8))).toEqual(DISC_WRITE_CHUNK);
      const offset = data.readUInt32LE(8);
      const len = data.readUInt32LE(12);
      const bytes = data.subarray(16, 16 + len);
      const chunkIndex = offset / MAX_CHUNK_SIZE;
      const sig = `sig-${sent.length}`;
      sent.push({ sig, offset, len, blockhash: parsed.recentBlockhash });
      if (dropOnce.has(chunkIndex)) {
        dropOnce.delete(chunkIndex);
        return sig; // sent, never lands
      }
      confirmed.add(sig);
      if (tearForever.has(chunkIndex)) return sig;
      if (tearOnce.has(chunkIndex)) {
        tearOnce.delete(chunkIndex);
        return sig; // confirmed, bytes lost
      }
      account.set(bytes, PROOF_DATA_OFFSET + offset);
      return sig;
    },
    async getSignatureStatuses(sigs: string[]) {
      statusPolls += 1;
      if (firstPollAfterSends < 0) firstPollAfterSends = sent.length;
      return {
        value: sigs.map(s => (confirmed.has(s) ? { err: null, confirmationStatus: 'confirmed' } : null)),
      };
    },
    async getAccountInfo() {
      return { data: Buffer.from(account) };
    },
    async getBlockHeight() {
      return 1;
    },
  };
  return {
    conn: conn as unknown as Connection,
    sent,
    account,
    stats: () => ({ statusPolls, firstPollAfterSends, blockhashes: blockhashCounter }),
  };
}

describe('pacing — where the July idle time was, and why it cannot come back', () => {
  it('a Helius endpoint is never throttled', () => {
    expect(pacingForEndpoint('https://devnet.helius-rpc.com/?api-key=abc')).toBe(FAST_PACING);
    expect(pacingForEndpoint('https://mainnet.helius-rpc.com/?api-key=abc')).toBe(FAST_PACING);
    expect(FAST_PACING.delayMs).toBe(0);
    expect(FAST_PACING.batch).toBe(Infinity);
  });
  it('a relay or localhost is treated as paid-for', () => {
    expect(pacingForEndpoint('https://relay.example.com/v1/rpc')).toBe(FAST_PACING);
    expect(pacingForEndpoint('http://localhost:8899')).toBe(FAST_PACING);
  });
  it('the public cluster endpoints keep a small pacing, and an unknown connection defaults to it', () => {
    expect(pacingForEndpoint('https://api.devnet.solana.com')).toBe(PUBLIC_RPC_PACING);
    expect(pacingForEndpoint('https://api.mainnet-beta.solana.com')).toBe(PUBLIC_RPC_PACING);
    expect(pacingForEndpoint(undefined)).toBe(PUBLIC_RPC_PACING);
    expect(PUBLIC_RPC_PACING.batch).toBeGreaterThanOrEqual(4);
    expect(PUBLIC_RPC_PACING.delayMs).toBeLessThanOrEqual(500);
  });
  it('the per-call RPC jitter is skipped for Helius, the relay and localhost, kept for the public cluster', () => {
    expect(isPrivateRpcEndpoint('https://devnet.helius-rpc.com/?api-key=abc')).toBe(true);
    expect(isPrivateRpcEndpoint('https://relay.p01.example/v1/rpc')).toBe(true);
    expect(isPrivateRpcEndpoint('http://localhost:8899')).toBe(true);
    expect(isPrivateRpcEndpoint('https://api.devnet.solana.com')).toBe(false);
  });
  it('every poll interval is 400 ms — not the 1,500 ms the July doc measured', () => {
    expect(FAST_PACING.pollMs).toBe(400);
    expect(PUBLIC_RPC_PACING.pollMs).toBe(400);
  });
});

describe('chunk geometry and the readback gate (pure)', () => {
  it('splits an 82,477-byte C6 proof into 83 chunks, the last one short', () => {
    const chunks = splitProofIntoChunks(proofOf(82_477));
    expect(chunks.length).toBe(83);
    expect(chunks[82].bytes.length).toBe(477);
    expect(chunks[5].offset).toBe(5000);
  });
  it('finds exactly the torn chunk, and reports everything as holes on a null account', () => {
    const proof = proofOf(3_500);
    const data = new Uint8Array(PROOF_DATA_OFFSET + proof.length);
    data.set(proof, PROOF_DATA_OFFSET);
    expect(findBufferHoles(proof, data)).toEqual([]);
    data[PROOF_DATA_OFFSET + 2_300] ^= 0xff;
    expect(findBufferHoles(proof, data)).toEqual([2]);
    expect(findBufferHoles(proof, null)).toEqual([0, 1, 2, 3]);
    expect(findBufferHoles(proof, data.subarray(0, PROOF_DATA_OFFSET + 1_500))).toEqual([1, 2, 3]);
  });
});

describe('uploadProofChunks — one barrier, targeted resend, byte-for-byte readback', () => {
  const kp = Keypair.generate();
  const buffer = new PublicKey('proof-buffer');

  it('sends EVERY chunk before the first status poll, and the account matches the proof', async () => {
    const proof = proofOf(12_345);
    const chain = fakeChain(proof.length);
    const steps: string[] = [];
    await uploadProofChunks(chain.conn, proof, buffer, kp.publicKey, kp, undefined, s => steps.push(s), {
      confirmWindowMs: 200,
      pollMs: 5,
    });
    const { firstPollAfterSends, statusPolls } = chain.stats();
    expect(chain.sent.length).toBe(13);
    expect(firstPollAfterSends).toBe(13); // all 13 sent, then polled
    expect(statusPolls).toBe(1); // everything confirmed on the first poll
    expect(Array.from(chain.account.subarray(PROOF_DATA_OFFSET))).toEqual(Array.from(proof));
    expect(steps.some(s => /Uploading the proof \(13 chunks\)/.test(s))).toBe(true);
  });

  it('resends ONLY the dropped chunk, under a fresh blockhash', async () => {
    const proof = proofOf(9_000);
    const chain = fakeChain(proof.length, { dropOnce: [4] });
    await uploadProofChunks(chain.conn, proof, buffer, kp.publicKey, kp, undefined, undefined, {
      confirmWindowMs: 30,
      pollMs: 5,
    });
    expect(chain.sent.length).toBe(10); // 9 + 1 resend
    const resend = chain.sent[9];
    expect(resend.offset).toBe(4000);
    expect(resend.blockhash).not.toBe(chain.sent[0].blockhash);
    expect(Array.from(chain.account.subarray(PROOF_DATA_OFFSET))).toEqual(Array.from(proof));
  });

  it('a chunk that confirmed but never landed is caught by the readback and repaired', async () => {
    const proof = proofOf(6_000);
    const chain = fakeChain(proof.length, { tearOnce: [2] });
    const steps: string[] = [];
    await uploadProofChunks(chain.conn, proof, buffer, kp.publicKey, kp, undefined, s => steps.push(s), {
      confirmWindowMs: 30,
      pollMs: 5,
    });
    expect(chain.sent.length).toBe(7); // 6 + 1 repair
    expect(chain.sent[6].offset).toBe(2000);
    expect(steps.some(s => /Readback found 1 torn chunk/.test(s))).toBe(true);
    expect(Array.from(chain.account.subarray(PROOF_DATA_OFFSET))).toEqual(Array.from(proof));
  });

  it('a hole that survives the repair aborts before any verify CU is spent', async () => {
    const proof = proofOf(4_000);
    const chain = fakeChain(proof.length, { tearForever: [1] });
    await expect(
      uploadProofChunks(chain.conn, proof, buffer, kp.publicKey, kp, undefined, undefined, {
        confirmWindowMs: 30,
        pollMs: 5,
      }),
    ).rejects.toThrow(/torn on-chain: chunk\(s\) \[1\]/);
  });

  it('on a public endpoint the sends are paced in bursts; on Helius they are not', async () => {
    const proof = proofOf(20_000);
    const helius = fakeChain(proof.length);
    const t0 = Date.now();
    await uploadProofChunks(helius.conn, proof, buffer, kp.publicKey, kp, undefined, undefined, {
      confirmWindowMs: 100,
      pollMs: 5,
    });
    const heliusMs = Date.now() - t0;
    expect(heliusMs).toBeLessThan(PUBLIC_RPC_PACING.delayMs); // no burst sleep at all

    const pub = fakeChain(proof.length, { rpcEndpoint: 'https://api.devnet.solana.com' });
    const t1 = Date.now();
    await uploadProofChunks(pub.conn, proof, buffer, kp.publicKey, kp, undefined, undefined, {
      confirmWindowMs: 100,
      pollMs: 5,
    });
    const publicMs = Date.now() - t1;
    // 20 chunks / batch 8 = 3 bursts = 2 sleeps of delayMs.
    expect(publicMs).toBeGreaterThanOrEqual(2 * PUBLIC_RPC_PACING.delayMs - 20);
    expect(pub.sent.length).toBe(20);
  });
});

describe('confirmation polling', () => {
  it('confirmSignaturesSoft returns the unconfirmed indices after the window, without throwing', async () => {
    const seen = new Set<string>(['a', 'c']);
    let polls = 0;
    const conn = {
      async getSignatureStatuses(sigs: string[]) {
        polls += 1;
        return { value: sigs.map(s => (seen.has(s) ? { err: null, confirmationStatus: 'confirmed' } : null)) };
      },
    } as unknown as Connection;
    const left = await confirmSignaturesSoft(conn, ['a', 'b', 'c'], 't', 40, 5);
    expect(left).toEqual([1]);
    expect(polls).toBeGreaterThan(3);
  });

  it('confirmSignaturesSoft throws on an on-chain error (resending would not help)', async () => {
    const conn = {
      async getSignatureStatuses(sigs: string[]) {
        return { value: sigs.map(() => ({ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' })) };
      },
    } as unknown as Connection;
    await expect(confirmSignaturesSoft(conn, ['x'], 'chunk', 40, 5)).rejects.toThrow(/chunk failed/);
  });

  it('confirmSignatureFast resolves on confirmed, throws on err, and expires past lastValidBlockHeight', async () => {
    let n = 0;
    const conn = {
      async getSignatureStatuses() {
        n += 1;
        return { value: [n >= 3 ? { err: null, confirmationStatus: 'confirmed' } : null] };
      },
      async getBlockHeight() {
        return 5;
      },
    } as unknown as Connection;
    await confirmSignatureFast(conn, 'sig', { pollMs: 2 });
    expect(n).toBe(3);

    const bad = {
      async getSignatureStatuses() {
        return { value: [{ err: 'boom', confirmationStatus: 'confirmed' }] };
      },
    } as unknown as Connection;
    await expect(confirmSignatureFast(bad, 'sig', { pollMs: 2 })).rejects.toThrow(/Transaction failed/);

    const expired = {
      async getSignatureStatuses() {
        return { value: [null] };
      },
      async getBlockHeight() {
        return 10;
      },
    } as unknown as Connection;
    await expect(
      confirmSignatureFast(expired, 'sigsigsigsigsig', { pollMs: 1, lastValidBlockHeight: 5, timeoutMs: 5_000 }),
    ).rejects.toThrow(/expired/);
  });

  it('audible re-emits the label with the seconds elapsed, and stops when the await resolves', async () => {
    vi.useFakeTimers();
    try {
      const steps: string[] = [];
      let release: () => void = () => {};
      const p = audible('Confirming', s => steps.push(s), () => new Promise<void>(r => { release = r; }), 1_000);
      await vi.advanceTimersByTimeAsync(3_500);
      release();
      await p;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(steps[0]).toBe('Confirming');
      expect(steps.filter(s => /^Confirming \(\d+s\)$/.test(s)).length).toBe(3);
      expect(steps.length).toBe(4); // nothing after resolve
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the composed transaction — L3', () => {
  const kp = Keypair.generate();
  const buffer = new PublicKey('proof-buffer');
  const consumeIx = new TransactionInstruction({
    programId: new PublicKey('pool'),
    keys: [],
    data: Buffer.from([9, 9, 9]),
  });
  const discOf = (ix: any) => Array.from(ix.data.subarray(0, 8));

  it('circuit 7 measured CU fits ONE transaction with the spend; circuit 6 phase 1 alone does not leave room', () => {
    expect(C7_PHASE1_CU + C7_PHASE2_CU + 176_404).toBeLessThan(MAX_TX_CU);
    expect(C6_PHASE1_CU + 190_000).toBeGreaterThan(MAX_TX_CU);
    expect(planForCircuit(7)).toBe('single');
    expect(planForCircuit(6)).toBe('split');
    expect(planForCircuit(1)).toBe('split');
  });

  it("'single': [cu limit, cu price, verify_v2, phase 2, consume, close] — close LAST", () => {
    const tx = composeConsumeTransaction({
      proof: { proofBytes: new Uint8Array(1), circuitId: 7, publicInputs: [1n, 2n, 3n, 4n, 5n, 6n], proofSize: 1 },
      proofBuffer: buffer,
      authority: kp.publicKey,
      consume: { ixs: [consumeIx], cuLimit: MAX_TX_CU, cuPriceMicroLamports: 1000 },
      includePhase1: true,
    });
    const ixs = tx.instructions;
    expect(ixs.length).toBe(6);
    expect(ixs[0].data[0]).toBe(2);
    expect(ixs[0].data.readUInt32LE(1)).toBe(MAX_TX_CU);
    expect(ixs[1].data[0]).toBe(3);
    expect(discOf(ixs[2])).toEqual(DISC_VERIFY_V2);
    expect(discOf(ixs[3])).toEqual(DISC_PHASE2);
    expect(ixs[4]).toBe(consumeIx);
    expect(discOf(ixs[5])).toEqual(DISC_CLOSE);
    // phase 1 and phase 2 carry the same public inputs, byte for byte
    expect(Array.from(ixs[2].data.subarray(8))).toEqual(Array.from(ixs[3].data.subarray(8)));
  });

  it("'split' (circuit 6): no phase 1 in the composed tx, phase 2 then shield then close", () => {
    const tx = composeConsumeTransaction({
      proof: { proofBytes: new Uint8Array(1), circuitId: 6, publicInputs: [0n, 1n, 2n, 3n, 11n], proofSize: 1 },
      proofBuffer: buffer,
      authority: kp.publicKey,
      consume: { ixs: [consumeIx], cuLimit: 1_000_000 },
      includePhase1: false,
    });
    const ixs = tx.instructions;
    expect(ixs.length).toBe(4);
    expect(ixs[0].data.readUInt32LE(1)).toBe(1_000_000);
    expect(discOf(ixs[1])).toEqual(DISC_PHASE2);
    expect(ixs[2]).toBe(consumeIx);
    expect(discOf(ixs[3])).toEqual(DISC_CLOSE);
    expect(ixs.some(ix => discOf(ix).join() === DISC_VERIFY_V2.join())).toBe(false);
  });

  it('circuit 0 verifies inline: legacy verify, no phase 2', () => {
    const tx = composeConsumeTransaction({
      proof: { proofBytes: new Uint8Array(1), circuitId: 0, publicInputs: [42n], proofSize: 1 },
      proofBuffer: buffer,
      authority: kp.publicKey,
      consume: { ixs: [consumeIx], cuLimit: MAX_TX_CU },
      includePhase1: true,
    });
    const discs = tx.instructions.map(discOf).map(d => d.join());
    expect(discs).toContain(DISC_VERIFY_LEGACY.join());
    expect(discs).not.toContain(DISC_PHASE2.join());
  });

  it('closeInline: false leaves the buffer for the caller, and the 1.4M cap is enforced', () => {
    const tx = composeConsumeTransaction({
      proof: { proofBytes: new Uint8Array(1), circuitId: 7, publicInputs: [1n], proofSize: 1 },
      proofBuffer: buffer,
      authority: kp.publicKey,
      consume: { ixs: [consumeIx], cuLimit: MAX_TX_CU, closeInline: false },
      includePhase1: true,
    });
    expect(tx.instructions.map(discOf).map(d => d.join())).not.toContain(DISC_CLOSE.join());
    expect(() =>
      composeConsumeTransaction({
        proof: { proofBytes: new Uint8Array(1), circuitId: 7, publicInputs: [1n], proofSize: 1 },
        proofBuffer: buffer,
        authority: kp.publicKey,
        consume: { ixs: [consumeIx], cuLimit: MAX_TX_CU + 1 },
        includePhase1: true,
      }),
    ).toThrow(/exceeds the 1400000/);
  });
});
