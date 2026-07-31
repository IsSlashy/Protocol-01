/**
 * Streams Service Test Suite
 *
 * Validates the payment orchestration layer for recurring P2P payments,
 * specifically the privacy-path decisions made inside processStreamPayment:
 *
 *   - ZK pool auto-pause when no mature shielded note can cover the payment
 *   - Stealth-address integration when useStealthAddress is toggled
 *
 * These paths are the "paid privacy" codepaths — if they silently regress,
 * recurring payments either drain the wallet or leak the recipient. Tests
 * target the branch logic in `_processStreamPaymentInner` directly; the
 * transport (relay, RPC) is mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '../../test/__mocks__/async-storage';
import { createStream, processStreamPayment, getStream, pauseStream, updateStream, mapVaultStatusToStream, upsertStreamFromVault } from './streams';
import type { VaultInfo } from '../subscriptionVault';

// ===================================================================
// Static module mocks
// ===================================================================

/**
 * `mockSlot` is what `getConnection().getSlot()` returns. `upsertStreamFromVault`
 * fetches it when the caller supplies none — which every one of its four call
 * sites does — so it is the only thing that makes the recovered subscription's
 * status real. Set it to `null` to simulate an unreachable RPC.
 */
let mockSlot: number | null = 1_250;

vi.mock('./connection', () => ({
  getConnection: vi.fn(() => ({
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'mock-bh', lastValidBlockHeight: 999 }),
    getSlot: vi.fn(async () => {
      if (mockSlot === null) throw new Error('no RPC');
      return mockSlot;
    }),
  })),
  getExplorerUrl: vi.fn(() => 'https://solscan.io/tx/mock'),
  isMainnet: vi.fn(() => false),
}));

vi.mock('./transactions', () => ({
  sendSol: vi.fn().mockResolvedValue({ success: true, signature: 'plain-sig' }),
  sendSolPrivate: vi.fn().mockResolvedValue({ success: true, signature: 'stealth-sig' }),
  getTransferFeeBreakdown: vi.fn(() => ({
    totalAmount: 1,
    feeAmount: 0,
    recipientAmount: 1,
    feePercentage: 0,
    isMainnet: false,
  })),
}));

vi.mock('./wallet', () => ({
  getKeypair: vi.fn().mockResolvedValue({
    publicKey: { toBase58: () => 'MockSenderPubkey11111111111111111111111111' },
    secretKey: new Uint8Array(64),
    sign: vi.fn(),
  }),
}));

vi.mock('../../stores/walletStore', () => ({
  // Privy removed (spec §3 Phase 1) — streams.ts no longer reads any signer here.
  useWalletStore: {
    getState: vi.fn(() => ({
      publicKey: 'MockSenderPubkey11111111111111111111111111',
    })),
  },
}));

vi.mock('../../utils/crypto/stealth', () => ({
  deriveStealthAddressSimple: vi.fn(() => ({
    stealthAddress: 'StealthAddr11111111111111111111111111111111',
    ephemeralPubkey: new Uint8Array(32),
  })),
}));

vi.mock('../../services/stealth/keys', () => ({
  getOrCreateStealthKeys: vi.fn().mockResolvedValue({
    spendingKey: { secretKey: new Uint8Array(64).fill(7) },
    viewingKey: { secretKey: new Uint8Array(32).fill(3) },
  }),
}));

vi.mock('./onchainSync', () => ({
  publishStatusUpdate: vi.fn().mockResolvedValue('mock-status-sig'),
}));

// denominatedPoolStore returns whatever the test stages via __setNotes.
const _notes = { value: [] as Array<{ token: string; status: string; denomination: number }> };
vi.mock('../../stores/denominatedPoolStore', () => ({
  useDenominatedPoolStore: {
    getState: () => ({
      getActiveNotes: () => _notes.value,
    }),
  },
}));

// ===================================================================
// Test helpers
// ===================================================================

