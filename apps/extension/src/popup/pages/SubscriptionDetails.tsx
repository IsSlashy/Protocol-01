import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ExternalLink,
  Shield,
  Clock,
  AlertTriangle,
  Play,
  Pause,
  Ban,
  Shuffle,
  EyeOff,
  ChevronDown,
  Check,
  Loader2,
  Edit3,
  Music,
  Bot,
  Gamepad2,
  Briefcase,
  Newspaper,
  Dumbbell,
  Cloud,
  CreditCard,
  GraduationCap,
  Target,
  MessageCircle,
} from 'lucide-react';
import { cn, truncateAddress } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { useWalletStore } from '@/shared/store/wallet';
import { formatInterval, calculateNextPayment, PaymentRecord } from '@/shared/services/stream';
import {
  detectServiceFromName,
  detectServiceFromOrigin,
  CATEGORY_CONFIG,
  type ServiceInfo,
  type ServiceCategory,
} from '@/shared/services/serviceRegistry';

// Map category icon names to Lucide components
const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Play,
  Music,
  Bot,
  Gamepad2,
  Briefcase,
  Newspaper,
  Dumbbell,
  Cloud,
  Shield,
  CreditCard,
  GraduationCap,
  Target,
  MessageCircle,
};

/**
 * Get the appropriate icon component for a category
 */
function getCategoryIconComponent(category: ServiceCategory): React.ComponentType<{ className?: string }> {
  const iconName = CATEGORY_CONFIG[category]?.icon || 'CreditCard';
  return CATEGORY_ICONS[iconName] || CreditCard;
}

