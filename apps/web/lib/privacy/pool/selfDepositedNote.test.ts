/**
 * Refusing to spend a note your own wallet deposited.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY THIS IS THE GUARD THAT DECIDES WHETHER THE OTHERS MATTER
 * ───────────────────────────────────────────────────────────
 * Spending republishes the deposit's commitment in cleartext. The program
 * forces it: the C1 inputs hash binds the byte-160 argument, C3 proves that
 * same value is a leaf, and the root must be one of the pool's. No client
 * change alters that before the verifier is redeployed.
 *
 * So the walk is spend → commitment → deposit → that deposit's fee payer. One
 * hop, no cryptography. And if that fee payer is the wallet doing the
 * spending, then everything else in this directory buys NOTHING: the
 * subscription can be paid by a treasury, swept to a treasury and signed by a
 * fresh ephemeral, and the buyer is still one hop away through their own
 * deposit.
 *
 * It is the one configuration where doing everything right leaves you findable,
 * and nothing on the subscribe screen distinguishes it — the note looks
 * identical either way. That is why it is checked in code rather than asked for
 * in a runbook.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

const OWNER = Keypair.generate().publicKey;
const TREASURY = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
/** The address that pays for the SPEND, which is a different question from who
 *  paid for the deposit — and, until 2026-08-18, a question nothing asked. */
const SPEND_FUNDER = Keypair.generate().publicKey;

/** Whatever the worker last answered for `poolSubscribePrepare`. */
let prepareAnswer: Record<string, unknown>;
let executeCalled = false;

vi.mock('../workerClient', () => ({
  poolRequest: vi.fn(async (req: { kind: string }) => {
    if (req.kind === 'poolSubscribePrepare') return prepareAnswer;
    if (req.kind === 'poolSubscribeExecute') {
      executeCalled = true;
      return {
        kind: 'poolSubscribeExecute',
        txSig: 'TXSIG',
        vaultPDA: 'VAULT',
        licenseKey: 'P01-KEY',
        serviceTag: 'tag',
        denomination: 1,
      };
    }
    return {};
  }),
}));

// The funding decision is exercised by its own suite; here it must simply not
// be reached when the deposit check refuses.
/** What the deployment answers when asked who funds the spend leg. Mutable so a
 *  case can turn the funder off, break the lookup, or point it at an address the
 *  wallet has paid. */
let funderLookup: { state: string; pubkey?: string; reason?: string };

vi.mock('./ephemeralFunder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ephemeralFunder')>()),
  fundEphemeralForJob: vi.fn(async () => ({
    fundedBy: 'funder' as const,
    sweepTo: TREASURY.toBase58(),
  })),
  // 🚨 REAL BY DEFAULT WOULD MEAN `fetch()` IN A NODE TEST, which resolves to
  // "unknown", which the spend-leg guard refuses — every case in this file would
  // go red for a reason that has nothing to do with what it is testing. Stubbing
  // it makes each case DECLARE who pays, which is the point of the new guard.
  fetchFunderLookup: vi.fn(async () => funderLookup),
}));

import { fundEphemeralForJob } from './ephemeralFunder';
import {
  SelfDepositedNoteError,
  SpendFunderNamesWalletError,
  subscribeFromPool,
} from '../shieldClient';

/**
 * Signature histories, by address. The guard's last question is answered by
 * intersecting two of these — a transaction naming two addresses is returned
 * for both — so a stub that serves nothing else is enough to drive every branch.
 */
let histories: Record<string, (string | { signature: string; slot: number })[]>;
const connection = {
  // Newest-first, exactly like the RPC: the guard's slot-coverage rule reads the
  // LAST element as the oldest one it managed to see, and getting that backwards
  // would turn "I read far enough" into "I did not".
  getSignaturesForAddress: async (key: PublicKey, o?: { limit?: number }) =>
    (histories[key.toBase58()] ?? [])
      .slice(0, o?.limit ?? 1000)
      .map((e) => (typeof e === 'string' ? { signature: e } : e)),
} as never;

