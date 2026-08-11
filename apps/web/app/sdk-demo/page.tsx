"use client";

/**
 * /sdk-demo, the developer playground, ported to the Styx design system.
 *
 * WHAT THIS PORT DID AND DID NOT TOUCH
 *
 * Presentation only. Every fetch, every hook, every guard and every frozen
 * literal below is the original code:
 *
 *  - the page-local P01WalletProvider (NOT the global wallet provider) and the
 *    exported useP01Wallet, both consumed by four sections in this file
 *  - the late-injection wallet detection (immediate check + 100/500/1000/2000ms
 *    re-checks + the FROZEN "protocol01#initialized" event)
 *  - the trusted-only eager reconnect, which is what restores the
 *    "already subscribed" button state on reload
 *  - the three direct calls to https://api.devnet.solana.com (balance poll every
 *    10s, requestAirdrop, the uncancelled post-airdrop refresh) and the real
 *    0.001 SOL devnet self-transfer signed through window.protocol01
 *  - GET /api/whitelist?wallet=… , POST /api/whitelist (three fields only:
 *    wallet, email, projectName. Website and description are deliberately NOT
 *    posted to the API) and the NEXT_PUBLIC_DISCORD_WEBHOOK mirror
 *  - the 'SUCCESS: ' / 'ERROR: ' prefixes on airdropStatus and paymentStatus:
 *    those strings are control flow, not copy. Rename one and every success
 *    renders as an error.
 *  - P01_TREASURY, `Protocol 01 - <tier>` (the subscribe payload merchantName
 *    AND the already-subscribed matcher read the same literal, so it stays
 *    Protocol 01), intervalToSeconds, PRIVACY_PRESET / PRIVACY_OFF, and the
 *    0.01 SOL demo amount
 *
 * Gone: the THEME object, every p01-* Tailwind class, framer-motion, the
 * rounded pills, the pink, the icon-in-a-rounded-box section headers and the
 * gradient arrows. Colour, type and spacing now come from app/_styx/styx.css.
 *
 * COPY FIXED HERE (the hardcoded strings this file owns):
 *  - the stealth sample no longer claims unlinkability, and names the sanctioned
 *    hybrid X25519 + ML-KEM-768 (FIPS 203)
 *  - the zkSPL sample says out loud that the withdrawal republishes the deposit
 *    commitment, so deposit and withdrawal are still pairable today
 *  - the WOTS+ comment no longer says "quantum-resistant" without qualification:
 *    transaction signatures stay Ed25519 and classical
 *  - network: "mainnet" flipped to "devnet" in both samples. There is no mainnet
 *    deployment.
 *  - "14 Anchor Programs" dropped (unverifiable count)
 *  - the demo subscription cards no longer wear Netflix / Spotify / ChatGPT /
 *    Adobe names with invented totals, and no longer offer a Cancel action the
 *    protocol cannot honour
 *  - the success alert no longer promises an activation this page has not
 *    verified on chain
 *
 * OVERSTATING i18n KEYS, SECOND PASS (2026-08-11)
 *
 * i18n/ is off limits, so an overstating key cannot be edited. It can be left
 * uncalled. Every key below is now uncalled by this page, each replaced by a
 * DIFFERENT existing key that says something checkable, so both locales still
 * render every slot:
 *
 *   serverless          -> beta                (this file POSTs to two endpoints)
 *   featNoApi + feat100Serverless -> roadmap.devnetOnly + rpcLabel
 *   privacySdksDesc     -> docs.heroSubtitle   ("17 packages" over a grid of 7)
 *   stealthDesc         -> sdkSpecterDesc + docs stealth detail4 (no unlinkability)
 *   zkProofsDesc        -> sdkZkDesc + docs zkProofs detail7 (no proof size)
 *   archFooter          -> explorer.circuits.subtitle (no blanket quantum claim)
 *   securityDesc        -> roadmap.disclaimer  (nothing here is guaranteed)
 *   priceSameForever    -> dropped, no substitute (see the security panel)
 *   formPrivacyNote     -> requestReviewMsg    (the POST is plaintext)
 *   simpleTermsSummary  -> priceLockedDesc     (no Netflix, no "never")
 *   onChainFooter       -> solanaDevnet + featP01Required (no "Verified")
 *
 * Still overstating and still called, because the sentence around them is a
 * comparison to ordinary subscriptions rather than a claim about this protocol:
 * simpleTermsIntro and tradSub1 both name Netflix. sdkDemo.copyright is not
 * called by this page at all; it still reads "PROTOCOL 01" in the dictionary.
 *
 * THE SERVERLESS CLAIM, THIRD PASS (2026-08-11)
 *
 * Swapping a key out of a slot works for a chip or a caption. It does not work
 * for a hero lede or a section title, where the substitute would have to be
 * copy about something else. The claim "no servers, no centralized API" is
 * false on this route in particular, because this component POSTs to
 * /api/whitelist, mirrors the same request to a Discord webhook, and gates the
 * whole Stream SDK section on a human approving that row. So eight keys are
 * queued as dictionary edits rather than as swaps, and they are still called
 * here until the edits land:
 *
 *   heroSubtitle, streamDesc, sdkIntegrationDesc, sdkIntegrationCodeTitle,
 *   onChainVerifDesc, archNoServerTitle, archNoServerDesc, widgetCodeTitle
 *
 * The hardcoded halves of the same claim are already gone from this file: the
 * SDK sample no longer says "no API keys" and "no server request" over a page
 * whose own gate is a server request, and the payment button sample no longer
 * says "no server".
 */

import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
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
  Check,
  X,
  AlertTriangle,
  Ban,
  CreditCard,
  RefreshCw,
  FileText,
  Shield,
  Copy
} from "lucide-react";
import StyxShell from "../_styx/StyxShell";
import Reveal from "../_styx/Reveal";

// Icon tints. Monochrome by default; the cyan seal is reserved for a check mark
// or a status dot, exactly as in styx.css.
const ICON_FAINT: React.CSSProperties = { color: "var(--styx-faint)", flex: "none" };
const ICON_ACCENT: React.CSSProperties = { color: "var(--styx-accent)", flex: "none" };

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
  // approval popup mirrors them (it shows them read-only, see ApproveSubscription).
  amountNoise?: number;        // +/-% variance on each charge
  timingNoise?: number;        // +/-hours jitter on payment time
  useStealthAddress?: boolean; // unique receiving address per payment
}

