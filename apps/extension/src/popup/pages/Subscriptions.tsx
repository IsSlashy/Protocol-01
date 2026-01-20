import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Repeat,
  ChevronRight,
  AlertCircle,
  Plus,
  Shield,
  EyeOff,
  Clock,
  Shuffle,
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
} from 'lucide-react';
import { cn, formatCurrency } from '@/shared/utils';
import { useSubscriptionsStore, useSubscriptionStats } from '@/shared/store/subscriptions';
import type { StreamSubscription } from '@/shared/services/stream';
import { formatInterval } from '@/shared/services/stream';
import {
  detectServiceFromName,
  detectServiceFromOrigin,
  getCategoryColor,
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

export default function Subscriptions() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);

  const { subscriptions, refreshComputedValues } = useSubscriptionsStore();
  const stats = useSubscriptionStats();

  // Refresh computed values on mount
  useEffect(() => {
    refreshComputedValues();
  }, [refreshComputedValues]);

  const filteredSubs = subscriptions.filter((sub) => {
    if (filter === 'active') return sub.status === 'active';
    if (filter === 'paused') return sub.status === 'paused';
    return sub.status !== 'cancelled'; // Hide cancelled in 'all'
  });

  // Sort by next payment (soonest first)
  const sortedSubs = [...filteredSubs].sort((a, b) => {
    if (a.status !== 'active' && b.status === 'active') return 1;
    if (a.status === 'active' && b.status !== 'active') return -1;
    return a.nextPayment - b.nextPayment;
  });

  // Calculate privacy score (how many have privacy features enabled)
  const privacyScore = subscriptions.filter(s => s.status === 'active').length > 0
    ? Math.round(
        (subscriptions.filter(s =>
          s.status === 'active' &&
          (s.amountNoise > 0 || s.timingNoise > 0 || s.useStealthAddress)
        ).length / subscriptions.filter(s => s.status === 'active').length) * 100
      )
    : 0;

  return (
    <div className="flex flex-col h-full">
      {/* Summary Card */}
      <div className="p-4">
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-gradient-to-br from-streams/20 to-p01-surface rounded-xl p-4 border border-streams/30"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Repeat className="w-5 h-5 text-streams" />
              <span className="text-sm font-medium text-streams">
                Stream Secure
              </span>
            </div>
            <button
              onClick={() => setShowPrivacyInfo(!showPrivacyInfo)}
              className="p-1.5 rounded-lg bg-p01-surface/50 hover:bg-p01-surface transition-colors"
              title="Privacy Info"
            >
              <Shield className="w-4 h-4 text-p01-cyan" />
            </button>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-display font-bold text-white">
              {formatCurrency(stats.monthlyCost)}
            </span>
            <span className="text-sm text-p01-chrome/60">/month</span>
          </div>

          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-p01-chrome/60">
              {stats.activeCount} active subscription{stats.activeCount !== 1 ? 's' : ''}
            </p>
            {stats.nextDue && (
              <p className="text-xs text-p01-chrome/60">
                Next: {new Date(stats.nextDue).toLocaleDateString()}
              </p>
            )}
          </div>

          {/* Privacy Score Bar */}
          {subscriptions.length > 0 && (
            <div className="mt-3 pt-3 border-t border-p01-border/50">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-p01-chrome/60">Privacy Score</span>
                <span className="text-xs font-medium text-p01-cyan">{privacyScore}%</span>
              </div>
              <div className="h-1.5 bg-p01-border rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${privacyScore}%` }}
                  transition={{ duration: 0.5, delay: 0.2 }}
                  className="h-full bg-gradient-to-r from-p01-cyan to-streams rounded-full"
                />
              </div>
            </div>
          )}
        </motion.div>

        {/* Privacy Info Panel */}
        {showPrivacyInfo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 bg-p01-surface rounded-xl p-4 border border-p01-cyan/30"
          >
            <h4 className="text-sm font-semibold text-p01-cyan mb-3 flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Privacy Features
            </h4>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-p01-cyan/10 flex items-center justify-center flex-shrink-0">
                  <Shuffle className="w-4 h-4 text-p01-cyan" />
                </div>
                <div>
                  <p className="text-xs font-medium text-white">Amount Noise</p>
                  <p className="text-xs text-p01-chrome/60">
                    Vary payment amounts by up to 20% to prevent pattern detection
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-streams/10 flex items-center justify-center flex-shrink-0">
                  <Clock className="w-4 h-4 text-streams" />
                </div>
                <div>
                  <p className="text-xs font-medium text-white">Timing Noise</p>
                  <p className="text-xs text-p01-chrome/60">
                    Randomize payment times within a window to hide patterns
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                  <EyeOff className="w-4 h-4 text-purple-400" />
                </div>
                <div>
                  <p className="text-xs font-medium text-white">Stealth Addresses</p>
                  <p className="text-xs text-p01-chrome/60">
                    Each payment sent to a unique derived address
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* Filter Tabs */}
      <div className="px-4 mb-3">
        <div className="flex gap-2 p-1 bg-p01-surface rounded-lg">
          {(['all', 'active', 'paused'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'flex-1 py-2 text-xs font-medium rounded-md transition-colors capitalize',
                filter === f
                  ? 'bg-p01-border text-white'
                  : 'text-p01-chrome/60 hover:text-p01-chrome'
              )}
            >
              {f}
              {f === 'active' && stats.activeCount > 0 && (
                <span className="ml-1 text-p01-cyan">({stats.activeCount})</span>
              )}
              {f === 'paused' && stats.pausedCount > 0 && (
                <span className="ml-1 text-yellow-500">({stats.pausedCount})</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Subscriptions List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {sortedSubs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Repeat className="w-12 h-12 text-p01-chrome/40 mb-3" />
            <p className="text-sm text-p01-chrome/60 mb-4">
              {filter !== 'all' ? `No ${filter} subscriptions` : 'No subscriptions yet'}
            </p>
            {filter === 'all' && (
              <button
                onClick={() => navigate('/subscriptions/new')}
                className="flex items-center gap-2 px-4 py-2 bg-p01-cyan text-p01-void text-sm font-medium rounded-lg hover:bg-p01-cyan-dim transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create Subscription
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {sortedSubs.map((sub, index) => (
              <SubscriptionCard
                key={sub.id}
                subscription={sub}
                index={index}
                onClick={() => navigate(`/subscriptions/${sub.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add Button (when there are subscriptions) */}
      {sortedSubs.length > 0 && (
        <div className="p-4 border-t border-p01-border">
          <button
            onClick={() => navigate('/subscriptions/new')}
            className="w-full flex items-center justify-center gap-2 py-3 bg-p01-surface text-white font-medium rounded-xl border border-p01-border hover:bg-p01-elevated transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Subscription
          </button>
        </div>
      )}

      {/* Security Info */}
      {sortedSubs.length > 0 && (
        <div className="px-4 pb-4">
          <div className="flex items-start gap-2 p-3 bg-p01-cyan/10 rounded-lg">
            <AlertCircle className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
            <p className="text-xs text-p01-chrome">
              <span className="text-p01-cyan font-medium">Protected: </span>
              Merchants can only charge the approved amount per period. Revoke anytime.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Hook to detect service info for a subscription
 */
function useServiceInfo(sub: StreamSubscription): ServiceInfo | null {
  return useMemo(() => {
    // Try to detect from origin first (most reliable)
    if (sub.origin) {
      const fromOrigin = detectServiceFromOrigin(sub.origin);
      if (fromOrigin) return fromOrigin;
    }

    // Try to detect from name
    const fromName = detectServiceFromName(sub.name);
    return fromName;
  }, [sub.origin, sub.name]);
}

/**
 * Get the appropriate icon component for a category
 */
function getCategoryIconComponent(category: ServiceCategory): React.ComponentType<{ className?: string }> {
  const iconName = CATEGORY_CONFIG[category]?.icon || 'CreditCard';
  return CATEGORY_ICONS[iconName] || CreditCard;
}

function SubscriptionCard({
  subscription: sub,
  index,
  onClick,
}: {
  subscription: StreamSubscription;
  index: number;
  onClick: () => void;
}) {
  const daysUntilNext = Math.ceil(
    (sub.nextPayment - Date.now()) / (1000 * 60 * 60 * 24)
  );

  // Detect service info from registry
  const serviceInfo = useServiceInfo(sub);

  // Determine logo and styling
  const logo = serviceInfo?.logo || sub.merchantLogo;
  const brandColor = serviceInfo?.color;
  const category = serviceInfo?.category;
  const CategoryIcon = category ? getCategoryIconComponent(category) : null;

  // Check privacy features
  const hasPrivacyFeatures = sub.amountNoise > 0 || sub.timingNoise > 0 || sub.useStealthAddress;

  return (
    <motion.button
      initial={{ x: -10, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ delay: index * 0.05 }}
      onClick={onClick}
      className="w-full flex items-center gap-3 p-4 bg-p01-surface rounded-xl hover:bg-p01-elevated transition-colors text-left"
    >
      {/* Logo with brand color accent */}
      <div
        className={cn(
          'w-12 h-12 rounded-xl flex items-center justify-center relative',
          sub.status === 'active' ? 'bg-p01-border' : 'bg-p01-border/50'
        )}
        style={brandColor && sub.status === 'active' ? {
          boxShadow: `0 0 0 1px ${brandColor}30`,
          background: `linear-gradient(135deg, ${brandColor}15, transparent)`,
        } : undefined}
      >
        {logo ? (
          <img
            src={logo}
            alt={sub.name}
            className={cn(
              'w-6 h-6',
              sub.status !== 'active' && 'opacity-50'
            )}
            style={{
              filter: brandColor && sub.status === 'active'
                ? `drop-shadow(0 0 1px ${brandColor})`
                : 'invert(1)',
            }}
            onError={(e) => {
              // Hide broken images
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span
            className="text-lg font-bold"
            style={{ color: brandColor || '#a3a3a3' }}
          >
            {sub.name.slice(0, 1).toUpperCase()}
          </span>
        )}

        {/* Privacy indicator */}
        {hasPrivacyFeatures && sub.status === 'active' && (
          <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-p01-cyan flex items-center justify-center">
            <Shield className="w-2.5 h-2.5 text-p01-void" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p
            className={cn(
              'text-sm font-medium truncate',
              sub.status === 'active' ? 'text-white' : 'text-p01-chrome/60'
            )}
          >
            {serviceInfo?.name || sub.name}
          </p>
          {sub.status === 'paused' && (
            <span className="px-1.5 py-0.5 text-[10px] bg-yellow-500/20 text-yellow-500 rounded flex-shrink-0">
              Paused
            </span>
          )}
        </div>

        {/* Category badge */}
        {category && sub.status === 'active' && (
          <div className="flex items-center gap-1.5 mt-0.5" style={{ color: brandColor || getCategoryColor(category) }}>
            {CategoryIcon && (
              <CategoryIcon className="w-3 h-3" />
            )}
            <span className="text-[10px]">
              {getCategoryLabel(category)}
            </span>
          </div>
        )}

        <p className="text-xs text-p01-chrome/60 mt-0.5">
          {sub.status === 'active'
            ? daysUntilNext <= 0
              ? 'Payment due now'
              : daysUntilNext === 1
              ? 'Due tomorrow'
              : `Next in ${daysUntilNext} days`
            : 'Subscription paused'}
        </p>

        {/* Privacy badges */}
        {hasPrivacyFeatures && sub.status === 'active' && (
          <div className="flex items-center gap-1 mt-1.5">
            {sub.amountNoise > 0 && (
              <span className="px-1.5 py-0.5 text-[9px] bg-p01-cyan/20 text-p01-cyan rounded">
                +/-{sub.amountNoise}%
              </span>
            )}
            {sub.timingNoise > 0 && (
              <span className="px-1.5 py-0.5 text-[9px] bg-streams/20 text-streams rounded">
                +/-{sub.timingNoise}h
              </span>
            )}
            {sub.useStealthAddress && (
              <span className="px-1.5 py-0.5 text-[9px] bg-purple-500/20 text-purple-400 rounded">
                Stealth
              </span>
            )}
          </div>
        )}
      </div>

      {/* Amount */}
      <div className="text-right flex-shrink-0">
        <p
          className={cn(
            'text-sm font-medium',
            sub.status === 'active' ? 'text-white' : 'text-p01-chrome/60'
          )}
        >
          {sub.amount.toFixed(sub.amount < 1 ? 4 : 2)} {sub.tokenSymbol}
        </p>
        <p className="text-xs text-p01-chrome/60">
          {formatInterval(sub.interval)}
        </p>
      </div>

      <ChevronRight className="w-4 h-4 text-p01-chrome/40 flex-shrink-0" />
    </motion.button>
  );
}
