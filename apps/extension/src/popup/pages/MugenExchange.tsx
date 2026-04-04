import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Infinity as InfinityIcon,
  RefreshCw,
  Star,
  Clock,
  Shield,
  ArrowDownUp,
  ExternalLink,
} from 'lucide-react';
import { useWalletStore } from '../../shared/store/wallet';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MugenOrder {
  address: string;
  maker: string;
  orderType: 'buy_crypto' | 'sell_crypto';
  token: string;
  cryptoAmount: number;
  fiatAmount: number;
  fiatCurrency: string;
  paymentMethods: string[];
  status: string;
  createdAt: number;
}

type Tab = 'buy' | 'sell';

const PAYMENT_COLORS: Record<string, string> = {
  bank: '#3b82f6',
  revolut: '#8b5cf6',
  wise: '#22c55e',
  sepa: '#60a5fa',
  zelle: '#7c3aed',
  cash: '#eab308',
};

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function MugenExchange() {
  const navigate = useNavigate();
  const { publicKey, network } = useWalletStore();

  const [tab, setTab] = useState<Tab>('buy');
  const [orders, setOrders] = useState<MugenOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenFilter, setTokenFilter] = useState('all');
  const [solPrice, setSolPrice] = useState(0);

  // Fetch orders from Mugen API
  const fetchOrders = useCallback(async () => {
    try {
      const [ordersRes, pricesRes] = await Promise.all([
        fetch('https://mugen-exchange.vercel.app/api/orders'),
        fetch('https://mugen-exchange.vercel.app/api/prices'),
      ]);

      if (ordersRes.ok) {
        const data = await ordersRes.json();
        setOrders(data.orders || []);
      }
      if (pricesRes.ok) {
        const prices = await pricesRes.json();
        setSolPrice(prices.SOL?.usd || 0);
      }
    } catch (err) {
      console.error('[Mugen] Fetch error:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 30000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const filteredOrders = orders.filter((o) => {
    const matchesTab = tab === 'buy' ? o.orderType === 'sell_crypto' : o.orderType === 'buy_crypto';
    const matchesToken = tokenFilter === 'all' || o.token === tokenFilter;
    return matchesTab && o.status === 'open' && matchesToken;
  });

  const handleTakeOrder = async (order: MugenOrder) => {
    if (!publicKey) return;

    const rate = order.fiatAmount / order.cryptoAmount;
    const confirmed = window.confirm(
      `Buy ${order.cryptoAmount} ${order.token}\n` +
      `Price: $${order.fiatAmount.toFixed(2)} ${order.fiatCurrency}\n` +
      `Rate: $${rate.toFixed(2)} per ${order.token}\n` +
      `Payment: ${order.paymentMethods.join(', ')}\n\n` +
      `Crypto will be locked in on-chain escrow.`,
    );
    if (!confirmed) return;

    try {
      const res = await fetch('https://mugen-exchange.vercel.app/api/trade/take', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderAddress: order.address,
          takerWallet: publicKey,
          tokenMint: 'So11111111111111111111111111111111111111112',
          sellerTokenAccount: publicKey,
          paymentMethod: 1,
        }),
      });

      const data = await res.json();
      if (data.success) {
        // Sign with extension keypair
        const { _keypair } = useWalletStore.getState();
        if (_keypair) {
          const { Transaction, Connection } = await import('@solana/web3.js');
          const txBytes = Buffer.from(data.transaction, 'base64');
          const tx = Transaction.from(txBytes);
          tx.sign({ publicKey: _keypair.publicKey, secretKey: _keypair.secretKey });

          const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
          const sig = await connection.sendRawTransaction(tx.serialize());
          await connection.confirmTransaction(sig, 'confirmed');

          alert(`Escrow created! Tx: ${sig.slice(0, 20)}...\nSend fiat to the seller now.`);
          fetchOrders();
        }
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <div className="flex items-center justify-center gap-2">
            <InfinityIcon className="w-4 h-4 text-[#3b82f6]" />
            <h1 className="text-white font-display font-bold tracking-wide">
              MUGEN EXCHANGE
            </h1>
          </div>
          <p className="text-[#3b82f6] text-[10px] font-mono tracking-wider">
            P2P • NO KYC • ZK COMPLIANCE
            {solPrice > 0 && ` • SOL $${solPrice.toFixed(0)}`}
          </p>
        </div>
        <button
          onClick={fetchOrders}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {/* Tabs */}
      <div className="flex px-3 pt-3 gap-1">
        {(['buy', 'sell'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-xs font-display font-bold uppercase tracking-wider rounded-lg transition-all ${
              tab === t
                ? 'bg-gradient-to-r from-[#3b82f6] to-[#7c3aed] text-white'
                : 'bg-p01-surface text-p01-chrome hover:text-white'
            }`}
          >
            {t === 'buy' ? 'Buy Crypto' : 'Sell Crypto'}
          </button>
        ))}
      </div>

      {/* Token filter */}
      <div className="flex px-3 pt-2 gap-1">
        {['all', 'SOL', 'USDC', 'USDT'].map((t) => (
          <button
            key={t}
            onClick={() => setTokenFilter(t)}
            className={`px-3 py-1 text-[10px] font-mono rounded transition-all ${
              tokenFilter === t
                ? 'bg-[#3b82f6]/15 text-[#3b82f6] border border-[#3b82f6]/30'
                : 'text-p01-chrome hover:text-white border border-transparent'
            }`}
          >
            {t === 'all' ? 'ALL' : t}
          </button>
        ))}
      </div>

      {/* Orders */}
      <div className="flex-1 overflow-y-auto px-3 pt-2 pb-3 space-y-2">
        {loading && (
          <div className="flex items-center justify-center py-10 gap-2">
            <RefreshCw className="w-4 h-4 text-[#3b82f6] animate-spin" />
            <span className="text-p01-chrome text-xs font-mono">Loading from Solana...</span>
          </div>
        )}

        {!loading && filteredOrders.length === 0 && (
          <div className="text-center py-10">
            <InfinityIcon className="w-8 h-8 text-p01-chrome/30 mx-auto mb-2" />
            <p className="text-p01-chrome text-xs font-mono">No orders found</p>
          </div>
        )}

        {filteredOrders.map((order, i) => (
          <motion.div
            key={order.address}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className="bg-p01-surface border border-p01-border rounded-xl p-3"
          >
            {/* Top row: token + amount + price */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-mono font-bold"
                  style={{
                    background: order.token === 'SOL' ? 'rgba(59,130,246,0.1)' : 'rgba(139,92,246,0.1)',
                    border: `1px solid ${order.token === 'SOL' ? 'rgba(59,130,246,0.2)' : 'rgba(139,92,246,0.2)'}`,
                    color: order.token === 'SOL' ? '#60a5fa' : '#a78bfa',
                  }}
                >
                  {order.token}
                </div>
                <div>
                  <span className="text-white text-sm font-bold">
                    {order.cryptoAmount} {order.token}
                  </span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <ArrowDownUp className="w-3 h-3 text-p01-chrome/50" />
                    <span className="text-[#60a5fa] text-xs font-mono">
                      ${order.fiatAmount.toFixed(2)} {order.fiatCurrency}
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <span className="text-p01-chrome text-[10px] font-mono">
                  ${(order.fiatAmount / order.cryptoAmount).toFixed(2)}/{order.token}
                </span>
                <div className="flex items-center gap-1 mt-0.5 justify-end">
                  <Clock className="w-3 h-3 text-p01-chrome/40" />
                  <span className="text-p01-chrome/60 text-[10px] font-mono">
                    {timeAgo(order.createdAt)}
                  </span>
                </div>
              </div>
            </div>

            {/* Payment methods */}
            <div className="flex items-center justify-between">
              <div className="flex gap-1">
                {order.paymentMethods.map((m) => (
                  <span
                    key={m}
                    className="text-[8px] font-mono uppercase px-1.5 py-0.5 rounded"
                    style={{
                      background: `${PAYMENT_COLORS[m] || '#555'}15`,
                      color: PAYMENT_COLORS[m] || '#888',
                      border: `1px solid ${PAYMENT_COLORS[m] || '#555'}25`,
                    }}
                  >
                    {m}
                  </span>
                ))}
              </div>
              <button
                onClick={() => handleTakeOrder(order)}
                disabled={!publicKey}
                className="px-3 py-1.5 text-[10px] font-display font-bold uppercase tracking-wider rounded-lg text-white disabled:opacity-30"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #7c3aed)' }}
              >
                {tab === 'buy' ? 'Buy' : 'Sell'}
              </button>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Bottom: open full Mugen site */}
      <div className="px-3 pb-3">
        <button
          onClick={() => window.open('https://mugen-exchange.vercel.app', '_blank')}
          className="w-full py-2 flex items-center justify-center gap-2 bg-p01-dark border border-p01-border rounded-lg text-p01-chrome text-xs font-mono hover:text-white transition-colors"
        >
          <ExternalLink className="w-3 h-3" />
          Open Mugen Exchange Full Site
        </button>
      </div>
    </div>
  );
}