async function makeStream(overrides: Partial<Parameters<typeof createStream>[0]> = {}) {
  // processStreamPayment gates on status==='active' only — nextPaymentDate isn't
  // checked here (that's processDuePayments). createStream persists via AsyncStorage
  // under its own STORAGE_KEY.
  return createStream({
    name: 'Test Stream',
    recipientAddress: 'RecipientPubkey111111111111111111111111111',
    totalAmount: 12,
    frequency: 'monthly',
    ...overrides,
  });
}

beforeEach(() => {
  AsyncStorage.__reset();
  _notes.value = [];
  vi.clearAllMocks();
});

// ===================================================================
// Section 1: ZK Pool Auto-Pause
// ===================================================================

describe('Streams Service -- ZK Pool Auto-Pause', () => {
  it('auto-pauses when no mature shielded notes exist', async () => {
    _notes.value = []; // No notes at all
    const stream = await makeStream({ useZkPool: true, totalAmount: 5 });

    const payment = await processStreamPayment(stream.id);

    expect(payment).not.toBeNull();
    expect(payment!.status).toBe('failed');
    expect(payment!.error).toMatch(/Insufficient private balance/i);

    const persisted = await getStream(stream.id);
    expect(persisted!.status).toBe('paused');
    // Failed payment recorded in history
    expect(persisted!.paymentHistory.length).toBe(1);
    expect(persisted!.paymentHistory[0].status).toBe('failed');
  });

  it('auto-pauses when mature note denomination is smaller than amountPerPayment', async () => {
    _notes.value = [
      { token: 'SOL', status: 'mature', denomination: 0.1 }, // Too small
    ];
    const stream = await makeStream({
      useZkPool: true,
      frequency: 'monthly',
      totalAmount: 5, // amountPerPayment = 5 (monthly default)
    });

    const payment = await processStreamPayment(stream.id);

    expect(payment!.status).toBe('failed');
    const persisted = await getStream(stream.id);
    expect(persisted!.status).toBe('paused');
  });

  it('ignores non-SOL notes when selecting coverage', async () => {
    _notes.value = [
      { token: 'USDC', status: 'mature', denomination: 100 }, // Wrong token
    ];
    const stream = await makeStream({ useZkPool: true, totalAmount: 5 });

    const payment = await processStreamPayment(stream.id);

    expect(payment!.status).toBe('failed');
    const persisted = await getStream(stream.id);
    expect(persisted!.status).toBe('paused');
  });

  it('ignores non-mature notes (pending/spent) when selecting coverage', async () => {
    _notes.value = [
      { token: 'SOL', status: 'pending', denomination: 10 }, // Not mature yet
      { token: 'SOL', status: 'spent', denomination: 10 },   // Already used
    ];
    const stream = await makeStream({ useZkPool: true, totalAmount: 5 });

    const payment = await processStreamPayment(stream.id);

    expect(payment!.status).toBe('failed');
    const persisted = await getStream(stream.id);
    expect(persisted!.status).toBe('paused');
  });

  it('returns null (no auto-pause) when a mature note covers the payment — user must Pay Now manually', async () => {
    _notes.value = [
      { token: 'SOL', status: 'mature', denomination: 10 }, // Covers
    ];
    const stream = await makeStream({ useZkPool: true, totalAmount: 5 });

    const payment = await processStreamPayment(stream.id);

    // ZK streams skip automatic processing — return null, stream stays active
    expect(payment).toBeNull();
    const persisted = await getStream(stream.id);
    expect(persisted!.status).toBe('active');
    expect(persisted!.paymentHistory.length).toBe(0);
  });
});

// ===================================================================
// Section 2: Stealth-Address Integration
// ===================================================================

