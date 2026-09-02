/**
 * What the subscribe screen WRITES, measured by clicking Subscribe.
 *
 * Two defects lived on this screen until 2026-09-02, and neither could be
 * seen by the tests that existed:
 *
 *   1. A registry arrival rewrote the merchant's period into a 1/7/30/365-day
 *      bucket before opening the vault. `CreateSubscription.intervals.test.ts`
 *      pins the four bucket constants and so could only ever agree with it.
 *      The merchant SDK requires the vault's interval to EQUAL the registry's,
 *      so a merchant registered at any other period refused every key this
 *      screen sold. The assertion that catches it is on the argument handed to
 *      `createPrivateVault`, for a period that is not a bucket.
 *
 *   2. The license key was derived and saved only after a fetchVault and a
 *      removeNote, i.e. after more RPC. The order is pinned here by reading
 *      the license store from inside the `removeNote` stub. (The deeper fix,
 *      the service persisting the key the instant the tx confirms, is pinned
 *      in `shared/services/subscriptionVault.licenseOrder.test.ts`.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import CreateSubscription from './CreateSubscription';
import { useLicenseStore } from '@/shared/store/license';
import { licenseKeyForPrivate } from '@/shared/services/license';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

/**
 * Everything the mock factories close over. `vi.mock` is hoisted above the
 * imports, so anything a factory reads has to be hoisted with it.
 */
const h = vi.hoisted(() => {
  const NOTE = {
    secret: 123456789012345678n,
    nullifierPreimage: 42n,
    depositEpoch: 0n,
    tokenMint: 0n,
    commitment: 777n,
    leafIndex: 0,
    denomination: 1_000_000_000n,
    pool: 'Pool111',
    token: 'SOL' as const,
    denominationHuman: 1,
    shieldedAt: 0,
    merkleRoot: 1n,
  };
  const POOL = {
    token: 'SOL' as const,
    tokenMint: { toBase58: () => '11111111111111111111111111111111' },
    denomination: 1,
    denominationAtomic: 1_000_000_000n,
    decimals: 9,
    poolPDA: { toBase58: () => 'Pool111' },
    treePDA: { toBase58: () => 'Tree111' },
    version: 'v3' as const,
  };
  return {
    NOTE,
    POOL,
    createPrivateVault: vi.fn(),
    removeNote: vi.fn(),
    fetchServiceRegistry: vi.fn(),
  };
});

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({ _keypair: {}, network: 'devnet', isUnlocked: true }),
}));

vi.mock('@/shared/store/denominatedPool', () => ({
  useDenominatedPoolStore: () => ({
    getSpendableNote: () => h.NOTE,
    getNotes: () => [h.NOTE],
    removeNote: h.removeNote,
  }),
}));

vi.mock('@/shared/store/subscriptionVault', () => ({
  useSubscriptionVaultStore: () => ({
    createPrivateVault: h.createPrivateVault,
    addVault: vi.fn(),
  }),
}));

vi.mock('@/shared/services/denominatedPool', () => ({
  findPoolV3: () => h.POOL,
  createNullifierV3: () => 1n,
  goldilocksU64To32: () => new Uint8Array(32),
  deriveNullifierPDA: () => [{}, 0],
}));

vi.mock('@/shared/services/subscriptionVault', () => ({
  deriveVaultPDA: () => ({ toBase58: () => 'Vault111' }),
  goldilocksU64To32: () => new Uint8Array(32),
  fetchVault: async () => null,
}));

vi.mock('@/shared/services/starkProver', () => ({
  starkProver: {
    start: async () => {},
    generateProof: async () => ({ commitment: '99' }),
  },
}));

/** A slot far past any maturity gate, and no spent nullifier records. */
vi.mock('@/shared/services/wallet', () => ({
  getConnection: () => ({
    getSlot: async () => 50_000_000,
    getMultipleAccountsInfo: async () => [null],
  }),
}));

vi.mock('@/shared/services/onchainServiceRegistry', () => ({
  fetchServiceRegistry: (...a: unknown[]) => h.fetchServiceRegistry(...a),
  NATIVE_MINT: '11111111111111111111111111111111',
}));

/** A real base58 pubkey: the screen constructs a PublicKey from it. */
const RETAILER = 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c';

