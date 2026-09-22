/**
 * [SWEEP round 1 of run logs8, network lens] What a returning browser asks the
 * RPC is a function of the CHAIN, not of when that browser last came.
 *
 * THE LEAK, MEASURED (`logs8/r1-network/cursor.probe.test.ts` and the judges'
 * `logs8/r1-judge-15-1/cursor2.probe.test.ts`). A warm walk sent the provider
 * `until = <the newest signature this profile saw last time>` and then read
 * exactly the transactions above it. The provider holds the other half in its
 * own log, so session N+1 was joined to session N whatever the IP: a user who
 * deposits from home and comes back through a VPN to withdraw was tied to the
 * home session by the first request the page made. The judges showed that
 * dropping `until` alone does not close it: the SET of `getTransaction` reads
 * names the same cursor.
 *
 * WHAT IS PINNED. Each case runs the same public chain for several browser
 * profiles and reads the provider's log by what MOVES it (`wp-logs/PROTOCOL.md`,
 * "a test that measures a leak instead of listing its spellings"):
 *   - two profiles that last came at different moments, both inside the anchor
 *     window, send the provider the SAME requests on their next visit;
 *   - a positive control: a store that is not a device's row still resumes at
 *     its own cursor, so the detector is shown to see a cursor when there is one;
 *   - the same world replays byte for byte, so a quiet green is not an accident;
 *   - a profile that stayed away longer than the window shows a multiple-of-N
 *     leaf and nothing finer;
 *   - the map is still whole, a session reads a transaction once, and a failed
 *     re-read of a leaf already held costs nothing.
 *
 * A SESSION is a fresh module graph (`vi.resetModules`), which is what a new
 * page load is: the worker's in-memory sets die with it and only the device's
 * row survives.
 */
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';

const POOL = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;
/** Spelled here as well as imported below: the test must fail, not move, if the window is changed quietly. */
const N = 16;

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
interface LogLine { ip: string; method: string; params: unknown }

/** One PUBLIC chain and one PROVIDER log, shared by every profile of a world. */
class World {
  chain: FakeTx[] = [];
  log: LogLine[] = [];
  unreadable = new Set<string>();
  private leaves = 0;

  /** A deposit, and after every third one a withdrawal: a pool transaction that inserts no leaf. */
  deposit(count = 1): void {
    for (let k = 0; k < count; k++) {
      const leafIndex = this.leaves++;
      this.chain.unshift({ signature: `DEPOSIT_${leafIndex}`, slot: 1000 + leafIndex, leafIndex, commitment: 5000n + BigInt(leafIndex) });
      if (leafIndex % 3 === 2) {
        this.chain.unshift({ signature: `SPEND_AFTER_${leafIndex}`, slot: 1000 + leafIndex, leafIndex: null, commitment: 0n });
      }
    }
  }

  connectionFrom(ip: string): Connection {
    const world = this;
    return {
      rpcEndpoint: 'https://devnet.helius-rpc.example/?api-key=PLACEHOLDER',
      async getSignaturesForAddress(_pk: PublicKey, opts: { before?: string; until?: string; limit?: number } = {}) {
        world.log.push({ ip, method: 'getSignaturesForAddress', params: { before: opts.before, until: opts.until } });
        let list = world.chain;
        if (opts.before) {
          const i = list.findIndex((t) => t.signature === opts.before);
          list = i >= 0 ? list.slice(i + 1) : list;
        }
        if (opts.until) {
          const i = list.findIndex((t) => t.signature === opts.until);
          if (i >= 0) list = list.slice(0, i);
        }
        return list.slice(0, opts.limit ?? 1000).map((t) => ({ signature: t.signature, err: null }));
      },
      async getTransaction(signature: string) {
        world.log.push({ ip, method: 'getTransaction', params: signature });
        if (world.unreadable.has(signature)) return null;
        const t = world.chain.find((x) => x.signature === signature);
        if (!t) return null;
        return {
          slot: t.slot,
          meta: {
            err: null,
            logMessages:
              t.leafIndex === null
                ? ['Program log: Instruction: SpendV4', 'Program log: success']
                : [`Program data: ${leafInsertedEvent(t.leafIndex, t.commitment)}`],
          },
          transaction: { message: { accountKeys: [PAYER] } },
        };
      },
      async getAccountInfo() {
        world.log.push({ ip, method: 'getAccountInfo', params: 'pool' });
        const d = new Uint8Array(182);
        new DataView(d.buffer).setBigUint64(121, BigInt(world.leaves), true);
        return { data: d };
      },
    } as unknown as Connection;
  }

