import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Send,
  Shield,
  Eye,
  EyeOff,
  AlertCircle,
  Check,
  Loader2,
  RefreshCw,
  Info,
  Inbox,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useConfidentialStore } from '@/shared/store/confidential';
import {
  NATIVE_SOL_MINT_STR,
  SUPPORTED_TOKENS,
  getTokenDecimals,
  getTokenSymbol,
} from '@/shared/services/zkspl';
import { cn } from '@/shared/utils';

export default function ConfidentialWallet() {
  const navigate = useNavigate();
  const { publicKey, solBalance } = useWalletStore();
  const {
    isInitialized,
    isLoading,
    displayBalance,
    displayBalances,
    balances,
    hasAccount,
    accounts,
    pendingCredits,
    pendingCreditsByToken,
    error: storeError,
    selectedToken,
    setSelectedToken,
    initialize,
    refreshBalance,
    refreshAllBalances,
    deposit,
    withdraw,
    transfer,
  } = useConfidentialStore();

  const tokenSymbol = getTokenSymbol(selectedToken);
  const tokenDecimals = getTokenDecimals(selectedToken);
  const currentDisplayBalance = displayBalances[selectedToken] ?? displayBalance;
  const currentPendingCredits = pendingCreditsByToken[selectedToken] ?? pendingCredits;
  const currentHasAccount = accounts[selectedToken] ?? hasAccount;

  const [showBalance, setShowBalance] = useState(true);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [actionModal, setActionModal] = useState<'deposit' | 'withdraw' | 'transfer' | null>(null);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  // Initialize on mount
  useEffect(() => {
    if (publicKey) {
      setInitError(null);
      initialize().catch(err => {
        console.error('[ConfidentialWallet] Init error:', err);
        setInitError((err as Error).message);
      });
    }
  }, [publicKey]);

  const handleDeposit = async () => {
    const val = parseFloat(amount);
    if (!amount || val <= 0) {
      setError('Please enter a valid amount');
      return;
    }
    if (selectedToken === NATIVE_SOL_MINT_STR && val > solBalance) {
      setError('Insufficient SOL balance');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const sig = await deposit(val);
      setSuccessMsg(`Deposited ${val} ${tokenSymbol}`);
      setActionModal(null);
      setAmount('');
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleWithdraw = async () => {
    const val = parseFloat(amount);
    if (!amount || val <= 0) {
      setError('Please enter a valid amount');
      return;
    }
    if (val > currentDisplayBalance) {
      setError(`Insufficient confidential ${tokenSymbol} balance`);
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const sig = await withdraw(val);
      setSuccessMsg(`Withdrew ${val} ${tokenSymbol}`);
      setActionModal(null);
      setAmount('');
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleTransfer = async () => {
    const val = parseFloat(amount);
    if (!amount || val <= 0) {
      setError('Please enter a valid amount');
      return;
    }
    if (val > currentDisplayBalance) {
      setError(`Insufficient confidential ${tokenSymbol} balance`);
      return;
    }
    if (!recipient || recipient.length < 32) {
      setError('Please enter a valid Solana address');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const sig = await transfer(recipient, val);
      setSuccessMsg(`Sent ${val} ${tokenSymbol} confidentially`);
      setActionModal(null);
      setAmount('');
      setRecipient('');
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const setPercentage = (pct: number) => {
    const maxVal = actionModal === 'deposit' ? solBalance : currentDisplayBalance;
    const val = maxVal * (pct / 100);
    const dp = tokenDecimals >= 9 ? 6 : 4;
    setAmount(val > 0 ? val.toFixed(dp) : '');
  };

  const formatBalance = () => {
    if (!showBalance) return '****';
    const dp = tokenDecimals >= 9 ? 4 : 2;
    return `${currentDisplayBalance.toFixed(dp)} ${tokenSymbol}`;
  };

  const getMaxAmount = () => {
    if (actionModal === 'deposit') return solBalance;
    return currentDisplayBalance;
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-dark bg-p01-surface">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/shielded')}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-p01-cyan" />
            <h1 className="text-white font-display font-bold tracking-wide">Confidential</h1>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => refreshBalance()}
            disabled={isLoading || !isInitialized}
            className="p-2 text-p01-chrome hover:text-white transition-colors disabled:opacity-50"
            title="Refresh balance"
            aria-label="Refresh balance"
          >
            <RefreshCw className={cn('w-5 h-5', isLoading && 'animate-spin')} />
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
        {/* Balance Card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="mx-4 mt-4 bg-gradient-to-br from-p01-surface to-p01-dark rounded-2xl p-5 border border-p01-cyan/20"
        >
          {/* Badge */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-p01-cyan" />
              <span className="text-p01-chrome text-sm">Confidential Balance</span>
            </div>
            <span className="text-[10px] font-mono font-medium text-p01-cyan bg-p01-cyan/10 px-2 py-0.5 rounded-full border border-p01-cyan/20">
              zkSPL Quantum-Resistant
            </span>
          </div>

          {/* Balance */}
          <div className="text-center py-4">
            <div className="flex items-center justify-center gap-2">
              <Shield className="w-6 h-6 text-p01-cyan/60" />
              <p className="text-3xl font-display font-bold text-white">
                {isLoading && !isInitialized ? (
                  <Loader2 className="w-8 h-8 animate-spin text-p01-cyan" />
                ) : (
                  formatBalance()
                )}
              </p>
            </div>
            <p className="text-p01-chrome text-xs mt-2">
              Hidden on-chain via Poseidon commitments
            </p>
          </div>

          {/* Pending credits indicator */}
          {currentPendingCredits > 0 && (
            <div className="bg-p01-cyan/10 rounded-lg p-3 flex items-center gap-2 border border-p01-cyan/20">
              <Inbox className="w-4 h-4 text-p01-cyan flex-shrink-0" />
              <div className="flex-1">
                <p className="text-p01-cyan text-xs font-medium">
                  {currentPendingCredits} pending credit{currentPendingCredits > 1 ? 's' : ''}
                </p>
                <p className="text-p01-chrome/60 text-[10px]">
                  Incoming {tokenSymbol} transfers waiting to be applied
                </p>
              </div>
            </div>
          )}

          {/* Init Error */}
          {initError && (
            <div className="mt-3 p-3 bg-red-500/10 rounded-lg border border-red-500/30" role="alert" aria-live="polite">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
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

          {/* Not set up yet */}
          {isInitialized && !currentHasAccount && !initError && (
            <div className="mt-3 p-3 bg-p01-void/50 rounded-lg border border-p01-dark">
              <p className="text-p01-chrome text-xs">
                No confidential {tokenSymbol} account yet. Make your first deposit to create one automatically.
              </p>
            </div>
          )}
        </motion.div>

        {/* Success Message */}
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-4 mt-3 p-3 bg-green-500/10 rounded-lg border border-green-500/30 flex items-center gap-2"
            role="status"
            aria-live="polite"
          >
            <Check className="w-4 h-4 text-green-400" />
            <p className="text-green-400 text-xs">{successMsg}</p>
          </motion.div>
        )}

        {/* Store error */}
        {storeError && !initError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mx-4 mt-3 p-3 bg-red-500/10 rounded-lg border border-red-500/30 flex items-center gap-2"
            role="alert"
            aria-live="polite"
          >
            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <p className="text-red-400 text-xs">{storeError}</p>
          </motion.div>
        )}

        {/* Token Selector */}
        <div className="flex gap-2 px-4 mt-3">
          {SUPPORTED_TOKENS.map((token) => {
            const isActive = token.mintStr === selectedToken;
            const bal = (balances[token.mintStr] || 0) / Math.pow(10, token.decimals);
            const dp = token.decimals >= 9 ? 4 : 2;
            return (
              <button
                key={token.mintStr}
                onClick={() => setSelectedToken(token.mintStr)}
                className={cn(
                  'flex-1 py-2 px-3 rounded-lg border text-xs font-medium transition-colors flex items-center justify-center gap-2',
                  isActive
                    ? 'border-p01-cyan bg-p01-cyan/10 text-p01-cyan'
                    : 'border-p01-dark bg-p01-surface text-p01-chrome hover:border-p01-chrome/30'
                )}
              >
                <span className="font-bold">{token.symbol}</span>
                {showBalance && (
                  <span className="text-[10px] opacity-70">{bal.toFixed(dp)}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Action Buttons */}
        <div className="flex justify-center gap-6 py-6">
          <ActionButton
            icon={<ArrowDown className="w-5 h-5" />}
            label="Deposit"
            color="cyan"
            onClick={() => {
              setError(null);
              setActionModal('deposit');
            }}
          />
          <ActionButton
            icon={<ArrowUp className="w-5 h-5" />}
            label="Withdraw"
            color="pink"
            onClick={() => {
              setError(null);
              setActionModal('withdraw');
            }}
            disabled={currentDisplayBalance <= 0}
          />
          <ActionButton
            icon={<Send className="w-5 h-5" />}
            label="Transfer"
            color="violet"
            onClick={() => {
              setError(null);
              setActionModal('transfer');
            }}
            disabled={currentDisplayBalance <= 0}
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
            AVAILABLE TO DEPOSIT
          </p>
          <div className="bg-p01-surface rounded-xl p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-p01-cyan to-p01-cyan/40 flex items-center justify-center">
              <ArrowDown className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-white font-medium">{solBalance.toFixed(4)} SOL</p>
              <p className="text-p01-chrome text-xs">Transparent wallet balance</p>
            </div>
          </div>
        </motion.div>

        {/* Privacy Info Card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mx-4 mt-4 mb-4"
        >
          <div className="bg-gradient-to-r from-p01-cyan/10 to-p01-pink/10 rounded-xl p-4 border border-p01-cyan/20">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center flex-shrink-0">
                <Shield className="w-5 h-5 text-p01-cyan" />
              </div>
              <div>
                <p className="text-white font-medium">zkSPL Confidential Balances</p>
                <p className="text-p01-chrome text-xs mt-1">
                  Your balance is hidden on-chain as a Poseidon commitment. Deposits and withdrawals
                  use ZK proofs to update your balance without revealing it. Transfers are fully private.
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Deposit / Withdraw Modal */}
      {(actionModal === 'deposit' || actionModal === 'withdraw') && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="conf-action-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className={cn(
                'w-12 h-12 rounded-full flex items-center justify-center',
                actionModal === 'deposit' ? 'bg-p01-cyan/20' : 'bg-p01-pink/20'
              )}>
                {actionModal === 'deposit' ? (
                  <ArrowDown className="w-6 h-6 text-p01-cyan" />
                ) : (
                  <ArrowUp className="w-6 h-6 text-p01-pink" />
                )}
              </div>
              <div>
                <h3 id="conf-action-title" className="text-lg font-display font-bold text-white capitalize">
                  {actionModal} {tokenSymbol}
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  {actionModal === 'deposit'
                    ? `Move ${tokenSymbol} into confidential account`
                    : `Withdraw ${tokenSymbol} from confidential account`}
                </p>
              </div>
            </div>

            {/* Amount Input */}
            <div className="mb-3">
              <div className="bg-p01-void rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-p01-chrome text-xs">Amount</span>
                  <button
                    onClick={() => setPercentage(100)}
                    className="text-p01-cyan text-xs hover:underline"
                  >
                    Max: {getMaxAmount().toFixed(tokenDecimals >= 9 ? 4 : 2)} {tokenSymbol}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0"
                    aria-label={`Amount in ${tokenSymbol}`}
                    className="flex-1 bg-transparent text-2xl font-display font-bold text-white outline-none"
                  />
                  <span className="text-p01-chrome text-lg">{tokenSymbol}</span>
                </div>
              </div>
            </div>

            {/* Quick-select percentage buttons */}
            <div className="flex gap-2 mb-4">
              {[25, 50, 75, 100].map(pct => (
                <button
                  key={pct}
                  onClick={() => setPercentage(pct)}
                  className="flex-1 py-2 text-xs font-medium text-p01-chrome bg-p01-void rounded-lg hover:bg-p01-dark hover:text-white transition-colors border border-p01-dark"
                  aria-label={pct === 100 ? 'Set to max amount' : `Set amount to ${pct}%`}
                >
                  {pct === 100 ? 'Max' : `${pct}%`}
                </button>
              ))}
            </div>

            {/* First deposit notice */}
            {actionModal === 'deposit' && !currentHasAccount && (
              <div className="mb-4 p-3 bg-p01-cyan/10 rounded-lg flex items-start gap-2 border border-p01-cyan/20">
                <Info className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-p01-chrome text-xs">
                  First deposit will create your on-chain confidential {tokenSymbol} account. This is a one-time setup.
                </p>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 rounded-lg border border-red-500/30 flex items-start gap-2" role="alert" aria-live="polite">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
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
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-dark transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={actionModal === 'deposit' ? handleDeposit : handleWithdraw}
                disabled={isProcessing || !amount || parseFloat(amount) <= 0}
                className={cn(
                  'flex-1 py-3 font-medium rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2',
                  actionModal === 'deposit'
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
                  <span className="capitalize">{actionModal}</span>
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Transfer Modal */}
      {actionModal === 'transfer' && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="conf-transfer-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                <Send className="w-6 h-6 text-p01-cyan" />
              </div>
              <div>
                <h3 id="conf-transfer-title" className="text-lg font-display font-bold text-white">
                  Confidential Transfer
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  Send {tokenSymbol} privately to another wallet
                </p>
              </div>
            </div>

            {/* Recipient Input */}
            <div className="mb-3">
              <div className="bg-p01-void rounded-xl p-4">
                <label htmlFor="conf-transfer-recipient" className="text-p01-chrome text-xs">Recipient Address</label>
                <input
                  id="conf-transfer-recipient"
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Solana address..."
                  className="w-full mt-1 bg-transparent text-sm font-mono text-white outline-none placeholder-p01-chrome/40"
                />
              </div>
            </div>

            {/* Amount Input */}
            <div className="mb-3">
              <div className="bg-p01-void rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <label htmlFor="conf-transfer-amount" className="text-p01-chrome text-xs">Amount</label>
                  <button
                    onClick={() => setPercentage(100)}
                    className="text-p01-cyan text-xs hover:underline"
                    aria-label="Set amount to maximum"
                  >
                    Max: {currentDisplayBalance.toFixed(tokenDecimals >= 9 ? 4 : 2)} {tokenSymbol}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="conf-transfer-amount"
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0"
                    className="flex-1 bg-transparent text-2xl font-display font-bold text-white outline-none"
                  />
                  <span className="text-p01-chrome text-lg">{tokenSymbol}</span>
                </div>
              </div>
            </div>

            {/* Quick-select percentage buttons */}
            <div className="flex gap-2 mb-4">
              {[25, 50, 75, 100].map(pct => (
                <button
                  key={pct}
                  onClick={() => setPercentage(pct)}
                  aria-label={`Set amount to ${pct}% of balance`}
                  className="flex-1 py-2 text-xs font-medium text-p01-chrome bg-p01-void rounded-lg hover:bg-p01-dark hover:text-white transition-colors border border-p01-dark"
                >
                  {pct === 100 ? 'Max' : `${pct}%`}
                </button>
              ))}
            </div>

            {/* Error */}
            {error && (
              <div className="mb-4 p-3 bg-red-500/10 rounded-lg border border-red-500/30 flex items-start gap-2" role="alert" aria-live="polite">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setActionModal(null);
                  setAmount('');
                  setRecipient('');
                  setError(null);
                }}
                disabled={isProcessing}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-dark transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleTransfer}
                disabled={isProcessing || !amount || parseFloat(amount) <= 0 || !recipient}
                className="flex-1 py-3 bg-p01-cyan text-p01-void font-medium rounded-xl hover:bg-p01-cyan/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Send'
                )}
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Info Modal */}
      {showInfoModal && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="conf-info-title">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-full max-h-[80%] bg-p01-surface rounded-2xl p-5 overflow-y-auto"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                <Shield className="w-6 h-6 text-p01-cyan" />
              </div>
              <div>
                <h3 id="conf-info-title" className="text-lg font-display font-bold text-white">
                  zkSPL Confidential Balances
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  Quantum-resistant privacy on Solana
                </p>
              </div>
            </div>

            <div className="space-y-4 text-sm">
              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">How it works</h4>
                <p className="text-p01-chrome/80">
                  zkSPL uses Poseidon hash commitments and post-quantum STARK proofs to hide your
                  balance on-chain. Only you know your actual balance; the blockchain only stores a
                  commitment.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">Deposit</h4>
                <p className="text-p01-chrome/80">
                  Move tokens from your transparent wallet into the confidential account. The deposit
                  amount is visible, but your new total balance remains hidden.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">Withdraw</h4>
                <p className="text-p01-chrome/80">
                  Move tokens from your confidential account back to your transparent wallet. The
                  withdrawal amount is visible, but your remaining balance stays hidden.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">Confidential Transfer</h4>
                <p className="text-p01-chrome/80">
                  Send tokens to another wallet where the amount is hidden on-chain as an amount hash.
                  The recipient receives a pending credit they must apply to update their balance.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">vs Shielded Pool</h4>
                <p className="text-p01-chrome/80">
                  The Shielded Pool uses a UTXO model (notes in a Merkle tree). zkSPL uses an
                  account model with balance commitments. Both provide privacy via ZK proofs,
                  but zkSPL is more composable with DeFi protocols.
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

// ---------------------------------------------------------------------------
// Action Button Component
// ---------------------------------------------------------------------------

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
