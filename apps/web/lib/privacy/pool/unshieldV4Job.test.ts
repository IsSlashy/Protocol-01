/**
 * The two guards on the circuit-7 withdrawal job, and WHEN they fire.
 *
 * The v3 job can only refuse a bad payee inside `executeUnshield`, because that
 * is the first moment it knows one: a C1 + C3 proof names no recipient. Circuit
 * 7 binds `sha256(recipient)` into four of its six public inputs, so the payee
 * is an INPUT to proving — which means the same refusal can be made before any
 * work happens instead of after.
 *
 * That is not a style preference. Proving a C7 spend takes about 5.5 seconds in
 * Node and produces 77,965 bytes that then have to be uploaded in 78 chunks
 * against a rented buffer. Refusing after all of that returns the same answer
 * and costs a real upload.
 *
 * ⚠️ These tests deliberately reach the guard WITHOUT a connection, a wallet
 * seed or a pool. That is only possible because the guard is the first
 * statement in the function, ahead of every `await`. If someone moves an RPC
 * read above it, these tests start failing with a network error rather than the
 * assertion — which is the correct signal, and the reason they pass `null` for
 * everything they do not need.
 */
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';

import { prepareUnshieldJobV4, executeUnshieldV4, type PreparedUnshieldV4 } from './unshieldEphemeral';
import type { PoolConfig, ShieldReceipt } from './denominatedPool';

const WALLET = Keypair.generate().publicKey;
const ELSEWHERE = Keypair.generate().publicKey;

/** Enough shape to reach the guard, and nothing beyond it. */
const RECEIPT = { leafIndex: 7 } as unknown as ShieldReceipt;
const POOL = { poolPDA: Keypair.generate().publicKey } as unknown as PoolConfig;
const NO_CONNECTION = null as unknown as Connection;
const NO_SEED = new Uint8Array(32);

describe('the circuit-7 withdrawal refuses its own funder', () => {
  it('refuses BEFORE proving when the payee is the wallet that pre-funded it', async () => {
    // No connection is passed, so if this resolves — or rejects for any reason
    // other than the guard — the guard has moved below an await.
    await expect(
      prepareUnshieldJobV4(RECEIPT, WALLET, WALLET, POOL, NO_CONNECTION, NO_SEED),
    ).rejects.toThrow(/Refusing to withdraw to the wallet that funded this withdrawal/);
  });

  it('says WHAT to do instead, because a refusal nobody can act on gets deleted', async () => {
    await expect(
      prepareUnshieldJobV4(RECEIPT, WALLET, WALLET, POOL, NO_CONNECTION, NO_SEED),
    ).rejects.toThrow(/derived payout address/);
  });

  it('does not refuse a third-party payee — only the pre-funder', async () => {
    // This must get PAST the guard. With no connection it then fails on the
    // unspent-note read, which is exactly the proof that the guard let it
    // through: a different error, from a later line.
    await expect(
      prepareUnshieldJobV4(RECEIPT, ELSEWHERE, WALLET, POOL, NO_CONNECTION, NO_SEED),
    ).rejects.not.toThrow(/Refusing to withdraw/);
  });

  /**
   * The execute half restates the refusal. It is exported, so a future caller
   * may hold a context it did not prepare — and this is one comparison standing
   * against a defect that has already shipped once, in `/pay`, until
   * 2026-08-04.
   */
  it('restates the refusal at execute, for a context it did not prepare', async () => {
    const ctx = {
      ephemeral: Keypair.generate(),
      poolConfig: POOL,
      receipt: RECEIPT,
      recipient: WALLET,
      requiredLamports: 1,
      rawRequiredLamports: 1,
      prepared: {} as PreparedUnshieldV4['prepared'],
      jobId: 'x',
    } satisfies PreparedUnshieldV4;

    await expect(executeUnshieldV4(ctx, NO_CONNECTION, WALLET)).rejects.toThrow(
      /Refusing to withdraw to the wallet that funded this withdrawal/,
    );
  });
});

describe('the v4 job is distinguishable from the v3 one', () => {
  /**
   * The job id is what a resumed or crashed run is keyed on. If v3 and v4 minted
   * the same id for the same note, a half-finished v3 job could be resumed as a
   * v4 one — different proof, different buffer count, different float. The
   * prefix is the whole defence and it is one word.
   */
  it('mints a job id that cannot collide with the v3 job for the same note', () => {
    const v4Prefix = 'unshield-v4:';
    const v3Prefix = 'unshield:';
    expect(v4Prefix.startsWith(v3Prefix)).toBe(false);
    expect(v3Prefix.startsWith(v4Prefix)).toBe(false);

    // And the source really does use them, so this is not two string literals
    // agreeing with each other in a vacuum.
    const src = readSource();
    expect(src).toContain('`unshield-v4:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}`');
    expect(src).toContain('`unshield:${poolConfig.poolPDA.toBase58()}:${receipt.leafIndex}`');
  });
});

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(__dirname, 'unshieldEphemeral.ts'), 'utf8');
}
