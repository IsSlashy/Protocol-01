/**
 * Who pays for a pool job, and the two refusals that cost nobody anything.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * This decision used to live inline in `subscribeFromPool` and nowhere else,
 * which is exactly why the deposit and withdrawal legs never got it. Now all
 * three call one function, so one function has to be right — and two of its
 * branches are refusals whose whole value is that they fire.
 *
 * The refusals are not conservatism. Each one exists because the alternative
 * loses somebody's money irreversibly, while refusing costs a retry on a key
 * that stays re-derivable from the seed forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';

import {
  DirtyEphemeralError,
  WalletExposureRefusedError,
  fundEphemeralForJob,
} from './ephemeralFunder';

// A real keypair rather than a bare address: the wallet fallback SERIALIZES the
// transaction it just had signed, and serialization rejects a missing
// signature. A stub that returned the transaction untouched would have made
// every wallet-funded case fail for a reason that has nothing to do with the
// decision under test.
const ownerKeypair = Keypair.generate();
const OWNER = ownerKeypair.publicKey;
const FUNDER = 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB';
const BLOCKHASH = SystemProgram.programId.toBase58();

/** A withdrawal's real pre-fund shape: float only, no denomination. */
const FLOAT_ONLY = 1_030_290_360;
/** A 1 SOL deposit's value half, measured on devnet: 1 SOL + 0.3%. */
const DEPOSIT_VALUE = 1_003_475_300;

let ephemeral: string;
let signed: Transaction[] = [];
let fetchCalls: string[] = [];

function fakeConnection(balance = 0): Connection {
  return {
    getBalance: async () => balance,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    sendRawTransaction: async () => 'FUNDSIG',
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
}

const signOne = async (tx: Transaction) => {
  signed.push(tx);
  tx.sign(ownerKeypair);
  return tx;
};

/** Stub the funder endpoint. `ok: false` drives the fallback path. */
function stubFunder(mode: 'ok' | 'refuse' | 'network') {
  vi.stubGlobal('fetch', async (url: string) => {
    fetchCalls.push(String(url));
    if (mode === 'network') throw new Error('network down');
    if (mode === 'refuse') {
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, error: 'too many funding requests from this address' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, signature: 'GRANTSIG', sweepTo: FUNDER, lamports: FLOAT_ONLY }),
    };
  });
}

const job = (over: Record<string, unknown> = {}) =>
  ({
    ephemeralPubkey: ephemeral,
    requiredLamports: FLOAT_ONLY,
    valueLamports: 0,
    owner: OWNER,
    connection: fakeConnection(),
    signOne,
    ...over,
  }) as never;

beforeEach(() => {
  vi.unstubAllGlobals();
  signed = [];
  fetchCalls = [];
  ephemeral = Keypair.generate().publicKey.toBase58();
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
});

describe('a float-only job with a funder available', () => {
  it('is paid by the funder, and the wallet signs NOTHING', () => {
    stubFunder('ok');
    return fundEphemeralForJob(job()).then((d) => {
      expect(d.fundedBy).toBe('funder');
      // The half that is easy to get wrong: paying through a third party and
      // then sweeping home spends someone else's SOL AND still writes the
      // wallet into the ephemeral's newest transaction.
      expect(d.sweepTo).toBe(FUNDER);
      expect(d.sweepTo).not.toBe(OWNER.toBase58());
      expect(d.funderSignature).toBe('GRANTSIG');
      expect(signed).toHaveLength(0);
    });
  });
});

