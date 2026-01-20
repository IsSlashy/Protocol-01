"use client";

import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  Link2,
  FileCode,
  Ticket,
  Lock,
  ShieldCheck,
  Hand,
  Wallet,
  Cpu,
  Boxes,
  Check,
  X,
  AlertTriangle,
  Zap,
  Clock,
  Ban,
  CreditCard,
  RefreshCw,
  FileText,
  Eye
} from "lucide-react";

// ============ P-01 Theme Constants ============
// Inspired by: Hatsune Miku (cyan), NEEDY STREAMER OVERLOAD (pink), ULTRAKILL (red)
// RULES: NO purple | NO black text | NO green #00ff88
const THEME = {
  // Primary: Cyan (Miku)
  primaryColor: "#39c5bb",
  primaryBright: "#00ffe5",
  // Secondary: Pink (KAngel)
  secondaryColor: "#ff77a8",
  pinkHot: "#ff2d7a",
  // Backgrounds
  backgroundColor: "#0a0a0c",
  surfaceColor: "#151518",
  elevatedColor: "#1f1f24",
  // Text (NO black)
  textColor: "#ffffff",
  mutedColor: "#888892",
  dimColor: "#555560",
  // Borders
  borderColor: "#2a2a30",
  // Status (cyan for success, NOT green!)
  successColor: "#39c5bb",
  errorColor: "#ff3366",
  warningColor: "#ffcc00",
  // UI
  borderRadius: "12px",
};

// ============ P-01 Wallet Provider (Native) ============
// Direct integration with Protocol 01 wallet - no other wallets allowed

interface P01WalletContextType {
  connected: boolean;
  connecting: boolean;
  publicKey: string | null;
  walletAvailable: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signMessage: (message: string) => Promise<string | null>;
  signAndSendTransaction: (transaction: unknown) => Promise<string | null>;
}

const P01WalletContext = createContext<P01WalletContextType>({
  connected: false,
  connecting: false,
  publicKey: null,
  walletAvailable: false,
  connect: async () => {},
  disconnect: async () => {},
  signMessage: async () => null,
  signAndSendTransaction: async () => null,
});

export const useP01Wallet = () => useContext(P01WalletContext);

// Type for window.protocol01
interface Protocol01Provider {
  isProtocol01: boolean;
  isConnected: boolean;
  publicKey: { toBase58: () => string } | null;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toBase58: () => string } }>;
  disconnect: () => Promise<void>;
  signMessage: (message: Uint8Array, display?: 'utf8' | 'hex') => Promise<{ signature: Uint8Array; publicKey: { toBase58: () => string } }>;
  signAndSendTransaction: (transaction: unknown) => Promise<{ signature: string }>;
  signTransaction: (transaction: unknown) => Promise<unknown>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  off: (event: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    protocol01?: Protocol01Provider;
  }
}

function P01WalletProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [walletAvailable, setWalletAvailable] = useState(false);

  // Check if P-01 wallet is available
  useEffect(() => {
    const checkWallet = () => {
      // Check both window.protocol01 and window.solana (P-01 injects both)
      const p01 = window.protocol01;
      const solana = (window as unknown as { solana?: Protocol01Provider }).solana;

      // Use protocol01 if available, fallback to solana if it's P-01
      const provider = p01 || (solana?.isProtocol01 ? solana : null);

      const available = !!provider?.isProtocol01;
      console.log("[P-01 SDK] Wallet check:", {
        protocol01: !!p01,
        solana: !!solana,
        isP01: provider?.isProtocol01,
        available
      });

      setWalletAvailable(available);

      if (available && provider?.isConnected && provider?.publicKey) {
        setConnected(true);
        setPublicKey(provider.publicKey.toBase58());
      }
    };

    // Check immediately
    checkWallet();

    // Check multiple times as wallet might inject late
    const timeouts = [100, 500, 1000, 2000].map(delay =>
      setTimeout(checkWallet, delay)
    );

    // Listen for wallet injection
    const handleInit = () => {
      console.log("[P-01 SDK] Wallet initialized event received");
      checkWallet();
    };
    window.addEventListener("protocol01#initialized", handleInit);

    return () => {
      timeouts.forEach(clearTimeout);
      window.removeEventListener("protocol01#initialized", handleInit);
    };
  }, []);

  // Listen for wallet events
  useEffect(() => {
    if (!window.protocol01) return;

    const handleConnect = (data: unknown) => {
      const pubkey = (data as { publicKey?: { toBase58: () => string } })?.publicKey;
      if (pubkey) {
        setConnected(true);
        setPublicKey(pubkey.toBase58());
      }
    };

    const handleDisconnect = () => {
      setConnected(false);
      setPublicKey(null);
    };

    const handleAccountChanged = (pubkey: unknown) => {
      if (pubkey && typeof (pubkey as { toBase58?: () => string }).toBase58 === "function") {
        setPublicKey((pubkey as { toBase58: () => string }).toBase58());
      } else {
        setPublicKey(null);
        setConnected(false);
      }
    };

    window.protocol01.on("connect", handleConnect);
    window.protocol01.on("disconnect", handleDisconnect);
    window.protocol01.on("accountChanged", handleAccountChanged);

    return () => {
      window.protocol01?.off("connect", handleConnect);
      window.protocol01?.off("disconnect", handleDisconnect);
      window.protocol01?.off("accountChanged", handleAccountChanged);
    };
  }, [walletAvailable]);

  const connect = useCallback(async () => {
    if (!window.protocol01) {
      throw new Error("Protocol 01 wallet not installed");
    }

    setConnecting(true);
    try {
      const result = await window.protocol01.connect();
      setConnected(true);
      setPublicKey(result.publicKey.toBase58());
    } catch (error) {
      console.error("Failed to connect:", error);
      throw error;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (!window.protocol01) return;

    try {
      await window.protocol01.disconnect();
      setConnected(false);
      setPublicKey(null);
    } catch (error) {
      console.error("Failed to disconnect:", error);
    }
  }, []);

  const signMessage = useCallback(async (message: string): Promise<string | null> => {
    if (!window.protocol01) {
      throw new Error("Protocol 01 wallet not installed");
    }

    try {
      const encodedMessage = new TextEncoder().encode(message);
      const result = await window.protocol01.signMessage(encodedMessage, 'utf8');

      // Convert signature to base58 or hex string
      const signatureArray = Array.from(result.signature);
      const signatureHex = signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');

      return signatureHex;
    } catch (error) {
      console.error("Failed to sign message:", error);
      throw error;
    }
  }, []);

  const signAndSendTransaction = useCallback(async (transaction: unknown): Promise<string | null> => {
    if (!window.protocol01) {
      throw new Error("Protocol 01 wallet not installed");
    }

    try {
      const result = await window.protocol01.signAndSendTransaction(transaction);
      return result.signature;
    } catch (error) {
      console.error("Failed to sign and send transaction:", error);
      throw error;
    }
  }, []);

  return (
    <P01WalletContext.Provider
      value={{
        connected,
        connecting,
        publicKey,
        walletAvailable,
        connect,
        disconnect,
        signMessage,
        signAndSendTransaction,
      }}
    >
      {children}
    </P01WalletContext.Provider>
  );
}

// ============ Demo Page ============
export default function SDKDemoPage() {
  return (
    <P01WalletProvider>
      <SDKDemoContent />
    </P01WalletProvider>
  );
}

