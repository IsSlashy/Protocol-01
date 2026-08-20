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
  DeploymentTillMisconfiguredError,
  DirtyEphemeralError,
  WalletExposureRefusedError,
  fundEphemeralForJob,
  loadFunderAddress,
  resetDeploymentAddresses,
} from './ephemeralFunder';

// A real keypair rather than a bare address: the wallet fallback SERIALIZES the
// transaction it just had signed, and serialization rejects a missing
// signature. A stub that returned the transaction untouched would have made
// every wallet-funded case fail for a reason that has nothing to do with the
// decision under test.
const ownerKeypair = Keypair.generate();
const OWNER = ownerKeypair.publicKey;
const FUNDER = 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB';
/** R, the till — the address a buyer's money must land on. NEVER F. */
const TILL = Keypair.generate().publicKey.toBase58();
/** The operator's fee sink. A THIRD address, and it must stay one. */
const FEE_WALLET = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = SystemProgram.programId.toBase58();

/** A withdrawal's real pre-fund shape: float only, no denomination. */
const FLOAT_ONLY = 1_030_290_360;
/** A 1 SOL deposit's value half, measured on devnet: 1 SOL + 0.3%. */
const DEPOSIT_VALUE = 1_003_475_300;
/** The whole pre-fund of a 1 SOL deposit, measured on devnet. */
const DEPOSIT_REQUIRED = 1_573_486_080;
/** 1% of the NOTE DENOMINATION — 1 SOL here. Not 1% of DEPOSIT_VALUE, which
 *  already carries the 0.3% protocol fee and would compound. */
const OPERATOR_FEE = 10_000_000;

let ephemeral: string;
let signed: Transaction[] = [];
let fetchCalls: string[] = [];
/** Bodies POSTed to the relay, so a case can pin what it was ASKED for. */
let relayBodies: Record<string, unknown>[] = [];

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

/**
 * Stub the funder endpoint. `ok: false` drives the fallback path.
 *
 * The GET is answered separately from the POSTs because it is the ONLY surface
 * that carries the deployment's three addresses. They are read at call time
 * rather than inlined at build for a measured reason (a rotated key would
 * otherwise be paid at the old address by every stale bundle), so a stub that
 * answered every method with the POST body left the relayed path untestable.
 */
function stubFunder(
  mode: 'ok' | 'refuse' | 'network',
  lookup: { funder?: string | null; till?: string | null; feeWallet?: string | null } = {},
) {
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    fetchCalls.push(String(url));
    if (mode === 'network') throw new Error('network down');
    if ((init?.method ?? 'GET') === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          configured: true,
          funder: FUNDER,
          till: TILL,
          feeWallet: FEE_WALLET,
          ...lookup,
        }),
      };
    }
    if (init?.body) relayBodies.push(JSON.parse(init.body) as Record<string, unknown>);
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

/** from -> to -> lamports for one `SystemProgram.transfer`, decoded by hand.
 *  The 4-byte little-endian instruction index (2 = Transfer) is followed by the
 *  u64 amount, so this needs no version-sensitive decoder helper. */