/**
 * 100 000 slots is 11.1 hours: not a day, a week, a month or a year, so no
 * bucket can reproduce it. The old screen wrote 216 000 for it.
 */
function service(over: Partial<Record<string, unknown>> = {}) {
  return {
    address: 'Svc111',
    owner: 'Own111',
    retailer: RETAILER,
    tokenMint: '11111111111111111111111111111111',
    priceAtomic: 60_000_000,
    intervalSlots: 100_000,
    subscriberCount: 0,
    supportsOneshot: false,
    supportsVault: true,
    verified: false,
    active: true,
    bump: 0,
    createdAt: 0,
    updatedAt: 0,
    slug: 'acme',
    name: 'Acme Reader',
    iconKey: '',
    category: 'news',
    metadataUri: '',
    ...over,
  };
}

const view = (state?: Record<string, unknown>) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/subscriptions/new', state }]}>
      <CreateSubscription />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  useLicenseStore.getState().reset();
  h.fetchServiceRegistry.mockResolvedValue(service());
  h.createPrivateVault.mockResolvedValue('SIG');
});

describe('a registry arrival', () => {
  it('writes the registry interval and price verbatim, not a bucket', async () => {
    view({ service: 'Svc111' });
    await screen.findByText('Acme Reader');

    fireEvent.click(screen.getByRole('button', { name: /^Subscribe$/ }));
    await waitFor(() => expect(h.createPrivateVault).toHaveBeenCalledTimes(1));

    const args = h.createPrivateVault.mock.calls[0][0];
    expect(args.intervalSlots).toBe(100_000n);
    expect(args.rate).toBe(60_000_000n);
    expect(args.retailer).toBe(RETAILER);
    expect(args.serviceId).toBe('acme');
    expect(args.serviceName).toBe('Acme Reader');
  });

  it('shows the exact period, read-only, with no picker', async () => {
    view({ service: 'Svc111' });
    await screen.findByText('Acme Reader');

    expect(screen.getByText('every 11.1 hours')).toBeInTheDocument();
    expect(screen.getByText(/written to your\s+vault exactly as listed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yearly' })).not.toBeInTheDocument();
    expect(screen.queryByText(/not recognised by a merchant/i)).not.toBeInTheDocument();
  });

  it('refuses a merchant billed in a token a SOL note cannot pay', async () => {
    h.fetchServiceRegistry.mockResolvedValue(
      service({ tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }),
    );
    view({ service: 'Svc111' });
    await screen.findByText('Acme Reader');

    fireEvent.click(screen.getByRole('button', { name: /^Subscribe$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot pay from a SOL note/i);
    expect(h.createPrivateVault).not.toHaveBeenCalled();
  });

  it('shows and files the key before the post-confirmation cleanup runs', async () => {
    const expectedKey = licenseKeyForPrivate(h.NOTE.secret, 'acme');
    let keyWhenNoteRemoved: string | null | undefined;
    h.removeNote.mockImplementation(() => {
      keyWhenNoteRemoved = useLicenseStore.getState().getLicense(RETAILER, 'zk')?.licenseKey;
    });

    view({ service: 'Svc111' });
    await screen.findByText('Acme Reader');
    fireEvent.click(screen.getByRole('button', { name: /^Subscribe$/ }));

    expect(await screen.findByText(expectedKey)).toBeInTheDocument();
    await waitFor(() => expect(h.removeNote).toHaveBeenCalledTimes(1));
    expect(keyWhenNoteRemoved).toBe(expectedKey);

    const entry = useLicenseStore.getState().getLicense(RETAILER, 'zk');
    expect(entry?.licenseKey).toBe(expectedKey);
    expect(entry?.vaultAddress).toBe('Vault111');
    expect(entry?.serviceTag).toBe('acme');
    expect(useLicenseStore.getState().vaultTags['Vault111']?.confirmedAt).toBeTypeOf('number');
  });
});

describe('a personal payment', () => {
  it('keeps the frequency picker and says a merchant will not recognise it', () => {
    view();
    expect(screen.getByRole('button', { name: 'Yearly' })).toBeInTheDocument();
    expect(screen.getByText(/not\s+recognised by a merchant's registry check/i)).toBeInTheDocument();
  });
});
