import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WalletProvider } from '@/components/WalletProvider';

// For this test we want to verify the component structure,
// so we use the real module mocks from setup.ts

describe('WalletProvider -- Solana wallet integration layer', () => {
  describe('Provider Hierarchy', () => {
    it('renders children within the wallet provider chain', () => {
      render(
        <WalletProvider>
          <div data-testid="child">Wallet Child Content</div>
        </WalletProvider>
      );
      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.getByText('Wallet Child Content')).toBeInTheDocument();
    });

    it('accepts a "devnet" network prop (default)', () => {
      const { container } = render(
        <WalletProvider network="devnet">
          <span>devnet child</span>
        </WalletProvider>
      );
      expect(container).toBeTruthy();
      expect(screen.getByText('devnet child')).toBeInTheDocument();
    });

    it('accepts a "mainnet-beta" network prop', () => {
      const { container } = render(
        <WalletProvider network="mainnet-beta">
          <span>mainnet child</span>
        </WalletProvider>
      );
      expect(container).toBeTruthy();
      expect(screen.getByText('mainnet child')).toBeInTheDocument();
    });

    it('accepts a "testnet" network prop', () => {
      const { container } = render(
        <WalletProvider network="testnet">
          <span>testnet child</span>
        </WalletProvider>
      );
      expect(container).toBeTruthy();
      expect(screen.getByText('testnet child')).toBeInTheDocument();
    });
  });

  describe('Supported Wallets', () => {
    it('initializes PhantomWalletAdapter', async () => {
      const { PhantomWalletAdapter } = await import('@solana/wallet-adapter-wallets');
      render(
        <WalletProvider>
          <div>test</div>
        </WalletProvider>
      );
      expect(PhantomWalletAdapter).toHaveBeenCalled();
    });

    it('initializes SolflareWalletAdapter', async () => {
      const { SolflareWalletAdapter } = await import('@solana/wallet-adapter-wallets');
      render(
        <WalletProvider>
          <div>test</div>
        </WalletProvider>
      );
      expect(SolflareWalletAdapter).toHaveBeenCalled();
    });

    it('initializes CoinbaseWalletAdapter', async () => {
      const { CoinbaseWalletAdapter } = await import('@solana/wallet-adapter-wallets');
      render(
        <WalletProvider>
          <div>test</div>
        </WalletProvider>
      );
      expect(CoinbaseWalletAdapter).toHaveBeenCalled();
    });

    it('initializes LedgerWalletAdapter for hardware wallet support', async () => {
      const { LedgerWalletAdapter } = await import('@solana/wallet-adapter-wallets');
      render(
        <WalletProvider>
          <div>test</div>
        </WalletProvider>
      );
      expect(LedgerWalletAdapter).toHaveBeenCalled();
    });

    it('initializes TorusWalletAdapter for social login support', async () => {
      const { TorusWalletAdapter } = await import('@solana/wallet-adapter-wallets');
      render(
        <WalletProvider>
          <div>test</div>
        </WalletProvider>
      );
      expect(TorusWalletAdapter).toHaveBeenCalled();
    });
  });
});