function transferOf(tx: Transaction, i: number) {
  const ix = tx.instructions[i];
  const data = Buffer.from(ix.data);
  return {
    from: ix.keys[0].pubkey.toBase58(),
    to: ix.keys[1].pubkey.toBase58(),
    lamports: Number(data.readBigUInt64LE(4)),
    tag: data.readUInt32LE(0),
  };
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
  relayBodies = [];
  ephemeral = Keypair.generate().publicKey.toBase58();
  vi.stubEnv('NEXT_PUBLIC_P01_FUNDER_TICKET', 'test-ticket');
  // Module-scope cache: without this a case that loaded a till leaves it loaded
  // for every case after it, and the refusal cases would silently test a
  // correctly-configured deployment. Green for the wrong reason.
  resetDeploymentAddresses();
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

// ---------------------------------------------------------------------------
// The relayed deposit: R != F, and the 1% operator fee
// ---------------------------------------------------------------------------

/** A 1 SOL deposit routed through the deployment. */
const relayedJob = (over: Record<string, unknown> = {}) =>
  job({
    requiredLamports: DEPOSIT_REQUIRED,
    valueLamports: DEPOSIT_VALUE,
    operatorFeeLamports: OPERATOR_FEE,
    relayThroughDeployment: true,
    ...over,
  });

describe('the relayed deposit pays the TILL, not the funder', () => {
  // 🚨 THE LEAK THIS BLOCK EXISTS FOR, AND IT SURVIVED THE PROSE THAT DENIED IT.
  //
  // Until 2026-08-20 this branch sent the buyer's deposit money straight to F —
  // the address that also funds the ephemeral that spends the note. MEASURED
  // 2026-08-18: that is a two-hop walk with no cryptography. F's own history
  // held a transfer SIGNED BY THE BUYER, one second before it financed the
  // depositing ephemeral, for exactly the note's amount. R != F was asserted in
  // the env documentation, in the readiness report and in three file headers,
  // and was wired nowhere.
  //
  // Nothing failed while it was wrong. That is why these are pinned on the
  // ADDRESS inside the instruction rather than on the flow succeeding.

  it('sends the value to the till and NOT to the funder', async () => {
    stubFunder('ok');
    await loadFunderAddress();
    const d = await fundEphemeralForJob(relayedJob());

    expect(signed).toHaveLength(1);
    const value = transferOf(signed[0], 0);
    expect(value.to).toBe(TILL);
    expect(value.to).not.toBe(FUNDER);
    expect(value.lamports).toBe(DEPOSIT_VALUE);
    expect(d.fundedBy).toBe('funder');
  });

  it('still sweeps the residue to the FUNDER, which is the address that lent it', async () => {
    // The line a future contributor would "fix for consistency" now that the
    // payment goes elsewhere. F fronted the refundable proof rent, so the
    // residue is F's money; sweeping it to the till would hand it to an address
    // that never lent it, and sweeping it home would rebuild the
    // ephemeral -> wallet edge P9 walked on 2026-08-18.
    stubFunder('ok');
    await loadFunderAddress();
    const d = await fundEphemeralForJob(relayedJob());
    expect(d.sweepTo).toBe(FUNDER);
    expect(d.sweepTo).not.toBe(TILL);
    expect(d.sweepTo).not.toBe(OWNER.toBase58());
  });

  it('charges the 1% fee to a THIRD address, in the SAME transaction', async () => {
    // One signature, two instructions. A second transaction would be a second
    // wallet popup and a second thing to correlate; folding the fee into the
    // value transfer would deposit denomination + 1% and the note would stop
    // being exactly the denomination.
    stubFunder('ok');
    await loadFunderAddress();
    await fundEphemeralForJob(relayedJob());

    expect(signed).toHaveLength(1);
    expect(signed[0].instructions).toHaveLength(2);
    const fee = transferOf(signed[0], 1);
    expect(fee.tag).toBe(2); // SystemInstruction::Transfer
    expect(fee.to).toBe(FEE_WALLET);
    expect(fee.to).not.toBe(TILL);
    expect(fee.to).not.toBe(FUNDER);
    expect(fee.lamports).toBe(OPERATOR_FEE);
  });

  it('keeps the note exactly the denomination: the fee never enters the pool', async () => {
    // The amount-correlation property. `requiredLamports` is what the relay is
    // asked to forward onto the depositing ephemeral, and the fee must not
    // inflate it — an inflated pre-fund is either deposited (the note stops
    // matching every other note of its size) or swept to F (the operator never
    // sees their fee).
    stubFunder('ok');
    await loadFunderAddress();
    await fundEphemeralForJob(relayedJob());

    const relay = relayBodies[relayBodies.length - 1];
    expect(relay.requiredLamports).toBe(DEPOSIT_REQUIRED);
    expect(relay.requiredLamports).not.toBe(DEPOSIT_REQUIRED + OPERATOR_FEE);
    // And the value transfer carried no fee either.
    expect(transferOf(signed[0], 0).lamports).toBe(DEPOSIT_VALUE);
  });
});

describe('the relayed deposit refuses rather than quietly paying F', () => {
  // ⛔ EVERY ONE OF THESE MUST THROW BEFORE THE WALLET IS ASKED TO SIGN.
  //
  // A silent fallback to paying F is worse than the original leak: the operator
  // reads a readiness report saying R != F, the code does the opposite, and
  // nothing anywhere reports the difference. `signed.length === 0` is the half
  // of each assertion that matters — the refusal has to be free.

  const cases: [
    string,
    { funder?: string | null; till?: string | null; feeWallet?: string | null },
    string,
  ][] = [
    ['the till is unset', { till: null }, 'till-unset'],
    ['the till IS the funder', { till: FUNDER }, 'till-equals-funder'],
    ['the fee wallet is unset', { feeWallet: null }, 'fee-wallet-unset'],
    ['the fee wallet IS the funder', { feeWallet: FUNDER }, 'fee-wallet-equals-funder'],
    ['the fee wallet IS the till', { feeWallet: TILL }, 'fee-wallet-equals-till'],
  ];

  for (const [name, lookup, reason] of cases) {
    it(`refuses when ${name}`, async () => {
      stubFunder('ok', lookup);
      await loadFunderAddress();
      const err = await fundEphemeralForJob(relayedJob()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeploymentTillMisconfiguredError);
      expect((err as DeploymentTillMisconfiguredError).reason).toBe(reason);
      expect(signed).toHaveLength(0);
    });
  }

  it('names an OPERATOR setting as the cure, not a retry', async () => {
    // The distinction is load-bearing: `WalletExposureRefusedError` means "the
    // funder could not serve" and the UI treats it as retryable. Nothing a buyer
    // retries fixes an unset environment variable, and reusing that name would
    // loop the panel over a problem no retry touches.
    stubFunder('ok', { till: null });
    await loadFunderAddress();
    const err = await fundEphemeralForJob(relayedJob()).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(WalletExposureRefusedError);
    expect((err as Error).message).toMatch(/operator setting/i);
    expect((err as Error).message).toMatch(/Nothing was sent/);
  });

  it('refuses a stale cache rather than paying the address it last saw', async () => {
    // 🚨 THE FAIL-STALE BUG. `loadFunderAddress` used to return early on a
    // non-ok response WITHOUT clearing what it had cached. Harmless while the
    // buyer paid F, because F does not change. Not harmless once the buyer pays
    // the till: an operator who rotates or removes P01_TILL_ADDRESS, plus one
    // failed refresh, would have this browser keep paying the OLD till —
    // lamports to an address nobody may still control, with no error anywhere.
    stubFunder('ok');
    await loadFunderAddress();
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await loadFunderAddress();

    const err = await fundEphemeralForJob(relayedJob()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeploymentTillMisconfiguredError);
    expect(signed).toHaveLength(0);
  });

  it('refuses a relayed deposit carrying no operator fee at all', async () => {
    // A missing fee is a CLIENT bug, not an operator one, and it is invisible:
    // the deposit succeeds and the operator simply collects nothing. Loud.
    stubFunder('ok');
    await loadFunderAddress();
    await expect(
      fundEphemeralForJob(relayedJob({ operatorFeeLamports: undefined })),
    ).rejects.toThrow(/operatorFeeLamports/);
    expect(signed).toHaveLength(0);
  });

  it('leaves the NON-relayed deposit alone', async () => {
    // The negative control, and it is the point. A guard that refuses everything
    // is not a guard, it is an outage. A deployment with no relay must still be
    // able to deposit: the till checks gate the relayed branch only, so a plain
    // wallet-funded deposit keeps working with no till configured at all.
    stubFunder('ok', { till: null, feeWallet: null });
    await loadFunderAddress();
    const d = await fundEphemeralForJob(
      job({ requiredLamports: DEPOSIT_REQUIRED, valueLamports: DEPOSIT_VALUE }),
    );
    expect(d.fundedBy).toBe('wallet');
    expect(signed).toHaveLength(1);
    expect(transferOf(signed[0], 0).to).toBe(ephemeral);
  });
});
