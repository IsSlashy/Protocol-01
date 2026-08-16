/**
 * Withdrawal payout addresses — derivation gate + the pre-funder refusal.
 *
 * Run: cd apps/web && pnpm test:pool
 * (`pnpm test` only includes `__tests__/**`, and its jsdom setup replaces
 * @solana/web3.js with a stub that has no `Keypair`. These assertions are about
 * real Ed25519 keys and real transaction bytes, so they belong in the node
 * suite — see vitest.pool.config.mts.)
 *
 * WHAT IS ACTUALLY AT RISK HERE
 * ─────────────────────────────
 * Two different failure modes, both of which have already shipped somewhere in
 * this repo:
 *
 * 1. A payout key derived from PUBLIC values. Mobile derives its per-note
 *    stealth signer as `hmac(sha256, walletAddr, 'stealth_unshield_v3_' + noteId)`
 *    (apps/mobile/stores/denominatedPoolStore.ts:1545) — both inputs public, so
 *    the private key is recomputable by anyone watching the chain. The tests
 *    below pin that the address moves when the SECRET root moves and that it is
 *    NOT a function of the public (pool, leaf) pair alone.
 *
 * 2. The withdrawal naming the wallet. `PoolPanel.tsx` passed `owner` as the
 *    recipient until 2026-08-04, so the payout landed in the connected wallet by
 *    name. `executeUnshield` now refuses that — and the refusal has to happen
 *    where the ~1 SOL pre-fund still gets swept home, because the pre-fund has
 *    already landed by the time the function runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
} from '@solana/web3.js';

// The pool module is a heavy import (wasm prover, RPC builders) and none of it
// is under test here. Only the three functions unshieldEphemeral actually calls.
const unshieldDenominatedStarkV3 = vi.fn();
vi.mock('./denominatedPool', () => ({
  isNullifierSpent: vi.fn(),
  prepareUnshield: vi.fn(),
  unshieldDenominatedStarkV3: (...args: unknown[]) => unshieldDenominatedStarkV3(...args),
}));
vi.mock('./unshieldFromPath', () => ({ prepareUnshieldFromPath: vi.fn() }));
// shieldClient's only other import is the main-thread worker bridge, which
// pulls the whole pay-core stealth stack. The payout derivation touches none of
// it.
vi.mock('../workerClient', () => ({ poolRequest: vi.fn() }));

import { executeUnshield, type PreparedUnshield } from './unshieldEphemeral';
import {
  buildPoolPayoutMessage,
  derivePoolPayoutKeypair,
  derivePoolPayoutRoot,
} from '../shieldClient';
import { buildDerivationMessage } from '../message';

const POOL_A = new PublicKey('11111111111111111111111111111112');
const POOL_B = new PublicKey('11111111111111111111111111111113');

function rootFrom(byte: number): Uint8Array {
  return derivePoolPayoutRoot(new Uint8Array(64).fill(byte));
}

describe('payout address derivation', () => {
  it('is deterministic in (root, pool, leaf) — the whole recovery story', () => {
    const a = derivePoolPayoutKeypair(rootFrom(7), POOL_A, 16);
    const b = derivePoolPayoutKeypair(rootFrom(7), POOL_A, 16);
    expect(a.publicKey.toBase58()).toBe(b.publicKey.toBase58());
  });

  it('accepts the pool as base58 or PublicKey, identically', () => {
    const root = rootFrom(7);
    expect(derivePoolPayoutKeypair(root, POOL_A, 16).publicKey.toBase58()).toBe(
      derivePoolPayoutKeypair(root, POOL_A.toBase58(), 16).publicKey.toBase58(),
    );
  });

  it('gives every note its own address', () => {
    const root = rootFrom(7);
    const seen = new Set(
      [0, 1, 2, 16, 4_000_000_000].map(
        (leaf) => derivePoolPayoutKeypair(root, POOL_A, leaf).publicKey.toBase58(),
      ),
    );
    expect(seen.size).toBe(5);
  });

  it('separates pools, so the same leaf index in two pools is two addresses', () => {
    const root = rootFrom(7);
    expect(derivePoolPayoutKeypair(root, POOL_A, 16).publicKey.toBase58()).not.toBe(
      derivePoolPayoutKeypair(root, POOL_B, 16).publicKey.toBase58(),
    );
  });

  /**
   * The mobile bug, stated as a test: an attacker holding only the public
   * (pool, leaf) pair must not reach the key. Here that is expressed as "a
   * different secret root over the same public inputs yields a different
   * address" — if the derivation ever stopped consuming the root, this fails.
   */
  it('is a function of the SECRET root, not of the public (pool, leaf) pair', () => {
    const withRoot7 = derivePoolPayoutKeypair(rootFrom(7), POOL_A, 16).publicKey.toBase58();
    const withRoot8 = derivePoolPayoutKeypair(rootFrom(8), POOL_A, 16).publicKey.toBase58();
    expect(withRoot7).not.toBe(withRoot8);
  });

  it('refuses a nonsense leaf index rather than deriving something un-re-derivable', () => {
    const root = rootFrom(7);
    expect(() => derivePoolPayoutKeypair(root, POOL_A, -1)).toThrow(/Refusing/);
    expect(() => derivePoolPayoutKeypair(root, POOL_A, 1.5)).toThrow(/Refusing/);
  });

  /**
   * The payout root lives on the MAIN THREAD while the pool seed lives in the
   * Worker. If the two messages ever converged, a leak of the payout signature
   * would hand over every note secret as well.
   */
  it('signs a different message than the identity derivation', () => {
    const walletPubkey = POOL_A.toBase58();
    const payout = buildPoolPayoutMessage({ walletPubkey, origin: 'https://example.test' });
    const identity = buildDerivationMessage({
      walletPubkey,
      origin: 'https://example.test',
      chainTag: 'solana:devnet',
    });
    expect(payout).not.toBe(identity);
    expect(payout).toContain('https://example.test');
    expect(payout).toContain(walletPubkey);
  });
});

