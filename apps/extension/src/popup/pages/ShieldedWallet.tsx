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
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useShieldedStore } from '@/shared/store/shielded';
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
  } = useShieldedStore();

  const [showBalance, setShowBalance] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [actionModal, setActionModal] = useState<'shield' | 'unshield' | null>(null);
  const [amount, setAmount] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize shielded wallet on mount
  useEffect(() => {
    if (!isInitialized && publicKey) {
      initialize();
    }
  }, [publicKey, isInitialized]);

  const handleCopyAddress = async () => {
    if (zkAddress) {
      await copyToClipboard(zkAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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

  const formatShieldedBalance = () => {
    if (!showBalance) return '****';
    return `${shieldedBalance.toFixed(4)} SOL`;
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border bg-p01-surface">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
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
            onClick={() => setShowBalance(!showBalance)}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
          >
            {showBalance ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
          </button>
          <button
            onClick={() => setShowInfoModal(true)}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
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
          className="mx-4 mt-4 bg-gradient-to-br from-p01-surface to-p01-dark rounded-2xl p-5 border border-p01-cyan/20"
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
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-white text-xs font-mono mt-1 truncate">
              {zkAddress || 'Initializing...'}
            </p>
          </div>
        </motion.div>

        {/* Action Buttons */}
        <div className="flex justify-center gap-6 py-6">
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
            SHIELDED NOTES ({notes.length})
          </p>
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            {notes.length === 0 ? (
              <div className="p-6 text-center">
                <Shield className="w-10 h-10 text-p01-chrome/30 mx-auto mb-2" />
                <p className="text-p01-chrome text-sm">No shielded notes yet</p>
                <p className="text-p01-chrome/60 text-xs mt-1">
                  Shield some SOL to create your first private note
                </p>
              </div>
            ) : (
              <div className="divide-y divide-p01-border/50">
                {notes.slice(0, 5).map((note, index) => (
                  <div key={index} className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                        <Lock className="w-5 h-5 text-p01-cyan" />
                      </div>
                      <div>
                        <p className="text-white font-medium font-mono">
                          {showBalance ? `${(Number(note.amount) / 1e9).toFixed(4)} SOL` : '****'}
                        </p>
                        <p className="text-p01-chrome text-xs">
                          Index: {note.leafIndex ?? 'pending'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-p01-chrome/60 text-xs font-mono">
                        {truncateAddress(note.commitment ?? '', 4)}
                      </p>
                    </div>
                  </div>
                ))}
                {notes.length > 5 && (
                  <button className="w-full p-3 text-center text-p01-cyan text-sm hover:bg-p01-void/50 transition-colors">
                    View all {notes.length} notes
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
          <div className="bg-gradient-to-r from-p01-cyan/10 to-p01-pink/10 rounded-xl p-4 border border-p01-cyan/20">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center flex-shrink-0">
                <ShieldCheck className="w-5 h-5 text-p01-cyan" />
              </div>
              <div>
                <p className="text-white font-medium">ZK-SNARK Protection</p>
                <p className="text-p01-chrome text-xs mt-1">
                  Your shielded transactions use Groth16 zero-knowledge proofs.
                  No one can see amounts, senders, or recipients on-chain.
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Shield/Unshield Modal */}
      {actionModal && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50">
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
                <h3 className="text-lg font-display font-bold text-white capitalize">
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
                    className="flex-1 bg-transparent text-2xl font-display font-bold text-white outline-none"
                  />
                  <span className="text-p01-chrome text-lg">SOL</span>
                </div>
              </div>
            </div>

            {/* Warning for first-time users */}
            {actionModal === 'shield' && notes.length === 0 && (
              <div className="mb-4 p-3 bg-yellow-500/10 rounded-lg flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                <p className="text-yellow-200 text-xs">
                  Proof generation may take 30-60 seconds on first use while circuits are loaded.
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 rounded-lg">
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
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
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
                <h3 className="text-lg font-display font-bold text-white">
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
  color: 'cyan' | 'pink' | 'violet';
  onClick: () => void;
  disabled?: boolean;
}) {
  const colorClasses = {
    cyan: 'bg-p01-cyan text-p01-void',
    pink: 'bg-p01-pink text-white',
    violet: 'bg-p01-cyan text-white',
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'w-12 h-12 rounded-full flex items-center justify-center transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100',
          colorClasses[color]
        )}
      >
        {icon}
      </button>
      <span className={cn('text-xs', disabled ? 'text-p01-chrome/50' : 'text-p01-chrome')}>
        {label}
      </span>
    </div>
  );
}
