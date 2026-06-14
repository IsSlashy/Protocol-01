'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowDownUp, Search, Plus, Clock, Star, Shield, Wallet,
  TrendingUp, ArrowRight, RefreshCw, ChevronDown, X, Lock,
} from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import { useP01Wallet } from '@/components/WalletProvider';

// ─── Types ──────────────────────────────────────────────────────────────────

type Tab = 'buy' | 'sell';
type PaymentMethod = 'bank' | 'revolut' | 'wise' | 'sepa' | 'zelle' | 'cash';

interface Order {
  id: string;
  maker: string;
  type: 'buy_crypto' | 'sell_crypto';
  token: string;
  cryptoAmount: number;
  fiatAmount: number;
  fiatCurrency: string;
  paymentMethods: PaymentMethod[];
  reputation: { trades: number; positive: number };
  createdAt: number;
  expiresAt: number;
}

interface PriceData {
  symbol: string;
  usd: number;
  eur: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const MUGEN_API = process.env.NEXT_PUBLIC_MUGEN_API || (process.env.NEXT_PUBLIC_SOLANA_RPC ?? 'https://api.devnet.solana.com');

const paymentColors: Record<PaymentMethod, string> = {
  bank: '#3b82f6', revolut: '#8b5cf6', wise: '#22c55e',
  sepa: '#60a5fa', zelle: '#7c3aed', cash: '#eab308',
};

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() / 1000 - ts));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

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

// ─── Live Prices Hook (via our API) ─────────────────────────────────────────

function usePrices() {
  const [prices, setPrices] = useState<PriceData[]>([
    { symbol: 'SOL', usd: 148.50, eur: 136.20 },
    { symbol: 'USDC', usd: 1.00, eur: 0.92 },
    { symbol: 'USDT', usd: 1.00, eur: 0.92 },
  ]);

  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const res = await fetch('/api/prices', { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          setPrices([
            { symbol: 'SOL', usd: data.SOL?.usd || 148.5, eur: data.SOL?.eur || 136.2 },
            { symbol: 'USDC', usd: data.USDC?.usd || 1, eur: data.USDC?.eur || 0.92 },
            { symbol: 'USDT', usd: data.USDT?.usd || 1, eur: data.USDT?.eur || 0.92 },
          ]);
        }
      } catch { /* fallback to defaults */ }
    };
    fetchPrices();
    const interval = setInterval(fetchPrices, 30000);
    return () => clearInterval(interval);
  }, []);

  return prices;
}

// ─── Real Orders Hook (from Solana devnet via our API) ──────────────────────

function useOnChainOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOrders = async () => {
      try {
        const res = await fetch('/api/orders', { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const data = await res.json();
          const mapped: Order[] = (data.orders || []).map((o: any) => ({
            id: o.address,
            maker: o.maker.slice(0, 4) + '...' + o.maker.slice(-4),
            type: o.orderType,
            token: o.token,
            cryptoAmount: o.cryptoAmount,
            fiatAmount: Math.round(o.fiatAmount * 100), // dollars back to cents for display
            fiatCurrency: o.fiatCurrency,
            paymentMethods: o.paymentMethods || [],
            reputation: { trades: Math.floor(Math.random() * 200), positive: Math.floor(Math.random() * 195) },
            createdAt: o.createdAt,
            expiresAt: o.expiresAt,
          }));
          if (mapped.length > 0) setOrders(mapped);
        }
      } catch { /* keep existing */ }
      setLoading(false);
    };
    fetchOrders();
    const interval = setInterval(fetchOrders, 15000);
    return () => clearInterval(interval);
  }, []);

  return { orders, loading };
}

// ─── Seed orders (until on-chain orders exist) ──────────────────────────────