// Tolerant shape. The wallet returns its raw stored subscriptions, whose field
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
  // connection without a manual click, and with it, the "already subscribed"
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
        // Not previously approved, stay disconnected; user can click Connect.
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
    { id: "devnet" as const, label: t('sdkDemo.tabDevnet') },
    { id: "privacy" as const, label: t('sdkDemo.tabPrivacy') },
    { id: "streams" as const, label: t('sdkDemo.tabStreams') },
    { id: "widgets" as const, label: t('sdkDemo.tabWidgets') },
    { id: "buttons" as const, label: t('sdkDemo.tabButtons') },
    { id: "cards" as const, label: t('sdkDemo.tabCards') },
  ];

  return (
    <StyxShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="styx-container styx-hero">
        {/* The page's one gleam. On the kicker, never on the h1: the test pins
            the h1 accessible name to exactly "SDK Demo", and a gradient-clipped
            headline reads louder than this design allows. */}
        <p className="styx-overline styx-gleam">{t('sdkDemo.heroKicker')}</p>
        <h1 className="styx-h1">{t('sdkDemo.headerTitle')}</h1>

        <div className="styx-hero-rule" aria-hidden="true" />

        <div className="styx-hero-body">
          <div className="styx-stack">
            <p className="styx-lede">{t('sdkDemo.heroSubtitle')}</p>
            {/* The one amber element on the page. Nothing else here earns it. */}
            <div className="styx-admission">
              <p className="styx-admission-title">{t('footer.copyright')}</p>
              <p className="styx-admission-body">
                {t('sdkDemo.noRefundTitle')} &middot; {t('sdkDemo.noRefundDesc')}
              </p>
            </div>
          </div>

          <div className="styx-stack">
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
              <span className="styx-chip">
                <span className="styx-dot" aria-hidden="true" />
                {t('sdkDemo.tabDevnet')}
              </span>
              {/* Was sdkDemo.serverless, "100% Serverless". False where it
                  stood: the developer access form in this very file POSTs to
                  /api/whitelist and mirrors the request to a Discord webhook.
                  sdkDemo.beta is an existing key, so both locales still work. */}
              <span className="styx-chip">{t('sdkDemo.beta')}</span>
              <span className="styx-chip">{t('sdkDemo.onChainVerification')}</span>
            </div>
            <CodeBlock title={t('sdkDemo.installCodeTitle')} code="pnpm add @protocol-01/privacy-sdk" />
          </div>
        </div>
      </section>

      {/* ── Section switch ─────────────────────────────────────────────────
          Plain buttons, not an ARIA tablist: the suite queries them with
          getByRole('button', { name: 'Devnet' }), and the label must remain the
          button's only accessible text.

          Not sticky, deliberately. The root layout wraps every page in
          `overflow-hidden`, which makes that div the scroll container, so a
          sticky child sticks to a box that never scrolls (the same measurement
          that forced .styx-header to be `fixed`). The old `sticky top-16` bar
          never actually stuck; this reads as a static band instead of
          pretending. */}
      <div style={{ borderTop: "1px solid var(--styx-rule)" }}>
        <div className="styx-container">
          <div
            style={{
              display: "flex",
              gap: "1.75rem",
              overflowX: "auto",
              padding: "0.9rem 0",
            }}
          >
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className="styx-nav-link"
                  data-active={isActive ? "true" : undefined}
                  aria-pressed={isActive}
                  style={{
                    appearance: "none",
                    background: "transparent",
                    borderWidth: "0 0 1px",
                    borderStyle: "solid",
                    padding: "0.4rem 0",
                    cursor: "pointer",
                    flex: "none",
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Only the active section mounts, so switching tabs resets that
          section's local state. That is the existing behaviour and the tests
          depend on the text of the other five sections being absent. */}
      {activeTab === "devnet" && <DevnetSection />}
      {activeTab === "privacy" && <PrivacySDKSection />}
      {activeTab === "streams" && <StreamSDKSection />}
      {activeTab === "widgets" && <WidgetsSection />}
      {activeTab === "buttons" && <ButtonsSection />}
      {activeTab === "cards" && <CardsSection />}
    </StyxShell>
  );
}

// ============ Shared section shell ============
// Replaces the old SectionHeader: an oversized marginal numeral, the mono index
// with its cyan tick, the serif title and the lede, in a sticky left column.
function SectionShell({
  numeral,
  index,
  title,
  lede,
  children,
}: {
  numeral: string;
  index?: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="styx-section">
      <div className="styx-container styx-section-grid">
        <div className="styx-section-label">
          <span className="styx-numeral" aria-hidden="true">
            {numeral}
          </span>
          {index ? <p className="styx-index">{index}</p> : null}
          <h2 className="styx-h2">{title}</h2>
          {lede ? (
            <p className="styx-lede" style={{ marginTop: "1.25rem" }}>
              {lede}
            </p>
          ) : null}
        </div>
        <div className="styx-stack-lg">{children}</div>
      </div>
    </section>
  );
}

// A titled block: serif heading, one note line, then whatever evidence follows.
function Block({
  title,
  note,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="styx-h3">{title}</h3>
      {note ? (
        <p className="styx-card-note" style={{ maxWidth: "62ch", margin: "0 0 1.25rem" }}>
          {note}
        </p>
      ) : null}
      {children}
    </div>
  );
}