describe('Streams Service -- Stealth Address Integration', () => {
  it('derives a unique stealth address per payment and routes through sendSolPrivate', async () => {
    const stream = await makeStream({
      useStealthAddress: true,
      totalAmount: 5,
    });

    const { deriveStealthAddressSimple } = await import('../../utils/crypto/stealth');
    const { sendSolPrivate, sendSol } = await import('./transactions');

    const payment = await processStreamPayment(stream.id);

    expect(payment).not.toBeNull();
    expect(payment!.status).toBe('success');
    expect(payment!.signature).toBe('stealth-sig');
    expect(payment!.wasStealthPayment).toBe(true);
    expect(payment!.stealthAddress).toBe('StealthAddr11111111111111111111111111111111');

    // Stealth path was chosen — plain sendSol must NOT have been called
    expect(sendSol).not.toHaveBeenCalled();

    // Stealth address derived from recipient + sender secret + payment index
    expect(deriveStealthAddressSimple).toHaveBeenCalledWith(
      stream.recipientAddress,
      expect.any(Uint8Array),
      0, // paymentsCompleted
    );

    // Stealth signed/sent through private relay
    expect(sendSolPrivate).toHaveBeenCalledWith(
      'StealthAddr11111111111111111111111111111111',
      expect.any(Number),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('uses plain sendSol when stealth is disabled', async () => {
    const stream = await makeStream({
      useStealthAddress: false,
      totalAmount: 5,
    });

    const { sendSol, sendSolPrivate } = await import('./transactions');

    const payment = await processStreamPayment(stream.id);

    expect(payment!.status).toBe('success');
    expect(payment!.signature).toBe('plain-sig');
    expect(payment!.wasStealthPayment).toBeFalsy();
    expect(sendSol).toHaveBeenCalledWith(stream.recipientAddress, expect.any(Number));
    expect(sendSolPrivate).not.toHaveBeenCalled();
  });

  it('advances paymentsCompleted so the next stealth address is unique', async () => {
    const stream = await makeStream({
      useStealthAddress: true,
      totalAmount: 20,
    });

    const { deriveStealthAddressSimple } = await import('../../utils/crypto/stealth');

    // First payment (stream stays 'active' after successful payment)
    await processStreamPayment(stream.id);
    // Second payment (paymentsCompleted now = 1)
    await processStreamPayment(stream.id);

    const calls = (deriveStealthAddressSimple as any).mock.calls;
    expect(calls.length).toBe(2);
    // Payment index must increment (0 → 1) so derived addresses differ
    expect(calls[0][2]).toBe(0);
    expect(calls[1][2]).toBe(1);
  });
});

// ===================================================================
// Section 3: Guard Conditions
// ===================================================================

describe('Streams Service -- Payment Guard Conditions', () => {
  it('returns null for non-active streams (paused/cancelled/completed)', async () => {
    const stream = await makeStream({ useZkPool: false });
    await pauseStream(stream.id);

    const payment = await processStreamPayment(stream.id);
    expect(payment).toBeNull();

    const { sendSol } = await import('./transactions');
    expect(sendSol).not.toHaveBeenCalled();
  });

  it('returns null for unknown stream IDs', async () => {
    const payment = await processStreamPayment('nonexistent-id');
    expect(payment).toBeNull();
  });

  it('never re-bills a prepaid stream within its term (stays active)', async () => {
    const stream = await makeStream({ endDate: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    await updateStream(stream.id, { prepaid: true });

    const payment = await processStreamPayment(stream.id);
    expect(payment).toBeNull();

    const { sendSol } = await import('./transactions');
    expect(sendSol).not.toHaveBeenCalled();
    expect((await getStream(stream.id))?.status).toBe('active');
  });

  it('completes a prepaid stream once past its end date, without charging', async () => {
    const stream = await makeStream({ endDate: Date.now() + 30 * 24 * 60 * 60 * 1000 });
    // Flag prepaid AND move the end date into the past to simulate term end.
    await updateStream(stream.id, { prepaid: true, endDate: Date.now() - 1000 });

    const payment = await processStreamPayment(stream.id);
    expect(payment).toBeNull();

    const { sendSol } = await import('./transactions');
    expect(sendSol).not.toHaveBeenCalled();
    expect((await getStream(stream.id))?.status).toBe('completed');
  });
});


// ===================================================================
// Vault -> StreamStatus mapping
// ===================================================================

/** 500,000 lamports at 100,000/period buys 5 periods, of 100 slots each. */
function vaultAt(over: Partial<VaultInfo> = {}): VaultInfo {
  return {
    address: 'Vau1t1111111111111111111111111111111111111',
    subscriberPubkey: null,
    subscriberCommitment: null,
    retailer: 'Reta11er111111111111111111111111111111111',
    tokenMint: '11111111111111111111111111111111',
    totalDeposited: 500_000n,
    rate: 100_000n,
    intervalSlots: 100n,
    startSlot: 1_000n,
    claimedPeriods: 0n,
    isActive: true,
    isPaused: false,
    pauseSlot: null,
    totalPausedSlots: 0n,
    sourcePool: null,
    isNormalMode: true,
    isPrivateMode: false,
    clientStealthMeta: null,
    ...over,
  };
}

describe('mapVaultStatusToStream', () => {
  it('files a subscription still inside its funded periods as active', () => {
    expect(mapVaultStatusToStream(vaultAt(), 1_250)).toBe('active');
  });

  it('THE BUG: an exhausted vault is completed, not active', () => {
    // isActive is still true here — the program never writes it false — so the
    // old `vault.isActive ? 'active' : 'cancelled'` filed this as active.
    const v = vaultAt();
    expect(v.isActive).toBe(true);
    expect(mapVaultStatusToStream(v, 1_500)).toBe('completed');
  });

  it('still reports paused', () => {
    expect(mapVaultStatusToStream(vaultAt({ isPaused: true }), 1_500)).toBe('paused');
  });

  it('stays active when no slot could be fetched, rather than guessing', () => {
    // `cancelled` would be sticky: loadStreams re-applies the cancelled-ids
    // list on every load, so a wrong guess here would never self-correct.
    expect(mapVaultStatusToStream(vaultAt(), null)).toBe('active');
  });

  it('reports cancelled only when the account itself says inactive', () => {
    expect(mapVaultStatusToStream(vaultAt({ isActive: false }), 1_250)).toBe('cancelled');
  });
});

// ===================================================================
// upsertStreamFromVault — the wiring, not just the mapping
// ===================================================================

/**
 * `mapVaultStatusToStream` being right proves nothing on its own: all four
 * production call sites of `upsertStreamFromVault` pass no `currentSlot`, so
 * for one commit the mapping ran on `null` every time and the fix had no
 * effect anywhere. Feeding it a slot it fetches itself is the whole fix, and
 * nothing pinned it — replacing `resolvedSlot` with `null` at the call site
 * left every test green. These tests go through the public function.
 */
describe('upsertStreamFromVault resolves a slot, so the recovered status is real', () => {
  beforeEach(() => {
    mockSlot = 1_250;
  });

  it('files a subscription still inside its funded periods as active', async () => {
    const s = await upsertStreamFromVault(vaultAt({ address: 'VaultInsideTerm11111111111' }));
    expect(s?.status).toBe('active');
  });

  it('THE WIRING: with no currentSlot passed, an exhausted vault still lands as completed', async () => {
    // No `opts.currentSlot` — exactly how every production caller invokes it.
    // The slot has to come from the connection or the status is a guess.
    mockSlot = 1_500;
    const v = vaultAt({ address: 'VaultExhausted111111111111' });
    const s = await upsertStreamFromVault(v);
    expect(v.isActive).toBe(true);
    expect(s?.status).toBe('completed');
  });

  it('an explicit currentSlot still wins over the fetch', async () => {
    mockSlot = 1_250;
    const s = await upsertStreamFromVault(
      vaultAt({ address: 'VaultExplicitSlot111111111' }),
      { currentSlot: 5_000 },
    );
    expect(s?.status).toBe('completed');
  });

  it('falls back to active, not cancelled, when the RPC is unreachable', async () => {
    // `cancelled` would be sticky: loadStreams re-applies the cancelled-ids
    // list on every load, so a wrong guess here would never self-correct.
    mockSlot = null;
    const s = await upsertStreamFromVault(vaultAt({ address: 'VaultNoRpc111111111111111' }));
    expect(s?.status).toBe('active');
  });

  it('dedupes by vaultAddress', async () => {
    const v = vaultAt({ address: 'VaultDedupe1111111111111111' });
    expect(await upsertStreamFromVault(v)).not.toBeNull();
    expect(await upsertStreamFromVault(v)).toBeNull();
  });
});
