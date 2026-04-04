'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Wallet, Clock, CheckCircle, XCircle, AlertTriangle, ExternalLink, ArrowRight, RefreshCw } from 'lucide-react';
import MugenNavbar from '@/components/MugenNavbar';
import { useP01Wallet } from '@/components/WalletProvider';

type OrderStatus = 'open' | 'in_escrow' | 'completed' | 'cancelled' | 'disputed';

interface MyOrder {
  id: string;
  type: 'buy_crypto' | 'sell_crypto';
  token: string;
  cryptoAmount: number;
  fiatAmount: number;
  fiatCurrency: string;
  status: OrderStatus;
  createdAt: number;
  counterparty?: string;
}

const statusConfig: Record<OrderStatus, { color: string; Icon: typeof CheckCircle; label: string; bg: string }> = {
  open: { color: '#3b82f6', Icon: Clock, label: 'Open', bg: 'rgba(59,130,246,0.1)' },
  in_escrow: { color: '#eab308', Icon: Clock, label: 'In Escrow', bg: 'rgba(234,179,8,0.1)' },
  completed: { color: '#22c55e', Icon: CheckCircle, label: 'Completed', bg: 'rgba(34,197,94,0.1)' },
  cancelled: { color: '#555570', Icon: XCircle, label: 'Cancelled', bg: 'rgba(85,85,112,0.1)' },
  disputed: { color: '#ef4444', Icon: AlertTriangle, label: 'Disputed', bg: 'rgba(239,68,68,0.1)' },
};

function GlassCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      position: 'relative',
      background: 'rgba(255,255,255,0.03)',
      backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '16px', overflow: 'hidden',
      ...style,
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent)' }} />
      {children}
    </div>
  );
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function OrdersPage() {
  const { connected, setShowConnectModal, publicKey } = useP01Wallet();
  const [filter, setFilter] = useState<'all' | OrderStatus>('all');
  const [orders, setOrders] = useState<MyOrder[]>([]);
  const [loading, setLoading] = useState(false);

  // Load user orders — in production this calls sdk.exchange.getMyOrders()
  useEffect(() => {
    if (connected) {
      setLoading(true);
      // Simulated fetch — replace with real on-chain query
      setTimeout(() => {
        setOrders([
          { id: '1', type: 'sell_crypto', token: 'SOL', cryptoAmount: 50, fiatAmount: 7350, fiatCurrency: 'USD', status: 'open', createdAt: Math.floor(Date.now()/1000) - 7200 },
          { id: '2', type: 'buy_crypto', token: 'USDC', cryptoAmount: 1000, fiatAmount: 99800, fiatCurrency: 'EUR', status: 'completed', createdAt: Math.floor(Date.now()/1000) - 86400, counterparty: '3EzP...T4y' },
          { id: '3', type: 'sell_crypto', token: 'SOL', cryptoAmount: 25, fiatAmount: 3720, fiatCurrency: 'USD', status: 'in_escrow', createdAt: Math.floor(Date.now()/1000) - 10800, counterparty: 'FH1J...TLPT' },
        ]);
        setLoading(false);
      }, 800);
    } else {
      setOrders([]);
    }
  }, [connected]);

  const filtered = orders.filter(o => filter === 'all' || o.status === filter);

  const stats = {
    total: orders.length,
    open: orders.filter(o => o.status === 'open').length,
    active: orders.filter(o => o.status === 'in_escrow').length,
    completed: orders.filter(o => o.status === 'completed').length,
  };

  return (
    <>
      <MugenNavbar />
      <main style={{ position: 'relative', zIndex: 10, minHeight: '100vh', paddingTop: '5.5rem', paddingBottom: '3rem', paddingLeft: '1.5rem', paddingRight: '1.5rem', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '64rem', margin: '0 auto', width: '100%' }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h1 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.8rem', fontWeight: 800, color: 'white', margin: 0 }}>My Orders</h1>
              <p style={{ color: '#8888aa', fontSize: '0.8rem', fontFamily: "'JetBrains Mono',monospace", marginTop: '0.3rem' }}>
                {connected ? `${stats.total} orders — ${stats.active} active` : 'Connect wallet to view orders'}
              </p>
            </div>
            {connected && (
              <Link href="/exchange" style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                padding: '0.6rem 1.5rem', background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                borderRadius: '10px', color: 'white', fontFamily: "'Orbitron',sans-serif", fontWeight: 700,
                fontSize: '0.75rem', textDecoration: 'none', textTransform: 'uppercase',
              }}>
                New Order <ArrowRight size={14} />
              </Link>
            )}
          </div>

          {/* Not connected state */}
          {!connected && (
            <GlassCard style={{ padding: '4rem 2rem', textAlign: 'center' }}>
              <Wallet size={48} style={{ color: '#3b82f6', margin: '0 auto 1.5rem', opacity: 0.5 }} />
              <h2 style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.2rem', fontWeight: 700, color: 'white', marginBottom: '0.75rem' }}>
                Connect Your P01 Wallet
              </h2>
              <p style={{ color: '#8888aa', fontSize: '0.85rem', maxWidth: '20rem', margin: '0 auto 1.5rem', lineHeight: 1.7 }}>
                Connect your Protocol 01 wallet to view your order history and active trades.
              </p>
              <button onClick={() => setShowConnectModal(true)} style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.8rem 2rem', background: 'linear-gradient(135deg, #3b82f6, #7c3aed)',
                border: 'none', borderRadius: '12px', color: 'white',
                fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.8rem',
                cursor: 'pointer', textTransform: 'uppercase',
                boxShadow: '0 4px 20px rgba(59,130,246,0.3)',
              }}>
                <Wallet size={16} />
                Connect P01
              </button>
            </GlassCard>
          )}

          {/* Connected — stats + orders */}
          {connected && (
            <>
              {/* Stats bar */}
              <GlassCard style={{ padding: '1.2rem 1.5rem', marginBottom: '1.5rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', textAlign: 'center' }}>
                  {[
                    { label: 'Total', value: stats.total, color: 'white' },
                    { label: 'Open', value: stats.open, color: '#3b82f6' },
                    { label: 'Active', value: stats.active, color: '#eab308' },
                    { label: 'Completed', value: stats.completed, color: '#22c55e' },
                  ].map(s => (
                    <div key={s.label}>
                      <span style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '1.3rem', fontWeight: 800, color: s.color }}>{s.value}</span>
                      <span style={{ display: 'block', fontSize: '0.6rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace", textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: '0.2rem' }}>{s.label}</span>
                    </div>
                  ))}
                </div>
              </GlassCard>

              {/* Filters */}
              <GlassCard style={{ display: 'inline-flex', padding: '0.25rem', borderRadius: '12px', gap: '0.15rem', marginBottom: '1.5rem' }}>
                {(['all', 'open', 'in_escrow', 'completed', 'cancelled'] as const).map(f => (
                  <button key={f} onClick={() => setFilter(f)} style={{
                    padding: '0.5rem 1rem', border: 'none', borderRadius: '10px', cursor: 'pointer',
                    fontFamily: "'JetBrains Mono',monospace", fontSize: '0.7rem', textTransform: 'uppercase',
                    background: filter === f ? 'rgba(59,130,246,0.12)' : 'transparent',
                    color: filter === f ? '#3b82f6' : '#555570', transition: 'all 0.2s',
                  }}>
                    {f === 'all' ? 'All' : f.replace('_', ' ')}
                  </button>
                ))}
              </GlassCard>

              {/* Loading */}
              {loading && (
                <div style={{ textAlign: 'center', padding: '3rem' }}>
                  <RefreshCw size={24} style={{ color: '#3b82f6', animation: 'spin 1s linear infinite' }} />
                  <style dangerouslySetInnerHTML={{ __html: '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}' }} />
                  <p style={{ color: '#8888aa', fontSize: '0.8rem', marginTop: '0.75rem', fontFamily: "'JetBrains Mono',monospace" }}>Loading orders from chain...</p>
                </div>
              )}

              {/* Orders */}
              {!loading && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {filtered.map(order => {
                    const sc = statusConfig[order.status];
                    return (
                      <GlassCard key={order.id} style={{ padding: '1.2rem 1.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
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
                              <p style={{ fontFamily: "'Orbitron',sans-serif", fontSize: '0.9rem', fontWeight: 700, color: 'white', margin: 0 }}>
                                {order.type === 'buy_crypto' ? 'Buy' : 'Sell'} {order.cryptoAmount} {order.token}
                              </p>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginTop: '0.3rem' }}>
                                <span style={{ fontSize: '0.7rem', color: '#60a5fa', fontFamily: "'JetBrains Mono',monospace" }}>
                                  ${(order.fiatAmount / 100).toFixed(2)} {order.fiatCurrency}
                                </span>
                                <span style={{ fontSize: '0.7rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace" }}>
                                  {timeAgo(order.createdAt)}
                                </span>
                                {order.counterparty && (
                                  <span style={{ fontSize: '0.7rem', color: '#555570', fontFamily: "'JetBrains Mono',monospace" }}>
                                    ↔ {order.counterparty}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <span style={{
                              display: 'flex', alignItems: 'center', gap: '0.3rem',
                              padding: '0.3rem 0.8rem', borderRadius: '8px',
                              fontSize: '0.7rem', fontFamily: "'JetBrains Mono',monospace",
                              background: sc.bg, color: sc.color,
                              border: `1px solid ${sc.color}25`,
                            }}>
                              <sc.Icon size={12} />
                              {sc.label}
                            </span>
                            {order.status === 'in_escrow' && (
                              <Link href={`/trade/${order.id}`} style={{
                                display: 'flex', alignItems: 'center', gap: '0.3rem',
                                padding: '0.4rem 1rem', borderRadius: '8px',
                                background: 'linear-gradient(135deg, #3b82f6, #7c3aed)', color: 'white',
                                fontFamily: "'Orbitron',sans-serif", fontWeight: 700, fontSize: '0.65rem',
                                textDecoration: 'none', textTransform: 'uppercase',
                              }}>
                                Trade <ArrowRight size={12} />
                              </Link>
                            )}
                          </div>
                        </div>
                      </GlassCard>
                    );
                  })}
                </div>
              )}

              {/* Empty filtered */}
              {!loading && filtered.length === 0 && (
                <div style={{ textAlign: 'center', padding: '4rem' }}>
                  <p style={{ fontFamily: "'Orbitron',sans-serif", color: '#8888aa', fontSize: '0.9rem' }}>No orders match this filter</p>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
