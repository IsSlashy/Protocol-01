/**
 * Who funded the address that paid for a deposit.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THIS IS THE MOST DANGEROUS FUNCTION TO GET WRONG. Its answer is compared
 * against the buyer's wallet to decide "did you deposit this note yourself".
 * A `null` fails CLOSED — the subscription is refused and nobody is exposed. A
 * confident WRONG address fails OPEN: the comparison measures an unrelated key,
 * a genuinely self-deposited note is accepted, and the linkage the whole product
 * exists to prevent is published on chain where it cannot be withdrawn. The user
 * sees a success either way.
 *
 * So the cases below pin both directions: it must find the real source, and it
 * must return null rather than name the wrong one.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveFunderOfPayer } from '@/lib/privacy/worker/poolHandlers';
import type { Connection } from '@solana/web3.js';

const PAYER = '8Eq1jsbB6HxjF6ucupbHKik6nqTaL2u4mkKw3BnTfooe';
const WALLET = 'BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN';
const RELAYER = 'H8WtBx3QapMCGQUFp68rufr3n9jmLuZmQYjYzBn3dyh7';
const SOME_BUFFER = 'EtDx5gTweibuJGSsDNBHeXmUYqf2bZPNMnDisGsZHAkk';

const SOL = 1_000_000_000;
const FEE = 5_000;

/** One transaction, described by what each account's balance did. */
function tx(deltas: Array<[string, number]>) {
  return {
    meta: {
      preBalances: deltas.map(() => 10 * SOL),
      postBalances: deltas.map(([, d]) => 10 * SOL + d),
    },
    transaction: {
      message: { accountKeys: deltas.map(([pubkey]) => ({ pubkey: { toBase58: () => pubkey } })) },
    },
  };
}

/**
 * A chain that answers with `signatures` newest-first, exactly as
 * `getSignaturesForAddress` does, and maps each to a transaction.
 */
function fakeConn(signatures: string[], byTx: Record<string, unknown>) {
  return {
    getSignaturesForAddress: vi.fn(async () => signatures.map((signature) => ({ signature, err: null }))),
    getParsedTransaction: vi.fn(async (s: string) => byTx[s] ?? null),
  } as unknown as Connection;
}

describe('resolveFunderOfPayer', () => {
  it('finds the funding transfer at the START of a long-lived payer', async () => {
    // 🚨 THE REGRESSION THIS FILE EXISTS FOR. The old code fetched `limit: 50`
    // and reversed THAT PAGE, so on a payer with ~150 signatures it examined
    // uploads from the middle of its life — where the payer only pays fees —
    // and returned null every time. Every note this client deposits has a payer
    // shaped exactly like this one.
    const uploads = Array.from({ length: 150 }, (_, i) => `upload${i}`);
    // Chronologically: funded first, then 150 uploads. The RPC answers
    // newest-first, so the funding transfer is the LAST entry — 151 deep, which
    // is what a 50-signature page could never reach.
    const signatures = [...[...uploads].reverse(), 'funding'];
    const byTx: Record<string, unknown> = {
      funding: tx([[WALLET, -(2 * SOL) - FEE], [PAYER, 2 * SOL]]),
    };
    for (const u of uploads) byTx[u] = tx([[PAYER, -FEE], [SOME_BUFFER, 0]]);

    expect(await resolveFunderOfPayer(fakeConn(signatures, byTx), PAYER)).toBe(WALLET);
  });

  it('names the SOURCE OF VALUE, not the fee payer', async () => {
    // ⛔ The old rule returned the first account with a negative delta.
    // `accountKeys[0]` is the fee payer and always has one, so it returned the
    // fee payer every time — correct only because every funding transfer this
    // repo writes happens to have feePayer == source. Here a relayer pays the
    // fee while the wallet provides the SOL, and the two answers differ.
    const byTx = {
      funding: tx([
        [RELAYER, -FEE], // fee payer, loses only the fee
        [WALLET, -(2 * SOL)], // the actual source
        [PAYER, 2 * SOL],
      ]),
    };
    expect(await resolveFunderOfPayer(fakeConn(['funding'], byTx), PAYER)).toBe(WALLET);
  });

  it('returns null rather than name an account whose loss does not match', async () => {
    // Nothing in this transaction lost what the payer gained, so the source is
    // somewhere this walk cannot see. Null blocks the subscription; a guess
    // would let a self-deposited note through with a wrong comparison.
    const byTx = {
      funding: tx([
        [RELAYER, -FEE],
        [SOME_BUFFER, -(SOL / 100)],
        [PAYER, 2 * SOL],
      ]),
    };
    expect(await resolveFunderOfPayer(fakeConn(['funding'], byTx), PAYER)).toBeNull();
  });

  it('tolerates the fee the source also paid', async () => {
    // The source is usually the fee payer too, so it loses gain + fee. That is
    // still the source; the tolerance exists for exactly this.
    const byTx = { funding: tx([[WALLET, -(2 * SOL) - FEE], [PAYER, 2 * SOL]]) };
    expect(await resolveFunderOfPayer(fakeConn(['funding'], byTx), PAYER)).toBe(WALLET);
  });

  it('returns null for an address with no history', async () => {
    expect(await resolveFunderOfPayer(fakeConn([], {}), PAYER)).toBeNull();
  });

  it('returns null when the chain call throws, never a guess', async () => {
    const conn = {
      getSignaturesForAddress: vi.fn(async () => {
        throw new Error('429 rate limited');
      }),
      getParsedTransaction: vi.fn(),
    } as unknown as Connection;
    expect(await resolveFunderOfPayer(conn, PAYER)).toBeNull();
  });

  it('skips transactions where the payer only spent', async () => {
    const byTx = {
      spend: tx([[PAYER, -FEE], [SOME_BUFFER, 0]]),
      funding: tx([[WALLET, -(2 * SOL)], [PAYER, 2 * SOL]]),
    };
    // Newest first: the spend is newer, the funding is the oldest entry.
    expect(await resolveFunderOfPayer(fakeConn(['spend', 'funding'], byTx), PAYER)).toBe(WALLET);
  });
});
