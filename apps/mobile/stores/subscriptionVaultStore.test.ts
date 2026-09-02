/**
 * The Stream row a private subscribe leaves behind.
 *
 * The Streams tab lists Stream rows and the detail screen hands a row's
 * `vaultAddress` to LicenseKeyCard, so a vault with no row is a subscription
 * the customer cannot see and a key they cannot read. The row used to be
 * written only when `fetchVault` returned the account on its single try right
 * after the send. An RPC that had not served the account yet, or one 429 after
 * the proof upload, left no row, and nothing rebuilt it later: the vault was
 * already in `vaults`, so `recoverOrphanedVaults` skipped it for ever.
 *
 * These tests drive the REAL store action against the REAL streams service
 * (AsyncStorage mocked), with only the transport (vault service, RPC) stubbed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '../test/__mocks__/async-storage';
import { PublicKey } from '@solana/web3.js';

const h = vi.hoisted(() => ({
  fetchVault: vi.fn(),
  subscribePrivateStark: vi.fn(),
  getSlot: vi.fn(async () => 1_000),
}));

vi.mock('../services/solana/connection', () => ({
  getConnection: vi.fn(() => ({
    getSlot: h.getSlot,
    getProgramAccounts: vi.fn(async () => []),
  })),
  getExplorerUrl: vi.fn(() => 'https://solscan.io/tx/mock'),
  isMainnet: vi.fn(() => false),
}));

vi.mock('../services/subscriptionVault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/subscriptionVault')>();
  const { PublicKey } = await import('@solana/web3.js');
  return {
    ...actual,
    subscribePrivateStark: h.subscribePrivateStark,
    fetchVault: h.fetchVault,
    deriveVaultPDA: vi.fn(() => [new PublicKey('vault-pda-under-test'), 255]),
  };
});

vi.mock('./walletStore', () => ({
  useWalletStore: { getState: () => ({ publicKey: 'wallet' }) },
}));
vi.mock('./denominatedPoolStore', () => ({
  useDenominatedPoolStore: { getState: () => ({ notes: [] }) },
}));
vi.mock('../services/notifications', () => ({
  scheduleLocalNotification: vi.fn(async () => {}),
}));
vi.mock('../utils/crypto/noteVault', () => ({
  vaultDecrypt: vi.fn((s: string) => s),
}));

import { loadStreams, upsertStreamFromVault } from '../services/solana/streams';
import type { PoolConfig, ShieldReceipt } from '../services/denominatedPool';
import type { VaultInfo } from '../services/subscriptionVault';
import {
  useSubscriptionVaultStore,
  fillStreamRowFromChain,
  provisionalVaultInfo,
  CHAIN_FILL_POLICY,
} from './subscriptionVaultStore';

const RETAILER = new PublicKey('retailer-under-test');
const VAULT_PDA = new PublicKey('vault-pda-under-test');
const SOL_MINT = new PublicKey('11111111111111111111111111111111');

const poolConfig: PoolConfig = {
  token: 'SOL',
  tokenMint: SOL_MINT,
  denomination: 1,
  denominationAtomic: 1_000_000_000n,
  decimals: 9,
  poolPDA: new PublicKey('pool-under-test'),
  treePDA: new PublicKey('tree-under-test'),
  version: 'v3',
};
const vaultConfig = { retailer: RETAILER, rate: 100_000_000n, intervalSlots: 7_201n };
const proof = { proofBytes: new Uint8Array(0), publicInputs: [] as bigint[], proofSize: 0 };
const walk = { merkleRoot: 0n, siblings: [] as bigint[], directions: [] as number[] };

function subscribe(serviceId = 'disney-plus') {
  return useSubscriptionVaultStore.getState().subscribePrivateStarkAction(
    {} as ShieldReceipt,
    poolConfig,
    vaultConfig,
    123n,
    42n,
    new Uint8Array(32),
    proof,
    proof,
    walk,
    serviceId,
  );
}

/** The account as the chain would report it once it serves it. */
function chainVault(overrides: Partial<VaultInfo> = {}): VaultInfo {
  return {
    ...provisionalVaultInfo({
      vaultAddress: VAULT_PDA.toBase58(),
      vaultConfig,
      poolConfig,
      subscriberOwnershipCommitment: 42n,
      startSlot: 990,
    }),
    ...overrides,
  };
}

const tick = () => new Promise(r => setTimeout(r, 5));

beforeEach(() => {
  AsyncStorage.__reset();
  useSubscriptionVaultStore.setState({ vaults: [], isLoading: false, error: null, progress: null });
  h.fetchVault.mockReset();
  h.subscribePrivateStark.mockReset().mockResolvedValue('sig-under-test');
  h.getSlot.mockReset().mockResolvedValue(1_000);
  // The action fires the chain fill in the background; keep it to one quick try
  // so a test's assertions are not raced by a 1.5 s timer.
  CHAIN_FILL_POLICY.attempts = 1;
  CHAIN_FILL_POLICY.delayMs = 0;
});

