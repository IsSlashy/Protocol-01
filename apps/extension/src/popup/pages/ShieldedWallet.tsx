import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Shield,
  ShieldCheck,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Copy,
  Check,
  RefreshCw,
  Loader2,
  Info,
  ChevronRight,
  Zap,
  Clock,
  AlertTriangle,
  Scan,
  Layers,
  Calendar,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useShieldedStore } from '@/shared/store/shielded';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { useConfidentialStore } from '@/shared/store/confidential';
import { cn, truncateAddress, copyToClipboard } from '@/shared/utils';

export default function ShieldedWallet() {
  const navigate = useNavigate();
  const { publicKey, solBalance } = useWalletStore();
  const {
    isInitialized,
    isLoading,
    shieldedBalance,
    notes,
    zkAddress,
    pendingTransactions,
    initialize,
    refreshBalance,
    shield,
    unshield,
    syncFromBlockchain,
    clearNotes,
    scanStealthPayments,
    sweepAllStealthPayments,
  } = useShieldedStore();

  // Denominated V3 notes are the real shielded funds (the working Goldilocks
  // path). Surface them in the balance + funds list alongside any legacy notes.
  const denomNotes = useDenominatedPoolStore((s) => s.serializedNotes);
  const denomBalanceSol = denomNotes
    .filter((n) => n.token === 'SOL')
    .reduce((sum, n) => sum + n.denominationHuman, 0);
  const displayNotes = [
    ...denomNotes.map((n) => ({
      label: `${n.denominationHuman} ${n.token}`,
      index: n.leafIndex as number | undefined,
      tag: String(n.commitment ?? '').slice(0, 8),
    })),
    ...notes.map((n) => ({
      label: `${(Number(n.amount) / 1e9).toFixed(4)} SOL`,
      index: n.leafIndex as number | undefined,
      tag: String(n.commitment ?? '').slice(0, 8),
    })),
  ];

  // Confidential (zkSPL) store
  const {
    isInitialized: confInitialized,
    isLoading: confLoading,
    displayBalance: confBalance,
    hasAccount: confHasAccount,
    pendingCredits: confPendingCredits,
    initialize: confInitialize,
  } = useConfidentialStore();

  // Initialize confidential store alongside shielded
  useEffect(() => {
    if (publicKey) {
      confInitialize().catch(err => {
        console.warn('[ShieldedWallet] Confidential init error:', err);
      });
    }
  }, [publicKey]);

  const [showBalance, setShowBalance] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [actionModal, setActionModal] = useState<'shield' | 'unshield' | null>(null);
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string } | null>(null);

  // Stealth recovery state
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [foundPayments, setFoundPayments] = useState<Array<{ stealthAddress: string; amount: number; signature: string }>>([]);

  // Initialize shielded wallet on mount
  // Always call initialize - it handles the guard internally and recreates _zkService if needed
  useEffect(() => {
    if (publicKey) {
      setInitError(null);
      initialize().catch(err => {
        console.error('[ShieldedWallet] Init error:', err);
        setInitError((err as Error).message);
      });
    }
  }, [publicKey]);

  const handleCopyAddress = async () => {
    if (zkAddress) {
      await copyToClipboard(zkAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSyncFromBlockchain = async () => {
    setIsSyncing(true);
    setSyncResult(null);
    try {
      const result = await syncFromBlockchain();
      if (result.success) {
        setSyncResult({ success: true, message: 'Tree synced successfully! Root matches on-chain.' });
      } else {
        setSyncResult({
          success: false,
          message: `Root mismatch! Local: ${result.localRoot.slice(0, 20)}... On-chain: ${result.onChainRoot.slice(0, 20)}...`
        });
      }
    } catch (err) {
      setSyncResult({ success: false, message: (err as Error).message });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleClearNotes = async () => {
    if (!confirm('Clear all notes? This cannot be undone. The Merkle tree will be preserved.')) {
      return;
    }
    try {
      await clearNotes();
      setSyncResult({ success: true, message: 'Notes cleared. Tree preserved.' });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleFullReset = async () => {
    if (!confirm('FULL RESET: Clear ALL shielded data (notes, tree, ZK state)? This cannot be undone.')) {
      return;
    }
    try {
      // Clear chrome storage for shielded store
      await chrome.storage.local.remove(['p01-shielded', 'p01_privy_zk_seed', 'p01_local_subtrees']);
      // Reset zustand store
      const { reset } = useShieldedStore.getState();
      reset();
      setSyncResult({ success: true, message: 'Full reset complete. Please re-initialize.' });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleShield = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      await shield(parseFloat(amount));
      setActionModal(null);
      setAmount('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUnshield = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    if (parseFloat(amount) > shieldedBalance) {
      setError('Insufficient shielded balance');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      await unshield(parseFloat(amount));
      setActionModal(null);
      setAmount('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  // Stealth recovery handlers
  const handleOpenRecovery = async () => {
    setShowRecoveryModal(true);
    setFoundPayments([]);
    await handleScanStealth();
  };

  const handleScanStealth = async () => {
    setIsScanning(true);
    try {
      const result = await scanStealthPayments();
      setFoundPayments(result.payments);
    } catch (err) {
      console.error('[Recovery] Scan error:', err);
      setError((err as Error).message);
    } finally {
      setIsScanning(false);
    }
  };

  const handleSweepAll = async () => {
    if (!publicKey) {
      setError('Wallet not connected');
      return;
    }

    setIsSweeping(true);
    setError(null);
    try {
      const result = await sweepAllStealthPayments(publicKey);

      if (result.swept > 0) {
        // Show partial or full success
        const msg = result.errors.length > 0
          ? `Recovered ${result.totalAmount.toFixed(4)} SOL from ${result.swept} payment(s). ${result.errors.length} payment(s) failed.`
          : `Recovered ${result.totalAmount.toFixed(4)} SOL from ${result.swept} stealth payment(s)!`;
        alert(msg);
        setFoundPayments([]);
        setShowRecoveryModal(false);
        await refreshBalance();
      } else if (result.errors.length > 0) {
        setError(result.errors.join('\n'));
      } else {
        // swept === 0 and no errors means nothing was found (already swept or dust)
        setError(null);
        alert('No sweepable payments found. Payments may have already been swept or are below the dust threshold.');
      }
    } catch (err) {
      console.error('[Recovery] Sweep error:', err);
      setError((err as Error).message);
    } finally {
      setIsSweeping(false);
    }
  };

  const formatShieldedBalance = () => {
    if (!showBalance) return '****';
    return `${(shieldedBalance + denomBalanceSol).toFixed(4)} SOL`;
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border bg-p01-surface">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-p01-cyan" />
            <h1 className="text-white font-display font-bold tracking-wide">Shielded Wallet</h1>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleFullReset}
            className="p-2 text-red-400 hover:text-red-300 transition-colors"
            title="Full Reset ZK State"
            aria-label="Full reset"
          >
            <AlertTriangle className="w-4 h-4" />
          </button>
          <button
            onClick={handleSyncFromBlockchain}
            disabled={isSyncing || !isInitialized}
            className="p-2 text-p01-chrome hover:text-white transition-colors disabled:opacity-50"
            title="Sync from Blockchain"
            aria-label="Sync from blockchain"
          >
            <RefreshCw className={cn('w-5 h-5', isSyncing && 'animate-spin')} />
          </button>
          <button
            onClick={() => setShowBalance(!showBalance)}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
            aria-label={showBalance ? 'Hide balance' : 'Show balance'}
          >
            {showBalance ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
          </button>
          <button
            onClick={() => setShowInfoModal(true)}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
            aria-label="Show info"
          >
            <Info className="w-5 h-5" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {/* Shielded Balance Card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="mx-4 mt-4 bg-p01-gradient-card rounded-2xl p-5 border border-p01-cyan/20"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-p01-cyan" />
              <span className="text-p01-chrome text-sm">Shielded Balance</span>
            </div>
            <button
              onClick={() => refreshBalance()}
              disabled={isLoading}
              className="p-1 text-p01-chrome hover:text-white transition-colors"
              aria-label="Refresh shielded balance"
            >
              <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
            </button>
          </div>

          <div className="text-center py-4">
            <div className="flex items-center justify-center gap-2">
              <Lock className="w-6 h-6 text-p01-cyan/60" />
              <p className="text-3xl font-display font-bold text-white">
                {isLoading ? (
                  <Loader2 className="w-8 h-8 animate-spin text-p01-cyan" />
                ) : (
                  formatShieldedBalance()
                )}
              </p>
            </div>
            <p className="text-p01-chrome text-xs mt-2">
              Fully private • Zero-knowledge protected
            </p>
          </div>

          {/* ZK Address */}
          <div className="bg-p01-void/50 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-p01-chrome text-xs">ZK Address</span>
              </div>
              <button
                onClick={handleCopyAddress}
                className="flex items-center gap-1 text-p01-cyan text-xs hover:text-p01-cyan/80 transition-colors"
                aria-label={copied ? 'ZK address copied' : 'Copy ZK address'}
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-white text-xs font-mono mt-1 truncate">
              {zkAddress || (isLoading ? 'Initializing...' : 'Not initialized')}
            </p>
          </div>

          {/* Init Error */}
          {initError && (
            <div className="mt-3 p-3 bg-red-500/10 rounded-lg border border-red-500/30" role="alert" aria-live="polite">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-red-400 text-xs">{initError}</p>
                  <button
                    onClick={() => {
                      setInitError(null);
                      initialize().catch(err => setInitError((err as Error).message));
                    }}
                    className="mt-2 text-xs text-p01-cyan hover:underline"
                  >
                    Retry initialization
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Sync Result */}
          {syncResult && (
            <div role="status" aria-live="polite" className={cn(
              'mt-3 p-3 rounded-lg border',
              syncResult.success
                ? 'bg-p01-cyan/10 border-p01-cyan/30'
                : 'bg-warning/10 border-warning/30'
            )}>
              <div className="flex items-start gap-2">
                {syncResult.success ? (
                  <Check className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1">
                  <p className={cn('text-xs', syncResult.success ? 'text-p01-cyan' : 'text-warning')}>
                    {syncResult.message}
                  </p>
                  <button
                    onClick={() => setSyncResult(null)}
                    className="mt-2 text-xs text-p01-chrome hover:underline"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}
        </motion.div>

        {/* Action Buttons */}
        <div className="flex justify-center gap-4 py-6">
          <ActionButton
            icon={<ArrowDown className="w-5 h-5" />}
            label="Shield"
            color="cyan"
            onClick={() => setActionModal('shield')}
          />
          <ActionButton
            icon={<ArrowUp className="w-5 h-5" />}
            label="Unshield"
            color="pink"
            onClick={() => setActionModal('unshield')}
            disabled={shieldedBalance <= 0}
          />
          <ActionButton
            icon={<Zap className="w-5 h-5" />}
            label="Transfer"
            color="violet"
            onClick={() => navigate('/shielded/transfer')}
            disabled={shieldedBalance <= 0}
          />
          <ActionButton
            icon={<Scan className="w-5 h-5" />}
            label="Recover"
            color="green"
            onClick={handleOpenRecovery}
          />
        </div>

        {/* Transparent Balance Info */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="mx-4"
        >
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            TRANSPARENT BALANCE
          </p>
          <div className="bg-p01-surface rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-p01-cyan to-p01-cyan-dim flex items-center justify-center">
                <Unlock className="w-5 h-5 text-white" />
              </div>
              <div>
                <p className="text-white font-medium">{solBalance.toFixed(4)} SOL</p>
                <p className="text-p01-chrome text-xs">Available to shield</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-p01-chrome" />
          </div>
        </motion.div>

        {/* Pending Transactions */}
        {pendingTransactions.length > 0 && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="mx-4 mt-4"
          >
            <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
              PENDING
            </p>
            <div className="bg-p01-surface rounded-xl overflow-hidden">
              {pendingTransactions.map((tx, index) => (
                <div
                  key={tx.id}
                  className={cn(
                    'p-4 flex items-center justify-between',
                    index < pendingTransactions.length - 1 && 'border-b border-p01-border/50'
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center">
                      <Clock className="w-5 h-5 text-yellow-400 animate-pulse" />
                    </div>
                    <div>
                      <p className="text-white font-medium capitalize">{tx.type}</p>
                      <p className="text-p01-chrome text-xs">
                        {tx.status === 'generating_proof' ? 'Generating ZK proof...' : 'Processing...'}
                      </p>
                    </div>
                  </div>
                  <Loader2 className="w-5 h-5 text-p01-cyan animate-spin" />
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {/* Shielded Notes */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="mx-4 mt-4"
        >
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            SHIELDED FUNDS ({displayNotes.length})
          </p>
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            {displayNotes.length === 0 ? (
              <div className="p-6 text-center">
                <Shield className="w-10 h-10 text-p01-chrome/30 mx-auto mb-2" />
                <p className="text-p01-chrome text-sm">No shielded funds yet</p>
                <p className="text-p01-chrome/60 text-xs mt-1">
                  Shield some SOL to start using private transactions
                </p>
              </div>
            ) : (
              <div className="divide-y divide-p01-border/50">
                {displayNotes.slice(0, 5).map((note, index) => (
                  <div key={index} className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                        <Lock className="w-5 h-5 text-p01-cyan" />
                      </div>
                      <div>
                        <p className="text-white font-medium font-mono">
                          {showBalance ? note.label : '****'}
                        </p>
                        <p className="text-p01-chrome text-xs">
                          Index: {note.index ?? 'pending'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-p01-chrome/60 text-xs font-mono">
                        {note.tag}
                      </p>
                    </div>
                  </div>
                ))}
                {displayNotes.length > 5 && (
                  <button className="w-full p-3 text-center text-p01-cyan text-sm hover:bg-p01-void/50 transition-colors">
                    View all {displayNotes.length} entries
                  </button>
                )}
              </div>
            )}
          </div>
        </motion.div>

        {/* Privacy Info Card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="mx-4 mt-4 mb-4"
        >
          <div className="bg-p01-gradient-card rounded-2xl p-4 border border-p01-cyan/20">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center flex-shrink-0">
                <ShieldCheck className="w-5 h-5 text-p01-cyan" />
              </div>
              <div>
                <p className="text-white font-medium">ZK-STARK Protection</p>
                <p className="text-p01-chrome text-xs mt-1">
                  Your shielded transactions use post-quantum STARK proofs. No one can see amounts, senders, or recipients on-chain.
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Shield/Unshield Modal */}
      {actionModal && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="shield-modal-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className={cn(
                'w-12 h-12 rounded-full flex items-center justify-center',
                actionModal === 'shield' ? 'bg-p01-cyan/20' : 'bg-p01-pink/20'
              )}>
                {actionModal === 'shield' ? (
                  <ArrowDown className="w-6 h-6 text-p01-cyan" />
                ) : (
                  <ArrowUp className="w-6 h-6 text-p01-pink" />
                )}
              </div>
              <div>
                <h3 id="shield-modal-title" className="text-lg font-display font-bold text-white capitalize">
                  {actionModal} SOL
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  {actionModal === 'shield'
                    ? 'Move SOL into shielded pool'
                    : 'Withdraw from shielded pool'}
                </p>
              </div>
            </div>

            {/* Amount Input */}
            <div className="mb-4">
              <div className="bg-p01-void rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-p01-chrome text-xs">Amount</span>
                  <button
                    onClick={() => {
                      const max = actionModal === 'shield' ? solBalance : shieldedBalance;
                      setAmount(max.toString());
                    }}
                    className="text-p01-cyan text-xs hover:underline"
                  >
                    Max: {actionModal === 'shield'
                      ? `${solBalance.toFixed(4)} SOL`
                      : `${shieldedBalance.toFixed(4)} SOL`}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0"
                    aria-label="Amount in SOL"
                    className="flex-1 bg-transparent text-2xl font-display font-bold text-white outline-none"
                  />
                  <span className="text-p01-chrome text-lg">SOL</span>
                </div>
              </div>
            </div>

            {/* Warning for first-time users */}
            {actionModal === 'shield' && notes.length === 0 && (
              <div className="mb-4 p-3 bg-warning/10 rounded-lg flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                <p className="text-p01-chrome text-xs">
                  Proof generation may take 30-60 seconds on first use while circuits are loaded.
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 rounded-lg" role="alert" aria-live="polite">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setActionModal(null);
                  setAmount('');
                  setError(null);
                }}
                disabled={isProcessing}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={actionModal === 'shield' ? handleShield : handleUnshield}
                disabled={isProcessing || !amount || parseFloat(amount) <= 0}
                className={cn(
                  'flex-1 py-3 font-medium rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2',
                  actionModal === 'shield'
                    ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
                    : 'bg-p01-pink text-white hover:bg-p01-pink/90'
                )}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>{actionModal === 'shield' ? 'Shield' : 'Unshield'}</>
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Info Modal */}
      {showInfoModal && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="shielded-info-title">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-h-[80%] bg-p01-surface rounded-2xl p-5 overflow-y-auto"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-p01-cyan" />
              </div>
              <div>
                <h3 id="shielded-info-title" className="text-lg font-display font-bold text-white">
                  Shielded Transactions
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  Zcash-style privacy on Solana
                </p>
              </div>
            </div>

            <div className="space-y-4 text-sm">
              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">How it works</h4>
                <p className="text-p01-chrome/80">
                  Shielded transactions use zero-knowledge proofs (ZK-SNARKs) to hide
                  amounts, senders, and recipients while proving the transaction is valid.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">Shield</h4>
                <p className="text-p01-chrome/80">
                  Convert transparent SOL into shielded notes. Your deposit amount is visible,
                  but from then on, all movements are completely private.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">Transfer</h4>
                <p className="text-p01-chrome/80">
                  Send shielded SOL to any ZK address. The amount, sender, and recipient
                  are all hidden. Only you and the recipient know the details.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">Unshield</h4>
                <p className="text-p01-chrome/80">
                  Withdraw shielded SOL back to a transparent address. The withdrawal
                  amount becomes visible, but the source remains hidden.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">Notes & Nullifiers</h4>
                <p className="text-p01-chrome/80">
                  Each shielded balance is stored as encrypted "notes" in a Merkle tree.
                  When spent, a nullifier prevents double-spending without revealing which note was used.
                </p>
              </div>
            </div>

            <button
              onClick={() => setShowInfoModal(false)}
              className="w-full mt-4 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan/90 transition-colors"
            >
              Got it
            </button>
          </motion.div>
        </div>
      )}

      {/* Recovery Modal */}
      {showRecoveryModal && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="recovery-modal-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                <Scan className="w-6 h-6 text-p01-cyan" />
              </div>
              <div>
                <h3 id="recovery-modal-title" className="text-lg font-display font-bold text-white">
                  Recover Private Funds
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  Scan for stealth payments
                </p>
              </div>
            </div>

            {/* Scanning Status */}
            {isScanning && (
              <div className="mb-4 p-4 bg-p01-cyan/10 rounded-xl flex items-center gap-3" aria-live="polite">
                <Loader2 className="w-5 h-5 text-p01-cyan animate-spin" aria-hidden="true" />
                <span className="text-p01-cyan text-sm">Scanning for payments...</span>
              </div>
            )}

            {/* Found Payments */}
            {!isScanning && foundPayments.length > 0 && (
              <div className="mb-4 bg-p01-void rounded-xl p-4">
                <p className="text-p01-cyan text-sm font-medium mb-3">
                  Found {foundPayments.length} payment(s)
                </p>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {foundPayments.map((payment, index) => (
                    <div key={index} className="flex items-center gap-2 py-2 border-b border-p01-border/50 last:border-0">
                      <Check className="w-4 h-4 text-p01-cyan" />
                      <div className="flex-1">
                        <p className="text-white text-sm font-medium">{payment.amount} SOL</p>
                        <p className="text-p01-chrome text-xs font-mono truncate">
                          {payment.stealthAddress.slice(0, 12)}...{payment.stealthAddress.slice(-8)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-p01-chrome/60 text-xs mt-3">
                  Your spending key is derived locally. Tap Sweep to recover funds directly to your wallet.
                </p>
              </div>
            )}

            {/* No Payments Found */}
            {!isScanning && foundPayments.length === 0 && (
              <div className="mb-4 p-6 text-center">
                <Shield className="w-12 h-12 text-p01-chrome/30 mx-auto mb-3" />
                <p className="text-p01-chrome text-sm">No stealth payments found</p>
                <p className="text-p01-chrome/60 text-xs mt-1">
                  Private transfers will appear here when received
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 rounded-lg border border-red-500/30" role="alert" aria-live="polite">
                <p className="text-red-400 text-xs">{error}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowRecoveryModal(false);
                  setError(null);
                }}
                disabled={isSweeping}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors disabled:opacity-50"
              >
                Close
              </button>
              {foundPayments.length > 0 ? (
                <button
                  onClick={handleSweepAll}
                  disabled={isSweeping}
                  className="flex-1 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isSweeping ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Sweeping...
                    </>
                  ) : (
                    <>Sweep {foundPayments.reduce((sum, p) => sum + p.amount, 0).toFixed(4)} SOL</>
                  )}
                </button>
              ) : (
                <button
                  onClick={handleScanStealth}
                  disabled={isScanning}
                  className="flex-1 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isScanning ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Scanning...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-5 h-5" />
                      Scan Again
                    </>
                  )}
                </button>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}

// Action Button Component
function ActionButton({
  icon,
  label,
  color,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  color: 'cyan' | 'pink' | 'violet' | 'green';
  onClick: () => void;
  disabled?: boolean;
}) {
  const colorClasses = {
    cyan: 'bg-p01-cyan text-p01-void',
    pink: 'bg-p01-pink text-white',
    violet: 'bg-p01-cyan text-white',
    green: 'bg-p01-cyan text-p01-void',
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'w-12 h-12 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100',
          colorClasses[color]
        )}
      >
        {icon}
      </button>
      <span aria-hidden="true" className={cn('text-xs', disabled ? 'text-p01-chrome/50' : 'text-p01-chrome')}>
        {label}
      </span>
    </div>
  );
}
