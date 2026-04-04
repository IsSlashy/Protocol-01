'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  CheckCircle,
  Clock,
  AlertTriangle,
  Shield,
  Lock,
  ArrowRight,
  RefreshCw,
  ExternalLink,
  Copy,
  XCircle,
} from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import { useP01Wallet } from '@/components/WalletProvider';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EscrowData {
  address: string;
  order: string;
  maker: string;
  taker: string;
  tokenMint: string;
  token: string;
  cryptoAmount: number;
  fiatAmount: number;
  escrowVault: string;
  paymentMethod: string;
  status: string;
  statusRaw: number;
  createdAt: number;
  expiresAt: number;
  paymentConfirmedAt: number;
  disputeInitiator: string;
}

interface OrderData {
  address: string;
  maker: string;
  token: string;
  cryptoAmount: number;
  fiatAmount: number;
  fiatCurrency: string;
  paymentMethods: string[];
  status: string;
}

type TradePhase = 'loading' | 'no_escrow' | 'awaiting_payment' | 'payment_confirmed' | 'released' | 'disputed' | 'refunded' | 'expired' | 'error';

// ─── GlassCard (shared pattern) ────────────────────────────────────────────

function GlassCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      position: 'relative',
      background: 'rgba(255,255,255,0.03)',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '16px',
      overflow: 'hidden',
      transition: 'all 0.3s ease',
      ...style,
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)' }} />
      {children}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  if (!addr || addr.length < 8) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'Expired';
  const hours = Math.floor(secondsLeft / 3600);
  const mins = Math.floor((secondsLeft % 3600) / 60);
  const secs = Math.floor(secondsLeft % 60);
  if (hours > 0) return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

const PHASE_CONFIG: Record<string, { color: string; label: string; bg: string }> = {
  awaiting_payment: { color: '#eab308', label: 'Awaiting Payment', bg: 'rgba(234,179,8,0.1)' },
  payment_confirmed: { color: '#3b82f6', label: 'Payment Confirmed', bg: 'rgba(59,130,246,0.1)' },
  released: { color: '#22c55e', label: 'Completed', bg: 'rgba(34,197,94,0.1)' },
  disputed: { color: '#ef4444', label: 'Disputed', bg: 'rgba(239,68,68,0.1)' },
  refunded: { color: '#8b5cf6', label: 'Refunded', bg: 'rgba(139,92,246,0.1)' },
  expired: { color: '#555570', label: 'Expired', bg: 'rgba(85,85,112,0.1)' },
};

const steps = [
  { key: 'awaiting_payment', label: 'Escrow Locked', icon: Lock },
  { key: 'payment_confirmed', label: 'Payment Sent', icon: CheckCircle },
  { key: 'released', label: 'Crypto Released', icon: ArrowRight },
] as const;

// ─── Page Component ────────────────────────────────────────────────────────

