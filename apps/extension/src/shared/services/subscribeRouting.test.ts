// @vitest-environment node
/**
 * WHICH SUBSCRIBE CIRCUIT THIS SERVICE ACTUALLY RUNS, AND WHAT IT REFUSES FIRST.
 *
 * The twin of `store/unshieldRouting.test.ts`, for `subscribePrivate`. Every
 * routing claim below is made by calling `subscribePrivate` and looking at
 * which function ran — never by scanning the source for a branch that exists.
 * apps/web learned why the expensive way: for a few hours its v3 branch was
 * dead code in production, and every source-level test stayed green.
 *
 * WHAT IT DOES NOT MEASURE, said plainly. The prover, the upload and the send
 * are mocked, so nothing here proves a circuit-7 proof verifies, that the
 * instruction is well formed (`subscribeV4.test.ts`, `subscribeV4AccountOrder.test.ts`),
 * or that the deployed program accepts a subscribe built on this surface — it
 * has not sent one.
 *
 * 🚨 AND THE CIRCUIT-7 ROUTE ON THIS SURFACE IS NOT ANONYMITY. The user's own
 * wallet uploads the buffer and signs the subscribe. Circuit 7 removes the
 * commitment from the wire; it does not remove the depositor's signature.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

const svc = vi.hoisted(() => ({
  findPoolV3: vi.fn(),
  isNullifierSpent: vi.fn(),
  prepareUnshield: vi.fn(),
  prepareSubscribeV4: vi.fn(),
  subscribePrivateStarkV4: vi.fn(),
  submitAndVerifyStarkProof: vi.fn(),
  closeStarkProofBuffer: vi.fn(),
  saveSecret: vi.fn(),
  recordVaultTag: vi.fn(),
  saveLicense: vi.fn(),
  sendRawTransaction: vi.fn(),
}));

/** ⚠️ SPREAD THE REAL MODULES, DO NOT REPLACE THEM. `V4Unprovable` must be
 *  the class the real service throws, or the routing here is on a class the
 *  service never throws while every test still passes. */
vi.mock('./denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./denominatedPool')>();
  return {
    ...actual,
    findPoolV3: svc.findPoolV3,
    isNullifierSpent: svc.isNullifierSpent,
    prepareUnshield: svc.prepareUnshield,
  };
});
vi.mock('./subscribePrivateStarkV4', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subscribePrivateStarkV4')>();
  return {
    ...actual,
    prepareSubscribeV4: svc.prepareSubscribeV4,
    subscribePrivateStarkV4: svc.subscribePrivateStarkV4,
  };
});
vi.mock('./stark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stark')>();
  return {
    ...actual,
    submitAndVerifyStarkProof: svc.submitAndVerifyStarkProof,
    closeStarkProofBuffer: svc.closeStarkProofBuffer,
  };
});
vi.mock('../store/subscriptionVault', () => ({
  useSubscriptionVaultStore: { getState: () => ({ saveSecret: svc.saveSecret }) },
}));
vi.mock('../store/license', () => ({
  useLicenseStore: {
    getState: () => ({ recordVaultTag: svc.recordVaultTag, saveLicense: svc.saveLicense }),
  },
}));
/** A connection with just enough for the v3 leg's direct send. A blockhash is
 *  any 32-byte base58 string, so a pubkey serves. */
vi.mock('./wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wallet')>();
  return {
    ...actual,
    getConnection: () => ({
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1,
      }),
      sendRawTransaction: svc.sendRawTransaction,
      confirmTransaction: async () => ({ value: { err: null } }),
    }),
  };
});

/** The wallet store persists through `src/shared/storage.ts`, which falls back
 *  to `localStorage` — absent under node. A plain state holder is all
 *  `createWalletSigner()` reads. */
vi.mock('../store/wallet', () => ({
  useWalletStore: {
    getState: () => walletState.current,
    setState: (s: Record<string, unknown>) => { walletState.current = { ...walletState.current, ...s }; },
  },
}));
const walletState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

import { V4Unprovable, type ShieldReceipt } from './denominatedPool';
import { subscribePrivate } from './subscriptionVault';
import { useWalletStore } from '../store/wallet';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET = Keypair.generate();
const RETAILER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const POOL = {
  token: 'SOL' as const,
  denomination: 1,
  denominationHuman: 1,
  decimals: 9,
  poolPDA: new PublicKey('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS'),
  treePDA: new PublicKey('GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi'),
  tokenMint: new PublicKey('11111111111111111111111111111111'),
};

/** MEASURED 2026-08-26: the live epoch is slot/7200 = 67,838. Five digits.
 *  That is what a pre-blinding note carries in `depositEpoch`. */
const EPOCH_BLINDED = 67838n;
/** What `deriveNoteBlinding` produces instead: a 63-bit PRF draw. */
const PRF_BLINDED = 7284991002338477113n;

function receipt(depositEpoch: bigint): ShieldReceipt {
  return {
    secret: 11n,
    nullifierPreimage: 22n,
    depositEpoch,
    tokenMint: 0n,
    commitment: 1234567890123456789n,
    leafIndex: 30,
    denomination: 1_000_000_000n,
    pool: POOL.poolPDA.toBase58(),
    token: 'SOL',
    denominationHuman: 1,
    shieldedAt: 0,
  };
}

