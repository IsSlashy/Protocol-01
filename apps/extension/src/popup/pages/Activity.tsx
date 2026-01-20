import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowUpRight,
  ArrowDownLeft,
  Repeat,
  Shield,
  ExternalLink,
  Filter,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { cn, formatCurrency, truncateAddress, formatRelativeTime } from '@/shared/utils';
import { getSolscanUrl } from '@/shared/services/transactions';
import { getSolPrice } from '@/shared/services/price';
import type { TransactionRecord } from '@/shared/types';

type FilterType = 'all' | 'send' | 'receive' | 'subscription';

export default function Activity() {
  const [filter, setFilter] = useState<FilterType>('all');
  const [solPrice, setSolPrice] = useState<number>(0);
  const {
    transactions,
    isLoadingTransactions,
    fetchTransactions,
    network,
  } = useWalletStore();

  // Fetch transactions and SOL price on mount
  useEffect(() => {
    fetchTransactions();
    getSolPrice().then(setSolPrice);
  }, []);

  const filteredTxs = transactions.filter((tx) => {
    if (filter === 'all') return true;
    if (filter === 'send') return tx.type === 'send';
    if (filter === 'receive') return tx.type === 'receive' || tx.type === 'claim';
    if (filter === 'subscription') return tx.type === 'subscription';
    return true;
  });

  const handleRefresh = () => {
    fetchTransactions();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filter Bar */}
      <div className="px-4 py-3 border-b border-p01-border">
        <div className="flex items-center justify-between">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {(['all', 'send', 'receive', 'subscription'] as FilterType[]).map(
              (f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors capitalize',
                    filter === f
                      ? 'bg-p01-cyan/20 text-p01-cyan'
                      : 'bg-p01-surface text-p01-chrome/60 hover:text-white'
                  )}
                >
                  {f === 'subscription' ? 'Streams' : f}
                </button>
              )
            )}
          </div>
          <button
            onClick={handleRefresh}
            disabled={isLoadingTransactions}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
          >
            <RefreshCw
              className={cn('w-4 h-4', isLoadingTransactions && 'animate-spin')}
            />
          </button>
        </div>
      </div>

      {/* Transactions List */}
      <div className="flex-1 overflow-y-auto">
        {isLoadingTransactions && transactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48">
            <Loader2 className="w-8 h-8 text-p01-cyan animate-spin mb-3" />
            <p className="text-sm text-p01-chrome/60">Loading transactions...</p>
          </div>
        ) : filteredTxs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center px-4">
            <Filter className="w-12 h-12 text-p01-chrome/40 mb-3" />
            <p className="text-sm text-p01-chrome/60">
              {transactions.length === 0
                ? 'No transactions yet'
                : 'No transactions found'}
            </p>
            <p className="text-xs text-p01-chrome/40 mt-1">
              {transactions.length === 0
                ? 'Your transaction history will appear here'
                : 'Try a different filter'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-p01-border">
            {filteredTxs.map((tx, index) => (
              <TransactionRow
                key={tx.signature}
                tx={tx}
                index={index}
                network={network}
                solPrice={solPrice}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TransactionRow({
  tx,
  index,
  network,
  solPrice,
}: {
  tx: TransactionRecord;
  index: number;
  network: string;
  solPrice: number;
}) {
  const getIcon = () => {
    switch (tx.type) {
      case 'send':
        return ArrowUpRight;
      case 'receive':
      case 'claim':
        return ArrowDownLeft;
      case 'swap':
        return Repeat;
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
      case 'swap':
        return 'text-blue-400 bg-blue-400/10';
      case 'subscription':
        return 'text-streams bg-streams/10';
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
        return 'Claimed stealth payment';
      case 'swap':
        return 'Swapped tokens';
      case 'subscription':
        return tx.counterparty || 'Subscription payment';
      default:
        return 'Transaction';
    }
  };

  const getStatusBadge = () => {
    if (tx.status === 'pending') {
      return (
        <span className="px-1.5 py-0.5 text-[9px] font-mono bg-yellow-500/20 text-yellow-500 rounded">
          PENDING
        </span>
      );
    }
    if (tx.status === 'failed') {
      return (
        <span className="px-1.5 py-0.5 text-[9px] font-mono bg-red-500/20 text-red-400 rounded">
          FAILED
        </span>
      );
    }
    return null;
  };

  const Icon = getIcon();
  const iconColor = getIconColor();
  const solscanUrl = getSolscanUrl('tx', tx.signature, network as any);

  return (
    <motion.a
      href={solscanUrl}
      target="_blank"
      rel="noopener noreferrer"
      initial={{ x: -10, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ delay: index * 0.03 }}
      className="flex items-center gap-3 px-4 py-3 hover:bg-p01-surface/50 transition-colors"
    >
      {/* Icon */}
      <div
        className={cn(
          'w-10 h-10 rounded-full flex items-center justify-center',
          iconColor
        )}
      >
        <Icon className="w-5 h-5" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-white truncate">{getLabel()}</p>
          {tx.isPrivate && (
            <Shield className="w-3.5 h-3.5 text-p01-cyan flex-shrink-0" />
          )}
          {getStatusBadge()}
        </div>
        <div className="flex items-center gap-2 text-xs text-p01-chrome/60">
          <span>{formatRelativeTime(tx.timestamp)}</span>
          {tx.fee > 0 && (
            <>
              <span className="text-p01-chrome/30">|</span>
              <span>Fee: {tx.fee.toFixed(6)} SOL</span>
            </>
          )}
        </div>
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
        {tx.tokenSymbol === 'SOL' && solPrice > 0 && (
          <p className="text-xs text-p01-chrome/60">
            {formatCurrency(tx.amount * solPrice)}
          </p>
        )}
      </div>

      <ExternalLink className="w-4 h-4 text-p01-chrome/40 flex-shrink-0" />
    </motion.a>
  );
}