function SDKDemoContent() {
  const [activeTab, setActiveTab] = useState<"devnet" | "streams" | "widgets" | "buttons" | "cards">("devnet");

  return (
    <div className="min-h-screen bg-p01-void">
      {/* Header */}
      <header className="border-b border-p01-border/50 bg-p01-surface/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-p01-cyan font-bold text-xl font-mono">
              P-01
            </Link>
            <span className="text-p01-text-dim">/</span>
            <span className="text-white font-medium">SDK Demo</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-p01-elevated px-3 py-1.5 rounded-lg border border-p01-border">
              <div className="w-2 h-2 bg-p01-cyan animate-pulse" />
              <span className="text-p01-cyan text-sm font-mono">100% Serverless</span>
            </div>
            <div className="flex items-center gap-2 bg-p01-elevated px-3 py-1.5 rounded-lg border border-p01-pink/30">
              <span className="text-p01-pink text-sm font-mono">On-chain verification</span>
            </div>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="flex gap-2 mb-8 flex-wrap">
          {[
            { id: "devnet" as const, label: "Devnet", icon: Cpu, color: "yellow" },
            { id: "streams" as const, label: "Stream SDK", icon: RefreshCw, color: "pink" },
            { id: "widgets" as const, label: "Widgets", icon: CreditCard, color: "cyan" },
            { id: "buttons" as const, label: "Buttons", icon: Zap, color: "cyan" },
            { id: "cards" as const, label: "Cards", icon: FileText, color: "cyan" },
          ].map((tab) => {
            const isActive = activeTab === tab.id;
            const IconComponent = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 font-medium text-sm transition-all font-display uppercase tracking-wider ${
                  isActive
                    ? "bg-p01-cyan text-p01-void"
                    : "bg-p01-surface text-p01-text-muted hover:text-white border border-p01-border hover:border-p01-cyan/50"
                }`}
              >
                <IconComponent size={16} className={isActive ? "text-p01-void" : tab.color === "yellow" ? "text-yellow-500" : tab.color === "pink" ? "text-p01-pink" : "text-p01-cyan"} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === "devnet" && <DevnetSection />}
          {activeTab === "streams" && <StreamSDKSection />}
          {activeTab === "widgets" && <WidgetsSection />}
          {activeTab === "buttons" && <ButtonsSection />}
          {activeTab === "cards" && <CardsSection />}
        </motion.div>
      </div>
    </div>
  );
}

// ============ Devnet Section ============
function DevnetSection() {
  const { publicKey, connected, walletAvailable, connect } = useP01Wallet();
  const [balance, setBalance] = useState<number | null>(null);
  const [airdropLoading, setAirdropLoading] = useState(false);
  const [airdropStatus, setAirdropStatus] = useState<string | null>(null);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);

  // Fetch balance when connected
  useEffect(() => {
    if (!connected || !publicKey) {
      setBalance(null);
      return;
    }

    const fetchBalance = async () => {
      try {
        const response = await fetch(`https://api.devnet.solana.com`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [publicKey],
          }),
        });
        const data = await response.json();
        if (data.result?.value !== undefined) {
          setBalance(data.result.value / 1_000_000_000); // Convert lamports to SOL
        }
      } catch (error) {
        console.error('Failed to fetch balance:', error);
      }
    };

    fetchBalance();
    const interval = setInterval(fetchBalance, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [connected, publicKey]);

  const requestAirdrop = async () => {
    if (!publicKey) return;

    setAirdropLoading(true);
    setAirdropStatus(null);

    try {
      const response = await fetch(`https://api.devnet.solana.com`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'requestAirdrop',
          params: [publicKey, 1_000_000_000], // 1 SOL
        }),
      });
      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message || 'Airdrop failed');
      }

      setAirdropStatus(`SUCCESS: Airdrop complete! TX: ${data.result?.slice(0, 16)}...`);

      // Refresh balance after a delay
      setTimeout(async () => {
        const balanceResponse = await fetch(`https://api.devnet.solana.com`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [publicKey],
          }),
        });
        const balanceData = await balanceResponse.json();
        if (balanceData.result?.value !== undefined) {
          setBalance(balanceData.result.value / 1_000_000_000);
        }
      }, 3000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setAirdropStatus(`ERROR: ${msg}`);
    } finally {
      setAirdropLoading(false);
    }
  };

  const simulatePayment = async () => {
    if (!window.protocol01 || !connected) return;

    setPaymentLoading(true);
    setPaymentStatus(null);

    try {
      // Use signMessage to simulate a simple interaction
      const message = new TextEncoder().encode(
        `Protocol 01 Payment Test\nTimestamp: ${new Date().toISOString()}\nAmount: 0.001 SOL`
      );

      const result = await window.protocol01.signMessage(message, 'utf8');

      // Convert signature to hex for display
      const signatureHex = Array.from(result.signature.slice(0, 8))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      setPaymentStatus(`SUCCESS: Message signed! Signature: ${signatureHex}...`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setPaymentStatus(`ERROR: ${msg}`);
    } finally {
      setPaymentLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Section Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center">
          <Cpu size={20} className="text-yellow-500" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-white font-display">Devnet Testing</h2>
          <p className="text-p01-text-muted text-sm">
            Test wallet connection, get devnet SOL, and simulate payments.
          </p>
        </div>
      </div>

      {/* Wallet Connection Card */}
      <div className="bg-p01-surface p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4 font-display">1. Connect Wallet</h3>

        {!walletAvailable ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-p01-surface border border-p01-border mx-auto mb-4 flex items-center justify-center">
              <Zap size={28} className="text-p01-text-dim" />
            </div>
            <p className="text-p01-text-muted mb-2">Protocol 01 wallet not detected</p>
            <p className="text-p01-text-dim text-sm">Make sure the extension is installed and enabled</p>
          </div>
        ) : !connected ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-p01-cyan/10 border border-p01-cyan/30 mx-auto mb-4 flex items-center justify-center">
              <Wallet size={28} className="text-p01-cyan" />
            </div>
            <p className="text-p01-text-muted mb-4">Connect your wallet to get started</p>
            <P01WalletButton variant="primary" size="lg" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-p01-elevated rounded-xl border border-p01-border">
              <div>
                <p className="text-p01-text-dim text-xs mb-1">Connected Address</p>
                <p className="text-white font-mono text-sm">{publicKey}</p>
              </div>
              <div className="text-right">
                <p className="text-p01-text-dim text-xs mb-1">Devnet Balance</p>
                <p className="text-p01-cyan font-bold text-xl">
                  {balance !== null ? `${balance.toFixed(4)} SOL` : '...'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-3 bg-p01-cyan/10 rounded-lg border border-p01-cyan/30">
              <CheckIcon color={THEME.primaryColor} />
              <span className="text-p01-cyan text-sm font-medium">Wallet connected to Devnet</span>
            </div>
          </div>
        )}
      </div>

      {/* Airdrop Card */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">2. Get Devnet SOL</h3>

        {!connected ? (
          <p className="text-p01-text-dim text-center py-4">Connect wallet first</p>
        ) : (
          <div className="space-y-4">
            <p className="text-p01-text-muted text-sm">
              Request free SOL from the Solana devnet faucet for testing.
            </p>

            <button
              onClick={requestAirdrop}
              disabled={airdropLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                width: '100%',
                padding: '14px 24px',
                backgroundColor: airdropLoading ? THEME.borderColor : THEME.primaryColor,
                color: airdropLoading ? THEME.mutedColor : THEME.backgroundColor,
                border: 'none',
                borderRadius: '12px',
                fontSize: '16px',
                fontWeight: 600,
                cursor: airdropLoading ? 'wait' : 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {airdropLoading ? (
                <>
                  <LoadingSpinner color={THEME.mutedColor} />
                  Requesting Airdrop...
                </>
              ) : (
                <>
                  <RefreshCw size={18} />
                  Request 1 SOL Airdrop
                </>
              )}
            </button>

            {airdropStatus && (
              <div className={`flex items-center gap-2 p-3 text-sm font-mono ${
                airdropStatus.startsWith('SUCCESS')
                  ? 'bg-p01-cyan/10 border border-p01-cyan/30 text-p01-cyan'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
              }`}>
                {airdropStatus.startsWith('SUCCESS') ? <Check size={16} /> : <X size={16} />}
                {airdropStatus}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Payment Simulation Card */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">3. Test Signing</h3>

        {!connected ? (
          <p className="text-p01-text-dim text-center py-4">Connect wallet first</p>
        ) : (
          <div className="space-y-4">
            <p className="text-p01-text-muted text-sm">
              Test message signing with the wallet. This will open an approval popup.
            </p>

            <button
              onClick={simulatePayment}
              disabled={paymentLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                width: '100%',
                padding: '14px 24px',
                backgroundColor: paymentLoading ? THEME.borderColor : THEME.secondaryColor,
                color: paymentLoading ? THEME.mutedColor : THEME.backgroundColor,
                border: 'none',
                borderRadius: '12px',
                fontSize: '16px',
                fontWeight: 600,
                cursor: paymentLoading ? 'wait' : 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {paymentLoading ? (
                <>
                  <LoadingSpinner color={THEME.mutedColor} />
                  Waiting for approval...
                </>
              ) : (
                <>
                  <FileText size={18} />
                  Sign Test Message
                </>
              )}
            </button>

            {paymentStatus && (
              <div className={`flex items-center gap-2 p-3 text-sm font-mono ${
                paymentStatus.startsWith('SUCCESS')
                  ? 'bg-p01-cyan/10 border border-p01-cyan/30 text-p01-cyan'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
              }`}>
                {paymentStatus.startsWith('SUCCESS') ? <Check size={16} /> : <X size={16} />}
                {paymentStatus}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Network Info */}
      <div className="bg-p01-elevated/50 rounded-xl p-4 border border-p01-border/50">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          <span className="text-p01-text-dim text-sm">
            Network: <span className="text-yellow-500 font-medium">Solana Devnet</span>
          </span>
          <span className="text-p01-text-dim text-sm ml-auto">
            RPC: api.devnet.solana.com
          </span>
        </div>
      </div>
    </div>
  );
}

// ============ Developer Whitelist ============
// Check whitelist via API (admin-managed)
async function checkWhitelistAPI(walletAddress: string): Promise<boolean> {
  try {
    console.log("[P-01 SDK] Checking whitelist for:", walletAddress);
    const res = await fetch(`/api/whitelist?wallet=${walletAddress}`);
    const data = await res.json();
    console.log("[P-01 SDK] Whitelist response:", data);
    return data.approved === true;
  } catch (error) {
    console.error("[P-01 SDK] Whitelist check failed:", error);
    return false;
  }
}

// Access request form state
interface AccessRequestForm {
  email: string;
  projectName: string;
  projectDescription: string;
  website: string;
}

// ============ Stream SDK Section ============
function StreamSDKSection() {
  const { publicKey, connected, walletAvailable } = useP01Wallet();
  const [hasDevAccess, setHasDevAccess] = useState<boolean | null>(null);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [formSubmitted, setFormSubmitted] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [formData, setFormData] = useState<AccessRequestForm>({
    email: '',
    projectName: '',
    projectDescription: '',
    website: '',
  });

  // Check whitelist via API
  useEffect(() => {
    if (connected && publicKey) {
      console.log("[P-01 SDK] Wallet connected, checking whitelist for:", publicKey);
      setHasDevAccess(null); // Loading state
      checkWhitelistAPI(publicKey).then((approved) => {
        console.log("[P-01 SDK] Whitelist check result:", approved);
        setHasDevAccess(approved);
      });
    } else {
      setHasDevAccess(null);
      setShowRequestForm(false);
      setFormSubmitted(false);
    }
  }, [connected, publicKey]);

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey || !formData.email || !formData.projectName) return;

    setFormLoading(true);
    try {
      // Save to API (will show in admin panel)
      await fetch('/api/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: publicKey,
          email: formData.email,
          projectName: formData.projectName,
        }),
      });

      // Also send to Discord webhook for notification
      const webhookUrl = process.env.NEXT_PUBLIC_DISCORD_WEBHOOK;
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: '🔑 New Developer Access Request',
              color: 0x39c5bb,
              fields: [
                { name: 'Wallet', value: `\`${publicKey}\``, inline: false },
                { name: 'Email', value: formData.email, inline: true },
                { name: 'Project', value: formData.projectName, inline: true },
                { name: 'Website', value: formData.website || 'N/A', inline: true },
                { name: 'Description', value: formData.projectDescription || 'N/A', inline: false },
              ],
              timestamp: new Date().toISOString(),
            }],
          }),
        });
      }

      setFormSubmitted(true);
      setShowRequestForm(false);
    } catch (error) {
      console.error('Failed to submit request:', error);
      alert('Failed to submit request. Please try again or contact us on Discord.');
    } finally {
      setFormLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Section Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-p01-pink/10 border border-p01-pink/30 flex items-center justify-center">
          <RefreshCw size={20} className="text-p01-pink" />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-white font-display">Stream Payments SDK</h2>
          <p className="text-p01-text-muted text-sm">
            Create subscription payments for your app. No servers needed - everything runs directly on the blockchain.
          </p>
        </div>
      </div>

      {/* Simple Explanation for Beginners */}
      <div className="bg-p01-elevated/50 p-6 border border-p01-border/50">
        <h3 className="text-lg font-semibold text-white mb-4 font-display flex items-center gap-2">
          <Eye size={18} className="text-p01-cyan" />
          What is this in simple terms?
        </h3>
        <div className="space-y-4 text-p01-text-muted">
          <p>
            <span className="text-white font-semibold">Think of Netflix or Spotify</span> - you pay automatically every month.
            Our SDK lets developers create these recurring payments, but with one major difference:
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-p01-void/50 border border-p01-border">
              <p className="text-p01-pink font-semibold mb-2">❌ Traditional Subscriptions</p>
              <ul className="text-sm space-y-1">
                <li>• Netflix can raise prices whenever they want</li>
                <li>• Your card can be charged without limits</li>
                <li>• You have to trust the company</li>
              </ul>
            </div>
            <div className="p-4 bg-p01-void/50 border border-p01-cyan/30">
              <p className="text-p01-cyan font-semibold mb-2">✅ With Protocol 01</p>
              <ul className="text-sm space-y-1">
                <li>• Price is LOCKED when you subscribe</li>
                <li>• Impossible to charge more than agreed</li>
                <li>• You cancel from your wallet, not the website</li>
              </ul>
            </div>
          </div>
          <p className="text-sm text-p01-text-dim">
            <span className="text-p01-cyan">In short:</span> It's like Netflix signing a contract with you - they can never change the terms once you've agreed.
          </p>
        </div>
      </div>

      {/* Key Features */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { icon: Link2, title: "100% Serverless", desc: "No centralized API", color: "cyan" },
          { icon: FileCode, title: "Smart Contract", desc: "On-chain verification", color: "cyan" },
          { icon: Ticket, title: "Whitelist Access", desc: "Verified developers only", color: "pink" },
          { icon: Lock, title: "Closed Circuit", desc: "P01 wallet required", color: "pink" },
          { icon: ShieldCheck, title: "Immutable Pricing", desc: "Prices locked on-chain", color: "cyan" },
          { icon: Hand, title: "Cancel Anytime", desc: "User controls subscription", color: "cyan" },
        ].map((feature) => {
          const IconComponent = feature.icon;
          const colorClass = feature.color === "cyan" ? "text-p01-cyan" : "text-p01-pink";
          const bgClass = feature.color === "cyan" ? "bg-p01-cyan/10 border-p01-cyan/30" : "bg-p01-pink/10 border-p01-pink/30";
          return (
            <div key={feature.title} className="bg-p01-surface p-4 border border-p01-border group hover:border-p01-cyan/50 transition-all">
              <div className={`w-10 h-10 ${bgClass} border flex items-center justify-center mb-3`}>
                <IconComponent size={20} className={colorClass} />
              </div>
              <h4 className="text-white font-semibold mb-1 font-display">{feature.title}</h4>
              <p className="text-p01-text-dim text-sm font-mono">{feature.desc}</p>
            </div>
          );
        })}
      </div>

      {/* Security Alert - Immutable Pricing */}
      <div className="bg-p01-cyan/5 p-6 border border-p01-cyan/30">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-p01-cyan/20 border border-p01-cyan/40 flex items-center justify-center flex-shrink-0">
            <ShieldCheck size={24} className="text-p01-cyan" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-p01-cyan mb-2 font-display">Customer Protection: Locked Prices</h3>
            <p className="text-p01-text-muted text-sm mb-2">
              <span className="text-white font-semibold">What does this mean?</span> When you subscribe at $9.99/month, that price is <span className="text-p01-cyan font-semibold">permanently recorded</span> on the blockchain.
            </p>
            <p className="text-p01-text-muted text-sm mb-4">
              Even if the app developer wants to raise prices, <span className="text-p01-pink font-semibold">they cannot touch your subscription</span>. It's like a signed contract - impossible to modify without your consent.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="bg-p01-void/50 p-3 border border-p01-cyan/20">
                <div className="flex items-center gap-2 mb-1">
                  <Check size={14} className="text-p01-cyan" />
                  <p className="text-p01-cyan text-xs font-mono">YOU CAN</p>
                </div>
                <p className="text-p01-text-muted text-sm">Cancel your subscription anytime you want</p>
              </div>
              <div className="bg-p01-void/50 p-3 border border-p01-cyan/20">
                <div className="flex items-center gap-2 mb-1">
                  <Check size={14} className="text-p01-cyan" />
                  <p className="text-p01-cyan text-xs font-mono">DEVELOPER CAN</p>
                </div>
                <p className="text-p01-text-muted text-sm">Change prices for new customers only</p>
              </div>
              <div className="bg-p01-void/50 p-3 border border-p01-pink/30">
                <div className="flex items-center gap-2 mb-1">
                  <X size={14} className="text-p01-pink" />
                  <p className="text-p01-pink text-xs font-mono">IMPOSSIBLE</p>
                </div>
                <p className="text-p01-text-muted text-sm">Change the price of your existing subscription</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Developer Access Card */}
      <div className="bg-p01-surface p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4 font-display">1. Developer Access</h3>
        <p className="text-p01-text-muted text-sm mb-4">
          To use the Stream SDK, you need to be a whitelisted developer. Request access to get your wallet added to the whitelist.
        </p>

        {!walletAvailable ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 bg-p01-surface border border-p01-border mx-auto mb-4 flex items-center justify-center">
              <Zap size={28} className="text-p01-text-dim" />
            </div>
            <p className="text-p01-text-muted mb-4">Install Protocol 01 wallet to check your access</p>
          </div>
        ) : !connected ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 bg-p01-cyan/10 border border-p01-cyan/30 mx-auto mb-4 flex items-center justify-center">
              <Wallet size={28} className="text-p01-cyan" />
            </div>
            <p className="text-p01-text-muted mb-4">Connect wallet to verify developer access</p>
            <P01WalletButton variant="primary" size="lg" />
          </div>
        ) : hasDevAccess === null ? (
          <div className="flex items-center justify-center py-6 gap-3">
            <LoadingSpinner color={THEME.primaryColor} />
            <span className="text-p01-text-muted">Checking developer whitelist...</span>
          </div>
        ) : hasDevAccess ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-p01-cyan/10 border border-p01-cyan/30">
              <div className="w-12 h-12 bg-p01-cyan/20 border border-p01-cyan/40 flex items-center justify-center">
                <Ticket size={24} className="text-p01-cyan" />
              </div>
              <div className="flex-1">
                <p className="text-p01-cyan font-semibold font-display">Developer Access Verified</p>
                <p className="text-p01-text-dim text-sm font-mono">You have full access to Stream SDK</p>
              </div>
              <div className="w-8 h-8 bg-p01-cyan/20 border border-p01-cyan/40 flex items-center justify-center">
                <Check size={16} className="text-p01-cyan" />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-p01-pink/10 border border-p01-pink/30">
              <div className="w-12 h-12 bg-p01-pink/20 border border-p01-pink/40 flex items-center justify-center">
                <Ban size={24} className="text-p01-pink" />
              </div>
              <div className="flex-1">
                <p className="text-p01-pink font-semibold font-display">Access Not Granted</p>
                <p className="text-p01-text-dim text-sm font-mono">Your wallet is not on the developer whitelist</p>
              </div>
            </div>
            {formSubmitted ? (
              <div className="p-4 bg-p01-cyan/10 border border-p01-cyan/30">
                <div className="flex items-center gap-2 mb-2">
                  <Check size={16} className="text-p01-cyan" />
                  <span className="text-p01-cyan font-semibold">Request Submitted!</span>
                </div>
                <p className="text-p01-text-muted text-sm">
                  We'll review your application and get back to you via email.
                  Join our <a href="https://discord.gg/KfmhPFAHNH" target="_blank" rel="noopener noreferrer" className="text-p01-cyan hover:underline">Discord</a> for faster response.
                </p>
              </div>
            ) : showRequestForm ? (
              <form onSubmit={handleSubmitRequest} className="space-y-4">
                <div>
                  <label className="block text-p01-text-muted text-sm mb-1">Email *</label>
                  <input
                    type="email"
                    required
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="dev@example.com"
                    className="w-full px-4 py-2 bg-p01-void border border-p01-border text-white placeholder-p01-text-dim focus:border-p01-cyan focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-p01-text-muted text-sm mb-1">Project Name *</label>
                  <input
                    type="text"
                    required
                    value={formData.projectName}
                    onChange={(e) => setFormData({ ...formData, projectName: e.target.value })}
                    placeholder="My Awesome DApp"
                    className="w-full px-4 py-2 bg-p01-void border border-p01-border text-white placeholder-p01-text-dim focus:border-p01-cyan focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-p01-text-muted text-sm mb-1">Website</label>
                  <input
                    type="url"
                    value={formData.website}
                    onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                    placeholder="https://myproject.com"
                    className="w-full px-4 py-2 bg-p01-void border border-p01-border text-white placeholder-p01-text-dim focus:border-p01-cyan focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-p01-text-muted text-sm mb-1">Project Description</label>
                  <textarea
                    value={formData.projectDescription}
                    onChange={(e) => setFormData({ ...formData, projectDescription: e.target.value })}
                    placeholder="Tell us about your project and how you plan to use the SDK..."
                    rows={3}
                    className="w-full px-4 py-2 bg-p01-void border border-p01-border text-white placeholder-p01-text-dim focus:border-p01-cyan focus:outline-none resize-none"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setShowRequestForm(false)}
                    className="flex-1 py-2 bg-p01-surface border border-p01-border text-p01-text-muted hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={formLoading}
                    className="flex-1 py-2 bg-p01-cyan text-p01-void font-semibold hover:bg-p01-cyan/90 transition-colors disabled:opacity-50"
                  >
                    {formLoading ? 'Submitting...' : 'Submit Request'}
                  </button>
                </div>
                <p className="text-p01-text-dim text-xs text-center">
                  Your data is encrypted and stored securely. We only use your email to notify you about your access status.
                </p>
              </form>
            ) : (
              <button
                onClick={() => setShowRequestForm(true)}
                className="w-full py-3 bg-p01-pink text-white font-semibold hover:bg-p01-pink/90 transition-colors font-display uppercase tracking-wider text-sm"
              >
                Request Developer Access
              </button>
            )}
            <p className="text-p01-text-dim text-xs text-center mt-3">
              Wallet: <span className="font-mono text-p01-text-muted">{publicKey}</span>
            </p>
          </div>
        )}
      </div>

      {/* SDK Integration */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">2. SDK Integration</h3>
        <p className="text-p01-text-muted text-sm mb-6">
          The SDK connects directly to on-chain programs. No API endpoints, no server infrastructure - everything verified by smart contracts.
        </p>

        <CodeBlock
          title="Initialize SDK (Serverless)"
          code={`import { P01SDK, STREAM_PROGRAM_ID } from '@protocol01/sdk';

// Connect with your P01 wallet - no API keys!
const p01 = new P01SDK({
  wallet: connectedWallet,  // Your Protocol 01 wallet
  network: "mainnet"        // or "devnet" for testing
});

// Smart contract verifies you hold the Developer NFT
// No server request - pure on-chain verification
const isAuthorized = await p01.verifyDeveloperAccess();

if (!isAuthorized) {
  throw new Error("Developer NFT required");
}`}
        />
      </div>

      {/* Create Stream */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">3. Create Payment Stream</h3>
        <p className="text-p01-text-muted text-sm mb-2">
          Create subscription streams for your users. <span className="text-p01-pink font-semibold">Recipients must have a Protocol 01 wallet</span> - this is a closed ecosystem.
        </p>
        <div className="flex items-center gap-3 p-3 bg-p01-pink/10 border border-p01-pink/30 mb-6">
          <AlertTriangle size={18} className="text-p01-pink flex-shrink-0" />
          <span className="text-p01-pink text-sm font-mono">Both sender and recipient must use P01 wallet (closed circuit)</span>
        </div>

        <CodeBlock
          title="Create Subscription Stream"
          code={`// Create a recurring payment stream
// Both parties must have P01 wallet!
const stream = await p01.streams.create({
  recipient: "p01:7xK9f...8c2e", // Must have P01 wallet
  amount: "9.99",                 // ⚠️ IMMUTABLE once subscribed!
  token: "USDC",
  interval: "monthly",
  programId: STREAM_PROGRAM_ID
});

// The smart contract:
// 1. Verifies your Developer NFT
// 2. Verifies recipient has P01 wallet
// 3. LOCKS the price in the subscription record
// 4. Handles automatic payments at LOCKED price

// ⛔ IMPOSSIBLE for developer to do:
// stream.updatePrice("19.99") // ERROR: Price is immutable

// ✅ Only the SUBSCRIBER can cancel:
// Called from subscriber's wallet only
await p01.streams.cancel({ streamId: stream.id });`}
        />
      </div>

      {/* Verify & Manage */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">4. On-Chain Verification</h3>
        <p className="text-p01-text-muted text-sm mb-6">
          All subscription data is stored on-chain. Verify and manage streams without any server calls.
        </p>

        <CodeBlock
          title="Query Streams (On-Chain)"
          code={`// Query streams directly from blockchain
const activeStreams = await p01.streams.query({
  merchant: publicKey,
  status: "active"
});

// Each stream contains IMMUTABLE data:
// - amount: locked at subscription time
// - token: cannot be changed
// - interval: fixed monthly/yearly
// - subscribedAt: timestamp proof

// Verify subscription with locked price
const subscription = await p01.streams.get(streamId);
console.log("Locked price:", subscription.amount); // Never changes!

// ✅ ONLY subscriber can cancel (from their wallet)
// Developer CANNOT cancel or modify!
await p01.streams.cancel({
  streamId: "stream_abc123",
  // Requires subscriber's wallet signature
});`}
        />
      </div>

      {/* Architecture Diagram */}
      <div className="bg-p01-elevated/50 p-6 border border-p01-border/50">
        <h4 className="text-white font-semibold mb-6 font-display text-center">Architecture: No Server Required</h4>
        <div className="flex items-center justify-center gap-6 text-center py-4">
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center relative">
              <Wallet size={28} className="text-p01-cyan" />
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-p01-cyan animate-pulse" />
            </div>
            <span className="text-p01-text-muted text-xs font-mono uppercase tracking-wider">Your dApp</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-[2px] bg-gradient-to-r from-p01-cyan to-p01-cyan/50" />
            <div className="w-2 h-2 bg-p01-cyan rotate-45" />
          </div>
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 bg-p01-pink/10 border border-p01-pink/30 flex items-center justify-center">
              <FileCode size={28} className="text-p01-pink" />
            </div>
            <span className="text-p01-text-muted text-xs font-mono uppercase tracking-wider">Smart Contract</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-[2px] bg-gradient-to-r from-p01-pink/50 to-p01-cyan" />
            <div className="w-2 h-2 bg-p01-cyan rotate-45" />
          </div>
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
              <Boxes size={28} className="text-p01-cyan" />
            </div>
            <span className="text-p01-text-muted text-xs font-mono uppercase tracking-wider">Solana</span>
          </div>
        </div>
        <p className="text-p01-text-dim text-xs text-center mt-6 font-mono">
          Direct wallet → smart contract → blockchain. No API servers, no centralized infrastructure.
        </p>
      </div>

      {/* Security Guarantee */}
      <div className="bg-gradient-to-r from-p01-cyan/5 to-p01-pink/5 p-6 border border-p01-border">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-10 h-10 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
            <Lock size={20} className="text-p01-cyan" />
          </div>
          <h4 className="text-white font-semibold font-display">Your Rights Are Protected by Code</h4>
        </div>
        <p className="text-p01-text-muted text-sm text-center mb-6 max-w-2xl mx-auto">
          A smart contract is like a robot that automatically enforces the rules.
          Nobody - not us, not the developers - can bypass it. Here's what's guaranteed:
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 bg-p01-cyan/20 border border-p01-cyan/30 flex items-center justify-center">
                <Check size={12} className="text-p01-cyan" />
              </div>
              <h5 className="text-p01-cyan font-semibold text-sm font-display uppercase tracking-wider">What YOU can do</h5>
            </div>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-3 text-p01-text-muted">
                <Check size={14} className="text-p01-cyan flex-shrink-0" />
                <span>Your price stays the same, forever</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <Check size={14} className="text-p01-cyan flex-shrink-0" />
                <span>Cancel in one click, directly from your wallet</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <Check size={14} className="text-p01-cyan flex-shrink-0" />
                <span>Nobody can modify without your permission</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <Check size={14} className="text-p01-cyan flex-shrink-0" />
                <span>View your complete payment history</span>
              </li>
            </ul>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 bg-p01-pink/20 border border-p01-pink/30 flex items-center justify-center">
                <X size={12} className="text-p01-pink" />
              </div>
              <h5 className="text-p01-pink font-semibold text-sm font-display uppercase tracking-wider">What developers CANNOT do</h5>
            </div>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-3 text-p01-text-muted">
                <X size={14} className="text-p01-pink flex-shrink-0" />
                <span>Raise your price after you subscribe</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <X size={14} className="text-p01-pink flex-shrink-0" />
                <span>Cancel your subscription without you</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <X size={14} className="text-p01-pink flex-shrink-0" />
                <span>Change from monthly to weekly billing</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <X size={14} className="text-p01-pink flex-shrink-0" />
                <span>Charge more than the agreed amount</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ Widgets Section ============
function WidgetsSection() {
  return (
    <div className="space-y-12">
      {/* Section Header */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Subscription Widget</h2>
        <p className="text-p01-text-muted">
          A complete pricing widget for subscription payments. <span className="text-p01-pink">Requires Protocol 01 wallet.</span>
        </p>
      </div>

      {/* Customer Protection Banner */}
      <div className="flex items-center gap-4 p-4 bg-p01-cyan/10 border border-p01-cyan/30">
        <div className="w-10 h-10 bg-p01-cyan/20 border border-p01-cyan/40 flex items-center justify-center flex-shrink-0">
          <ShieldCheck size={20} className="text-p01-cyan" />
        </div>
        <div>
          <p className="text-p01-cyan font-semibold text-sm font-display">Price Locked On-Chain</p>
          <p className="text-p01-text-dim text-xs font-mono">Once subscribed, the price can never be changed. Cancel anytime from your wallet.</p>
        </div>
      </div>

      {/* Demo Widget */}
      <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
        <DemoSubscriptionWidget />
      </div>

      {/* Code Example */}
      <CodeBlock
        title="Usage (Serverless - No API Keys)"
        code={`import { P01Provider, SubscriptionWidget } from '@protocol01/react';

function PricingPage() {
  return (
    // No merchantId! Wallet connection handles identity
    <P01Provider network="mainnet">
      <SubscriptionWidget
        title="Choose Your Plan"
        programId={STREAM_PROGRAM_ID} // On-chain program
        tiers={[
          {
            id: 'basic',
            name: 'Basic',
            price: 9.99,
            interval: 'monthly',
            features: ['Feature 1', 'Feature 2'],
          },
          {
            id: 'pro',
            name: 'Pro',
            price: 19.99,
            interval: 'monthly',
            popular: true,
            features: ['All Basic', 'Feature 3', 'Feature 4'],
          },
        ]}
        // Recipients must have P01 wallet!
        onSuccess={(result) => console.log('Subscribed:', result.signature)}
      />
    </P01Provider>
  );
}`}
      />
    </div>
  );
}

// ============ Buttons Section ============
function ButtonsSection() {
  return (
    <div className="space-y-12">
      {/* Wallet Button */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Wallet Button</h2>
        <p className="text-p01-text-muted mb-6">Connect/disconnect wallet with various styles.</p>

        <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
          <p className="text-p01-text-dim text-sm mb-4">Click to connect your wallet:</p>
          <div className="flex flex-wrap gap-4 items-center mb-8">
            <P01WalletButton variant="primary" size="lg" />
            <P01WalletButton variant="secondary" size="md" />
            <P01WalletButton variant="outline" size="sm" />
          </div>

          {/* Demo Connected State (static preview) */}
          <p className="text-p01-text-dim text-sm mb-4">Preview of connected state:</p>
          <div className="flex flex-wrap gap-4 items-center">
            <DemoWalletButton connected address="7xK9f...8c2e" isP01Wallet />
            <DemoWalletButton connected address="3mN2p...4f1a" />
          </div>
        </div>

        <CodeBlock
          title="Usage"
          code={`import { WalletButton } from '@protocol01/react';

// P01 wallet only - closed ecosystem
<WalletButton
  variant="primary"
  size="md"
  onConnect={(pubkey) => console.log('Connected:', pubkey)}
  onDisconnect={() => console.log('Disconnected')}
/>`}
        />
      </div>

      {/* Payment Button */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Payment Button</h2>
        <p className="text-p01-text-muted mb-6">One-time payment button with stealth address support.</p>

        <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
          <div className="flex flex-wrap gap-4 items-center">
            <DemoPaymentButton amount={9.99} token="USDC" variant="primary" size="lg" />
            <DemoPaymentButton amount={25} token="SOL" variant="secondary" size="md" />
            <DemoPaymentButton amount={100} token="USDC" variant="outline" size="sm" />
          </div>
        </div>

        <CodeBlock
          title="Usage (On-Chain)"
          code={`import { PaymentButton } from '@protocol01/react';

// Direct on-chain payment - no server
<PaymentButton
  amount={9.99}
  token="USDC"
  recipient="p01:7xK9..." // Must have P01 wallet
  useStealthAddress={true}
  onSuccess={(result) => console.log('TX:', result.signature)}
  onError={(err) => console.error(err)}
/>`}
        />
      </div>

      {/* Subscription Button */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Subscription Button</h2>
        <p className="text-p01-text-muted mb-6">Stream Secure subscription with on-chain limits.</p>

        <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
          <div className="flex flex-wrap gap-4 items-center">
            <DemoSubscriptionButton amount={15.99} interval="monthly" variant="primary" />
            <DemoSubscriptionButton amount={149.99} interval="yearly" variant="secondary" />
          </div>
        </div>

        <CodeBlock
          title="Usage (Smart Contract)"
          code={`import { SubscriptionButton, STREAM_PROGRAM_ID } from '@protocol01/react';

// On-chain subscription via smart contract
<SubscriptionButton
  amount={15.99}
  interval="monthly"
  programId={STREAM_PROGRAM_ID} // On-chain program
  recipient="p01:7xK9..." // Must have P01 wallet
  maxPayments={12}
  useStealthAddress={true}
  onSuccess={(result) => console.log('Stream:', result.streamId)}
/>`}
        />
      </div>
    </div>
  );
}

// ============ Cards Section ============
function CardsSection() {
  return (
    <div className="space-y-12">
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Subscription Card</h2>
        <p className="text-p01-text-muted mb-6">Display active subscriptions with management options.</p>

        <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <DemoSubscriptionCard
              merchantName="Netflix"
              description="Premium Plan"
              amount={15.99}
              interval="monthly"
              status="active"
              nextPayment="in 12 days"
              totalPaid={47.97}
              periodsPaid={3}
              privacyEnabled
            />
            <DemoSubscriptionCard
              merchantName="Spotify"
              description="Family Plan"
              amount={16.99}
              interval="monthly"
              status="paused"
              nextPayment="Paused"
              totalPaid={33.98}
              periodsPaid={2}
            />
            <DemoSubscriptionCard
              merchantName="ChatGPT Plus"
              description="AI Assistant"
              amount={20}
              interval="monthly"
              status="active"
              nextPayment="in 5 days"
              totalPaid={60}
              periodsPaid={3}
            />
            <DemoSubscriptionCard
              merchantName="Adobe CC"
              description="All Apps"
              amount={54.99}
              interval="monthly"
              status="cancelled"
              nextPayment="—"
              totalPaid={164.97}
              periodsPaid={3}
            />
          </div>
        </div>

        <CodeBlock
          title="Usage (On-Chain Data)"
          code={`import { SubscriptionCard, useStreams } from '@protocol01/react';

// Fetch streams directly from blockchain
const { streams } = useStreams({ wallet: publicKey });

// Display on-chain subscription data
<SubscriptionCard
  stream={streams[0]} // On-chain stream data
  showCancel={true}
  onCancel={async (streamId) => {
    // Cancel via smart contract
    await p01.streams.cancel({ streamId });
  }}
/>`}
        />
      </div>
    </div>
  );
}

// ============ Demo Components ============

// Demo Subscription Widget
function DemoSubscriptionWidget() {
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [enablePrivacy, setEnablePrivacy] = useState(true);

  const tiers = [
    {
      id: "basic",
      name: "Basic",
      price: 9.99,
      interval: "monthly",
      features: ["1 Project", "Basic Analytics", "Email Support"],
    },
    {
      id: "pro",
      name: "Pro",
      price: 19.99,
      interval: "monthly",
      popular: true,
      features: ["Unlimited Projects", "Advanced Analytics", "Priority Support", "API Access"],
      trialDays: 14,
    },
    {
      id: "enterprise",
      name: "Enterprise",
      price: 49.99,
      interval: "monthly",
      features: ["Everything in Pro", "Custom Integrations", "Dedicated Manager", "SLA Guarantee"],
    },
  ];

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif" }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "32px" }}>
        <h2 style={{ color: THEME.textColor, fontSize: "28px", fontWeight: 700, margin: "0 0 8px 0" }}>
          Choose Your Plan
        </h2>
        <p style={{ color: THEME.mutedColor, fontSize: "16px", margin: 0 }}>
          Start with a 14-day free trial. No credit card required.
        </p>
      </div>

      {/* Privacy Toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", marginBottom: "24px" }}>
        <button
          onClick={() => setEnablePrivacy(!enablePrivacy)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "10px 16px",
            backgroundColor: enablePrivacy ? `${THEME.primaryColor}15` : THEME.surfaceColor,
            border: `1px solid ${enablePrivacy ? THEME.primaryColor : THEME.borderColor}`,
            borderRadius: "10px",
            cursor: "pointer",
            transition: "all 0.2s ease",
          }}
        >
          {/* Toggle Switch */}
          <div style={{
            width: "36px",
            height: "20px",
            backgroundColor: enablePrivacy ? THEME.primaryColor : THEME.borderColor,
            borderRadius: "10px",
            position: "relative",
            transition: "all 0.2s ease",
          }}>
            <div style={{
              width: "16px",
              height: "16px",
              backgroundColor: THEME.textColor,
              borderRadius: "50%",
              position: "absolute",
              top: "2px",
              left: enablePrivacy ? "18px" : "2px",
              transition: "all 0.2s ease",
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }} />
          </div>
          <ShieldIcon color={enablePrivacy ? THEME.primaryColor : THEME.mutedColor} />
          <span style={{
            color: enablePrivacy ? THEME.textColor : THEME.mutedColor,
            fontSize: "14px",
            fontWeight: 500,
          }}>
            Enable Privacy Features
          </span>
        </button>
      </div>

      {/* Tiers Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "24px" }}>
        {tiers.map((tier) => (
          <div
            key={tier.id}
            onClick={() => setSelectedTier(tier.id)}
            style={{
              backgroundColor: THEME.surfaceColor,
              borderRadius: THEME.borderRadius,
              border: tier.popular ? `2px solid ${THEME.primaryColor}` : `1px solid ${THEME.borderColor}`,
              padding: "24px",
              position: "relative",
              cursor: "pointer",
              transition: "all 0.2s ease",
              transform: selectedTier === tier.id ? "scale(1.02)" : "scale(1)",
            }}
          >
            {/* Popular Badge */}
            {tier.popular && (
              <div
                style={{
                  position: "absolute",
                  top: "-12px",
                  left: "50%",
                  transform: "translateX(-50%)",
                  backgroundColor: THEME.primaryColor,
                  color: THEME.backgroundColor,
                  padding: "4px 16px",
                  borderRadius: "12px",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                Most Popular
              </div>
            )}

            {/* Name */}
            <h3 style={{ color: THEME.textColor, fontSize: "20px", fontWeight: 600, margin: "0 0 8px 0", textAlign: "center" }}>
              {tier.name}
            </h3>

            {/* Price */}
            <div style={{ textAlign: "center", marginBottom: "16px" }}>
              <span style={{ color: THEME.textColor, fontSize: "40px", fontWeight: 700 }}>{tier.price}</span>
              <span style={{ color: THEME.mutedColor, fontSize: "16px", marginLeft: "4px" }}>USDC/{tier.interval}</span>
            </div>

            {/* Trial */}
            {tier.trialDays && (
              <div style={{ textAlign: "center", marginBottom: "16px", color: THEME.primaryColor, fontSize: "13px", fontWeight: 500 }}>
                {tier.trialDays} day free trial
              </div>
            )}

            {/* Features */}
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 20px 0" }}>
              {tier.features.map((feature, index) => (
                <li
                  key={index}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    color: THEME.textColor,
                    fontSize: "14px",
                    marginBottom: "8px",
                  }}
                >
                  <CheckIcon color={THEME.successColor} />
                  {feature}
                </li>
              ))}
            </ul>

            {/* Button */}
            <TierWalletButton popular={tier.popular} tierName={tier.name} price={tier.price} interval={tier.interval} />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", marginTop: "24px", color: THEME.mutedColor, fontSize: "12px" }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }}>
          <LockIcon color={THEME.primaryColor} />
          100% On-chain · Smart Contract Verified · P01 Wallet Required
        </span>
      </div>
    </div>
  );
}

// Demo Wallet Button
function DemoWalletButton({
  variant = "primary",
  size = "md",
  connected = false,
  address,
  isP01Wallet = false,
}: {
  variant?: "primary" | "secondary" | "outline";
  size?: "sm" | "md" | "lg";
  connected?: boolean;
  address?: string;
  isP01Wallet?: boolean;
}) {
  const sizeStyles = {
    sm: { padding: "8px 16px", fontSize: "14px", borderRadius: "8px" },
    md: { padding: "12px 24px", fontSize: "16px", borderRadius: "12px" },
    lg: { padding: "16px 32px", fontSize: "18px", borderRadius: "16px" },
  };

  const variantStyles = connected
    ? { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` }
    : variant === "primary"
    ? { backgroundColor: THEME.primaryColor, color: THEME.backgroundColor, border: "none" }
    : variant === "secondary"
    ? { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` }
    : { backgroundColor: "transparent", color: THEME.primaryColor, border: `2px solid ${THEME.primaryColor}` };

  return (
    <button
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        fontWeight: 600,
        cursor: "pointer",
        transition: "all 0.2s ease",
        ...sizeStyles[size],
        ...variantStyles,
      }}
    >
      {connected ? (
        <>
          {isP01Wallet && <P01Icon />}
          {address}
        </>
      ) : (
        <>
          <WalletIcon />
          Connect Wallet
        </>
      )}
    </button>
  );
}

// P-01 Wallet Button - Direct connection to Protocol 01 wallet only
function P01WalletButton({
  variant = "primary",
  size = "md",
}: {
  variant?: "primary" | "secondary" | "outline";
  size?: "sm" | "md" | "lg";
}) {
  const { publicKey, connected, connecting, walletAvailable, connect, disconnect } = useP01Wallet();

  const sizeStyles = {
    sm: { padding: "8px 16px", fontSize: "14px", borderRadius: "8px" },
    md: { padding: "12px 24px", fontSize: "16px", borderRadius: "12px" },
    lg: { padding: "16px 32px", fontSize: "18px", borderRadius: "16px" },
  };

  const variantStyles = connected
    ? { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` }
    : variant === "primary"
    ? { backgroundColor: THEME.primaryColor, color: THEME.backgroundColor, border: "none" }
    : variant === "secondary"
    ? { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` }
    : { backgroundColor: "transparent", color: THEME.primaryColor, border: `2px solid ${THEME.primaryColor}` };

  const handleClick = async () => {
    if (!walletAvailable) {
      // Redirect to extension install page or show message
      alert("Protocol 01 wallet is not installed. Please install the P-01 extension.");
      return;
    }

    if (connected) {
      await disconnect();
    } else {
      try {
        await connect();
      } catch (error) {
        console.error("Connection failed:", error);
      }
    }
  };

  const truncateAddress = (address: string) => {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  return (
    <button
      onClick={handleClick}
      disabled={connecting}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        fontWeight: 600,
        cursor: connecting ? "wait" : "pointer",
        opacity: connecting ? 0.7 : 1,
        transition: "all 0.2s ease",
        ...sizeStyles[size],
        ...variantStyles,
      }}
    >
      {!walletAvailable ? (
        <>
          <WalletIcon />
          Install P-01 Wallet
        </>
      ) : connecting ? (
        <>
          <LoadingSpinner color={variant === "primary" ? THEME.backgroundColor : THEME.primaryColor} />
          Connecting...
        </>
      ) : connected && publicKey ? (
        <>
          <P01Icon />
          {truncateAddress(publicKey)}
        </>
      ) : (
        <>
          <P01Icon />
          Connect P-01
        </>
      )}
    </button>
  );
}

// Loading Spinner for buttons
function LoadingSpinner({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "spin 1s linear infinite" }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray="32" strokeDashoffset="12" />
    </svg>
  );
}

// Tier Wallet Button - Used in subscription pricing tiers (P-01 only)
// Protocol 01 Treasury address for demo subscriptions (devnet)
const P01_TREASURY = new PublicKey("7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5");
const DEVNET_RPC = "https://api.devnet.solana.com";

function TierWalletButton({ popular = false, tierName = "Basic", price = 9.99, interval = "monthly" }: { popular?: boolean; tierName?: string; price?: number; interval?: string }) {
  const { publicKey, connected, connecting, walletAvailable, connect, signAndSendTransaction } = useP01Wallet();
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const handleClick = async () => {
    if (!walletAvailable) {
      alert("Protocol 01 wallet is not installed. Please install the P-01 extension.");
      return;
    }

    if (!connected) {
      try {
        await connect();
      } catch (error) {
        console.error("Connection failed:", error);
      }
      return;
    }

    if (!publicKey) {
      alert("Wallet not connected properly.");
      return;
    }

    // Already connected - initiate subscription with real transaction
    setIsSubscribing(true);
    try {
      // Connect to devnet
      const connection = new Connection(DEVNET_RPC, "confirmed");

      // Calculate subscription deposit (0.01 SOL for demo, represents first payment)
      const depositLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);

      // Create a real SOL transfer transaction
      const senderPubkey = new PublicKey(publicKey);
      const transaction = new Transaction();

      // Add transfer instruction
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: senderPubkey,
          toPubkey: P01_TREASURY,
          lamports: depositLamports,
        })
      );

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = senderPubkey;

      // Request wallet to sign and send
      const signature = await signAndSendTransaction(transaction);

      if (signature) {
        console.log("Subscription transaction sent:", signature);
        setTxSignature(signature);

        // Wait for confirmation
        await connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight,
        }, "confirmed");

        setSubscribed(true);

        // Show success notification with explorer link
        alert(`✅ Subscription Active!\n\nPlan: ${tierName}\nDeposit: 0.01 SOL (Demo)\nTransaction: ${signature.slice(0, 8)}...${signature.slice(-8)}\n\nView on Solana Explorer:\nhttps://explorer.solana.com/tx/${signature}?cluster=devnet\n\nYour stream payment is now active on devnet!`);
      }
    } catch (error) {
      console.error("Subscription failed:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (errorMessage.includes("insufficient")) {
        alert("Insufficient SOL balance. Please get devnet SOL from a faucet:\nhttps://faucet.solana.com");
      } else {
        alert(`Subscription failed: ${errorMessage}\n\nPlease try again.`);
      }
    } finally {
      setIsSubscribing(false);
    }
  };

  const truncateAddress = (address: string) => {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  const isLoading = connecting || isSubscribing;
  const buttonBg = subscribed ? "#22c55e" : (popular ? THEME.primaryColor : "transparent");
  const buttonColor = subscribed ? "#ffffff" : (popular ? THEME.backgroundColor : THEME.primaryColor);
  const buttonBorder = subscribed ? "none" : (popular ? "none" : `2px solid ${THEME.primaryColor}`);

  return (
    <button
      onClick={handleClick}
      disabled={isLoading || subscribed}
      style={{
        width: "100%",
        padding: "14px 24px",
        backgroundColor: buttonBg,
        color: buttonColor,
        border: buttonBorder,
        borderRadius: "10px",
        fontSize: "16px",
        fontWeight: 600,
        cursor: isLoading || subscribed ? "default" : "pointer",
        opacity: isLoading ? 0.7 : 1,
        transition: "all 0.2s ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
      }}
    >
      {!walletAvailable ? (
        <>
          <WalletIcon />
          Install P-01 Wallet
        </>
      ) : connecting ? (
        <>
          <LoadingSpinner color={buttonColor} />
          Connecting...
        </>
      ) : isSubscribing ? (
        <>
          <LoadingSpinner color={buttonColor} />
          Confirm in Wallet...
        </>
      ) : subscribed ? (
        <>
          <CheckIcon color="#ffffff" />
          Subscribed ✓
        </>
      ) : connected && publicKey ? (
        <>
          <CheckIcon color={buttonColor} />
          Subscribe with {truncateAddress(publicKey)}
        </>
      ) : (
        <>
          <P01Icon />
          Connect P-01
        </>
      )}
    </button>
  );
}