  /** What the provider holds about one IP: every request, in order, with the IP taken off. */
  view(ip: string): string {
    return JSON.stringify(this.log.filter((l) => l.ip === ip).map((l) => [l.method, l.params]));
  }

  reads(ip: string): string[] {
    return this.log.filter((l) => l.ip === ip && l.method === 'getTransaction').map((l) => String(l.params));
  }

  untils(ip: string): Array<string | undefined> {
    return this.log
      .filter((l) => l.ip === ip && l.method === 'getSignaturesForAddress')
      .map((l) => (l.params as { until?: string }).until);
  }
}

interface Row { key: string }
/** A browser profile's IndexedDB row, as the walk sees it. `perDevice` is what the IndexedDB store declares. */
function profile(perDevice: boolean) {
  const rows = new Map<string, Row>();
  return {
    rows,
    store: {
      perDevice,
      async load(key: string) { return rows.get(key) ?? null; },
      async save(snapshot: Row) { rows.set(snapshot.key, snapshot); },
      async clear(key: string) { rows.delete(key); },
      async keys() { return [...rows.keys()]; },
    },
  };
}

/** One page load: a fresh module graph, the profile's row, one IP. Returns the walk function of that session. */
async function openSession(p: ReturnType<typeof profile>, world: World, ip: string) {
  vi.resetModules();
  const pool = await import('./denominatedPool');
  const cache = await import('./poolHistoryCache');
  cache.setPoolHistoryStore(p.store as never);
  const conn = world.connectionFrom(ip);
  return {
    windowLeaves: (pool as unknown as { PUBLIC_ANCHOR_LEAVES?: number }).PUBLIC_ANCHOR_LEAVES,
    walk: (onWalked?: (r: { unread: number }) => void) => pool.fetchPoolCommitments(conn, POOL, { onWalked }),
  };
}

/** Monday: A comes at home, three deposits later B comes at the office. Tuesday: both come back from new networks. */
async function twoProfilesTwoVisits(perDevice: boolean) {
  const world = new World();
  const a = profile(perDevice);
  const b = profile(perDevice);
  world.deposit(40);
  await (await openSession(a, world, 'IP-A-home')).walk();
  world.deposit(3);
  await (await openSession(b, world, 'IP-B-office')).walk();
  world.deposit(4);
  const mapA = await (await openSession(a, world, 'IP-C-vpn-exit')).walk();
  const mapB = await (await openSession(b, world, 'IP-D-mobile')).walk();
  return { world, mapA, mapB, a, b };
}