export default function SubscriptionDetails() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showPaymentHistory, setShowPaymentHistory] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showEditAmount, setShowEditAmount] = useState(false);
  const [newAmount, setNewAmount] = useState('');

  const {
    getSubscription,
    pauseSubscription,
    resumeSubscription,
    cancelSubscription,
    updateSubscription,
    processPayment,
    error,
    clearError,
  } = useSubscriptionsStore();

  const { _keypair, network, isUnlocked } = useWalletStore();

  const subscription = id ? getSubscription(id) : undefined;

  // Detect service info from registry
  const detectedService = useMemo((): ServiceInfo | null => {
    if (!subscription) return null;

    // Try to detect from origin first (most reliable)
    if (subscription.origin) {
      const fromOrigin = detectServiceFromOrigin(subscription.origin);
      if (fromOrigin) return fromOrigin;
    }

    // Fall back to name-based detection
    const fromName = detectServiceFromName(subscription.name);
    return fromName;
  }, [subscription]);

  // Clear error on unmount
  useEffect(() => {
    return () => clearError();
  }, [clearError]);

  if (!subscription) {
    return (
      <div className="flex flex-col h-full items-center justify-center">
        <p className="text-p01-chrome/60">Subscription not found</p>
        <button
          onClick={() => navigate('/subscriptions')}
          className="mt-4 px-4 py-2 bg-p01-surface text-white rounded-lg"
        >
          Go Back
        </button>
      </div>
    );
  }

  // Use detected service info or fall back to subscription data
  // These are prepared for enhanced UI but currently using subscription data directly
  const _serviceName = detectedService?.name || subscription.name;
  const _serviceLogo = detectedService?.logo || subscription.merchantLogo;
  const _serviceColor = detectedService?.color;
  const _serviceCategory = detectedService?.category;
  const _CategoryIcon = _serviceCategory ? getCategoryIconComponent(_serviceCategory) : null;
  // Suppress unused warnings - these will be used in future UI enhancements
  void _serviceName; void _serviceLogo; void _serviceColor; void _CategoryIcon;

  const daysUntilNext = Math.ceil(
    (subscription.nextPayment - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const remainingPayments = subscription.maxPayments > 0
    ? subscription.maxPayments - subscription.paymentsMade
    : Infinity;

  const maxTotal = subscription.maxPayments > 0
    ? subscription.amount * subscription.maxPayments
    : Infinity;

  // Calculate payment preview with noise
  const paymentPreview = _keypair
    ? calculateNextPayment(subscription, _keypair)
    : calculateNextPayment(subscription);

  // Check privacy features
  const hasPrivacyFeatures =
    subscription.amountNoise > 0 ||
    subscription.timingNoise > 0 ||
    subscription.useStealthAddress;

  const handlePauseResume = () => {
    if (subscription.status === 'active') {
      pauseSubscription(subscription.id);
    } else if (subscription.status === 'paused') {
      resumeSubscription(subscription.id);
    }
  };

  const handleCancel = () => {
    cancelSubscription(subscription.id);
    setShowCancelConfirm(false);
    navigate('/subscriptions');
  };

  const handlePayNow = async () => {
    if (!_keypair || !isUnlocked) {
      alert('Wallet must be unlocked to process payments');
      return;
    }

    setIsProcessing(true);
    clearError();

    try {
      await processPayment(subscription.id, _keypair, network);
    } catch (err) {
      console.error('Payment failed:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleUpdateAmount = () => {
    const amount = parseFloat(newAmount);
    if (!isNaN(amount) && amount > 0) {
      updateSubscription(subscription.id, { amount });
      setShowEditAmount(false);
      setNewAmount('');
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 hover:bg-p01-surface rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-p01-chrome" />
        </button>
        <h1 className="text-lg font-semibold text-white">Subscription</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Merchant Info */}
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-p01-surface flex items-center justify-center relative">
            {subscription.merchantLogo ? (
              <img
                src={subscription.merchantLogo}
                alt={subscription.name}
                className="w-8 h-8"
                style={{ filter: 'invert(1)' }}
              />
            ) : (
              <span className="text-2xl font-bold text-p01-chrome">
                {subscription.name.slice(0, 1)}
              </span>
            )}
            {hasPrivacyFeatures && subscription.status === 'active' && (
              <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-p01-cyan flex items-center justify-center">
                <Shield className="w-3.5 h-3.5 text-p01-void" />
              </div>
            )}
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">
              {subscription.name}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              {subscription.status === 'active' ? (
                <span className="flex items-center gap-1 text-xs text-p01-cyan">
                  <span className="w-1.5 h-1.5 rounded-full bg-p01-cyan animate-pulse" />
                  Active
                </span>
              ) : subscription.status === 'paused' ? (
                <span className="flex items-center gap-1 text-xs text-yellow-500">
                  <Pause className="w-3 h-3" />
                  Paused
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-red-500">
                  <Ban className="w-3 h-3" />
                  Cancelled
                </span>
              )}
              {subscription.origin && (
                <span className="text-xs text-p01-chrome/40">
                  via {new URL(subscription.origin).hostname}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Amount with Edit */}
        <div className="bg-p01-surface rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-p01-chrome/60">Amount</span>
            {subscription.status !== 'cancelled' && (
              <button
                onClick={() => {
                  setShowEditAmount(!showEditAmount);
                  setNewAmount(subscription.amount.toString());
                }}
                className="text-xs text-p01-cyan hover:underline flex items-center gap-1"
              >
                <Edit3 className="w-3 h-3" />
                Edit
              </button>
            )}
          </div>
          {showEditAmount ? (
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                className="flex-1 px-3 py-2 bg-p01-border rounded-lg text-white text-sm"
                step="0.001"
                min="0"
              />
              <button
                onClick={handleUpdateAmount}
                className="px-3 py-2 bg-p01-cyan text-p01-void rounded-lg text-sm font-medium"
              >
                Save
              </button>
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-white">
                {subscription.amount.toFixed(subscription.amount < 1 ? 4 : 2)}
              </span>
              <span className="text-sm text-p01-chrome">{subscription.tokenSymbol}</span>
              <span className="text-sm text-p01-chrome/60">/ {formatInterval(subscription.interval).toLowerCase()}</span>
            </div>
          )}
        </div>

        {/* Privacy Features Card */}
        {hasPrivacyFeatures && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="bg-p01-cyan/10 rounded-xl p-4 border border-p01-cyan/30"
          >
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-5 h-5 text-p01-cyan" />
              <span className="text-sm font-semibold text-p01-cyan">
                Privacy Enabled
              </span>
            </div>

            <div className="space-y-2">
              {subscription.amountNoise > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shuffle className="w-4 h-4 text-p01-cyan/60" />
                    <span className="text-xs text-p01-chrome">Amount Noise</span>
                  </div>
                  <span className="text-xs font-mono text-white">+/-{subscription.amountNoise}%</span>
                </div>
              )}
              {subscription.timingNoise > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-streams/60" />
                    <span className="text-xs text-p01-chrome">Timing Noise</span>
                  </div>
                  <span className="text-xs font-mono text-white">+/-{subscription.timingNoise}h</span>
                </div>
              )}
              {subscription.useStealthAddress && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <EyeOff className="w-4 h-4 text-purple-400/60" />
                    <span className="text-xs text-p01-chrome">Stealth Addresses</span>
                  </div>
                  <Check className="w-4 h-4 text-purple-400" />
                </div>
              )}
            </div>

            {/* Preview next payment */}
            {subscription.status === 'active' && (
              <div className="mt-3 pt-3 border-t border-p01-cyan/20">
                <p className="text-xs text-p01-chrome/60 mb-1">Next payment preview:</p>
                <p className="text-sm text-white font-mono">
                  ~{paymentPreview.amount.toFixed(4)} {subscription.tokenSymbol}
                  {paymentPreview.noise.amountDelta !== 0 && (
                    <span className="text-p01-chrome/40 text-xs ml-1">
                      ({paymentPreview.noise.amountDelta > 0 ? '+' : ''}
                      {paymentPreview.noise.amountDelta.toFixed(4)})
                    </span>
                  )}
                </p>
              </div>
            )}
          </motion.div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-p01-surface rounded-xl p-4">
            <p className="text-xs text-p01-chrome/60 mb-1">Total Paid</p>
            <p className="text-lg font-semibold text-white">
              {subscription.totalPaid.toFixed(subscription.totalPaid < 1 ? 4 : 2)} {subscription.tokenSymbol}
            </p>
            <p className="text-xs text-p01-chrome/60">
              {subscription.paymentsMade} payment{subscription.paymentsMade !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="bg-p01-surface rounded-xl p-4">
            <p className="text-xs text-p01-chrome/60 mb-1">Remaining</p>
            <p className="text-lg font-semibold text-white">
              {remainingPayments === Infinity ? 'Unlimited' : `${remainingPayments} payments`}
            </p>
            <p className="text-xs text-p01-chrome/60">
              {maxTotal === Infinity
                ? 'No limit'
                : `Max: ${maxTotal.toFixed(2)} ${subscription.tokenSymbol}`}
            </p>
          </div>
        </div>

        {/* Next Payment */}
        {subscription.status === 'active' && (
          <div className="bg-p01-surface rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-p01-chrome/60" />
              <span className="text-sm text-p01-chrome/60">Next Payment</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-lg font-semibold text-white">
                {daysUntilNext <= 0 ? 'Due now' : `In ${daysUntilNext} day${daysUntilNext !== 1 ? 's' : ''}`}
              </span>
              <span className="text-sm text-p01-chrome">
                {new Date(subscription.nextPayment).toLocaleDateString()}
              </span>
            </div>
            <div className="mt-2 h-1.5 bg-p01-border rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full',
                  daysUntilNext <= 0 ? 'bg-red-500' : 'bg-p01-cyan'
                )}
                style={{
                  width: `${Math.min(100, Math.max(0, ((30 - daysUntilNext) / 30) * 100))}%`,
                }}
              />
            </div>

            {/* Pay Now Button */}
            {daysUntilNext <= 1 && isUnlocked && (
              <button
                onClick={handlePayNow}
                disabled={isProcessing}
                className="mt-3 w-full py-2 bg-p01-cyan text-p01-void text-sm font-medium rounded-lg hover:bg-p01-cyan-dim transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  'Pay Now'
                )}
              </button>
            )}
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="bg-red-500/10 rounded-xl p-4 border border-red-500/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-500 font-medium">Payment Failed</p>
                <p className="text-xs text-red-400 mt-1">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Payment History */}
        <div className="bg-p01-surface rounded-xl">
          <button
            onClick={() => setShowPaymentHistory(!showPaymentHistory)}
            className="w-full flex items-center justify-between p-4"
          >
            <span className="text-sm font-medium text-white">Payment History</span>
            <ChevronDown
              className={cn(
                'w-4 h-4 text-p01-chrome transition-transform',
                showPaymentHistory && 'rotate-180'
              )}
            />
          </button>

          {showPaymentHistory && (
            <div className="px-4 pb-4">
              {subscription.payments.length === 0 ? (
                <p className="text-xs text-p01-chrome/60 text-center py-4">
                  No payments yet
                </p>
              ) : (
                <div className="space-y-2">
                  {subscription.payments.slice().reverse().map((payment) => (
                    <PaymentHistoryItem key={payment.id} payment={payment} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="bg-p01-surface rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-p01-chrome/60">Recipient</span>
            <div className="flex items-center gap-1">
              <span className="text-sm font-mono text-white">
                {truncateAddress(subscription.recipient, 4)}
              </span>
              <ExternalLink className="w-3 h-3 text-p01-chrome/40" />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-p01-chrome/60">Created</span>
            <span className="text-sm text-white">
              {new Date(subscription.createdAt).toLocaleDateString()}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-p01-chrome/60">Subscription ID</span>
            <span className="text-sm font-mono text-white">
              {truncateAddress(subscription.id, 4)}
            </span>
          </div>
        </div>
      </div>

      {/* Actions */}
      {subscription.status !== 'cancelled' && (
        <div className="p-4 border-t border-p01-border space-y-2">
          <button
            onClick={handlePauseResume}
            className="w-full flex items-center justify-center gap-2 py-3 bg-p01-surface text-white font-medium rounded-xl border border-p01-border hover:bg-p01-elevated transition-colors"
          >
            {subscription.status === 'active' ? (
              <>
                <Pause className="w-4 h-4" />
                Pause Subscription
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Resume Subscription
              </>
            )}
          </button>

          <button
            onClick={() => setShowCancelConfirm(true)}
            className="w-full flex items-center justify-center gap-2 py-3 bg-red-500/10 text-red-500 font-medium rounded-xl border border-red-500/30 hover:bg-red-500/20 transition-colors"
          >
            <Ban className="w-4 h-4" />
            Cancel & Revoke
          </button>
        </div>
      )}

      {/* Cancel Confirmation Modal */}
      {showCancelConfirm && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">
                  Cancel Subscription?
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  This will permanently stop all payments
                </p>
              </div>
            </div>

            <div className="bg-p01-elevated rounded-xl p-3 mb-4">
              <p className="text-xs text-p01-chrome">
                <strong className="text-white">{subscription.name}</strong> will no longer receive
                payments. This action cannot be undone.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="flex-1 py-3 bg-p01-border text-white font-medium rounded-xl hover:bg-p01-border transition-colors"
              >
                Keep Active
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 py-3 bg-red-500 text-white font-medium rounded-xl hover:bg-red-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}

function PaymentHistoryItem({ payment }: { payment: PaymentRecord }) {
  const statusColors = {
    confirmed: 'text-green-500',
    pending: 'text-yellow-500',
    failed: 'text-red-500',
  };

  return (
    <div className="flex items-center justify-between py-2 border-b border-p01-border/50 last:border-0">
      <div>
        <p className="text-sm text-white">
          {payment.amount.toFixed(4)} SOL
          {payment.noise.amountDelta !== 0 && (
            <span className="text-xs text-p01-chrome/40 ml-1">
              ({payment.noise.amountDelta > 0 ? '+' : ''}
              {payment.noise.amountDelta.toFixed(4)})
            </span>
          )}
        </p>
        <p className="text-xs text-p01-chrome/60">
          {new Date(payment.timestamp).toLocaleString()}
        </p>
        {payment.wasStealthPayment && (
          <span className="text-[9px] text-purple-400">Stealth</span>
        )}
      </div>
      <div className="text-right">
        <p className={cn('text-xs font-medium capitalize', statusColors[payment.status])}>
          {payment.status}
        </p>
        <a
          href={`https://solscan.io/tx/${payment.signature}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-p01-chrome/60 hover:text-p01-cyan flex items-center gap-1"
        >
          View <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}
