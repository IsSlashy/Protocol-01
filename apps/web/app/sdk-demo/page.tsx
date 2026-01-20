"use client";

import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
import { motion } from "framer-motion";
import Link from "next/link";

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
}

const P01WalletContext = createContext<P01WalletContextType>({
  connected: false,
  connecting: false,
  publicKey: null,
  walletAvailable: false,
  connect: async () => {},
  disconnect: async () => {},
});

export const useP01Wallet = () => useContext(P01WalletContext);

// Type for window.protocol01
interface Protocol01Provider {
  isProtocol01: boolean;
  isConnected: boolean;
  publicKey: { toBase58: () => string } | null;
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toBase58: () => string } }>;
  disconnect: () => Promise<void>;
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

  return (
    <P01WalletContext.Provider
      value={{
        connected,
        connecting,
        publicKey,
        walletAvailable,
        connect,
        disconnect,
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
  const [activeTab, setActiveTab] = useState<"widgets" | "buttons" | "cards" | "devnet">("devnet");

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
          <div className="flex items-center gap-2">
            <code className="bg-p01-elevated px-3 py-1.5 rounded-lg text-p01-cyan text-sm font-mono">
              npm install p-01
            </code>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="flex gap-2 mb-8">
          {(["devnet", "widgets", "buttons", "cards"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                activeTab === tab
                  ? "bg-p01-cyan text-p01-void"
                  : "bg-p01-surface text-p01-text-muted hover:text-white border border-p01-border"
              }`}
            >
              {tab === "devnet" ? "🧪 Devnet" : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Content */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === "devnet" && <DevnetSection />}
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

      setAirdropStatus(`✅ Airdrop successful! TX: ${data.result?.slice(0, 16)}...`);

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
      setAirdropStatus(`❌ ${msg}`);
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
      setPaymentStatus(`✅ Message signed! Signature: ${Array.from(result.signature.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')}...`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setPaymentStatus(`❌ ${msg}`);
    } finally {
      setPaymentLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Section Header */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">🧪 Devnet Testing</h2>
        <p className="text-p01-text-muted">
          Test wallet connection, get devnet SOL, and simulate payments.
        </p>
      </div>

      {/* Wallet Connection Card */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">1. Connect Wallet</h3>

        {!walletAvailable ? (
          <div className="text-center py-8">
            <div className="text-4xl mb-4">🔌</div>
            <p className="text-p01-text-muted mb-4">Protocol 01 wallet not detected</p>
            <p className="text-p01-text-dim text-sm">Make sure the extension is installed and enabled</p>
          </div>
        ) : !connected ? (
          <div className="text-center py-8">
            <div className="text-4xl mb-4">👛</div>
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
                  💧 Request 1 SOL Airdrop
                </>
              )}
            </button>

            {airdropStatus && (
              <div className={`p-3 rounded-lg text-sm font-mono ${
                airdropStatus.startsWith('✅')
                  ? 'bg-p01-cyan/10 border border-p01-cyan/30 text-p01-cyan'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
              }`}>
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
                  ✍️ Sign Test Message
                </>
              )}
            </button>

            {paymentStatus && (
              <div className={`p-3 rounded-lg text-sm font-mono ${
                paymentStatus.startsWith('✅')
                  ? 'bg-p01-cyan/10 border border-p01-cyan/30 text-p01-cyan'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
              }`}>
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

// ============ Widgets Section ============
function WidgetsSection() {
  return (
    <div className="space-y-12">
      {/* Section Header */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Subscription Widget</h2>
        <p className="text-p01-text-muted">
          A complete pricing widget for subscription payments with Stream Secure protection.
        </p>
      </div>

      {/* Demo Widget */}
      <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
        <DemoSubscriptionWidget />
      </div>

      {/* Code Example */}
      <CodeBlock
        title="Usage"
        code={`import { P01Provider, SubscriptionWidget } from 'p-01/react';

function PricingPage() {
  return (
    <P01Provider config={{ merchantId: 'your-id', merchantName: 'Your App' }}>
      <SubscriptionWidget
        title="Choose Your Plan"
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
        onSuccess={(result) => console.log('Subscribed:', result)}
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
          code={`import { WalletButton } from 'p-01/react';

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
          title="Usage"
          code={`import { PaymentButton } from 'p-01/react';

<PaymentButton
  amount={9.99}
  token="USDC"
  description="Premium Feature"
  useStealthAddress={true}
  onSuccess={(result) => console.log('Paid:', result.signature)}
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
          title="Usage"
          code={`import { SubscriptionButton } from 'p-01/react';

<SubscriptionButton
  amount={15.99}
  interval="monthly"
  maxPayments={12}
  description="Pro Plan"
  suggestedPrivacy={{ useStealthAddress: true }}
  onSuccess={(result) => console.log('Subscribed:', result.subscriptionId)}
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
          title="Usage"
          code={`import { SubscriptionCard } from 'p-01/react';

<SubscriptionCard
  subscription={subscription}
  showCancel={true}
  onCancel={(id) => console.log('Cancelled:', id)}
  onViewDetails={(sub) => openModal(sub)}
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
            <TierWalletButton popular={tier.popular} />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", marginTop: "24px", color: THEME.mutedColor, fontSize: "12px" }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }}>
          <LockIcon color={THEME.primaryColor} />
          Secured by Protocol 01 Stream Secure
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
function TierWalletButton({ popular = false }: { popular?: boolean }) {
  const { publicKey, connected, connecting, walletAvailable, connect } = useP01Wallet();

  const handleClick = async () => {
    if (!walletAvailable) {
      alert("Protocol 01 wallet is not installed. Please install the P-01 extension.");
      return;
    }

    if (connected) {
      // Already connected - could show subscription modal here
      alert(`Ready to subscribe with wallet: ${publicKey?.slice(0, 8)}...`);
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
        width: "100%",
        padding: "14px 24px",
        backgroundColor: popular ? THEME.primaryColor : "transparent",
        color: popular ? THEME.backgroundColor : THEME.primaryColor,
        border: popular ? "none" : `2px solid ${THEME.primaryColor}`,
        borderRadius: "10px",
        fontSize: "16px",
        fontWeight: 600,
        cursor: connecting ? "wait" : "pointer",
        opacity: connecting ? 0.7 : 1,
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
          <LoadingSpinner color={popular ? THEME.backgroundColor : THEME.primaryColor} />
          Connecting...
        </>
      ) : connected && publicKey ? (
        <>
          <CheckIcon color={popular ? THEME.backgroundColor : THEME.primaryColor} />
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
