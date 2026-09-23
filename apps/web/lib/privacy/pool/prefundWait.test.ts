/**
 * [flow-speed X2 2026-09-23] A SHORT PRE-FUND BALANCE IS READ AGAIN BEFORE IT IS
 * BELIEVED, on every web copy of the check that is not the shield's.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * The funder route answers only once ITS node saw the float -> E grant at
 * 'confirmed' (`app/api/fund-ephemeral/route.ts`). The worker then reads E's
 * balance through the browser's endpoint, a load-balanced provider whose node
 * can lag the route's by a few hundred ms. One lagging read used to throw the
 * whole prepare (walks, proof) and the grant away: the `finally` swept the grant
 * back, the job was dropped, and the next click did everything again and drew
 * the lamport budget a second time.
 *
 * What stays exactly as it was, and is pinned here:
 *   - the bar: `funded < ctx.requiredLamports`, at 'confirmed', same error text;
 *   - a funded E is read ONCE and no timer is scheduled (the happy path);
 *   - an RPC error is not retried (the paced transport already retries);
 *   - the check sits inside the `try`, so a grant that lands late is swept to
 *     whoever paid, never to the wallet.
 * The shield's copy (`shieldEphemeral.ts`) belongs to another run; its re-read
 * is pinned by `shieldExecuteFunded.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';

vi.mock('./denominatedPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./denominatedPool')>()),
  unshieldDenominatedStarkV3: vi.fn(),
  unshieldDenominatedStarkV4: vi.fn(),
}));
vi.mock('./subscribePrivateStark', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./subscribePrivateStark')>()),
  subscribePrivateStark: vi.fn(),
}));
vi.mock('./subscribePrivateStarkV4', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./subscribePrivateStarkV4')>()),
  subscribePrivateStarkV4: vi.fn(),
}));

import { unshieldDenominatedStarkV3, unshieldDenominatedStarkV4 } from './denominatedPool';
import { subscribePrivateStark } from './subscribePrivateStark';
import { subscribePrivateStarkV4 } from './subscribePrivateStarkV4';
import { executeUnshield, executeUnshieldV4 } from './unshieldEphemeral';
import { executeSubscribe, executeSubscribeV4 } from './subscribeEphemeral';

const OWNER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
const FUNDER = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
const PAYOUT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const VAULT = new PublicKey('SysvarRent111111111111111111111111111111111');
const BLOCKHASH = SystemProgram.programId.toBase58();
const REQUIRED = 600_000_000;
const SWEEP_FEE = 5_000;

let ephemeral: Keypair;
let sent: Buffer[];

/**
 * `balances` is what each successive `getBalance` answers (the last one repeats);
 * an Error in it is thrown instead. `delayMs` makes every read slow, the way a
 * pacer busy with the page-load scan makes it.
 */
