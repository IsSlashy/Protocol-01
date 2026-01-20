import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  ShieldCheck,
  ExternalLink,
  Download,
  Check,
  AlertCircle,
  Loader2,
  Copy,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useWalletStore } from '@/shared/store/wallet';
import {
  useStealthStore,
  selectUnclaimedPayments,
  selectClaimedPayments,
} from '@/shared/store/stealth';
import { StealthPayment } from '@/shared/services/stealth';
import { copyToClipboard, truncateAddress, formatRelativeTime, cn } from '@/shared/utils';

export default function StealthPayments() {
  const navigate = useNavigate();
  const { publicKey, network } = useWalletStore();
  const {
    stealthBalance,
    isLoading,
    error,
    claimPayment,
    clearError,
    lastScanTimestamp,
  } = useStealthStore();

  const unclaimedPayments = selectUnclaimedPayments(useStealthStore.getState());
  const claimedPayments = selectClaimedPayments(useStealthStore.getState());

  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState<string | null>(null);
  const [showClaimed, setShowClaimed] = useState(false);
  const [expandedPayment, setExpandedPayment] = useState<string | null>(null);

  const handleClaim = async (payment: StealthPayment) => {
    if (!publicKey) return;

    setClaimingId(payment.id);
    clearError();

    try {
      await claimPayment(payment.id, publicKey, network);
      setClaimSuccess(payment.id);
      setTimeout(() => setClaimSuccess(null), 3000);
    } catch (err) {
      // Error is set in the store
    } finally {
      setClaimingId(null);
    }
  };

  const formatSol = (lamports: number) => {
    return (lamports / 1_000_000_000).toFixed(4);
  };

  const handleCopyAddress = async (address: string) => {
    await copyToClipboard(address);
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-p01-border bg-p01-surface">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 hover:bg-p01-border transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-p01-chrome" />
        </button>
        <h1 className="text-sm font-mono font-bold text-white tracking-wider">STEALTH PAYMENTS</h1>
        <div className="ml-auto">
          <ShieldCheck className="w-4 h-4 text-p01-cyan" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Balance Summary */}
        <div className="p-4 border-b border-p01-border bg-p01-surface/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-p01-chrome font-mono tracking-wider">
              PENDING STEALTH BALANCE
            </span>
            {lastScanTimestamp && (
              <span className="text-[9px] text-p01-chrome/60 font-mono">
                Last scan: {formatRelativeTime(lastScanTimestamp)}
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-mono font-bold text-white">
              {formatSol(stealthBalance)}
            </span>
            <span className="text-sm text-p01-chrome font-mono">SOL</span>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <EyeOff className="w-3 h-3 text-p01-cyan" />
            <span className="text-[10px] text-p01-cyan font-mono">
              {unclaimedPayments.length} PRIVATE PAYMENT{unclaimedPayments.length !== 1 ? 'S' : ''}{' '}
              PENDING
            </span>
          </div>
        </div>

        {/* Error Display */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mx-4 mt-4"
            >
              <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <span className="text-xs font-mono text-red-400 flex-1">{error}</span>
                <button
                  onClick={clearError}
                  className="text-red-400 hover:text-red-300 text-xs font-mono"
                >
                  DISMISS
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Pending Payments */}
        <div className="p-4 space-y-3">
          {unclaimedPayments.length === 0 ? (
            <div className="text-center py-8">
              <Eye className="w-12 h-12 text-p01-chrome/30 mx-auto mb-3" />
              <p className="text-p01-chrome font-mono text-sm mb-1">No pending payments</p>
              <p className="text-p01-chrome/60 font-mono text-xs">
                Share your stealth meta-address to receive private payments
              </p>
            </div>
          ) : (
            unclaimedPayments.map((payment) => (
              <PaymentCard
                key={payment.id}
                payment={payment}
                isExpanded={expandedPayment === payment.id}
                onToggleExpand={() =>
                  setExpandedPayment(expandedPayment === payment.id ? null : payment.id)
                }
                onClaim={() => handleClaim(payment)}
                onCopyAddress={handleCopyAddress}
                isClaiming={claimingId === payment.id}
                isClaimSuccess={claimSuccess === payment.id}
                network={network}
              />
            ))
          )}
        </div>

        {/* Claimed Payments Section */}
        {claimedPayments.length > 0 && (
          <div className="border-t border-p01-border">
            <button
              onClick={() => setShowClaimed(!showClaimed)}
              className="w-full p-4 flex items-center justify-between hover:bg-p01-surface/30 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-500" />
                <span className="text-[11px] font-mono font-bold text-p01-chrome tracking-wider">
                  CLAIMED ({claimedPayments.length})
                </span>
              </div>
              {showClaimed ? (
                <ChevronUp className="w-4 h-4 text-p01-chrome" />
              ) : (
                <ChevronDown className="w-4 h-4 text-p01-chrome" />
              )}
            </button>

            <AnimatePresence>
              {showClaimed && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="px-4 pb-4 space-y-3"
                >
                  {claimedPayments.map((payment) => (
                    <PaymentCard
                      key={payment.id}
                      payment={payment}
                      isExpanded={expandedPayment === payment.id}
                      onToggleExpand={() =>
                        setExpandedPayment(expandedPayment === payment.id ? null : payment.id)
                      }
                      onCopyAddress={handleCopyAddress}
                      isClaimed
                      network={network}
                    />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Info Section */}
        <div className="p-4">
          <div className="bg-p01-surface border border-p01-border p-3 rounded-xl">
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[10px] font-mono font-bold text-p01-cyan tracking-wider mb-1">
                  [ HOW IT WORKS ]
                </p>
                <p className="text-[10px] text-p01-chrome/70 font-mono leading-relaxed">
                  Stealth payments are sent to unique one-time addresses. Only you can detect and
                  claim these funds. When you claim, the funds are transferred to your main wallet
                  address.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Claim All Button */}
      {unclaimedPayments.length > 1 && (
        <div className="p-3 border-t border-p01-border bg-p01-surface">
          <button
            disabled={isLoading}
            className={cn(
              'w-full py-3 font-mono font-bold text-xs tracking-wider rounded-lg transition-colors flex items-center justify-center gap-2',
              isLoading
                ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
            )}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                CLAIMING...
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                CLAIM ALL ({formatSol(stealthBalance)} SOL)
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// PAYMENT CARD COMPONENT
// =============================================================================

interface PaymentCardProps {
  payment: StealthPayment;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onClaim?: () => void;
  onCopyAddress: (address: string) => void;
  isClaiming?: boolean;
  isClaimSuccess?: boolean;
  isClaimed?: boolean;
  network: string;
}

function PaymentCard({
  payment,
  isExpanded,
  onToggleExpand,
  onClaim,
  onCopyAddress,
  isClaiming,
  isClaimSuccess,
  isClaimed,
  network,
}: PaymentCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await onCopyAddress(payment.stealthAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatSol = (lamports: number) => {
    return (lamports / 1_000_000_000).toFixed(4);
  };

  return (
    <motion.div
      layout
      className={cn(
        'bg-p01-surface border rounded-xl overflow-hidden transition-colors',
        isClaimed ? 'border-p01-border/50 opacity-70' : 'border-p01-border hover:border-p01-cyan/30'
      )}
    >
      {/* Main Row */}
      <button
        onClick={onToggleExpand}
        className="w-full p-3 flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'w-10 h-10 rounded-lg flex items-center justify-center',
              isClaimed
                ? 'bg-green-500/20 border border-green-500/30'
                : 'bg-p01-cyan/20 border border-p01-cyan/30'
            )}
          >
            {isClaimed ? (
              <Check className="w-5 h-5 text-green-500" />
            ) : (
              <EyeOff className="w-5 h-5 text-p01-cyan" />
            )}
          </div>
          <div className="text-left">
            <p className="font-mono font-bold text-white text-sm">
              +{formatSol(payment.amount)} SOL
            </p>
            <p className="text-[10px] text-p01-chrome font-mono">
              {formatRelativeTime(payment.timestamp)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isClaimed && onClaim && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClaim();
              }}
              disabled={isClaiming}
              className={cn(
                'px-3 py-1.5 text-[10px] font-mono font-bold tracking-wider rounded transition-colors',
                isClaiming
                  ? 'bg-p01-border text-p01-chrome/40 cursor-not-allowed'
                  : isClaimSuccess
                  ? 'bg-green-500 text-white'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan-dim'
              )}
            >
              {isClaiming ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : isClaimSuccess ? (
                'CLAIMED!'
              ) : (
                'CLAIM'
              )}
            </button>
          )}
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-p01-chrome" />
          ) : (
            <ChevronDown className="w-4 h-4 text-p01-chrome" />
          )}
        </div>
      </button>

      {/* Expanded Details */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="border-t border-p01-border"
          >
            <div className="p-3 space-y-3">
              {/* Stealth Address */}
              <div>
                <p className="text-[9px] text-p01-chrome/60 font-mono mb-1 tracking-wider">
                  STEALTH ADDRESS
                </p>
                <div className="flex items-center gap-2">
                  <p className="text-[10px] text-white font-mono flex-1 break-all">
                    {payment.stealthAddress}
                  </p>
                  <button
                    onClick={handleCopy}
                    className="p-1 hover:bg-p01-dark rounded transition-colors"
                  >
                    {copied ? (
                      <Check className="w-3 h-3 text-p01-cyan" />
                    ) : (
                      <Copy className="w-3 h-3 text-p01-chrome" />
                    )}
                  </button>
                </div>
              </div>

              {/* Transaction Signature */}
              <div>
                <p className="text-[9px] text-p01-chrome/60 font-mono mb-1 tracking-wider">
                  TRANSACTION
                </p>
                <a
                  href={`https://solscan.io/tx/${payment.signature}?cluster=${network}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[10px] text-p01-cyan font-mono hover:underline"
                >
                  {truncateAddress(payment.signature, 8)}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              {/* Claim Signature (if claimed) */}
              {payment.claimSignature && (
                <div>
                  <p className="text-[9px] text-p01-chrome/60 font-mono mb-1 tracking-wider">
                    CLAIM TRANSACTION
                  </p>
                  <a
                    href={`https://solscan.io/tx/${payment.claimSignature}?cluster=${network}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] text-green-500 font-mono hover:underline"
                  >
                    {truncateAddress(payment.claimSignature, 8)}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}

              {/* Ephemeral Key (Advanced) */}
              <div>
                <p className="text-[9px] text-p01-chrome/60 font-mono mb-1 tracking-wider">
                  EPHEMERAL KEY
                </p>
                <p className="text-[9px] text-p01-chrome/50 font-mono break-all">
                  {payment.ephemeralPubKey}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
