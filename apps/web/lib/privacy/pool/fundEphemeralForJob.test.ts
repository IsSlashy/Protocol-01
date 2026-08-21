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

/** Commitment the wallet-signed transaction asked its blockhash at. */
let blockhashCommitment: string | undefined;

function fakeConnection(balance = 0): Connection {
  return {
    getBalance: async () => balance,
    getLatestBlockhash: async (c?: string) => {
      blockhashCommitment = c;
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 1 };
    },
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

  it('takes the wallet transaction’s blockhash at FINALIZED, not confirmed', async () => {
    // "Transaction simulation failed: Blockhash not found", empty logs, on a
    // wallet-signed pre-fund. Two nodes are involved: we fetch the blockhash
    // from OUR RPC and the wallet extension simulates with ITS OWN. A
    // `confirmed` blockhash is seconds old and may not have reached the
    // wallet's node — and the gap is not milliseconds, it is however long the
    // human takes to read the popup and press approve.
    //
    // Pinned because the fix is one word and nothing else fails when it is
    // wrong: it works on every machine where both sides happen to share a node,
    // which includes most development.
    stubFunder('refuse');
    await fundEphemeralForJob(job());
    expect(signed).toHaveLength(1);
    expect(blockhashCommitment).toBe('finalized');
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

// ===========================================================================
// PORTE 4 (R != F + the 1% operator fee) and PORTE 2's engine half.
//
// 🚨 EVERY CASE BELOW IS A DEFECT THAT SHIPPED ONCE. The first attempt at this
// exact scope (branch `wip/lots-abc-2026-08-20`) wrote the R != F split into
// four file headers, an env template and a readiness report, and then paid the
// funder anyway on one line. Prose is not a mechanism. These are the
// measurements that would have caught each one.
//
// The relayed deposit is the ONLY leg where the buyer signs something
// irreversible before this code is finished — a wallet-signed transfer of a
// full denomination to an address the deployment holds no spending key for by
// design. Every other leg can fail all it likes and cost a retry. That
// asymmetry is why the ordering cases exist at all.
// ===========================================================================

/**
 * A NAMESPACE import, deliberately, and not for style.
 *
 * These cases name exports that did not exist when they were written. With
 * named imports a missing export is a MODULE LINK ERROR: vitest reports one
 * failed file, zero tests, and the twelve pre-existing cases above go dark with
 * it — so "the suite is red" stops distinguishing a missing export from a wrong
 * answer, and a real defect can hide behind an unrelated rename. Through a
 * namespace the module still loads, each case fails on its own assertion, and
 * the failure names the thing that is missing.
 */
import * as funderModule from './ephemeralFunder';
import { SystemInstruction } from '@solana/web3.js';

/** R, the till: collects from buyers, funds nothing. */
const TILL = 'BQWLmnLmQPzQvJVGrJyBRA6RPBEqMhMQZ5oXQKmDMhcE';
/** The operator's fee wallet: a PURE SINK, co-named with every buyer. */
const FEE_WALLET = 'CtVBK3rQpsPBLuqvhtFbwXcjXWv5PoyqjbJPZ3mV7iVv';

/** A 1 SOL deposit's real pre-fund, measured on devnet 2026-08-18. */
const DEPOSIT_REQUIRED = 1_573_486_080;
/** 1% of a 1 SOL note. */
const DEPOSIT_FEE = 10_000_000;

/** The 1 SOL pool's fee basis, straight out of the pool table. */
const SOL_1 = { token: 'SOL' as const, denominationAtomic: 1_000_000_000n, decimals: 9 };
/** The 1000 USDC pool's, whose atoms are NOT lamports. */
const USDC_1000 = { token: 'USDC' as const, denominationAtomic: 1_000_000_000n, decimals: 6 };

/**
 * The relay's own constants, as `/api/relay-to-buyer` reports them.
 *
 * ⚠️ `ready` IS PART OF THE SHAPE, NOT DECORATION. `ok` only means the handler
 * answered; `ready` is the verdict the client must act on, and a fixture that
 * omitted it was a fixture that did not model the server — which is exactly how
 * "the client ignores ready:false" survived a full green suite.
 *
 * `maxRentSubsidyLamports` recalibrated 2026-08-21 from 1_500_000_000 to
 * 650_000_000; the derivation lives on the constant in the route.
 */
const RELAY_TERMS = {
  ok: true,
  ready: true,
  reasons: [] as string[],
  funder: FUNDER,
  till: TILL,
  feeWallet: FEE_WALLET,
  maxRelayLamports: 2_500_000_000,
  maxRentSubsidyLamports: 650_000_000,
  // Comfortably above one 1 SOL deposit. The cases that matter override it.
  funderLamports: 5_000_000_000,
  relayFeeLamports: 5_000,
};

/** Everything that happened, in order. The point of several cases below. */
let calls: string[] = [];
/** The body the client posted to the relay, so the fee cannot hide in it. */
let relayedBody: { requiredLamports?: number; buyerPubkey?: string; paymentSignature?: string } | null =
  null;

function recordingConnection(balance = 0): Connection {
  return {
    getBalance: async () => balance,
    getLatestBlockhash: async (c?: string) => {
      calls.push(`getLatestBlockhash:${c}`);
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 1 };
    },
    sendRawTransaction: async () => {
      calls.push('sendRawTransaction');
      return 'PAYSIG';
    },
    confirmTransaction: async () => {
      calls.push('confirmTransaction');
      return { value: { err: null } };
    },
  } as unknown as Connection;
}

const recordingSignOne = async (tx: Transaction) => {
  calls.push('signOne');
  signed.push(tx);
  tx.sign(ownerKeypair);
  return tx;
};

/**
 * Stand up a whole deployment's answers: the relay's terms, and its relay POST.
 *
 * `terms: null` is a deployment that cannot be asked — a 500, a proxy
 * interstitial, a dropped connection. Deliberately distinct from a deployment
 * that answers with an address missing, which is an operator mistake rather
 * than an outage and has a different cure.
 */
function stubDeployment(
  opts: {
    terms?: Record<string, unknown> | null;
    termsStatus?: number;
    relay?: 'ok' | 'refuse';
  } = {},
) {
  const terms = opts.terms === undefined ? RELAY_TERMS : opts.terms;
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${String(url)}`);
    fetchCalls.push(String(url));
    if (String(url).startsWith('/api/relay-to-buyer') && method === 'GET') {
      if (terms === null) throw new Error('the deployment could not be reached');
      return {
        ok: (opts.termsStatus ?? 200) < 400,
        status: opts.termsStatus ?? 200,
        json: async () => terms,
      };
    }
    if (String(url).startsWith('/api/relay-to-buyer')) {
      relayedBody = JSON.parse(init?.body ?? '{}');
      if (opts.relay === 'refuse') {
        return {
          ok: false,
          status: 402,
          json: async () => ({
            ok: false,
            error: 'that payment does not cover the value this job moves',
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          signature: 'RELAYSIG',
          lamports: DEPOSIT_REQUIRED,
          funder: FUNDER,
          till: TILL,
        }),
      };
    }
    // `/api/fund-ephemeral` — the float-only grant path, unused by these cases.
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, configured: true, funder: FUNDER }),
    };
  });
}

/** A relayed 1 SOL deposit: the shape `shieldToPool` builds. */
const deposit = (over: Record<string, unknown> = {}) =>
  ({
    ephemeralPubkey: ephemeral,
    requiredLamports: DEPOSIT_REQUIRED,
    valueLamports: DEPOSIT_VALUE,
    feeBasis: SOL_1,
    owner: OWNER,
    connection: recordingConnection(),
    signOne: recordingSignOne,
    relayThroughDeployment: true,
    ...over,
  }) as never;

/** The rejection, or a failure that says what came back instead of one. */
async function refusal(p: Promise<unknown>): Promise<Error & { reason?: string }> {
  let value: unknown;
  try {
    value = await p;
  } catch (e) {
    return e as Error & { reason?: string };
  }
  throw new Error(`expected a refusal, got ${JSON.stringify(value)}`);
}

/**
 * A `localStorage` this environment does not otherwise have.
 *
 * ⚠️ NOT A CONVENIENCE. `fundEphemeralForJob` runs on the MAIN THREAD — it holds
 * the wallet — so the browser really does have one, and the receipt it keeps
 * there is what stops an interrupted deposit being paid for twice. This config
 * runs in `node`, where a real refusal (`no-receipt-store`) would otherwise fire
 * on every relayed case and hide every other assertion behind it. The case that
 * asserts the refusal removes this stub deliberately.
 */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  return backing;
}

let storage: Map<string, string>;

beforeEach(() => {
  calls = [];
  relayedBody = null;
  storage = installStorage();
  // Module state, not test state: the deployment's addresses are cached for the
  // session and would otherwise leak from one case into the next — which is how
  // a case asserting "no till declared" quietly runs against a declared one.
  (funderModule as { resetDeploymentAddresses?: () => void }).resetDeploymentAddresses?.();
});

describe('the relayed deposit refuses rather than pay the wrong address', () => {
  // 🚨 D1, MEASURED ON `wip/lots-abc-2026-08-20`. The relayed branch was guarded
  // by `valueLamports > 0 && relayThroughDeployment && funderConfigured()` and
  // carried the comment "⛔ THERE IS DELIBERATELY NO `else` HERE THAT FALLS
  // THROUGH TO PAYING F". There was one: the very next line was
  // `else if (valueLamports > 0)`, which set a fallback reason and let the
  // WALLET pre-fund the depositing ephemeral directly — the exact edge P9
  // walked on 2026-08-18, restored silently, on the one path whose entire
  // purpose is removing it.
  //
  // The user is not told. The deposit succeeds. The screen says it worked.

  it('refuses when the deployment names no till, and signs NOTHING', async () => {
    stubDeployment({ terms: { ...RELAY_TERMS, till: null } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('DeploymentTillMisconfiguredError');
    expect(e.reason).toBe('till-unset');
    expect(signed).toHaveLength(0);
    expect(calls).not.toContain('sendRawTransaction');
  });

  it('refuses when the till IS the funder', async () => {
    // The 2026-08-18 measurement itself: a buyer who pays F is one transaction
    // from the address that funds their own spend, and P11 walks it in two hops
    // with no cryptography.
    stubDeployment({ terms: { ...RELAY_TERMS, till: FUNDER } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('DeploymentTillMisconfiguredError');
    expect(e.reason).toBe('till-equals-funder');
    expect(signed).toHaveLength(0);
  });

  it('refuses a till that is not a public key at all', async () => {
    // Unparseable must fail the same way as unset. A `new PublicKey(...)` throw
    // escaping from here would be an untyped error the panel cannot classify —
    // and, worse, it can only happen at the moment the transaction is built,
    // which on the old ordering was after the wallet had been asked.
    stubDeployment({ terms: { ...RELAY_TERMS, till: 'not-a-public-key' } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('DeploymentTillMisconfiguredError');
    expect(e.reason).toBe('addresses-unreadable');
    expect(signed).toHaveLength(0);
  });

  it('refuses when the deployment declares no fee wallet', async () => {
    stubDeployment({ terms: { ...RELAY_TERMS, feeWallet: null } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('DeploymentTillMisconfiguredError');
    expect(e.reason).toBe('fee-wallet-unset');
    expect(signed).toHaveLength(0);
  });

  it('refuses when the fee wallet IS the funder', async () => {
    // The fee rides inside the buyer's own transaction, so a fee wallet equal to
    // F puts F in that transaction: the two-hop walk with the middle step
    // removed.
    stubDeployment({ terms: { ...RELAY_TERMS, feeWallet: FUNDER } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('DeploymentTillMisconfiguredError');
    expect(e.reason).toBe('fee-wallet-equals-funder');
    expect(signed).toHaveLength(0);
  });

  it('refuses when the fee wallet IS the till', async () => {
    // 🚨 THE COLLISION WITH NO SYMPTOM. web3.js dedupes an identical pubkey into
    // ONE account index, so both credits land in one balance delta: the relay
    // reads `value + fee` as the payment, `subsidy = required - received` merely
    // shrinks, nothing errors anywhere, and the operator collects no fee while
    // believing they do.
    stubDeployment({ terms: { ...RELAY_TERMS, feeWallet: TILL } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('DeploymentTillMisconfiguredError');
    expect(e.reason).toBe('fee-wallet-equals-till');
    expect(signed).toHaveLength(0);
  });

  it('refuses instead of pre-funding the ephemeral from the wallet when there is no funder', async () => {
    // 🚨 THE `else if` ITSELF. A deployment serving a bundle built before
    // `NEXT_PUBLIC_P01_FUNDER_TICKET` was set has `funderConfigured() === false`
    // — the stale-bundle case this repository has already been bitten by — so
    // the relayed branch is skipped entirely and the wallet funds the depositing
    // ephemeral in one public transfer. The caller ASKED for the relay. Getting
    // the linkable path instead, with no error, is the one outcome the buyer
    // cannot detect afterwards and cannot undo.
    vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', '');
    stubDeployment();
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('no-funder-configured');
    expect(signed).toHaveLength(0);
    expect(calls).not.toContain('sendRawTransaction');
  });

  it('still lets the wallet fund a deposit that never asked for the relay', async () => {
    // ⚠️ THE NEGATIVE CONTROL, AND IT IS THE FROZEN DEMO'S SHAPE. The live
    // devnet harness funds its ephemeral straight from the wallet and does not
    // set `relayThroughDeployment`. A refusal that fired on this shape would
    // take the proven journey down.
    stubDeployment();
    const d = await fundEphemeralForJob(deposit({ relayThroughDeployment: false }));
    expect(d.fundedBy).toBe('wallet');
    expect(d.sweepTo).toBe(OWNER.toBase58());
    expect(signed).toHaveLength(1);
  });
});

describe('the relay’s own verdict outranks anything this client re-derives', () => {
  // 🚨 THE BLOCKER THIS PINS. `ok: true` is a literal in the route — it means
  // "the handler answered" — while `ready` is the verdict. This client used to
  // read only `ok`, re-derive the ADDRESS checks, and pay. Two of the route's
  // non-readiness reasons cannot be re-derived from here at all: the server-side
  // `P01_FUNDER_TICKET` (the client reads a different, NEXT_PUBLIC_ variable)
  // and an unreachable KV store. In both, the addresses are valid and distinct,
  // every client-side check passes, the wallet signs — and the POST answers 503
  // after a full denomination has gone to an address with no spending key.

  it('refuses when the relay says it is not ready, and signs NOTHING', async () => {
    stubDeployment({
      terms: {
        ...RELAY_TERMS,
        ready: false,
        reasons: ['No durable KV store is reachable, so the POST fails closed.'],
      },
    });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('deployment-not-ready');
    // Verbatim, because the reason names the environment variable to fix and a
    // paraphrase would send the operator looking in the wrong place.
    expect(e.message).toContain('No durable KV store is reachable');
    expect(signed).toHaveLength(0);
    expect(calls).not.toContain('sendRawTransaction');
  });

  it('refuses a not-ready relay even when it still publishes payable addresses', async () => {
    // The exact shape of the trap: the route reports `till` and `feeWallet`
    // whether or not it can serve, so a client that reads the addresses and not
    // the verdict has everything it needs to pay and nothing that stops it.
    stubDeployment({ terms: { ...RELAY_TERMS, ready: false, reasons: [] } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.reason).toBe('deployment-not-ready');
    expect(signed).toHaveLength(0);
  });

  it('still gives an operator mistake its OWN error, rather than the catch-all', async () => {
    // ⚠️ ORDER, AND IT IS THE POINT. A misconfigured till makes the route report
    // BOTH `ready: false` and the till reason. Checking readiness first would
    // collapse every operator mistake into one untyped refusal, and the UI would
    // offer the buyer a smaller denomination for a problem no denomination
    // fixes. The typed error must win.
    stubDeployment({
      terms: { ...RELAY_TERMS, till: '', ready: false, reasons: ['P01_TILL_ADDRESS is unset.'] },
    });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('DeploymentTillMisconfiguredError');
    expect(e.reason).toBe('till-unset');
  });
});

describe('a float that cannot pay refuses before the buyer does', () => {
  // 🚨 THE FLOAT SENDS THE WHOLE JOB NOW AND THE BUYER CREDITS IT NOTHING, so
  // it drains by one pre-fund per deposit until the operator settles the till
  // into it — which nothing here implements. MEASURED 2026-08-21: the devnet
  // authority held 1.4558 SOL while one 1 SOL deposit needs 1.5735. Without this
  // the buyer pays the till first and meets the shortfall as a 502.

  it('refuses when the float is visibly short, and signs NOTHING', async () => {
    stubDeployment({ terms: { ...RELAY_TERMS, funderLamports: 1_455_800_000 } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('float-too-low');
    expect(e.message).toContain('1455800000');
    expect(signed).toHaveLength(0);
    expect(calls).not.toContain('sendRawTransaction');
  });

  it('counts the relay’s own transaction fee, not just the pre-fund', async () => {
    // Exactly the pre-fund and not one lamport more: the float still has to pay
    // for the transfer that sends it.
    stubDeployment({ terms: { ...RELAY_TERMS, funderLamports: DEPOSIT_REQUIRED } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.reason).toBe('float-too-low');

    stubDeployment({ terms: { ...RELAY_TERMS, funderLamports: DEPOSIT_REQUIRED + 5_000 } });
    const d = await fundEphemeralForJob(deposit());
    expect(d.fundedBy).toBe('funder');
  });

  it('treats an unreadable balance as unknown, never as empty', async () => {
    // ⚠️ THE OVERREACH THIS AVOIDS. Refusing on `null` would let one RPC hiccup
    // at the deployment delete the only private deposit path — the shape of
    // guard that has already cost this project a working journey. Unknown
    // proceeds; the persisted receipt is what makes a later failure cheap.
    stubDeployment({ terms: { ...RELAY_TERMS, funderLamports: null } });
    const d = await fundEphemeralForJob(deposit());
    expect(d.fundedBy).toBe('funder');
    expect(signed).toHaveLength(1);
  });
});

describe('a payment that already left is never made twice', () => {
  // 🚨 THE BLOCKER THIS PINS, AND IT COST THE BUYER A FULL DENOMINATION. The
  // payment signature lived in a local `const`. When the relay call threw — a
  // 429, a 502, or the route's own 404 "not on chain yet; confirm it and retry"
  // — the receipt died with the call stack. The ephemeral had received nothing,
  // so the "already holds lamports" guard did not bite, and the retry signed a
  // SECOND full denomination plus a second fee. The route already releases its
  // one-shot claim on every path that hands nothing over, precisely so the same
  // receipt can be presented again; nothing on this side could present it.

  it('keeps the receipt when the relay refuses, and reuses it instead of paying again', async () => {
    stubDeployment({ relay: 'refuse' });
    await refusal(fundEphemeralForJob(deposit()));
    expect(signed).toHaveLength(1);
    const first = relayedBody?.paymentSignature;
    expect(first).toBeTruthy();

    // The retry. Same job, same ephemeral — deterministic in (seed, pool, leaf)
    // — so the receipt is found and presented rather than re-bought.
    stubDeployment({ relay: 'ok' });
    const d = await fundEphemeralForJob(deposit());
    expect(d.fundedBy).toBe('funder');
    expect(signed).toHaveLength(1);
    expect(relayedBody?.paymentSignature).toBe(first);
  });

  it('drops the receipt once the relay has actually forwarded it', async () => {
    stubDeployment({ relay: 'ok' });
    await fundEphemeralForJob(deposit());
    expect(JSON.parse(storage.get('p01_relay_payment_receipts_v1') ?? '[]')).toHaveLength(0);

    // And a later deposit on the same key pays for itself rather than resuming
    // a payment that has already been spent.
    stubDeployment({ relay: 'ok' });
    await fundEphemeralForJob(deposit());
    expect(signed).toHaveLength(2);
  });

  it('refuses rather than pay twice when the job moved under an outstanding receipt', async () => {
    stubDeployment({ relay: 'refuse' });
    await refusal(fundEphemeralForJob(deposit()));

    // A different pre-fund against the same ephemeral: reusing the receipt would
    // present a payment for another job, and paying again would charge twice.
    // Neither is safe, so it refuses and NAMES the signature so the money is
    // findable.
    stubDeployment({ relay: 'ok' });
    const e = await refusal(
      fundEphemeralForJob(deposit({ requiredLamports: DEPOSIT_REQUIRED + 1 })),
    );
    expect(e.reason).toBe('payment-outstanding');
    expect(signed).toHaveLength(1);
  });

  it('refuses to take money it could not keep a receipt for', async () => {
    // Private browsing, or storage disabled. A failure between the payment and
    // the relay would then be unrecoverable rather than merely annoying, so the
    // refusal happens BEFORE the wallet is asked.
    vi.stubGlobal('localStorage', undefined);
    stubDeployment({ relay: 'ok' });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('no-receipt-store');
    expect(signed).toHaveLength(0);
  });
});

describe('nothing irreversible happens before the relay has agreed to serve', () => {
  // 🚨 D2. The buyer's payment is the only step in this flow that cannot be
  // undone: a full denomination, signed by their wallet, sent to an address this
  // deployment deliberately holds no spending key for. Anything that fails AFTER
  // it — an unreadable till, a job over the cap, a rate limit, a 502 — strands
  // that money at the till with no relay and no refund path.
  //
  // So the order is: learn the terms, check this job against them, and only then
  // ask the wallet. The irreversible step is last.

  it('reads the relay terms BEFORE the wallet signs and before the payment is sent', async () => {
    stubDeployment();
    await fundEphemeralForJob(deposit());
    const terms = calls.indexOf('GET /api/relay-to-buyer');
    expect(terms).toBeGreaterThan(-1);
    expect(terms).toBeLessThan(calls.indexOf('signOne'));
    expect(terms).toBeLessThan(calls.indexOf('sendRawTransaction'));
    // And before the blockhash too. Fetching one commits nothing, but building
    // the transaction before the terms are known is how a refusal ends up after
    // the wallet popup instead of before it.
    expect(terms).toBeLessThan(calls.indexOf('getLatestBlockhash:finalized'));
  });

  it('signs nothing when the deployment cannot be asked at all', async () => {
    // An outage is not an all-clear. Paying a cached or guessed till here is how
    // money reaches an address nobody is watching.
    stubDeployment({ terms: null });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('terms-unreadable');
    expect(signed).toHaveLength(0);
  });

  it('signs nothing when the terms endpoint answers with an error status', async () => {
    stubDeployment({ terms: { ok: false, error: 'no funder key' }, termsStatus: 503 });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(signed).toHaveLength(0);
  });

  it('pays the till the RELAY named, so the payer and the reader cannot drift', async () => {
    // The relay reads `received` from the till's balance delta. If the client
    // paid an address from a second source — a build-time constant, a different
    // endpoint — a rotated till means the buyer pays one address while the relay
    // reads another, and the answer is 400 AFTER the money has moved.
    stubDeployment();
    await fundEphemeralForJob(deposit());
    expect(signed).toHaveLength(1);
    const to = signed[0].instructions.map((ix) =>
      SystemInstruction.decodeTransfer(ix).toPubkey.toBase58(),
    );
    expect(to).toContain(TILL);
    expect(to).not.toContain(FUNDER);
  });
});

describe('a job the relay cannot serve is refused before the buyer signs', () => {
  // PORTE 2, engine half. MEASURED FROM SOURCE 2026-08-20:
  //   relay-to-buyer MAX_RELAY_LAMPORTS        2_500_000_000
  //   relay-to-buyer MAX_RENT_SUBSIDY_LAMPORTS 1_500_000_000
  //   fund-ephemeral MAX_LAMPORTS_PER_REQUEST  2_000_000_000
  // A shield needs denomination * 1.003 + about 0.57 SOL of refundable proof
  // rent, so MAX_RELAY_LAMPORTS binds at a denomination of roughly 1.92 SOL. The
  // 10, 100, 500 and 1000 SOL pools therefore take the buyer's money and deliver
  // NOTHING, 100% of the time: the payment lands and the relay then refuses it.

  it('refuses a 10 SOL deposit, which no relay on this deployment can fund', async () => {
    stubDeployment();
    const e = await refusal(
      fundEphemeralForJob(
        deposit({
          valueLamports: 10_030_000_000,
          requiredLamports: 10_600_010_780,
          feeBasis: { token: 'SOL', denominationAtomic: 10_000_000_000n, decimals: 9 },
        }),
      ),
    );
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('job-over-relay-cap');
    expect(signed).toHaveLength(0);
    expect(calls).not.toContain('sendRawTransaction');
  });

  it('takes the ceiling from the deployment rather than from a constant in this file', async () => {
    // 🚨 A SECOND COPY OF A CAP IS A CAP THAT DRIFTS. If the client carried its
    // own 2.5 SOL, an operator lowering the relay's cap would not lower the
    // client's, and every buyer between the two numbers would pay first and be
    // refused after. Same deposit, same code, only the deployment's answer
    // changes — and the outcome has to change with it.
    stubDeployment({ terms: { ...RELAY_TERMS, maxRelayLamports: 1_000_000_000 } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('job-over-relay-cap');
    expect(signed).toHaveLength(0);
  });

  it('serves the same job when the deployment raises its own ceiling', async () => {
    // The other half of that property: the client must not be stricter than the
    // deployment either, or raising the cap does nothing and the client's copy
    // is the real cap after all.
    //
    // ⚠️ THE FLOAT IS RAISED WITH THE CEILING, ON PURPOSE. A deployment that
    // lifts its cap to 20 SOL without funding the float cannot serve a 10 SOL
    // job, and the `float-too-low` refusal is right to say so — but it would
    // make this case pass for a reason that has nothing to do with ceilings.
    stubDeployment({
      terms: {
        ...RELAY_TERMS,
        maxRelayLamports: 20_000_000_000,
        funderLamports: 20_000_000_000,
      },
    });
    const d = await fundEphemeralForJob(
      deposit({
        valueLamports: 10_030_000_000,
        requiredLamports: 10_600_010_780,
        feeBasis: { token: 'SOL', denominationAtomic: 10_000_000_000n, decimals: 9 },
      }),
    );
    expect(d.fundedBy).toBe('funder');
  });

  it('refuses when the rent the deployment would front exceeds its own subsidy cap', async () => {
    // `subsidy = required - received`. The buyer pays the value; the deployment
    // fronts the refundable proof rent. A job whose rent half is over the cap is
    // refused by the relay AFTER the payment unless it is refused here BEFORE it.
    stubDeployment({ terms: { ...RELAY_TERMS, maxRentSubsidyLamports: 100_000 } });
    const e = await refusal(fundEphemeralForJob(deposit()));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('subsidy-over-cap');
    expect(signed).toHaveLength(0);
  });
});

describe('the operator fee is 1% of the note, in the note’s own units', () => {
  // 🚨 D4. `operatorFeeLamportsFor(denomination)` on `wip/lots-abc-2026-08-20`
  // was `Math.round((denomination * 1e9) / 100)` — the HUMAN denomination times
  // a hard-coded 1e9. That is right for SOL by coincidence, because SOL has nine
  // decimals, and it is catastrophic for every other pool in the table: the 1000
  // USDC pool would have charged 10_000_000_000 lamports, which is TEN SOL, in a
  // transfer the buyer signs without seeing it itemised.
  //
  // The pool table already carries `denominationAtomic` and `decimals` for
  // exactly this reason. A percentage of atoms needs neither a decimal exponent
  // nor a float.

  it('charges 0.01 SOL on the 1 SOL pool', () => {
    expect(funderModule.operatorFeeAtomic(SOL_1)).toBe(10_000_000n);
  });

  it('charges 0.001 SOL on the 0.1 SOL pool, which holds 10 live notes', () => {
    expect(
      funderModule.operatorFeeAtomic({
        token: 'SOL',
        denominationAtomic: 100_000_000n,
        decimals: 9,
      }),
    ).toBe(1_000_000n);
  });

  it('charges TEN USDC on the 1000 USDC pool, not ten SOL', () => {
    const fee = funderModule.operatorFeeAtomic(USDC_1000);
    expect(fee).toBe(10_000_000n);
    // The reading that matters: ten of the pool's own unit.
    expect(Number(fee) / 10 ** USDC_1000.decimals).toBe(10);
    // And explicitly NOT the 1e9 answer, which is the defect by its number.
    expect(fee).not.toBe(10_000_000_000n);
  });

  it('charges 0.01 USDC on the 1 USDC pool', () => {
    const fee = funderModule.operatorFeeAtomic({
      token: 'USDC',
      denominationAtomic: 1_000_000n,
      decimals: 6,
    });
    expect(fee).toBe(10_000n);
    expect(fee).not.toBe(10_000_000n);
  });

  it('refuses a non-SOL pool outright, because a lamport transfer cannot pay a USDC fee', async () => {
    // The founder's shape is a `SystemProgram.transfer` inside the buyer's own
    // transaction, and that instruction moves LAMPORTS. Charging a USDC pool's
    // atoms through it would send 10 SOL-millionths per USDC-millionth of
    // nothing at all; charging its lamport equivalent would need a price feed.
    // Refusing explicitly is the only honest third option, and it has to happen
    // before the wallet is asked.
    stubDeployment();
    const e = await refusal(fundEphemeralForJob(deposit({ feeBasis: USDC_1000 })));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('fee-not-payable-in-lamports');
    expect(signed).toHaveLength(0);
  });

  it('refuses a relayed deposit that states no fee basis at all', async () => {
    // Silently charging nothing is invisible revenue loss, and it is a CLIENT
    // bug rather than an operator one. Loud.
    stubDeployment();
    const e = await refusal(fundEphemeralForJob(deposit({ feeBasis: undefined })));
    expect(e.name).toBe('RelayCannotServeJobError');
    expect(e.reason).toBe('fee-basis-missing');
    expect(signed).toHaveLength(0);
  });
});

describe('what the buyer actually signs', () => {
  it('is ONE transaction: the note value to the till, the 1% to the fee wallet', async () => {
    // No second signature and no second transaction — the founder's shape. Two
    // transactions would double the popups and, worse, make the fee droppable: a
    // buyer who approves the first and rejects the second has deposited without
    // paying, and there is no way to collect afterwards.
    stubDeployment();
    await fundEphemeralForJob(deposit());
    expect(signed).toHaveLength(1);
    const tx = signed[0];
    expect(tx.instructions).toHaveLength(2);

    const decoded = tx.instructions.map((ix) => SystemInstruction.decodeTransfer(ix));
    const byDest = new Map(decoded.map((d) => [d.toPubkey.toBase58(), Number(d.lamports)]));

    // 🚨 EXACTLY THE DENOMINATION PLUS THE PROTOCOL FEE, AND NOT ONE LAMPORT
    // MORE. The relay reads this delta and forwards `requiredLamports`; the note
    // that lands in the pool has to be exactly the denomination, or notes stop
    // being indistinguishable by size and the amount defence is gone.
    expect(byDest.get(TILL)).toBe(DEPOSIT_VALUE);
    expect(byDest.get(FEE_WALLET)).toBe(DEPOSIT_FEE);
    // The fee is not folded into the payment, and the payment is not inflated by
    // it.
    expect(byDest.get(TILL)).not.toBe(DEPOSIT_VALUE + DEPOSIT_FEE);
    expect(decoded.every((d) => d.fromPubkey.toBase58() === OWNER.toBase58())).toBe(true);
  });

  it('asks the relay for the pre-fund UNCHANGED, with no fee added to it', async () => {
    // Inflating `requiredLamports` by the fee would forward the fee into the
    // ephemeral, where it ends up either inside the note — breaking the exact
    // denomination — or swept to F, which is not the operator.
    stubDeployment();
    await fundEphemeralForJob(deposit());
    expect(relayedBody?.requiredLamports).toBe(DEPOSIT_REQUIRED);
    expect(relayedBody?.requiredLamports).not.toBe(DEPOSIT_REQUIRED + DEPOSIT_FEE);
  });

  it('sweeps the residue back to the FLOAT, never to the till', async () => {
    // ⛔ F fronted the refundable proof rent, so the residue that comes back is
    // F's own money. Sweeping it to the till "for consistency with the payment"
    // would hand F's rent to an address that never lent it — and sweeping it home
    // to the wallet would rebuild the `ephemeral -> wallet` edge P9 walked on
    // 2026-08-18, undoing the entire detour to return money that was never the
    // buyer's.
    stubDeployment();
    const d = await fundEphemeralForJob(deposit());
    expect(d.fundedBy).toBe('funder');
    expect(d.sweepTo).toBe(FUNDER);
    expect(d.sweepTo).not.toBe(TILL);
    expect(d.sweepTo).not.toBe(OWNER.toBase58());
  });
});
