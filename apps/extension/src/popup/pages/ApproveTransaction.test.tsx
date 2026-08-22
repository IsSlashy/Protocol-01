/**
 * Tests for ApproveTransaction page
 *
 * The ApproveTransaction page handles transaction signing and message signing
 * requests from dApps. It displays:
 * - The requesting dApp's name and origin
 * - Whether it is a message sign or transaction sign request
 * - The facts of the signature, always open: signer, network, fee, stealth
 * - One caution line
 * - Reject and Approve, side by side
 *
 * Validates:
 * - Loading state while fetching request
 * - Transaction request display
 * - Message signing request display
 * - Stealth row for private transactions
 * - Approve and reject button interactions
 *
 * ⚠️ WHY THE COPY ASSERTIONS CHANGED. The screen used monospace capitals as UI
 * labels ("SIGN TRANSACTION", "EST. FEE", "VERIFY BEFORE SIGNING") and said
 * several things twice: a badge repeating the header, an origin card repeating
 * the origin, and stealth announced as both a row and a card. The duplicates
 * are deleted and the labels are sentence case; these tests follow the screen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ApproveTransaction from './ApproveTransaction';

vi.mock('@/shared/store/wallet', () => ({
  useWalletStore: () => ({
    publicKey: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    _keypair: {
      publicKey: { toBase58: () => '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
      secretKey: new Uint8Array(64),
    },
  }),
}));

// Partial mock: the UI kit imports `cn` from the same module, so replacing the
// whole module leaves every shared component without its class merger.
vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/utils')>()),
  truncateAddress: (addr: string, chars: number) =>
    `${addr.slice(0, chars)}...${addr.slice(-chars)}`,
}));

const mockApproveRequest = vi.fn(() => Promise.resolve());
const mockRejectRequest = vi.fn(() => Promise.resolve());

vi.mock('@/shared/messaging', () => ({
  approveRequest: (...args: unknown[]) => mockApproveRequest(...args),
  rejectRequest: (...args: unknown[]) => mockRejectRequest(...args),
}));

// Mock tweetnacl
vi.mock('tweetnacl', () => ({
  __esModule: true,
  default: {
    sign: {
      detached: vi.fn(() => new Uint8Array(64)),
    },
  },
}));

// Mock @solana/web3.js
vi.mock('@solana/web3.js', () => ({
  Connection: vi.fn(() => ({
    sendRawTransaction: vi.fn(() => Promise.resolve('mock-sig')),
    confirmTransaction: vi.fn(() => Promise.resolve()),
  })),
  Transaction: {
    from: vi.fn(() => ({
      sign: vi.fn(),
      serialize: vi.fn(() => new Uint8Array(100)),
    })),
  },
  VersionedTransaction: {
    deserialize: vi.fn(),
  },
  Keypair: {
    fromSecretKey: vi.fn(() => ({})),
  },
}));

describe('ApproveTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the loading state when no request is loaded', () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({});

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    expect(screen.getByText('Loading request')).toBeInTheDocument();
  });

  it('displays transaction signing request once loaded', async () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'tx-req-1',
        type: 'transaction',
        origin: 'https://raydium.io',
        originName: 'Raydium',
        payload: {
          transaction: btoa(String.fromCharCode(...new Uint8Array(100))),
        },
        createdAt: Date.now(),
      },
    });

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign transaction' })).toBeInTheDocument();
      expect(screen.getByText('Raydium')).toBeInTheDocument();
    });
  });

  it('displays message signing request for signMessage type', async () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'msg-req-1',
        type: 'signMessage',
        origin: 'https://example.com',
        originName: 'Example',
        payload: {
          message: btoa('Hello, Protocol 01!'),
          displayText: 'Hello, Protocol 01!',
        },
        createdAt: Date.now(),
      },
    });

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sign message' })).toBeInTheDocument();
      expect(screen.getByText('Message')).toBeInTheDocument();
      expect(screen.getByText('Hello, Protocol 01!')).toBeInTheDocument();
      // The action says what it does, once, and differently from the title.
      expect(screen.getByRole('button', { name: 'Sign' })).toBeInTheDocument();
    });
  });

  it('warns, once, that only trusted sites should be approved', async () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'tx-req-2',
        type: 'transaction',
        origin: 'https://unknown-dapp.com',
        originName: 'Unknown dApp',
        payload: { transaction: btoa('mock') },
        createdAt: Date.now(),
      },
    });

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Only approve transactions from sites you trust/),
      ).toBeInTheDocument();
    });
  });

  it('displays the signer address and network, never behind a disclosure', async () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'tx-req-3',
        type: 'transaction',
        origin: 'https://app.example.com',
        originName: 'Example',
        payload: { transaction: btoa('mock') },
        createdAt: Date.now(),
      },
    });

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('From')).toBeInTheDocument();
      expect(screen.getByText('Network')).toBeInTheDocument();
      expect(screen.getByText('Solana devnet')).toBeInTheDocument();
      expect(screen.getByText(/7xKXtg\.\.\.osgAsU/)).toBeInTheDocument();
    });
  });

  it('shows a single stealth row for private transactions', async () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'tx-req-4',
        type: 'transaction',
        origin: 'https://stealth-dapp.com',
        originName: 'Stealth dApp',
        payload: {
          transaction: btoa('mock'),
          isPrivate: true,
        },
        createdAt: Date.now(),
      },
    });

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Privacy')).toBeInTheDocument();
      expect(screen.getByText('Stealth address')).toBeInTheDocument();
      expect(
        screen.getByText(/The recipient is not publicly linked to this wallet/),
      ).toBeInTheDocument();
    });
  });

  it('renders Approve and Reject', async () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'tx-req-5',
        type: 'transaction',
        origin: 'https://app.example.com',
        originName: 'Example',
        payload: { transaction: btoa('mock') },
        createdAt: Date.now(),
      },
    });

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    });
  });

  it('calls rejectRequest and closes window on Reject', async () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'tx-req-6',
        type: 'transaction',
        origin: 'https://app.example.com',
        originName: 'Example',
        payload: { transaction: btoa('mock') },
        createdAt: Date.now(),
      },
    });

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(mockRejectRequest).toHaveBeenCalledWith('tx-req-6', 'User rejected');
      expect(window.close).toHaveBeenCalled();
    });
  });

  it('displays the network fee for transactions', async () => {
    (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentApproval: {
        id: 'tx-req-7',
        type: 'transaction',
        origin: 'https://app.example.com',
        originName: 'Example',
        payload: { transaction: btoa('mock') },
        createdAt: Date.now(),
      },
    });

    render(
      <MemoryRouter>
        <ApproveTransaction />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Network fee')).toBeInTheDocument();
      expect(screen.getByText('~0.000005 SOL')).toBeInTheDocument();
    });
  });
});
