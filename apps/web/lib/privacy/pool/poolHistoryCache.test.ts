/**
 * [HISTORY-CACHE 2026-09-13] The pool-history walk is fetched once and then
 * only EXTENDED: the second call asks the RPC for signatures `until` the newest
 * one it decoded, and decodes only those.
 *
 * Built against real event bytes (the V3 `LeafInserted` layout the walk
 * decodes) so the assertion is on the decoded map, not on a mocked decoder.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fetchPoolCommitments } from './denominatedPool';
import {
  memoryPoolHistoryStore,
  poolHistoryKey,
  setPoolHistoryStore,
  type PoolHistoryStore,
} from './poolHistoryCache';

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

interface FakeTx { signature: string; slot: number; leafIndex: number | null; commitment: bigint }

/** Newest-first history, the way `getSignaturesForAddress` pages it. */
class FakeHistory {
  txs: FakeTx[] = [];
  getTransactionCalls = 0;
  signatureCalls: Array<{ before?: string; until?: string; limit?: number }> = [];
  rpcEndpoint = 'https://fake.rpc/';

  push(leafIndex: number, commitment: bigint) {
    const signature = `sig_${leafIndex}_${commitment.toString(16)}`;
    this.txs.unshift({ signature, slot: 1000 + leafIndex, leafIndex, commitment });
  }