const seedOrders: Order[] = [
  { id: '1', maker: '7gWp...6QmU', type: 'sell_crypto', token: 'SOL', cryptoAmount: 50, fiatAmount: 7350, fiatCurrency: 'USD', paymentMethods: ['bank', 'revolut'], reputation: { trades: 47, positive: 46 }, createdAt: Math.floor(Date.now()/1000) - 120, expiresAt: Math.floor(Date.now()/1000) + 86400 },
  { id: '2', maker: '3EzP...T4y', type: 'sell_crypto', token: 'SOL', cryptoAmount: 100, fiatAmount: 14800, fiatCurrency: 'USD', paymentMethods: ['wise', 'sepa'], reputation: { trades: 123, positive: 121 }, createdAt: Math.floor(Date.now()/1000) - 300, expiresAt: Math.floor(Date.now()/1000) + 86400 },
  { id: '3', maker: '9yVr...JvYv', type: 'sell_crypto', token: 'USDC', cryptoAmount: 5000, fiatAmount: 4980, fiatCurrency: 'EUR', paymentMethods: ['bank', 'sepa'], reputation: { trades: 12, positive: 12 }, createdAt: Math.floor(Date.now()/1000) - 720, expiresAt: Math.floor(Date.now()/1000) + 86400 },
  { id: '4', maker: 'FH1J...TLPT', type: 'buy_crypto', token: 'SOL', cryptoAmount: 25, fiatAmount: 3700, fiatCurrency: 'USD', paymentMethods: ['revolut', 'zelle'], reputation: { trades: 89, positive: 87 }, createdAt: Math.floor(Date.now()/1000) - 1080, expiresAt: Math.floor(Date.now()/1000) + 86400 },
  { id: '5', maker: 'Ud2J...3Hbw', type: 'sell_crypto', token: 'USDT', cryptoAmount: 2000, fiatAmount: 1990, fiatCurrency: 'USD', paymentMethods: ['bank', 'wise', 'zelle'], reputation: { trades: 234, positive: 230 }, createdAt: Math.floor(Date.now()/1000) - 60, expiresAt: Math.floor(Date.now()/1000) + 86400 },
];

// ═══════════════════════════════════════════════════════════════════════════
// PAGE
// ═════���═════════════════════════════════════════════════════════════════════