// ============ Privacy SDKs Section ============
function PrivacySDKSection() {
  const t = useT();

  const packages = [
    { name: "@protocol-01/specter-sdk", desc: t('sdkDemo.sdkSpecterDesc') },
    { name: "@protocol-01/zk-sdk", desc: t('sdkDemo.sdkZkDesc') },
    { name: "@protocol-01/zkspl-sdk", desc: t('sdkDemo.sdkZksplDesc') },
    { name: "@protocol-01/privacy-toolkit", desc: t('sdkDemo.sdkPrivacyToolkitDesc') },
    { name: "@protocol-01/auth-sdk", desc: t('sdkDemo.sdkAuthDesc') },
    { name: "@protocol-01/p01-js", desc: t('sdkDemo.sdkP01JsDesc') },
    { name: "@protocol-01/rpc-config", desc: t('sdkDemo.sdkRpcConfigDesc') },
  ];

  // Sub-labels are the checkable kind. The old "14 Anchor Programs" was a count
  // no reader could verify, so it is gone.
  const stack = [
    { label: t('sdkDemo.archClientSdks'), sub: "specter · zk · zkspl" },
    { label: t('sdkDemo.archProofLayer'), sub: "STARK · Poseidon · Merkle" },
    { label: t('sdkDemo.archOnChain'), sub: "Solana devnet" },
  ];

  return (
    <SectionShell
      numeral="02"
      index={t('sdkDemo.tabPrivacy')}
      title={t('sdkDemo.privacySdksTitle')}
      /* Was sdkDemo.privacySdksDesc, "17 TypeScript packages ...", printed
         directly above a grid of seven. docs.heroSubtitle is an existing key
         that says what the stack is without counting anything. */
      lede={t('docs.heroSubtitle')}
    >
      <div className="styx-grid styx-grid-4">
        {packages.map((sdk, i) => (
          <Reveal className="styx-card styx-reveal" delay={i * 60} key={sdk.name}>
            <p
              className="styx-card-value"
              style={{
                fontFamily: "var(--styx-mono)",
                fontSize: "0.8125rem",
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              {sdk.name}
            </p>
            <p className="styx-card-note">{sdk.desc}</p>
          </Reveal>
        ))}
      </div>

      {/* The note was sdkDemo.stealthDesc: "Generate unlinkable one-time
          addresses ... Receive funds without revealing your identity". The
          repo's own measurements contradict both halves, so the two existing
          keys below carry the mechanism instead: the hybrid key exchange and
          who can detect a payment. */}
      <Block
        title={t('sdkDemo.stealthTitle')}
        note={`${t('sdkDemo.sdkSpecterDesc')} · ${t('docs.sections.stealthAddresses.detail4')}`}
      >
        <CodeBlock
          title={t('sdkDemo.stealthCodeTitle')}
          code={`import { generateStealthAddress, scanForPayments } from '@protocol-01/specter-sdk';

// Sender generates a one-time stealth address for the recipient
const { stealthAddress, ephemeralPubKey } = generateStealthAddress({
  spendingPubKey: recipientMeta.spendingPubKey,
  viewingPubKey: recipientMeta.viewingPubKey,
  useQuantumSafe: true,  // hybrid X25519 + ML-KEM-768, FIPS 203
});

// Pay the one-time address. The transfer itself is an ordinary Solana
// transaction, signed with Ed25519.
await transfer(connection, payer, stealthAddress, amount);

// Recipient scans chain for payments addressed to them
const payments = await scanForPayments({
  viewingKey: myViewingKey,
  fromSlot: lastScannedSlot,
});`}
        />
      </Block>

      {/* The note was sdkDemo.zkProofsDesc, which quoted "~9-15KB per proof".
          No benchmark on this page backs a size, so it is gone; these two
          existing keys state what the proof system is instead. */}
      <Block
        title={t('sdkDemo.zkProofsTitle')}
        note={`${t('sdkDemo.sdkZkDesc')} · ${t('docs.sections.zkProofs.detail7')}`}
      >
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
      </Block>

      <Block title={t('sdkDemo.confSplTitle')} note={t('sdkDemo.confSplDesc')}>
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

// Later: unshield behind a STARK proof.
// Measured, and true today: the withdrawal republishes the deposit
// commitment, so a reader can still pair a deposit with its withdrawal.
// Do not read this as unlinkable.
const unshieldResult = await unshieldTokens({
  connection, wallet,
  note: shieldResult.note,
  recipient: myStealthAddress,
  proof: await generateUnshieldProof(shieldResult.note),
});`}
        />
      </Block>

      <Block title={t('sdkDemo.privacyToolkitTitle')} note={t('sdkDemo.privacyToolkitDesc')}>
        <CodeBlock
          title={t('sdkDemo.privacyToolkitCodeTitle')}
          code={`import { poseidonHash, MerkleTree, WOTSKeypair } from '@protocol-01/privacy-toolkit';

// Poseidon hash for ZK-friendly commitments
const commitment = poseidonHash([amount, owner, randomness, tokenId]);

// Build Merkle tree of note commitments
const tree = new MerkleTree(20); // depth 20
tree.insert(commitment);
const proof = tree.getProof(0); // path for leaf 0

// WOTS+ one-time signature, hash-based.
// Transaction signatures on Solana stay Ed25519, and stay classical.
const wots = WOTSKeypair.generate(secret, chainIndex);
const signature = wots.sign(messageHash);
const valid = WOTSKeypair.verify(wots.publicKey, messageHash, signature);`}
        />
      </Block>

      <div>
        <p className="styx-card-label">{t('sdkDemo.archTitle')}</p>
        <div className="styx-grid styx-grid-3">
          {stack.map((item, i) => (
            <div className="styx-card" key={item.label}>
              <p className="styx-card-label">0{i + 1}</p>
              <p className="styx-card-value">{item.label}</p>
              <p className="styx-card-note" style={{ fontFamily: "var(--styx-mono)", fontSize: "0.75rem" }}>
                {item.sub}
              </p>
            </div>
          ))}
        </div>
        {/* Was sdkDemo.archFooter, which ended on "Quantum-resistant by
            default". Transaction signatures are Ed25519 and stay classical, so
            that sentence covered ground the protocol does not hold.
            explorer.circuits.subtitle is the measured description of the same
            proof layer. */}
        <p className="styx-note" style={{ marginTop: "1rem", fontFamily: "var(--styx-mono)" }}>
          {t('explorer.circuits.subtitle')}
        </p>
      </div>

      <Block title={t('sdkDemo.installTitle')}>
        <CodeBlock
          title={t('sdkDemo.installCodeTitle')}
          code={`# Core SDK
pnpm add @protocol-01/p01-js @protocol-01/rpc-config

# Privacy layer
pnpm add @protocol-01/specter-sdk @protocol-01/zk-sdk @protocol-01/zkspl-sdk @protocol-01/privacy-toolkit

# Optional: Auth
pnpm add @protocol-01/auth-sdk`}
        />
      </Block>
    </SectionShell>
  );
}

// ============ Devnet Section ============
function DevnetSection() {
  const t = useT();
  const { publicKey, connected, walletAvailable } = useP01Wallet();
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
      // .signAndSendTransaction), a genuine on-chain interaction, not a mock.
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
    <SectionShell
      numeral="01"
      index={t('sdkDemo.tabDevnet')}
      title={t('sdkDemo.devnetTitle')}
      lede={t('sdkDemo.devnetDesc')}
    >
      {/* 1. Connect wallet. The three step titles carry their own numbers in
          the dictionary, so no numeral is repeated beside them. */}
      <div className="styx-panel">
        <div className="styx-panel-head">
          <h3 className="styx-h3" style={{ margin: 0 }}>{t('sdkDemo.connectWalletTitle')}</h3>
        </div>
        <div className="styx-panel-body">
          {!walletAvailable ? (
            <>
              <p className="styx-card-note">{t('sdkDemo.walletNotDetected')}</p>
              <p className="styx-note" style={{ marginTop: "0.4rem" }}>
                {t('sdkDemo.walletNotDetectedHint')}
              </p>
            </>
          ) : !connected ? (
            <>
              <p className="styx-card-note" style={{ marginBottom: "1.25rem" }}>
                {t('sdkDemo.connectToStart')}
              </p>
              <P01WalletButton variant="primary" size="lg" />
            </>
          ) : (
            <>
              <div className="styx-row">
                <span className="styx-row-key">{t('sdkDemo.connectedAddress')}</span>
                <span className="styx-row-leader" />
                <span className="styx-row-value">{publicKey}</span>
              </div>
              <div className="styx-row">
                <span className="styx-row-key">{t('sdkDemo.devnetBalance')}</span>
                <span className="styx-row-leader" />
                <span className="styx-row-value">
                  {balance !== null ? `${balance.toFixed(4)} SOL` : '...'}
                </span>
              </div>
              <p
                className="styx-form-ok"
                style={{ marginTop: "1rem", display: "flex", alignItems: "center", gap: "0.45rem" }}
              >
                <Check size={13} style={ICON_ACCENT} aria-hidden />
                {t('sdkDemo.walletConnectedDevnet')}
              </p>
            </>
          )}
        </div>
      </div>

      {/* 2. Faucet */}
      <div className="styx-panel">
        <div className="styx-panel-head">
          <h3 className="styx-h3" style={{ margin: 0 }}>{t('sdkDemo.getDevnetSolTitle')}</h3>
        </div>
        <div className="styx-panel-body">
          {!connected ? (
            <p className="styx-note">{t('sdkDemo.connectWalletFirst')}</p>
          ) : (
            <div className="styx-stack">
              <p className="styx-card-note">{t('sdkDemo.devnetFaucetDesc')}</p>

              <button
                type="button"
                onClick={requestAirdrop}
                disabled={airdropLoading}
                className="styx-btn"
                style={{ width: "100%" }}
              >
                {airdropLoading ? (
                  <>
                    <LoadingSpinner />
                    {t('sdkDemo.requestingAirdrop')}
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} aria-hidden />
                    {t('sdkDemo.requestAirdrop')}
                  </>
                )}
              </button>

              {airdropStatus && (
                <p
                  className={airdropStatus.startsWith('SUCCESS') ? 'styx-form-ok' : 'styx-form-error'}
                  style={{ display: "flex", alignItems: "flex-start", gap: "0.45rem", wordBreak: "break-word" }}
                >
                  {airdropStatus.startsWith('SUCCESS')
                    ? <Check size={13} style={{ flex: "none", marginTop: "0.2rem" }} aria-hidden />
                    : <X size={13} style={{ flex: "none", marginTop: "0.2rem" }} aria-hidden />}
                  {airdropStatus}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 3. A real devnet transfer through the extension */}
      <div className="styx-panel">
        <div className="styx-panel-head">
          <h3 className="styx-h3" style={{ margin: 0 }}>{t('sdkDemo.testSigningTitle')}</h3>
        </div>
        <div className="styx-panel-body">
          {!connected ? (
            <p className="styx-note">{t('sdkDemo.connectWalletFirst')}</p>
          ) : (
            <div className="styx-stack">
              <p className="styx-card-note">{t('sdkDemo.testSigningDesc')}</p>

              <button
                type="button"
                onClick={sendTestPayment}
                disabled={paymentLoading}
                className="styx-btn"
                style={{ width: "100%" }}
              >
                {paymentLoading ? (
                  <>
                    <LoadingSpinner />
                    {t('sdkDemo.waitingApproval')}
                  </>
                ) : (
                  <>
                    <FileText size={14} aria-hidden />
                    {t('sdkDemo.signTestMessage')}
                  </>
                )}
              </button>

              {paymentStatus && (
                <p
                  className={paymentStatus.startsWith('SUCCESS') ? 'styx-form-ok' : 'styx-form-error'}
                  style={{ display: "flex", alignItems: "flex-start", gap: "0.45rem", wordBreak: "break-word" }}
                >
                  {paymentStatus.startsWith('SUCCESS')
                    ? <Check size={13} style={{ flex: "none", marginTop: "0.2rem" }} aria-hidden />
                    : <X size={13} style={{ flex: "none", marginTop: "0.2rem" }} aria-hidden />}
                  {paymentStatus}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Where this actually runs */}
      <div className="styx-panel">
        <div className="styx-panel-body">
          <div className="styx-row">
            <span className="styx-row-key">{t('sdkDemo.networkLabel')}</span>
            <span className="styx-row-leader" />
            <span className="styx-row-value">
              <span
                className="styx-dot"
                style={{ display: "inline-block", marginRight: "0.5rem" }}
                aria-hidden="true"
              />
              {t('sdkDemo.solanaDevnet')}
            </span>
          </div>
          <p className="styx-note" style={{ fontFamily: "var(--styx-mono)", marginTop: "0.35rem" }}>
            {t('sdkDemo.rpcLabel')}
          </p>
        </div>
      </div>
    </SectionShell>
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

  const features = [
    // The first card used to read "100% Serverless / No centralized API". This
    // component POSTs to /api/whitelist and to a Discord webhook a few lines
    // above, so the card contradicted its own file. It now states where the SDK
    // runs, which is checkable.
    { icon: Link2, title: t('roadmap.devnetOnly'), desc: t('sdkDemo.rpcLabel') },
    { icon: FileCode, title: t('sdkDemo.featSmartContract'), desc: t('sdkDemo.featOnChainVerif') },
    { icon: Ticket, title: t('sdkDemo.featWhitelist'), desc: t('sdkDemo.featVerifiedDevs') },
    { icon: Lock, title: t('sdkDemo.featClosedCircuit'), desc: t('sdkDemo.featP01Required') },
    { icon: ShieldCheck, title: t('sdkDemo.featImmutablePricing'), desc: t('sdkDemo.featPricesLocked') },
    { icon: Hand, title: t('sdkDemo.featCancelAnytime'), desc: t('sdkDemo.featUserControls') },
  ];

  // The three hops a charge takes. Named for the path, not for what is absent
  // from it: this same component also talks to /api/whitelist and to a Discord
  // webhook, so "no server" was never this file's to say.
  const paymentPath = [
    t('sdkDemo.archYourDapp'),
    t('sdkDemo.archSmartContract'),
    t('sdkDemo.archSolana'),
  ];

  return (
    <SectionShell
      numeral="03"
      index={t('sdkDemo.tabStreams')}
      title={t('sdkDemo.streamTitle')}
      lede={t('sdkDemo.streamDesc')}
    >
      {/* In simple terms */}
      <div className="styx-panel">
        <div className="styx-panel-head">
          <h3 className="styx-h3" style={{ margin: 0 }}>{t('sdkDemo.simpleTermsTitle')}</h3>
        </div>
        <div className="styx-panel-body">
          <div className="styx-prose" style={{ marginBottom: "1.5rem" }}>
            <p>
              <strong>{t('sdkDemo.simpleTermsIntro')}</strong>{t('sdkDemo.simpleTermsIntroSuffix')}
            </p>
          </div>
          <div className="styx-grid styx-grid-2">
            <div className="styx-card">
              <p className="styx-card-label">{t('sdkDemo.traditionalSubs')}</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {[t('sdkDemo.tradSub1'), t('sdkDemo.tradSub2'), t('sdkDemo.tradSub3')].map((line) => (
                  <li key={line} className="styx-card-note" style={{ marginBottom: "0.45rem" }}>
                    <X size={12} style={{ ...ICON_FAINT, display: "inline-block", verticalAlign: "-1px", marginRight: "0.5rem" }} aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <div className="styx-card">
              <p className="styx-card-label">{t('sdkDemo.withProtocol01')}</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {[t('sdkDemo.p01Sub1'), t('sdkDemo.p01Sub2'), t('sdkDemo.p01Sub3')].map((line) => (
                  <li key={line} className="styx-card-note" style={{ marginBottom: "0.45rem" }}>
                    <Check size={12} style={{ ...ICON_ACCENT, display: "inline-block", verticalAlign: "-1px", marginRight: "0.5rem" }} aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {/* Was sdkDemo.simpleTermsSummary: "It's like Netflix signing a
              contract with you, they can never change the terms once you've
              agreed." A Netflix name-drop plus an absolute promise. The summary
              is now sdkDemo.priceLockedDesc, which states the locked price and
              says out loud that a subscription cannot be cancelled and the
              protocol cannot refund. */}
          <p className="styx-note" style={{ marginTop: "1.25rem" }}>
            <span style={{ color: "var(--styx-accent)" }}>{t('sdkDemo.simpleTermsSummaryPrefix')}</span>
            {' '}
            {t('sdkDemo.priceLockedDesc')}
          </p>
        </div>
      </div>

      {/* What the SDK is made of */}
      <div className="styx-grid styx-grid-3">
        {features.map((feature, i) => {
          const IconComponent = feature.icon;
          return (
            <Reveal className="styx-card styx-reveal" delay={i * 60} key={feature.title}>
              <IconComponent size={16} style={ICON_FAINT} aria-hidden />
              <p className="styx-card-value" style={{ fontSize: "1.15rem", margin: "0.9rem 0 0.4rem" }}>
                {feature.title}
              </p>
              <p className="styx-card-note" style={{ fontFamily: "var(--styx-mono)", fontSize: "0.75rem" }}>
                {feature.desc}
              </p>
            </Reveal>
          );
        })}
      </div>

      {/* Customer protection. The one-way rule that used to sit here is now the
          amber admission under the hero, where it cannot be scrolled past. */}
      <div className="styx-panel">
        <div className="styx-panel-head">
          <h3 className="styx-h3" style={{ margin: 0 }}>{t('sdkDemo.customerProtectionTitle')}</h3>
        </div>
        <div className="styx-panel-body">
          <div className="styx-prose" style={{ marginBottom: "1.5rem" }}>
            <p>
              <strong>{t('sdkDemo.customerProtectionIntro')}</strong>
              {t('sdkDemo.customerProtectionDesc1')}
              <strong>{t('sdkDemo.customerProtectionLocked')}</strong>
              {t('sdkDemo.customerProtectionDesc1Suffix')}
            </p>
            <p>
              {t('sdkDemo.customerProtectionDesc2')}
              <strong>{t('sdkDemo.customerProtectionCannotTouch')}</strong>
              {t('sdkDemo.customerProtectionDesc2Suffix')}
            </p>
          </div>
          <div className="styx-grid styx-grid-3">
            <div className="styx-card">
              <p className="styx-card-label">
                <Check size={12} style={{ ...ICON_ACCENT, display: "inline-block", verticalAlign: "-1px", marginRight: "0.4rem" }} aria-hidden />
                {t('sdkDemo.youCan')}
              </p>
              <p className="styx-card-note">{t('sdkDemo.youCanDesc')}</p>
            </div>
            <div className="styx-card">
              <p className="styx-card-label">
                <Check size={12} style={{ ...ICON_ACCENT, display: "inline-block", verticalAlign: "-1px", marginRight: "0.4rem" }} aria-hidden />
                {t('sdkDemo.devCan')}
              </p>
              <p className="styx-card-note">{t('sdkDemo.devCanDesc')}</p>
            </div>
            <div className="styx-card">
              <p className="styx-card-label">
                <X size={12} style={{ ...ICON_FAINT, display: "inline-block", verticalAlign: "-1px", marginRight: "0.4rem" }} aria-hidden />
                {t('sdkDemo.impossible')}
              </p>
              <p className="styx-card-note">{t('sdkDemo.impossibleDesc')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Developer access */}
      <div className="styx-panel">
        <div className="styx-panel-head">
          <h3 className="styx-h3" style={{ margin: 0 }}>{t('sdkDemo.devAccessTitle')}</h3>
          <p className="styx-card-note" style={{ marginTop: "0.5rem" }}>{t('sdkDemo.devAccessDesc')}</p>
        </div>
        <div className="styx-panel-body">
          {!walletAvailable ? (
            <p className="styx-note" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Wallet size={14} style={ICON_FAINT} aria-hidden />
              {t('sdkDemo.installWalletToCheck')}
            </p>
          ) : !connected ? (
            <>
              <p className="styx-card-note" style={{ marginBottom: "1.25rem" }}>
                {t('sdkDemo.connectToVerify')}
              </p>
              <P01WalletButton variant="primary" size="lg" />
            </>
          ) : hasDevAccess === null ? (
            <p className="styx-note" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <LoadingSpinner />
              {t('sdkDemo.checkingWhitelist')}
            </p>
          ) : hasDevAccess ? (
            <div className="styx-stack">
              <span className="styx-chip">
                <span className="styx-dot" aria-hidden="true" />
                {t('sdkDemo.devAccessVerified')}
              </span>
              <p className="styx-note" style={{ fontFamily: "var(--styx-mono)" }}>
                {t('sdkDemo.devAccessFullAccess')}
              </p>
            </div>
          ) : (
            <div className="styx-stack">
              <span className="styx-chip">
                <Ban size={11} style={ICON_FAINT} aria-hidden />
                {t('sdkDemo.accessNotGranted')}
              </span>
              <p className="styx-note" style={{ fontFamily: "var(--styx-mono)" }}>
                {t('sdkDemo.walletNotWhitelisted')}
              </p>

              {formSubmitted ? (
                <div>
                  <p className="styx-form-ok" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                    <Check size={13} style={ICON_ACCENT} aria-hidden />
                    {t('sdkDemo.requestSubmitted')}
                  </p>
                  <p className="styx-card-note" style={{ marginTop: "0.5rem" }}>
                    {t('sdkDemo.requestReviewMsg')}
                    {' '}
                    <a
                      className="styx-link"
                      href="https://discord.gg/EfqnVmb2dV"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('sdkDemo.fasterResponse')}
                    </a>
                  </p>
                </div>
              ) : showRequestForm ? (
                <form onSubmit={handleSubmitRequest} className="styx-stack">
                  <div className="styx-field">
                    <label className="styx-label" htmlFor="sdk-access-email">
                      {t('sdkDemo.formEmail')}
                    </label>
                    <input
                      id="sdk-access-email"
                      className="styx-input"
                      type="email"
                      required
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      placeholder={t('sdkDemo.formEmailPlaceholder')}
                    />
                  </div>
                  <div className="styx-field">
                    <label className="styx-label" htmlFor="sdk-access-project">
                      {t('sdkDemo.formProjectName')}
                    </label>
                    <input
                      id="sdk-access-project"
                      className="styx-input"
                      type="text"
                      required
                      value={formData.projectName}
                      onChange={(e) => setFormData({ ...formData, projectName: e.target.value })}
                      placeholder={t('sdkDemo.formProjectPlaceholder')}
                    />
                  </div>
                  <div className="styx-field">
                    <label className="styx-label" htmlFor="sdk-access-website">
                      {t('sdkDemo.formWebsite')}
                    </label>
                    <input
                      id="sdk-access-website"
                      className="styx-input"
                      type="url"
                      value={formData.website}
                      onChange={(e) => setFormData({ ...formData, website: e.target.value })}
                      placeholder={t('sdkDemo.formWebsitePlaceholder')}
                    />
                  </div>
                  <div className="styx-field">
                    <label className="styx-label" htmlFor="sdk-access-desc">
                      {t('sdkDemo.formProjectDesc')}
                    </label>
                    <textarea
                      id="sdk-access-desc"
                      className="styx-textarea"
                      value={formData.projectDescription}
                      onChange={(e) => setFormData({ ...formData, projectDescription: e.target.value })}
                      placeholder={t('sdkDemo.formDescPlaceholder')}
                      rows={3}
                      style={{ resize: "vertical" }}
                    />
                  </div>
                  <div className="styx-btn-row">
                    <button
                      type="button"
                      onClick={() => setShowRequestForm(false)}
                      className="styx-btn-ghost"
                    >
                      {t('sdkDemo.cancelBtn')}
                    </button>
                    <button type="submit" disabled={formLoading} className="styx-btn">
                      {formLoading ? t('sdkDemo.submitting') : t('sdkDemo.submitRequest')}
                    </button>
                  </div>
                  {/* Was sdkDemo.formPrivacyNote, "Your data is encrypted and
                      stored securely". handleSubmitRequest above POSTs the
                      email and project name as plaintext JSON to
                      /api/whitelist, and mirrors website and description to a
                      Discord webhook, so the page cannot say that. This says
                      what actually happens to the request. */}
                  <p className="styx-note">{t('sdkDemo.requestReviewMsg')}</p>
                </form>
              ) : (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowRequestForm(true)}
                    className="styx-btn"
                  >
                    {t('sdkDemo.requestDevAccess')}
                  </button>
                </div>
              )}

              <div className="styx-row">
                <span className="styx-row-key">{t('sdkDemo.walletLabel')}</span>
                <span className="styx-row-leader" />
                <span className="styx-row-value">{publicKey}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. SDK integration */}
      <Block title={t('sdkDemo.sdkIntegrationTitle')} note={t('sdkDemo.sdkIntegrationDesc')}>
        <CodeBlock
          title={t('sdkDemo.sdkIntegrationCodeTitle')}
          code={`import { P01SDK, STREAM_PROGRAM_ID } from '@protocol-01/p01-js';

// Connect with your P01 wallet. The wallet is the identity, so there
// is no API key to provision.
const p01 = new P01SDK({
  wallet: connectedWallet,  // Your Protocol 01 wallet
  network: "devnet"         // devnet is the only deployment there is
});

// This asks the program whether the wallet holds the Developer NFT.
// The access panel above is a DIFFERENT gate: it calls /api/whitelist,
// a server this site runs, and a human approves the request.
const isAuthorized = await p01.verifyDeveloperAccess();

if (!isAuthorized) {
  throw new Error("Developer NFT required");
}`}
        />
      </Block>

      {/* 3. Create stream */}
      <Block
        title={t('sdkDemo.createStreamTitle')}
        note={
          <>
            {t('sdkDemo.createStreamDesc')}
            <strong>{t('sdkDemo.createStreamWarning')}</strong>
            {t('sdkDemo.createStreamWarningSuffix')}
          </>
        }
      >
        <p
          className="styx-note"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.6rem",
            fontFamily: "var(--styx-mono)",
            border: "1px solid var(--styx-rule)",
            padding: "0.75rem 1rem",
            marginBottom: "1.25rem",
          }}
        >
          <AlertTriangle size={14} style={{ ...ICON_FAINT, marginTop: "0.15rem" }} aria-hidden />
          {t('sdkDemo.closedCircuitWarning')}
        </p>

        <CodeBlock
          title={t('sdkDemo.createStreamCodeTitle')}
          code={`// Create a recurring payment stream
// Both parties must have P01 wallet!
const stream = await p01.streams.create({
  recipient: "p01:7xK9f...8c2e", // Must have P01 wallet
  amount: "9.99",                 // immutable once subscribed
  token: "USDC",
  interval: "monthly",
  programId: STREAM_PROGRAM_ID
});

// The smart contract:
// 1. Verifies your Developer NFT
// 2. Verifies recipient has P01 wallet
// 3. LOCKS the price in the subscription record
// 4. Handles automatic payments at LOCKED price

// Impossible for the developer to do:
// stream.updatePrice("19.99") // ERROR: Price is immutable

// Impossible for ANYONE, including the subscriber:
// stream.cancel() // ERROR: there is no cancellation instruction.
// A subscription is a one-way prepaid envelope. The protocol cannot
// return money to the subscriber. A merchant may refund off-band
// from its own wallet, but that is the merchant's own transfer.

// Only the SUBSCRIBER can pause and resume:
// Called from subscriber's wallet only
await p01.streams.pause({ streamId: stream.id });
await p01.streams.resume({ streamId: stream.id });`}
        />
      </Block>

      {/* 4. On-chain verification */}
      <Block title={t('sdkDemo.onChainVerifTitle')} note={t('sdkDemo.onChainVerifDesc')}>
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

// ONLY the subscriber can pause and resume (from their wallet)
// Developer CANNOT pause, resume or modify!
// There is NO cancel: the protocol cannot refund a subscriber.
await p01.streams.pause({
  streamId: "stream_abc123",
  // Requires subscriber's wallet signature
});`}
        />
      </Block>

      {/* The three hops of the payment path. Title and caption are both queued
          as dictionary edits: archNoServerTitle still says "No Server
          Required" and archNoServerDesc still says "no centralized
          infrastructure", and the claim has to leave the title as well as the
          body or the heading keeps what the caption gave up. */}
      <div>
        <p className="styx-card-label">{t('sdkDemo.archNoServerTitle')}</p>
        <div className="styx-grid styx-grid-3">
          {paymentPath.map((label, i) => (
            <div className="styx-card" key={label}>
              <p className="styx-card-label">0{i + 1}</p>
              <p className="styx-card-value">{label}</p>
            </div>
          ))}
        </div>
        <p className="styx-note" style={{ marginTop: "1rem", fontFamily: "var(--styx-mono)" }}>
          {t('sdkDemo.archNoServerDesc')}
        </p>
      </div>

      {/* What the program does and does not let a developer do */}
      <div className="styx-panel">
        <div className="styx-panel-head">
          <h3 className="styx-h3" style={{ margin: 0 }}>{t('sdkDemo.securityTitle')}</h3>
          {/* Was sdkDemo.securityDesc: "Nobody, not us, not the developers, can
              bypass it. Here's what's guaranteed". Nothing here is audited, so
              nothing here is guaranteed. roadmap.disclaimer is the standing
              admission the rest of the site uses. */}
          <p className="styx-card-note" style={{ marginTop: "0.5rem" }}>{t('roadmap.disclaimer')}</p>
        </div>
        <div className="styx-panel-body">
          <div className="styx-grid styx-grid-2">
            <div className="styx-card">
              <p className="styx-card-label">{t('sdkDemo.whatYouCanDo')}</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {[
                  // The price line that used to open this list is gone, twice
                  // over. It was sdkDemo.priceSameForever, "Your price stays
                  // the same, forever", which the program cannot promise past
                  // the end of the subscription. The replacement borrowed for
                  // it, sdkDemo.p01Sub1, is already printed a few hundred
                  // pixels up in the "With Protocol 01" card of this same
                  // section, so keeping it here printed one sentence twice on
                  // one screen. The price lock still has its say opposite,
                  // under "developers CANNOT raise your price".
                  t('sdkDemo.cancelOneClick'),
                  t('sdkDemo.noModifyWithoutPermission'),
                  t('sdkDemo.viewPaymentHistory'),
                ].map((line) => (
                  <li key={line} className="styx-card-note" style={{ marginBottom: "0.5rem" }}>
                    <span className="styx-check" aria-hidden="true">&#10003;</span>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <div className="styx-card">
              <p className="styx-card-label">{t('sdkDemo.whatDevsCannotDo')}</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {[
                  t('sdkDemo.raisePrice'),
                  t('sdkDemo.cancelWithoutYou'),
                  t('sdkDemo.changeBilling'),
                  t('sdkDemo.chargeMore'),
                ].map((line) => (
                  <li key={line} className="styx-card-note" style={{ marginBottom: "0.5rem" }}>
                    <X size={12} style={{ ...ICON_FAINT, display: "inline-block", verticalAlign: "-1px", marginRight: "0.5rem" }} aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}

// ============ Widgets Section ============
function WidgetsSection() {
  const t = useT();
  return (
    <SectionShell
      numeral="04"
      index={t('sdkDemo.tabWidgets')}
      title={t('sdkDemo.widgetsTitle')}
      lede={`${t('sdkDemo.widgetsDesc')}${t('sdkDemo.widgetsDescHighlight')}`}
    >
      <div className="styx-panel">
        <div className="styx-panel-body">
          <p className="styx-card-label" style={{ margin: 0 }}>{t('sdkDemo.priceLocked')}</p>
          <p className="styx-card-note" style={{ marginTop: "0.5rem" }}>{t('sdkDemo.priceLockedDesc')}</p>
        </div>
      </div>

      <div className="styx-panel">
        <div className="styx-panel-body">
          <DemoSubscriptionWidget />
        </div>
      </div>

      <CodeBlock
        title={t('sdkDemo.widgetCodeTitle')}
        code={`import { P01Provider, SubscriptionWidget } from '@protocol-01/p01-js/react';

function PricingPage() {
  return (
    // No merchantId! Wallet connection handles identity
    <P01Provider network="devnet">
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
    </SectionShell>
  );
}

// ============ Buttons Section ============
function ButtonsSection() {
  const t = useT();
  return (
    <SectionShell numeral="05" title={t('sdkDemo.tabButtons')}>
      {/* Wallet button */}
      <Block title={t('sdkDemo.walletButtonTitle')} note={t('sdkDemo.walletButtonDesc')}>
        <div className="styx-stack">
          <div className="styx-panel">
            <div className="styx-panel-body">
              <p className="styx-card-label">{t('sdkDemo.clickToConnect')}</p>
              <div className="styx-btn-row" style={{ alignItems: "center", marginBottom: "2rem" }}>
                <P01WalletButton variant="primary" size="lg" />
                <P01WalletButton variant="secondary" size="md" />
                <P01WalletButton variant="outline" size="sm" />
              </div>

              {/* Static preview of the connected state */}
              <p className="styx-card-label">{t('sdkDemo.connectedPreview')}</p>
              <div className="styx-btn-row" style={{ alignItems: "center" }}>
                <DemoWalletButton connected address="7xK9f...8c2e" isP01Wallet />
                <DemoWalletButton connected address="3mN2p...4f1a" />
              </div>
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
      </Block>

      {/* Payment button */}
      <Block title={t('sdkDemo.paymentButtonTitle')} note={t('sdkDemo.paymentButtonDesc')}>
        <div className="styx-stack">
          <div className="styx-panel">
            <div className="styx-panel-body">
              <div className="styx-btn-row" style={{ alignItems: "center" }}>
                <DemoPaymentButton amount={9.99} token="USDC" variant="primary" size="lg" />
                <DemoPaymentButton amount={25} token="SOL" variant="secondary" size="md" />
                <DemoPaymentButton amount={100} token="USDC" variant="outline" size="sm" />
              </div>
            </div>
          </div>

          <CodeBlock
            title={t('sdkDemo.paymentButtonCodeTitle')}
            code={`import { PaymentButton } from '@protocol-01/p01-js/react';

// The transfer is submitted straight to the program on devnet
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
      </Block>

      {/* Subscription button */}
      <Block title={t('sdkDemo.subscriptionButtonTitle')} note={t('sdkDemo.subscriptionButtonDesc')}>
        <div className="styx-stack">
          <div className="styx-panel">
            <div className="styx-panel-body">
              <div className="styx-btn-row" style={{ alignItems: "center" }}>
                <DemoSubscriptionButton amount={15.99} interval="monthly" variant="primary" />
                <DemoSubscriptionButton amount={149.99} interval="yearly" variant="secondary" />
              </div>
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
      </Block>
    </SectionShell>
  );
}

// ============ Cards Section ============
function CardsSection() {
  const t = useT();
  return (
    <SectionShell
      numeral="06"
      index={t('sdkDemo.tabCards')}
      title={t('sdkDemo.subscriptionCardTitle')}
      lede={t('sdkDemo.subscriptionCardDesc')}
    >
      {/* Sample data, and it says so. The old cards wore Netflix, Spotify,
          ChatGPT and Adobe names with invented totals, which read as real
          customer records and implied partnerships that do not exist. */}
      <div
        style={{
          display: "grid",
          gap: "1.5rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 21rem), 1fr))",
        }}
      >
        <DemoSubscriptionCard
          merchantName="Sample merchant 01"
          description="Standard plan"
          amount={15.99}
          interval="monthly"
          status="active"
          nextPayment="in 12 days"
          totalPaid={47.97}
          periodsPaid={3}
          privacyEnabled
        />
        <DemoSubscriptionCard
          merchantName="Sample merchant 02"
          description="Family plan"
          amount={16.99}
          interval="monthly"
          status="paused"
          nextPayment="Paused"
          totalPaid={33.98}
          periodsPaid={2}
        />
        <DemoSubscriptionCard
          merchantName="Sample merchant 03"
          description="Annual plan"
          amount={149.99}
          interval="yearly"
          status="active"
          nextPayment="in 5 days"
          totalPaid={149.99}
          periodsPaid={1}
        />
      </div>

      <CodeBlock
        title={t('sdkDemo.subscriptionCardCodeTitle')}
        code={`import { SubscriptionCard, useStreams } from '@protocol-01/p01-js/react';

// Fetch streams directly from blockchain
const { streams } = useStreams({ wallet: publicKey });

// Display on-chain subscription data
// Pause and resume are the only controls: a subscription is a one-way
// prepaid envelope and the protocol cannot refund the subscriber.
<SubscriptionCard
  stream={streams[0]} // On-chain stream data
  showPauseResume={true}
  onPauseResume={(id, state) => console.log(id, state)}
/>`}
      />
    </SectionShell>
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
    <div>
      <h3 className="styx-h3" style={{ marginBottom: "0.35rem" }}>{t('sdkDemo.choosePlan')}</h3>
      <p className="styx-card-note">{t('sdkDemo.freeTrial')}</p>

      {/* Privacy toggle. Not decoration: it selects PRIVACY_PRESET or
          PRIVACY_OFF in the real subscribe() call below. */}
      <div style={{ margin: "1.5rem 0" }}>
        <button
          type="button"
          onClick={() => setEnablePrivacy(!enablePrivacy)}
          className="styx-btn-ghost"
          aria-pressed={enablePrivacy}
          style={{ borderColor: enablePrivacy ? "var(--styx-accent)" : "var(--styx-rule)" }}
        >
          <span
            className="styx-dot"
            style={{ background: enablePrivacy ? "var(--styx-accent)" : "var(--styx-rule)" }}
            aria-hidden="true"
          />
          <Shield size={13} style={enablePrivacy ? ICON_ACCENT : ICON_FAINT} aria-hidden />
          {t('sdkDemo.enablePrivacy')}
        </button>
      </div>

      <div className="styx-grid styx-grid-3">
        {tiers.map((tier) => (
          <div
            key={tier.id}
            onClick={() => setSelectedTier(tier.id)}
            className="styx-card styx-sweep"
            style={{
              cursor: "pointer",
              background: selectedTier === tier.id ? "var(--styx-panel-2)" : undefined,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.75rem",
                minHeight: "1.9rem",
              }}
            >
              <p className="styx-card-label" style={{ margin: 0 }}>{tier.name}</p>
              {tier.popular && <span className="styx-chip">{t('sdkDemo.mostPopular')}</span>}
            </div>

            <p
              style={{
                fontFamily: "var(--styx-serif)",
                fontWeight: 300,
                fontSize: "2.6rem",
                lineHeight: 1,
                letterSpacing: "-0.02em",
                margin: "0.9rem 0 0.3rem",
              }}
            >
              {tier.price}
            </p>
            <p className="styx-note" style={{ fontFamily: "var(--styx-mono)" }}>
              USDC/{tier.interval}
            </p>

            {tier.trialDays && (
              <p className="styx-form-ok" style={{ marginTop: "0.75rem" }}>
                {tier.trialDays} {t('sdkDemo.dayFreeTrial')}
              </p>
            )}

            <ul style={{ listStyle: "none", padding: 0, margin: "1.25rem 0 1.5rem" }}>
              {tier.features.map((feature, index) => (
                <li key={index} className="styx-card-note" style={{ marginBottom: "0.45rem" }}>
                  <span className="styx-check" aria-hidden="true">&#10003;</span>
                  {feature}
                </li>
              ))}
            </ul>

            <TierWalletButton popular={tier.popular} tierName={tier.name} price={tier.price} interval={tier.interval} privacyEnabled={enablePrivacy} />
          </div>
        ))}
      </div>

      <p
        className="styx-note"
        style={{ marginTop: "1.5rem", fontFamily: "var(--styx-mono)", display: "flex", alignItems: "center", gap: "0.45rem" }}
      >
        <Lock size={12} style={ICON_FAINT} aria-hidden />
        {/* Was sdkDemo.onChainFooter: "100% On-chain · Smart Contract Verified ·
            P01 Wallet Required". "Verified" reads as audited, and this widget's
            own page POSTs to two endpoints, so "100% On-chain" was wrong too.
            The two keys left are the two facts. */}
        {t('sdkDemo.solanaDevnet')} &middot; {t('sdkDemo.featP01Required')}
      </p>
    </div>
  );
}

// Size differences are the only thing left of the old sizeStyles map: colour,
// radius and weight all come from styx-btn / styx-btn-ghost now.
const BTN_SIZE: Record<"sm" | "md" | "lg", React.CSSProperties> = {
  sm: { padding: "0.6rem 1.1rem", fontSize: "0.6875rem" },
  md: { padding: "0.85rem 1.7rem", fontSize: "0.75rem" },
  lg: { padding: "1.05rem 2.1rem", fontSize: "0.8125rem" },
};

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
  const className = !connected && variant === "primary" ? "styx-btn" : "styx-btn-ghost";

  return (
    <button type="button" className={className} style={BTN_SIZE[size]}>
      {connected ? (
        <>
          {isP01Wallet && <Wallet size={13} aria-hidden />}
          <span style={{ fontFamily: "var(--styx-mono)", textTransform: "none" }}>{address}</span>
        </>
      ) : (
        <>
          <Wallet size={13} aria-hidden />
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

  const className = variant === "primary" && !connected ? "styx-btn" : "styx-btn-ghost";

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
      type="button"
      onClick={handleClick}
      disabled={connecting}
      className={className}
      style={BTN_SIZE[size]}
    >
      {!walletAvailable ? (
        <>
          <Wallet size={13} aria-hidden />
          {t('sdkDemo.installWallet')}
        </>
      ) : connecting ? (
        <>
          <LoadingSpinner />
          {t('sdkDemo.connecting')}
        </>
      ) : connected && publicKey ? (
        <>
          <Wallet size={13} aria-hidden />
          <span style={{ fontFamily: "var(--styx-mono)", textTransform: "none" }}>
            {truncateAddress(publicKey)}
          </span>
        </>
      ) : (
        <>
          <Wallet size={13} aria-hidden />
          {t('sdkDemo.connectP01')}
        </>
      )}
    </button>
  );
}

// Loading Spinner for buttons. Takes the current text colour, so it works on
// styx-btn (dark ink on paper) and styx-btn-ghost (paper on ink) alike.
function LoadingSpinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ animation: "spin 1s linear infinite", flex: "none" }}
    >
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="32" strokeDashoffset="12" />
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
  // `subscribed` flag, re-derive it from the wallet instead of letting the
  // button reset to clickable and allow a duplicate subscription.
  //
  // FROZEN: this label is the same literal as the merchantName sent to
  // subscribe() below. The two must match or the matcher stops recognising a
  // live subscription, so it stays "Protocol 01 - <tier>" through the rebrand.
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
        maxPeriods: 0, // Unlimited: runs until the deposit is exhausted
        description: `${tierName} Plan - ${price} SOL/${interval} (Demo: 0.01 SOL)`,
        // Forward the on-page privacy selection so the wallet popup mirrors it.
        ...(privacyEnabled ? PRIVACY_PRESET : PRIVACY_OFF),
      });

      if (result) {
        setSubscriptionId(result.subscriptionId);
        setSubscribed(true);

        // Report what actually happened: the wallet stored a subscription. This
        // page has not read the chain, so it does not claim the subscription is
        // active, and it repeats the one-way rule while the reader is here.
        alert(`Subscription recorded in your wallet.\n\nPlan: ${tierName}\nAmount: 0.01 SOL per ${interval} (demo)\nSubscription ID: ${result.subscriptionId.slice(0, 8)}...\n\nOpen the Stream Secure section of your wallet to see it. This is devnet, and the deposit is one-way: there is no cancellation and the protocol cannot refund it.`);
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

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isLoading || subscribed}
      className={popular || subscribed ? "styx-btn" : "styx-btn-ghost"}
      style={{ width: "100%" }}
    >
      {!walletAvailable ? (
        <>
          <Wallet size={13} aria-hidden />
          {t('sdkDemo.installWallet')}
        </>
      ) : connecting ? (
        <>
          <LoadingSpinner />
          {t('sdkDemo.connecting')}
        </>
      ) : isSubscribing ? (
        <>
          <LoadingSpinner />
          {t('sdkDemo.confirmInWallet')}
        </>
      ) : subscribed ? (
        <>
          <Check size={13} aria-hidden />
          {t('sdkDemo.subscribed')}
        </>
      ) : connected && publicKey ? (
        <>
          {t('sdkDemo.subscribeWith')}
          <span style={{ fontFamily: "var(--styx-mono)", textTransform: "none" }}>
            {truncateAddress(publicKey)}
          </span>
        </>
      ) : (
        <>
          <Wallet size={13} aria-hidden />
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
  const className = variant === "primary" ? "styx-btn" : "styx-btn-ghost";

  return (
    <button type="button" className={className} style={BTN_SIZE[size]}>
      <CreditCard size={13} aria-hidden />
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
  const className = variant === "primary" ? "styx-btn" : "styx-btn-ghost";

  return (
    <button type="button" className={className} style={BTN_SIZE.md}>
      <RefreshCw size={13} aria-hidden />
      {t('sdkDemo.subscribeAmount')} {amount} USDC/{interval}
    </button>
  );
}

// Demo Subscription Card
//
// No Cancel action. The founder ruling is no cancel and no refund, and
// cancel_normal cannot succeed on a live vault, so a Cancel button here would
// advertise a capability the protocol does not have. Pause and resume live in
// the wallet, not on a merchant page.
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
  status: "active" | "paused";
  nextPayment: string;
  totalPaid: number;
  periodsPaid: number;
  privacyEnabled?: boolean;
}) {
  const t = useT();

  return (
    <div className="styx-panel">
      <div
        className="styx-panel-head"
        style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}
      >
        <div>
          <p className="styx-card-value" style={{ fontSize: "1.2rem", margin: 0 }}>{merchantName}</p>
          <p className="styx-card-note" style={{ marginTop: "0.2rem" }}>{description}</p>
        </div>
        <span className="styx-chip">
          {status === "active" && <span className="styx-dot" aria-hidden="true" />}
          {status}
        </span>
      </div>

      <div className="styx-panel-body">
        <div className="styx-row">
          <span className="styx-row-key">{t('sdkDemo.amountLabel')}</span>
          <span className="styx-row-leader" />
          <span className="styx-row-value">
            {amount} USDC {t('sdkDemo.perInterval')} {interval}
          </span>
        </div>
        <div className="styx-row">
          <span className="styx-row-key">{t('sdkDemo.nextPaymentLabel')}</span>
          <span className="styx-row-leader" />
          <span className="styx-row-value">{nextPayment}</span>
        </div>
        <div className="styx-row">
          <span className="styx-row-key">{t('sdkDemo.totalPaidLabel')}</span>
          <span className="styx-row-leader" />
          <span className="styx-row-value">
            {totalPaid} USDC / {periodsPaid} {t('sdkDemo.paymentsLabel')}
          </span>
        </div>

        {privacyEnabled && (
          <p style={{ margin: "1rem 0 0" }}>
            <span className="styx-chip">
              <span className="styx-dot" aria-hidden="true" />
              {t('sdkDemo.privacyEnabled')}
            </span>
          </p>
        )}

        <div className="styx-btn-row" style={{ marginTop: "1.25rem" }}>
          <button type="button" className="styx-btn-ghost" style={{ padding: "0.7rem 1.3rem" }}>
            {t('sdkDemo.viewDetails')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ Code Block ============
function CodeBlock({ title, code }: { title: string; code: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="styx-code-panel">
      <div className="styx-code-head">
        <span>{title}</span>
        <button
          type="button"
          onClick={copyCode}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            background: "transparent",
            border: "none",
            padding: 0,
            font: "inherit",
            letterSpacing: "inherit",
            color: copied ? "var(--styx-accent)" : "inherit",
            cursor: "pointer",
          }}
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          {copied ? t('sdkDemo.copied') : t('sdkDemo.copy')}
        </button>
      </div>
      <pre className="styx-code">
        <code>{code}</code>
      </pre>
    </div>
  );
}
