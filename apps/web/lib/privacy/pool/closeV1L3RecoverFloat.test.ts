/**
 * close-v1, lane L3: Recover (`recoverFloat.ts`) after the F04 and F71 fixes.
 *
 * Run: cd apps/web && npx vitest run --config vitest.pool.config.mts lib/privacy/pool/closeV1L3RecoverFloat.test.ts
 *
 * F04 FOLLOW-UP. The F04 fix (stark.ts) made `allocateProofBuffer` step past
 * squatted addresses: public attempts 1..3, then four PRIVATE attempts derived
 * from the ephemeral's own signature. Recover still probed the pre-L2 PDA and
 * public attempt 0 only, so a run that crashed after a stranger had squatted
 * attempt 0 left its buffer (~0.5 SOL of rent, closable by the ephemeral alone)
 * where Recover never looked, while the panel said nothing was stranded.
 *
 * F71. Recover's deep scan reads one key per leaf below the head window, and
 * reported progress once, before the loop. The page's pool-job watchdog fires
 * after 180 s WITHOUT a progress message (`workerClient.ts`,
 * POOL_SILENCE_TIMEOUT_MS), so on a large tree Recover was reported as a hang
 * while it was still working, and its result was lost. The scan now reports
 * progress while it runs, which is what re-arms the watchdog.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import nacl from 'tweetnacl';

const head = vi.hoisted(() => ({ value: 0 }));
const closed = vi.hoisted(() => ({ list: [] as string[] }));
const swept = vi.hoisted(() => ({ list: [] as string[] }));

vi.mock('./shieldEphemeral', async (orig) => ({
  ...(await orig<typeof import('./shieldEphemeral')>()),
  readTreeLeafCount: vi.fn(async () => head.value),
}));
vi.mock('./stark', async (orig) => ({
  ...(await orig<typeof import('./stark')>()),
  closeStarkProofBuffer: vi.fn(async (address: PublicKey) => {
    closed.list.push(address.toBase58());
    return 'CLOSESIG';
  }),
}));
vi.mock('./sendTx', () => ({
  sendWithFreshBlockhash: vi.fn(async (_c: unknown, _tx: unknown, _s: unknown, payer: PublicKey) => {
    swept.list.push(payer.toBase58());
    return { signature: 'SWEEPSIG', blockhash: 'x', lastValidBlockHeight: 1 };
  }),
}));

import { recoverStuckFloat } from './recoverFloat';
import { deriveShieldEphemeral } from './shieldEphemeral';
import { deriveUnshieldEphemeral } from './unshieldEphemeral';
import { deriveProofBufferKeypair, deriveSecretProofBufferKeypair } from './stark';
import { CIRCUIT_MERKLE_UPDATE, CIRCUIT_SPEND, findPoolV3, type WalletSigner } from './denominatedPool';

const pool = findPoolV3('SOL', 1)!;
const seed = new Uint8Array(32).fill(7);
const owner = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;

function signerOf(kp: Keypair): WalletSigner {
  return {
    publicKey: kp.publicKey,
    signBytes: async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey),
    signTransaction: async (t) => t,
  } as WalletSigner;
}

/** A chain where exactly `buffer` holds a live proof buffer and `holder` a small balance. */
function world(buffer: PublicKey, holder: PublicKey) {
  const conn = {
    getAccountInfo: async (a: PublicKey) =>
      a.equals(buffer) && !closed.list.includes(buffer.toBase58())
        ? { lamports: 400_000_000, data: Buffer.alloc(8), owner: PublicKey.default, executable: false }
        : null,
    getBalance: async (a: PublicKey) =>
      a.equals(holder) && swept.list.length === 0 ? (closed.list.length > 0 ? 400_010_000 : 10_000) : 0,
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
  return conn;
}

beforeEach(() => {
  closed.list.length = 0;
  swept.list.length = 0;
});

describe('F04 follow-up: Recover finds a buffer at every address the allocator may have used', () => {
  for (const attempt of [0, 3]) {
    it(`a shield buffer at PRIVATE attempt ${attempt} (the public ones squatted) is closed and swept`, async () => {
      head.value = 40;
      const e = deriveShieldEphemeral(seed, pool.poolPDA, 40);
      const buffer = (await deriveSecretProofBufferKeypair(signerOf(e), CIRCUIT_MERKLE_UPDATE, attempt))!.publicKey;
      const out = await recoverStuckFloat(world(buffer, e.publicKey), pool, seed, owner, {});
      expect(closed.list, 'the buffer at a private attempt was never looked at').toEqual([buffer.toBase58()]);
      expect(out.map((f) => f.closedBuffers)).toEqual([1]);
    });
  }

  it('a shield buffer at public attempt 2 is closed', async () => {
    head.value = 40;
    const e = deriveShieldEphemeral(seed, pool.poolPDA, 38);
    const buffer = deriveProofBufferKeypair(e.publicKey, CIRCUIT_MERKLE_UPDATE, 2).publicKey;
    await recoverStuckFloat(world(buffer, e.publicKey), pool, seed, owner, {});
    expect(closed.list).toEqual([buffer.toBase58()]);
  });

  it('a spend (circuit 7) buffer at a private attempt of a named note is closed', async () => {
    head.value = 40;
    const e = deriveUnshieldEphemeral(seed, pool.poolPDA, 5);
    const buffer = (await deriveSecretProofBufferKeypair(signerOf(e), CIRCUIT_SPEND, 1))!.publicKey;
    await recoverStuckFloat(world(buffer, e.publicKey), pool, seed, owner, { unshieldLeafIndices: [5] });
    expect(closed.list).toEqual([buffer.toBase58()]);
  });
});

describe('F71: a long Recover keeps the silence watchdog armed', () => {
  it('on a 3,000-leaf tree at one second per read, no silence reaches the 180 s watchdog', async () => {
    head.value = 3000;
    let clock = 1_700_000_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const stranded = deriveShieldEphemeral(seed, pool.poolPDA, 0);
    const conn = {
      getAccountInfo: async () => {
        clock += 1000;
        return null;
      },
      getBalance: async (a: PublicKey) => {
        clock += 1000;
        return a.equals(stranded.publicKey) && swept.list.length === 0 ? 1_020_000_000 : 0;
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    } as unknown as Connection;
    const beats: number[] = [];
    const start = clock;
    try {
      const out = await recoverStuckFloat(conn, pool, seed, owner, { onProgress: () => beats.push(clock) });
      expect(out.map((f) => f.leafIndex)).toEqual([0]);
    } finally {
      spy.mockRestore();
    }
    const marks = [start, ...beats, clock];
    let longest = 0;
    for (let i = 1; i < marks.length; i++) longest = Math.max(longest, marks[i]! - marks[i - 1]!);
    expect(longest, `the longest silence was ${longest / 1000} s`).toBeLessThan(60_000);
  });
});