// Demo Payment Button
function DemoPaymentButton({
  amount,
  token,
  variant = "primary",
  size = "md",
}: {
  amount: number;
  token: string;
  variant?: "primary" | "secondary" | "outline";
  size?: "sm" | "md" | "lg";
}) {
  const sizeStyles = {
    sm: { padding: "8px 16px", fontSize: "14px", borderRadius: "8px" },
    md: { padding: "12px 24px", fontSize: "16px", borderRadius: "12px" },
    lg: { padding: "16px 32px", fontSize: "18px", borderRadius: "16px" },
  };

  const variantStyles =
    variant === "primary"
      ? { backgroundColor: THEME.primaryColor, color: THEME.backgroundColor, border: "none" }
      : variant === "secondary"
      ? { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` }
      : { backgroundColor: "transparent", color: THEME.primaryColor, border: `2px solid ${THEME.primaryColor}` };

  return (
    <button
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        fontWeight: 600,
        cursor: "pointer",
        ...sizeStyles[size],
        ...variantStyles,
      }}
    >
      <PaymentIcon />
      Pay {amount} {token}
    </button>
  );
}

// Demo Subscription Button
function DemoSubscriptionButton({
  amount,
  interval,
  variant = "primary",
}: {
  amount: number;
  interval: string;
  variant?: "primary" | "secondary";
}) {
  const variantStyles =
    variant === "primary"
      ? { backgroundColor: THEME.primaryColor, color: THEME.backgroundColor, border: "none" }
      : { backgroundColor: THEME.surfaceColor, color: THEME.textColor, border: `1px solid ${THEME.borderColor}` };

  return (
    <button
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "8px",
        padding: "12px 24px",
        borderRadius: "12px",
        fontSize: "16px",
        fontWeight: 600,
        cursor: "pointer",
        ...variantStyles,
      }}
    >
      <SubscriptionIcon color={variant === "primary" ? THEME.backgroundColor : THEME.primaryColor} />
      Subscribe {amount} USDC/{interval}
    </button>
  );
}

// Demo Subscription Card
function DemoSubscriptionCard({
  merchantName,
  description,
  amount,
  interval,
  status,
  nextPayment,
  totalPaid,
  periodsPaid,
  privacyEnabled = false,
}: {
  merchantName: string;
  description: string;
  amount: number;
  interval: string;
  status: "active" | "paused" | "cancelled";
  nextPayment: string;
  totalPaid: number;
  periodsPaid: number;
  privacyEnabled?: boolean;
}) {
  const statusColor =
    status === "active" ? THEME.successColor : status === "paused" ? "#f59e0b" : THEME.errorColor;

  return (
    <div
      style={{
        backgroundColor: THEME.surfaceColor,
        borderRadius: THEME.borderRadius,
        border: `1px solid ${THEME.borderColor}`,
        padding: "20px",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              borderRadius: "10px",
              backgroundColor: THEME.primaryColor + "20",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <SubscriptionIcon color={THEME.primaryColor} />
          </div>
          <div>
            <h4 style={{ color: THEME.textColor, fontSize: "16px", fontWeight: 600, margin: 0 }}>{merchantName}</h4>
            <p style={{ color: THEME.mutedColor, fontSize: "13px", margin: "2px 0 0 0" }}>{description}</p>
          </div>
        </div>
        <div
          style={{
            padding: "4px 10px",
            borderRadius: "6px",
            backgroundColor: statusColor + "20",
            color: statusColor,
            fontSize: "12px",
            fontWeight: 600,
            textTransform: "capitalize",
          }}
        >
          {status}
        </div>
      </div>

      {/* Details Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", marginBottom: "16px" }}>
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "0 0 4px 0" }}>Amount</p>
          <p style={{ color: THEME.textColor, fontSize: "16px", fontWeight: 600, margin: 0 }}>{amount} USDC</p>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "2px 0 0 0" }}>per {interval}</p>
        </div>
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "0 0 4px 0" }}>Next Payment</p>
          <p style={{ color: THEME.textColor, fontSize: "16px", fontWeight: 600, margin: 0 }}>{nextPayment}</p>
        </div>
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "0 0 4px 0" }}>Total Paid</p>
          <p style={{ color: THEME.textColor, fontSize: "16px", fontWeight: 600, margin: 0 }}>{totalPaid} USDC</p>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "2px 0 0 0" }}>{periodsPaid} payments</p>
        </div>
      </div>

      {/* Privacy Badge */}
      {privacyEnabled && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "6px 12px",
            backgroundColor: THEME.primaryColor + "10",
            borderRadius: "6px",
            marginBottom: "16px",
          }}
        >
          <ShieldIcon color={THEME.primaryColor} />
          <span style={{ color: THEME.primaryColor, fontSize: "12px", fontWeight: 500 }}>Privacy Enabled</span>
        </div>
      )}

      {/* Actions */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          borderTop: `1px solid ${THEME.borderColor}`,
          paddingTop: "16px",
          marginTop: "8px",
        }}
      >
        <button
          style={{
            flex: 1,
            padding: "10px 16px",
            backgroundColor: "transparent",
            color: THEME.textColor,
            border: `1px solid ${THEME.borderColor}`,
            borderRadius: "8px",
            fontSize: "14px",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          View Details
        </button>
        {status === "active" && (
          <button
            style={{
              flex: 1,
              padding: "10px 16px",
              backgroundColor: "transparent",
              color: THEME.errorColor,
              border: `1px solid ${THEME.errorColor}40`,
              borderRadius: "8px",
              fontSize: "14px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ============ Code Block Component ============
function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <span className="text-p01-text-dim text-sm font-mono">{title}</span>
        <button
          onClick={copyCode}
          className="text-p01-text-dim hover:text-white text-sm transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="bg-p01-elevated border border-p01-border rounded-xl p-4 overflow-x-auto">
        <code className="text-sm text-p01-text-muted font-mono whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}

// ============ Icons ============
function CheckIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon({ color }: { color: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9a2 2 0 012-2h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 9V7a2 2 0 012-2h12a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="14" r="2" fill="currentColor" />
    </svg>
  );
}

function P01Icon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </svg>
  );
}

function PaymentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14m-7-7h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SubscriptionIcon({ color }: { color: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
