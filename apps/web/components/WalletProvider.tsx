"use client";

import React, { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  CoinbaseWalletAdapter,
  LedgerWalletAdapter,
  TorusWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { RpcConnectionManager, type SolanaCluster } from "@p01/rpc-config";

// Import wallet adapter styles
import "@solana/wallet-adapter-react-ui/styles.css";

interface WalletProviderProps {
  children: React.ReactNode;
  network?: "mainnet-beta" | "devnet" | "testnet";
}

export function WalletProvider({
  children,
  network = "devnet",
}: WalletProviderProps) {
  // RPC endpoint — prefer Helius if NEXT_PUBLIC_HELIUS_API_KEY is set, else public RPC
  const endpoint = useMemo(() => {
    const heliusApiKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY;
    const mgr = new RpcConnectionManager({
      cluster: network as SolanaCluster,
      commitment: "confirmed",
      heliusApiKey: heliusApiKey || undefined,
    });
    return mgr.getCurrentEndpoint().http;
  }, [network]);

  // Wallets to support
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter(),
      new LedgerWalletAdapter(),
      new TorusWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        {/* @ts-ignore React 19 type compatibility with wallet adapter */}
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

export default WalletProvider;
