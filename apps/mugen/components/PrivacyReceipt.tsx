'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Coins,
  Brain,
  Network,
  Cpu,
  ShieldCheck,
  CheckCircle2,
  ExternalLink,
  Handshake,
  Loader2,
  AlertTriangle,
  Link as LinkIcon,
  Copy,
  Check,
  Share2,
} from 'lucide-react';
import type {
  ThresholdMetaSuccess,
  MatchedOrderDetails,
  FiatCurrency,
} from '@/lib/mpc-types';
import TradeLifecycleCard from './TradeLifecycleCard';

// ═══════════════════════════════════════════════════════════════════════════
// Privacy Receipt — renders the 4 composable privacy layers that protected
// an encrypted submit / blind take trade. Gojo theme (GlassCard + Orbitron).
// Polished for pitch: copyable tx sigs, verifiable explorer links, signer
// timestamps, and a concrete "breaks-if" attack-surface footer.
// ═══════════════════════════════════════════════════════════════════════════

export interface PrivacyReceiptProps {
  operation: 'submit' | 'take';
  computationOffset?: string;
  txSignature: string;
  threshold?: ThresholdMetaSuccess;
  matched?: boolean;
  /**
   * When operation === 'take' and matched === true, the matched maker's
   * public details (from the MVP server-side registry). Required for the
   * follow-up "Claim match & create escrow" action.
   */
  matchedOrder?: MatchedOrderDetails;
  /** Taker's nonce pubkey — needed for the claim-match API call. */
  takerNoncePubkey?: string;
  /** Currency the taker searched in (for UI display only). */
  fiatCurrency?: FiatCurrency;
}

interface ClaimMatchSuccess {
  ok: true;
  /** True when the real token-bearing MugenEscrow PDA was created. */
  tokenEscrow?: boolean;
  escrowPDA?: string;
  vaultPDA?: string;
  orderPDA?: string;
  reputationPDA?: string;
  txSignature?: string;
  simulated?: boolean;
  matchedTerms: {
    cryptoAmountLamports: number;
    fiatAmountCents: number;
    fiatCurrency: FiatCurrency;
    paymentMethods: number;
    makerNoncePubkey: string;
    takerNoncePubkey: string;
    takerWallet: string;
  };
  note?: string;
  fallbackReason?: string;
}

interface ClaimMatchError {
  error: string;
  detail?: string;
}

const PAYMENT_METHOD_LABELS: readonly { label: string; bit: number }[] = [
  { label: 'SEPA', bit: 1 },
  { label: 'Revolut', bit: 2 },
  { label: 'Wise', bit: 4 },
  { label: 'Cash', bit: 8 },
  { label: 'Zelle', bit: 16 },
];

function decodePaymentMethods(mask: number): string {
  const hits = PAYMENT_METHOD_LABELS.filter((m) => (mask & m.bit) !== 0).map(
    (m) => m.label,
  );
  return hits.length > 0 ? hits.join(' · ') : `0x${mask.toString(16)}`;
}