function fakeConnection(balances: Array<number | Error>, delayMs = 0) {
  const reads: string[] = [];
  let i = 0;
  const conn = {
    getBalance: async (_pk: PublicKey, commitment?: string) => {
      reads.push(String(commitment));
      const v = balances[Math.min(i, balances.length - 1)]!;
      i += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (v instanceof Error) throw v;
      return v;
    },
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    sendRawTransaction: async (raw: Buffer) => {
      sent.push(raw);
      return 'SWEEPSIG';
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
  return { conn, reads };
}

function sweepTarget(): string {
  expect(sent).toHaveLength(1);
  const ix = Transaction.from(sent[0]!).instructions[0]!;
  return ix.keys[1]!.pubkey.toBase58();
}

/** Drive fake time until `p` settles, then return its outcome. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let done = false;
  const outcome = p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void outcome.then(() => {
    done = true;
  });
  for (let n = 0; !done && n < 500; n++) await vi.advanceTimersByTimeAsync(50);
  return outcome;
}

type Flow = {
  name: string;
  run: (conn: Connection) => Promise<unknown>;
  spend: () => ReturnType<typeof vi.fn>;
  text: RegExp;
};

const FLOWS: Flow[] = [
  {
    name: 'withdrawal v4 (executeUnshieldV4)',
    run: (conn) =>
      executeUnshieldV4(
        { ephemeral, requiredLamports: REQUIRED, poolConfig: {}, prepared: {}, recipient: PAYOUT } as never,
        conn,
        OWNER,
        undefined,
        FUNDER,
      ),
    spend: () => vi.mocked(unshieldDenominatedStarkV4),
    text: /^The withdrawal signer is underfunded \(\d+ of 600000000 lamports\)\. The pre-fund transaction may not have confirmed yet — retry in a moment\.$/,
  },
  {
    name: 'withdrawal v3 (executeUnshield)',
    run: (conn) =>
      executeUnshield(
        { ephemeral, requiredLamports: REQUIRED, poolConfig: {}, prepared: {}, receipt: {} } as never,
        conn,
        PAYOUT,
        OWNER,
        undefined,
        FUNDER,
      ),
    spend: () => vi.mocked(unshieldDenominatedStarkV3),
    text: /^The withdrawal signer is underfunded \(\d+ of 600000000 lamports\)\. The pre-fund transaction may not have confirmed yet — retry in a moment\.$/,
  },
  {
    name: 'subscription v4 (executeSubscribeV4)',
    run: (conn) =>
      executeSubscribeV4(
        {
          ephemeral,
          requiredLamports: REQUIRED,
          poolConfig: {},
          prepared: {},
          receipt: {},
          binding: { vault: VAULT, rate: 1n, intervalSlots: 1n, vkHashSubscriber: new Uint8Array(32) },
          retailer: PAYOUT,
          subscriberCommitment: 1n,
        } as never,
        conn,
        { ownerPubkey: OWNER, sweepTo: FUNDER },
      ),
    spend: () => vi.mocked(subscribePrivateStarkV4),
    text: /^The subscription signer is underfunded \(\d+ of 600000000 lamports\)\. The pre-fund transaction may not have confirmed yet — retry in a moment\.$/,
  },
  {
    name: 'subscription v3 (executeSubscribe)',
    run: (conn) =>
      executeSubscribe(
        { ephemeral, requiredLamports: REQUIRED, poolConfig: {}, prepared: {}, receipt: {} } as never,
        conn,
        {
          ownerPubkey: OWNER,
          sweepTo: FUNDER,
          retailer: PAYOUT,
          rate: 1n,
          intervalSlots: 1n,
          subscriberCommitment: 1n,
          vkHashSubscriber: new Uint8Array(32),
        } as never,
      ),
    spend: () => vi.mocked(subscribePrivateStark),
    text: /^The subscription signer is underfunded \(\d+ of 600000000 lamports\)\. The pre-fund transaction may not have confirmed yet — retry in a moment\.$/,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sent = [];
  ephemeral = Keypair.generate();
  vi.mocked(unshieldDenominatedStarkV3).mockResolvedValue('TX3');
  vi.mocked(unshieldDenominatedStarkV4).mockResolvedValue('TX4');
  vi.mocked(subscribePrivateStark).mockResolvedValue({ txSig: 'S3', vaultPDA: VAULT });
  vi.mocked(subscribePrivateStarkV4).mockResolvedValue({ txSig: 'S4', vaultPDA: VAULT });
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(FLOWS)('[X2] $name reads a short pre-fund again before believing it', (flow) => {
  it('T1: 0, 0, then funded -> the spend runs once, and only the residue is swept', async () => {
    // RED at HEAD: the first 0 threw "underfunded" and the spend never ran.
    const { conn, reads } = fakeConnection([0, 0, REQUIRED, REQUIRED]);
    const out = await settle(flow.run(conn));
    expect(out.ok, out.ok ? '' : String((out as { error: unknown }).error)).toBe(true);
    expect(flow.spend()).toHaveBeenCalledTimes(1);
    // Three reads before the spend, one in the `finally`, all at 'confirmed'.
    expect(reads).toEqual(['confirmed', 'confirmed', 'confirmed', 'confirmed']);
    expect(sweepTarget()).toBe(FUNDER.toBase58());
  });

  it('T2: always 0 -> the unchanged refusal after exactly 5 reads; no spend, no sweep of nothing', async () => {
    const { conn, reads } = fakeConnection([0]);
    const out = await settle(flow.run(conn));
    expect(out.ok).toBe(false);
    expect(((out as { error: Error }).error).message).toMatch(flow.text);
    expect(flow.spend()).not.toHaveBeenCalled();
    // 5 checks, then the `finally` read.
    expect(reads).toHaveLength(6);
    expect(sent).toHaveLength(0);
  });

  it('T3: an RPC error is not retried here, and the finally still runs', async () => {
    const { conn, reads } = fakeConnection([new Error('429 Too Many Requests'), REQUIRED]);
    const out = await settle(flow.run(conn));
    expect(out.ok).toBe(false);
    expect(((out as { error: Error }).error).message).toBe('429 Too Many Requests');
    expect(flow.spend()).not.toHaveBeenCalled();
    // One check (thrown), one `finally` read that sweeps what is there.
    expect(reads).toHaveLength(2);
    expect(sweepTarget()).toBe(FUNDER.toBase58());
  });

  it('T4: funded on the first read -> one read before the spend, and no timer', async () => {
    const { conn, reads } = fakeConnection([REQUIRED]);
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const out = await settle(flow.run(conn));
    expect(out.ok).toBe(true);
    const beforeSpend = flow.spend().mock.invocationCallOrder[0]!;
    expect(beforeSpend).toBeGreaterThan(0);
    expect(reads).toHaveLength(2); // the check and the `finally`
    // No wait was scheduled by the check (sendWithFreshBlockhash schedules none
    // on a first-try send either).
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('T5: the grant lands after the last check -> refused, and the late grant goes back to the float', async () => {
    const { conn, reads } = fakeConnection([0, 0, 0, 0, 0, REQUIRED]);
    const out = await settle(flow.run(conn));
    expect(out.ok).toBe(false);
    expect(((out as { error: Error }).error).message).toMatch(flow.text);
    expect(reads).toHaveLength(6);
    expect(sweepTarget()).toBe(FUNDER.toBase58());
    expect(sweepTarget()).not.toBe(OWNER.toBase58());
  });

  it('T6: slow, pacer-queued reads still get all 5 attempts (a count, not a deadline)', async () => {
    const { conn, reads } = fakeConnection([0, 0, 0, 0, REQUIRED, REQUIRED], 1_000);
    const out = await settle(flow.run(conn));
    expect(out.ok).toBe(true);
    expect(flow.spend()).toHaveBeenCalledTimes(1);
    expect(reads).toHaveLength(6);
  });
});

describe('[X2] one helper, not four inline checks', () => {
  it('T7: no web copy outside the helper reads the balance and throws "underfunded" inline', () => {
    for (const file of ['unshieldEphemeral.ts', 'subscribeEphemeral.ts']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      // The only `signer is underfunded` text left is the message each flow
      // passes to the helper; the inline `if (funded < ctx.requiredLamports)`
      // shape is gone from both files.
      expect(src, file).not.toMatch(/if \(funded < ctx\.requiredLamports\)/);
      expect(src.match(/awaitPrefund\(/g)?.length ?? 0, file).toBeGreaterThanOrEqual(2);
    }
  });
});