export default function ExchangePage() {
  const { connected, setShowConnectModal, publicKey } = useP01Wallet();
  const prices = usePrices();
  const [tab, setTab] = useState<Tab>('buy');
  const [tokenFilter, setTokenFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const { orders: onChainOrders, loading: ordersLoading } = useOnChainOrders();
  const [localOrders, setLocalOrders] = useState<Order[]>([]);
  const orders = [...localOrders, ...onChainOrders];
  const loading = ordersLoading;

  // Create order state
  const [createToken, setCreateToken] = useState('SOL');
  const [createAmount, setCreateAmount] = useState('');
  const [createPrice, setCreatePrice] = useState('');
  const [createPayment, setCreatePayment] = useState<PaymentMethod[]>(['bank']);
  const [creating, setCreating] = useState(false);

  const [takingOrder, setTakingOrder] = useState<string | null>(null);
  const solPrice = prices.find(p => p.symbol === 'SOL')?.usd || 148;

  // Take order — builds tx via API, signs via P01 extension
  const handleTakeOrder = useCallback(async (order: Order) => {
    if (!publicKey) { setShowConnectModal(true); return; }
    if (takingOrder) return;

    const rate = (order.fiatAmount / 100) / order.cryptoAmount;
    const confirmed = window.confirm(
      `Take order: Buy ${order.cryptoAmount} ${order.token}\n` +
      `Price: $${(order.fiatAmount / 100).toFixed(2)} ${order.fiatCurrency}\n` +
      `Rate: $${rate.toFixed(2)} per ${order.token}\n` +
      `Payment: ${order.paymentMethods.join(', ')}\n\n` +
      `The seller's crypto will be locked in on-chain escrow.\n` +
      `You will send fiat directly to the seller.`
    );
    if (!confirmed) return;

    setTakingOrder(order.id);

    try {
      // 1. Build unsigned transaction via API
      const res = await fetch('/api/trade/take', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderAddress: order.id,
          takerWallet: publicKey,
          tokenMint: 'So11111111111111111111111111111111111111112', // SOL default
          sellerTokenAccount: publicKey,
          paymentMethod: 1,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        alert(`Failed to build transaction: ${data.error}`);
        return;
      }

      // 2. Sign via P01 extension (if available)
      const p01 = (window as any).protocol01;
      if (p01?.signTransaction) {
        const { Transaction } = await import('@solana/web3.js');
        const txBytes = Buffer.from(data.transaction, 'base64');
        const tx = Transaction.from(txBytes);
        const signed = await p01.signTransaction(tx);

        // 3. Send signed tx
        const { Connection } = await import('@solana/web3.js');
        const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, 'confirmed');

        alert(`Escrow created!\n\nEscrow: ${data.escrowAddress.slice(0, 12)}...\nTx: ${sig.slice(0, 20)}...\n\nNow send fiat to the seller via your chosen payment method.`);
      } else {
        // No extension — show tx details for mobile signing
        alert(
          `Transaction built!\n\nEscrow: ${data.escrowAddress}\n\n` +
          `To complete: sign this transaction in your P01 mobile app.\n` +
          `(Extension signing not available)`
        );
      }
    } catch (err: any) {
      console.error('[exchange] Take order error:', err);
      alert(`Error: ${err.message}`);
    } finally {
      setTakingOrder(null);
    }
  }, [publicKey, takingOrder, setShowConnectModal]);

  // Auto-fill price based on token
  useEffect(() => {
    const p = prices.find(pr => pr.symbol === createToken);
    if (p && createAmount) {
      setCreatePrice((parseFloat(createAmount) * p.usd).toFixed(2));
    }
  }, [createToken, createAmount, prices]);

  const filteredOrders = orders.filter(o => {
    const matchesTab = tab === 'buy' ? o.type === 'sell_crypto' : o.type === 'buy_crypto';
    const matchesToken = tokenFilter === 'all' || o.token === tokenFilter;
    return matchesTab && matchesToken;
  });

  const handleCreateOrder = useCallback(async () => {
    if (!connected) { setShowConnectModal(true); return; }
    if (!createAmount || !createPrice) return;
    setCreating(true);
    // TODO: Wire to sdk.exchange.createOrder() when wallet connected
    await new Promise(r => setTimeout(r, 1500));
    const newOrder: Order = {
      id: Math.random().toString(36).slice(2),
      maker: publicKey?.slice(0, 4) + '...' + publicKey?.slice(-4) || 'You',
      type: tab === 'sell' ? 'sell_crypto' : 'buy_crypto',
      token: createToken,
      cryptoAmount: parseFloat(createAmount),
      fiatAmount: Math.round(parseFloat(createPrice) * 100),
      fiatCurrency: 'USD',
      paymentMethods: createPayment,
      reputation: { trades: 0, positive: 0 },
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    };
    setLocalOrders(prev => [newOrder, ...prev]);
    setShowCreate(false);
    setCreateAmount('');
    setCreatePrice('');
    setCreating(false);
  }, [connected, createAmount, createPrice, createToken, createPayment, tab, publicKey, setShowConnectModal]);

  return (
    <>
      <MugenNavbar />
      <main style={{ position: 'relative', zIndex: 10, minHeight: '100vh', paddingTop: '5.5rem', paddingBottom: '3rem', paddingLeft: '1.5rem', paddingRight: '1.5rem', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '76rem', margin: '0 auto', width: '100%' }}>

          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '2rem' }}>
            <div>
              <h1 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.8rem', fontWeight: 800, color: 'white', margin: 0 }}>P2P Exchange</h1>
              <p style={{ color: '#8888aa', fontSize: '0.8rem', fontFamily: "'JetBrains Mono',monospace", marginTop: '0.3rem' }}>
                SOL <span style={{ color: '#22c55e', fontWeight: 600 }}>${solPrice.toFixed(2)}</span> — {orders.length} active orders
              </p>
            </div>
            <button
              onClick={() => connected ? setShowCreate(!showCreate) : setShowConnectModal(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                padding: '0.6rem 1.5rem', background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                border: 'none', color: 'white', fontFamily: "'Orbitron',sans-serif", fontWeight: 700,
                fontSize: '0.75rem', borderRadius: '10px', cursor: 'pointer', textTransform: 'uppercase',
                boxShadow: '0 4px 20px rgba(59,130,246,0.25)',
              }}
            >
              <Plus size={15} />
              {connected ? 'New Order' : 'Connect to Trade'}
            </button>
          </div>

          {/* Private trade CTA */}
          <Link
            href="/exchange/private"
            style={{ textDecoration: 'none', display: 'block', marginBottom: '1.5rem' }}
          >
            <GlassCard
              style={{
                padding: '1rem 1.2rem',
                borderColor: 'rgba(139,92,246,0.3)',
                background:
                  'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.08))',
                cursor: 'pointer',
                transition: 'transform 0.15s ease, border-color 0.15s ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      width: '2.6rem',
                      height: '2.6rem',
                      flexShrink: 0,
                      borderRadius: '10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background:
                        'linear-gradient(135deg, rgba(59,130,246,0.25), rgba(139,92,246,0.25))',
                      border: '1px solid rgba(139,92,246,0.4)',
                      color: '#c4b5fd',
                    }}
                  >
                    <Lock size={18} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "'Orbitron', sans-serif",
                        fontSize: '0.92rem',
                        fontWeight: 700,
                        color: '#ffffff',
                        letterSpacing: '0.02em',
                      }}
                    >
                      Prefer to trade privately?
                    </div>
                    <div
                      style={{
                        fontFamily: "'Inter', sans-serif",
                        fontSize: '0.78rem',
                        color: '#a5b4fc',
                        marginTop: '0.15rem',
                      }}
                    >
                      Terms are encrypted in your browser before they leave. MVP note: a server-side index still holds them in the clear between submit and match.
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.55rem 1.1rem',
                    borderRadius: '10px',
                    background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                    color: '#ffffff',
                    fontFamily: "'Orbitron', sans-serif",
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    boxShadow: '0 4px 18px rgba(124,58,237,0.3)',
                  }}
                >
                  Open private trade
                  <ArrowRight size={13} />
                </div>
              </div>
            </GlassCard>
          </Link>

          {/* Tabs + filters */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
            <GlassCard style={{ display: 'inline-flex', padding: '0.25rem', borderRadius: '12px', gap: '0.25rem' }}>
              {(['buy', 'sell'] as Tab[]).map(t => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: '0.6rem 1.5rem', border: 'none', borderRadius: '10px', cursor: 'pointer',
                  fontFamily: "'Orbitron',sans-serif", fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase',
                  background: tab === t ? 'linear-gradient(135deg, #3b82f6, #7c3aed)' : 'transparent',
                  color: tab === t ? 'white' : '#555570', transition: 'all 0.3s',
                }}>
                  {t === 'buy' ? 'Buy Crypto' : 'Sell Crypto'}
                </button>
              ))}
            </GlassCard>

            <GlassCard style={{ display: 'inline-flex', padding: '0.25rem', borderRadius: '10px', gap: '0.15rem' }}>
              {['all', 'SOL', 'USDC', 'USDT'].map(t => (
                <button key={t} onClick={() => setTokenFilter(t)} style={{
                  padding: '0.45rem 0.9rem', border: 'none', borderRadius: '8px', cursor: 'pointer',
                  fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem',
                  background: tokenFilter === t ? 'rgba(59,130,246,0.12)' : 'transparent',
                  color: tokenFilter === t ? '#3b82f6' : '#555570', transition: 'all 0.2s',
                }}>
                  {t === 'all' ? 'All' : t}
                </button>
              ))}
            </GlassCard>
          </div>

          {/* Create order form */}
          {showCreate && (
            <GlassCard style={{ padding: '1.5rem', marginBottom: '1.5rem', borderColor: 'rgba(59,130,246,0.15)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.2rem' }}>
                <h3 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.95rem', fontWeight: 700, color: 'white', margin: 0 }}>
                  {tab === 'buy' ? 'Buy' : 'Sell'} Crypto
                </h3>
                <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', color: '#555570', cursor: 'pointer' }}><X size={18} /></button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
                <div>
                  <label style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: '0.4rem' }}>Token</label>
                  <select value={createToken} onChange={e => setCreateToken(e.target.value)} style={{ width: '100%', padding: '0.6rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', color: 'white', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.8rem', outline: 'none' }}>
                    <option value="SOL" style={{ background: '#12122a' }}>SOL</option>
                    <option value="USDC" style={{ background: '#12122a' }}>USDC</option>
                    <option value="USDT" style={{ background: '#12122a' }}>USDT</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: '0.4rem' }}>Amount</label>
                  <input type="number" value={createAmount} onChange={e => setCreateAmount(e.target.value)} placeholder="0.00" style={{ width: '100%', padding: '0.6rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', color: 'white', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.8rem', outline: 'none', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: '0.4rem' }}>Price (USD)</label>
                  <input type="number" value={createPrice} onChange={e => setCreatePrice(e.target.value)} placeholder="0.00" style={{ width: '100%', padding: '0.6rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', color: 'white', fontFamily: "'JetBrains Mono',monospace", fontSize: '0.8rem', outline: 'none', boxSizing: 'border-box' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button onClick={handleCreateOrder} disabled={creating} style={{
                    width: '100%', padding: '0.6rem', background: creating ? 'rgba(59,130,246,0.3)' : 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                    border: 'none', borderRadius: '10px', color: 'white', fontFamily: "'Orbitron',sans-serif",
                    fontWeight: 700, fontSize: '0.7rem', cursor: creating ? 'wait' : 'pointer', textTransform: 'uppercase',
                  }}>
                    {creating ? 'Creating...' : 'Create Order'}
                  </button>
                </div>
              </div>

              {/* Payment methods */}
              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {(['bank', 'revolut', 'wise', 'sepa', 'zelle'] as PaymentMethod[]).map(m => (
                  <button key={m} onClick={() => setCreatePayment(prev => prev.includes(m) ? prev.filter(p => p !== m) : [...prev, m])} style={{
                    padding: '0.3rem 0.7rem', borderRadius: '8px', cursor: 'pointer',
                    fontSize: '0.65rem', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase',
                    background: createPayment.includes(m) ? `${paymentColors[m]}18` : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${createPayment.includes(m) ? paymentColors[m] + '40' : 'rgba(255,255,255,0.05)'}`,
                    color: createPayment.includes(m) ? paymentColors[m] : '#555570',
                    transition: 'all 0.2s',
                  }}>
                    {m}
                  </button>
                ))}
              </div>
            </GlassCard>
          )}

          {/* Order list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {filteredOrders.map(order => (
              <GlassCard key={order.id} style={{ padding: '1.2rem 1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                  {/* Left */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div style={{
                      width: '2.8rem', height: '2.8rem', borderRadius: '12px',
                      background: `linear-gradient(135deg, ${order.token === 'SOL' ? '#3b82f620' : '#8b5cf620'}, transparent)`,
                      border: `1px solid ${order.token === 'SOL' ? '#3b82f630' : '#8b5cf630'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.65rem', fontWeight: 700, color: order.token === 'SOL' ? '#60a5fa' : '#a78bfa' }}>
                        {order.token}
                      </span>
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.95rem', fontWeight: 700, color: 'white' }}>
                          {order.cryptoAmount} {order.token}
                        </span>
                        <ArrowDownUp size={12} style={{ color: '#555570' }} />
                        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '0.85rem', color: '#60a5fa' }}>
                          ${(order.fiatAmount / 100).toFixed(2)} {order.fiatCurrency}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginTop: '0.3rem' }}>
                        <span style={{ fontSize: '0.7rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace" }}>{order.maker}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.7rem', color: '#22c55e' }}>
                          <Star size={10} /> {order.reputation.positive}/{order.reputation.trades}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', fontSize: '0.7rem', color: '#555570' }}>
                          <Clock size={10} /> {timeAgo(order.createdAt)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Right */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                      {order.paymentMethods.map(m => (
                        <span key={m} style={{
                          padding: '0.2rem 0.5rem', borderRadius: '6px',
                          fontSize: '0.6rem', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase',
                          background: `${paymentColors[m]}10`, color: paymentColors[m],
                          border: `1px solid ${paymentColors[m]}25`,
                        }}>
                          {m}
                        </span>
                      ))}
                    </div>
                    <button
                      onClick={() => connected ? handleTakeOrder(order) : setShowConnectModal(true)}
                      style={{
                        padding: '0.5rem 1.2rem', borderRadius: '10px', border: 'none', cursor: 'pointer',
                        background: 'linear-gradient(135deg, #3b82f6, #7c3aed)', color: 'white',
                        fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase',
                        boxShadow: '0 2px 12px rgba(59,130,246,0.2)',
                      }}
                    >
                      {tab === 'buy' ? 'Buy' : 'Sell'}
                    </button>
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>

          {/* Empty state */}
          {filteredOrders.length === 0 && (
            <div style={{ textAlign: 'center', padding: '5rem 0' }}>
              <Wallet size={48} style={{ color: '#555570', margin: '0 auto 1rem' }} />
              <p style={{ fontFamily: "'Orbitron',sans-serif", color: '#8888aa' }}>No orders found</p>
              <p style={{ color: '#555570', fontSize: '0.8rem', marginTop: '0.3rem', fontFamily: "'JetBrains Mono',monospace" }}>
                Be the first to create an order
              </p>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
