/**
 * Test Helpers for Protocol 01 Extension
 *
 * Provides render wrappers and mock data factories for testing
 * React components that depend on React Router and Zustand stores.
 */

import React, { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { MemoryRouter, MemoryRouterProps } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Router-wrapped render helper
// ---------------------------------------------------------------------------

interface ExtendedRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  routerProps?: MemoryRouterProps;
  initialEntries?: string[];
}

export function renderWithRouter(
  ui: ReactElement,
  options: ExtendedRenderOptions = {},
) {
  const { initialEntries = ['/'], routerProps, ...renderOptions } = options;

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={initialEntries} {...routerProps}>
        {children}
      </MemoryRouter>
    );
  }

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
  };
}

// ---------------------------------------------------------------------------
// Mock wallet public key (valid Solana devnet address)
// ---------------------------------------------------------------------------

export const MOCK_PUBLIC_KEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
export const MOCK_RECIPIENT = 'DRtXHDgC312wpNdNCSb8vCoXDcofCJcPHdAynHjnB5eY';

// ---------------------------------------------------------------------------
// Mock transaction records
// ---------------------------------------------------------------------------

export function createMockTransaction(overrides: Record<string, unknown> = {}) {
  return {
    signature: '5UfDuR...mock',
    type: 'send' as const,
    amount: 1.5,
    tokenSymbol: 'SOL',
    tokenMint: 'native',
    counterparty: MOCK_RECIPIENT,
    timestamp: Date.now() - 3600_000,
    status: 'confirmed' as const,
    isPrivate: false,
    fee: 0.000005,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock stealth payment
// ---------------------------------------------------------------------------

export function createMockStealthPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stealth-payment-1',
    stealthAddress: 'StealthAddr123...mock',
    ephemeralPubKey: 'EphPub456...mock',
    amount: 500_000_000, // 0.5 SOL in lamports
    signature: 'StealthSig789...mock',
    timestamp: Date.now() - 7200_000,
    claimed: false,
    claimSignature: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock approval request
// ---------------------------------------------------------------------------

export function createMockApprovalRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-req-1',
    type: 'connect' as const,
    origin: 'https://example-dapp.com',
    originName: 'Example dApp',
    originIcon: undefined,
    payload: {},
    createdAt: Date.now(),
    ...overrides,
  };
}
