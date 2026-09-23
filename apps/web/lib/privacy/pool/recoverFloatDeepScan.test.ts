/**
 * A crashed deposit's float must stay reachable from the default Recover,
 * however far the tree has moved on since (audit v1, round 4, client P1).
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/recoverFloatDeepScan.test.ts
 *
 * THE FLAW. A deposit or a contribution derives its funded ephemeral E(N) from
 * the leaf index N it was prepared for (`shieldEphemeral.ts`, prepareShield and
 * prepareContribution). A run that dies after E(N) is funded and before the
 * insert lands leaves ~1 SOL (plus a proof buffer) on E(N), and the tree moves
 * on without this user: other deposits, and the restock job alone (up to three
 * leaves per four-hour run). Recover used to re-derive shield keys for the head
 * and the 12 leaves below it only, and no caller passes a wider window. From
 * the 13th foreign leaf on, E(N) was never read again, Recover returned
 * nothing, and the panel said "Nothing stranded in any pool".
 *
 * WHAT IS PINNED HERE:
 *   1. The default Recover reaches E(N) at any distance below the head: it
 *      closes E(N)'s buffer and sweeps E(N)'s balance home.
 *   2. The scan below the head window asks about ONE address per request. The
 *      fake connection has no `getMultipleAccountsInfo`, so a batch would throw
 *      (the house rule in `PoolPanel.tsx`, `refreshPayouts`: per-leaf keys are
 *      never named together in one record).
 *   3. The scan does not depend on anything the user holds: every shield key
 *      from the head down to leaf 0 is read, whichever of them is stranded.
 *   4. An explicit `lookback` still bounds the scan (the destination tests use
 *      it to isolate one key).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';

const head = vi.hoisted(() => ({ value: 0 }));
const closed = vi.hoisted(() => ({ list: [] as string[] }));
const swept = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock('./shieldEphemeral', async (orig) => ({
  ...(await orig<typeof import('./shieldEphemeral')>()),
  readTreeLeafCount: vi.fn(async () => head.value),
}));
vi.mock('./stark', async (orig) => ({
  ...(await orig<typeof import('./stark')>()),
  closeStarkProofBuffer: vi.fn(async (address: PublicKey) => {
    closed.list.push(address.toBase58());
    return 'CLOSESIG';
  }),
}));
vi.mock('./sendTx', () => ({
  sendWithFreshBlockhash: vi.fn(async (_c: unknown, _tx: unknown, _s: unknown, payer: PublicKey) => {
    swept.list.push(payer.toBase58());
    return { signature: 'SWEEPSIG', blockhash: 'x', lastValidBlockHeight: 1 };
  }),
}));

import { recoverStuckFloat } from './recoverFloat';
import { deriveShieldEphemeral } from './shieldEphemeral';
import { deriveProofBufferKeypair } from './stark';
import { CIRCUIT_MERKLE_UPDATE, findPoolV3 } from './denominatedPool';

const pool = findPoolV3('SOL', 1)!;
const seed = new Uint8Array(32).fill(7);
const owner = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
const STRANDED_LAMPORTS = 1_020_000_000;
const SWEEP_FEE = 5_000;

interface World {
  conn: Connection;
  /** Every address read, in order, one entry per request. */
  reads: string[];
  balanceReads: string[];
}

/** E(stranded) holds ~1 SOL and a live circuit-6 buffer; every other key is empty. */
function world(strandedLeaf: number): World {
  const stranded = deriveShieldEphemeral(seed, pool.poolPDA, strandedLeaf).publicKey;
  const buffer = deriveProofBufferKeypair(stranded, CIRCUIT_MERKLE_UPDATE).publicKey;
  const reads: string[] = [];
  const balanceReads: string[] = [];
  const conn = {
    getAccountInfo: async (a: PublicKey) => {
      reads.push(a.toBase58());
      return a.equals(buffer) && !closed.list.includes(buffer.toBase58())
        ? { lamports: 400_000_000, data: Buffer.alloc(8), owner: PublicKey.default, executable: false }
        : null;
    },
    getBalance: async (a: PublicKey) => {
      reads.push(a.toBase58());
      balanceReads.push(a.toBase58());
      return a.equals(stranded) && swept.list.length === 0 ? STRANDED_LAMPORTS : 0;
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    // Deliberately no getMultipleAccountsInfo / getMultipleAccounts.
  } as unknown as Connection;
  return { conn, reads, balanceReads };
}

beforeEach(() => {
  closed.list.length = 0;
  swept.list.length = 0;
});

const N = 500;

describe('the default Recover reaches a crashed deposit at any distance below the head', () => {
  for (const advanced of [0, 12, 13, 40, 300]) {
    it(`E(N) is closed and swept home with the head at N + ${advanced}`, async () => {
      head.value = N + advanced;
      const { conn } = world(N);
      const out = await recoverStuckFloat(conn, pool, seed, owner, {});
      const stranded = deriveShieldEphemeral(seed, pool.poolPDA, N).publicKey.toBase58();
      const hit = out.filter((f) => f.ephemeral === stranded);
      expect(hit, `head = N + ${advanced}: the stranded key was not recovered`).toHaveLength(1);
      expect(hit[0]!.kind).toBe('shield');
      expect(hit[0]!.leafIndex).toBe(N);
      expect(hit[0]!.lamports).toBe(STRANDED_LAMPORTS - SWEEP_FEE);
      expect(hit[0]!.closedBuffers).toBe(1);
      expect(hit[0]!.destination).toBe(owner.toBase58());
      // Nothing else is reported: no empty key turns into a row.
      expect(out).toHaveLength(1);
    });
  }

  it('a deposit stranded at leaf 0 is reached with the head far above it', async () => {
    head.value = 250;
    const { conn } = world(0);
    const out = await recoverStuckFloat(conn, pool, seed, owner, {});
    expect(out.map((f) => f.leafIndex)).toEqual([0]);
    expect(out[0]!.lamports).toBe(STRANDED_LAMPORTS - SWEEP_FEE);
  });
});

describe('the scan below the head window', () => {
  it('reads every shield key from the head down to leaf 0, one address per request', async () => {
    head.value = 120;
    const { conn, balanceReads } = world(N); // nothing stranded under this head
    const out = await recoverStuckFloat(conn, pool, seed, owner, {});
    expect(out).toEqual([]);
    const expected = new Set<string>();
    for (let i = 0; i <= 120; i++) expected.add(deriveShieldEphemeral(seed, pool.poolPDA, i).publicKey.toBase58());
    expect(new Set(balanceReads)).toEqual(expected);
    // One request per key: each shield key is asked about exactly once.
    expect(balanceReads).toHaveLength(expected.size);
  });

  it('asks the same questions whichever leaf is stranded, up to the stranded key itself', async () => {
    head.value = 90;
    const a = world(10);
    await recoverStuckFloat(a.conn, pool, seed, owner, {});
    closed.list.length = 0;
    swept.list.length = 0;
    const b = world(60);
    await recoverStuckFloat(b.conn, pool, seed, owner, {});
    // The balance scan itself names the same keys in both worlds.
    expect(new Set(a.balanceReads)).toEqual(new Set(b.balanceReads));
  });

  it('an explicit lookback still bounds the scan to the head window', async () => {
    head.value = N + 13;
    const { conn, balanceReads } = world(N);
    const out = await recoverStuckFloat(conn, pool, seed, owner, { lookback: 12 });
    expect(out).toEqual([]);
    expect(balanceReads).toHaveLength(13);
  });
});