const params = (over: Record<string, unknown> = {}) =>
  ({
    meta: 'meta',
    token: 'SOL',
    denomination: 1,
    leafIndex: 3,
    retailer: TREASURY,
    rate: 1n,
    intervalSlots: 100n,
    owner: OWNER,
    connection,
    signOne: async (t: never) => t,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  executeCalled = false;
  // Disjoint by default: the funder and the buyer share no transaction, which
  // is what a note bought without an on-chain payment to the funder looks like.
  histories = {
    [TREASURY.toBase58()]: ['TREASURY_TX_1', 'TREASURY_TX_2'],
    [OWNER.toBase58()]: ['WALLET_TX_1'],
    [SPEND_FUNDER.toBase58()]: ['SPEND_FUNDER_TX_1'],
  };
  // A deployment whose till and float are different addresses: the funder that
  // pays for spends has never been paid by this buyer.
  funderLookup = { state: 'configured', pubkey: SPEND_FUNDER.toBase58() };
  prepareAnswer = {
    kind: 'poolSubscribePrepare',
    jobId: 'job',
    ephemeralPubkey: Keypair.generate().publicKey.toBase58(),
    requiredLamports: 1_035_725_040,
    denomination: 1,
    derivation: 'v1',
    // A deposit is ALWAYS signed by a fresh ephemeral, so the payer is a key
    // nobody has heard of. The address that decides anything is the one that
    // funded it — see `depositFunder`.
    depositPayer: 'EPHEMERAL1111111111111111111111111111111111',
    depositFunder: TREASURY.toBase58(),
    depositSignature: 'DEPOSITSIG',
  };
});

describe('a note somebody else deposited', () => {
  it('proceeds, and reports that the buyer is not reachable through it', async () => {
    const out = await subscribeFromPool(params({ neverExposeWallet: true }));
    expect(out.reachableViaDeposit).toBe(false);
    expect(out.depositPayer).toBe(TREASURY.toBase58());
    expect(executeCalled).toBe(true);
  });
});

describe('a note deposited by a funder the wallet PAID', () => {
  // 🚨 THE SHAPE THAT PASSED THIS GUARD AND WAS STILL FINDABLE.
  //
  // MEASURED 2026-08-18, spend `4zWERbE1NPaR…`. The funder is not the wallet, so
  // every equality above is false and the guard passed. The result screen then
  // said the wallet was not reachable. It was, in two hops: the funder's own
  // history holds `21PjRyhLLg…`, SIGNED BY THE WALLET, paying it 1.003 SOL one
  // second before it financed the depositing ephemeral.
  //
  // Equality was never the question. The question is whether any transaction
  // names both — and the answer costs two `getSignaturesForAddress` calls,
  // which is precisely why an auditor runs it first.
  beforeEach(() => {
    histories = {
      [TREASURY.toBase58()]: ['TREASURY_TX_1', 'THE_PURCHASE'],
      [OWNER.toBase58()]: ['WALLET_TX_1', 'THE_PURCHASE'],
    };
  });

  it('refuses, though the funder is not the wallet', async () => {
    expect(prepareAnswer.depositFunder).not.toBe(OWNER.toBase58());
    await expect(subscribeFromPool(params({ neverExposeWallet: true }))).rejects.toBeInstanceOf(
      SelfDepositedNoteError,
    );
    expect(executeCalled).toBe(false);
  });

  it('reports it as reachable when the caller proceeds anyway', async () => {
    const out = await subscribeFromPool(params());
    expect(out.reachableViaDeposit).toBe(true);
  });
});

describe('a funder history too long to argue absence from', () => {
  // An absence read off a truncated page is not an absence, it is a shorter
  // look. Same asymmetry as everywhere else on this path: a hit is proof, an
  // absence has to be paid for in full, and an unknown is refused.
  beforeEach(() => {
    histories = {
      [TREASURY.toBase58()]: Array.from({ length: 1000 }, (_, i) => `T${i}`),
      [OWNER.toBase58()]: ['WALLET_TX_1'],
    };
  });

  it('refuses rather than call a full page clean', async () => {
    await expect(subscribeFromPool(params({ neverExposeWallet: true }))).rejects.toBeInstanceOf(
      SelfDepositedNoteError,
    );
    expect(executeCalled).toBe(false);
  });
});

