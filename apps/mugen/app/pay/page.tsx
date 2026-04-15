'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowRight, Shield, Lock, CheckCircle, Loader2, CreditCard,
  Building2, Smartphone, ChevronDown, Infinity, Copy, Check,
  ArrowLeft, Clock, AlertCircle, Zap, RefreshCw,
} from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import PrivacyPreview from '@/components/PrivacyPreview';
import { useP01Wallet } from '@/components/WalletProvider';

// ─── Types ──────────────────────────────────────────────────────────────────

type Step = 'amount' | 'method' | 'paying' | 'confirming' | 'complete';
type PaymentMethod = 'card' | 'iban' | 'revolut' | 'wise' | 'sepa';
type Token = 'SOL' | 'USDC' | 'USDT';

interface PriceData {
  SOL: { usd: number; eur: number };
  USDC: { usd: number; eur: number };
  USDT: { usd: number; eur: number };
}

interface MatchedOrder {
  address: string;
  maker: string;
  cryptoAmount: number;
  fiatAmount: number;
  fiatCurrency: string;
  paymentMethods: string[];
  token: string;
}

const PAYMENT_METHODS: { id: PaymentMethod; name: string; icon: typeof CreditCard; fee: string; time: string; color: string }[] = [
  { id: 'card', name: 'Credit / Debit Card', icon: CreditCard, fee: '2.9%', time: 'Instant', color: '#3b82f6' },
  { id: 'iban', name: 'Bank Transfer (IBAN)', icon: Building2, fee: '0.5%', time: '1-2 days', color: '#8b5cf6' },
  { id: 'revolut', name: 'Revolut', icon: Smartphone, fee: '0%', time: 'Instant', color: '#7c3aed' },
  { id: 'wise', name: 'Wise', icon: Zap, fee: '0.5%', time: '1-2 hours', color: '#22c55e' },
  { id: 'sepa', name: 'SEPA Transfer', icon: Building2, fee: '0.5%', time: '1 day', color: '#60a5fa' },
];

import { calculateCryptoAmount, formatFeeDisplay, VISIBLE_FEE_BPS, SPREAD_BPS } from '@/lib/fees';

function GlassCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      position: 'relative',
      background: 'rgba(255,255,255,0.03)',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '20px', overflow: 'hidden',
      boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      ...style,
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)' }} />
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAY PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function PayPage() {
  const { connected, publicKey, setShowConnectModal } = useP01Wallet();

  const [step, setStep] = useState<Step>('amount');
  const [token, setToken] = useState<Token>('SOL');
  const [fiatAmount, setFiatAmount] = useState('100');
  const [currency, setCurrency] = useState<'USD' | 'EUR'>('USD');
  const [method, setMethod] = useState<PaymentMethod>('card');
  const [prices, setPrices] = useState<PriceData | null>(null);
  const [matchedOrder, setMatchedOrder] = useState<MatchedOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [escrowAddress, setEscrowAddress] = useState<string | null>(null);
  const [showTokenDropdown, setShowTokenDropdown] = useState(false);
  const [confirmCountdown, setConfirmCountdown] = useState(0);

  // Fetch prices
  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const res = await fetch('/api/prices');
        if (res.ok) setPrices(await res.json());
      } catch {}
    };
    fetchPrices();
    const interval = setInterval(fetchPrices, 30000);
    return () => clearInterval(interval);
  }, []);

  // Countdown for confirming step
  useEffect(() => {
    if (step !== 'paying' || confirmCountdown <= 0) return;
    const interval = setInterval(() => {
      setConfirmCountdown(c => c > 0 ? c - 1 : 0);
    }, 1000);
    return () => clearInterval(interval);
  }, [step, confirmCountdown]);

  const fiatNum = parseFloat(fiatAmount) || 0;
  const marketPrice = prices?.[token]?.usd || (token === 'SOL' ? 148 : 1);
  const calc = calculateCryptoAmount(fiatNum, marketPrice, method);
  const cryptoAmount = calc.cryptoAmount;
  const visibleFee = calc.visibleFee;
  const effectiveRate = calc.effectiveRate;
  const methodInfo = PAYMENT_METHODS.find(m => m.id === method)!;

  // Auto-match best order
  const findBestOrder = useCallback(async () => {
    try {
      const res = await fetch('/api/orders');
      if (!res.ok) return null;
      const data = await res.json();
      const orders = (data.orders || []).filter((o: any) =>
        o.orderType === 'sell_crypto' &&
        o.token === token &&
        o.status === 'open' &&
        o.cryptoAmount >= cryptoAmount
      );
      if (orders.length === 0) return null;
      // Pick cheapest rate
      orders.sort((a: any, b: any) => (a.fiatAmount / a.cryptoAmount) - (b.fiatAmount / b.cryptoAmount));
      return orders[0] as MatchedOrder;
    } catch {
      return null;
    }
  }, [token, cryptoAmount]);

  const handleContinue = async () => {
    if (!connected) { setShowConnectModal(true); return; }
    if (step === 'amount') {
      if (fiatNum < 5) return;
      setStep('method');
    } else if (step === 'method') {
      setLoading(true);
      const order = await findBestOrder();
      setMatchedOrder(order);
      if (order) {
        setStep('paying');
        setConfirmCountdown(3600); // 1 hour
      } else {
        alert('No sellers available for this amount right now. Try a different token or amount.');
      }
      setLoading(false);
    }
  };

  const handleConfirmPayment = async () => {
    if (!publicKey || !matchedOrder) return;
    setStep('confirming');
    setLoading(true);

    try {
      // 1. Take the order (lock crypto in escrow)
      const takeRes = await fetch('/api/trade/take', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderAddress: matchedOrder.address,
          takerWallet: publicKey,
          tokenMint: 'So11111111111111111111111111111111111111112',
          sellerTokenAccount: publicKey,
          paymentMethod: method === 'card' ? 1 : method === 'iban' ? 1 : method === 'revolut' ? 2 : method === 'wise' ? 4 : 16,
        }),
      });
      const takeData = await takeRes.json();

      if (takeData.success) {
        setEscrowAddress(takeData.escrowAddress);

        // 2. Sign via P01 extension if available
        const p01 = (window as any).protocol01;
        if (p01?.signTransaction) {
          const { Transaction, Connection } = await import('@solana/web3.js');
          const tx = Transaction.from(Buffer.from(takeData.transaction, 'base64'));
          const signed = await p01.signTransaction(tx);
          const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
          const sig = await connection.sendRawTransaction(signed.serialize());
          await connection.confirmTransaction(sig, 'confirmed');
          setTxSig(sig);
        }

        // 3. Confirm payment
        if (takeData.escrowAddress) {
          await fetch('/api/trade/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              escrowAddress: takeData.escrowAddress,
              buyerWallet: publicKey,
            }),
          });
        }
      }

      setStep('complete');
    } catch (err: any) {
      console.error('[pay] Error:', err);
      alert(`Payment error: ${err.message}`);
      setStep('paying');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const mins = Math.floor(confirmCountdown / 60);
  const secs = confirmCountdown % 60;

  return (
    <>
      <MugenNavbar />
      <main style={{ position: 'relative', zIndex: 10, minHeight: '100vh', paddingTop: '5rem', paddingBottom: '3rem', paddingLeft: '1rem', paddingRight: '1rem', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '28rem', margin: '0 auto', width: '100%' }}>

          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <img src="/mugen-icon.png" alt="" style={{ width: '1.8rem', height: '1.8rem', objectFit: 'contain' }} />
              <h1 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.3rem', fontWeight: 800, color: 'white', margin: 0 }}>
                Buy Crypto
              </h1>
            </div>
            <p style={{ color: '#8888aa', fontSize: '0.75rem', fontFamily: "'JetBrains Mono',monospace" }}>
              No KYC required — ZK compliance only
            </p>
          </div>

          {/* Progress steps */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '2rem' }}>
            {['Amount', 'Payment', 'Pay', 'Done'].map((label, i) => {
              const stepIndex = ['amount', 'method', 'paying', 'complete'].indexOf(step);
              const isActive = i <= stepIndex || (step === 'confirming' && i <= 2);
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{
                    width: '1.5rem', height: '1.5rem', borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.6rem', fontFamily: "'Orbitron',sans-serif", fontWeight: 700,
                    background: isActive ? 'linear-gradient(135deg, #3b82f6, #7c3aed)' : 'rgba(255,255,255,0.05)',
                    color: isActive ? 'white' : '#555570',
                    border: `1px solid ${isActive ? 'transparent' : 'rgba(255,255,255,0.06)'}`,
                    transition: 'all 0.3s',
                  }}>
                    {i < stepIndex || step === 'complete' ? <Check size={10} /> : i + 1}
                  </div>
                  {i < 3 && <div style={{ width: '2rem', height: '1px', background: isActive ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.05)' }} />}
                </div>
              );
            })}
          </div>

          {/* ═══ STEP 1: Amount ═══ */}
          {step === 'amount' && (
            <GlassCard style={{ padding: '2rem' }}>
              {/* You pay */}
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.15em', display: 'block', marginBottom: '0.5rem' }}>
                  You pay
                </label>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '14px', padding: '0.8rem 1rem',
                }}>
                  <span style={{ fontSize: '1.5rem', color: '#8888aa' }}>{currency === 'USD' ? '$' : '€'}</span>
                  <input
                    type="number"
                    value={fiatAmount}
                    onChange={e => setFiatAmount(e.target.value)}
                    placeholder="0.00"
                    style={{
                      flex: 1, background: 'transparent', border: 'none', outline: 'none',
                      color: 'white', fontSize: '1.8rem', fontFamily: "'Orbitron',sans-serif", fontWeight: 700,
                      width: '100%',
                    }}
                  />
                  <button
                    onClick={() => setCurrency(c => c === 'USD' ? 'EUR' : 'USD')}
                    style={{
                      padding: '0.3rem 0.6rem', borderRadius: '8px',
                      background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                      color: '#3b82f6', fontSize: '0.75rem', fontFamily: "'JetBrains Mono',monospace",
                      cursor: 'pointer', fontWeight: 600,
                    }}
                  >
                    {currency}
                  </button>
                </div>

                {/* Quick amounts */}
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                  {[50, 100, 250, 500, 1000].map(v => (
                    <button key={v} onClick={() => setFiatAmount(v.toString())} style={{
                      flex: 1, padding: '0.4rem', borderRadius: '8px', cursor: 'pointer',
                      background: fiatAmount === v.toString() ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${fiatAmount === v.toString() ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.05)'}`,
                      color: fiatAmount === v.toString() ? '#3b82f6' : '#555570',
                      fontSize: '0.7rem', fontFamily: "'JetBrains Mono',monospace",
                      transition: 'all 0.2s',
                    }}>
                      {currency === 'USD' ? '$' : '€'}{v}
                    </button>
                  ))}
                </div>
              </div>

              {/* Divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.05)' }} />
                <div style={{
                  width: '2rem', height: '2rem', borderRadius: '50%',
                  background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <ArrowRight size={12} style={{ color: '#3b82f6', transform: 'rotate(90deg)' }} />
                </div>
                <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.05)' }} />
              </div>

              {/* You receive */}
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.15em', display: 'block', marginBottom: '0.5rem' }}>
                  You receive
                </label>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '14px', padding: '0.8rem 1rem',
                }}>
                  <span style={{ fontSize: '1.8rem', fontFamily: "'Orbitron',sans-serif", fontWeight: 700, color: '#60a5fa' }}>
                    {cryptoAmount > 0 ? cryptoAmount.toFixed(token === 'SOL' ? 4 : 2) : '0.00'}
                  </span>

                  {/* Token selector */}
                  <div style={{ position: 'relative' }}>
                    <button
                      onClick={() => setShowTokenDropdown(!showTokenDropdown)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '0.4rem',
                        padding: '0.4rem 0.7rem', borderRadius: '10px',
                        background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)',
                        color: 'white', fontSize: '0.85rem', fontFamily: "'Orbitron',sans-serif", fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {token}
                      <ChevronDown size={14} style={{ color: '#3b82f6' }} />
                    </button>
                    {showTokenDropdown && (
                      <div style={{
                        position: 'absolute', top: '110%', right: 0, zIndex: 20,
                        background: '#0a0a1a', border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '12px', overflow: 'hidden', minWidth: '100px',
                      }}>
                        {(['SOL', 'USDC', 'USDT'] as Token[]).map(t => (
                          <button key={t} onClick={() => { setToken(t); setShowTokenDropdown(false); }} style={{
                            display: 'block', width: '100%', padding: '0.6rem 1rem',
                            background: t === token ? 'rgba(59,130,246,0.1)' : 'transparent',
                            border: 'none', color: t === token ? '#3b82f6' : '#8888aa',
                            fontSize: '0.8rem', fontFamily: "'Orbitron',sans-serif", fontWeight: 600,
                            cursor: 'pointer', textAlign: 'left',
                          }}>
                            {t}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Price info */}
              <div style={{ fontSize: '0.7rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                  <span>Rate</span>
                  <span style={{ color: '#8888aa' }}>1 {token} = ${effectiveRate.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                  <span>Fee ({formatFeeDisplay(method)})</span>
                  <span style={{ color: '#8888aa' }}>${visibleFee.toFixed(2)} {currency}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '0.3rem' }}>
                  <span style={{ color: '#60a5fa' }}>You receive</span>
                  <span style={{ color: '#60a5fa', fontWeight: 600 }}>{cryptoAmount.toFixed(token === 'SOL' ? 6 : 2)} {token}</span>
                </div>
              </div>

              {/* Privacy preview (Layer 1 denomination splitter) */}
              <PrivacyPreview fiatAmount={fiatNum} fiatCurrency={currency} token={token} />

              {/* Continue */}
              <button onClick={handleContinue} disabled={fiatNum < 5} style={{
                width: '100%', padding: '0.9rem', borderRadius: '14px', border: 'none',
                background: fiatNum >= 5 ? 'linear-gradient(135deg, #3b82f6, #7c3aed)' : 'rgba(255,255,255,0.05)',
                color: fiatNum >= 5 ? 'white' : '#555570',
                fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.85rem',
                cursor: fiatNum >= 5 ? 'pointer' : 'not-allowed', textTransform: 'uppercase',
                boxShadow: fiatNum >= 5 ? '0 4px 20px rgba(59,130,246,0.3)' : 'none',
                transition: 'all 0.3s',
              }}>
                {connected ? 'Continue' : 'Connect Wallet'}
              </button>

              {/* Trust badges */}
              <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '1rem' }}>
                {[
                  { icon: Shield, label: 'No KYC' },
                  { icon: Lock, label: 'Escrow' },
                  { icon: Zap, label: 'ZK Proof' },
                ].map(b => (
                  <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <b.icon size={10} style={{ color: '#3b82f6' }} />
                    <span style={{ fontSize: '0.55rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase' }}>{b.label}</span>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {/* ═══ STEP 2: Payment Method ═══ */}
          {step === 'method' && (
            <GlassCard style={{ padding: '2rem' }}>
              <button onClick={() => setStep('amount')} style={{ background: 'none', border: 'none', color: '#8888aa', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '1rem', fontSize: '0.75rem' }}>
                <ArrowLeft size={14} /> Back
              </button>

              <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem', fontWeight: 700, color: 'white', marginBottom: '0.3rem' }}>
                Payment Method
              </h2>
              <p style={{ color: '#555570', fontSize: '0.7rem', fontFamily: "'JetBrains Mono',monospace", marginBottom: '1.5rem' }}>
                Buy {cryptoAmount.toFixed(4)} {token} for {currency === 'USD' ? '$' : '€'}{fiatNum.toFixed(2)}
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '1.5rem' }}>
                {PAYMENT_METHODS.map(m => (
                  <button key={m.id} onClick={() => setMethod(m.id)} style={{
                    display: 'flex', alignItems: 'center', gap: '0.8rem',
                    padding: '0.9rem 1rem', borderRadius: '14px',
                    background: method === m.id ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${method === m.id ? 'rgba(59,130,246,0.2)' : 'rgba(255,255,255,0.05)'}`,
                    cursor: 'pointer', width: '100%', textAlign: 'left', transition: 'all 0.2s',
                  }}>
                    <div style={{
                      width: '2.2rem', height: '2.2rem', borderRadius: '10px',
                      background: `${m.color}12`, border: `1px solid ${m.color}20`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <m.icon size={16} style={{ color: m.color }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'white' }}>{m.name}</div>
                      <div style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", marginTop: '0.15rem' }}>
                        Fee: {m.fee} — {m.time}
                      </div>
                    </div>
                    {method === m.id && <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#3b82f6', boxShadow: '0 0 8px rgba(59,130,246,0.5)' }} />}
                  </button>
                ))}
              </div>

              <button onClick={handleContinue} disabled={loading} style={{
                width: '100%', padding: '0.9rem', borderRadius: '14px', border: 'none',
                background: loading ? 'rgba(59,130,246,0.3)' : 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                color: 'white', fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.85rem',
                cursor: loading ? 'wait' : 'pointer', textTransform: 'uppercase',
                boxShadow: '0 4px 20px rgba(59,130,246,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
              }}>
                {loading ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Finding seller...</> : <>Find Best Price <ArrowRight size={16} /></>}
                <style dangerouslySetInnerHTML={{ __html: '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' }} />
              </button>
            </GlassCard>
          )}

          {/* ═══ STEP 3: Paying ═══ */}
          {step === 'paying' && matchedOrder && (
            <GlassCard style={{ padding: '2rem' }}>
              <button onClick={() => setStep('method')} style={{ background: 'none', border: 'none', color: '#8888aa', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '1rem', fontSize: '0.75rem' }}>
                <ArrowLeft size={14} /> Back
              </button>

              {/* Matched banner */}
              <div style={{
                padding: '0.8rem', borderRadius: '12px', marginBottom: '1.5rem',
                background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)',
                display: 'flex', alignItems: 'center', gap: '0.5rem',
              }}>
                <CheckCircle size={16} style={{ color: '#22c55e' }} />
                <span style={{ color: '#22c55e', fontSize: '0.75rem', fontFamily: "'JetBrains Mono',monospace" }}>
                  Seller matched — crypto locked in escrow
                </span>
              </div>

              {/* Summary */}
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <div>
                    <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase' }}>You pay</span>
                    <p style={{ fontSize: '1.3rem', fontFamily: "'Orbitron',sans-serif", fontWeight: 700, color: 'white', margin: '0.2rem 0 0' }}>
                      {currency === 'USD' ? '$' : '€'}{fiatNum.toFixed(2)}
                    </p>
                  </div>
                  <ArrowRight size={20} style={{ color: '#3b82f6' }} />
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase' }}>You receive</span>
                    <p style={{ fontSize: '1.3rem', fontFamily: "'Orbitron',sans-serif", fontWeight: 700, color: '#60a5fa', margin: '0.2rem 0 0' }}>
                      {cryptoAmount.toFixed(4)} {token}
                    </p>
                  </div>
                </div>
              </div>

              {/* Payment instructions */}
              <div style={{
                padding: '1.2rem', borderRadius: '14px',
                background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
                marginBottom: '1.5rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                  <methodInfo.icon size={16} style={{ color: methodInfo.color }} />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'white' }}>
                    Pay via {methodInfo.name}
                  </span>
                </div>

                <p style={{ fontSize: '0.75rem', color: '#8888aa', lineHeight: 1.7, marginBottom: '1rem' }}>
                  Send <strong style={{ color: 'white' }}>{currency === 'USD' ? '$' : '€'}{fiatNum.toFixed(2)}</strong> to the seller using {methodInfo.name}.
                  The seller&apos;s details will appear in the encrypted trade chat.
                </p>

                {/* Seller info */}
                <div style={{
                  padding: '0.8rem', borderRadius: '10px',
                  background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.1)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.65rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace" }}>Seller</span>
                    <button onClick={() => handleCopy(matchedOrder.maker)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                      <span style={{ fontSize: '0.65rem', color: '#60a5fa', fontFamily: "'JetBrains Mono',monospace" }}>
                        {matchedOrder.maker.slice(0, 6)}...{matchedOrder.maker.slice(-4)}
                      </span>
                      {copied ? <Check size={10} style={{ color: '#22c55e' }} /> : <Copy size={10} style={{ color: '#555570' }} />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Timer */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                <Clock size={14} style={{ color: confirmCountdown < 300 ? '#ef4444' : '#555570' }} />
                <span style={{ fontSize: '0.75rem', fontFamily: "'JetBrains Mono',monospace", color: confirmCountdown < 300 ? '#ef4444' : '#8888aa' }}>
                  Time remaining: {mins}:{secs.toString().padStart(2, '0')}
                </span>
              </div>

              {/* Confirm button */}
              <button onClick={handleConfirmPayment} style={{
                width: '100%', padding: '0.9rem', borderRadius: '14px', border: 'none',
                background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                color: 'white', fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.85rem',
                cursor: 'pointer', textTransform: 'uppercase',
                boxShadow: '0 4px 20px rgba(34,197,94,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
              }}>
                <CheckCircle size={16} />
                I&apos;ve Sent the Payment
              </button>
            </GlassCard>
          )}

          {/* ═══ STEP 3.5: Confirming ═══ */}
          {step === 'confirming' && (
            <GlassCard style={{ padding: '3rem 2rem', textAlign: 'center' }}>
              <Loader2 size={40} style={{ color: '#3b82f6', margin: '0 auto 1rem', animation: 'spin 1s linear infinite' }} />
              <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1rem', fontWeight: 700, color: 'white', marginBottom: '0.5rem' }}>
                Processing...
              </h2>
              <p style={{ color: '#8888aa', fontSize: '0.8rem', fontFamily: "'JetBrains Mono',monospace" }}>
                Locking escrow and confirming payment on-chain
              </p>
            </GlassCard>
          )}

          {/* ═══ STEP 4: Complete ═══ */}
          {step === 'complete' && (
            <GlassCard style={{ padding: '2.5rem 2rem', textAlign: 'center' }}>
              <div style={{
                width: '4rem', height: '4rem', borderRadius: '50%', margin: '0 auto 1.5rem',
                background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 30px rgba(34,197,94,0.15)',
              }}>
                <CheckCircle size={28} style={{ color: '#22c55e' }} />
              </div>

              <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.2rem', fontWeight: 700, color: '#22c55e', marginBottom: '0.5rem' }}>
                Payment Confirmed
              </h2>
              <p style={{ color: '#8888aa', fontSize: '0.8rem', marginBottom: '1.5rem' }}>
                Your {cryptoAmount.toFixed(4)} {token} will arrive once the seller releases the escrow.
              </p>

              {txSig && (
                <div style={{
                  padding: '0.8rem', borderRadius: '10px', marginBottom: '1rem',
                  background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.1)',
                }}>
                  <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace" }}>Transaction</span>
                  <p style={{ fontSize: '0.7rem', color: '#60a5fa', fontFamily: "'JetBrains Mono',monospace", margin: '0.3rem 0 0', wordBreak: 'break-all' }}>
                    {txSig}
                  </p>
                </div>
              )}

              {escrowAddress && (
                <div style={{
                  padding: '0.8rem', borderRadius: '10px', marginBottom: '1.5rem',
                  background: 'rgba(139,92,246,0.05)', border: '1px solid rgba(139,92,246,0.1)',
                }}>
                  <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace" }}>Escrow</span>
                  <p style={{ fontSize: '0.7rem', color: '#a78bfa', fontFamily: "'JetBrains Mono',monospace", margin: '0.3rem 0 0', wordBreak: 'break-all' }}>
                    {escrowAddress}
                  </p>
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <Link href="/orders" style={{
                  flex: 1, padding: '0.7rem', borderRadius: '12px',
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
                  color: '#8888aa', fontSize: '0.75rem', fontFamily: "'Orbitron',sans-serif", fontWeight: 600,
                  textDecoration: 'none', textAlign: 'center',
                }}>
                  My Orders
                </Link>
                <button onClick={() => { setStep('amount'); setFiatAmount('100'); setTxSig(null); setEscrowAddress(null); }} style={{
                  flex: 1, padding: '0.7rem', borderRadius: '12px',
                  background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                  border: 'none', color: 'white', fontSize: '0.75rem',
                  fontFamily: "'Orbitron',sans-serif", fontWeight: 600, cursor: 'pointer',
                }}>
                  Buy More
                </button>
              </div>
            </GlassCard>
          )}

          {/* Bottom trust line */}
          <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
              <Shield size={12} style={{ color: '#3b82f6' }} />
              <span style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace" }}>
                Protected by on-chain escrow — crypto locked until payment confirmed
              </span>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
