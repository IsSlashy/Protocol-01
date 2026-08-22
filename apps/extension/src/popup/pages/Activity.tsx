/**
 * Activity: the transaction history.
 *
 * 🚨 EVERY ROW WAS AN EXTERNAL LINK, AND THAT IS WHY THIS SCREEN EXISTED ONCE
 * PER SESSION. The whole row was an `<a target="_blank">` to Solscan, so the
 * only thing a user could do with their own history was leave the wallet. A
 * popup closes the moment focus goes to a new tab, so tapping a row to read it
 * — which is what a row that looks like a list item invites — destroyed the
 * screen the user was reading. There was no way to see a signature, a fee or
 * a counterparty without that happening.
 *
 * A row now expands in place. The block explorer is still reachable, as one
 * explicit link inside the expanded row, where leaving is a choice rather than
 * the only gesture available.
 *
 * ⚠️ IT ALSO HAD NO HEADER AT ALL. `MainLayout` renders no title bar — every
 * page brings its own — and this one brought a filter bar instead, so the
 * screen reached from "View all" on the wallet opened with no name and no way
 * back except the tab bar. It uses `Screen` now, like everything else.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  ArrowDownLeft,
  Inbox,
  Repeat,
  Shield,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { cn, formatCurrency, truncateAddress, formatRelativeTime } from '@/shared/utils';
import { getSolscanUrl } from '@/shared/services/transactions';
import { getSolPrice } from '@/shared/services/price';
import { EmptyState, Hairline, Pill, Screen } from '@/popup/ui';
import type { TransactionRecord } from '@/shared/types';

type FilterType = 'all' | 'send' | 'receive' | 'subscription';

/** The stored value is not the word a person reads. */
const FILTER_LABELS: Record<FilterType, string> = {
  all: 'All',
  send: 'Sent',
  receive: 'Received',
  subscription: 'Streams',
};

export default function Activity() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FilterType>('all');
  const [solPrice, setSolPrice] = useState<number>(0);
  /** Which row is open. One at a time: this is a 360px column. */
  const [openSignature, setOpenSignature] = useState<string | null>(null);
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
    <Screen
      title="Activity"
      onBack={() => navigate(-1)}
      action={
        <button
          onClick={handleRefresh}
          disabled={isLoadingTransactions}
          aria-label="Refresh transactions"
          className={cn(
            'flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-muted',
            'transition-colors duration-exit hover:text-p01-text',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
            isLoadingTransactions && 'cursor-not-allowed opacity-40',
          )}
        >
          <RefreshCw
            className={cn('h-[18px] w-[18px]', isLoadingTransactions && 'animate-spin')}
            aria-hidden="true"
          />
        </button>
      }
    >
      {/* ── Filters ── */}
      <div className="flex gap-2">
        {(Object.keys(FILTER_LABELS) as FilterType[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={cn(
              'min-h-[44px] flex-1 rounded-lg border px-2 text-tiny transition-colors duration-exit',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
              filter === f
                ? 'border-p01-cyan bg-p01-cyan/10 text-p01-text'
                : 'border-p01-border text-p01-text-muted hover:border-p01-border-light',
            )}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* ── The list ── */}
      {isLoadingTransactions && transactions.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-10">
          <RefreshCw className="h-4 w-4 animate-spin text-p01-text-dim" aria-hidden="true" />
          <p className="text-sm text-p01-text-muted">Loading your history</p>
        </div>
      ) : filteredTxs.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={transactions.length === 0 ? 'Nothing yet' : 'Nothing under this filter'}
          body={
            transactions.length === 0
              ? 'Anything you send, receive or subscribe to shows up here.'
              : `No ${FILTER_LABELS[filter].toLowerCase()} transactions. Try another filter.`
          }
        />
      ) : (
        <div className="mt-1">
          {filteredTxs.map((tx, i) => (
            <div key={tx.signature}>
              {i > 0 && <Hairline className="bg-p01-border-soft" />}
              <TransactionRow
                tx={tx}
                network={network}
                solPrice={solPrice}
                open={openSignature === tx.signature}
                onToggle={() =>
                  setOpenSignature(openSignature === tx.signature ? null : tx.signature)
                }
              />
            </div>
          ))}
        </div>
      )}
    </Screen>
  );
}

function TransactionRow({
  tx,
  network,
  solPrice,
  open,
  onToggle,
}: {
  tx: TransactionRecord;
  network: string;
  solPrice: number;
  open: boolean;
  onToggle: () => void;
}) {
  const incoming = tx.type === 'receive' || tx.type === 'claim';

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

  const Icon = getIcon();
  const solscanUrl = getSolscanUrl('tx', tx.signature, network as any);

  return (
    <div>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex min-h-[44px] w-full items-center gap-3 rounded-lg py-3 text-left',
          'transition-colors duration-exit hover:bg-p01-surface',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
        )}
      >
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
            incoming
              ? 'border-p01-cyan/40 bg-p01-cyan/10'
              : 'border-p01-border-soft bg-p01-surface',
          )}
        >
          <Icon
            className={cn('h-4 w-4', incoming ? 'text-p01-cyan' : 'text-p01-text-muted')}
            aria-hidden="true"
          />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm text-p01-text">{getLabel()}</span>
            {tx.isPrivate && (
              <Shield className="h-3.5 w-3.5 shrink-0 text-p01-cyan" aria-label="Private" />
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className="text-tiny text-p01-text-dim">
              {formatRelativeTime(tx.timestamp)}
            </span>
            {tx.status === 'pending' && <Pill tone="warn">Pending</Pill>}
            {tx.status === 'failed' && <Pill tone="bad">Failed</Pill>}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span
            className={cn(
              'block text-sm tabular',
              incoming ? 'text-p01-cyan' : 'text-p01-text',
            )}
          >
            {incoming ? '+' : '-'}
            {tx.amount.toFixed(4)} {tx.tokenSymbol}
          </span>
          {tx.tokenSymbol === 'SOL' && solPrice > 0 && (
            <span className="block text-tiny text-p01-text-dim tabular">
              {formatCurrency(tx.amount * solPrice)}
            </span>
          )}
        </span>
      </button>

      {/* Detail, in place. Reading a transaction no longer costs the popup. */}
      {open && (
        <div className="pb-3 pl-12">
          <p className="select-all break-all font-mono text-tiny text-p01-text-dim">
            {tx.signature}
          </p>
          {tx.fee > 0 && (
            <p className="mt-1 text-tiny text-p01-text-muted tabular">
              Network fee {tx.fee.toFixed(6)} SOL
            </p>
          )}
          {/* ⚠️ Leaving the popup is now one deliberate link, not the whole
              row. Opening a tab closes this window; that is the browser, not
              something the screen can soften, so it must not be the default
              gesture. */}
          <a
            href={solscanUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'mt-1 inline-flex min-h-[44px] items-center gap-1.5 text-tiny text-p01-cyan',
              'transition-colors duration-exit hover:text-p01-cyan-bright',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan',
            )}
          >
            Open in Solscan
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
      )}
    </div>
  );
}