describe('subscribePrivateStarkAction writes the Stream row from the terms it sent', () => {
  it('THE BUG: a vault the RPC does not serve yet still gets its row', async () => {
    h.fetchVault.mockResolvedValue(null);

    const res = await subscribe();
    await tick();

    const rows = await loadStreams();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.vaultAddress).toBe(res.vaultAddress);
    expect(row.vaultAddress).toBe(VAULT_PDA.toBase58());
    expect(row.recipientAddress).toBe(RETAILER.toBase58());
    expect(row.useZkVault).toBe(true);
    expect(row.status).toBe('active');
    expect(row.amountPerPayment).toBe(0.1);
    expect(row.totalAmount).toBe(1);
    expect(row.paymentsCompleted).toBe(0);
    // The tag hashed into license_commitment, so LicenseKeyCard derives the
    // same key the merchant's blake3 check expects.
    expect(row.licenseServiceTag).toBe('disney-plus');
  });

  it('still writes the row when the read THROWS (one 429 after the proof upload)', async () => {
    h.fetchVault.mockRejectedValue(new Error('429 Too Many Requests'));

    await subscribe();
    await tick();

    const rows = await loadStreams();
    expect(rows).toHaveLength(1);
    expect(rows[0].vaultAddress).toBe(VAULT_PDA.toBase58());
    expect(rows[0].licenseServiceTag).toBe('disney-plus');
  });

  it('the vault is in the store too, tagged with the service id', async () => {
    h.fetchVault.mockResolvedValue(null);
    await subscribe();
    await tick();
    const { vaults } = useSubscriptionVaultStore.getState();
    expect(vaults).toHaveLength(1);
    expect(vaults[0].vaultAddress).toBe(VAULT_PDA.toBase58());
    expect(vaults[0].serviceId).toBe('disney-plus');
    expect(vaults[0].rate).toBe('100000000');
    expect(vaults[0].intervalSlots).toBe('7201');
  });

  it('writes ONE row when the account is readable at once, not one per source', async () => {
    h.fetchVault.mockResolvedValue(chainVault());
    await subscribe();
    await tick();
    const rows = await loadStreams();
    expect(rows).toHaveLength(1);
    expect(rows[0].licenseServiceTag).toBe('disney-plus');
  });

  it('judges the status at the confirmation slot, so a fresh vault is active even when the RPC will not give a slot', async () => {
    h.fetchVault.mockResolvedValue(null);
    h.getSlot.mockRejectedValue(new Error('no RPC'));
    await subscribe();
    await tick();
    const rows = await loadStreams();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
  });
});

describe('fillStreamRowFromChain fills in what only the chain knows', () => {
  async function provisionalRow() {
    await upsertStreamFromVault(
      provisionalVaultInfo({
        vaultAddress: VAULT_PDA.toBase58(),
        vaultConfig,
        poolConfig,
        subscriberOwnershipCommitment: 42n,
        startSlot: 1_000,
      }),
      { licenseServiceTag: 'disney-plus', currentSlot: 1_000 },
    );
  }

  it('retries until the account is served, then updates the row in place', async () => {
    await provisionalRow();
    h.fetchVault
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(chainVault({ claimedPeriods: 1n }));

    const info = await fillStreamRowFromChain(VAULT_PDA, {
      attempts: 5,
      delayMs: 0,
      licenseServiceTag: 'disney-plus',
    });

    expect(info?.claimedPeriods).toBe(1n);
    expect(h.fetchVault).toHaveBeenCalledTimes(3);
    const rows = await loadStreams();
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentsCompleted).toBe(1);
    expect(rows[0].amountStreamed).toBe(0.1);
    expect(rows[0].licenseServiceTag).toBe('disney-plus');
    expect(rows[0].vaultAddress).toBe(VAULT_PDA.toBase58());
  });

  it('gives up quietly after the attempts and leaves the row as sent', async () => {
    await provisionalRow();
    h.fetchVault.mockResolvedValue(null);

    const info = await fillStreamRowFromChain(VAULT_PDA, { attempts: 3, delayMs: 0 });

    expect(info).toBeNull();
    expect(h.fetchVault).toHaveBeenCalledTimes(3);
    const rows = await loadStreams();
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentsCompleted).toBe(0);
    expect(rows[0].status).toBe('active');
  });

  it('treats a throwing read as a miss, not a failure', async () => {
    await provisionalRow();
    h.fetchVault
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce(chainVault());

    const info = await fillStreamRowFromChain(VAULT_PDA, { attempts: 2, delayMs: 0 });
    expect(info).not.toBeNull();
    expect(h.fetchVault).toHaveBeenCalledTimes(2);
  });

  it('creates the row if the provisional write was lost', async () => {
    expect(await loadStreams()).toHaveLength(0);
    h.fetchVault.mockResolvedValue(chainVault());

    await fillStreamRowFromChain(VAULT_PDA, { attempts: 1, delayMs: 0, licenseServiceTag: 'disney-plus' });

    const rows = await loadStreams();
    expect(rows).toHaveLength(1);
    expect(rows[0].vaultAddress).toBe(VAULT_PDA.toBase58());
    expect(rows[0].licenseServiceTag).toBe('disney-plus');
  });
});