  /**
   * A pool transaction that inserts NO leaf — a v4 withdrawal, say, which
   * lists the pool PDA as writable and so comes back from
   * `getSignaturesForAddress` like any deposit. The walk reads it, finds no
   * `LeafInserted` event, and files nothing.
   */
  pushLeafless(signature: string, slot = 9_000) {
    this.txs.unshift({ signature, slot, leafIndex: null, commitment: 0n });
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

  /**
   * Signatures the RPC LISTS but will not RETURN: a null answer, which is a
   * read that did not happen rather than a transaction without leaves. An
   * ordinary devnet event (a pruning node, a 429, an un-indexed slot).
   */
  unreadable = new Set<string>();

  async getTransaction(signature: string, _opts?: unknown) {
    this.getTransactionCalls++;
    if (this.unreadable.has(signature)) return null;
    const t = this.txs.find((x) => x.signature === signature);
    if (!t) return null;
    return {
      slot: t.slot,
      meta: {
        logMessages:
          t.leafIndex === null
            ? ['Program log: Instruction: SpendV4', 'Program log: success']
            : [`Program data: ${leafInsertedEvent(t.leafIndex, t.commitment)}`],
      },
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

/**
 * [HIST-1] The snapshot is keyed by the RPC HOST and the pool — never by the
 * endpoint's path or query.
 *
 * Re-read 2026-09-16, at today's line numbers: `poolHistoryKey` is
 * `${rpcEndpoint}|${poolPDA}` (`poolHistoryCache.ts:129-131`) and the same
 * string is written INTO the snapshot as `key` (`denominatedPool.ts:2137`).
 * The deployment's endpoint is a Helius URL whose query carries an API key, so
 * every IndexedDB row on a user's device, and every JSON file the live harness
 * writes, held that key in clear. Two such files are still on this machine;
 * they are the founder action in `HIST-1-report.md`.
 *
 * `SECRET123` below is a fixture. The real key lives in `apps/web/.env.local`,
 * is never read by a test, and is never written to a log.
 */
describe('[HIST-1] the snapshot key is a function of host and pool only', () => {
  const SECRET = 'SECRET123';
  const ENDPOINT = `https://devnet.helius-rpc.com/v0/rpc?api-key=${SECRET}`;

  /**
   * A store whose rows the test can read whole. `unknown` on purpose: the same
   * literals must compile against the snapshot shape both before and after
   * this work package changes it, so the test is identical in its red and in
   * its green.
   */
  function recordingStore() {
    const rows = new Map<string, unknown>();
    const store = {
      async load(key: string) {
        return rows.get(key) ?? null;
      },
      async save(snapshot: { key: string }) {
        rows.set(snapshot.key, snapshot);
      },
      async clear(key: string) {
        rows.delete(key);
      },
    } as unknown as PoolHistoryStore;
    return { rows, store };
  }

  it('no snapshot key or value holds the endpoint path or query', async () => {
    const { rows, store } = recordingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    h.rpcEndpoint = ENDPOINT;
    for (let i = 0; i < 4; i++) h.push(i, 3_000n + BigInt(i));

    await fetchPoolCommitments(h.asConnection(), POOL);

    // Read the way a dump reads it: every key AND every value.
    const dump = JSON.stringify([...rows.entries()]);
    expect(rows.size).toBeGreaterThan(0);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('api-key');
    expect(dump).not.toContain('/v0/rpc');
    // Still a per-host, per-pool cache: the host and the pool are the key.
    expect([...rows.keys()]).toEqual([`devnet.helius-rpc.com|${POOL.toBase58()}`]);
  });

  it('a legacy row keyed by the whole endpoint is migrated and deleted', async () => {
    const { rows, store } = recordingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    h.rpcEndpoint = ENDPOINT;
    for (let i = 0; i < 4; i++) h.push(i, 4_000n + BigInt(i));

    // The key the old code wrote, spelled out rather than imported: it is a
    // constant of what shipped, not of what the module returns today.
    const legacyKey = `${ENDPOINT}|${POOL.toBase58()}`;
    rows.set(legacyKey, {
      version: 1,
      key: legacyKey,
      newestSignature: h.txs[0]!.signature,
      entries: h.txs.map((t) => ({
        commitment: t.commitment.toString(),
        leafIndex: t.leafIndex,
        depositPayer: PAYER.toBase58(),
        depositSlot: t.slot,
        signature: t.signature,
      })),
      savedAt: 1_700_000_000_000,
    });

    h.getTransactionCalls = 0;
    const map = await fetchPoolCommitments(h.asConnection(), POOL);

    expect(rows.has(legacyKey)).toBe(false);
    expect(rows.has(poolHistoryKey(ENDPOINT, POOL.toBase58()))).toBe(true);
    expect(JSON.stringify([...rows.entries()])).not.toContain(SECRET);
    // [close-v1, audit v1 F33/F34] Deleted AND not trusted: a version-1 row is
    // a pre-fix walk's leaf map (filed by commitment, any program's events), so
    // its four leaves are read again from the chain (`POOL_HISTORY_VERSION`).
    // This case used to pin "migrated, not thrown away: 0 transactions".
    expect(map.size).toBe(4);
    expect(h.getTransactionCalls).toBe(4);
  });

  it('two endpoints that differ only by their credential share one snapshot, two hosts do not', async () => {
    const other = `https://devnet.helius-rpc.com/v0/rpc?api-key=OTHERKEY`;
    expect(poolHistoryKey(ENDPOINT, POOL.toBase58())).toBe(poolHistoryKey(other, POOL.toBase58()));
    expect(poolHistoryKey(ENDPOINT, POOL.toBase58())).not.toBe(
      poolHistoryKey('https://api.devnet.solana.com', POOL.toBase58()),
    );
    // A string that is not a URL must still never be stored whole.
    expect(poolHistoryKey('not a url?api-key=SECRET123', POOL.toBase58())).not.toContain(SECRET);
  });
});

/**
 * [SWEEP4 round 1, storage lane] The device's row is a function of the CHAIN,
 * not of this device's walks.
 *
 * The row lives in IndexedDB `p01-pool-history` on the user's own machine, so
 * its reader is a storage dump (an extension with storage access, disk
 * forensics, an XSS) holding the public chain beside it. Three of its fields
 * moved with THIS device rather than with the pool:
 *
 *   - `newestSignature`. `PoolPanel` rescans the moment a withdrawal lands, so
 *     the resume point became the user's OWN v4 withdrawal — a transaction
 *     that names the payout address the pool paid. The pool PDA is writable in
 *     it, which is why `getSignaturesForAddress` returns it at all.
 *   - `savedAt`, the millisecond of the last walk.
 *   - `entries`, kept in the order the walks happened to decode them, so their
 *     order drew the walk boundaries: how many leaves the pool held at each
 *     scan and each spend preparation this device ran.
 *
 * CACHE-1 removed exactly these three from the KV twin (`kvPoolHistory.ts`,
 * "minus `savedAt` … the order the walks happened to decode the leaves in");
 * the device row kept them. The cases below are the device side of the same
 * rule, and they are MEASURED, not spelled: each runs the same chain twice and
 * reads what MOVES the row.
 */
describe('[SWEEP4-STORAGE] the pool-history row is a function of the chain, not of this device', () => {
  /** A store whose rows the test can read whole, as a dump reads them. */
  function recordingStore() {
    const rows = new Map<string, unknown>();
    const store = {
      async load(key: string) {
        return rows.get(key) ?? null;
      },
      async save(snapshot: { key: string }) {
        rows.set(snapshot.key, snapshot);
      },
      async clear(key: string) {
        rows.delete(key);
      },
    } as unknown as PoolHistoryStore;
    return { rows, store };
  }

  function row(rows: Map<string, unknown>) {
    return [...rows.values()][0] as {
      newestSignature: string | null;
      savedAt: number;
      entries: Array<{ leafIndex: number; signature: string }>;
    };
  }

  it('names no transaction of this device: the walk that follows the user’s own withdrawal keeps a deposit as its resume point', async () => {
    const { rows, store } = recordingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    for (let i = 0; i < 5; i++) h.push(i, 5_000n + BigInt(i));

    // The device's ordinary walk...
    await fetchPoolCommitments(h.asConnection(), POOL);
    const newestDeposit = h.txs[0]!.signature;

    // ...then this user's own withdrawal lands and the panel rescans.
    h.pushLeafless('WITHDRAWAL_OF_THIS_DEVICE_1');
    await fetchPoolCommitments(h.asConnection(), POOL);

    expect(row(rows).newestSignature, 'the row names the device’s own withdrawal').not.toBe(
      'WITHDRAWAL_OF_THIS_DEVICE_1',
    );
    // The resume point is a deposit — a leaf the row already carries, so it
    // adds nothing to the dump that the entries do not already say.
    expect(row(rows).newestSignature).toBe(newestDeposit);
    expect(
      row(rows).entries.some((e) => e.signature === row(rows).newestSignature),
      'the resume point is not one of the leaves the row already holds',
    ).toBe(true);
  });

  /**
   * 🚨 THE SAME LEAK, THROUGH THE OTHER DOOR (gate r1, RED 6).
   *
   * `rememberLeafless` is only reached after a SUCCESSFUL read, so the rule
   * above — "a transaction this walk read and found leafless is never the saved
   * resume point" — says nothing about a transaction the walk could not read.
   * A null, a 429 or a log-less answer is an ordinary devnet event, and on the
   * very path the leak was measured on (PoolPanel rescanning the moment a
   * withdrawal lands) the unreadable transaction IS the user's own withdrawal.
   * The row then names it again.
   *
   * ⛔ AND THE GRIEFER RULE MUST SURVIVE. A transaction the CHAIN REJECTED is
   * listed and never fetched, so it never enters the re-read list, and it stays
   * eligible as the resume point — otherwise a griefer's failing padding above a
   * real deposit is re-listed on every walk until it eats the signature budget
   * (`poolHistoryBackfill.test.ts`). "Unread" here means "listed as successful
   * and not returned", never "rejected".
   */
  it('names no transaction of this device when the read of it FAILED, not only when it succeeded', async () => {
    const { rows, store } = recordingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    for (let i = 0; i < 5; i++) h.push(i, 8_100n + BigInt(i));

    await fetchPoolCommitments(h.asConnection(), POOL);
    const newestDeposit = h.txs[0]!.signature;

    // This user's own withdrawal lands, the panel rescans, and the RPC will not
    // hand the transaction back.
    h.pushLeafless('WITHDRAWAL_OF_THIS_DEVICE_2');
    h.unreadable.add('WITHDRAWAL_OF_THIS_DEVICE_2');
    await fetchPoolCommitments(h.asConnection(), POOL);

    expect(
      row(rows).newestSignature,
      'the row names the device\u2019s own withdrawal as its resume point',
    ).not.toBe('WITHDRAWAL_OF_THIS_DEVICE_2');
    expect(row(rows).newestSignature).toBe(newestDeposit);
  });

  /**
   * ⚠️ A DISCLOSED RESIDUAL, MEASURED RATHER THAN HIDDEN (gate r1, RED 6).
   *
   * The re-read list holds RAW SIGNATURES of transactions the RPC listed and
   * did not return, and on this same path that can be the user's own
   * withdrawal. It cannot be removed today:
   *   - hashing buys nothing, because the pool's signature list is public;
   *   - leaving out the entries above the resume point stops the walk
   *     converging (`spendRootIsCurrent.test.ts`, "signatures the walk gave up
   *     on keep a short map from being proved" — `dropped` measured 0, not 2);
   *   - moving the count into session memory loses the attempt cap across a
   *     reload.
   * What closes it is sealing this row, which the walk cannot do today: it has
   * no identity to seal to. FOUNDER / next round.
   *
   * So what is pinned here is the BOUND. The signature is in the row only while
   * the RPC is failing on it, and the FIRST successful read takes it out — the
   * window is the outage, not the life of the store. A change that let it
   * linger, or that wrote it into any other field, fails this case.
   */
  it('clears it from the row as soon as the read succeeds, so the window is the outage', async () => {
    const { rows, store } = recordingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    for (let i = 0; i < 5; i++) h.push(i, 8_200n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);

    h.pushLeafless('WITHDRAWAL_OF_THIS_DEVICE_3');
    h.unreadable.add('WITHDRAWAL_OF_THIS_DEVICE_3');
    await fetchPoolCommitments(h.asConnection(), POOL);

    // The residual, stated: while the read keeps failing it is in the re-read
    // list — and in NO other field. This is the positive control for the
    // assertion below, and the list of fields is what keeps a future one from
    // carrying it quietly.
    const during = row(rows) as unknown as Record<string, unknown>;
    expect(
      JSON.stringify(during.retry),
      'the re-read list does not name it, so this case proves nothing',
    ).toContain('WITHDRAWAL_OF_THIS_DEVICE_3');
    for (const [field, value] of Object.entries(during)) {
      if (field === 'retry') continue;
      expect(JSON.stringify(value) ?? '', `the row names it in ${field}`).not.toContain(
        'WITHDRAWAL_OF_THIS_DEVICE_3',
      );
    }

    // The RPC recovers. One successful read and the row names it nowhere.
    h.unreadable.clear();
    await fetchPoolCommitments(h.asConnection(), POOL);

    const dump = JSON.stringify([...rows.entries()]);
    expect(dump, 'nothing was stored at all').toContain('sig_4_');
    expect(dump, 'the row still names this device’s own withdrawal after a good read').not.toContain(
      'WITHDRAWAL_OF_THIS_DEVICE_3',
    );
  });

  it('carries no clock: the same chain walked at two different moments stores the same row', async () => {
    async function world(now: number): Promise<string> {
      const { rows, store } = recordingStore();
      setPoolHistoryStore(store);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const h = new FakeHistory();
        for (let i = 0; i < 4; i++) h.push(i, 6_000n + BigInt(i));
        await fetchPoolCommitments(h.asConnection(), POOL);
        h.push(4, 6_004n);
        await fetchPoolCommitments(h.asConnection(), POOL);
      } finally {
        clock.mockRestore();
      }
      return JSON.stringify([...rows.entries()]);
    }
    const base = await world(1_700_000_000_000);
    expect(await world(1_700_000_000_000), 'the world does not replay').toBe(base);
    expect(await world(1_800_000_000_000), 'the stored row moved with the clock').toBe(base);
  });

  it('files the leaves in leaf order, so the row does not draw this device’s walk boundaries', async () => {
    const { rows, store } = recordingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    // Five leaves, a walk; two more, a walk; one more, a walk. The walk
    // boundaries fall at 5 and 7 leaves.
    for (let i = 0; i < 5; i++) h.push(i, 7_000n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);
    h.push(5, 7_005n);
    h.push(6, 7_006n);
    await fetchPoolCommitments(h.asConnection(), POOL);
    h.push(7, 7_007n);
    await fetchPoolCommitments(h.asConnection(), POOL);

    expect(row(rows).entries.map((e) => e.leafIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('costs no re-read: a leafless transaction above the newest deposit is fetched once, not once per walk', async () => {
    const { store } = recordingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    for (let i = 0; i < 3; i++) h.push(i, 8_000n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);

    h.pushLeafless('WITHDRAWAL_OF_THIS_DEVICE_2');
    h.getTransactionCalls = 0;
    await fetchPoolCommitments(h.asConnection(), POOL);
    expect(h.getTransactionCalls, 'the new transaction is read once').toBe(1);

    // Two more walks with nothing new on chain: the resume point is a deposit,
    // so the withdrawal is LISTED again — and must not be read again.
    h.getTransactionCalls = 0;
    await fetchPoolCommitments(h.asConnection(), POOL);
    await fetchPoolCommitments(h.asConnection(), POOL);
    expect(h.getTransactionCalls, 'a leafless transaction is re-read every walk').toBe(0);
  });
});

/**
 * [SWEEP round 1 of run logs8, storage lens] A row the DEPLOYED build wrote is
 * healed or deleted whatever the current endpoint is.
 *
 * origin/master writes the key as `${rpcEndpoint}|${pool}`, and the HIST-1
 * migration above only ever looks under the key it can RECOMPUTE from today's
 * endpoint. The RPC credential is rotated before this build ships, so the
 * recomputed legacy key stops matching on the first visit after the deploy and
 * the row stays for the life of the profile: `newestSignature` (the device's
 * own v4 withdrawal whenever the old build's last walk was the post-withdrawal
 * rescan), `savedAt` (the millisecond of that walk), the entries in walk order,
 * and the old endpoint spelled in the key. Measured by the sweep's probe
 * `logs8/r1-storage/A-orphan-history-row.probe.ts`.
 *
 * The store below has the get / put / delete-by-key behaviour of the IndexedDB
 * one, plus `keys()`, which is what the healing needs: it cannot depend on
 * recomputing a key it no longer knows.
 *
 * The credential strings are placeholders. No real key is read or printed.
 */
describe('[SWEEP-R1-STORAGE] a row left under a key that spells an endpoint does not outlive one walk', () => {
  const OLD_ENDPOINT = 'https://devnet.helius-rpc.com/?api-key=OLD-CREDENTIAL-PLACEHOLDER';
  const NEW_ENDPOINT = 'https://devnet.helius-rpc.com/?api-key=NEW-CREDENTIAL-PLACEHOLDER';
  const OWN_WITHDRAWAL = 'OWN_WITHDRAWAL_SIGNATURE_of_this_device';
  const LAST_WALK_MS = 1_789_000_123_456;

  function listingStore() {
    const rows = new Map<string, unknown>();
    const store = {
      async load(key: string) {
        return rows.get(key) ?? null;
      },
      async save(snapshot: { key: string }) {
        rows.set(snapshot.key, snapshot);
      },
      async clear(key: string) {
        rows.delete(key);
      },
      async keys() {
        return [...rows.keys()];
      },
    } as unknown as PoolHistoryStore;
    return { rows, store };
  }

  /** The row exactly as the build on origin/master writes it: version 1, key = the whole endpoint, walk order. */
  function shippedRow(endpoint: string, pool: PublicKey, h: FakeHistory): [string, unknown] {
    const key = `${endpoint}|${pool.toBase58()}`;
    return [
      key,
      {
        version: 1,
        key,
        newestSignature: OWN_WITHDRAWAL,
        entries: h.txs.map((t) => ({
          commitment: t.commitment.toString(),
          leafIndex: t.leafIndex,
          depositPayer: PAYER.toBase58(),
          depositSlot: t.slot,
          signature: t.signature,
        })),
        savedAt: LAST_WALK_MS,
      },
    ];
  }

  it('the credential was rotated: ONE walk under the new endpoint leaves no own withdrawal, no clock and no endpoint', async () => {
    const { rows, store } = listingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    h.rpcEndpoint = NEW_ENDPOINT;
    for (let i = 0; i < 4; i++) h.push(i, 6_000n + BigInt(i));
    const [k, v] = shippedRow(OLD_ENDPOINT, POOL, h);
    rows.set(k, v);
    h.pushLeafless(OWN_WITHDRAWAL);

    h.getTransactionCalls = 0;
    const map = await fetchPoolCommitments(h.asConnection(), POOL);

    const dump = JSON.stringify([...rows.entries()]);
    expect(dump, 'the dump still names this device’s own withdrawal').not.toContain(OWN_WITHDRAWAL);
    expect(dump, 'the dump still carries the clock of the old build’s last walk').not.toContain(String(LAST_WALK_MS));
    expect(dump, 'a key still spells the old endpoint').not.toContain('OLD-CREDENTIAL-PLACEHOLDER');
    expect(dump).not.toContain('api-key');
    expect([...rows.keys()]).toEqual([poolHistoryKey(NEW_ENDPOINT, POOL.toBase58())]);
    // [close-v1, audit v1 F33/F34] Deleted, not healed: the old build's row is
    // a pre-fix leaf map, so the walk is cold and reads the four leaves and the
    // leafless withdrawal (5). This case used to pin "healed, 1 transaction".
    expect(map.size).toBe(4);
    expect(h.getTransactionCalls).toBe(5);
  });

  it('nothing new on chain since the old build’s last walk: the migrated row still does not name the withdrawal', async () => {
    // The resume point a v1 row carries is whatever was newest on the pool when
    // the old build last walked. With nothing eligible in the next delta the
    // walk keeps the resume point it was given, so the migration itself must
    // not hand the withdrawal on.
    const { rows, store } = listingStore();
    setPoolHistoryStore(store);
    const h = new FakeHistory();
    h.rpcEndpoint = OLD_ENDPOINT;
    for (let i = 0; i < 4; i++) h.push(i, 6_100n + BigInt(i));
    const [k, v] = shippedRow(OLD_ENDPOINT, POOL, h);
    rows.set(k, v);
    h.pushLeafless(OWN_WITHDRAWAL);

    await fetchPoolCommitments(h.asConnection(), POOL);
    await fetchPoolCommitments(h.asConnection(), POOL);

    const dump = JSON.stringify([...rows.entries()]);
    expect(dump, 'nothing was stored at all').toContain('sig_3_');
    expect(dump, 'the dump still names this device’s own withdrawal').not.toContain(OWN_WITHDRAWAL);
  });

  it('a row for a pool this walk never opens, and one that is not a snapshot at all, go in the same pass', async () => {
    const { rows, store } = listingStore();
    setPoolHistoryStore(store);
    const retiredPool = Keypair.generate().publicKey;
    const retired = new FakeHistory();
    for (let i = 0; i < 3; i++) retired.push(i, 7_000n + BigInt(i));
    const [k, v] = shippedRow(OLD_ENDPOINT, retiredPool, retired);
    rows.set(k, v);
    rows.set('https://devnet.helius-rpc.com/v0/rpc?api-key=OLD-CREDENTIAL-PLACEHOLDER|not-a-pool', { junk: LAST_WALK_MS });

    const h = new FakeHistory();
    h.rpcEndpoint = NEW_ENDPOINT;
    for (let i = 0; i < 4; i++) h.push(i, 8_000n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), POOL);

    const dump = JSON.stringify([...rows.entries()]);
    expect(dump).not.toContain(OWN_WITHDRAWAL);
    expect(dump).not.toContain(String(LAST_WALK_MS));
    expect(dump).not.toContain('OLD-CREDENTIAL-PLACEHOLDER');
    for (const key of rows.keys()) expect(key, 'a key still spells a URL').not.toMatch(/[/?#@]|:\/\//);
  });

  it('a well-formed row is left alone: another pool’s cache survives the pass', async () => {
    const { rows, store } = listingStore();
    setPoolHistoryStore(store);
    const other = Keypair.generate().publicKey;
    const h = new FakeHistory();
    h.rpcEndpoint = NEW_ENDPOINT;
    for (let i = 0; i < 3; i++) h.push(i, 9_000n + BigInt(i));
    await fetchPoolCommitments(h.asConnection(), other);
    await fetchPoolCommitments(h.asConnection(), POOL);
    expect([...rows.keys()].sort()).toEqual(
      [poolHistoryKey(NEW_ENDPOINT, other.toBase58()), poolHistoryKey(NEW_ENDPOINT, POOL.toBase58())].sort(),
    );
  });
});

/**
 * The same pass, through the store a BROWSER gets. The cases above use a map
 * with `keys()`; what ships is `indexedDbPoolHistoryStore`, so the listing it
 * is built on (`getAllKeys`) is exercised here against a hand-rolled
 * IndexedDB: one object store, keyPath `key`, requests that answer on a later
 * microtask as the real ones do.
 */
describe('[SWEEP-R1-STORAGE] the IndexedDB store lists its keys, so the pass reaches a browser’s rows', () => {
  function fakeIndexedDb() {
    const rows = new Map<string, { key: string }>();
    const request = <T>(compute: () => T) => {
      const req: { result?: T; error: unknown; onsuccess: null | (() => void); onerror: null | (() => void) } = {
        error: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        req.result = compute();
        req.onsuccess?.();
      });
      return req;
    };
    const objectStore = {
      get: (k: string) => request(() => rows.get(k)),
      put: (v: { key: string }) => request(() => void rows.set(v.key, v)),
      delete: (k: string) => request(() => void rows.delete(k)),
      getAllKeys: () => request(() => [...rows.keys()]),
    };
    const db = { transaction: () => ({ objectStore: () => objectStore }), close: () => undefined, createObjectStore: () => objectStore };
    const idb = {
      open: () => {
        const req = request(() => db) as ReturnType<typeof request> & { onupgradeneeded: null | (() => void) };
        req.onupgradeneeded = null;
        return req;
      },
    } as unknown as IDBFactory;
    return { rows, idb };
  }

  it('heals a row the deployed build left under a rotated credential, through the real store', async () => {
    const { indexedDbPoolHistoryStore } = await import('./poolHistoryCache');
    const { rows, idb } = fakeIndexedDb();
    const store = indexedDbPoolHistoryStore(idb);
    setPoolHistoryStore(store);

    const h = new FakeHistory();
    h.rpcEndpoint = 'https://devnet.helius-rpc.com/?api-key=NEW-CREDENTIAL-PLACEHOLDER';
    for (let i = 0; i < 4; i++) h.push(i, 6_500n + BigInt(i));
    const legacyKey = `https://devnet.helius-rpc.com/?api-key=OLD-CREDENTIAL-PLACEHOLDER|${POOL.toBase58()}`;
    rows.set(legacyKey, {
      version: 1,
      key: legacyKey,
      newestSignature: 'OWN_WITHDRAWAL_SIGNATURE_of_this_device',
      entries: h.txs.map((t) => ({
        commitment: t.commitment.toString(),
        leafIndex: t.leafIndex,
        depositPayer: PAYER.toBase58(),
        depositSlot: t.slot,
        signature: t.signature,
      })),
      savedAt: 1_789_000_123_456,
    } as unknown as { key: string });

    expect(await store.keys!()).toEqual([legacyKey]);
    h.getTransactionCalls = 0;
    const map = await fetchPoolCommitments(h.asConnection(), POOL);

    const dump = JSON.stringify([...rows.entries()]);
    expect([...rows.keys()]).toEqual([`devnet.helius-rpc.com|${POOL.toBase58()}`]);
    expect(dump).not.toContain('OWN_WITHDRAWAL_SIGNATURE_of_this_device');
    expect(dump).not.toContain('1789000123456');
    expect(dump).not.toContain('OLD-CREDENTIAL-PLACEHOLDER');
    expect(map.size).toBe(4);
    // [close-v1, audit v1 F33/F34] The old build's row is a pre-fix leaf map:
    // it is deleted, never healed into a served row, so the walk is cold and
    // reads all four leaves (it used to heal the row and read 3, resuming at
    // the public anchor). A cold walk lists with no `until`.
    expect(h.getTransactionCalls).toBe(4);
    expect(h.signatureCalls[0]?.until).toBeUndefined();
  });
});
