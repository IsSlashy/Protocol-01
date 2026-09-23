/**
 * close-v1, lane L3, audit v1 F05 (founder item, web mitigation): the web
 * client no longer builds a C1 + C3 spend unless the deployment opts in.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/closeV1L3C1C3SpendDisabled.test.ts
 *
 * THE FLAW (on chain, redeploy = founder). The v3 withdrawal and the v3
 * subscription verify two proofs (C1, C3) that bind neither the payee, nor the
 * new note, nor the merchant, and the proofs do not depend on who uploads them:
 * anyone who copies the public proof bytes out of the buffers can land the spend
 * first, to themselves (litesvm, 995,000,000 lamports taken). Circuit 7 (the v4
 * withdrawal and subscription) is not affected.
 *
 * THE MITIGATION PINNED HERE. Every C1 + C3 builder refuses, before any network
 * request, any proof and so before any payment or upload, unless
 * `NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND === '1'`. The refusal's message starts with
 * the stable code `C1C3_SPEND_DISABLED:` (close-v1 contract C2), which the
 * worker passes through and the panels map to their own sentence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';

import { prepareUnshieldJob } from './unshieldEphemeral';
import { prepareSubscribeJob } from './subscribeEphemeral';
import { subscribePrivateStark } from './subscribePrivateStark';
import {
  findPoolV3,
  prepareUnshield,
  unshieldDenominatedStarkV3,
  type ShieldReceipt,
} from './denominatedPool';

const pool = findPoolV3('SOL', 1)!;

/** A connection that records every request, and fails it. */
function recordingConnection() {
  const calls: string[] = [];
  const conn = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        return () => {
          calls.push(String(prop));
          return Promise.reject(new Error(`network: ${String(prop)}`));
        };
      },
    },
  ) as unknown as Connection;
  return { conn, calls };
}

const receipt = {
  secret: 11n,
  nullifierPreimage: 22n,
  noteBlinding: 33n,
  commitment: 44n,
  leafIndex: 3,
  denomination: pool.denominationAtomic,
  pool: pool.poolPDA.toBase58(),
  token: pool.token,
  denominationHuman: pool.denomination,
  shieldedAt: 0,
} as unknown as ShieldReceipt;

const signer = { publicKey: Keypair.generate().publicKey, signTransaction: async <T,>(t: T) => t } as never;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'resolved';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('F05: no C1 + C3 spend is built by default', () => {
  const cases: Array<[string, (conn: Connection) => Promise<unknown>]> = [
    ['prepareUnshieldJob (v3 withdrawal)', (conn) => prepareUnshieldJob(receipt, pool, conn, new Uint8Array(32))],
    ['prepareSubscribeJob (v3 subscription)', (conn) => prepareSubscribeJob(receipt, pool, conn, new Uint8Array(32))],
    ['prepareUnshield (C1 + C3 proving)', (conn) => prepareUnshield(receipt, pool, conn)],
    [
      'unshieldDenominatedStarkV3 (upload + withdraw)',
      (conn) => unshieldDenominatedStarkV3(receipt, pool, Keypair.generate().publicKey, {} as never, signer, conn),
    ],
    ['subscribePrivateStark (upload + subscribe)', (conn) => subscribePrivateStark({} as never, signer, conn)],
  ];

  for (const [name, run] of cases) {
    it(`${name} refuses with C1C3_SPEND_DISABLED before any request`, async () => {
      vi.stubEnv('NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND', '');
      const { conn, calls } = recordingConnection();
      const msg = await refusal(() => run(conn));
      expect(msg, `${name} did not refuse`).toMatch(/^C1C3_SPEND_DISABLED: /);
      expect(calls, `${name} reached the network first`).toEqual([]);
    });
  }

  // Not guarded: `buildTransferDenominatedStarkV3Ix`. It has no production
  // caller (its own doc comment), and the parity suite pins its wire format
  // against the deployed handler. The spends a user can reach are the four above.

  it('any value but the literal "1" keeps it off', async () => {
    for (const v of ['true', 'yes', '0', ' 1']) {
      vi.stubEnv('NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND', v);
      const { conn } = recordingConnection();
      expect(await refusal(() => prepareUnshieldJob(receipt, pool, conn, new Uint8Array(32)))).toMatch(
        /^C1C3_SPEND_DISABLED: /,
      );
    }
  });

  it('control: with the opt-in the builder goes on to the network (and fails there, in this fake)', async () => {
    vi.stubEnv('NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND', '1');
    const { conn, calls } = recordingConnection();
    const msg = await refusal(() => prepareUnshieldJob(receipt, pool, conn, new Uint8Array(32)));
    expect(msg).not.toMatch(/C1C3_SPEND_DISABLED/);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('the message says nothing was sent and names no note value', async () => {
    const { conn } = recordingConnection();
    const msg = await refusal(() => prepareUnshieldJob(receipt, pool, conn, new Uint8Array(32)));
    expect(msg).toMatch(/nothing was (proved|sent)/i);
    for (const v of ['44', '22', '11']) expect(msg).not.toContain(` ${v}`);
    expect(msg).not.toContain(new PublicKey(pool.poolPDA).toBase58());
  });
});
