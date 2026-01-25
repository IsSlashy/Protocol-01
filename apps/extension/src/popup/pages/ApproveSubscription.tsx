import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Shield,
  AlertTriangle,
  Check,
  X,
  Repeat,
  Clock,
  Loader2,
  ExternalLink,
  Shuffle,
  EyeOff,
  ChevronDown,
  Play,
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
  CheckCircle2,
  Link,
} from 'lucide-react';
import { cn, truncateAddress } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { useWalletStore } from '@/shared/store/wallet';
import { sendToBackground } from '@/shared/messaging';
import type { SubscriptionInterval } from '@/shared/services/stream';
import { publishSubscription } from '@/shared/services/onchain-sync';
import { Keypair } from '@solana/web3.js';
import {
  detectServiceFromOrigin,
  detectServiceFromName,
  getCategoryLabel,
  CATEGORY_CONFIG,
  type ServiceInfo,
  type ServiceCategory,
} from '@/shared/services/serviceRegistry';

// Map category icon names to Lucide components
const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
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

// This page is opened when a dApp requests a subscription via p01-js
// The request data comes from chrome.storage.session

interface SubscriptionRequestData {
  id: string;
  origin: string;
  originName?: string;
  originIcon?: string;
  payload: {
    recipient: string;
    merchantName: string;
    merchantLogo?: string;
    tokenMint?: string;
    amountPerPeriod: number;
    periodSeconds: number;
    maxPeriods: number;
    description?: string;
    // dApp-suggested privacy options
    amountNoise?: number;
    timingNoise?: number;
    useStealthAddress?: boolean;
  };
}

// Convert period seconds to interval type
function periodSecondsToInterval(seconds: number): SubscriptionInterval {
  if (seconds <= 86400) return 'daily';
  if (seconds <= 604800) return 'weekly';
  if (seconds <= 2592000) return 'monthly';
  return 'yearly';
}

// Format period for display
function formatPeriodSeconds(seconds: number): string {
  const days = seconds / 86400;
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'year';
}