function subscribe(r: ShieldReceipt, over: { serviceId?: string; onProgress?: (s: string) => void } = {}) {
  return subscribePrivate({
    receipt: r,
    poolPDA: POOL.poolPDA.toBase58(),
    treePDA: POOL.treePDA.toBase58(),
    retailer: RETAILER,
    rate: 100_000_000n,
    intervalSlots: 216_000n,
    subscriberOwnershipCommitment: 0x0fedcba987654321n,
    vkHashSubscriber: new Uint8Array(32),
    ...over,
  });
}

const PREPARED_V3 = {
  c1ProofResult: { proofBytes: new Uint8Array(4), publicInputs: [1n, 2n], proofSize: 4 },
  c3ProofResult: { proofBytes: new Uint8Array(4), publicInputs: [1n, 2n, 3n], proofSize: 4 },
  merkleRoot: 1n,
  nullifierGoldilocks: 2n,
  starkCommitment: 3n,
  subtreeRoot: 4n,
  siblings: [5n, 6n, 7n, 8n],
  directions: [0, 0, 0, 0],
};

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.setState({
    publicKey: WALLET.publicKey.toBase58(),
    network: 'devnet',
    _keypair: WALLET as never,
  });
  svc.findPoolV3.mockReturnValue(POOL);
  svc.isNullifierSpent.mockResolvedValue(false);
  svc.saveSecret.mockResolvedValue(undefined);
  svc.prepareSubscribeV4.mockResolvedValue({ v4: 'prepared' });
  svc.subscribePrivateStarkV4.mockResolvedValue({ txSig: 'SIG_V4', vaultPDA: POOL.poolPDA });
  svc.prepareUnshield.mockResolvedValue(PREPARED_V3);
  svc.submitAndVerifyStarkProof.mockResolvedValue({ proofBuffer: Keypair.generate().publicKey });
  svc.closeStarkProofBuffer.mockResolvedValue(undefined);
  svc.sendRawTransaction.mockResolvedValue('SIG_V3');
});

// ---------------------------------------------------------------------------

describe('the route is per note', () => {
  it('a PRF-blinded note subscribes on circuit 7, and the pair is never touched', async () => {
    await expect(subscribe(receipt(PRF_BLINDED))).resolves.toBe('SIG_V4');
    expect(svc.prepareSubscribeV4).toHaveBeenCalledTimes(1);
    expect(svc.subscribePrivateStarkV4).toHaveBeenCalledTimes(1);
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
    expect(svc.submitAndVerifyStarkProof).not.toHaveBeenCalled();
  });

  it('an epoch-blinded note goes to the C1 + C3 pair, and circuit 7 is not even attempted', async () => {
    // ⛔ NOT "it threw" — it must reach v3 and SUBSCRIBE. A guard that blocked
    // the note would strand every note received through an extension transfer,
    // since `prepareTransfer` still mints those with a real epoch.
    await expect(subscribe(receipt(EPOCH_BLINDED))).resolves.toBe('SIG_V3');
    expect(svc.prepareSubscribeV4).not.toHaveBeenCalled();
    expect(svc.subscribePrivateStarkV4).not.toHaveBeenCalled();
    expect(svc.prepareUnshield).toHaveBeenCalledTimes(1);
    // Two buffers: the pair.
    expect(svc.submitAndVerifyStarkProof).toHaveBeenCalledTimes(2);
  });

  it('tells the user the subscription became the linkable kind', async () => {
    const steps: string[] = [];
    await subscribe(receipt(EPOCH_BLINDED), { onProgress: (s) => steps.push(s) });
    expect(steps.join(' | ')).toMatch(/falling back to the C1 \+ C3 pair/i);
    expect(steps.join(' | ')).toMatch(/will publish the note commitment/i);
  });

  it('binds the terms BEFORE the proof: rate, interval, vk and vault reach prepare', async () => {
    await subscribe(receipt(PRF_BLINDED));
    const binding = svc.prepareSubscribeV4.mock.calls[0][3] as {
      vault: PublicKey; rate: bigint; intervalSlots: bigint; vkHashSubscriber: Uint8Array;
    };
    expect(binding.rate).toBe(100_000_000n);
    expect(binding.intervalSlots).toBe(216_000n);
    expect(binding.vkHashSubscriber).toHaveLength(32);
    // And the SAME binding object is what the send is told to check against.
    const sent = svc.subscribePrivateStarkV4.mock.calls[0][0] as { binding: unknown };
    expect(sent.binding).toBe(binding);
  });
});

