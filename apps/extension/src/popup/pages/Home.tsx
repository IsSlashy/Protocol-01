import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  ArrowDownLeft,
  Repeat,
  Share2,
  Copy,
  Check,
  Settings,
  ChevronRight,
  RefreshCw,
  Loader2,
  Clock,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { usePrivacyStore } from '@/shared/store/privacy';
import { useShieldedStore } from '@/shared/store/shielded';
import { getSolscanUrl } from '@/shared/services/transactions';
import {
  formatCurrency,
  truncateAddress,
  copyToClipboard,
  formatRelativeTime,
  cn,
} from '@/shared/utils';
import { getSolPrice } from '@/shared/services/price';
import type { TransactionRecord } from '@/shared/types';

export default function Home() {
  const navigate = useNavigate();
  const {
    publicKey,
    solBalance,
    tokens,
    network,
    isRefreshing,
    isUnlocked,
    refreshBalance,
    requestFaucet,
    transactions,
    isLoadingTransactions,
    fetchTransactions,
  } = useWalletStore();
  const { config: privacyConfig, walletPrivacyScore } = usePrivacyStore();
  const { shieldedBalance, isInitialized: shieldedInitialized } = useShieldedStore();

  const [copied, setCopied] = useState(false);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetSuccess, setFaucetSuccess] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [solPrice, setSolPrice] = useState<number>(0);

  // Redirect to unlock if wallet is locked
  useEffect(() => {
    if (!isUnlocked) {
      navigate('/unlock');
    }
  }, [isUnlocked, navigate]);

  // Fetch SOL price
  useEffect(() => {
    const fetchPrice = async () => {
      const price = await getSolPrice();
      setSolPrice(price);
    };
    fetchPrice();
    // Refresh price every minute
    const interval = setInterval(fetchPrice, 60000);
    return () => clearInterval(interval);
  }, []);

  const usdValue = solBalance * solPrice;

  // Refresh balance and transactions on mount
  useEffect(() => {
    if (isUnlocked) {
      refreshBalance();
      fetchTransactions();
    }
  }, [isUnlocked]);

  // Get last 3 transactions
  const recentTransactions = transactions.slice(0, 3);

  const handleCopy = async () => {
    if (publicKey) {
      await copyToClipboard(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleFaucet = async () => {
    setFaucetError(null);
    setFaucetLoading(true);
    try {
      await requestFaucet(1);
      setFaucetSuccess(true);
      setTimeout(() => setFaucetSuccess(false), 3000);
    } catch (err) {
      const message = (err as Error).message || 'Faucet request failed';
      setFaucetError(message);
      setTimeout(() => setFaucetError(null), 5000);
    } finally {
      setFaucetLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header - Like Mobile */}
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          {/* 01 Logo */}
          <img
            src="/01-miku.png"
            alt="Protocol 01"
            className="w-9 h-9 rounded-lg object-cover"
          />
          <div className="flex items-center gap-2">
            <span className="text-white font-display font-bold tracking-wide">PROTOCOL</span>
            {network === 'devnet' && (
              <span className="px-2 py-0.5 bg-p01-cyan/20 text-p01-cyan text-[10px] font-mono font-bold rounded tracking-wider">
                DEVNET
              </span>
            )}
            {/* Privacy Zone Badge */}
            {privacyConfig.enabled && (
              <button
                onClick={() => navigate('/privacy')}
                className="flex items-center gap-1 px-2 py-0.5 bg-p01-cyan/20 text-p01-cyan text-[10px] font-mono font-bold rounded tracking-wider hover:bg-p01-cyan/30 transition-colors"
              >
                <ShieldCheck className="w-3 h-3" />
                <span>{walletPrivacyScore}</span>
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
          >
            {copied ? <Check className="w-5 h-5 text-p01-cyan" /> : <Copy className="w-5 h-5" />}
          </button>
          <button
            onClick={() => navigate('/settings')}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto pb-4">
        {/* Balance Card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="mx-4 bg-p01-surface rounded-2xl p-5"
        >
          {/* Wallet Address */}
          <div className="flex items-center justify-center gap-2 text-p01-chrome text-sm mb-1">
            <span>{publicKey ? truncateAddress(publicKey, 6) : '---'}</span>
            <button onClick={handleCopy} className="hover:text-white transition-colors">
              {copied ? <Check className="w-4 h-4 text-p01-cyan" /> : <Copy className="w-4 h-4" />}
            </button>
            <a
              href={`https://solscan.io/account/${publicKey}?cluster=${network}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>

          {/* Big USD Balance */}
          <div className="text-center py-4">
            <div className="flex items-center justify-center gap-2">
              <p className="text-4xl font-display font-bold text-white">
                {formatCurrency(usdValue)}
              </p>
              <button
                onClick={() => refreshBalance()}
                disabled={isRefreshing}
                className="p-1 text-p01-chrome hover:text-white transition-colors"
              >
                <RefreshCw className={cn('w-4 h-4', isRefreshing && 'animate-spin')} />
              </button>
            </div>
            <div className="flex items-center justify-center gap-2 mt-2 text-p01-chrome">
              {/* Solana Icon */}
              <div className="w-4 h-4 rounded-full bg-gradient-to-br from-p01-cyan to-p01-cyan-dim flex items-center justify-center">
                <span className="text-[8px] text-white font-bold">S</span>
              </div>
              <span>{solBalance.toFixed(4)} SOL</span>
            </div>
          </div>
        </motion.div>

        {/* Action Buttons - Round with Different Colors */}
        <div className="flex justify-center gap-6 py-6">
          <ActionButton
            icon={<ArrowUp className="w-5 h-5" />}
            label="Send"
            color="cyan"
            onClick={() => navigate('/send')}
          />
          <ActionButton
            icon={<ArrowDown className="w-5 h-5" />}
            label="Receive"
            color="pink"
            onClick={() => navigate('/receive')}
          />
          <ActionButton
            icon={<Repeat className="w-5 h-5" />}
            label="Swap"
            color="violet"
            onClick={() => navigate('/swap')}
          />
          <ActionButton
            icon={<Share2 className="w-5 h-5" />}
            label="Share"
            color="orange"
            onClick={() => navigate('/receive')}
          />
        </div>

        {/* Faucet Card (Devnet only) */}
        {network === 'devnet' && (
          <motion.button
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            onClick={handleFaucet}
            disabled={faucetLoading}
            className="mx-4 mb-4 bg-p01-surface rounded-xl p-4 flex items-center justify-between w-[calc(100%-2rem)] hover:bg-p01-surface/80 transition-colors"
          >
            <div className="flex items-center gap-3">
              {/* Solana gradient icon */}
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center">
                {faucetLoading ? (
                  <Loader2 className="w-5 h-5 text-white animate-spin" />
                ) : faucetSuccess ? (
                  <Check className="w-5 h-5 text-white" />
                ) : (
                  <span className="text-white font-bold text-sm">S</span>
                )}
              </div>
              <div className="text-left">
                <p className="text-white font-medium">
                  {faucetSuccess ? '+1 SOL Received!' : 'Get Test SOL'}
                </p>
                <p className="text-p01-chrome text-xs">
                  {faucetError || 'Tap to receive 1 SOL from devnet faucet'}
                </p>
              </div>
            </div>
            <ChevronRight className={cn(
              'w-5 h-5',
              faucetSuccess ? 'text-green-500' : faucetError ? 'text-red-400' : 'text-p01-pink'
            )} />
          </motion.button>
        )}

        {/* Shielded Wallet Card */}
        <motion.button
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.15 }}
          onClick={() => navigate('/shielded')}
          className="mx-4 mb-4 bg-gradient-to-r from-p01-surface to-p01-dark rounded-xl p-4 flex items-center justify-between w-[calc(100%-2rem)] hover:from-p01-surface/90 hover:to-p01-dark/90 transition-all border border-p01-cyan/20"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-p01-cyan" />
            </div>
            <div className="text-left">
              <p className="text-white font-medium">Shielded Wallet</p>
              <p className="text-p01-chrome text-xs">
                {shieldedInitialized
                  ? `${shieldedBalance.toFixed(4)} SOL shielded`
                  : 'ZK-protected privacy'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-p01-cyan font-mono bg-p01-cyan/10 px-2 py-0.5 rounded">
              ZK
            </span>
            <ChevronRight className="w-5 h-5 text-p01-cyan" />
          </div>
        </motion.button>

        {/* Assets Section */}
        <div className="px-4">
          <p className="text-p01-chrome text-sm font-display tracking-wider mb-3">ASSETS</p>

          {/* Native SOL - Always show */}
          <motion.div
            initial={{ x: -10, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="bg-p01-surface rounded-xl p-4 flex items-center justify-between mb-2"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-p01-cyan to-p01-cyan-dim flex items-center justify-center">
                <span className="text-white font-bold text-sm">S</span>
              </div>
              <div>
                <p className="text-white font-medium">Solana</p>
                <p className="text-p01-chrome text-xs">SOL</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-white font-medium">{solBalance.toFixed(4)}</p>
              <p className="text-p01-chrome text-xs">{formatCurrency(usdValue)}</p>
            </div>
          </motion.div>

          {/* SPL Tokens */}
          {tokens.map((token, index) => (
            <motion.div
              key={token.mint}
              initial={{ x: -10, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: (index + 1) * 0.05 }}
              className="bg-p01-surface rounded-xl p-4 flex items-center justify-between mb-2"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-cyan-500 to-cyan-700 flex items-center justify-center">
                  <span className="text-white font-bold text-xs">
                    {token.symbol.slice(0, 2)}
                  </span>
                </div>
                <div>
                  <p className="text-white font-medium">{token.symbol}</p>
                  <p className="text-p01-chrome text-xs">{truncateAddress(token.mint, 4)}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-white font-medium">{token.uiBalance}</p>
                <p className="text-p01-chrome text-xs">$0.00</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Recent Activity Section */}
        <div className="px-4 mt-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-p01-chrome text-sm font-display tracking-wider">RECENT ACTIVITY</p>
            <button
              onClick={() => navigate('/activity')}
              className="text-p01-pink text-xs font-medium hover:underline"
            >
              See All
            </button>
          </div>

          {/* Recent transactions or empty state */}
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            {isLoadingTransactions && recentTransactions.length === 0 ? (
              <div className="p-4 flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-p01-cyan animate-spin" />
              </div>
            ) : recentTransactions.length === 0 ? (
              <div className="p-4 flex items-center justify-center">
                <div className="text-center py-4">
                  <Clock className="w-8 h-8 text-p01-chrome/40 mx-auto mb-2" />
                  <p className="text-p01-chrome text-sm">No recent activity</p>
                  <p className="text-p01-chrome/60 text-xs mt-1">
                    Your transactions will appear here
                  </p>
                </div>
              </div>
            ) : (
              <div className="divide-y divide-p01-border">
                {recentTransactions.map((tx, index) => (
                  <RecentTransactionRow
                    key={tx.signature}
                    tx={tx}
                    index={index}
                    network={network}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Action Button Component with Different Colors
function ActionButton({
  icon,
  label,
  color,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  color: 'cyan' | 'pink' | 'violet' | 'orange';
  onClick: () => void;
}) {
  const colorClasses = {
    cyan: 'bg-p01-cyan text-p01-void',
    pink: 'bg-p01-pink text-white',
    violet: 'bg-p01-cyan text-white',
    orange: 'bg-orange-500 text-white',
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={onClick}
        className={cn(
          'w-12 h-12 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95',
          colorClasses[color]
        )}
      >
        {icon}
      </button>
      <span className="text-xs text-p01-chrome">{label}</span>
    </div>
  );
}

// Recent Transaction Row for Home page
function RecentTransactionRow({
  tx,
  index,
  network,
}: {
  tx: TransactionRecord;
  index: number;
  network: string;
}) {
  const getIcon = () => {
    switch (tx.type) {
      case 'send':
        return ArrowUpRight;
      case 'receive':
      case 'claim':
        return ArrowDownLeft;
      case 'swap':
      case 'subscription':
        return Repeat;
      default:
        return ArrowUpRight;
    }
  };

  const getIconColor = () => {
    switch (tx.type) {
      case 'send':
        return 'text-red-400 bg-red-400/10';
      case 'receive':
      case 'claim':
        return 'text-green-400 bg-green-400/10';
      default:
        return 'text-p01-chrome/60 bg-p01-surface';
    }
  };

  const getLabel = () => {
    switch (tx.type) {
      case 'send':
        return tx.counterparty
          ? `Sent to ${truncateAddress(tx.counterparty, 4)}`
          : 'Sent';
      case 'receive':
        return tx.counterparty
          ? `From ${truncateAddress(tx.counterparty, 4)}`
          : 'Received';
      case 'claim':
        return 'Claimed';
      case 'swap':
        return 'Swap';
      case 'subscription':
        return 'Stream';
      default:
        return 'Transaction';
    }
  };

  const Icon = getIcon();
  const iconColor = getIconColor();
  const solscanUrl = getSolscanUrl('tx', tx.signature, network as 'devnet' | 'mainnet-beta');

  return (
    <motion.a
      href={solscanUrl}
      target="_blank"
      rel="noopener noreferrer"
      initial={{ x: -10, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ delay: index * 0.05 }}
      className="flex items-center gap-3 px-3 py-2.5 hover:bg-p01-dark/50 transition-colors"
    >
      {/* Icon */}
      <div
        className={cn(
          'w-8 h-8 rounded-full flex items-center justify-center',
          iconColor
        )}
      >
        <Icon className="w-4 h-4" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{getLabel()}</p>
        <p className="text-xs text-p01-chrome/60">{formatRelativeTime(tx.timestamp)}</p>
      </div>

      {/* Amount */}
      <div className="text-right">
        <p
          className={cn(
            'text-sm font-medium',
            tx.type === 'send' || tx.type === 'subscription'
              ? 'text-red-400'
              : 'text-green-400'
          )}
        >
          {tx.type === 'send' || tx.type === 'subscription' ? '-' : '+'}
          {tx.amount.toFixed(4)} {tx.tokenSymbol}
        </p>
      </div>

      <ExternalLink className="w-3.5 h-3.5 text-p01-chrome/40 flex-shrink-0" />
    </motion.a>
  );
}
