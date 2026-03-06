import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Clock,
  Play,
  Pause,
  Trash2,
  DollarSign,
  Shield,
  Eye,
  EyeOff,
  AlertCircle,
  Check,
  Loader2,
  RefreshCw,
  Info,
  Plus,
  Calendar,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import { useSubscriptionVaultStore } from '@/shared/store/subscriptionVault';
import { LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import { cn } from '@/shared/utils';

export default function SubscriptionVaults() {
  const navigate = useNavigate();
  const { publicKey } = useWalletStore();
  const {
    vaults,
    loading,
    error: storeError,
    currentSlot,
    loadVaults,
    refreshVault,
    setCurrentSlot,
    getClaimable,
    getClaimableAmount,
    getRefundable,
    getNextClaimableSlot,
  } = useSubscriptionVaultStore();

  const [showBalance, setShowBalance] = useState(true);
  const [selectedVault, setSelectedVault] = useState<string | null>(null);
  const [actionModal, setActionModal] = useState<'pause' | 'resume' | 'cancel' | 'claim' | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Load vaults on mount
  useEffect(() => {
    if (publicKey) {
      loadVaults(publicKey).catch(err => {
        console.error('[SubscriptionVaults] Load error:', err);
      });
    }
  }, [publicKey]);

  // Fetch current slot periodically
  useEffect(() => {
    const fetchSlot = async () => {
      try {
        const response = await fetch('https://api.devnet.solana.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSlot',
          }),
        });
        const data = await response.json();
        if (data.result) {
          setCurrentSlot(data.result);
        }
      } catch (error) {
        console.error('[SubscriptionVaults] Failed to fetch slot:', error);
      }
    };

    fetchSlot();
    const interval = setInterval(fetchSlot, 10000); // Every 10s
    return () => clearInterval(interval);
  }, []);

  const handlePause = async () => {
    if (!selectedVault) return;
    const vault = vaults.find(v => v.address === selectedVault);
    if (!vault) return;

    setIsProcessing(true);
    setError(null);

    try {
      // TODO: Implement pause logic
      setSuccessMsg('Vault paused successfully');
      setActionModal(null);
      await refreshVault(selectedVault);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleResume = async () => {
    if (!selectedVault) return;
    const vault = vaults.find(v => v.address === selectedVault);
    if (!vault) return;

    setIsProcessing(true);
    setError(null);

    try {
      // TODO: Implement resume logic
      setSuccessMsg('Vault resumed successfully');
      setActionModal(null);
      await refreshVault(selectedVault);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = async () => {
    if (!selectedVault) return;
    const vault = vaults.find(v => v.address === selectedVault);
    if (!vault) return;

    setIsProcessing(true);
    setError(null);

    try {
      // TODO: Implement cancel logic
      setSuccessMsg('Vault cancelled successfully');
      setActionModal(null);
      await refreshVault(selectedVault);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClaim = async () => {
    if (!selectedVault) return;
    const vault = vaults.find(v => v.address === selectedVault);
    if (!vault) return;

    setIsProcessing(true);
    setError(null);

    try {
      // TODO: Implement claim logic
      setSuccessMsg('Periods claimed successfully');
      setActionModal(null);
      await refreshVault(selectedVault);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatTokenAmount = (amount: number, tokenMint: string): string => {
    const isNativeSol = tokenMint === SystemProgram.programId.toBase58();
    if (isNativeSol) {
      return `${(amount / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
    }
    return `${amount} tokens`;
  };

  const formatInterval = (slots: number): string => {
    const seconds = slots * 0.4; // Approximate: 1 slot ~= 400ms
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds.toFixed(0)}s`;
  };

  const truncateAddress = (addr: string): string => {
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
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
            <Calendar className="w-5 h-5 text-p01-cyan" />
            <h1 className="text-white font-display font-bold tracking-wide">Subscription Vaults</h1>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => publicKey && loadVaults(publicKey)}
            disabled={loading}
            className="p-2 text-p01-chrome hover:text-white transition-colors disabled:opacity-50"
            aria-label="Refresh vaults"
          >
            <RefreshCw className={cn('w-5 h-5', loading && 'animate-spin')} />
          </button>
          <button
            onClick={() => setShowBalance(!showBalance)}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
            aria-label={showBalance ? 'Hide balances' : 'Show balances'}
          >
            {showBalance ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {/* Success Message */}
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-4 mt-3 p-3 bg-green-500/10 rounded-lg border border-green-500/30 flex items-center gap-2"
            role="status"
            aria-live="polite"
          >
            <Check className="w-4 h-4 text-green-400" aria-hidden="true" />
            <p className="text-green-400 text-xs">{successMsg}</p>
          </motion.div>
        )}

        {/* Store error */}
        {storeError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mx-4 mt-3 p-3 bg-red-500/10 rounded-lg border border-red-500/30 flex items-center gap-2"
            role="alert"
            aria-live="polite"
          >
            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" aria-hidden="true" />
            <p className="text-red-400 text-xs">{storeError}</p>
          </motion.div>
        )}

        {/* Empty state */}
        {!loading && vaults.length === 0 && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="mx-4 mt-6"
          >
            <div className="bg-p01-surface rounded-xl p-6 text-center border border-p01-dark">
              <Calendar className="w-12 h-12 text-p01-chrome/40 mx-auto mb-3" />
              <p className="text-white font-medium mb-1">No subscription vaults yet</p>
              <p className="text-p01-chrome text-xs mb-4">
                Create a vault to enable recurring payments to retailers
              </p>
              <button
                onClick={() => setActionModal(null)} // TODO: Navigate to create vault page
                className="px-4 py-2 bg-p01-cyan text-p01-void rounded-lg font-medium text-sm hover:bg-p01-cyan/90 transition-colors inline-flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Create Vault
              </button>
            </div>
          </motion.div>
        )}

        {/* Vault list */}
        {vaults.length > 0 && (
          <div className="px-4 mt-4 space-y-3">
            {vaults.map((vault) => {
              const claimablePeriods = getClaimable(vault.address);
              const claimableAmount = getClaimableAmount(vault.address);
              const refundable = getRefundable(vault.address);
              const nextSlot = getNextClaimableSlot(vault.address);
              const isRetailer = publicKey === vault.retailer;

              return (
                <motion.div
                  key={vault.address}
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  className="bg-gradient-to-br from-p01-surface to-p01-dark rounded-xl p-4 border border-p01-cyan/20"
                >
                  {/* Header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      {vault.isPrivateMode ? (
                        <Shield className="w-5 h-5 text-p01-cyan" />
                      ) : (
                        <Calendar className="w-5 h-5 text-p01-pink" />
                      )}
                      <div>
                        <p className="text-white font-medium text-sm">
                          {vault.isPrivateMode ? 'Private Vault' : 'Normal Vault'}
                        </p>
                        <p className="text-p01-chrome text-xs font-mono">
                          {truncateAddress(vault.address)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {vault.isPaused && (
                        <span className="text-[10px] font-mono font-medium text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded-full border border-yellow-400/20">
                          PAUSED
                        </span>
                      )}
                      {vault.isActive && !vault.isPaused && (
                        <span className="text-[10px] font-mono font-medium text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full border border-green-400/20">
                          ACTIVE
                        </span>
                      )}
                      {!vault.isActive && (
                        <span className="text-[10px] font-mono font-medium text-p01-chrome bg-p01-void px-2 py-0.5 rounded-full border border-p01-dark">
                          INACTIVE
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Info grid */}
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div className="bg-p01-void rounded-lg p-2">
                      <p className="text-p01-chrome text-[10px] mb-0.5">Retailer</p>
                      <p className="text-white text-xs font-mono">
                        {truncateAddress(vault.retailer)}
                      </p>
                    </div>
                    <div className="bg-p01-void rounded-lg p-2">
                      <p className="text-p01-chrome text-[10px] mb-0.5">Rate</p>
                      <p className="text-white text-xs">
                        {showBalance
                          ? formatTokenAmount(vault.rate, vault.tokenMint)
                          : '****'}
                      </p>
                    </div>
                    <div className="bg-p01-void rounded-lg p-2">
                      <p className="text-p01-chrome text-[10px] mb-0.5">Interval</p>
                      <p className="text-white text-xs">
                        {formatInterval(vault.intervalSlots)}
                      </p>
                    </div>
                    <div className="bg-p01-void rounded-lg p-2">
                      <p className="text-p01-chrome text-[10px] mb-0.5">Deposited</p>
                      <p className="text-white text-xs">
                        {showBalance
                          ? formatTokenAmount(vault.totalDeposited, vault.tokenMint)
                          : '****'}
                      </p>
                    </div>
                  </div>

                  {/* Claimable info */}
                  {vault.isActive && !vault.isPaused && (
                    <div className="bg-p01-cyan/10 rounded-lg p-2 mb-3 border border-p01-cyan/20">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-p01-chrome text-[10px]">
                            {isRetailer ? 'Claimable' : 'Next claim'}
                          </p>
                          <p className="text-p01-cyan text-sm font-medium">
                            {isRetailer
                              ? `${claimablePeriods} period${claimablePeriods !== 1 ? 's' : ''}`
                              : nextSlot
                              ? `Slot ${nextSlot}`
                              : 'N/A'}
                          </p>
                        </div>
                        {isRetailer && claimableAmount > 0 && showBalance && (
                          <p className="text-p01-cyan text-xs">
                            {formatTokenAmount(claimableAmount, vault.tokenMint)}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    {!isRetailer && vault.isActive && !vault.isPaused && (
                      <button
                        onClick={() => {
                          setSelectedVault(vault.address);
                          setActionModal('pause');
                          setError(null);
                        }}
                        className="flex-1 py-2 px-3 bg-p01-void text-p01-chrome rounded-lg text-xs font-medium hover:bg-p01-dark hover:text-white transition-colors flex items-center justify-center gap-1"
                      >
                        <Pause className="w-3 h-3" />
                        Pause
                      </button>
                    )}
                    {!isRetailer && vault.isActive && vault.isPaused && (
                      <button
                        onClick={() => {
                          setSelectedVault(vault.address);
                          setActionModal('resume');
                          setError(null);
                        }}
                        className="flex-1 py-2 px-3 bg-p01-cyan/20 text-p01-cyan rounded-lg text-xs font-medium hover:bg-p01-cyan/30 transition-colors flex items-center justify-center gap-1 border border-p01-cyan/30"
                      >
                        <Play className="w-3 h-3" />
                        Resume
                      </button>
                    )}
                    {!isRetailer && vault.isActive && (
                      <button
                        onClick={() => {
                          setSelectedVault(vault.address);
                          setActionModal('cancel');
                          setError(null);
                        }}
                        className="flex-1 py-2 px-3 bg-red-500/10 text-red-400 rounded-lg text-xs font-medium hover:bg-red-500/20 transition-colors flex items-center justify-center gap-1 border border-red-500/30"
                      >
                        <Trash2 className="w-3 h-3" />
                        Cancel
                      </button>
                    )}
                    {isRetailer && claimablePeriods > 0 && (
                      <button
                        onClick={() => {
                          setSelectedVault(vault.address);
                          setActionModal('claim');
                          setError(null);
                        }}
                        className="flex-1 py-2 px-3 bg-p01-cyan text-p01-void rounded-lg text-xs font-medium hover:bg-p01-cyan/90 transition-colors flex items-center justify-center gap-1"
                      >
                        <DollarSign className="w-3 h-3" />
                        Claim
                      </button>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      {/* Action Modal */}
      {actionModal && selectedVault && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="vault-action-title">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center gap-3 mb-4">
              <div
                className={cn(
                  'w-12 h-12 rounded-full flex items-center justify-center',
                  actionModal === 'pause' && 'bg-yellow-400/20',
                  actionModal === 'resume' && 'bg-p01-cyan/20',
                  actionModal === 'cancel' && 'bg-red-500/20',
                  actionModal === 'claim' && 'bg-p01-cyan/20'
                )}
              >
                {actionModal === 'pause' && <Pause className="w-6 h-6 text-yellow-400" />}
                {actionModal === 'resume' && <Play className="w-6 h-6 text-p01-cyan" />}
                {actionModal === 'cancel' && <Trash2 className="w-6 h-6 text-red-400" />}
                {actionModal === 'claim' && <DollarSign className="w-6 h-6 text-p01-cyan" />}
              </div>
              <div>
                <h3 id="vault-action-title" className="text-lg font-display font-bold text-white capitalize">
                  {actionModal} Vault
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  {actionModal === 'pause' && 'Temporarily stop periodic payments'}
                  {actionModal === 'resume' && 'Resume periodic payments'}
                  {actionModal === 'cancel' && 'Close vault and refund remaining balance'}
                  {actionModal === 'claim' && 'Claim accrued periods'}
                </p>
              </div>
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
                  setSelectedVault(null);
                  setError(null);
                }}
                disabled={isProcessing}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-dark transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (actionModal === 'pause') handlePause();
                  else if (actionModal === 'resume') handleResume();
                  else if (actionModal === 'cancel') handleCancel();
                  else if (actionModal === 'claim') handleClaim();
                }}
                disabled={isProcessing}
                className={cn(
                  'flex-1 py-3 font-medium rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2',
                  actionModal === 'pause' && 'bg-yellow-400 text-p01-void hover:bg-yellow-400/90',
                  actionModal === 'resume' && 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90',
                  actionModal === 'cancel' && 'bg-red-500 text-white hover:bg-red-500/90',
                  actionModal === 'claim' && 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
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
    </div>
  );
}
