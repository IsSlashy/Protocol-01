/**
 * Where the residual rent goes when a subscribe job ends.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * A pool job is signed by a fresh ephemeral key, funded by someone, and swept
 * back to someone when it ends. Those two transfers are ordinary public
 * `SystemProgram::transfer`s, and they are the two ends of the ephemeral's
 * entire life — which is exactly what `verify/p01-verify.mjs` probe P6 reads.
 * Measured on the recorded devnet fixture: three RPC calls take a stranger from
 * a subscription to the buyer's wallet, with no proof read and no commitment
 * matched.
 *
 * `sweepTo` exists so a third party can pay instead. The failure mode it
 * introduces is silent and strictly worse than not having it: fund through a
 * relayer, then sweep home. That spends someone else's ~1.03 SOL AND writes the
 * user's wallet into the newest transaction of the ephemeral's life, so P6 stays
 * red and the relayer bought nothing. Nothing on chain rejects it, no type
 * catches it, and the symptom is a privacy claim that is quietly false.
 *
 * So these tests decode the bytes that would actually reach the chain, rather
 * than asserting on the argument that was passed in. A test that reads back its
 * own input agrees with the encoder no matter what either of them does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';

// The real subscribe does ~150 chunk uploads. Stubbing it isolates the ONE thing
// under test — the `finally` sweep — and lets the failure path be exercised too.
vi.mock('./subscribePrivateStark', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./subscribePrivateStark')>()),
  subscribePrivateStark: vi.fn(),
}));

import { subscribePrivateStark } from './subscribePrivateStark';
import { executeSubscribe } from './subscribeEphemeral';

const OWNER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
const FUNDER = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
const RETAILER = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const VAULT = new PublicKey('SysvarRent111111111111111111111111111111111');
// 32 zero bytes in base58 — a syntactically valid blockhash, which is all the
// Transaction encoder needs.
const BLOCKHASH = SystemProgram.programId.toBase58();

// The real pre-fund, measured on devnet. `executeSubscribe` reads the balance
// twice — once to refuse an underfunded signer before spending ~150 uploads,
// once in the `finally` to size the sweep — so this must clear
// `requiredLamports` or the first check throws and the test measures the wrong
// error.
const REQUIRED_LAMPORTS = 1_035_725_040;
const EPHEMERAL_BALANCE = REQUIRED_LAMPORTS;
const SWEEP_FEE = 5_000;

let sent: Buffer[] = [];
let ephemeral: Keypair;

function fakeConnection(): Connection {
  return {
    getBalance: async () => EPHEMERAL_BALANCE,
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

function params(overrides: Record<string, unknown> = {}) {
  return {
    ownerPubkey: OWNER,
    retailer: RETAILER,
    rate: 30_000_000n,
    intervalSlots: 6_480_000n,
    subscriberCommitment: 1n,
    vkHashSubscriber: new Uint8Array(32),
    ...overrides,
  } as never;
}

/** Decode the one transaction the fake connection was handed, back into a transfer. */
function decodeSweep() {
  expect(sent).toHaveLength(1);
  const tx = Transaction.from(sent[0]!);
  expect(tx.instructions).toHaveLength(1);
  const ix = tx.instructions[0]!;
  expect(ix.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
  const data = Buffer.from(ix.data);
  // System instruction 2 = Transfer, then u64 lamports, both little-endian.
  expect(data.readUInt32LE(0)).toBe(2);
  return {
    from: ix.keys[0]!.pubkey.toBase58(),
    to: ix.keys[1]!.pubkey.toBase58(),
    lamports: Number(data.readBigUInt64LE(4)),
  };
}

beforeEach(() => {
  // Call history accumulates across tests otherwise, and the zero-interval case
  // asserts on it — without this it reads the PREVIOUS tests' calls and passes
  // or fails for reasons that have nothing to do with the interval check.
  vi.clearAllMocks();
  sent = [];
  ephemeral = Keypair.generate();
  vi.mocked(subscribePrivateStark).mockResolvedValue({ txSig: 'TXSIG', vaultPDA: VAULT });
});

describe('the sweep goes to whoever paid', () => {
  it('sweeps home when the wallet funded the job', async () => {
    await executeSubscribe(ctx(), fakeConnection(), params());
    const sweep = decodeSweep();
    expect(sweep.to).toBe(OWNER.toBase58());
    expect(sweep.from).toBe(ephemeral.publicKey.toBase58());
    expect(sweep.lamports).toBe(EPHEMERAL_BALANCE - SWEEP_FEE);
  });

  it('sweeps to the funder when a third party funded the job', async () => {
    await executeSubscribe(ctx(), fakeConnection(), params({ sweepTo: FUNDER }));
    const sweep = decodeSweep();
    expect(sweep.to).toBe(FUNDER.toBase58());
    // The negative half, stated separately: this is THE regression. A sweep home
    // after a third party paid leaves the wallet in the ephemeral's newest
    // transaction and P6 stays red.
    expect(sweep.to).not.toBe(OWNER.toBase58());
  });

  it('still sweeps to the funder when the subscribe itself fails', async () => {
    // The sweep lives in a `finally`, and the failure path is the one that
    // matters most: ~1.03 SOL of someone else's money is on that key, and the
    // job just threw. A funder that only gets repaid on success is a funder
    // nobody will run.
    vi.mocked(subscribePrivateStark).mockRejectedValue(new Error('chunk upload died'));
    await expect(executeSubscribe(ctx(), fakeConnection(), params({ sweepTo: FUNDER }))).rejects.toThrow(
      'chunk upload died',
    );
    expect(decodeSweep().to).toBe(FUNDER.toBase58());
  });

  it('refuses a zero interval before spending the pre-fund, and still returns the money', async () => {
    // `require!(interval_slots > 0)` is the first line of the on-chain handler.
    // Catching it client-side saves ~150 uploads — but only if the sweep still
    // runs, which is why the check sits inside the try.
    await expect(
      executeSubscribe(ctx(), fakeConnection(), params({ sweepTo: FUNDER, intervalSlots: 0n })),
    ).rejects.toThrow(/interval/i);
    expect(subscribePrivateStark).not.toHaveBeenCalled();
    expect(decodeSweep().to).toBe(FUNDER.toBase58());
  });
});
