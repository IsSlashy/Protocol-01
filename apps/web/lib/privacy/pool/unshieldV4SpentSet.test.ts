/**
 * [flow-speed W1 2026-09-23] The circuit-7 withdrawal job asks the spent set it
 * is HANDED, and reads one itself only when it is handed none.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * `locateOwnedNote` reads the pool-wide spent set (one `getProgramAccounts`)
 * and the job used to read the identical set again a few hundred ms later, in
 * the same request. The handler now passes the first one down
 * (`poolHandlersUnshieldV4.test.ts`, "[W1] hands the circuit-7 withdrawal job
 * the SAME spent set locateOwnedNote read"). What must not move:
 *   - the local refusal and its words ("already been withdrawn");
 *   - a caller that passes NO set (the harness, other callers) still gets a
 *     read, never an empty default that would skip the check;
 *   - never a pointed read of the note's nullifier PDA (`noPointedNullifierRead.test.ts`).
 * The prepare after the check is replaced by a sentinel so each case stops
 * right past the spent check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';

vi.mock('./denominatedPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./denominatedPool')>()),
  prepareUnshieldV4: vi.fn(async () => {
    throw new Error('STOP: past the spent check');
  }),
}));

import {
  createNullifierV3,
  deriveNullifierPDA,
  findPoolV3,
  goldilocksU64To32,
  type ShieldReceipt,
} from './denominatedPool';
import { prepareUnshieldJobV4 } from './unshieldEphemeral';

const POOL = findPoolV3('SOL', 0.1)!;
const RECIPIENT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const OWNER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
const SECRET = 918273645546372819n;
const NULLIFIER_PREIMAGE = 192837465564738291n;
const RECEIPT = {
  secret: SECRET,
  nullifierPreimage: NULLIFIER_PREIMAGE,
  noteBlinding: 7_284_991_002_338_477_113n,
  leafIndex: 5,
} as unknown as ShieldReceipt;
const NULLIFIER_PDA = deriveNullifierPDA(
  POOL.poolPDA,
  goldilocksU64To32(createNullifierV3(NULLIFIER_PREIMAGE, SECRET)),
)[0];

let gpa = 0;
let pointed: string[] = [];

/** `answer` is what getProgramAccounts returns; an Error is thrown instead. */
function conn(answer: Array<{ pubkey: PublicKey }> | Error): Connection {
  return {
    getProgramAccounts: async () => {
      gpa += 1;
      if (answer instanceof Error) throw answer;
      return answer.map((a) => ({ ...a, account: {} }));
    },
    getAccountInfo: async (pk: PublicKey) => {
      pointed.push(pk.toBase58());
      return null;
    },
  } as unknown as Connection;
}

const SEED = new Uint8Array(32).fill(3);

beforeEach(() => {
  gpa = 0;
  pointed = [];
});

describe('[W1] the circuit-7 withdrawal job and the spent set', () => {
  it('T3: a handed set that holds the note refuses it, with no read of its own', async () => {
    await expect(
      prepareUnshieldJobV4(
        RECEIPT, RECIPIENT, OWNER, POOL, conn(new Error('getProgramAccounts must not be sent')), SEED,
        undefined, {}, new Set([NULLIFIER_PDA.toBase58()]),
      ),
    ).rejects.toThrow(/^This note has already been withdrawn\.$/);
    expect(gpa).toBe(0);
    expect(pointed).toEqual([]);
  });

  it('T4: a handed set without the note gets past the check with zero reads', async () => {
    await expect(
      prepareUnshieldJobV4(
        RECEIPT, RECIPIENT, OWNER, POOL, conn(new Error('getProgramAccounts must not be sent')), SEED,
        undefined, {}, new Set<string>(),
      ),
    ).rejects.toThrow(/STOP: past the spent check/);
    expect(gpa).toBe(0);
  });

  it('T5: no set handed -> exactly one pool-wide read, and a spent note is still refused', async () => {
    await expect(
      prepareUnshieldJobV4(RECEIPT, RECIPIENT, OWNER, POOL, conn([{ pubkey: NULLIFIER_PDA }]), SEED),
    ).rejects.toThrow(/^This note has already been withdrawn\.$/);
    expect(gpa).toBe(1);
    expect(pointed, 'a pointed nullifier read').toEqual([]);
  });

  it('T5b: no set handed and the note unspent -> one read, then the prepare', async () => {
    await expect(
      prepareUnshieldJobV4(RECEIPT, RECIPIENT, OWNER, POOL, conn([]), SEED),
    ).rejects.toThrow(/STOP: past the spent check/);
    expect(gpa).toBe(1);
  });

  it('the handed set never reaches the prepare options (nothing serialisable carries it)', async () => {
    const { prepareUnshieldV4 } = await import('./denominatedPool');
    vi.mocked(prepareUnshieldV4).mockClear();
    const opts = { unread: 0 };
    await expect(
      prepareUnshieldJobV4(RECEIPT, RECIPIENT, OWNER, POOL, conn([]), SEED, undefined, opts, new Set<string>()),
    ).rejects.toThrow(/STOP/);
    const forwarded = vi.mocked(prepareUnshieldV4).mock.calls[0]![5] as Record<string, unknown>;
    expect(Object.values(forwarded).some((v) => v instanceof Set)).toBe(false);
  });
});