// ---------------------------------------------------------------------------

interface FakeConnection {
  sent: Uint8Array[];
  conn: Connection;
}

function fakeConnection(ephemeralBalance: number): FakeConnection {
  const sent: Uint8Array[] = [];
  const conn = {
    getBalance: vi.fn().mockResolvedValue(ephemeralBalance),
    getLatestBlockhash: vi
      .fn()
      .mockResolvedValue({ blockhash: POOL_A.toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: vi.fn(async (raw: Uint8Array) => {
      sent.push(raw);
      return 'sweep-sig';
    }),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  } as unknown as Connection;
  return { sent, conn };
}

function preparedFor(ephemeral: Keypair): PreparedUnshield {
  return {
    jobId: 'unshield:test:16',
    poolConfig: { poolPDA: POOL_A, denomination: 1 } as PreparedUnshield['poolConfig'],
    receipt: {} as PreparedUnshield['receipt'],
    ephemeral,
    requiredLamports: 1_000_000,
    rawRequiredLamports: 1_000_000,
    prepared: {} as PreparedUnshield['prepared'],
  };
}

describe('executeUnshield — the pre-funder may not be the payee', () => {
  beforeEach(() => {
    unshieldDenominatedStarkV3.mockReset();
    unshieldDenominatedStarkV3.mockResolvedValue('unshield-sig');
  });

  it('pays a recipient that is not the pre-funder', async () => {
    const ephemeral = Keypair.generate();
    const owner = Keypair.generate().publicKey;
    const payout = Keypair.generate().publicKey;
    const { conn } = fakeConnection(2_000_000);

    const out = await executeUnshield(preparedFor(ephemeral), conn, payout, owner);

    expect(out.txSig).toBe('unshield-sig');
    // 3rd positional arg of unshieldDenominatedStarkV3 is the recipient.
    expect(
      (unshieldDenominatedStarkV3.mock.calls[0][2] as PublicKey).toBase58(),
    ).toBe(payout.toBase58());
  });

  it('refuses when the recipient IS the wallet that pre-funded the ephemeral', async () => {
    const ephemeral = Keypair.generate();
    const owner = Keypair.generate().publicKey;
    const { conn } = fakeConnection(2_000_000);

    await expect(
      executeUnshield(preparedFor(ephemeral), conn, owner, owner),
    ).rejects.toThrow(/Refusing to withdraw to the wallet that funded this withdrawal/);

    // And it refuses BEFORE spending anything: no proof upload, no unshield.
    expect(unshieldDenominatedStarkV3).not.toHaveBeenCalled();
  });

  /**
   * The refusal is worthless if it strands the money. By the time
   * `executeUnshield` runs, the wallet has already moved ~1 SOL onto the
   * ephemeral (`shieldClient.unshieldFromPool` funds it and waits for the
   * confirmation), and only the ephemeral can ever move it again. So the throw
   * must happen inside the `try`, with the `finally` sweep still running.
   */
  it('still sweeps the pre-fund home when it refuses', async () => {
    const ephemeral = Keypair.generate();
    const owner = Keypair.generate().publicKey;
    const { sent, conn } = fakeConnection(2_000_000);

    await expect(
      executeUnshield(preparedFor(ephemeral), conn, owner, owner),
    ).rejects.toThrow(/Refusing/);

    expect(sent).toHaveLength(1);
    const sweep = Transaction.from(Buffer.from(sent[0]));
    expect(sweep.feePayer?.toBase58()).toBe(ephemeral.publicKey.toBase58());
    const keys = sweep.instructions[0].keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(ephemeral.publicKey.toBase58());
    expect(keys).toContain(owner.toBase58());
    // 2_000_000 balance minus the sweep's own 5_000 fee — the account lands on
    // zero, which is the only residue a 0-data system account may hold.
    expect(sweep.instructions[0].data.readBigUInt64LE(4)).toBe(1_995_000n);
  });
});