describe('the fallback is loud, not silent', () => {
  it('falls back to the wallet and CARRIES THE REASON when the funder refuses', async () => {
    // A 429, a 409 and an operator switching the funder off all put the wallet
    // back on chain. If the reason is dropped they are indistinguishable, and
    // the user is told nothing about the world they ended up in.
    stubFunder('refuse');
    const d = await fundEphemeralForJob(job());
    expect(d.fundedBy).toBe('wallet');
    expect(d.sweepTo).toBe(OWNER.toBase58());
    expect(d.funderFallbackReason).toMatch(/too many funding requests/);
    expect(signed).toHaveLength(1);
  });

  it('does the same when the funder is unreachable', async () => {
    stubFunder('network');
    const d = await fundEphemeralForJob(job());
    expect(d.fundedBy).toBe('wallet');
    expect(d.funderFallbackReason).toBeTruthy();
  });

  it('pays from the wallet with no reason when no funder is configured', async () => {
    // Not a fallback — there was nothing to fall back from. A reason here would
    // read as a failure on a deployment that simply has no funder.
    vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', '');
    const d = await fundEphemeralForJob(job());
    expect(d.fundedBy).toBe('wallet');
    expect(d.funderFallbackReason).toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('the treasury never buys a note', () => {
  it('refuses to ask the funder when the job carries the user’s own value', async () => {
    // A deposit's pre-fund embeds the denomination plus the 0.3% fee, and
    // 1,003,475,300 of a 1 SOL deposit's 1,573,486,080 never comes back. The
    // funder's 2 SOL per-request cap does NOT catch this: it refuses only pools
    // of 10 SOL and up, so both demo pools sail under it. The refusal has to be
    // structural.
    stubFunder('ok');
    const d = await fundEphemeralForJob(job({ valueLamports: DEPOSIT_VALUE }));
    expect(fetchCalls).toHaveLength(0);
    expect(d.fundedBy).toBe('wallet');
    expect(d.funderFallbackReason).toMatch(/your own value/);
    expect(signed).toHaveLength(1);
  });

  it('asks again as soon as the job is float-only', async () => {
    // The negative control: the guard must key on the VALUE, not on having been
    // tripped once, or a bug that pins valueLamports high would silently
    // disable the funder everywhere and look like "the funder is off".
    stubFunder('ok');
    const d = await fundEphemeralForJob(job({ valueLamports: 0 }));
    expect(d.fundedBy).toBe('funder');
  });
});

describe('neverExposeWallet — the last way the buyer lands on chain', () => {
  // Once the notes are deposited by someone else and the funder pays, the ONLY
  // remaining route from a subscription to its buyer is this fallback. Every
  // reason the funder does not serve arrives as one catch, and the fallback
  // then SUCCEEDS: the subscription exists, nothing errors, and the wallet is
  // accountKeys[0] of a public transfer bracketing the whole operation. The
  // buyer cannot detect it afterwards and cannot undo it.

  it('refuses instead of falling back when the funder cannot serve', async () => {
    stubFunder('refuse');
    await expect(
      fundEphemeralForJob(job({ neverExposeWallet: true })),
    ).rejects.toBeInstanceOf(WalletExposureRefusedError);
    // Nothing was spent and nothing is stranded: the refusal happens before any
    // lamport moves and before the wallet is even asked to sign.
    expect(signed).toHaveLength(0);
  });

  it('carries the funder’s own reason, so the user can act on it', async () => {
    // "It failed" is not actionable. A 429, a rotated ticket and a drained
    // treasury need three different responses.
    stubFunder('refuse');
    await expect(
      fundEphemeralForJob(job({ neverExposeWallet: true })),
    ).rejects.toThrow(/too many funding requests/);
  });

  it('refuses when NO funder is configured at all', async () => {
    // The case the guard would miss if it only wrapped the catch: the funder was
    // never asked, so there is no failure to catch, and the wallet pays. To a
    // user who ticked the box that is the same betrayal by a different route.
    vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', '');
    await expect(
      fundEphemeralForJob(job({ neverExposeWallet: true })),
    ).rejects.toBeInstanceOf(WalletExposureRefusedError);
    expect(signed).toHaveLength(0);
  });

  it('refuses a value-bearing job, which the funder may never cover', async () => {
    // A deposit can never be funder-paid, so under this flag it can never run.
    // Refusing is right: the alternative is charging the wallet in public for
    // the one operation that is guaranteed to name it.
    stubFunder('ok');
    await expect(
      fundEphemeralForJob(job({ neverExposeWallet: true, valueLamports: DEPOSIT_VALUE })),
    ).rejects.toBeInstanceOf(WalletExposureRefusedError);
    expect(fetchCalls).toHaveLength(0);
  });

  it('changes NOTHING when the funder does serve', async () => {
    // The negative control. A flag that also altered the happy path would be
    // changing behaviour it was not asked to change.
    stubFunder('ok');
    const d = await fundEphemeralForJob(job({ neverExposeWallet: true }));
    expect(d.fundedBy).toBe('funder');
    expect(d.sweepTo).toBe(FUNDER);
    expect(signed).toHaveLength(0);
  });

  it('still falls back when the flag is OFF', async () => {
    // The other negative control: a deployment with no funder must keep working
    // for users who did not ask for this.
    stubFunder('refuse');
    const d = await fundEphemeralForJob(job({ neverExposeWallet: false }));
    expect(d.fundedBy).toBe('wallet');
    expect(signed).toHaveLength(1);
  });

  it('protects the STALE BUNDLE case, where the build-time ticket is absent', async () => {
    // 🚨 THE ROUTE THAT DISARMED THE FIRST VERSION OF THIS GUARD.
    //
    // `NEXT_PUBLIC_P01_FUNDER_TICKET` is inlined at BUILD time. A deployment
    // that switched its funder on without rebuilding serves a bundle where it
    // is absent — so the panel used to seed the guard from it, render no
    // checkbox, default the flag to FALSE, and let the wallet pay. The
    // protection stood itself down in precisely the situation it was written
    // for, silently, while the server's readiness check said ready.
    //
    // The guard must therefore hold on the ticket's ABSENCE, not on its
    // presence. Same environment as a stale bundle, flag on: refuse.
    vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', '');
    await expect(
      fundEphemeralForJob(job({ neverExposeWallet: true })),
    ).rejects.toBeInstanceOf(WalletExposureRefusedError);
    expect(signed).toHaveLength(0);
  });
});

describe('an ephemeral that already holds money', () => {
  it('refuses BOTH paths rather than mixing two parties on one key', async () => {
    // E is deterministic in (seed, pool, leafIndex), so a retry lands on the
    // SAME key an earlier attempt stranded money on. The route 409s a non-empty
    // target, and the old code caught that and fell back to the wallet — so a
    // wallet pre-fund landed on top of a stranded treasury grant, and the
    // single-destination sweep handed the whole pile to one party.
    //
    // There is no correct split: every sweep must land a 0-data account on
    // exactly zero, so two destinations means two fees and a residue that fails
    // silently. Refusing is the only outcome where nobody loses.
    stubFunder('ok');
    await expect(
      fundEphemeralForJob(job({ connection: fakeConnection(500_000) })),
    ).rejects.toBeInstanceOf(DirtyEphemeralError);
    expect(fetchCalls).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  it('points the user at Recover, which is the actual cure', async () => {
    stubFunder('ok');
    await expect(
      fundEphemeralForJob(job({ connection: fakeConnection(500_000) })),
    ).rejects.toThrow(/Recover/);
  });
});