describe('a note THIS wallet deposited', () => {
  beforeEach(() => {
    // 🚨 THE SHAPE THE FIRST VERSION OF THIS GUARD COULD NOT SEE. The payer
    // stays an ephemeral — it always is — and the WALLET is one hop behind it.
    // Measured on a real devnet shield: wallet BRop…TjNN, deposit payer
    // 8Eq1jsbB…. Comparing the wallet to the payer never matches, so the guard
    // passed, the screen said "your wallet did not sign or pay for this", and
    // that true sentence read as "nobody can reach me" while
    // deposit → ephemeral → funder → wallet was one RPC call away.
    prepareAnswer.depositFunder = OWNER.toBase58();
  });

  it('is not fooled by the deposit being signed by an ephemeral', () => {
    // Stated as its own case because it is the whole bug: the payer here is
    // NOT the wallet, and the note is still the wallet's.
    expect(prepareAnswer.depositPayer).not.toBe(OWNER.toBase58());
  });

  it('refuses before spending anything', async () => {
    await expect(
      subscribeFromPool(params({ neverExposeWallet: true })),
    ).rejects.toBeInstanceOf(SelfDepositedNoteError);
    // Nothing proved, nothing funded, nothing sent. The refusal lands between
    // prepare and the funding decision, so no lamport has moved.
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
    expect(executeCalled).toBe(false);
  });

  it('carries the exact `name` the panel branches on', async () => {
    // 🚨 THE CONTRACT BETWEEN THE GUARD AND THE AUTOMATIC SWAP, and it is a
    // string. `SubscribePanel` catches, checks `err.name !==
    // 'SelfDepositedNoteError'`, rethrows anything else, and otherwise fetches a
    // note this deployment deposited and retries.
    //
    // If that name ever changes — a rename, a wrapper, a minifier that mangles
    // the class — the swap silently stops happening and every buyer holding
    // their own note is refused instead of served. Nothing else fails, and the
    // refusal is a correct-looking message, so it would read as the guard
    // working rather than as the recovery being gone.
    await subscribeFromPool(params({ neverExposeWallet: true })).then(
      () => expect.unreachable('should have refused'),
      (e: Error) => expect(e.name).toBe('SelfDepositedNoteError'),
    );
  });

  it('says the right cure, which is NOT "retry later"', async () => {
    // Distinct from WalletExposureRefusedError on purpose: that one means the
    // funder is down and a retry may work. This one means no payer on earth
    // makes this note give the property asked for.
    await expect(
      subscribeFromPool(params({ neverExposeWallet: true })),
    ).rejects.toThrow(/note deposited by someone else/);
  });

  it('still proceeds when the caller did NOT ask to stay off chain', async () => {
    // The negative control. This guard must not break ordinary use: a user who
    // never asked for the property is not protected out of their subscription.
    const out = await subscribeFromPool(params({ neverExposeWallet: false }));
    expect(executeCalled).toBe(true);
    // But the fact is still REPORTED, because the result screen has to be able
    // to say which of the two worlds they ended up in.
    expect(out.reachableViaDeposit).toBe(true);
  });
});

