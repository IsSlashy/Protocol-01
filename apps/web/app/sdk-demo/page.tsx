"use client";

import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
import { motion } from "framer-motion";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useT } from "@/i18n";
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
  Eye,
  Shield,
  Copy
} from "lucide-react";
import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";

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

interface SubscriptionOptions {
  recipient: string;
  merchantName: string;
  merchantLogo?: string;
  tokenMint?: string;
  amountPerPeriod: number;
  periodSeconds: number;
  maxPeriods?: number;
  description?: string;
  // Privacy preferences selected on the site. Forwarded to the wallet so the
  // approval popup mirrors them (it shows them read-only — see ApproveSubscription).
  amountNoise?: number;        // +/-% variance on each charge
  timingNoise?: number;        // +/-hours jitter on payment time
  useStealthAddress?: boolean; // unique receiving address per payment
}

// Tolerant shape — the wallet returns its raw stored subscriptions, whose field
// names have varied across versions (name vs merchantName, status vs isActive).
interface WalletSubscription {
  id: string;
  name?: string;
  merchantName?: string;
  recipient: string;
  status?: 'active' | 'paused' | 'cancelled';
  isActive?: boolean;
  origin?: string;
}

interface P01WalletContextType {
  connected: boolean;
  connecting: boolean;
  publicKey: string | null;
  walletAvailable: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signMessage: (message: string) => Promise<string | null>;
  signAndSendTransaction: (transaction: unknown) => Promise<string | null>;
  subscribe: (options: SubscriptionOptions) => Promise<{ subscriptionId: string; address: string } | null>;
  getSubscriptions: () => Promise<WalletSubscription[]>;
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
  subscribe: async () => null,
  getSubscriptions: async () => [],
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
  subscribe: (options: {
    recipient: string;
    merchantName: string;
    merchantLogo?: string;
    tokenMint?: string;
    amountPerPeriod: number;
    periodSeconds: number;
    maxPeriods?: number;
    description?: string;
    amountNoise?: number;
    timingNoise?: number;
    useStealthAddress?: boolean;
  }) => Promise<{ subscriptionId: string; address: string }>;
  getSubscriptions: () => Promise<Array<{
    id: string;
    name?: string;
    merchantName?: string;
    recipient: string;
    status?: 'active' | 'paused' | 'cancelled';
    isActive?: boolean;
    origin?: string;
  }>>;
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
      checkWallet();
    };
    window.addEventListener("protocol01#initialized", handleInit);

    return () => {
      timeouts.forEach(clearTimeout);
      window.removeEventListener("protocol01#initialized", handleInit);
    };
  }, []);

  // Eager (trusted-only) reconnect on load. Already-approved sites restore the
  // connection without a manual click — and with it, the "already subscribed"
  // button state. Throws (caught) if the site was never approved.
  useEffect(() => {
    if (!walletAvailable || connected) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await window.protocol01?.connect({ onlyIfTrusted: true });
        if (!cancelled && result?.publicKey) {
          setConnected(true);
          setPublicKey(result.publicKey.toBase58());
        }
      } catch {
        // Not previously approved — stay disconnected; user can click Connect.
      }
    })();
    return () => { cancelled = true; };
  }, [walletAvailable, connected]);

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

  const subscribe = useCallback(async (options: SubscriptionOptions): Promise<{ subscriptionId: string; address: string } | null> => {
    if (!window.protocol01) {
      throw new Error("Protocol 01 wallet not installed");
    }

    try {
      const result = await window.protocol01.subscribe(options);
      return result;
    } catch (error) {
      console.error("Failed to create subscription:", error);
      throw error;
    }
  }, []);

  const getSubscriptions = useCallback(async (): Promise<WalletSubscription[]> => {
    if (!window.protocol01?.getSubscriptions) return [];
    try {
      const subs = await window.protocol01.getSubscriptions();
      return Array.isArray(subs) ? (subs as WalletSubscription[]) : [];
    } catch (error) {
      console.error("Failed to fetch subscriptions:", error);
      return [];
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
        subscribe,
        getSubscriptions,
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
  const [activeTab, setActiveTab] = useState<"devnet" | "privacy" | "streams" | "widgets" | "buttons" | "cards">("devnet");
  const t = useT();

  const tabs = [
    { id: "devnet" as const, label: t('sdkDemo.tabDevnet'), icon: Cpu, accent: "text-yellow-500" },
    { id: "privacy" as const, label: t('sdkDemo.tabPrivacy'), icon: Shield, accent: "text-p01-cyan" },
    { id: "streams" as const, label: t('sdkDemo.tabStreams'), icon: RefreshCw, accent: "text-p01-pink" },
    { id: "widgets" as const, label: t('sdkDemo.tabWidgets'), icon: CreditCard, accent: "text-p01-cyan" },
    { id: "buttons" as const, label: t('sdkDemo.tabButtons'), icon: Zap, accent: "text-p01-cyan" },
    { id: "cards" as const, label: t('sdkDemo.tabCards'), icon: FileText, accent: "text-p01-cyan" },
  ];

  return (
    <div className="min-h-screen bg-p01-void">
      <SiteHeader />

      {/* Hero */}
      <section className="max-w-7xl mx-auto px-6 pt-28 pb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-p01-cyan/25 bg-p01-cyan/10 mb-5">
          <span className="w-1.5 h-1.5 rounded-full bg-p01-cyan animate-pulse" />
          <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-p01-cyan">
            {t('sdkDemo.heroKicker')}
          </span>
        </div>
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white font-display tracking-tight mb-4">
          {t('sdkDemo.headerTitle')}
        </h1>
        <p className="text-p01-text-muted max-w-2xl leading-relaxed mb-6">{t('sdkDemo.heroSubtitle')}</p>

        <div className="flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.03] border border-p01-cyan/30">
            <span className="w-1.5 h-1.5 rounded-full bg-p01-cyan animate-pulse" />
            <span className="text-xs font-mono text-p01-cyan">{t('sdkDemo.serverless')}</span>
          </span>
          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.03] border border-p01-pink/30">
            <span className="text-xs font-mono text-p01-pink">{t('sdkDemo.onChainVerification')}</span>
          </span>
          <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.03] border border-yellow-500/30">
            <span className="text-xs font-mono text-yellow-500">{t('sdkDemo.tabDevnet')}</span>
          </span>
        </div>

        <div className="mt-7 max-w-md">
          <CodeBlock title={t('sdkDemo.installCodeTitle')} code="pnpm add @protocol-01/privacy-sdk" />
        </div>
      </section>

      {/* Sticky pill tabs */}
      <div className="sticky top-16 z-40 bg-p01-void/80 backdrop-blur-xl border-b border-p01-border/40">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-2 py-3 overflow-x-auto">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              const IconComponent = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-xs font-display uppercase tracking-wider transition-all ${
                    isActive
                      ? "bg-p01-cyan text-p01-void"
                      : "bg-white/[0.03] text-p01-text-muted hover:text-white border border-p01-border hover:border-p01-cyan/50"
                  }`}
                >
                  <IconComponent size={15} className={isActive ? "text-p01-void" : tab.accent} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-6 py-10">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === "devnet" && <DevnetSection />}
          {activeTab === "privacy" && <PrivacySDKSection />}
          {activeTab === "streams" && <StreamSDKSection />}
          {activeTab === "widgets" && <WidgetsSection />}
          {activeTab === "buttons" && <ButtonsSection />}
          {activeTab === "cards" && <CardsSection />}
        </motion.div>
      </div>

      <Footer />
    </div>
  );
}

// ============ Shared section header ============
function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  accent = "cyan",
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  subtitle?: string;
  accent?: "cyan" | "pink" | "yellow";
}) {
  const map = {
    cyan: { box: "bg-p01-cyan/10 border-p01-cyan/30", icon: "text-p01-cyan" },
    pink: { box: "bg-p01-pink/10 border-p01-pink/30", icon: "text-p01-pink" },
    yellow: { box: "bg-yellow-500/10 border-yellow-500/30", icon: "text-yellow-500" },
  }[accent];
  return (
    <div className="flex items-center gap-3">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${map.box}`}>
        <Icon size={20} className={map.icon} />
      </div>
      <div>
        <h2 className="text-2xl font-bold text-white font-display tracking-tight">{title}</h2>
        {subtitle && <p className="text-p01-text-muted text-sm mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

// ============ Privacy SDKs Section ============
function PrivacySDKSection() {
  const t = useT();
  return (
    <div className="space-y-8">
      <SectionHeader
        icon={Shield}
        title={t('sdkDemo.privacySdksTitle')}
        subtitle={t('sdkDemo.privacySdksDesc')}
        accent="cyan"
      />

      {/* SDK Overview Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { name: "@protocol-01/specter-sdk", desc: t('sdkDemo.sdkSpecterDesc'), color: "cyan" },
          { name: "@protocol-01/zk-sdk", desc: t('sdkDemo.sdkZkDesc'), color: "cyan" },
          { name: "@protocol-01/zkspl-sdk", desc: t('sdkDemo.sdkZksplDesc'), color: "pink" },
          { name: "@protocol-01/privacy-toolkit", desc: t('sdkDemo.sdkPrivacyToolkitDesc'), color: "cyan" },
          { name: "@protocol-01/auth-sdk", desc: t('sdkDemo.sdkAuthDesc'), color: "cyan" },
          { name: "@protocol-01/p01-js", desc: t('sdkDemo.sdkP01JsDesc'), color: "pink" },
          { name: "@protocol-01/rpc-config", desc: t('sdkDemo.sdkRpcConfigDesc'), color: "cyan" },
        ].map((sdk) => (
          <div key={sdk.name} className="bg-p01-surface rounded-xl p-4 border border-p01-border hover:border-p01-cyan/50 transition-all group">
            <p className={`text-sm font-mono font-bold mb-1 ${sdk.color === "cyan" ? "text-p01-cyan" : "text-p01-pink"}`}>{sdk.name}</p>
            <p className="text-p01-text-dim text-xs">{sdk.desc}</p>
          </div>
        ))}
      </div>

      {/* Stealth Addresses */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-2 font-display">{t('sdkDemo.stealthTitle')}</h3>
        <p className="text-p01-text-muted text-sm mb-4">
          {t('sdkDemo.stealthDesc')}
        </p>
        <CodeBlock
          title={t('sdkDemo.stealthCodeTitle')}
          code={`import { generateStealthAddress, scanForPayments } from '@protocol-01/specter-sdk';

// Sender generates a one-time stealth address for the recipient
const { stealthAddress, ephemeralPubKey } = generateStealthAddress({
  spendingPubKey: recipientMeta.spendingPubKey,
  viewingPubKey: recipientMeta.viewingPubKey,
  useQuantumSafe: true,  // ML-KEM-768 hybrid mode
});

// Send funds to the stealth address — unlinkable to recipient
await transfer(connection, payer, stealthAddress, amount);

// Recipient scans chain for payments addressed to them
const payments = await scanForPayments({
  viewingKey: myViewingKey,
  fromSlot: lastScannedSlot,
});`}
        />
      </div>

      {/* ZK Proofs */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-2 font-display">{t('sdkDemo.zkProofsTitle')}</h3>
        <p className="text-p01-text-muted text-sm mb-4">
          {t('sdkDemo.zkProofsDesc')}
        </p>
        <CodeBlock
          title={t('sdkDemo.zkProofsCodeTitle')}
          code={`import { proveTransfer, verifyProof } from '@protocol-01/zk-sdk';

// Generate a STARK proof for a confidential transfer
const { proof, publicSignals } = await proveTransfer({
  senderNote: myShieldedNote,
  recipientPubKey: recipientStealthAddress,
  amount: 100_000_000, // 0.1 SOL in lamports
  merkleProof: treePath,
});

// Submit proof to on-chain verifier (zk_shielded program)
const tx = await submitShieldedTransfer(connection, wallet, {
  proof,
  publicSignals,
  nullifier: publicSignals.nullifier,
});`}
        />
      </div>

      {/* Confidential SPL */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-2 font-display">{t('sdkDemo.confSplTitle')}</h3>
        <p className="text-p01-text-muted text-sm mb-4">
          {t('sdkDemo.confSplDesc')}
        </p>
        <CodeBlock
          title={t('sdkDemo.confSplCodeTitle')}
          code={`import { shieldTokens, unshieldTokens } from '@protocol-01/zkspl-sdk';

// Shield 100 USDC into a denominated pool
const shieldResult = await shieldTokens({
  connection, wallet,
  mint: USDC_MINT,
  amount: 100_000_000, // 100 USDC (6 decimals)
  pool: 'pool_100',    // 100 USDC denomination
});

// Later: unshield with ZK proof (no link to deposit)
const unshieldResult = await unshieldTokens({
  connection, wallet,
  note: shieldResult.note,
  recipient: myStealthAddress,
  proof: await generateUnshieldProof(shieldResult.note),
});`}
        />
      </div>

      {/* Privacy Toolkit */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-2 font-display">{t('sdkDemo.privacyToolkitTitle')}</h3>
        <p className="text-p01-text-muted text-sm mb-4">
          {t('sdkDemo.privacyToolkitDesc')}
        </p>
        <CodeBlock
          title={t('sdkDemo.privacyToolkitCodeTitle')}
          code={`import { poseidonHash, MerkleTree, WOTSKeypair } from '@protocol-01/privacy-toolkit';

// Poseidon hash for ZK-friendly commitments
const commitment = poseidonHash([amount, owner, randomness, tokenId]);

// Build Merkle tree of note commitments
const tree = new MerkleTree(20); // depth 20
tree.insert(commitment);
const proof = tree.getProof(0); // path for leaf 0

// WOTS+ one-time signature (quantum-resistant)
const wots = WOTSKeypair.generate(secret, chainIndex);
const signature = wots.sign(messageHash);
const valid = WOTSKeypair.verify(wots.publicKey, messageHash, signature);`}
        />
      </div>

      {/* Architecture callout */}
      <div className="bg-p01-elevated/50 rounded-2xl p-6 border border-p01-border/50">
        <h4 className="text-white font-semibold mb-4 font-display text-center">{t('sdkDemo.archTitle')}</h4>
        <div className="flex items-center justify-center gap-4 text-center py-4 flex-wrap">
          {[
            { label: t('sdkDemo.archClientSdks'), sub: "specter · zk · zkspl", icon: Wallet },
            { label: t('sdkDemo.archProofLayer'), sub: "STARK · ZK", icon: Shield },
            { label: t('sdkDemo.archOnChain'), sub: "14 Anchor Programs", icon: Boxes },
          ].map((item, i) => (
            <React.Fragment key={item.label}>
              {i > 0 && (
                <div className="flex items-center gap-1">
                  <div className="w-6 h-[2px] bg-gradient-to-r from-p01-cyan to-p01-cyan/50" />
                  <div className="w-2 h-2 bg-p01-cyan rotate-45" />
                </div>
              )}
              <div className="flex flex-col items-center gap-2">
                <div className="w-14 h-14 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
                  <item.icon size={24} className="text-p01-cyan" />
                </div>
                <span className="text-white text-xs font-display uppercase tracking-wider">{item.label}</span>
                <span className="text-p01-text-dim text-[10px] font-mono">{item.sub}</span>
              </div>
            </React.Fragment>
          ))}
        </div>
        <p className="text-p01-text-dim text-xs text-center mt-4 font-mono">
          {t('sdkDemo.archFooter')}
        </p>
      </div>

      {/* Install */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4 font-display">{t('sdkDemo.installTitle')}</h3>
        <CodeBlock
          title={t('sdkDemo.installCodeTitle')}
          code={`# Core SDK
pnpm add @protocol-01/p01-js @protocol-01/rpc-config

# Privacy layer
pnpm add @protocol-01/specter-sdk @protocol-01/zk-sdk @protocol-01/zkspl-sdk @protocol-01/privacy-toolkit

# Optional: Auth
pnpm add @protocol-01/auth-sdk`}
        />
      </div>
    </div>
  );
}

// ============ Devnet Section ============
function DevnetSection() {
  const t = useT();
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

  const sendTestPayment = async () => {
    if (!window.protocol01 || !connected || !publicKey) return;

    setPaymentLoading(true);
    setPaymentStatus(null);

    try {
      // Build and send a REAL 0.001 SOL self-transfer on devnet, signed and
      // broadcast through the Protocol 01 extension (window.protocol01
      // .signAndSendTransaction) — a genuine on-chain interaction, not a mock.
      const connection = new Connection("https://api.devnet.solana.com", "confirmed");
      const owner = new PublicKey(publicKey);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");

      const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: owner,
          lamports: Math.round(0.001 * LAMPORTS_PER_SOL),
        })
      );

      const { signature } = await window.protocol01.signAndSendTransaction(tx);
      setPaymentStatus(`SUCCESS: Sent on devnet. TX: ${signature.slice(0, 24)}...`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      setPaymentStatus(`ERROR: ${msg}`);
    } finally {
      setPaymentLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        icon={Cpu}
        title={t('sdkDemo.devnetTitle')}
        subtitle={t('sdkDemo.devnetDesc')}
        accent="yellow"
      />

      {/* Wallet Connection Card */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4 font-display">{t('sdkDemo.connectWalletTitle')}</h3>

        {!walletAvailable ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-p01-surface border border-p01-border mx-auto mb-4 flex items-center justify-center">
              <Zap size={28} className="text-p01-text-dim" />
            </div>
            <p className="text-p01-text-muted mb-2">{t('sdkDemo.walletNotDetected')}</p>
            <p className="text-p01-text-dim text-sm">{t('sdkDemo.walletNotDetectedHint')}</p>
          </div>
        ) : !connected ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-p01-cyan/10 border border-p01-cyan/30 mx-auto mb-4 flex items-center justify-center">
              <Wallet size={28} className="text-p01-cyan" />
            </div>
            <p className="text-p01-text-muted mb-4">{t('sdkDemo.connectToStart')}</p>
            <P01WalletButton variant="primary" size="lg" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-p01-elevated rounded-xl border border-p01-border">
              <div>
                <p className="text-p01-text-dim text-xs mb-1">{t('sdkDemo.connectedAddress')}</p>
                <p className="text-white font-mono text-sm">{publicKey}</p>
              </div>
              <div className="text-right">
                <p className="text-p01-text-dim text-xs mb-1">{t('sdkDemo.devnetBalance')}</p>
                <p className="text-p01-cyan font-bold text-xl">
                  {balance !== null ? `${balance.toFixed(4)} SOL` : '...'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-3 bg-p01-cyan/10 rounded-lg border border-p01-cyan/30">
              <CheckIcon color={THEME.primaryColor} />
              <span className="text-p01-cyan text-sm font-medium">{t('sdkDemo.walletConnectedDevnet')}</span>
            </div>
          </div>
        )}
      </div>

      {/* Airdrop Card */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">{t('sdkDemo.getDevnetSolTitle')}</h3>

        {!connected ? (
          <p className="text-p01-text-dim text-center py-4">{t('sdkDemo.connectWalletFirst')}</p>
        ) : (
          <div className="space-y-4">
            <p className="text-p01-text-muted text-sm">
              {t('sdkDemo.devnetFaucetDesc')}
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
                  {t('sdkDemo.requestingAirdrop')}
                </>
              ) : (
                <>
                  <RefreshCw size={18} />
                  {t('sdkDemo.requestAirdrop')}
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

      {/* Real devnet payment via the extension */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">{t('sdkDemo.testSigningTitle')}</h3>

        {!connected ? (
          <p className="text-p01-text-dim text-center py-4">{t('sdkDemo.connectWalletFirst')}</p>
        ) : (
          <div className="space-y-4">
            <p className="text-p01-text-muted text-sm">
              {t('sdkDemo.testSigningDesc')}
            </p>

            <button
              onClick={sendTestPayment}
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
                  {t('sdkDemo.waitingApproval')}
                </>
              ) : (
                <>
                  <FileText size={18} />
                  {t('sdkDemo.signTestMessage')}
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
            {t('sdkDemo.networkLabel')} <span className="text-yellow-500 font-medium">{t('sdkDemo.solanaDevnet')}</span>
          </span>
          <span className="text-p01-text-dim text-sm ml-auto">
            {t('sdkDemo.rpcLabel')}
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
    const res = await fetch(`/api/whitelist?wallet=${walletAddress}`);
    const data = await res.json();
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
  const t = useT();
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
      setHasDevAccess(null); // Loading state
      checkWhitelistAPI(publicKey).then((approved) => {
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
      alert(t('sdkDemo.alertSubmitFailed'));
    } finally {
      setFormLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        icon={RefreshCw}
        title={t('sdkDemo.streamTitle')}
        subtitle={t('sdkDemo.streamDesc')}
        accent="pink"
      />

      {/* Simple Explanation for Beginners */}
      <div className="bg-p01-elevated/50 rounded-2xl p-6 border border-p01-border/50">
        <h3 className="text-lg font-semibold text-white mb-4 font-display flex items-center gap-2">
          <Eye size={18} className="text-p01-cyan" />
          {t('sdkDemo.simpleTermsTitle')}
        </h3>
        <div className="space-y-4 text-p01-text-muted">
          <p>
            <span className="text-white font-semibold">{t('sdkDemo.simpleTermsIntro')}</span>{t('sdkDemo.simpleTermsIntroSuffix')}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-p01-void/50 border border-p01-border">
              <p className="text-p01-pink font-semibold mb-2">&#x274C; {t('sdkDemo.traditionalSubs')}</p>
              <ul className="text-sm space-y-1">
                <li>&#x2022; {t('sdkDemo.tradSub1')}</li>
                <li>&#x2022; {t('sdkDemo.tradSub2')}</li>
                <li>&#x2022; {t('sdkDemo.tradSub3')}</li>
              </ul>
            </div>
            <div className="p-4 bg-p01-void/50 border border-p01-cyan/30">
              <p className="text-p01-cyan font-semibold mb-2">&#x2705; {t('sdkDemo.withProtocol01')}</p>
              <ul className="text-sm space-y-1">
                <li>&#x2022; {t('sdkDemo.p01Sub1')}</li>
                <li>&#x2022; {t('sdkDemo.p01Sub2')}</li>
                <li>&#x2022; {t('sdkDemo.p01Sub3')}</li>
              </ul>
            </div>
          </div>
          <p className="text-sm text-p01-text-dim">
            <span className="text-p01-cyan">{t('sdkDemo.simpleTermsSummaryPrefix')}</span>{t('sdkDemo.simpleTermsSummary')}
          </p>
        </div>
      </div>

      {/* Key Features */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { icon: Link2, title: t('sdkDemo.feat100Serverless'), desc: t('sdkDemo.featNoApi'), color: "cyan" },
          { icon: FileCode, title: t('sdkDemo.featSmartContract'), desc: t('sdkDemo.featOnChainVerif'), color: "cyan" },
          { icon: Ticket, title: t('sdkDemo.featWhitelist'), desc: t('sdkDemo.featVerifiedDevs'), color: "pink" },
          { icon: Lock, title: t('sdkDemo.featClosedCircuit'), desc: t('sdkDemo.featP01Required'), color: "pink" },
          { icon: ShieldCheck, title: t('sdkDemo.featImmutablePricing'), desc: t('sdkDemo.featPricesLocked'), color: "cyan" },
          { icon: Hand, title: t('sdkDemo.featCancelAnytime'), desc: t('sdkDemo.featUserControls'), color: "cyan" },
        ].map((feature) => {
          const IconComponent = feature.icon;
          const colorClass = feature.color === "cyan" ? "text-p01-cyan" : "text-p01-pink";
          const bgClass = feature.color === "cyan" ? "bg-p01-cyan/10 border-p01-cyan/30" : "bg-p01-pink/10 border-p01-pink/30";
          return (
            <div key={feature.title} className="bg-p01-surface rounded-xl p-4 border border-p01-border group hover:border-p01-cyan/50 transition-all">
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
            <h3 className="text-lg font-semibold text-p01-cyan mb-2 font-display">{t('sdkDemo.customerProtectionTitle')}</h3>
            <p className="text-p01-text-muted text-sm mb-2">
              <span className="text-white font-semibold">{t('sdkDemo.customerProtectionIntro')}</span>{t('sdkDemo.customerProtectionDesc1')}<span className="text-p01-cyan font-semibold">{t('sdkDemo.customerProtectionLocked')}</span>{t('sdkDemo.customerProtectionDesc1Suffix')}
            </p>
            <p className="text-p01-text-muted text-sm mb-4">
              {t('sdkDemo.customerProtectionDesc2')}<span className="text-p01-pink font-semibold">{t('sdkDemo.customerProtectionCannotTouch')}</span>{t('sdkDemo.customerProtectionDesc2Suffix')}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="bg-p01-void/50 p-3 border border-p01-cyan/20">
                <div className="flex items-center gap-2 mb-1">
                  <Check size={14} className="text-p01-cyan" />
                  <p className="text-p01-cyan text-xs font-mono">{t('sdkDemo.youCan')}</p>
                </div>
                <p className="text-p01-text-muted text-sm">{t('sdkDemo.youCanDesc')}</p>
              </div>
              <div className="bg-p01-void/50 p-3 border border-p01-cyan/20">
                <div className="flex items-center gap-2 mb-1">
                  <Check size={14} className="text-p01-cyan" />
                  <p className="text-p01-cyan text-xs font-mono">{t('sdkDemo.devCan')}</p>
                </div>
                <p className="text-p01-text-muted text-sm">{t('sdkDemo.devCanDesc')}</p>
              </div>
              <div className="bg-p01-void/50 p-3 border border-p01-pink/30">
                <div className="flex items-center gap-2 mb-1">
                  <X size={14} className="text-p01-pink" />
                  <p className="text-p01-pink text-xs font-mono">{t('sdkDemo.impossible')}</p>
                </div>
                <p className="text-p01-text-muted text-sm">{t('sdkDemo.impossibleDesc')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Developer Access Card */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4 font-display">{t('sdkDemo.devAccessTitle')}</h3>
        <p className="text-p01-text-muted text-sm mb-4">
          {t('sdkDemo.devAccessDesc')}
        </p>

        {!walletAvailable ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 bg-p01-surface border border-p01-border mx-auto mb-4 flex items-center justify-center">
              <Zap size={28} className="text-p01-text-dim" />
            </div>
            <p className="text-p01-text-muted mb-4">{t('sdkDemo.installWalletToCheck')}</p>
          </div>
        ) : !connected ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 bg-p01-cyan/10 border border-p01-cyan/30 mx-auto mb-4 flex items-center justify-center">
              <Wallet size={28} className="text-p01-cyan" />
            </div>
            <p className="text-p01-text-muted mb-4">{t('sdkDemo.connectToVerify')}</p>
            <P01WalletButton variant="primary" size="lg" />
          </div>
        ) : hasDevAccess === null ? (
          <div className="flex items-center justify-center py-6 gap-3">
            <LoadingSpinner color={THEME.primaryColor} />
            <span className="text-p01-text-muted">{t('sdkDemo.checkingWhitelist')}</span>
          </div>
        ) : hasDevAccess ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-p01-cyan/10 border border-p01-cyan/30">
              <div className="w-12 h-12 bg-p01-cyan/20 border border-p01-cyan/40 flex items-center justify-center">
                <Ticket size={24} className="text-p01-cyan" />
              </div>
              <div className="flex-1">
                <p className="text-p01-cyan font-semibold font-display">{t('sdkDemo.devAccessVerified')}</p>
                <p className="text-p01-text-dim text-sm font-mono">{t('sdkDemo.devAccessFullAccess')}</p>
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
                <p className="text-p01-pink font-semibold font-display">{t('sdkDemo.accessNotGranted')}</p>
                <p className="text-p01-text-dim text-sm font-mono">{t('sdkDemo.walletNotWhitelisted')}</p>
              </div>
            </div>
            {formSubmitted ? (
              <div className="p-4 bg-p01-cyan/10 border border-p01-cyan/30">
                <div className="flex items-center gap-2 mb-2">
                  <Check size={16} className="text-p01-cyan" />
                  <span className="text-p01-cyan font-semibold">{t('sdkDemo.requestSubmitted')}</span>
                </div>
                <p className="text-p01-text-muted text-sm">
                  {t('sdkDemo.requestReviewMsg')}
                  {' '}<a href="https://discord.gg/EfqnVmb2dV" target="_blank" rel="noopener noreferrer" className="text-p01-cyan hover:underline">{t('sdkDemo.fasterResponse')}</a>
                </p>
              </div>
            ) : showRequestForm ? (
              <form onSubmit={handleSubmitRequest} className="space-y-4">
                <div>
                  <label className="block text-p01-text-muted text-sm mb-1">{t('sdkDemo.formEmail')}</label>
                  <input
                    type="email"
                    required
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder={t('sdkDemo.formEmailPlaceholder')}
                    className="w-full px-4 py-2 bg-p01-void border border-p01-border text-white placeholder-p01-text-dim focus:border-p01-cyan focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-p01-text-muted text-sm mb-1">{t('sdkDemo.formProjectName')}</label>
                  <input
                    type="text"
                    required
                    value={formData.projectName}
                    onChange={(e) => setFormData({ ...formData, projectName: e.target.value })}
                    placeholder={t('sdkDemo.formProjectPlaceholder')}
                    className="w-full px-4 py-2 bg-p01-void border border-p01-border text-white placeholder-p01-text-dim focus:border-p01-cyan focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-p01-text-muted text-sm mb-1">{t('sdkDemo.formWebsite')}</label>
                  <input
                    type="url"
                    value={formData.website}
                    onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                    placeholder={t('sdkDemo.formWebsitePlaceholder')}
                    className="w-full px-4 py-2 bg-p01-void border border-p01-border text-white placeholder-p01-text-dim focus:border-p01-cyan focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-p01-text-muted text-sm mb-1">{t('sdkDemo.formProjectDesc')}</label>
                  <textarea
                    value={formData.projectDescription}
                    onChange={(e) => setFormData({ ...formData, projectDescription: e.target.value })}
                    placeholder={t('sdkDemo.formDescPlaceholder')}
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
                    {t('sdkDemo.cancelBtn')}
                  </button>
                  <button
                    type="submit"
                    disabled={formLoading}
                    className="flex-1 py-2 bg-p01-cyan text-p01-void font-semibold hover:bg-p01-cyan/90 transition-colors disabled:opacity-50"
                  >
                    {formLoading ? t('sdkDemo.submitting') : t('sdkDemo.submitRequest')}
                  </button>
                </div>
                <p className="text-p01-text-dim text-xs text-center">
                  {t('sdkDemo.formPrivacyNote')}
                </p>
              </form>
            ) : (
              <button
                onClick={() => setShowRequestForm(true)}
                className="w-full py-3 bg-p01-pink text-white font-semibold hover:bg-p01-pink/90 transition-colors font-display uppercase tracking-wider text-sm"
              >
                {t('sdkDemo.requestDevAccess')}
              </button>
            )}
            <p className="text-p01-text-dim text-xs text-center mt-3">
              {t('sdkDemo.walletLabel')} <span className="font-mono text-p01-text-muted">{publicKey}</span>
            </p>
          </div>
        )}
      </div>

      {/* SDK Integration */}
      <div className="bg-p01-surface rounded-2xl p-6 border border-p01-border">
        <h3 className="text-lg font-semibold text-white mb-4">{t('sdkDemo.sdkIntegrationTitle')}</h3>
        <p className="text-p01-text-muted text-sm mb-6">
          {t('sdkDemo.sdkIntegrationDesc')}
        </p>

        <CodeBlock
          title={t('sdkDemo.sdkIntegrationCodeTitle')}
          code={`import { P01SDK, STREAM_PROGRAM_ID } from '@protocol-01/p01-js';

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
        <h3 className="text-lg font-semibold text-white mb-4">{t('sdkDemo.createStreamTitle')}</h3>
        <p className="text-p01-text-muted text-sm mb-2">
          {t('sdkDemo.createStreamDesc')}<span className="text-p01-pink font-semibold">{t('sdkDemo.createStreamWarning')}</span>{t('sdkDemo.createStreamWarningSuffix')}
        </p>
        <div className="flex items-center gap-3 p-3 bg-p01-pink/10 border border-p01-pink/30 mb-6">
          <AlertTriangle size={18} className="text-p01-pink flex-shrink-0" />
          <span className="text-p01-pink text-sm font-mono">{t('sdkDemo.closedCircuitWarning')}</span>
        </div>

        <CodeBlock
          title={t('sdkDemo.createStreamCodeTitle')}
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
        <h3 className="text-lg font-semibold text-white mb-4">{t('sdkDemo.onChainVerifTitle')}</h3>
        <p className="text-p01-text-muted text-sm mb-6">
          {t('sdkDemo.onChainVerifDesc')}
        </p>

        <CodeBlock
          title={t('sdkDemo.onChainVerifCodeTitle')}
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

// ✅ ONLY subscriber can cancel (from their wallet)
// Developer CANNOT cancel or modify!
await p01.streams.cancel({
  streamId: "stream_abc123",
  // Requires subscriber's wallet signature
});`}
        />
      </div>

      {/* Architecture Diagram */}
      <div className="bg-p01-elevated/50 rounded-2xl p-6 border border-p01-border/50">
        <h4 className="text-white font-semibold mb-6 font-display text-center">{t('sdkDemo.archNoServerTitle')}</h4>
        <div className="flex items-center justify-center gap-6 text-center py-4">
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center relative">
              <Wallet size={28} className="text-p01-cyan" />
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-p01-cyan animate-pulse" />
            </div>
            <span className="text-p01-text-muted text-xs font-mono uppercase tracking-wider">{t('sdkDemo.archYourDapp')}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-[2px] bg-gradient-to-r from-p01-cyan to-p01-cyan/50" />
            <div className="w-2 h-2 bg-p01-cyan rotate-45" />
          </div>
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 bg-p01-pink/10 border border-p01-pink/30 flex items-center justify-center">
              <FileCode size={28} className="text-p01-pink" />
            </div>
            <span className="text-p01-text-muted text-xs font-mono uppercase tracking-wider">{t('sdkDemo.archSmartContract')}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-[2px] bg-gradient-to-r from-p01-pink/50 to-p01-cyan" />
            <div className="w-2 h-2 bg-p01-cyan rotate-45" />
          </div>
          <div className="flex flex-col items-center gap-3">
            <div className="w-16 h-16 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
              <Boxes size={28} className="text-p01-cyan" />
            </div>
            <span className="text-p01-text-muted text-xs font-mono uppercase tracking-wider">{t('sdkDemo.archSolana')}</span>
          </div>
        </div>
        <p className="text-p01-text-dim text-xs text-center mt-6 font-mono">
          {t('sdkDemo.archNoServerDesc')}
        </p>
      </div>

      {/* Security Guarantee */}
      <div className="bg-gradient-to-r from-p01-cyan/5 to-p01-pink/5 p-6 border border-p01-border">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-10 h-10 bg-p01-cyan/10 border border-p01-cyan/30 flex items-center justify-center">
            <Lock size={20} className="text-p01-cyan" />
          </div>
          <h4 className="text-white font-semibold font-display">{t('sdkDemo.securityTitle')}</h4>
        </div>
        <p className="text-p01-text-muted text-sm text-center mb-6 max-w-2xl mx-auto">
          {t('sdkDemo.securityDesc')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 bg-p01-cyan/20 border border-p01-cyan/30 flex items-center justify-center">
                <Check size={12} className="text-p01-cyan" />
              </div>
              <h5 className="text-p01-cyan font-semibold text-sm font-display uppercase tracking-wider">{t('sdkDemo.whatYouCanDo')}</h5>
            </div>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-3 text-p01-text-muted">
                <Check size={14} className="text-p01-cyan flex-shrink-0" />
                <span>{t('sdkDemo.priceSameForever')}</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <Check size={14} className="text-p01-cyan flex-shrink-0" />
                <span>{t('sdkDemo.cancelOneClick')}</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <Check size={14} className="text-p01-cyan flex-shrink-0" />
                <span>{t('sdkDemo.noModifyWithoutPermission')}</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <Check size={14} className="text-p01-cyan flex-shrink-0" />
                <span>{t('sdkDemo.viewPaymentHistory')}</span>
              </li>
            </ul>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 bg-p01-pink/20 border border-p01-pink/30 flex items-center justify-center">
                <X size={12} className="text-p01-pink" />
              </div>
              <h5 className="text-p01-pink font-semibold text-sm font-display uppercase tracking-wider">{t('sdkDemo.whatDevsCannotDo')}</h5>
            </div>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-3 text-p01-text-muted">
                <X size={14} className="text-p01-pink flex-shrink-0" />
                <span>{t('sdkDemo.raisePrice')}</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <X size={14} className="text-p01-pink flex-shrink-0" />
                <span>{t('sdkDemo.cancelWithoutYou')}</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <X size={14} className="text-p01-pink flex-shrink-0" />
                <span>{t('sdkDemo.changeBilling')}</span>
              </li>
              <li className="flex items-center gap-3 text-p01-text-muted">
                <X size={14} className="text-p01-pink flex-shrink-0" />
                <span>{t('sdkDemo.chargeMore')}</span>
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
  const t = useT();
  return (
    <div className="space-y-12">
      <SectionHeader
        icon={CreditCard}
        title={t('sdkDemo.widgetsTitle')}
        subtitle={`${t('sdkDemo.widgetsDesc')}${t('sdkDemo.widgetsDescHighlight')}`}
        accent="cyan"
      />

      {/* Customer Protection Banner */}
      <div className="flex items-center gap-4 p-4 bg-p01-cyan/10 border border-p01-cyan/30">
        <div className="w-10 h-10 bg-p01-cyan/20 border border-p01-cyan/40 flex items-center justify-center flex-shrink-0">
          <ShieldCheck size={20} className="text-p01-cyan" />
        </div>
        <div>
          <p className="text-p01-cyan font-semibold text-sm font-display">{t('sdkDemo.priceLocked')}</p>
          <p className="text-p01-text-dim text-xs font-mono">{t('sdkDemo.priceLockedDesc')}</p>
        </div>
      </div>

      {/* Demo Widget */}
      <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
        <DemoSubscriptionWidget />
      </div>

      {/* Code Example */}
      <CodeBlock
        title={t('sdkDemo.widgetCodeTitle')}
        code={`import { P01Provider, SubscriptionWidget } from '@protocol-01/p01-js/react';

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
  const t = useT();
  return (
    <div className="space-y-12">
      <SectionHeader icon={Zap} title={t('sdkDemo.tabButtons')} accent="cyan" />
      {/* Wallet Button */}
      <div>
        <h2 className="text-2xl font-bold text-white mb-2">{t('sdkDemo.walletButtonTitle')}</h2>
        <p className="text-p01-text-muted mb-6">{t('sdkDemo.walletButtonDesc')}</p>

        <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
          <p className="text-p01-text-dim text-sm mb-4">{t('sdkDemo.clickToConnect')}</p>
          <div className="flex flex-wrap gap-4 items-center mb-8">
            <P01WalletButton variant="primary" size="lg" />
            <P01WalletButton variant="secondary" size="md" />
            <P01WalletButton variant="outline" size="sm" />
          </div>

          {/* Demo Connected State (static preview) */}
          <p className="text-p01-text-dim text-sm mb-4">{t('sdkDemo.connectedPreview')}</p>
          <div className="flex flex-wrap gap-4 items-center">
            <DemoWalletButton connected address="7xK9f...8c2e" isP01Wallet />
            <DemoWalletButton connected address="3mN2p...4f1a" />
          </div>
        </div>

        <CodeBlock
          title={t('sdkDemo.walletButtonCodeTitle')}
          code={`import { WalletButton } from '@protocol-01/p01-js/react';

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
        <h2 className="text-2xl font-bold text-white mb-2">{t('sdkDemo.paymentButtonTitle')}</h2>
        <p className="text-p01-text-muted mb-6">{t('sdkDemo.paymentButtonDesc')}</p>

        <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
          <div className="flex flex-wrap gap-4 items-center">
            <DemoPaymentButton amount={9.99} token="USDC" variant="primary" size="lg" />
            <DemoPaymentButton amount={25} token="SOL" variant="secondary" size="md" />
            <DemoPaymentButton amount={100} token="USDC" variant="outline" size="sm" />
          </div>
        </div>

        <CodeBlock
          title={t('sdkDemo.paymentButtonCodeTitle')}
          code={`import { PaymentButton } from '@protocol-01/p01-js/react';

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
        <h2 className="text-2xl font-bold text-white mb-2">{t('sdkDemo.subscriptionButtonTitle')}</h2>
        <p className="text-p01-text-muted mb-6">{t('sdkDemo.subscriptionButtonDesc')}</p>

        <div className="bg-p01-surface rounded-2xl p-8 border border-p01-border">
          <div className="flex flex-wrap gap-4 items-center">
            <DemoSubscriptionButton amount={15.99} interval="monthly" variant="primary" />
            <DemoSubscriptionButton amount={149.99} interval="yearly" variant="secondary" />
          </div>
        </div>

        <CodeBlock
          title={t('sdkDemo.subscriptionButtonCodeTitle')}
          code={`import { SubscriptionButton, STREAM_PROGRAM_ID } from '@protocol-01/p01-js/react';

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
  const t = useT();
  return (
    <div className="space-y-12">
      <div>
        <div className="mb-6">
          <SectionHeader
            icon={FileText}
            title={t('sdkDemo.subscriptionCardTitle')}
            subtitle={t('sdkDemo.subscriptionCardDesc')}
            accent="cyan"
          />
        </div>

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
          title={t('sdkDemo.subscriptionCardCodeTitle')}
          code={`import { SubscriptionCard, useStreams } from '@protocol-01/p01-js/react';

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
  const t = useT();
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
          {t('sdkDemo.choosePlan')}
        </h2>
        <p style={{ color: THEME.mutedColor, fontSize: "16px", margin: 0 }}>
          {t('sdkDemo.freeTrial')}
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
            {t('sdkDemo.enablePrivacy')}
          </span>
        </button>
      </div>

      {/* Tiers Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
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
                {t('sdkDemo.mostPopular')}
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
                {tier.trialDays} {t('sdkDemo.dayFreeTrial')}
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
            <TierWalletButton popular={tier.popular} tierName={tier.name} price={tier.price} interval={tier.interval} privacyEnabled={enablePrivacy} />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", marginTop: "24px", color: THEME.mutedColor, fontSize: "12px" }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "4px" }}>
          <LockIcon color={THEME.primaryColor} />
          {t('sdkDemo.onChainFooter')}
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
  const t = useT();
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
          {t('sdkDemo.connectWallet')}
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
  const t = useT();
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
      alert(t('sdkDemo.alertWalletNotInstalled'));
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
          {t('sdkDemo.installWallet')}
        </>
      ) : connecting ? (
        <>
          <LoadingSpinner color={variant === "primary" ? THEME.backgroundColor : THEME.primaryColor} />
          {t('sdkDemo.connecting')}
        </>
      ) : connected && publicKey ? (
        <>
          <P01Icon />
          {truncateAddress(publicKey)}
        </>
      ) : (
        <>
          <P01Icon />
          {t('sdkDemo.connectP01')}
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
const P01_TREASURY = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";

// Privacy preset applied when the on-page "Enable Privacy" toggle is on. These
// are the values the wallet's approval popup will display (read-only). Keep in
// sync with the extension's ApproveSubscription defaults.
const PRIVACY_PRESET = { amountNoise: 5, timingNoise: 2, useStealthAddress: true } as const;
const PRIVACY_OFF = { amountNoise: 0, timingNoise: 0, useStealthAddress: false } as const;

// Convert interval string to seconds
function intervalToSeconds(interval: string): number {
  switch (interval) {
    case "daily": return 86400;           // 1 day
    case "weekly": return 604800;         // 7 days
    case "biweekly": return 1209600;      // 14 days
    case "monthly": return 2592000;       // 30 days
    case "quarterly": return 7776000;     // 90 days
    case "yearly": return 31536000;       // 365 days
    default: return 2592000;              // default monthly
  }
}

function TierWalletButton({ popular = false, tierName = "Basic", price = 9.99, interval = "monthly", privacyEnabled = true }: { popular?: boolean; tierName?: string; price?: number; interval?: string; privacyEnabled?: boolean }) {
  const t = useT();
  const { publicKey, connected, connecting, walletAvailable, connect, subscribe, getSubscriptions } = useP01Wallet();
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);

  // Restore the "already subscribed" state on load / reconnect. Subscriptions
  // live in the wallet (chrome.storage), so a page reload loses our local
  // `subscribed` flag — re-derive it from the wallet instead of letting the
  // button reset to green/clickable and allow a duplicate subscription.
  const tierLabel = `Protocol 01 - ${tierName}`;
  useEffect(() => {
    if (!connected || !walletAvailable) {
      setSubscribed(false);
      setSubscriptionId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const subs = await getSubscriptions();
      if (cancelled) return;
      const match = subs.find((s) => {
        const isActive = s.status ? s.status === 'active' : s.isActive !== false;
        const label = s.name || s.merchantName || '';
        return isActive && label === tierLabel && s.recipient === P01_TREASURY;
      });
      if (match) {
        setSubscribed(true);
        setSubscriptionId(match.id);
      }
    })();
    return () => { cancelled = true; };
  }, [connected, walletAvailable, getSubscriptions, tierLabel]);

  const handleClick = async () => {
    if (!walletAvailable) {
      alert(t('sdkDemo.alertWalletNotInstalled'));
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
      alert(t('sdkDemo.alertWalletNotConnected'));
      return;
    }

    // Already connected - create subscription using Stream Secure
    setIsSubscribing(true);
    try {
      // Convert price to lamports (SOL has 9 decimals)
      // For demo, we use 0.01 SOL per period instead of the displayed price
      const amountLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);
      const periodSeconds = intervalToSeconds(interval);

      // Use the wallet's subscribe method - this will:
      // 1. Open the subscription approval popup
      // 2. Store the subscription in the wallet's Stream Secure section
      // 3. Enable automatic recurring payments
      const result = await subscribe({
        recipient: P01_TREASURY,
        merchantName: `Protocol 01 - ${tierName}`,
        amountPerPeriod: amountLamports,
        periodSeconds: periodSeconds,
        maxPeriods: 0, // Unlimited until cancelled
        description: `${tierName} Plan - ${price} SOL/${interval} (Demo: 0.01 SOL)`,
        // Forward the on-page privacy selection so the wallet popup mirrors it.
        ...(privacyEnabled ? PRIVACY_PRESET : PRIVACY_OFF),
      });

      if (result) {
        setSubscriptionId(result.subscriptionId);
        setSubscribed(true);

        // Show success notification
        alert(`✅ Subscription Created!\n\nPlan: ${tierName}\nAmount: 0.01 SOL per ${interval} (Demo)\nSubscription ID: ${result.subscriptionId.slice(0, 8)}...\n\nYour subscription is now active!\nCheck your wallet's Stream Secure section to manage it.`);
      }
    } catch (error) {
      console.error("Subscription failed:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      if (errorMessage.includes("rejected")) {
        // User rejected - no error alert needed
      } else if (errorMessage.includes("permission")) {
        alert(t('sdkDemo.alertMissingPermission'));
      } else if (/refresh this page|was updated|context invalidated/i.test(errorMessage)) {
        // Extension was reloaded; this tab's bridge is stale until a page reload.
        alert(errorMessage);
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
          {t('sdkDemo.installWallet')}
        </>
      ) : connecting ? (
        <>
          <LoadingSpinner color={buttonColor} />
          {t('sdkDemo.connecting')}
        </>
      ) : isSubscribing ? (
        <>
          <LoadingSpinner color={buttonColor} />
          {t('sdkDemo.confirmInWallet')}
        </>
      ) : subscribed ? (
        <>
          <CheckIcon color="#ffffff" />
          {t('sdkDemo.subscribed')} &#x2713;
        </>
      ) : connected && publicKey ? (
        <>
          <CheckIcon color={buttonColor} />
          {t('sdkDemo.subscribeWith')} {truncateAddress(publicKey)}
        </>
      ) : (
        <>
          <P01Icon />
          {t('sdkDemo.connectP01')}
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
  const t = useT();
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
      {t('sdkDemo.payAmount')} {amount} {token}
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
  const t = useT();
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
      {t('sdkDemo.subscribeAmount')} {amount} USDC/{interval}
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
  const t = useT();
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "0 0 4px 0" }}>{t('sdkDemo.amountLabel')}</p>
          <p style={{ color: THEME.textColor, fontSize: "16px", fontWeight: 600, margin: 0 }}>{amount} USDC</p>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "2px 0 0 0" }}>{t('sdkDemo.perInterval')} {interval}</p>
        </div>
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "0 0 4px 0" }}>{t('sdkDemo.nextPaymentLabel')}</p>
          <p style={{ color: THEME.textColor, fontSize: "16px", fontWeight: 600, margin: 0 }}>{nextPayment}</p>
        </div>
        <div>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "0 0 4px 0" }}>{t('sdkDemo.totalPaidLabel')}</p>
          <p style={{ color: THEME.textColor, fontSize: "16px", fontWeight: 600, margin: 0 }}>{totalPaid} USDC</p>
          <p style={{ color: THEME.mutedColor, fontSize: "12px", margin: "2px 0 0 0" }}>{periodsPaid} {t('sdkDemo.paymentsLabel')}</p>
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
          <span style={{ color: THEME.primaryColor, fontSize: "12px", fontWeight: 500 }}>{t('sdkDemo.privacyEnabled')}</span>
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
          {t('sdkDemo.viewDetails')}
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
            {t('sdkDemo.cancelBtn')}
          </button>
        )}
      </div>
    </div>
  );
}

// ============ Code Block Component ============
function CodeBlock({ title, code }: { title: string; code: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-6 rounded-xl overflow-hidden border border-p01-border bg-p01-elevated">
      <div className="flex items-center justify-between px-4 py-2 border-b border-p01-border/60 bg-white/[0.02]">
        <span className="text-p01-text-dim text-xs font-mono tracking-wide">{title}</span>
        <button
          onClick={copyCode}
          className="flex items-center gap-1.5 text-p01-text-dim hover:text-p01-cyan text-xs font-mono transition-colors"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('sdkDemo.copied') : t('sdkDemo.copy')}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto">
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
