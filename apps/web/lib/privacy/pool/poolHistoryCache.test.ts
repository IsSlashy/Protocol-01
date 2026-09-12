/**
 * [HISTORY-CACHE 2026-09-13] The pool-history walk is fetched once and then
 * only EXTENDED: the second call asks the RPC for signatures `until` the newest
 * one it decoded, and decodes only those.
 *
 * Built against real event bytes (the V3 `LeafInserted` layout the walk
 * decodes) so the assertion is on the decoded map, not on a mocked decoder.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fetchPoolCommitments } from './denominatedPool';
import { memoryPoolHistoryStore, poolHistoryKey, setPoolHistoryStore } from './poolHistoryCache';

const POOL = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;

function leafInsertedEvent(leafIndex: number, commitment: bigint): string {
  const data = new Uint8Array(144);
  data.set(sha256(new TextEncoder().encode('event:LeafInserted')).subarray(0, 8), 0);
  data.set(POOL.toBytes(), 8);
  new DataView(data.buffer).setBigUint64(40, BigInt(leafIndex), true);
  let c = commitment;
  for (let i = 0; i < 32; i++) {
    data[48 + i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return Buffer.from(data).toString('base64');
}

interface FakeTx { signature: string; slot: number; leafIndex: number; commitment: bigint }

/** Newest-first history, the way `getSignaturesForAddress` pages it. */
class FakeHistory {
  txs: FakeTx[] = [];
  getTransactionCalls = 0;
  signatureCalls: Array<{ before?: string; until?: string; limit?: number }> = [];
  readonly rpcEndpoint = 'https://fake.rpc/';

  push(leafIndex: number, commitment: bigint) {
    const signature = `sig_${leafIndex}_${commitment.toString(16)}`;
    this.txs.unshift({ signature, slot: 1000 + leafIndex, leafIndex, commitment });
  }

  async getSignaturesForAddress(_pk: PublicKey, opts: { before?: string; until?: string; limit?: number } = {}) {
    this.signatureCalls.push(opts);
    let list = this.txs;
    if (opts.before) {
      const i = list.findIndex((t) => t.signature === opts.before);
      list = i >= 0 ? list.slice(i + 1) : list;
    }
    if (opts.until) {
      const i = list.findIndex((t) => t.signature === opts.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, opts.limit ?? 1000).map((t) => ({ signature: t.signature }));
  }

  async getTransaction(signature: string, _opts?: unknown) {
    this.getTransactionCalls++;
    const t = this.txs.find((x) => x.signature === signature);
    if (!t) return null;
    return {
      slot: t.slot,
      meta: { logMessages: [`Program data: ${leafInsertedEvent(t.leafIndex, t.commitment)}`] },
      transaction: { message: { accountKeys: [PAYER] } },
    };
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

describe('[HISTORY-CACHE] fetchPoolCommitments fetches once and then only what is new', () => {
  beforeEach(() => {
    setPoolHistoryStore(memoryPoolHistoryStore());
  });

  it('cold: walks everything and decodes every leaf', async () => {
    const h = new FakeHistory();
    for (let i = 0; i < 40; i++) h.push(i, 1_000n + BigInt(i));
    const map = await fetchPoolCommitments(h.asConnection(), POOL);
    expect(map.size).toBe(40);
    expect(map.get('1005')?.leafIndex).toBe(5);
    expect(map.get('1005')?.depositPayer).toBe(PAYER.toBase58());
    expect(h.getTransactionCalls).toBe(40);
    expect(h.signatureCalls[0]?.until).toBeUndefined();
  });

  it('warm: asks `until` the newest signature and decodes only the new transactions', async () => {
    const h = new FakeHistory();
    for (let i = 0; i < 40; i++) h.push(i, 1_000n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);
    const newestBefore = h.txs[0]!.signature;
    h.getTransactionCalls = 0;
    h.signatureCalls = [];

    h.push(40, 2_040n);
    h.push(41, 2_041n);
    const map = await fetchPoolCommitments(h.asConnection(), POOL);

    expect(h.signatureCalls[0]?.until).toBe(newestBefore);
    expect(h.getTransactionCalls).toBe(2);
    expect(map.size).toBe(42);
    expect(map.get('2041')?.leafIndex).toBe(41);
    expect(map.get('1000')?.leafIndex).toBe(0);
  });

  it('warm with nothing new: zero transactions fetched, the map is served from the cache', async () => {
    const h = new FakeHistory();
    for (let i = 0; i < 10; i++) h.push(i, 500n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);
    h.getTransactionCalls = 0;
    const map = await fetchPoolCommitments(h.asConnection(), POOL);
    expect(h.getTransactionCalls).toBe(0);
    expect(map.size).toBe(10);
  });

  it('the cache is keyed by endpoint AND pool: another pool starts cold', async () => {
    const h = new FakeHistory();
    for (let i = 0; i < 5; i++) h.push(i, 700n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);
    h.getTransactionCalls = 0;
    const other = Keypair.generate().publicKey;
    await fetchPoolCommitments(h.asConnection(), other);
    expect(h.getTransactionCalls).toBe(5);
    expect(poolHistoryKey(h.rpcEndpoint, POOL.toBase58())).not.toBe(poolHistoryKey(h.rpcEndpoint, other.toBase58()));
  });

  it('`incremental: false` ignores and does not touch the cache', async () => {
    const h = new FakeHistory();
    for (let i = 0; i < 6; i++) h.push(i, 900n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);
    h.getTransactionCalls = 0;
    const map = await fetchPoolCommitments(h.asConnection(), POOL, { incremental: false });
    expect(h.getTransactionCalls).toBe(6);
    expect(map.size).toBe(6);
  });
});
