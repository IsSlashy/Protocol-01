import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowUp,
  ArrowUpRight,
  Check,
  Clock,
  Copy,
  Droplet,
  Loader2,
  RefreshCw,
  Settings,
  Shield,
  Wallet as WalletIcon,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useShieldedStore } from '@/shared/store/shielded';
import { useSettingsStore } from '@/shared/store/settings';
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
import Wordmark from '@/popup/components/Wordmark';
import {
  ActionGrid,
  Amount,
  Eyebrow,
  EmptyState,
  Hairline,
  Panel,
  Pill,
  Row,
} from '@/popup/ui';

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
  const { shieldedBalance, isInitialized: shieldedInitialized } = useShieldedStore();
  const { shieldedWalletEnabled, initialize: initSettings } = useSettingsStore();

  // Show legacy shielded card only if toggle on or has funds
  const hasShieldedFunds = shieldedBalance > 0;
  const showShieldedCard = shieldedWalletEnabled || hasShieldedFunds;

  useEffect(() => { initSettings(); }, []);

  const [copied, setCopied] = useState(false);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetSuccess, setFaucetSuccess] = useState(false);
  const [faucetError, setFaucetError] = useState<string | null>(null);
  const [solPrice, setSolPrice] = useState<number>(0);

  // Redirect to unlock if wallet is locked.
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
    /**
     * 🎯 REBUILT 2026-08-23. The old home screen carried a balance header, a
     * three-verb action row, a devnet faucet card, TWO cards pointing at the
     * same shielded screen (one of them advertising itself as a dead end), an
     * asset list and a mini activity feed, and no way to reach a subscription
     * at all. Under a merchant-subscription pivot, the front door did not
     * mention the product.
     *
     * What changed, and why each one:
     *   - ONE copy control. There were two, in the header and in the balance
     *     card, firing the same handler eight lines apart.
     *   - Swap is parked, so the third verb is Shield: the action this product
     *     is for, rather than one it does not do.
     *   - The two shielded cards collapse into one strip, and the "no exit, V1
     *     retired" card is gone. A full-width tappable button that announces
     *     itself as a dead end is worse than no button.
     *   - A subscriptions strip, because the tab bar was the only way in.
     *   - The faucet is a line, not a card above the product. It is test
     *     plumbing and it was outranking the thing being sold.
     *   - SPL rows no longer print a fiat value. It was hardcoded to zero and
     *     shown as fact on every token.
     */
    <div className="flex h-full flex-col bg-p01-void">
      <header className="flex shrink-0 items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Wordmark size={22} showText={true} />
          {network === 'devnet' && <Pill>Devnet</Pill>}
        </div>
        <button
          onClick={() => navigate('/settings')}
          aria-label="Settings"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-muted transition-colors duration-exit hover:text-p01-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
        >
          <Settings className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {/* Balance. The address sits under it as one control, not two. */}
        <div className="py-4 text-center">
          <Amount value={solBalance.toFixed(4)} unit="SOL" size="xl" />
          <p className="mt-1 text-sm text-p01-text-muted tabular">
            {solPrice > 0 ? formatCurrency(usdValue) : " "}
          </p>
          <button
            onClick={handleCopy}
            aria-label={copied ? "Address copied" : "Copy wallet address"}
            className="mx-auto mt-2 flex min-h-[36px] items-center gap-1.5 rounded-lg px-2 text-tiny text-p01-text-dim transition-colors duration-exit hover:text-p01-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
          >
            <span className="font-mono">{truncateAddress(publicKey ?? "", 4)}</span>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-p01-cyan" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>

        <ActionGrid
          actions={[
            { label: "Send", icon: ArrowUp, onClick: () => navigate("/send") },
            { label: "Receive", icon: ArrowDown, onClick: () => navigate("/receive") },
            { label: "Shield", icon: Shield, onClick: () => navigate("/shield") },
            { label: "Subscribe", icon: RefreshCw, onClick: () => navigate("/discover") },
          ]}
        />

        {/* The two strips that were duplicated and missing. */}
        <div className="mt-4 flex flex-col gap-2">
          {shieldedWalletEnabled && (
            <Panel className="p-0 px-3">
              <Row
                icon={Shield}
                label="Private balance"
                sub={
                  shieldedInitialized
                    ? `${shieldedBalance.toFixed(2)} SOL shielded`
                    : "Not set up yet"
                }
                chevron
                onClick={() => navigate("/shield")}
              />
            </Panel>
          )}

          <Panel className="p-0 px-3">
            <Row
              icon={RefreshCw}
              label="Subscriptions"
              sub="Pay a merchant without an account"
              chevron
              onClick={() => navigate("/subscriptions")}
            />
          </Panel>
        </div>

        {/* Assets */}
        <div className="mt-5">
          <Eyebrow>Assets</Eyebrow>
          <div className="mt-1.5">
            <Row icon={WalletIcon} label="SOL" sub="Solana" value={solBalance.toFixed(4)} />
            {tokens.map((token) => (
              <div key={token.mint}>
                <Hairline className="bg-p01-border-soft" />
                {/* No fiat column. It was hardcoded to zero on every token row
                    and printed as though it had been looked up. */}
                <Row
                  label={token.symbol}
                  sub={truncateAddress(token.mint, 4)}
                  value={String(token.uiBalance)}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Activity */}
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <Eyebrow>Recent activity</Eyebrow>
            <button
              onClick={() => navigate("/activity")}
              className="rounded-lg px-2 py-1 text-tiny text-p01-cyan transition-colors duration-exit hover:text-p01-cyan-bright focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
            >
              See all
            </button>
          </div>

          <div className="mt-1.5">
            {isLoadingTransactions && recentTransactions.length === 0 ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-p01-text-dim" aria-hidden="true" />
              </div>
            ) : recentTransactions.length === 0 ? (
              <EmptyState
                icon={Clock}
                title="Nothing yet"
                body="Transactions from this wallet will appear here."
              />
            ) : (
              recentTransactions.map((tx: TransactionRecord, i: number) => (
                <div key={tx.signature}>
                  {i > 0 && <Hairline className="bg-p01-border-soft" />}
                  <Row
                    icon={tx.type === "receive" ? ArrowDownLeft : ArrowUpRight}
                    label={tx.type === "receive" ? "Received" : "Sent"}
                    sub={formatRelativeTime(tx.timestamp)}
                    value={`${tx.type === "receive" ? "+" : "-"}${tx.amount} SOL`}
                    onClick={() => window.open(getSolscanUrl("tx", tx.signature, network), "_blank")}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Faucet. A line, at the bottom, where test plumbing belongs. */}
        {network === "devnet" && (
          <div className="mt-5">
            <Hairline className="bg-p01-border-soft" />
            <button
              onClick={handleFaucet}
              disabled={faucetLoading}
              className="flex min-h-[44px] w-full items-center gap-2 text-left text-tiny text-p01-text-dim transition-colors duration-exit hover:text-p01-text-muted disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
            >
              {faucetLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Droplet className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {faucetSuccess ? "Airdropped 1 SOL" : "Get test SOL"}
            </button>
            {/* The failure used to replace the button's own subtitle and clear
                itself after five seconds, so a rejected airdrop could vanish
                before it was read. It stays until the next attempt. */}
            {faucetError && (
              <p role="alert" className="mt-1 text-tiny text-p01-red">
                {faucetError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
