/**
 * The tab that has to earn its place.
 *
 * Discover replaced the Agent tab, so the bar it has to clear is not "does it
 * render" but "does it give someone a reason to open the extension". These
 * assertions pin the parts that do that job, and the ones where getting it
 * wrong would mislead rather than merely disappoint.
 *
 * 🚨 THE TWO THAT MATTER MOST
 *   - an unreachable registry must not look like an empty one. They are the
 *     same blank list on screen and they need opposite reactions: retry, or
 *     go register a merchant.
 *   - `verified` is a field on the account. It is reported, never conferred.
 *     A directory that decorates entries with trust it invented is worse than
 *     one that shows none.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Discover from './Discover';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockFetchAllServices = vi.fn();

vi.mock('@/shared/services/onchainServiceRegistry', () => ({
  fetchAllServices: (...a: unknown[]) => mockFetchAllServices(...a),
  resolveServiceBranding: (e: { name: string }) => ({ name: e.name }),
}));

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({ network: 'devnet' }),
}));

/** One month of Solana slots, near enough for the label to resolve. */
const MONTH_SLOTS = Math.round((30 * 86_400 * 1000) / 400);

function service(over: Partial<Record<string, unknown>> = {}) {
  return {
    address: 'Svc111',
    owner: 'Own111',
    retailer: 'Ret111',
    tokenMint: '11111111111111111111111111111111',
    priceAtomic: 100_000_000, // 0.1 SOL
    intervalSlots: MONTH_SLOTS,
    subscriberCount: 12,
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
    ...over,
  };
}

const view = () => render(<MemoryRouter><Discover /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchAllServices.mockResolvedValue([service()]);
});

describe('what it shows', () => {
  it('lists a merchant with what it costs and how often', async () => {
    view();
    expect(await screen.findByText('Acme Reader')).toBeInTheDocument();
    expect(screen.getByText('0.1 SOL')).toBeInTheDocument();
    expect(screen.getByText(/per month/i)).toBeInTheDocument();
  });

  it('translates slots into something a person thinks in', async () => {
    // The registry stores an interval in slots. Nobody has an intuition for
    // 6,480,000 slots, and printing it raw is what the old approval screen did.
    mockFetchAllServices.mockResolvedValue([
      service({ intervalSlots: Math.round((7 * 86_400 * 1000) / 400), name: 'Weekly' }),
    ]);
    view();
    expect(await screen.findByText(/per week/i)).toBeInTheDocument();
  });

  it('reports verification as a fact, and shows nothing when there is none', async () => {
    view();
    await screen.findByText('Acme Reader');
    expect(screen.queryByLabelText(/Verified in the registry/i)).not.toBeInTheDocument();

    mockFetchAllServices.mockResolvedValue([service({ verified: true })]);
    fireEvent.click(screen.getByLabelText(/Refresh the merchant list/i));
    expect(await screen.findByLabelText(/Verified in the registry/i)).toBeInTheDocument();
  });

  it('sells the point of the tab in one line', async () => {
    view();
    expect(
      await screen.findByText(/never receives a\s+name, an email or a card number/i),
    ).toBeInTheDocument();
  });
});

describe('what it refuses to show', () => {
  it('hides merchants who switched themselves off', async () => {
    // An inactive entry sends someone into a subscribe flow that cannot
    // complete. Filtered at the fetch AND locally, because the fetch option is
    // a hint and the field is the truth.
    mockFetchAllServices.mockResolvedValue([
      service({ name: 'Live' }),
      service({ address: 'Svc222', name: 'Switched off', active: false }),
    ]);
    view();
    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('Switched off')).not.toBeInTheDocument();
  });
});

describe('when the chain does not answer', () => {
  it('says the registry could not be read, and offers a retry', async () => {
    // 🚨 NOT the empty state. "No merchants" and "we could not ask" look the
    // same on screen and mean opposite things.
    mockFetchAllServices.mockRejectedValue(new Error('rpc timeout'));
    view();
    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/rpc timeout/)).toBeInTheDocument();
    expect(screen.queryByText(/No merchants yet/i)).not.toBeInTheDocument();

    mockFetchAllServices.mockResolvedValue([service()]);
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(await screen.findByText('Acme Reader')).toBeInTheDocument();
  });

  it('says the registry is empty when it genuinely is', async () => {
    mockFetchAllServices.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No merchants yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/i)).not.toBeInTheDocument();
  });
});

describe('getting from here to a subscription', () => {
  it('carries the merchant into the subscribe flow', async () => {
    view();
    fireEvent.click(await screen.findByText('Acme Reader'));
    // Without the address the next screen has to re-ask which merchant, which
    // is the step this tab exists to remove.
    expect(mockNavigate).toHaveBeenCalledWith('/subscriptions/new', {
      state: { service: 'Svc111' },
    });
  });
});

describe('search', () => {
  it('stays out of the way until the list is long enough to need it', async () => {
    view();
    await screen.findByText('Acme Reader');
    expect(screen.queryByLabelText(/Search merchants/i)).not.toBeInTheDocument();
  });

  it('filters on name and category, and can be cleared', async () => {
    mockFetchAllServices.mockResolvedValue([
      service({ address: 'a', name: 'Alpha', category: 'news' }),
      service({ address: 'b', name: 'Beta', category: 'music' }),
      service({ address: 'c', name: 'Gamma', category: 'news' }),
      service({ address: 'd', name: 'Delta', category: 'video' }),
    ]);
    view();
    const box = await screen.findByLabelText(/Search merchants/i);

    fireEvent.change(box, { target: { value: 'music' } });
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'nothing here' } });
    expect(await screen.findByText(/No match/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear search/i }));
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });
});