describe('[SWEEP-R1-NETWORK] a returning browser asks the RPC what every returning browser asks', () => {
  it('positive control: a store that is not a device’s row resumes at its own cursor, and the provider can pair the visits', async () => {
    const { world } = await twoProfilesTwoVisits(false);
    expect(world.untils('IP-C-vpn-exit')[0]).toBe('DEPOSIT_39');
    expect(world.untils('IP-D-mobile')[0]).toBe('DEPOSIT_42');
    expect(world.view('IP-C-vpn-exit')).not.toBe(world.view('IP-D-mobile'));
  });

  it('two profiles that last came at different moments send the SAME requests on their next visit', async () => {
    const { world, mapA, mapB } = await twoProfilesTwoVisits(true);

    // The measured join: `until` of visit 2 was the newest signature served in visit 1.
    expect(world.untils('IP-C-vpn-exit'), 'profile A’s listing names its own last visit').not.toContain('DEPOSIT_39');
    expect(world.untils('IP-D-mobile'), 'profile B’s listing names its own last visit').not.toContain('DEPOSIT_42');
    // The judges' join: the set of transactions read names the same cursor.
    expect(world.reads('IP-C-vpn-exit'), 'the transactions read differ with the last visit').toEqual(world.reads('IP-D-mobile'));
    // Everything the provider holds about the two visits, request by request.
    expect(world.view('IP-C-vpn-exit'), 'the provider can tell the two returning profiles apart').toBe(world.view('IP-D-mobile'));
    // Not an empty equality: something was listed and something was read.
    expect(world.untils('IP-C-vpn-exit').length).toBeGreaterThan(0);
    expect(world.reads('IP-C-vpn-exit').length).toBeGreaterThan(0);

    // And the walk still does its job.
    expect(mapA.size).toBe(47);
    expect(mapB.size).toBe(47);
    expect(mapA.get('5046')?.leafIndex).toBe(46);
  });

  it('the world replays: the same profiles on the same chain leave the same provider log', async () => {
    const one = await twoProfilesTwoVisits(true);
    const two = await twoProfilesTwoVisits(true);
    expect(JSON.stringify(two.world.log)).toBe(JSON.stringify(one.world.log));
  });

  it('the anchor is a leaf whose index is a multiple of the window, one whole window behind the pool', async () => {
    const world = new World();
    const p = profile(true);
    world.deposit(40);
    const first = await openSession(p, world, 'IP-1');
    expect(first.windowLeaves, 'the exported window is not the one this test was written for').toBe(N);
    await first.walk();
    world.deposit(7); // 47 leaves: the top is leaf 46, its window starts at 32, the anchor is 16.
    await (await openSession(p, world, 'IP-2')).walk();
    expect(world.untils('IP-2')).toEqual(['DEPOSIT_16']);
    // Everything above the anchor is read, held or not: 30 deposits and the 10 spends between them.
    const above = world.chain.slice(0, world.chain.findIndex((t) => t.signature === 'DEPOSIT_16')).map((t) => t.signature);
    expect(world.reads('IP-2')).toEqual(above);
  });

  it('a profile that stayed away longer than the window shows a multiple-of-N leaf, nothing finer', async () => {
    const world = new World();
    const stale = profile(true);
    world.deposit(21);
    await (await openSession(stale, world, 'IP-S1')).walk();
    world.deposit(60); // 81 leaves: the public anchor is leaf 64, which this profile never saw.
    const map = await (await openSession(stale, world, 'IP-S2')).walk();
    expect(world.untils('IP-S2')).toEqual(['DEPOSIT_16']);
    expect(world.untils('IP-S2')).not.toContain('DEPOSIT_20');
    expect(map.size).toBe(81);

    // Two stale profiles of the same window are one bucket.
    const world2 = new World();
    const s1 = profile(true);
    const s2 = profile(true);
    world2.deposit(18);
    await (await openSession(s1, world2, 'IP-X1')).walk();
    world2.deposit(9);
    await (await openSession(s2, world2, 'IP-Y1')).walk();
    world2.deposit(60);
    await (await openSession(s1, world2, 'IP-X2')).walk();
    await (await openSession(s2, world2, 'IP-Y2')).walk();
    expect(world2.view('IP-X2')).toBe(world2.view('IP-Y2'));
  });

  it('a session reads a transaction once: the second walk of the same page load reads only what is new', async () => {
    const world = new World();
    const p = profile(true);
    world.deposit(40);
    await (await openSession(p, world, 'IP-1')).walk();
    world.deposit(7);
    const s = await openSession(p, world, 'IP-2');
    await s.walk();
    const before = world.reads('IP-2').length;
    // Bounded: at most two windows of leaves and the spends between them.
    expect(before).toBeLessThanOrEqual(2 * N + Math.ceil((2 * N) / 3) + 1);
    await s.walk();
    expect(world.reads('IP-2').length, 'a walk of the same session re-read what it had just read').toBe(before);
    world.deposit(1); // leaf 47, and the spend the world files after every third leaf
    await s.walk();
    expect(world.reads('IP-2').slice(before)).toEqual(['SPEND_AFTER_47', 'DEPOSIT_47']);
  });

  it('a failed re-read of a leaf already held costs nothing: the map stays whole and nothing is queued', async () => {
    const world = new World();
    const p = profile(true);
    world.deposit(40);
    await (await openSession(p, world, 'IP-1')).walk();
    world.deposit(7);
    world.unreadable.add('DEPOSIT_30');
    let unread = -1;
    const map = await (await openSession(p, world, 'IP-2')).walk((r) => { unread = r.unread; });
    expect(world.reads('IP-2'), 'the held leaf was not asked for, so this case proves nothing').toContain('DEPOSIT_30');
    expect(map.size).toBe(47);
    expect(map.get('5030')?.leafIndex).toBe(30);
    expect(unread).toBe(0);
    const row = [...p.rows.values()][0] as unknown as { retry: unknown[]; complete: boolean };
    expect(row.retry).toEqual([]);
    expect(row.complete).toBe(true);
  });
});

describe('[SWEEP-R1-NETWORK] the store a browser gets declares itself a device’s row', () => {
  it('the IndexedDB store is `perDevice`; the memory store and a plain literal are not', async () => {
    vi.resetModules();
    const cache = await import('./poolHistoryCache');
    const idb = { open: () => ({}) } as unknown as IDBFactory;
    expect((cache.indexedDbPoolHistoryStore(idb) as { perDevice?: boolean }).perDevice).toBe(true);
    expect((cache.memoryPoolHistoryStore() as { perDevice?: boolean }).perDevice).toBeUndefined();
  });
});
