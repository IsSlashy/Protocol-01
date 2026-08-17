/**
 * Where the residual rent goes when a WITHDRAWAL ends.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * A direct mirror of `subscribeSweepTarget.test.ts`, and it exists for the same
 * reason: `sweepTo` introduces a failure mode that is silent and strictly worse
 * than not having it. Fund through the deployment's funder, then sweep home —
 * that spends someone else's ~1.03 SOL AND writes the user's wallet into the
 * newest transaction of the ephemeral's life. Nothing on chain rejects it, no
 * type catches it, and the symptom is a privacy claim that is quietly false.
 *
 * So these tests decode the bytes that would actually reach the chain rather
 * than asserting on the argument passed in. A test that reads back its own
 * input agrees with the encoder no matter what either of them does.
 *
 * ⚠️ THE CASE THAT CARRIES THE MOST WEIGHT is the last one. `ownerPubkey` means
 * THE WALLET and `sweepTo` means the money, and the refusal
 * `recipient === ownerPubkey` is justified by that split. Repurposing
 * `ownerPubkey` to carry the funder would disable that refusal silently — and
 * it is the exact line that regressed once already, paying a withdrawal's whole
 * value into the user's wallet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';

// The real withdrawal does ~150 chunk uploads. Stubbing it isolates the ONE
// thing under test — the `finally` sweep — and lets the failure path run too.
vi.mock('./denominatedPool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./denominatedPool')>()),
  unshieldDenominatedStarkV3: vi.fn(),
}));

import { unshieldDenominatedStarkV3 } from './denominatedPool';
import { executeUnshield } from './unshieldEphemeral';

const OWNER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
const FUNDER = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
/** A derived payout address — where a withdrawal is supposed to pay. */
const PAYOUT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const BLOCKHASH = SystemProgram.programId.toBase58();

/** The real withdrawal pre-fund: float only, no denomination term. */
const REQUIRED_LAMPORTS = 1_030_290_360;
const SWEEP_FEE = 5_000;

let sent: Buffer[] = [];
let ephemeral: Keypair;

function fakeConnection(): Connection {
  return {
    getBalance: async () => REQUIRED_LAMPORTS,
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    sendRawTransaction: async (raw: Buffer) => {
      sent.push(raw);
      return 'SWEEPSIG';
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
}

function ctx() {
  return {
    ephemeral,
    requiredLamports: REQUIRED_LAMPORTS,
    poolConfig: {},
    prepared: {},
    receipt: {},
  } as never;
}

function decodeSweep() {
  expect(sent).toHaveLength(1);
  const tx = Transaction.from(sent[0]!);
  expect(tx.instructions).toHaveLength(1);
  const ix = tx.instructions[0]!;
  expect(ix.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
  const data = Buffer.from(ix.data);
  expect(data.readUInt32LE(0)).toBe(2); // System Transfer
  return {
    from: ix.keys[0]!.pubkey.toBase58(),
    to: ix.keys[1]!.pubkey.toBase58(),
    lamports: Number(data.readBigUInt64LE(4)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  ephemeral = Keypair.generate();
  vi.mocked(unshieldDenominatedStarkV3).mockResolvedValue('TXSIG');
});

describe('the withdrawal sweep goes to whoever paid', () => {
  it('sweeps home when the wallet funded it — sweepTo omitted', async () => {
    await executeUnshield(ctx(), fakeConnection(), PAYOUT, OWNER, undefined);
    const sweep = decodeSweep();
    expect(sweep.to).toBe(OWNER.toBase58());
    expect(sweep.from).toBe(ephemeral.publicKey.toBase58());
    expect(sweep.lamports).toBe(REQUIRED_LAMPORTS - SWEEP_FEE);
  });

  it('sweeps to the funder when a third party funded it', async () => {
    await executeUnshield(ctx(), fakeConnection(), PAYOUT, OWNER, undefined, FUNDER);
    const sweep = decodeSweep();
    expect(sweep.to).toBe(FUNDER.toBase58());
    // Stated separately because this is THE regression: sweeping home after a
    // third party paid leaves the wallet in the ephemeral's newest transaction,
    // and the funder bought nothing.
    expect(sweep.to).not.toBe(OWNER.toBase58());
  });

  it('still repays the funder when the withdrawal itself fails', async () => {
    // The sweep is in a `finally`, and the failure path matters most: ~1.03 SOL
    // of someone else's money is on that key and the job just threw. A funder
    // repaid only on success is a funder nobody will run.
    vi.mocked(unshieldDenominatedStarkV3).mockRejectedValue(new Error('chunk upload died'));
    await expect(
      executeUnshield(ctx(), fakeConnection(), PAYOUT, OWNER, undefined, FUNDER),
    ).rejects.toThrow('chunk upload died');
    expect(decodeSweep().to).toBe(FUNDER.toBase58());
  });
});

describe('ownerPubkey is identity, sweepTo is money', () => {
  it('still refuses to pay the wallet even while the funder gets the sweep', async () => {
    // The case that catches an ownerPubkey/sweepTo confusion. If a future change
    // passed the FUNDER as ownerPubkey "because that is who gets swept", this
    // refusal would compare the recipient against the funder, never match, and
    // silently allow a withdrawal straight into the user's wallet — which is
    // what /pay shipped until 2026-08-04.
    await expect(
      executeUnshield(ctx(), fakeConnection(), OWNER, OWNER, undefined, FUNDER),
    ).rejects.toThrow(/Refusing to withdraw to the wallet/);
    // And the money still comes back: the refusal lives inside the try, so the
    // finally sweep runs. Throwing before it would strand the whole pre-fund.
    expect(decodeSweep().to).toBe(FUNDER.toBase58());
  });

  it('allows a third-party recipient, which is not the same thing', async () => {
    // Only the WALLET is refused as payee. A derived payout address — the normal
    // case — must pass, or withdrawals stop working entirely.
    await executeUnshield(ctx(), fakeConnection(), PAYOUT, OWNER, undefined, FUNDER);
    expect(unshieldDenominatedStarkV3).toHaveBeenCalled();
  });
});