describe('a deposit that could not be found', () => {
  beforeEach(() => {
    prepareAnswer.depositPayer = null;
    prepareAnswer.depositFunder = null;
    prepareAnswer.depositSignature = null;
  });

  it('is treated as UNKNOWN, not as safe', async () => {
    // The whole file's posture in one case: an unread channel reported clean is
    // the failure this effort exists to refuse. A leaf outside the scanned
    // window might have been deposited by anyone — including this wallet.
    await expect(
      subscribeFromPool(params({ neverExposeWallet: true })),
    ).rejects.toBeInstanceOf(SelfDepositedNoteError);
    expect(executeCalled).toBe(false);
  });

  it('explains that unknown is not the same as safe', async () => {
    await expect(
      subscribeFromPool(params({ neverExposeWallet: true })),
    ).rejects.toThrow(/not the same as a safe one/);
  });

  it('reports it as reachable when the caller proceeds anyway', async () => {
    const out = await subscribeFromPool(params({ neverExposeWallet: false }));
    expect(out.reachableViaDeposit).toBe(true);
    expect(out.depositPayer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The SPEND leg — the funder surface this file did not read until 2026-08-18
// ---------------------------------------------------------------------------

describe('the address that pays for the subscription', () => {
  // 🚨 THE HALF THE GUARD WAS MISSING WHILE THE PROBE READ BOTH.
  //
  // Everything above this line asks who funded the DEPOSIT. P11 walks the
  // funders of BOTH legs. So a deployment holding a genuinely third-party note —
  // clean on every assertion in this file — could still hand an auditor the
  // buyer through the address paying for THIS transaction.

  it('refuses when a transaction names both that funder and the wallet', async () => {
    histories = {
      [TREASURY.toBase58()]: ['TREASURY_TX_1'],
      [OWNER.toBase58()]: ['WALLET_TX_1', 'THE_PURCHASE'],
      [SPEND_FUNDER.toBase58()]: ['SPEND_FUNDER_TX_1', 'THE_PURCHASE'],
    };
    await expect(subscribeFromPool(params({ neverExposeWallet: true }))).rejects.toBeInstanceOf(
      SpendFunderNamesWalletError,
    );
    expect(executeCalled).toBe(false);
    // Refused BEFORE any money moved, like every other refusal on this path.
    expect(fundEphemeralForJob).not.toHaveBeenCalled();
  });

  it('does NOT reuse the note error name, or the panel would loop forever', async () => {
    // 🚨 THE CONTRACT WITH THE PANEL, AND IT IS A STRING. `SubscribePanel`
    // recovers from `SelfDepositedNoteError` by swapping in another note. Doing
    // that here would change nothing — the funder is the same address whichever
    // note is spent — so it would burn a fresh note per attempt and report a
    // note problem for a treasury problem.
    histories = {
      [OWNER.toBase58()]: ['THE_PURCHASE'],
      [SPEND_FUNDER.toBase58()]: ['THE_PURCHASE'],
      [TREASURY.toBase58()]: ['TREASURY_TX_1'],
    };
    await subscribeFromPool(params({ neverExposeWallet: true })).then(
      () => expect.unreachable('should have refused'),
      (e: Error) => {
        expect(e.name).toBe('SpendFunderNamesWalletError');
        expect(e.name).not.toBe('SelfDepositedNoteError');
      },
    );
  });

  it('names the cure as a deployment change, not a user action', async () => {
    histories = {
      [OWNER.toBase58()]: ['THE_PURCHASE'],
      [SPEND_FUNDER.toBase58()]: ['THE_PURCHASE'],
      [TREASURY.toBase58()]: ['TREASURY_TX_1'],
    };
    await expect(subscribeFromPool(params({ neverExposeWallet: true }))).rejects.toThrow(
      /collects payments must never be the address that funds the spends/,
    );
  });

  it('refuses when the deployment cannot say who pays', async () => {
    // Unknown is not clean. Same posture as the deposit half.
    funderLookup = { state: 'unknown', reason: 'the funder endpoint replied 502' };
    await expect(subscribeFromPool(params({ neverExposeWallet: true }))).rejects.toBeInstanceOf(
      SpendFunderNamesWalletError,
    );
  });

  it('stays out of the way when there is no funder at all', async () => {
    // No funder means the WALLET pre-funds, which is worse — and is already
    // refused by `fundEphemeralForJob` with a different, accurate cure. This
    // guard reporting it too would replace that error with a misleading one.
    funderLookup = { state: 'none' };
    const out = await subscribeFromPool(params({ neverExposeWallet: true }));
    expect(out.reachableViaSpendFunder).toBe(false);
    expect(executeCalled).toBe(true);
  });

  it('reports the exposure instead of refusing when the caller did not ask', async () => {
    histories = {
      [OWNER.toBase58()]: ['THE_PURCHASE'],
      [SPEND_FUNDER.toBase58()]: ['THE_PURCHASE'],
      [TREASURY.toBase58()]: ['TREASURY_TX_1'],
    };
    const out = await subscribeFromPool(params());
    expect(out.reachableViaSpendFunder).toBe(true);
    // The deposit leg is clean in this fixture, and it stays clean: the two
    // halves are reported separately so the screen cannot claim one from the
    // other.
    expect(out.reachableViaDeposit).toBe(false);
    expect(executeCalled).toBe(true);
  });

  it('reports both halves clean on a deployment that is actually clean', async () => {
    const out = await subscribeFromPool(params({ neverExposeWallet: true }));
    expect(out.reachableViaDeposit).toBe(false);
    expect(out.reachableViaSpendFunder).toBe(false);
    expect(executeCalled).toBe(true);
  });
});

describe('a busy funder, which is what a working deployment looks like', () => {
  // 🚨 THE REGRESSION THIS MUST NEVER BECOME.
  //
  // The first version of the join returned `null` the moment EITHER page filled.
  // A funder that has served more than a page of jobs then answers `null`
  // forever, and the guard above refuses every note for the rest of the
  // deployment's life. That is the same shape as the funder-resolution bug that
  // read the newest signatures instead of the oldest: a check that cannot pass
  // is not a check, it is an outage.
  //
  // The absence is still recoverable soundly: a transaction naming both is in
  // the WALLET's history by definition, so if the wallet's page did not fill,
  // its history is complete — and it is enough for the funder's window to reach
  // back past the wallet's first transaction.

  it('still clears a full funder page that reaches back before the wallet existed', async () => {
    histories = {
      [TREASURY.toBase58()]: ['TREASURY_TX_1'],
      // A brand-new buyer, which is exactly the recommended flow.
      [OWNER.toBase58()]: [{ signature: 'WALLET_TX_1', slot: 900 }],
      [SPEND_FUNDER.toBase58()]: Array.from({ length: 1000 }, (_, i) => ({
        signature: `F${i}`,
        slot: 1000 - i, // newest first: oldest read is slot 1, before the wallet
      })),
    };
    const out = await subscribeFromPool(params({ neverExposeWallet: true }));
    expect(out.reachableViaSpendFunder).toBe(false);
    expect(executeCalled).toBe(true);
  });

  it('still refuses when the funder page stops short of the wallet history', async () => {
    histories = {
      [TREASURY.toBase58()]: ['TREASURY_TX_1'],
      // An older wallet: the funder's window does not cover its whole life, so
      // the co-naming transaction may sit just off the end of what was read.
      [OWNER.toBase58()]: [{ signature: 'WALLET_TX_1', slot: 10 }],
      [SPEND_FUNDER.toBase58()]: Array.from({ length: 1000 }, (_, i) => ({
        signature: `F${i}`,
        slot: 5000 - i, // oldest read is slot 4001, long after the wallet's first
      })),
    };
    await expect(subscribeFromPool(params({ neverExposeWallet: true }))).rejects.toBeInstanceOf(
      SpendFunderNamesWalletError,
    );
  });

  it('a hit is still a hit, however long the page', async () => {
    histories = {
      [TREASURY.toBase58()]: ['TREASURY_TX_1'],
      [OWNER.toBase58()]: [{ signature: 'THE_PURCHASE', slot: 4500 }],
      [SPEND_FUNDER.toBase58()]: [
        { signature: 'THE_PURCHASE', slot: 4500 },
        ...Array.from({ length: 999 }, (_, i) => ({ signature: `F${i}`, slot: 4499 - i })),
      ],
    };
    await expect(subscribeFromPool(params({ neverExposeWallet: true }))).rejects.toBeInstanceOf(
      SpendFunderNamesWalletError,
    );
  });
});
