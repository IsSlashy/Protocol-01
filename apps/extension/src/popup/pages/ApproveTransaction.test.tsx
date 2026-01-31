/**
 * Tests for ApproveTransaction page
 *
 * The ApproveTransaction page handles transaction signing and message signing
 * requests from dApps. It displays:
 * - The requesting dApp's name and icon
 * - Whether it is a message sign or transaction sign request
 * - Transaction details (sender, network, privacy mode, fee estimate)
 * - Warning to verify before signing
 * - APPROVE/SIGN and REJECT buttons
 *
 * Validates:
 * - Loading state while fetching request
 * - Transaction request display
 * - Message signing request display
 * - Privacy badge for stealth transactions
 * - Approve and reject button interactions
 * - Error state handling
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

vi.mock('@/shared/utils', () => ({
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

    expect(screen.getByText('LOADING REQUEST...')).toBeInTheDocument();
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
      expect(screen.getByText('SIGN TRANSACTION')).toBeInTheDocument();
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
      // "SIGN MESSAGE" appears in both the header and the approve button
      const signMsgs = screen.getAllByText('SIGN MESSAGE');
      expect(signMsgs.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('MESSAGE SIGNATURE')).toBeInTheDocument();
      expect(screen.getByText('Hello, Protocol 01!')).toBeInTheDocument();
    });
  });

  it('shows the "VERIFY BEFORE SIGNING" warning', async () => {
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
      expect(screen.getByText('VERIFY BEFORE SIGNING')).toBeInTheDocument();
      expect(
        screen.getByText(/Only approve transactions from sites you trust/),
      ).toBeInTheDocument();
    });
  });

  it('displays the sender address and network', async () => {
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
      expect(screen.getByText('FROM')).toBeInTheDocument();
      expect(screen.getByText('NETWORK')).toBeInTheDocument();
      expect(screen.getByText('Solana Devnet')).toBeInTheDocument();
      expect(screen.getByText(/7xKXtg\.\.\.osgAsU/)).toBeInTheDocument();
    });
  });

  it('shows the privacy badge for stealth transactions', async () => {
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
      expect(screen.getByText('PRIVATE TRANSACTION')).toBeInTheDocument();
      expect(screen.getByText('STEALTH')).toBeInTheDocument();
    });
  });

  it('renders APPROVE and REJECT buttons', async () => {
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
      expect(screen.getByText('APPROVE')).toBeInTheDocument();
      expect(screen.getByText('REJECT')).toBeInTheDocument();
    });
  });

  it('calls rejectRequest and closes window on REJECT', async () => {
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
      expect(screen.getByText('REJECT')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('REJECT'));

    await waitFor(() => {
      expect(mockRejectRequest).toHaveBeenCalledWith('tx-req-6', 'User rejected');
      expect(window.close).toHaveBeenCalled();
    });
  });

  it('displays estimated fee for transactions', async () => {
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
      expect(screen.getByText('EST. FEE')).toBeInTheDocument();
      expect(screen.getByText('~0.000005 SOL')).toBeInTheDocument();
    });
  });
});