function shortenPubkey(s: string): string {
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function shortenSig(sig: string): string {
  if (sig.length <= 20) return sig;
  return `${sig.slice(0, 12)}…${sig.slice(-8)}`;
}

function txExplorerUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function addressExplorerUrl(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

function formatRelative(tsSeconds: number, nowMs: number): string {
  // Accept seconds or milliseconds — values < 1e12 are treated as seconds.
  if (nowMs === 0) return '—';
  const ms = tsSeconds < 1e12 ? tsSeconds * 1000 : tsSeconds;
  const diff = Math.max(0, nowMs - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface LayerDef {
  key: string;
  layer: string;
  title: string;
  accent: string;
  icon: React.ReactNode;
  description: string;
  detail: React.ReactNode;
  prominent?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Keyframes — declared exactly once at module scope. Using styled-jsx inside
// CopyButton would duplicate this block per instance under Next 16 Turbopack
// and scoping is fragile across RSC boundaries; a single inline <style> tag
// rendered once by the main component is simpler and correct.
// ═══════════════════════════════════════════════════════════════════════════

const MUGEN_FADE_KEYFRAMES = `
@keyframes mugenFade {
  0% { opacity: 0; transform: translate(-50%, 2px); }
  15% { opacity: 1; transform: translate(-50%, 0); }
  80% { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, -2px); }
}
`;

// ═══════════════════════════════════════════════════════════════════════════
// CopyButton — small icon-only button that copies a string to clipboard and
// briefly toggles to a Check icon + "Copied" tooltip. Accessible via
// aria-label; not color-only (icon switches too).
// ═══════════════════════════════════════════════════════════════════════════

interface CopyButtonProps {
  value: string;
  label: string;
  tint?: string;
}

function CopyButton({ value, label, tint = '#c4b5fd' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        }
      } catch {
        // Best-effort — clipboard can throw in non-secure contexts.
      }
    },
    [value],
  );

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '1.25rem',
          height: '1.25rem',
          padding: 0,
          border: `1px solid ${tint}30`,
          borderRadius: '6px',
          background: `${tint}10`,
          color: copied ? '#86efac' : tint,
          cursor: 'pointer',
          transition: 'color 120ms ease, background 120ms ease',
        }}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
      {copied && (
        <span
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '0.15rem 0.45rem',
            borderRadius: '6px',
            background: 'rgba(10,10,24,0.95)',
            border: '1px solid rgba(34,197,94,0.4)',
            color: '#86efac',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.6rem',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            animation: 'mugenFade 1.5s ease forwards',
          }}
        >
          Copied
        </span>
      )}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// OnchainRef — consistent rendering of an on-chain artifact: truncated mono
// anchor → Solana Explorer, trailing external-link icon, and a copy button.
// Works for tx signatures and account addresses (pass kind).
// ═══════════════════════════════════════════════════════════════════════════

interface OnchainRefProps {
  kind: 'tx' | 'address';
  value: string;
  label: string;
  tint?: string;
  prefix?: string;
}