export default function ApproveSubscription() {
  const [isApproving, setIsApproving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPrivacyOptions, setShowPrivacyOptions] = useState(true);
  const [request, setRequest] = useState<SubscriptionRequestData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');

  // Privacy options (user can adjust)
  const [amountNoise, setAmountNoise] = useState(5);    // Default 5%
  const [timingNoise, setTimingNoise] = useState(2);    // Default 2h
  const [useStealthAddress, setUseStealthAddress] = useState(false);
  const [syncToChain, setSyncToChain] = useState(true); // Default to sync on-chain

  const { addSubscription } = useSubscriptionsStore();
  const { _keypair } = useWalletStore();

  // Load request from session storage
  useEffect(() => {
    const loadRequest = async () => {
      try {
        const result = await chrome.storage.session.get('currentApproval');
        if (result.currentApproval && result.currentApproval.type === 'subscription') {
          const req = result.currentApproval as SubscriptionRequestData;
          setRequest(req);

          // Set dApp-suggested privacy defaults if provided
          if (req.payload.amountNoise !== undefined) {
            setAmountNoise(req.payload.amountNoise);
          }
          if (req.payload.timingNoise !== undefined) {
            setTimingNoise(req.payload.timingNoise);
          }
          if (req.payload.useStealthAddress !== undefined) {
            setUseStealthAddress(req.payload.useStealthAddress);
          }
        }
      } catch (err) {
        console.error('Failed to load approval request:', err);
        setError('Failed to load subscription request');
      }
    };

    loadRequest();
  }, []);

  // Detect service from origin or merchant name
  const detectedService = useMemo((): ServiceInfo | null => {
    if (!request) return null;

    // Try origin-based detection first (most reliable)
    if (request.origin) {
      const fromOrigin = detectServiceFromOrigin(request.origin);
      if (fromOrigin) return fromOrigin;
    }

    // Fall back to name-based detection
    if (request.payload?.merchantName) {
      const fromName = detectServiceFromName(request.payload.merchantName);
      if (fromName) return fromName;
    }

    return null;
  }, [request]);

  if (!request) {
    return (
      <div className="flex flex-col h-full bg-p01-void items-center justify-center">
        {error ? (
          <div className="text-center p-4">
            <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-3" />
            <p className="text-sm text-red-500">{error}</p>
          </div>
        ) : (
          <Loader2 className="w-8 h-8 text-p01-cyan animate-spin" />
        )}
      </div>
    );
  }

  const { payload, origin, originIcon } = request;

  // Use detected service info or fall back to dApp-provided info
  const serviceName = detectedService?.name || payload.merchantName;
  const serviceLogo = detectedService?.logo || payload.merchantLogo;
  const serviceColor = detectedService?.color;
  const serviceCategory = detectedService?.category;
  const CategoryIcon = serviceCategory ? getCategoryIconComponent(serviceCategory) : null;

  // Calculate amounts (assuming SOL with 9 decimals for now)
  // In production, fetch token info from mint
  const decimals = payload.tokenMint ? 6 : 9; // USDC = 6, SOL = 9
  const amount = payload.amountPerPeriod / Math.pow(10, decimals);
  const maxTotal = payload.maxPeriods > 0 ? amount * payload.maxPeriods : Infinity;
  const periodLabel = formatPeriodSeconds(payload.periodSeconds);

  const handleApprove = async () => {
    setIsApproving(true);
    setError(null);

    try {
      // Create the subscription in local store with privacy options
      // Use detected service info for better branding
      const subscription = addSubscription({
        name: serviceName, // Use detected or provided name
        recipient: payload.recipient,
        amount,
        tokenMint: payload.tokenMint,
        tokenSymbol: payload.tokenMint ? 'USDC' : 'SOL',
        tokenDecimals: decimals,
        interval: periodSecondsToInterval(payload.periodSeconds),
        maxPayments: payload.maxPeriods,
        amountNoise,
        timingNoise,
        useStealthAddress,
        merchantLogo: serviceLogo, // Use detected or provided logo
        origin,
        originIcon,
      });

      // Publish to blockchain for cross-device sync (if enabled and wallet unlocked)
      console.log('[ApproveSubscription] Sync check:', { syncToChain, hasKeypair: !!_keypair });
      if (syncToChain && _keypair) {
        setSyncStatus('syncing');
        try {
          console.log('[ApproveSubscription] Publishing to blockchain...');
          const keypair = Keypair.fromSecretKey(_keypair.secretKey);
          await publishSubscription(subscription, keypair, 'devnet');
          setSyncStatus('synced');
          console.log('[ApproveSubscription] Subscription synced to blockchain');
        } catch (syncErr) {
          console.warn('[ApproveSubscription] Failed to sync to chain:', syncErr);
          setSyncStatus('error');
          // Don't fail the whole operation, local subscription is still created
        }
      } else {
        console.log('[ApproveSubscription] Skipping blockchain sync - wallet locked or sync disabled');
      }

      // Notify background of approval
      await sendToBackground('APPROVE_REQUEST', {
        requestId: request.id,
        data: {
          subscriptionId: subscription.id,
          approved: true,
        },
      });

      // Delay close to see logs (debug)
      console.log('[ApproveSubscription] Closing in 3 seconds...');
      setTimeout(() => window.close(), 3000);
    } catch (err) {
      console.error('Failed to approve subscription:', err);
      setError((err as Error).message);
      setIsApproving(false);
    }
  };

  const handleReject = async () => {
    try {
      await sendToBackground('REJECT_REQUEST', {
        requestId: request.id,
        reason: 'User rejected',
      });
    } catch (err) {
      console.error('Failed to reject:', err);
    }
    window.close();
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header with Service Branding */}
      <div
        className="p-4 border-b border-p01-border"
        style={serviceColor ? {
          background: `linear-gradient(135deg, ${serviceColor}15, transparent)`,
          borderColor: `${serviceColor}30`,
        } : undefined}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center overflow-hidden"
            style={serviceColor ? {
              backgroundColor: `${serviceColor}20`,
              boxShadow: `0 0 0 1px ${serviceColor}40`,
            } : { backgroundColor: 'var(--p01-surface)' }}
          >
            {serviceLogo ? (
              <img
                src={serviceLogo}
                alt={serviceName}
                className="w-6 h-6"
                style={{
                  filter: serviceColor
                    ? `drop-shadow(0 0 1px ${serviceColor})`
                    : 'invert(1)',
                }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <span
                className="text-lg font-bold"
                style={{ color: serviceColor || '#a3a3a3' }}
              >
                {serviceName.slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-white">
                {serviceName}
              </h1>
              {detectedService && (
                <div
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                  style={{
                    backgroundColor: `${serviceColor}20`,
                    color: serviceColor,
                  }}
                >
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  Verified
                </div>
              )}
            </div>
            {serviceCategory && CategoryIcon && (
              <div className="flex items-center gap-1.5 mt-0.5" style={{ color: serviceColor }}>
                <CategoryIcon className="w-3 h-3" />
                <span className="text-xs">
                  {getCategoryLabel(serviceCategory)}
                </span>
              </div>
            )}
            <p className="text-xs text-p01-chrome/60 mt-0.5">
              {origin}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Request Type Badge */}
        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-streams/20 rounded-full">
            <Repeat className="w-4 h-4 text-streams" />
            <span className="text-sm font-medium text-streams">
              Subscription Request
            </span>
          </div>
        </div>

        {/* Amount Display */}
        <div className="text-center py-4">
          <p className="text-4xl font-display font-bold text-white">
            {amount.toFixed(amount < 1 ? 4 : 2)} {payload.tokenMint ? 'USDC' : 'SOL'}
          </p>
          <p className="text-sm text-p01-chrome/60 mt-1">
            per {periodLabel}
          </p>
        </div>

        {/* Description */}
        {payload.description && (
          <div className="bg-p01-surface rounded-xl p-3">
            <p className="text-xs text-p01-chrome">{payload.description}</p>
          </div>
        )}

        {/* SECURE LIMITS */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-p01-cyan/10 rounded-xl p-4 border border-p01-cyan/30"
        >
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-5 h-5 text-p01-cyan" />
            <span className="text-sm font-semibold text-p01-cyan">
              Stream Secure Limits
            </span>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-p01-chrome">Maximum per payment</span>
              <span className="text-sm font-mono font-semibold text-white">
                {amount.toFixed(amount < 1 ? 4 : 2)} {payload.tokenMint ? 'USDC' : 'SOL'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-p01-chrome/60" />
                <span className="text-sm text-p01-chrome">Frequency</span>
              </div>
              <span className="text-sm font-medium text-white">
                Once per {periodLabel}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-p01-chrome">Duration</span>
              <span className="text-sm font-medium text-white">
                {payload.maxPeriods > 0
                  ? `${payload.maxPeriods} ${periodLabel}s`
                  : 'Until cancelled'}
              </span>
            </div>

            <div className="border-t border-p01-cyan/30 pt-3 mt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-p01-cyan">
                  Maximum total exposure
                </span>
                <span className="text-sm font-mono font-bold text-p01-cyan">
                  {maxTotal === Infinity
                    ? 'Unlimited'
                    : `${maxTotal.toFixed(2)} ${payload.tokenMint ? 'USDC' : 'SOL'}`}
                </span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Privacy Options - User Adjustable */}
        <div className="bg-p01-surface rounded-xl overflow-hidden">
          <button
            onClick={() => setShowPrivacyOptions(!showPrivacyOptions)}
            className="w-full flex items-center justify-between p-4"
          >
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-p01-cyan" />
              <span className="text-sm font-medium text-white">Privacy Options</span>
            </div>
            <ChevronDown
              className={cn(
                'w-4 h-4 text-p01-chrome transition-transform',
                showPrivacyOptions && 'rotate-180'
              )}
            />
          </button>

          {showPrivacyOptions && (
            <div className="px-4 pb-4 space-y-4">
              {/* Amount Noise */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Shuffle className="w-4 h-4 text-p01-cyan" />
                    <span className="text-xs text-p01-chrome">Amount Noise</span>
                  </div>
                  <span className="text-xs font-mono text-p01-cyan">+/-{amountNoise}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="20"
                  value={amountNoise}
                  onChange={(e) => setAmountNoise(parseInt(e.target.value))}
                  className="w-full accent-p01-cyan h-1"
                />
                <p className="text-[10px] text-p01-chrome/40 mt-1">
                  Vary amounts to prevent pattern detection
                </p>
              </div>

              {/* Timing Noise */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-streams" />
                    <span className="text-xs text-p01-chrome">Timing Noise</span>
                  </div>
                  <span className="text-xs font-mono text-streams">+/-{timingNoise}h</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="24"
                  value={timingNoise}
                  onChange={(e) => setTimingNoise(parseInt(e.target.value))}
                  className="w-full accent-streams h-1"
                />
                <p className="text-[10px] text-p01-chrome/40 mt-1">
                  Randomize payment times within window
                </p>
              </div>

              {/* Stealth Address */}
              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2">
                  <EyeOff className="w-4 h-4 text-p01-cyan" />
                  <div>
                    <span className="text-xs text-p01-chrome">Stealth Addresses</span>
                    <p className="text-[10px] text-p01-chrome/40">
                      Each payment to unique address
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setUseStealthAddress(!useStealthAddress)}
                  className={cn(
                    'w-10 h-5 rounded-full transition-colors relative',
                    useStealthAddress ? 'bg-p01-cyan' : 'bg-p01-border'
                  )}
                >
                  <div
                    className={cn(
                      'w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform',
                      useStealthAddress ? 'translate-x-5' : 'translate-x-0.5'
                    )}
                  />
                </button>
              </div>

              {/* On-Chain Sync */}
              <div className="flex items-center justify-between py-2 border-t border-p01-border pt-3 mt-2">
                <div className="flex items-center gap-2">
                  <Link className="w-4 h-4 text-p01-cyan" />
                  <div>
                    <span className="text-xs text-p01-chrome">Sync to Blockchain</span>
                    <p className="text-[10px] text-p01-chrome/40">
                      Access on all devices with this wallet
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setSyncToChain(!syncToChain)}
                  className={cn(
                    'w-10 h-5 rounded-full transition-colors relative',
                    syncToChain ? 'bg-p01-cyan' : 'bg-p01-border'
                  )}
                >
                  <div
                    className={cn(
                      'w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform',
                      syncToChain ? 'translate-x-5' : 'translate-x-0.5'
                    )}
                  />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* What you're approving */}
        <div className="bg-p01-surface rounded-xl p-4">
          <p className="text-sm font-medium text-white mb-2">
            What you're approving:
          </p>
          <ul className="space-y-2">
            <li className="flex items-start gap-2 text-xs text-p01-chrome">
              <Check className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
              <span>
                <strong className="text-white">{serviceName}</strong> can charge up to{' '}
                <strong className="text-white">
                  {amount.toFixed(amount < 1 ? 4 : 2)} {payload.tokenMint ? 'USDC' : 'SOL'}
                </strong>{' '}
                once per {periodLabel}
              </span>
            </li>
            <li className="flex items-start gap-2 text-xs text-p01-chrome">
              <Check className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
              <span>
                They <strong className="text-white">cannot</strong> charge more
                than approved
              </span>
            </li>
            <li className="flex items-start gap-2 text-xs text-p01-chrome">
              <Check className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
              <span>
                You can <strong className="text-white">pause or cancel</strong>{' '}
                anytime from your wallet
              </span>
            </li>
            {(amountNoise > 0 || timingNoise > 0 || useStealthAddress) && (
              <li className="flex items-start gap-2 text-xs text-p01-chrome">
                <Shield className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
                <span>
                  Privacy features will hide payment patterns
                </span>
              </li>
            )}
            {syncToChain && (
              <li className="flex items-start gap-2 text-xs text-p01-chrome">
                <Link className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
                <span>
                  Subscription synced on-chain for <strong className="text-white">mobile access</strong>
                </span>
              </li>
            )}
          </ul>
        </div>

        {/* Advanced Details */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full text-left"
        >
          <div className="flex items-center justify-between text-xs text-p01-chrome/60 hover:text-p01-chrome transition-colors">
            <span>Advanced details</span>
            <span>{showAdvanced ? '▲' : '▼'}</span>
          </div>
        </button>

        {showAdvanced && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            className="bg-p01-surface rounded-xl p-4 space-y-2 overflow-hidden"
          >
            <div className="flex justify-between text-xs">
              <span className="text-p01-chrome/60">Recipient</span>
              <div className="flex items-center gap-1">
                <span className="font-mono text-white">
                  {truncateAddress(payload.recipient, 4)}
                </span>
                <ExternalLink className="w-3 h-3 text-p01-chrome/40" />
              </div>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-p01-chrome/60">Token</span>
              <span className="text-white">{payload.tokenMint ? 'USDC' : 'SOL'}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-p01-chrome/60">Period</span>
              <span className="text-white">{payload.periodSeconds} seconds</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-p01-chrome/60">Request ID</span>
              <span className="font-mono text-white">{truncateAddress(request.id, 4)}</span>
            </div>
          </motion.div>
        )}

        {/* Warning for unlimited */}
        {payload.maxPeriods === 0 && (
          <div className="bg-yellow-500/10 rounded-xl p-4 border border-yellow-500/20">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-yellow-500">
                  Unlimited Duration
                </p>
                <p className="text-xs text-p01-chrome mt-1">
                  This subscription has no end date. Remember to cancel when
                  you no longer need it.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 rounded-xl p-4 border border-red-500/30">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-500">{error}</p>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-p01-border space-y-3">
        <button
          onClick={handleApprove}
          disabled={isApproving}
          className="w-full py-3.5 bg-p01-cyan text-p01-void font-semibold rounded-xl hover:bg-p01-cyan-dim transition-colors disabled:opacity-70 flex items-center justify-center gap-2"
        >
          {isApproving ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              {syncStatus === 'syncing' ? 'Syncing to Blockchain...' : 'Creating Subscription...'}
            </>
          ) : (
            <>
              <Shield className="w-5 h-5" />
              Approve Subscription
              {syncToChain && <Link className="w-4 h-4 ml-1" />}
            </>
          )}
        </button>

        <button
          onClick={handleReject}
          disabled={isApproving}
          className="w-full py-3 text-p01-chrome/60 font-medium rounded-xl hover:text-white hover:bg-p01-surface transition-colors flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" />
          Reject
        </button>
      </div>
    </div>
  );
}
