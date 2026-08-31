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
import { RpcConnectionManager, type SolanaCluster } from "@protocol-01/rpc-config";

/**
 * \U0001f6a8 A LOCAL COPY, BECAUSE THE PACKAGE'S OWN STYLESHEET FETCHES A FONT.
 *
 * `@solana/wallet-adapter-react-ui/styles.css` begins with
 * `@import url('https://fonts.googleapis.com/css2?family=DM+Sans...')`, and this
 * provider is mounted ONLY on the private app. So a request to Google for DM
 * Sans was not merely a third-party font load -- it was a beacon that said
 * "someone opened the private app", from that visitor's IP, at that moment, on
 * any cold cache. Nothing else on the site pulls it.
 *
 * \u26a0 The local copy is the upstream file with its first line removed and
 * NOTHING else changed. When the package is upgraded, re-copy it the same way.
 */
import "./pay/wallet-adapter.css";

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
