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
vi.mock('./ephemeralFunder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ephemeralFunder')>()),
  fundEphemeralForJob: vi.fn(async () => ({
    fundedBy: 'funder' as const,
    sweepTo: TREASURY.toBase58(),
  })),
}));

import { fundEphemeralForJob } from './ephemeralFunder';
import { SelfDepositedNoteError, subscribeFromPool } from '../shieldClient';

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
    connection: {} as never,
    signOne: async (t: never) => t,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  executeCalled = false;
  prepareAnswer = {
    kind: 'poolSubscribePrepare',
    jobId: 'job',
    ephemeralPubkey: Keypair.generate().publicKey.toBase58(),
    requiredLamports: 1_035_725_040,
    denomination: 1,
    derivation: 'v1',
    depositPayer: TREASURY.toBase58(),
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

describe('a note THIS wallet deposited', () => {
  beforeEach(() => {
    prepareAnswer.depositPayer = OWNER.toBase58();
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