describe('what prepareSubscribeV4 itself throws', () => {
  const ROOT_PREFLIGHT_FAILURE =
    "PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots " +
    '(current + 100 historical). Aborting before proof rent is spent. ' +
    'Wait ~10s for the RPC to index recent transactions, then retry.';

  it('a V4Unprovable from prepare reaches the C1 + C3 pair', async () => {
    svc.prepareSubscribeV4.mockRejectedValue(new V4Unprovable(ROOT_PREFLIGHT_FAILURE));
    await expect(subscribe(receipt(PRF_BLINDED))).resolves.toBe('SIG_V3');
    expect(svc.prepareSubscribeV4).toHaveBeenCalledTimes(1);
    expect(svc.prepareUnshield).toHaveBeenCalledTimes(1);
    expect(svc.subscribePrivateStarkV4).not.toHaveBeenCalled();
  });

  it('a plain Error from prepare FAILS CLOSED and never touches v3', async () => {
    // ⛔ THE SAFETY PROPERTY. "The prover published 5 felts" is a defect to
    // surface, not a reason to republish this note's commitment on the pair.
    svc.prepareSubscribeV4.mockRejectedValue(new Error('Circuit 7 must publish exactly 6 felts, got 5.'));
    await expect(subscribe(receipt(PRF_BLINDED))).rejects.toThrow(/exactly 6 felts/);
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
    expect(svc.submitAndVerifyStarkProof).not.toHaveBeenCalled();
  });

  it('routes on the TYPE, not on the wording', async () => {
    svc.prepareSubscribeV4.mockRejectedValue(new Error(ROOT_PREFLIGHT_FAILURE));
    await expect(subscribe(receipt(PRF_BLINDED))).rejects.toThrow(/PRE-FLIGHT FAIL/);
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
  });

  it('a failure at EXECUTE never retries on v3', async () => {
    // ⛔ THE CATCH WRAPS PREPARE ONLY. By the time `subscribePrivateStarkV4`
    // throws, a proof may already be uploaded and the nullifier PDA
    // initialised; a v3 retry would pay the buffer rent a second time and then
    // die on the double-spend guard with the note gone.
    svc.subscribePrivateStarkV4.mockRejectedValue(new Error('upload died at chunk 61'));
    await expect(subscribe(receipt(PRF_BLINDED))).rejects.toThrow(/chunk 61/);
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
    expect(svc.submitAndVerifyStarkProof).not.toHaveBeenCalled();
  });
});

describe('the pre-flights both routes share', () => {
  it('refuses an already-spent note before either prepare', async () => {
    svc.isNullifierSpent.mockResolvedValue(true);
    await expect(subscribe(receipt(PRF_BLINDED))).rejects.toThrow();
    expect(svc.prepareSubscribeV4).not.toHaveBeenCalled();
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
  });

  it('will not prove anything it could not first save the subscriber secret for (FIX B)', async () => {
    svc.saveSecret.mockRejectedValue(new Error('locked'));
    await expect(subscribe(receipt(PRF_BLINDED))).rejects.toThrow(/Could not securely save/);
    expect(svc.prepareSubscribeV4).not.toHaveBeenCalled();
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
  });
});

describe('the license key survives the v4 leg exactly as it survives v3 (FIX C)', () => {
  it('records the vault tag the instant before the send, via the hook, and saves the key after', async () => {
    let tagCallsAtSend = -1;
    svc.subscribePrivateStarkV4.mockImplementation(async (p: { onBeforeSend?: () => void }) => {
      // The service is expected to fire this after the upload, before the send.
      expect(svc.recordVaultTag).not.toHaveBeenCalled();
      p.onBeforeSend?.();
      tagCallsAtSend = svc.recordVaultTag.mock.calls.length;
      return { txSig: 'SIG_V4', vaultPDA: POOL.poolPDA };
    });
    await subscribe(receipt(PRF_BLINDED), { serviceId: 'svc-1' });
    expect(tagCallsAtSend).toBe(1);
    expect(svc.recordVaultTag.mock.calls[0][0]).toMatchObject({ retailer: RETAILER, serviceTag: 'svc-1' });
    expect(svc.saveLicense).toHaveBeenCalledTimes(1);
    expect(svc.saveLicense.mock.calls[0][0]).toMatchObject({ mode: 'zk', serviceTag: 'svc-1' });
    // And the license commitment was INSIDE the binding, so it is inside the proof.
    const binding = svc.prepareSubscribeV4.mock.calls[0][3] as { licenseCommitment?: Uint8Array };
    expect(binding.licenseCommitment).toHaveLength(32);
  });

  it('records no tag and saves no key when the v4 leg fails before the send', async () => {
    svc.subscribePrivateStarkV4.mockRejectedValue(new Error('upload died at chunk 61'));
    await expect(subscribe(receipt(PRF_BLINDED), { serviceId: 'svc-1' })).rejects.toThrow();
    expect(svc.recordVaultTag).not.toHaveBeenCalled();
    expect(svc.saveLicense).not.toHaveBeenCalled();
  });

  it('carries no license into the binding when there is no serviceId', async () => {
    await subscribe(receipt(PRF_BLINDED));
    const binding = svc.prepareSubscribeV4.mock.calls[0][3] as { licenseCommitment?: Uint8Array };
    expect(binding.licenseCommitment).toBeUndefined();
    expect(svc.recordVaultTag).not.toHaveBeenCalled();
    expect(svc.saveLicense).not.toHaveBeenCalled();
  });
});