export default function TradePage() {
  const params = useParams();
  const router = useRouter();
  const orderId = params.orderId as string;
  const { connected, publicKey, setShowConnectModal } = useP01Wallet();

  // State
  const [phase, setPhase] = useState<TradePhase>('loading');
  const [order, setOrder] = useState<OrderData | null>(null);
  const [escrow, setEscrow] = useState<EscrowData | null>(null);
  const [escrowAddress, setEscrowAddress] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [countdown, setCountdown] = useState('--:--');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Fetch order data ──────────────────────────────────────────────────
  const fetchOrder = useCallback(async () => {
    try {
      const res = await fetch('/api/orders', { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const data = await res.json();
      const found = (data.orders || []).find((o: any) => o.address === orderId);
      if (found) {
        const mapped: OrderData = {
          address: found.address,
          maker: found.maker,
          token: found.token,
          cryptoAmount: found.cryptoAmount,
          fiatAmount: found.fiatAmount,
          fiatCurrency: found.fiatCurrency,
          paymentMethods: found.paymentMethods || [],
          status: found.status,
        };
        setOrder(mapped);
        return mapped;
      }
      return null;
    } catch {
      return null;
    }
  }, [orderId]);

  // ─── Fetch escrow status ──────────────────────────────────────────────
  const fetchEscrowStatus = useCallback(async (addr: string) => {
    try {
      const res = await fetch(`/api/trade/status?escrowAddress=${addr}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (res.status === 404) return null;
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.exists) return null;
      return data.escrow as EscrowData;
    } catch (err: any) {
      console.error('[trade] Escrow fetch error:', err.message);
      return null;
    }
  }, []);

  // ─── Initial load ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setPhase('loading');

      // 1. Try orderId as escrow address first
      const escrowData = await fetchEscrowStatus(orderId);
      if (cancelled) return;

      if (escrowData) {
        setEscrow(escrowData);
        setEscrowAddress(orderId);
        setPhase(escrowData.status as TradePhase);

        // Also fetch the order for additional info
        // Use the escrow's order field to match
        fetchOrder();
        return;
      }

      // 2. Try as order address — fetch order first
      const orderData = await fetchOrder();
      if (cancelled) return;

      if (orderData) {
        // The order exists; check if it has an escrow by scanning
        // Since we can't easily derive the escrow PDA client-side without
        // the taker pubkey, we try the user's wallet if connected
        if (publicKey) {
          // Try deriving: we know seeds are ["mugen_escrow", order, taker]
          // but we can't do findProgramAddressSync in browser easily
          // Instead, scan for 312-byte accounts with order at offset 8
          try {
            const scanRes = await fetch('/api/trade/status?escrowAddress=' + orderId);
            if (scanRes.ok) {
              const scanData = await scanRes.json();
              if (scanData.exists) {
                setEscrow(scanData.escrow);
                setEscrowAddress(orderId);
                setPhase(scanData.escrow.status as TradePhase);
                return;
              }
            }
          } catch { /* continue */ }
        }

        // Order exists but no escrow found yet
        setPhase('no_escrow');
        return;
      }

      // 3. Nothing found
      setPhase('error');
      setErrorMsg('Order or escrow not found on-chain. The address may be invalid or the account may have been closed.');
    }

    init();
    return () => { cancelled = true; };
  }, [orderId, publicKey, fetchOrder, fetchEscrowStatus]);

  // ─── Poll escrow status every 5 seconds ───────────────────────────────
  useEffect(() => {
    if (!escrowAddress) return;
    // Don't poll terminal states
    if (phase === 'released' || phase === 'refunded' || phase === 'expired') return;

    const poll = async () => {
      const data = await fetchEscrowStatus(escrowAddress);
      if (data) {
        setEscrow(data);
        const newPhase = data.status as TradePhase;
        if (newPhase !== phase) {
          setPhase(newPhase);
        }
      }
    };

    pollRef.current = setInterval(poll, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [escrowAddress, phase, fetchEscrowStatus]);

  // ─── Countdown timer ──────────────────────────────────────────────────
  useEffect(() => {
    if (!escrow?.expiresAt) {
      setCountdown('--:--');
      return;
    }

    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = escrow.expiresAt - now;
      setSecondsLeft(remaining);
      setCountdown(formatCountdown(remaining));
    };

    tick(); // immediate
    countdownRef.current = setInterval(tick, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [escrow?.expiresAt]);

  // ─── Determine user role ──────────────────────────────────────────────
  const isMaker = escrow && publicKey && escrow.maker === publicKey;
  const isTaker = escrow && publicKey && escrow.taker === publicKey;
  const isParticipant = isMaker || isTaker;

  // For a sell_crypto order: maker=seller, taker=buyer
  // The buyer confirms payment, the seller releases
  const isSeller = isMaker;
  const isBuyer = isTaker;

  // ─── Actions ──────────────────────────────────────────────────────────

  const handleConfirmPayment = useCallback(async () => {
    if (!escrowAddress || !publicKey) return;
    setActionLoading(true);
    setActionResult(null);

    try {
      const res = await fetch('/api/trade/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escrowAddress, buyerWallet: publicKey }),
      });

      const data = await res.json();
      if (!data.success) {
        setActionResult({ type: 'error', msg: data.error || 'Failed to build transaction' });
        return;
      }

      // Sign via P01 extension
      const p01 = (window as any).protocol01;
      if (p01?.signTransaction) {
        const { Transaction, Connection } = await import('@solana/web3.js');
        const txBytes = Buffer.from(data.transaction, 'base64');
        const tx = Transaction.from(txBytes);
        const signed = await p01.signTransaction(tx);

        const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, 'confirmed');

        setActionResult({ type: 'success', msg: `Payment confirmed! Tx: ${sig.slice(0, 20)}...` });
        // Refresh escrow status immediately
        const updated = await fetchEscrowStatus(escrowAddress);
        if (updated) {
          setEscrow(updated);
          setPhase(updated.status as TradePhase);
        }
      } else {
        setActionResult({ type: 'success', msg: 'Transaction built. Sign it in your P01 mobile app.' });
      }
    } catch (err: any) {
      setActionResult({ type: 'error', msg: err.message });
    } finally {
      setActionLoading(false);
    }
  }, [escrowAddress, publicKey, fetchEscrowStatus]);

  const handleReleaseEscrow = useCallback(async () => {
    if (!escrowAddress || !publicKey) return;
    setActionLoading(true);
    setActionResult(null);

    try {
      const res = await fetch('/api/trade/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escrowAddress, sellerWallet: publicKey }),
      });

      const data = await res.json();
      if (!data.success) {
        setActionResult({ type: 'error', msg: data.error || 'Failed to build transaction' });
        return;
      }

      // Sign via P01 extension
      const p01 = (window as any).protocol01;
      if (p01?.signTransaction) {
        const { Transaction, Connection } = await import('@solana/web3.js');
        const txBytes = Buffer.from(data.transaction, 'base64');
        const tx = Transaction.from(txBytes);
        const signed = await p01.signTransaction(tx);

        const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, 'confirmed');

        setActionResult({ type: 'success', msg: `Escrow released! Crypto sent to buyer. Tx: ${sig.slice(0, 20)}...` });
        const updated = await fetchEscrowStatus(escrowAddress);
        if (updated) {
          setEscrow(updated);
          setPhase(updated.status as TradePhase);
        }
      } else {
        setActionResult({ type: 'success', msg: 'Transaction built. Sign it in your P01 mobile app.' });
      }
    } catch (err: any) {
      setActionResult({ type: 'error', msg: err.message });
    } finally {
      setActionLoading(false);
    }
  }, [escrowAddress, publicKey, fetchEscrowStatus]);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  // ─── Progress step index ──────────────────────────────────────────────
  const stepIndex = escrow
    ? escrow.statusRaw >= 2 ? 2 : escrow.statusRaw >= 1 ? 1 : 0
    : 0;

  // ─── Render ───────────────────────────────────────────────────────────

  // Loading state
  if (phase === 'loading') {
    return (
      <>
        <MugenNavbar />
        <main style={{ position: 'relative', zIndex: 10, minHeight: '100vh', paddingTop: '5.5rem', paddingBottom: '3rem', paddingLeft: '1.5rem', paddingRight: '1.5rem', boxSizing: 'border-box' }}>
          <div style={{ maxWidth: '64rem', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
            <RefreshCw size={32} style={{ color: '#3b82f6', animation: 'spin 1s linear infinite' }} />
            <style dangerouslySetInnerHTML={{ __html: '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' }} />
            <p style={{ color: '#8888aa', fontSize: '0.85rem', marginTop: '1rem', fontFamily: "'JetBrains Mono',monospace" }}>
              Loading trade from chain...
            </p>
            <p style={{ color: '#555570', fontSize: '0.7rem', marginTop: '0.5rem', fontFamily: "'JetBrains Mono',monospace" }}>
              {shortAddr(orderId)}
            </p>
          </div>
        </main>
      </>
    );
  }

  // Error / not found
  if (phase === 'error' || phase === 'no_escrow') {
    return (
      <>
        <MugenNavbar />
        <main style={{ position: 'relative', zIndex: 10, minHeight: '100vh', paddingTop: '5.5rem', paddingBottom: '3rem', paddingLeft: '1.5rem', paddingRight: '1.5rem', boxSizing: 'border-box' }}>
          <div style={{ maxWidth: '64rem', margin: '0 auto', width: '100%' }}>
            <GlassCard style={{ padding: '3rem 2rem', textAlign: 'center', maxWidth: '32rem', margin: '4rem auto 0' }}>
              {phase === 'no_escrow' ? (
                <>
                  <Clock size={48} style={{ color: '#eab308', margin: '0 auto 1.5rem', opacity: 0.6 }} />
                  <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.2rem', fontWeight: 700, color: 'white', marginBottom: '0.75rem' }}>
                    No Active Escrow
                  </h2>
                  <p style={{ color: '#8888aa', fontSize: '0.85rem', lineHeight: 1.7, marginBottom: '0.5rem' }}>
                    This order exists but no escrow has been created yet.
                  </p>
                  <p style={{ color: '#555570', fontSize: '0.75rem', fontFamily: "'JetBrains Mono',monospace", marginBottom: '1.5rem' }}>
                    Someone needs to take this order on the Exchange page first.
                  </p>
                  <button
                    onClick={() => router.push('/exchange')}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                      padding: '0.7rem 1.5rem', background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                      border: 'none', borderRadius: '10px', color: 'white',
                      fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.75rem',
                      cursor: 'pointer', textTransform: 'uppercase',
                    }}
                  >
                    Go to Exchange <ArrowRight size={14} />
                  </button>
                </>
              ) : (
                <>
                  <XCircle size={48} style={{ color: '#ef4444', margin: '0 auto 1.5rem', opacity: 0.6 }} />
                  <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.2rem', fontWeight: 700, color: 'white', marginBottom: '0.75rem' }}>
                    Trade Not Found
                  </h2>
                  <p style={{ color: '#8888aa', fontSize: '0.85rem', lineHeight: 1.7, marginBottom: '0.5rem' }}>
                    {errorMsg || 'Could not find an order or escrow at this address.'}
                  </p>
                  <p style={{ color: '#555570', fontSize: '0.7rem', fontFamily: "'JetBrains Mono',monospace", wordBreak: 'break-all', marginBottom: '1.5rem' }}>
                    {orderId}
                  </p>
                  <button
                    onClick={() => router.push('/exchange')}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                      padding: '0.7rem 1.5rem', background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                      border: 'none', borderRadius: '10px', color: 'white',
                      fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.75rem',
                      cursor: 'pointer', textTransform: 'uppercase',
                    }}
                  >
                    Go to Exchange <ArrowRight size={14} />
                  </button>
                </>
              )}
            </GlassCard>
          </div>
        </main>
      </>
    );
  }

  // ─── Active trade view ────────────────────────────────────────────────

  const phaseConfig = PHASE_CONFIG[phase] || PHASE_CONFIG.awaiting_payment;
  const isTerminal = phase === 'released' || phase === 'refunded' || phase === 'expired';

  return (
    <>
      <MugenNavbar />
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
        @keyframes pulse-glow { 0%, 100% { box-shadow: 0 0 20px rgba(59,130,246,0.2); } 50% { box-shadow: 0 0 40px rgba(59,130,246,0.4); } }
        @keyframes countdown-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
        @media (max-width: 768px) { .trade-grid { grid-template-columns: 1fr !important; } }
      `}} />
      <main style={{ position: 'relative', zIndex: 10, minHeight: '100vh', paddingTop: '5.5rem', paddingBottom: '3rem', paddingLeft: '1.5rem', paddingRight: '1.5rem', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '64rem', margin: '0 auto', width: '100%' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '2rem' }}>
            <div>
              <h1 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.8rem', fontWeight: 800, color: 'white', margin: 0 }}>
                Active Trade
              </h1>
              <p style={{ color: '#8888aa', fontSize: '0.8rem', fontFamily: "'JetBrains Mono',monospace", marginTop: '0.3rem' }}>
                {escrow ? `${escrow.token} escrow` : 'Loading...'}
                {isParticipant && (
                  <span style={{ color: '#3b82f6', marginLeft: '0.5rem' }}>
                    (you are the {isSeller ? 'seller' : 'buyer'})
                  </span>
                )}
              </p>
            </div>

            {/* Status badge */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.5rem 1rem', borderRadius: '10px',
              background: phaseConfig.bg,
              border: `1px solid ${phaseConfig.color}30`,
            }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: phaseConfig.color, animation: isTerminal ? 'none' : 'countdown-pulse 2s infinite' }} />
              <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.7rem', fontWeight: 700, color: phaseConfig.color, textTransform: 'uppercase' }}>
                {phaseConfig.label}
              </span>
            </div>
          </div>

          <div className="trade-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '1.5rem', alignItems: 'start' }}>
            {/* ═══ Left Column ═══ */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

              {/* Trade Details Card */}
              <GlassCard style={{ padding: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
                  <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.85rem', fontWeight: 700, color: 'white', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Trade Details
                  </h3>
                  {/* Countdown */}
                  {!isTerminal && escrow && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '0.4rem',
                      padding: '0.35rem 0.8rem', borderRadius: '8px',
                      background: secondsLeft < 300 ? 'rgba(239,68,68,0.1)' : 'rgba(59,130,246,0.08)',
                      border: `1px solid ${secondsLeft < 300 ? 'rgba(239,68,68,0.25)' : 'rgba(59,130,246,0.15)'}`,
                    }}>
                      <Clock size={12} style={{ color: secondsLeft < 300 ? '#ef4444' : '#60a5fa' }} />
                      <span style={{
                        fontFamily: "'JetBrains Mono',monospace", fontSize: '0.75rem', fontWeight: 600,
                        color: secondsLeft < 300 ? '#ef4444' : '#60a5fa',
                        animation: secondsLeft < 60 ? 'countdown-pulse 1s infinite' : 'none',
                      }}>
                        {countdown}
                      </span>
                    </div>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.2rem' }}>
                  <div>
                    <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Crypto Amount
                    </span>
                    <p style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.3rem', fontWeight: 800, color: '#60a5fa', marginTop: '0.3rem' }}>
                      {escrow?.cryptoAmount ?? '...'} {escrow?.token ?? ''}
                    </p>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Fiat Amount
                    </span>
                    <p style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.3rem', fontWeight: 800, color: 'white', marginTop: '0.3rem' }}>
                      ${escrow?.fiatAmount?.toFixed(2) ?? '...'}
                    </p>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Payment Method
                    </span>
                    <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.85rem', color: '#8b5cf6', marginTop: '0.3rem', textTransform: 'capitalize' }}>
                      {escrow?.paymentMethod ?? '...'}
                    </p>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Rate
                    </span>
                    <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.85rem', color: '#8888aa', marginTop: '0.3rem' }}>
                      {escrow ? `$${(escrow.fiatAmount / escrow.cryptoAmount).toFixed(2)} / ${escrow.token}` : '...'}
                    </p>
                  </div>
                </div>

                {/* Parties */}
                <div style={{ marginTop: '1.5rem', paddingTop: '1.2rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div>
                      <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                        Seller (Maker)
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.3rem' }}>
                        <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.8rem', color: isMaker ? '#22c55e' : '#8888aa', margin: 0 }}>
                          {escrow ? shortAddr(escrow.maker) : '...'}
                        </p>
                        {isMaker && (
                          <span style={{ fontSize: '0.55rem', color: '#22c55e', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', fontFamily: "'JetBrains Mono',monospace" }}>
                            YOU
                          </span>
                        )}
                        {escrow && (
                          <button onClick={() => copyToClipboard(escrow.maker)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
                            <Copy size={10} style={{ color: '#555570' }} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                        Buyer (Taker)
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.3rem' }}>
                        <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.8rem', color: isTaker ? '#22c55e' : '#8888aa', margin: 0 }}>
                          {escrow ? shortAddr(escrow.taker) : '...'}
                        </p>
                        {isTaker && (
                          <span style={{ fontSize: '0.55rem', color: '#22c55e', padding: '0.1rem 0.4rem', borderRadius: '4px', background: 'rgba(34,197,94,0.1)', fontFamily: "'JetBrains Mono',monospace" }}>
                            YOU
                          </span>
                        )}
                        {escrow && (
                          <button onClick={() => copyToClipboard(escrow.taker)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
                            <Copy size={10} style={{ color: '#555570' }} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </GlassCard>

              {/* Escrow Progress */}
              <GlassCard style={{ padding: '1.5rem' }}>
                <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem', fontWeight: 700, color: '#8888aa', margin: '0 0 1.5rem 0', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  Escrow Progress
                </h3>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative' }}>
                  {/* Progress line */}
                  <div style={{
                    position: 'absolute', top: '20px', left: '40px', right: '40px', height: '2px',
                    background: 'rgba(255,255,255,0.06)',
                  }}>
                    <div style={{
                      height: '100%',
                      background: 'linear-gradient(90deg, #3b82f6, #7c3aed)',
                      transition: 'width 0.6s ease',
                      width: `${(stepIndex / (steps.length - 1)) * 100}%`,
                      borderRadius: '2px',
                    }} />
                  </div>

                  {steps.map((step, i) => {
                    const isComplete = i <= stepIndex;
                    const isCurrent = i === stepIndex;
                    const StepIcon = step.icon;
                    return (
                      <div key={step.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', zIndex: 1 }}>
                        <div style={{
                          width: '40px', height: '40px', borderRadius: '50%',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          border: `2px solid ${isComplete ? '#3b82f6' : 'rgba(255,255,255,0.1)'}`,
                          background: isComplete ? 'linear-gradient(135deg, #3b82f6, #7c3aed)' : 'rgba(10,10,26,0.8)',
                          transition: 'all 0.3s ease',
                          animation: isCurrent && !isTerminal ? 'pulse-glow 2s infinite' : 'none',
                        }}>
                          <StepIcon size={16} style={{ color: isComplete ? 'white' : '#555570' }} />
                        </div>
                        <span style={{
                          fontFamily: "'JetBrains Mono',monospace", fontSize: '0.6rem', marginTop: '0.5rem',
                          color: isComplete ? '#60a5fa' : '#555570',
                          textTransform: 'uppercase', letterSpacing: '0.05em',
                        }}>
                          {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Disputed / Refunded / Expired overlay */}
                {(phase === 'disputed' || phase === 'refunded' || phase === 'expired') && (
                  <div style={{
                    marginTop: '1.2rem', padding: '0.8rem 1rem', borderRadius: '10px',
                    background: phaseConfig.bg, border: `1px solid ${phaseConfig.color}30`,
                    display: 'flex', alignItems: 'center', gap: '0.6rem',
                  }}>
                    <AlertTriangle size={16} style={{ color: phaseConfig.color }} />
                    <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.8rem', color: phaseConfig.color }}>
                      {phase === 'disputed' && 'This trade is under dispute. An arbitrator will review the evidence.'}
                      {phase === 'refunded' && 'This escrow has been refunded to the seller.'}
                      {phase === 'expired' && 'This escrow has expired. Funds can be reclaimed by the seller.'}
                    </span>
                  </div>
                )}
              </GlassCard>

              {/* Actions Card */}
              {!isTerminal && (
                <GlassCard style={{ padding: '1.5rem' }}>
                  <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem', fontWeight: 700, color: '#8888aa', margin: '0 0 1rem 0', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    Actions
                  </h3>

                  {!connected && (
                    <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                      <p style={{ color: '#8888aa', fontSize: '0.8rem', marginBottom: '1rem', fontFamily: "'JetBrains Mono',monospace" }}>
                        Connect your wallet to interact with this trade.
                      </p>
                      <button
                        onClick={() => setShowConnectModal(true)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                          padding: '0.7rem 1.5rem', background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                          border: 'none', borderRadius: '10px', color: 'white',
                          fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.75rem',
                          cursor: 'pointer', textTransform: 'uppercase',
                        }}
                      >
                        Connect P01 Wallet
                      </button>
                    </div>
                  )}

                  {connected && !isParticipant && (
                    <div style={{
                      padding: '1rem', borderRadius: '10px',
                      background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)',
                    }}>
                      <p style={{ color: '#8888aa', fontSize: '0.8rem', fontFamily: "'JetBrains Mono',monospace", margin: 0 }}>
                        You are not a participant in this trade. Only the maker and taker can perform actions.
                      </p>
                    </div>
                  )}

                  {connected && isParticipant && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {/* Buyer: Confirm Payment (only in awaiting_payment) */}
                      {isBuyer && phase === 'awaiting_payment' && (
                        <button
                          onClick={handleConfirmPayment}
                          disabled={actionLoading}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                            width: '100%', padding: '0.8rem 1.5rem',
                            background: actionLoading ? 'rgba(59,130,246,0.3)' : 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                            border: 'none', borderRadius: '10px', color: 'white',
                            fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.75rem',
                            cursor: actionLoading ? 'wait' : 'pointer', textTransform: 'uppercase',
                            boxShadow: '0 4px 20px rgba(59,130,246,0.25)',
                          }}
                        >
                          {actionLoading ? (
                            <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Processing...</>
                          ) : (
                            <><CheckCircle size={14} /> I Have Sent Fiat Payment</>
                          )}
                        </button>
                      )}

                      {/* Buyer: Waiting for release */}
                      {isBuyer && phase === 'payment_confirmed' && (
                        <div style={{
                          padding: '1rem', borderRadius: '10px',
                          background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)',
                          display: 'flex', alignItems: 'center', gap: '0.6rem',
                        }}>
                          <RefreshCw size={14} style={{ color: '#60a5fa', animation: 'spin 2s linear infinite' }} />
                          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.8rem', color: '#60a5fa' }}>
                            Waiting for seller to release crypto...
                          </span>
                        </div>
                      )}

                      {/* Seller: Waiting for buyer payment confirmation */}
                      {isSeller && phase === 'awaiting_payment' && (
                        <div style={{
                          padding: '1rem', borderRadius: '10px',
                          background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.15)',
                          display: 'flex', alignItems: 'center', gap: '0.6rem',
                        }}>
                          <Clock size={14} style={{ color: '#eab308' }} />
                          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.8rem', color: '#eab308' }}>
                            Waiting for buyer to send fiat and confirm payment...
                          </span>
                        </div>
                      )}

                      {/* Seller: Release Escrow (only in payment_confirmed) */}
                      {isSeller && phase === 'payment_confirmed' && (
                        <button
                          onClick={handleReleaseEscrow}
                          disabled={actionLoading}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                            width: '100%', padding: '0.8rem 1.5rem',
                            background: actionLoading ? 'rgba(34,197,94,0.3)' : 'linear-gradient(135deg, #22c55e, #16a34a)',
                            border: 'none', borderRadius: '10px', color: 'white',
                            fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.75rem',
                            cursor: actionLoading ? 'wait' : 'pointer', textTransform: 'uppercase',
                            boxShadow: '0 4px 20px rgba(34,197,94,0.25)',
                          }}
                        >
                          {actionLoading ? (
                            <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Releasing...</>
                          ) : (
                            <><ArrowRight size={14} /> Release Crypto to Buyer</>
                          )}
                        </button>
                      )}

                      {/* Dispute button (available for both parties, non-terminal) */}
                      {phase !== 'disputed' && (
                        <button
                          disabled={actionLoading}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
                            width: '100%', padding: '0.7rem 1.5rem',
                            background: 'transparent',
                            border: '1px solid rgba(239,68,68,0.3)',
                            borderRadius: '10px', color: '#ef4444',
                            fontFamily: "'Orbitron',sans-serif", fontWeight: 600, fontSize: '0.7rem',
                            cursor: 'pointer', textTransform: 'uppercase',
                            transition: 'all 0.2s ease',
                          }}
                          onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'rgba(239,68,68,0.08)'; }}
                          onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
                        >
                          <AlertTriangle size={14} />
                          Open Dispute
                        </button>
                      )}
                    </div>
                  )}

                  {/* Action result */}
                  {actionResult && (
                    <div style={{
                      marginTop: '0.75rem', padding: '0.8rem 1rem', borderRadius: '10px',
                      background: actionResult.type === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                      border: `1px solid ${actionResult.type === 'success' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                    }}>
                      <p style={{
                        fontFamily: "'JetBrains Mono',monospace", fontSize: '0.75rem', margin: 0,
                        color: actionResult.type === 'success' ? '#22c55e' : '#ef4444',
                        wordBreak: 'break-all',
                      }}>
                        {actionResult.msg}
                      </p>
                    </div>
                  )}
                </GlassCard>
              )}

              {/* Completed state */}
              {phase === 'released' && (
                <GlassCard style={{ padding: '1.5rem', borderColor: 'rgba(34,197,94,0.15)' }}>
                  <div style={{ textAlign: 'center' }}>
                    <CheckCircle size={40} style={{ color: '#22c55e', margin: '0 auto 1rem' }} />
                    <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem', fontWeight: 700, color: '#22c55e', marginBottom: '0.5rem' }}>
                      Trade Complete
                    </h3>
                    <p style={{ color: '#8888aa', fontSize: '0.8rem', fontFamily: "'JetBrains Mono',monospace" }}>
                      {escrow?.cryptoAmount} {escrow?.token} has been released to the buyer.
                    </p>
                  </div>
                </GlassCard>
              )}
            </div>

            {/* ═══ Right Column — Escrow Info ═══ */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

              {/* On-chain info */}
              <GlassCard style={{ padding: '1.2rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '1rem' }}>
                  <Shield size={14} style={{ color: '#3b82f6' }} />
                  <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.7rem', fontWeight: 700, color: 'white', textTransform: 'uppercase' }}>
                    Escrow Info
                  </span>
                  <span style={{
                    marginLeft: 'auto', fontSize: '0.55rem', color: '#22c55e',
                    padding: '0.15rem 0.5rem', borderRadius: '4px',
                    background: 'rgba(34,197,94,0.1)', fontFamily: "'JetBrains Mono',monospace",
                  }}>
                    ON-CHAIN
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                  {/* Escrow address */}
                  <div>
                    <span style={{ fontSize: '0.55rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Escrow Account
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.2rem' }}>
                      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem', color: '#8888aa' }}>
                        {escrowAddress ? shortAddr(escrowAddress) : '...'}
                      </span>
                      {escrowAddress && (
                        <>
                          <button onClick={() => copyToClipboard(escrowAddress)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}>
                            <Copy size={10} style={{ color: copied ? '#22c55e' : '#555570' }} />
                          </button>
                          <a
                            href={`https://explorer.solana.com/address/${escrowAddress}?cluster=devnet`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ padding: '2px' }}
                          >
                            <ExternalLink size={10} style={{ color: '#555570' }} />
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Order address */}
                  <div>
                    <span style={{ fontSize: '0.55rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Order Account
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.2rem' }}>
                      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem', color: '#8888aa' }}>
                        {escrow ? shortAddr(escrow.order) : '...'}
                      </span>
                      {escrow && (
                        <a
                          href={`https://explorer.solana.com/address/${escrow.order}?cluster=devnet`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ padding: '2px' }}
                        >
                          <ExternalLink size={10} style={{ color: '#555570' }} />
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Vault */}
                  <div>
                    <span style={{ fontSize: '0.55rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Escrow Vault
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.2rem' }}>
                      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem', color: '#8888aa' }}>
                        {escrow ? shortAddr(escrow.escrowVault) : '...'}
                      </span>
                      {escrow && (
                        <a
                          href={`https://explorer.solana.com/address/${escrow.escrowVault}?cluster=devnet`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ padding: '2px' }}
                        >
                          <ExternalLink size={10} style={{ color: '#555570' }} />
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Token mint */}
                  <div>
                    <span style={{ fontSize: '0.55rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Token
                    </span>
                    <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem', color: '#8b5cf6', marginTop: '0.2rem' }}>
                      {escrow?.token ?? '...'} ({escrow ? shortAddr(escrow.tokenMint) : '...'})
                    </p>
                  </div>

                  {/* Timestamps */}
                  <div style={{ paddingTop: '0.6rem', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <span style={{ fontSize: '0.55rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Created
                    </span>
                    <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.65rem', color: '#8888aa', marginTop: '0.15rem' }}>
                      {escrow ? new Date(escrow.createdAt * 1000).toLocaleString() : '...'}
                    </p>
                  </div>
                  <div>
                    <span style={{ fontSize: '0.55rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                      Expires
                    </span>
                    <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.65rem', color: secondsLeft < 300 ? '#ef4444' : '#8888aa', marginTop: '0.15rem' }}>
                      {escrow ? new Date(escrow.expiresAt * 1000).toLocaleString() : '...'}
                    </p>
                  </div>
                  {escrow?.paymentConfirmedAt !== undefined && escrow.paymentConfirmedAt > 0 && (
                    <div>
                      <span style={{ fontSize: '0.55rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                        Payment Confirmed
                      </span>
                      <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.65rem', color: '#22c55e', marginTop: '0.15rem' }}>
                        {new Date(escrow.paymentConfirmedAt * 1000).toLocaleString()}
                      </p>
                    </div>
                  )}
                </div>
              </GlassCard>

              {/* Trade instructions */}
              <GlassCard style={{ padding: '1.2rem' }}>
                <h4 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.65rem', fontWeight: 700, color: '#8888aa', margin: '0 0 0.8rem 0', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  How It Works
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  {[
                    { num: '1', text: 'Seller\'s crypto is locked in on-chain escrow', active: phase === 'awaiting_payment' },
                    { num: '2', text: 'Buyer sends fiat via the chosen payment method', active: phase === 'awaiting_payment' },
                    { num: '3', text: 'Buyer confirms payment on-chain', active: phase === 'awaiting_payment' },
                    { num: '4', text: 'Seller verifies fiat received and releases crypto', active: phase === 'payment_confirmed' },
                  ].map(step => (
                    <div key={step.num} style={{
                      display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
                      opacity: step.active ? 1 : 0.5,
                    }}>
                      <span style={{
                        fontFamily: "'Orbitron',sans-serif", fontSize: '0.6rem', fontWeight: 700,
                        color: step.active ? '#3b82f6' : '#555570',
                        width: '18px', height: '18px', borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: step.active ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${step.active ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.06)'}`,
                        flexShrink: 0,
                      }}>
                        {step.num}
                      </span>
                      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.65rem', color: step.active ? '#8888aa' : '#555570', lineHeight: 1.5 }}>
                        {step.text}
                      </span>
                    </div>
                  ))}
                </div>
              </GlassCard>

              {/* Security note */}
              <GlassCard style={{ padding: '0.8rem 1rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <Lock size={12} style={{ color: '#22c55e', marginTop: '2px', flexShrink: 0 }} />
                  <p style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.6rem', color: '#555570', lineHeight: 1.6, margin: 0 }}>
                    Crypto is held in a non-custodial on-chain escrow. Neither party can withdraw without the proper state transition. Disputes are handled by arbitration.
                  </p>
                </div>
              </GlassCard>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
