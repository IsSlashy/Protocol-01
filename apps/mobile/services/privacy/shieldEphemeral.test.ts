/**
 * Guards for the shield depositor.
 *
 * Two things can lose money here and both are asserted:
 *   1. E not re-derivable  → a crash between pre-fund and shield strands the
 *      full denomination.
 *   2. E under-funded      → the shield fails AFTER the 145 KB proof upload,
 *      with the denomination already sitting on E.
 *
 * The third assertion is the one the whole task is about: E must not be the
 * user's wallet.
 */
import { describe, it, expect, vi } from 'vitest';
import { Keypair as SolKeypair, PublicKey } from '@solana/web3.js';

import {
  computeShieldPrefundLamports,
  deriveShieldEphemeral,
  E_TX_FEE_BUDGET,
  resumeShieldPrefund,
  SHIELD_RENT_MARGIN,
  RELAYER_TOPUP,
  shieldProtocolFee,
} from './shieldEphemeral';

const SEED = new Uint8Array(32).fill(3);
const OTHER_SEED = new Uint8Array(32).fill(4);
const POOL = new PublicKey('9CvrqUAeqEbYbfvQDrHK7TnbaSGCsRPKb2SkAULhSarQ');
const OTHER_POOL = new PublicKey('AnBmWYRKGmcPSVTSgYZJeFgqaHmyLTzT1VJbmejXVSib');

describe('deriveShieldEphemeral', () => {
  it('is a pure function of (seed, pool, counter) — the whole recovery story', () => {
    const a = deriveShieldEphemeral(SEED, POOL, 16);
    const b = deriveShieldEphemeral(SEED, POOL, 16);
    expect(a.publicKey.toBase58()).toBe(b.publicKey.toBase58());
  });

  it('is NOT the wallet — the deposit stops naming the user as depositor', () => {
    // The wallet keypair in this app is Keypair.fromSeed(noteSeed): noteSeed is
    // secretKey[0..32). If E ever equalled that, the fix would be a no-op.
    const wallet = SolKeypair.fromSeed(SEED);
    const e = deriveShieldEphemeral(SEED, POOL, 16);
    expect(e.publicKey.toBase58()).not.toBe(wallet.publicKey.toBase58());
  });

  it('separates pools and counters', () => {
    const base = deriveShieldEphemeral(SEED, POOL, 16).publicKey.toBase58();
    expect(deriveShieldEphemeral(SEED, POOL, 17).publicKey.toBase58()).not.toBe(base);
    expect(deriveShieldEphemeral(SEED, OTHER_POOL, 16).publicKey.toBase58()).not.toBe(base);
    expect(deriveShieldEphemeral(OTHER_SEED, POOL, 16).publicKey.toBase58()).not.toBe(base);
  });

  it('rejects a short seed and a negative counter rather than deriving junk', () => {
    expect(() => deriveShieldEphemeral(new Uint8Array(8), POOL, 0)).toThrow(/too short/);
    expect(() => deriveShieldEphemeral(SEED, POOL, -1)).toThrow(/non-negative/);
  });
});

describe('computeShieldPrefundLamports', () => {
  const bufferRent = 1_010_000_000;

  it('covers denomination + 0.3% protocol fee + buffer rent + fees + margin', () => {
    const denom = 1_000_000_000n; // 1 SOL
    const total = computeShieldPrefundLamports({
      denominationAtomic: denom,
      bufferRent,
      relayerEnabled: false,
    });
    expect(total).toBe(
      1_000_000_000 + 3_000_000 + bufferRent + E_TX_FEE_BUDGET + SHIELD_RENT_MARGIN,
    );
  });

  it('does not lose the protocol fee at large denominations', () => {
    // The 0.3% fee on 10 SOL is 0.03 SOL — bigger than the whole rent margin,
    // so a pre-fund that omits it fails the shield after the proof upload.
    expect(shieldProtocolFee(10_000_000_000n)).toBe(30_000_000);
    expect(shieldProtocolFee(10_000_000_000n)).toBeGreaterThan(SHIELD_RENT_MARGIN);
  });

  it('adds the relayer top-up only when the relayer is on', () => {
    const off = computeShieldPrefundLamports({
      denominationAtomic: 100_000_000n,
      bufferRent,
      relayerEnabled: false,
    });
    const on = computeShieldPrefundLamports({
      denominationAtomic: 100_000_000n,
      bufferRent,
      relayerEnabled: true,
    });
    expect(on - off).toBe(RELAYER_TOPUP);
  });
});

describe('resumeShieldPrefund', () => {
  const funder = SolKeypair.fromSeed(new Uint8Array(32).fill(1));
  const ephemeral = SolKeypair.fromSeed(new Uint8Array(32).fill(2));

  function fakeConnection(balances: number[]) {
    let i = 0;
    return {
      getBalance: vi.fn(async () => balances[Math.min(i++, balances.length - 1)]),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: 'bh' })),
      sendRawTransaction: vi.fn(async () => 'sig'),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    } as any;
  }

  it('funds nothing when a crashed attempt already left the money on E', async () => {
    const conn = fakeConnection([2_000_000_000]);
    const out = await resumeShieldPrefund(conn, funder, ephemeral, 1_500_000_000);
    expect(out.fundedLamports).toBe(0);
    expect(out.signature).toBeNull();
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('tops up only the shortfall on a partially funded E', async () => {
    const conn = fakeConnection([400_000_000, 1_000_000_000]);
    const out = await resumeShieldPrefund(conn, funder, ephemeral, 1_000_000_000);
    expect(out.fundedLamports).toBe(600_000_000);
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses to fund when the balance cannot be read (would double-spend)', async () => {
    const conn = {
      getBalance: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      sendRawTransaction: vi.fn(),
    } as any;
    await expect(
      resumeShieldPrefund(conn, funder, ephemeral, 1_000),
    ).rejects.toThrow(/refusing to fund blindly/);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });
});