function OnchainRef({
  kind,
  value,
  label,
  tint = '#c4b5fd',
  prefix,
}: OnchainRefProps) {
  const href = kind === 'tx' ? txExplorerUrl(value) : addressExplorerUrl(value);
  const short = kind === 'tx' ? shortenSig(value) : shortenPubkey(value);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        flexWrap: 'wrap',
      }}
    >
      {prefix && (
        <span
          style={{
            color: '#555570',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.68rem',
          }}
        >
          {prefix}
        </span>
      )}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label} on Solana Explorer (devnet)`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
          color: tint,
          textDecoration: 'none',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.68rem',
          borderBottom: '1px dashed transparent',
          transition: 'border-color 120ms ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderBottomColor = `${tint}80`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderBottomColor = 'transparent';
        }}
      >
        <code
          style={{
            background: 'transparent',
            color: 'inherit',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        >
          {short}
        </code>
        <ExternalLink size={11} aria-hidden="true" />
      </a>
      <CopyButton value={value} label={label} tint={tint} />
    </span>
  );
}

export default function PrivacyReceipt({
  operation,
  computationOffset,
  txSignature,
  threshold,
  matched,
  matchedOrder,
  takerNoncePubkey,
  fiatCurrency,
}: PrivacyReceiptProps) {
  const [receiptCopied, setReceiptCopied] = useState(false);
  // Client-only wall-clock anchor for relative timestamp rendering. Kept at
  // 0 on the server so `formatRelative` returns a stable placeholder until
  // after hydration — prevents SSR/CSR mismatches.
  const [nowMs, setNowMs] = useState<number>(0);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  const onCopyReceipt = useCallback(async () => {
    const payload = {
      operation,
      matched: matched ?? null,
      txSignature,
      explorer: txExplorerUrl(txSignature),
      computationOffset: computationOffset ?? null,
      fiatCurrency: fiatCurrency ?? matchedOrder?.fiatCurrency ?? null,
      threshold: threshold
        ? {
            reached: threshold.reached,
            signaturesCount: threshold.signaturesCount,
            threshold: threshold.threshold,
            totalSigners: threshold.totalSigners,
            txHashHex: threshold.txHashHex,
            signers: threshold.signers.map((s) => ({
              region: s.region,
              port: s.port,
              signerPubkey: s.signerPubkey,
              signedAt: s.signedAt,
            })),
          }
        : null,
      matchedOrder: matchedOrder
        ? {
            makerNoncePubkey: matchedOrder.makerNoncePubkey,
            cryptoAmountLamports: matchedOrder.cryptoAmountLamports,
            fiatAmountCents: matchedOrder.fiatAmountCents,
            fiatCurrency: matchedOrder.fiatCurrency,
            paymentMethods: matchedOrder.paymentMethods,
            expiresAtUnix: matchedOrder.expiresAtUnix,
            mpcTxSignature: matchedOrder.mpcTxSignature,
            registeredAt: matchedOrder.registeredAt,
          }
        : null,
      takerNoncePubkey: takerNoncePubkey ?? null,
      generatedAt: new Date().toISOString(),
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        setReceiptCopied(true);
      }
    } catch {
      // silent — clipboard may be blocked
    }
  }, [
    operation,
    matched,
    txSignature,
    computationOffset,
    fiatCurrency,
    threshold,
    matchedOrder,
    takerNoncePubkey,
  ]);

  useEffect(() => {
    if (!receiptCopied) return;
    const t = setTimeout(() => setReceiptCopied(false), 1500);
    return () => clearTimeout(t);
  }, [receiptCopied]);

  const layers: LayerDef[] = [
    {
      key: 'L1',
      layer: 'L1',
      title: 'Natural Variance Fiat',
      accent: '#eab308',
      icon: <Coins size={14} aria-hidden="true" />,
      description:
        'Off-chain fiat leg carries organic transaction noise — no chain-observable settlement on the fiat side.',
      detail: (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.66rem',
            color: '#fcd34d',
          }}
        >
          <CheckCircle2 size={11} aria-hidden="true" /> P2P rails, no on-chain fiat trail
        </span>
      ),
    },
    {
      key: 'L8',
      layer: 'L8',
      title: 'Arcium MPC',
      accent: '#c4b5fd',
      icon: <Brain size={14} aria-hidden="true" />,
      prominent: true,
      description:
        operation === 'submit'
          ? 'Plaintext crypto amount, fiat amount, and payment methods were encrypted in your browser before hitting the MPC network.'
          : 'Your desired amount and max fiat were matched against encrypted orders inside MPC — neither side learned the other’s terms.',
      detail: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {computationOffset && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.66rem',
                color: '#8888aa',
                wordBreak: 'break-all',
              }}
            >
              <span style={{ color: '#555570' }}>offset:</span>
              <code
                style={{
                  color: '#c4b5fd',
                  background: 'transparent',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                }}
              >
                {computationOffset}
              </code>
              <CopyButton
                value={computationOffset}
                label="computation offset"
                tint="#c4b5fd"
              />
            </div>
          )}
          <OnchainRef
            kind="tx"
            value={txSignature}
            label="MPC transaction signature"
            tint="#c4b5fd"
            prefix="tx:"
          />
        </div>
      ),
    },
    {
      key: 'L9',
      layer: 'L9',
      title: 'FROST Quorum',
      accent: '#93c5fd',
      icon: <Network size={14} aria-hidden="true" />,
      description:
        'A 2-of-3 distributed signer network approved the MPC transaction before the relayer signed it. No single node can front-run or censor.',
      detail: threshold ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.35rem',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.66rem',
              color: '#4ade80',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            <ShieldCheck size={11} aria-hidden="true" />
            {threshold.signaturesCount}-of-{threshold.totalSigners} approved · threshold{' '}
            {threshold.threshold}
          </div>
          <ul
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.3rem',
              listStyle: 'none',
              padding: 0,
              margin: 0,
            }}
          >
            {threshold.signers.map((s) => (
              <li
                key={s.signerPubkey}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  background: 'rgba(34,197,94,0.1)',
                  border: '1px solid rgba(34,197,94,0.25)',
                  padding: '0.15rem 0.45rem',
                  borderRadius: '999px',
                }}
              >
                <CheckCircle2 size={10} color="#86efac" aria-hidden="true" />
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.6rem',
                    color: '#86efac',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  {s.region}
                </span>
                <code
                  title={s.signerPubkey}
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.6rem',
                    color: '#a7f3d0',
                    background: 'transparent',
                  }}
                >
                  {s.signerPubkey.slice(0, 6)}…{s.signerPubkey.slice(-4)}
                </code>
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.58rem',
                    color: '#6ee7b7',
                    opacity: 0.75,
                  }}
                >
                  · {formatRelative(s.signedAt, nowMs)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.66rem',
            color: '#8888aa',
          }}
        >
          threshold metadata not returned
        </span>
      ),
    },
    {
      key: 'L11',
      layer: 'L11',
      title: 'Post-Quantum Crypto',
      accent: '#60a5fa',
      icon: <Cpu size={14} aria-hidden="true" />,
      description:
        'Underlying Protocol 01 primitives are hash-based (Poseidon + Blake3 STARKs) — resistant to Shor-class quantum attacks on elliptic curves.',
      detail: (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.18rem 0.5rem',
            borderRadius: '999px',
            background: 'rgba(96,165,250,0.1)',
            border: '1px solid rgba(96,165,250,0.3)',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.6rem',
            color: '#93c5fd',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          <CheckCircle2 size={10} aria-hidden="true" /> Quantum-safe path active
        </span>
      ),
    },
  ];

  const heading =
    operation === 'submit'
      ? 'Private order submitted'
      : matched
        ? 'Private match found'
        : 'Blind take executed — no match';

  const subheading =
    operation === 'submit'
      ? 'Plaintext terms never left your browser. Here is the privacy receipt:'
      : matched
        ? 'A match was found inside MPC. Neither side learned the other party’s terms.'
        : 'No compatible encrypted order existed. Nothing was revealed about your search parameters.';

  return (
    <section
      aria-label="Privacy receipt"
      style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.02)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(139,92,246,0.2)',
        borderRadius: '16px',
        padding: '1.1rem 1.2rem',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
      }}
    >
      {/* Declare mugenFade keyframes once for this receipt + its descendants. */}
      <style dangerouslySetInnerHTML={{ __html: MUGEN_FADE_KEYFRAMES }} />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '1px',
          background:
            'linear-gradient(90deg, transparent, rgba(139,92,246,0.5), transparent)',
        }}
      />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <div
          aria-hidden="true"
          style={{
            width: '2rem',
            height: '2rem',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background:
              'linear-gradient(135deg, rgba(34,197,94,0.2), rgba(139,92,246,0.2))',
            border: '1px solid rgba(34,197,94,0.3)',
            color: '#4ade80',
          }}
        >
          <CheckCircle2 size={16} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          <h3
            style={{
              margin: 0,
              fontFamily: "'Orbitron', sans-serif",
              fontSize: '0.9rem',
              fontWeight: 700,
              color: '#ffffff',
              letterSpacing: '0.04em',
            }}
          >
            {heading}
          </h3>
          <span
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: '0.78rem',
              color: '#a5b4fc',
            }}
          >
            {subheading}
          </span>
        </div>
      </div>

      {/* Layer list */}
      <ol
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.45rem',
          listStyle: 'none',
          padding: 0,
          margin: 0,
        }}
      >
        {layers.map((l) => {
          const prominent = l.prominent === true;
          return (
            <li
              key={l.key}
              style={{
                position: 'relative',
                display: 'flex',
                gap: '0.7rem',
                padding: prominent ? '0.75rem 0.9rem' : '0.55rem 0.75rem',
                borderRadius: '12px',
                background: prominent
                  ? `linear-gradient(135deg, ${l.accent}14, rgba(10,10,24,0.55))`
                  : 'rgba(10,10,24,0.5)',
                border: `1px solid ${l.accent}${prominent ? '55' : '30'}`,
                boxShadow: prominent
                  ? `0 0 0 1px ${l.accent}20, 0 0 28px -8px ${l.accent}50`
                  : 'none',
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: prominent ? '2rem' : '1.75rem',
                  height: prominent ? '2rem' : '1.75rem',
                  flexShrink: 0,
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: `${l.accent}15`,
                  color: l.accent,
                  border: `1px solid ${l.accent}35`,
                }}
              >
                {l.icon}
              </div>
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '0.5rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.6rem',
                      color: l.accent,
                      textTransform: 'uppercase',
                      letterSpacing: '0.16em',
                    }}
                  >
                    {l.layer}
                  </span>
                  <span
                    style={{
                      fontFamily: "'Orbitron', sans-serif",
                      fontSize: prominent ? '0.82rem' : '0.76rem',
                      fontWeight: 700,
                      color: '#ffffff',
                    }}
                  >
                    {l.title}
                  </span>
                  {prominent && (
                    <span
                      style={{
                        marginLeft: 'auto',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        padding: '0.1rem 0.4rem',
                        borderRadius: '999px',
                        background: `${l.accent}1f`,
                        border: `1px solid ${l.accent}55`,
                        color: l.accent,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.56rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                      }}
                    >
                      <CheckCircle2 size={9} aria-hidden="true" />
                      On-chain proof
                    </span>
                  )}
                </div>
                <p
                  style={{
                    margin: 0,
                    fontFamily: "'Inter', sans-serif",
                    fontSize: prominent ? '0.74rem' : '0.7rem',
                    color: '#8888aa',
                    lineHeight: 1.4,
                  }}
                >
                  {l.description}
                </p>
                <div style={{ marginTop: '0.1rem' }}>{l.detail}</div>
              </div>
            </li>
          );
        })}
      </ol>

      {/* Attack-surface footer */}
      <div
        style={{
          display: 'flex',
          gap: '0.55rem',
          alignItems: 'flex-start',
          padding: '0.65rem 0.8rem',
          borderRadius: '10px',
          background:
            'linear-gradient(135deg, rgba(139,92,246,0.08), rgba(59,130,246,0.04))',
          border: '1px solid rgba(139,92,246,0.3)',
        }}
      >
        <ShieldCheck
          size={14}
          color="#c4b5fd"
          style={{ flexShrink: 0, marginTop: '2px' }}
          aria-hidden="true"
        />
        <p
          style={{
            margin: 0,
            fontFamily: "'Inter', sans-serif",
            fontSize: '0.72rem',
            color: '#c4b5fd',
            lineHeight: 1.5,
          }}
        >
          To defeat this transaction, an attacker would need to simultaneously
          compromise <strong style={{ color: '#ffffff' }}>Arcium MPC</strong>{' '}
          (multi-party computation),{' '}
          <strong style={{ color: '#ffffff' }}>
            2 of 3 geodistributed FROST signers
          </strong>
          , AND break{' '}
          <strong style={{ color: '#ffffff' }}>post-quantum STARK commitments</strong>.
          Each layer failing alone leaks nothing.
        </p>
      </div>

      {/* Claim-match card — rendered only on take+match with full context */}
      {operation === 'take' &&
        matched === true &&
        matchedOrder &&
        takerNoncePubkey && (
          <ClaimMatchCard
            matchedOrder={matchedOrder}
            takerNoncePubkey={takerNoncePubkey}
            fiatCurrency={fiatCurrency ?? matchedOrder.fiatCurrency}
          />
        )}

      {/* Share receipt */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          marginTop: '-0.1rem',
        }}
      >
        <button
          type="button"
          onClick={onCopyReceipt}
          aria-label={
            receiptCopied
              ? 'Receipt JSON copied to clipboard'
              : 'Copy receipt as JSON'
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.4rem 0.7rem',
            borderRadius: '8px',
            border: `1px solid ${receiptCopied ? 'rgba(34,197,94,0.45)' : 'rgba(139,92,246,0.3)'}`,
            background: receiptCopied
              ? 'rgba(34,197,94,0.1)'
              : 'rgba(139,92,246,0.08)',
            color: receiptCopied ? '#86efac' : '#c4b5fd',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.64rem',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            cursor: 'pointer',
            transition: 'all 160ms ease',
          }}
        >
          {receiptCopied ? (
            <>
              <Check size={11} aria-hidden="true" />
              Copied
            </>
          ) : (
            <>
              <Share2 size={11} aria-hidden="true" />
              Copy receipt as JSON
            </>
          )}
        </button>
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ClaimMatchCard — renders the matched maker's public terms and lets the
// taker trigger /api/trade/claim-match to start the escrow leg.
//
// MVP: ephemeral server-side registry of encrypted orders.
// Production path = parse the Arcium MPC callback output to extract the
// matched maker's nonce directly from chain, no server state needed.
// Blocked on arcium-anchor 0.9.2 callback output wrapper ABI.
// ═══════════════════════════════════════════════════════════════════════════

interface ClaimMatchCardProps {
  matchedOrder: MatchedOrderDetails;
  takerNoncePubkey: string;
  fiatCurrency: FiatCurrency;
}

function ClaimMatchCard({
  matchedOrder,
  takerNoncePubkey,
  fiatCurrency,
}: ClaimMatchCardProps) {
  const [takerWallet, setTakerWallet] = useState<string>('');
  const [claiming, setClaiming] = useState(false);
  const [claimResult, setClaimResult] = useState<ClaimMatchSuccess | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  // Pre-fill with the relayer pubkey (MVP). Best-effort — silent on failure.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/debug/relayer-pubkey');
        if (!res.ok) return;
        const json = (await res.json()) as { pubkey?: string };
        if (!cancelled && json.pubkey) setTakerWallet(json.pubkey);
      } catch {
        // ignore — user can paste their own pubkey
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onClaim = useCallback(async () => {
    setClaiming(true);
    setClaimError(null);
    setClaimResult(null);
    try {
      const res = await fetch('/api/trade/claim-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          takerNoncePubkey,
          matchedMakerNonce: matchedOrder.makerNoncePubkey,
          takerWallet,
        }),
      });
      const json = (await res.json()) as ClaimMatchSuccess | ClaimMatchError;
      if (!res.ok || 'error' in json) {
        const errJson = json as ClaimMatchError;
        setClaimError(errJson.detail || errJson.error || `HTTP ${res.status}`);
      } else {
        setClaimResult(json);
      }
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setClaiming(false);
    }
  }, [matchedOrder.makerNoncePubkey, takerNoncePubkey, takerWallet]);

  const paymentLabels = decodePaymentMethods(matchedOrder.paymentMethods);

  // Success state — green "Escrow ready" card
  if (claimResult) {
    return (
      <div
        style={{
          position: 'relative',
          background:
            'linear-gradient(135deg, rgba(34,197,94,0.08), rgba(139,92,246,0.05))',
          border: '1px solid rgba(34,197,94,0.35)',
          borderRadius: '14px',
          padding: '1rem 1.1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.7rem',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontFamily: "'Orbitron', sans-serif",
            fontSize: '0.85rem',
            fontWeight: 700,
            color: '#86efac',
            letterSpacing: '0.04em',
          }}
        >
          <CheckCircle2 size={16} aria-hidden="true" />
          {claimResult.tokenEscrow ? 'Token Escrow Active' : 'Escrow ready'}
          {claimResult.tokenEscrow && (
            <span
              style={{
                marginLeft: '0.35rem',
                padding: '0.15rem 0.5rem',
                borderRadius: '999px',
                background: 'rgba(34,197,94,0.15)',
                border: '1px solid rgba(34,197,94,0.4)',
                color: '#86efac',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.6rem',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              wSOL locked
            </span>
          )}
          {claimResult.simulated && (
            <span
              style={{
                marginLeft: 'auto',
                padding: '0.15rem 0.5rem',
                borderRadius: '999px',
                background: 'rgba(245,158,11,0.12)',
                border: '1px solid rgba(245,158,11,0.3)',
                color: '#fcd34d',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.6rem',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              simulated
            </span>
          )}
        </div>

        {claimResult.tokenEscrow ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {claimResult.escrowPDA && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.7rem',
                  color: '#d1d5db',
                }}
              >
                <span style={{ color: '#8888aa', minWidth: '3.5rem' }}>escrow:</span>
                <OnchainRef
                  kind="address"
                  value={claimResult.escrowPDA}
                  label="MugenEscrow PDA"
                  tint="#86efac"
                />
              </div>
            )}
            {claimResult.vaultPDA && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.7rem',
                  color: '#d1d5db',
                }}
              >
                <span style={{ color: '#8888aa', minWidth: '3.5rem' }}>vault:</span>
                <OnchainRef
                  kind="address"
                  value={claimResult.vaultPDA}
                  label="wSOL vault token account"
                  tint="#86efac"
                />
              </div>
            )}
            {claimResult.orderPDA && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.7rem',
                  color: '#d1d5db',
                }}
              >
                <span style={{ color: '#8888aa', minWidth: '3.5rem' }}>order:</span>
                <OnchainRef
                  kind="address"
                  value={claimResult.orderPDA}
                  label="MugenOrder PDA"
                  tint="#c4b5fd"
                />
              </div>
            )}
          </div>
        ) : (
          claimResult.escrowPDA && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.4rem',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.7rem',
                color: '#d1d5db',
              }}
            >
              <span style={{ color: '#8888aa' }}>reputation:</span>
              <OnchainRef
                kind="address"
                value={claimResult.escrowPDA}
                label="reputation PDA"
                tint="#86efac"
              />
            </div>
          )
        )}
        {claimResult.fallbackReason && !claimResult.tokenEscrow && (
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.65rem',
              color: '#fca5a5',
              lineHeight: 1.5,
              background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: '8px',
              padding: '0.45rem 0.65rem',
            }}
          >
            token escrow unavailable: {claimResult.fallbackReason}
          </div>
        )}
        {claimResult.txSignature && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '0.4rem',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.7rem',
              color: '#d1d5db',
            }}
          >
            <span style={{ color: '#8888aa' }}>tx:</span>
            <OnchainRef
              kind="tx"
              value={claimResult.txSignature}
              label="escrow tx signature"
              tint="#93c5fd"
            />
          </div>
        )}
        {claimResult.note && (
          <div
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: '0.72rem',
              color: '#fcd34d',
              lineHeight: 1.5,
              background: 'rgba(245,158,11,0.06)',
              border: '1px solid rgba(245,158,11,0.2)',
              borderRadius: '8px',
              padding: '0.5rem 0.7rem',
            }}
          >
            {claimResult.note}
          </div>
        )}
        {claimResult.tokenEscrow &&
          claimResult.escrowPDA &&
          claimResult.orderPDA &&
          claimResult.vaultPDA &&
          claimResult.txSignature && (
            <TradeLifecycleCard
              escrowPDA={claimResult.escrowPDA}
              orderPDA={claimResult.orderPDA}
              vaultPDA={claimResult.vaultPDA}
              initialTxSignature={claimResult.txSignature}
            />
          )}
        <a
          href="/exchange"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.4rem',
            padding: '0.65rem 1rem',
            borderRadius: '10px',
            border: '1px solid rgba(34,197,94,0.3)',
            background: 'rgba(34,197,94,0.12)',
            color: '#86efac',
            fontFamily: "'Orbitron', sans-serif",
            fontSize: '0.75rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            textDecoration: 'none',
          }}
        >
          <LinkIcon size={12} aria-hidden="true" />
          Open the trade floor
        </a>
      </div>
    );
  }

  // Action state — "Claim your match" form
  return (
    <div
      style={{
        position: 'relative',
        background:
          'linear-gradient(135deg, rgba(139,92,246,0.08), rgba(59,130,246,0.05))',
        border: '1px solid rgba(139,92,246,0.35)',
        borderRadius: '14px',
        padding: '1rem 1.1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontFamily: "'Orbitron', sans-serif",
          fontSize: '0.9rem',
          fontWeight: 700,
          color: '#ffffff',
          letterSpacing: '0.04em',
        }}
      >
        <Handshake size={16} color="#c4b5fd" aria-hidden="true" />
        Claim your match
      </div>

      <p
        style={{
          margin: 0,
          fontFamily: "'Inter', sans-serif",
          fontSize: '0.76rem',
          color: '#a5b4fc',
          lineHeight: 1.5,
        }}
      >
        MPC confirmed a compatible sell offer. Confirm your settlement wallet to
        open the real on-chain escrow and start the trade.
      </p>

      {/* Matched terms grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0.5rem 0.9rem',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.72rem',
        }}
      >
        <div>
          <div
            style={{
              color: '#555570',
              fontSize: '0.62rem',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            Crypto
          </div>
          <div style={{ color: '#e5e7eb' }}>
            {(matchedOrder.cryptoAmountLamports / 1e9).toFixed(4)} SOL
          </div>
        </div>
        <div>
          <div
            style={{
              color: '#555570',
              fontSize: '0.62rem',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            Fiat
          </div>
          <div style={{ color: '#e5e7eb' }}>
            {(matchedOrder.fiatAmountCents / 100).toFixed(2)} {fiatCurrency}
          </div>
        </div>
        <div>
          <div
            style={{
              color: '#555570',
              fontSize: '0.62rem',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            Payment methods
          </div>
          <div style={{ color: '#e5e7eb' }}>{paymentLabels}</div>
        </div>
        <div>
          <div
            style={{
              color: '#555570',
              fontSize: '0.62rem',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            Maker nonce
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <OnchainRef
              kind="address"
              value={matchedOrder.makerNoncePubkey}
              label="maker nonce pubkey"
              tint="#c4b5fd"
            />
          </div>
        </div>
      </div>

      {/* Taker wallet input */}
      <div>
        <label
          htmlFor="mugen-taker-wallet"
          style={{
            display: 'block',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.64rem',
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
            color: '#8888aa',
            marginBottom: '0.35rem',
          }}
        >
          Your settlement wallet (pubkey)
        </label>
        <input
          id="mugen-taker-wallet"
          type="text"
          value={takerWallet}
          onChange={(e) => setTakerWallet(e.target.value)}
          placeholder="Paste a base58 pubkey…"
          aria-label="Your settlement wallet public key"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: 'rgba(10,10,24,0.65)',
            border: '1px solid rgba(139,92,246,0.25)',
            borderRadius: '10px',
            padding: '0.6rem 0.75rem',
            color: '#ffffff',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.74rem',
            outline: 'none',
          }}
        />
        <div
          style={{
            marginTop: '0.3rem',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.6rem',
            color: '#555570',
          }}
        >
          Pre-filled with the relayer pubkey (MVP). Replace with your own.
        </div>
      </div>

      {/* Error */}
      {claimError && (
        <div
          role="alert"
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'flex-start',
            padding: '0.6rem 0.8rem',
            borderRadius: '10px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.25)',
            color: '#fca5a5',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.7rem',
          }}
        >
          <AlertTriangle
            size={12}
            style={{ flexShrink: 0, marginTop: '2px' }}
            aria-hidden="true"
          />
          <span style={{ wordBreak: 'break-word' }}>{claimError}</span>
        </div>
      )}

      {/* Submit */}
      <button
        type="button"
        onClick={onClaim}
        disabled={claiming || takerWallet.length < 32}
        aria-label="Claim match and start escrow"
        style={{
          width: '100%',
          padding: '0.8rem 1rem',
          borderRadius: '12px',
          border: '1px solid rgba(139,92,246,0.5)',
          background:
            claiming || takerWallet.length < 32
              ? 'rgba(139,92,246,0.12)'
              : 'linear-gradient(135deg, rgba(139,92,246,0.45), rgba(59,130,246,0.45))',
          color: '#ffffff',
          fontFamily: "'Orbitron', sans-serif",
          fontWeight: 700,
          fontSize: '0.8rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          cursor: claiming || takerWallet.length < 32 ? 'not-allowed' : 'pointer',
          opacity: claiming || takerWallet.length < 32 ? 0.6 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
        }}
      >
        {claiming ? (
          <>
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Opening escrow…
          </>
        ) : (
          <>
            <Handshake size={14} aria-hidden="true" />
            Claim match & start escrow
          </>
        )}
      </button>

      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.6rem',
          color: '#555570',
          fontStyle: 'italic',
          lineHeight: 1.5,
        }}
      >
        MVP: match is pulled from an ephemeral server-side registry. Production
        path ingests the Arcium callback output directly (blocked on
        arcium-anchor 0.9.2 ABI).
      </div>
    </div>
  );
}
