/**
 * close-v1 lane L1 · a stranger's transaction is not an operator edge.
 *
 * Run: cd apps/web && npx vitest run __tests__/api/closeV1L1CoNaming.test.ts
 *
 * F61 (audit v1, round 3, server axis). `/api/relay-to-buyer` GET reports
 * `ready: false` when the fee sink and the float share ANY transaction, and
 * the client refuses to pay a relay that is not ready. Any stranger can list
 * both addresses in one transaction of their own (two 1-lamport transfers,
 * one signature, about 5,000 lamports), so one such transaction switched off
 * every relayed deposit and every contribution. Audit probe:
 * `r3-server/p1/probe-sink-float-grief.mts`.
 *
 * The invariant the check exists for is "the sink never FUNDS the float" (and
 * the reverse). A transaction can move lamports out of either only with that
 * address's signature, so the edge that matters is one an operator key signed,
 * or one where lamports left one of the two for the other. A stranger's
 * transaction that merely names both is neither, and is ignored. `null` still
 * means "could not establish" and still does not block.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

interface FakeTx {
  keys: string[];
  signers: number;
  pre: number[];
  post: number[];
}
const histories = new Map<string, string[]>();
const txs = new Map<string, FakeTx | null>();

vi.mock('@/lib/waitlist/store', () => ({
  getStore: () => ({ get: async () => null, incr: async () => 1, expire: async () => {} }),
  rateLimitExceeded: async () => false,
  rateLimitRemaining: async () => 3,
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      async getBalance() {
        return 50_000_000_000;
      }
      async getSignaturesForAddress(k: { toBase58(): string }, o?: { limit?: number }) {
        return (histories.get(k.toBase58()) ?? [])
          .slice(0, o?.limit ?? 1000)
          .map((signature) => ({ signature, err: null, blockTime: 1 }));
      }
      async getTransaction(sig: string) {
        const t = txs.get(sig);
        if (!t) return null;
        return {
          meta: { err: null, preBalances: t.pre, postBalances: t.post },
          transaction: {
            message: {
              header: { numRequiredSignatures: t.signers },
              getAccountKeys: () => ({
                staticAccountKeys: t.keys.map((k) => new actual.PublicKey(k)),
              }),
            },
          },
        };
      }
    },
  };
});

import { GET } from '@/app/api/relay-to-buyer/route';

const float = Keypair.generate();
const FLOAT = float.publicKey.toBase58();
const TILL = Keypair.generate().publicKey.toBase58();
const SINK = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();

function lands(sig: string, tx: FakeTx | null, names: string[]) {
  txs.set(sig, tx);
  for (const a of names) histories.set(a, [sig, ...(histories.get(a) ?? [])]);
}
const readiness = async () =>
  (await GET(new NextRequest('http://localhost/api/relay-to-buyer', { headers: { 'x-real-ip': '203.0.113.9' } }))).json();

beforeEach(() => {
  histories.clear();
  txs.clear();
  vi.unstubAllEnvs();
  vi.stubEnv('P01_FUNDER_SECRET_KEY', bs58.encode(float.secretKey));
  vi.stubEnv('P01_TILL_ADDRESS', TILL);
  vi.stubEnv('P01_FEE_WALLET', SINK);
  vi.stubEnv('P01_FUNDER_TICKET', 'public-ticket');
  vi.stubEnv('P01_FUNDER_RPC', 'http://fake-rpc.invalid');
  // Each address has its own honest history, so neither listing is empty.
  lands('SINK_OWN', { keys: [STRANGER, SINK], signers: 1, pre: [1e10, 0], post: [1e10 - 1e7, 1e7] }, [STRANGER, SINK]);
  lands('FLOAT_OWN', { keys: [FLOAT, STRANGER], signers: 1, pre: [5e10, 0], post: [5e10 - 1e9, 1e9] }, [FLOAT]);
});

describe('F61 · only an operator edge between the fee sink and the float blocks the relay', () => {
  it('control: no shared transaction, ready', async () => {
    const body = await readiness();
    expect(body.sinkFundedFloat).toBe(false);
    expect(body.ready, JSON.stringify(body.reasons)).toBe(true);
  });

  it("a stranger's transaction naming both, signed by nobody but the stranger, does not switch the relay off", async () => {
    // The probe's transaction: one signer, 1 lamport to each of the two.
    lands(
      'GRIEF',
      { keys: [STRANGER, SINK, FLOAT], signers: 1, pre: [1e9, 5, 7], post: [1e9 - 5002, 6, 8] },
      [STRANGER, SINK, FLOAT],
    );
    const body = await readiness();
    expect(body.sinkFundedFloat, JSON.stringify(body)).toBe(false);
    expect(body.ready, JSON.stringify(body.reasons)).toBe(true);
  });

  it('control: the fee sink SIGNING a transfer into the float is still reported, and still blocks', async () => {
    lands(
      'SINK_PAYS_FLOAT',
      { keys: [SINK, FLOAT], signers: 1, pre: [5e9, 5e10], post: [5e9 - 1e9 - 5000, 5e10 + 1e9] },
      [SINK, FLOAT],
    );
    const body = await readiness();
    expect(body.sinkFundedFloat).toBe(true);
    expect(body.ready).toBe(false);
  });

  it('control: the float signing a transfer into the fee sink is reported too', async () => {
    lands(
      'FLOAT_PAYS_SINK',
      { keys: [FLOAT, SINK], signers: 1, pre: [5e10, 5e9], post: [5e10 - 1e6 - 5000, 5e9 + 1e6] },
      [FLOAT, SINK],
    );
    expect((await readiness()).sinkFundedFloat).toBe(true);
  });

  it('a shared transaction that cannot be read is "could not establish", not a violation', async () => {
    lands('UNREADABLE', null, [SINK, FLOAT]);
    const body = await readiness();
    expect(body.sinkFundedFloat).toBeNull();
    expect(body.ready, JSON.stringify(body.reasons)).toBe(true);
  });

  it('a flood of stranger transactions cannot hide an operator edge as "clean"', async () => {
    lands(
      'SINK_PAYS_FLOAT_OLD',
      { keys: [SINK, FLOAT], signers: 1, pre: [5e9, 5e10], post: [5e9 - 1e9 - 5000, 5e10 + 1e9] },
      [SINK, FLOAT],
    );
    for (let i = 0; i < 60; i += 1) {
      lands(
        `GRIEF${i}`,
        { keys: [STRANGER, SINK, FLOAT], signers: 1, pre: [1e9, 5, 7], post: [1e9 - 5002, 6, 8] },
        [STRANGER, SINK, FLOAT],
      );
    }
    // Either the edge is found (true) or the search says it ran out of room
    // (null). What it must never say is `false`.
    expect((await readiness()).sinkFundedFloat).not.toBe(false);
  });
});

describe('F61 · both readings of an operator edge are pinned (close-v1 verify round 1)', () => {
  it('an operator key signing a transaction that names the other counts, even with no transfer between them', async () => {
    // The fee sink pays only the network fee; the float is listed, unmoved.
    lands(
      'SINK_SIGNS',
      { keys: [SINK, FLOAT], signers: 1, pre: [5e9, 5e10], post: [5e9 - 5000, 5e10] },
      [SINK, FLOAT],
    );
    expect((await readiness()).sinkFundedFloat).toBe(true);
  });

  it('lamports moving from the fee sink to the float count, even when neither signed (a program-owned sink)', async () => {
    lands(
      'PROGRAM_MOVES',
      { keys: [STRANGER, SINK, FLOAT], signers: 1, pre: [1e9, 5e9, 5e10], post: [1e9 - 5000, 4e9, 5e10 + 1e9] },
      [STRANGER, SINK, FLOAT],
    );
    expect((await readiness()).sinkFundedFloat).toBe(true);
  });
});
