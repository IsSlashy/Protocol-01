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
  RefreshCw,
  Loader2,
  User,
  Grid,
  Palette,
  Info,
  CheckCircle,
  Wallet,
  ShieldCheck,
} from 'lucide-react';
import { cn, formatCurrency } from '@/shared/utils';
import { useSubscriptionsStore, useSubscriptionStats } from '@/shared/store/subscriptions';
import { useWalletStore } from '@/shared/store/wallet';
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

// Mock SDK Services - In production, these come from SDK providers
const SDK_SERVICES = [
  { id: 'netflix', name: 'Netflix', icon: Play, price: 0.15, frequency: 'monthly' as const, category: 'Entertainment' },
  { id: 'spotify', name: 'Spotify', icon: Music, price: 0.08, frequency: 'monthly' as const, category: 'Music' },
  { id: 'chatgpt', name: 'ChatGPT Plus', icon: Bot, price: 0.18, frequency: 'monthly' as const, category: 'AI' },
  { id: 'github', name: 'GitHub Pro', icon: Cloud, price: 0.04, frequency: 'monthly' as const, category: 'Dev Tools' },
  { id: 'figma', name: 'Figma', icon: Palette, price: 0.12, frequency: 'monthly' as const, category: 'Design' },
  { id: 'notion', name: 'Notion', icon: Briefcase, price: 0.07, frequency: 'monthly' as const, category: 'Productivity' },
];

type SectionType = 'personal' | 'services';

export default function Subscriptions() {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<SectionType>('personal');
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const { subscriptions, refreshComputedValues, syncFromChain } = useSubscriptionsStore();
  const { publicKey, network } = useWalletStore();
  const stats = useSubscriptionStats();

  // Handle sync from blockchain
  const handleSync = async () => {
    if (!publicKey || isSyncing) return;

    setIsSyncing(true);
    try {
      const result = await syncFromChain(publicKey, network);
      if (result.newCount > 0 || result.updatedCount > 0) {
      }
    } catch (error) {
      console.error('[Streams] Sync failed:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  // Refresh computed values on mount
  useEffect(() => {
    refreshComputedValues();
  }, [refreshComputedValues]);

  // Filter out cancelled subscriptions
  const activeSubscriptions = subscriptions.filter(s => s.status !== 'cancelled');

  // Sort by next payment (soonest first)
  const sortedSubs = [...activeSubscriptions].sort((a, b) => {
    if (a.status !== 'active' && b.status === 'active') return 1;
    if (a.status === 'active' && b.status !== 'active') return -1;
    return a.nextPayment - b.nextPayment;
  });

  // Separate streams by type (SDK services vs personal)
  const serviceStreams = sortedSubs.filter(s =>
    SDK_SERVICES.some(svc => s.name.toLowerCase().includes(svc.name.toLowerCase()))
  );
  const personalStreams = sortedSubs.filter(s =>
    !SDK_SERVICES.some(svc => s.name.toLowerCase().includes(svc.name.toLowerCase()))
  );

  // Calculate privacy score (how many have privacy features enabled)
  const activeCount = subscriptions.filter(s => s.status === 'active').length;
  const privacyScore = activeCount > 0
    ? Math.round(
        (subscriptions.filter(s =>
          s.status === 'active' &&
          (s.amountNoise > 0 || s.timingNoise > 0 || s.useStealthAddress)
        ).length / activeCount) * 100
      )
    : 0;

  // Next payment
  const activeStreams = subscriptions.filter(s => s.status === 'active');
  const nextDue = activeStreams.length > 0
    ? Math.min(...activeStreams.map(s => s.nextPayment))
    : null;

  const handleSubscribeService = (service: typeof SDK_SERVICES[0]) => {
    // Navigate to subscribe flow with pre-filled service data
    navigate('/subscriptions/new', {
      state: {
        serviceId: service.id,
        serviceName: service.name,
        price: service.price,
        frequency: service.frequency,
      },
    });
  };

  const handleCreatePersonalStream = () => {
    navigate('/subscriptions/new');
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Summary Card */}
      <div className="p-4">
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-gradient-to-br from-p01-cyan/20 to-p01-surface rounded-xl p-4 border border-p01-cyan/30"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Repeat className="w-5 h-5 text-p01-cyan" />
              <span className="text-sm font-medium text-p01-cyan">
                Stream Secure
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSync}
                disabled={!publicKey || isSyncing}
                className="p-1.5 rounded-lg bg-p01-surface/50 hover:bg-p01-surface transition-colors disabled:opacity-50"
                title="Sync from blockchain"
              >
                {isSyncing ? (
                  <Loader2 className="w-4 h-4 text-p01-cyan animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4 text-p01-cyan" />
                )}
              </button>
              <button
                onClick={() => setShowPrivacyInfo(!showPrivacyInfo)}
                className="p-1.5 rounded-lg bg-p01-surface/50 hover:bg-p01-surface transition-colors"
                title="Privacy Info"
              >
                <Shield className="w-4 h-4 text-p01-cyan" />
              </button>
            </div>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-display font-bold text-white">
              {stats.monthlyCost.toFixed(2)}
            </span>
            <span className="text-sm text-p01-chrome/60">SOL/month</span>
          </div>

          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-p01-chrome/60">
              {activeCount} active stream{activeCount !== 1 ? 's' : ''}
            </p>
            {nextDue && (
              <p className="text-xs text-p01-chrome/60">
                Next: {new Date(nextDue).toLocaleDateString()}
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
                  className="h-full bg-p01-cyan rounded-full"
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
              <ShieldCheck className="w-4 h-4" />
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
                    Vary amounts by up to 20%
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-p01-cyan/10 flex items-center justify-center flex-shrink-0">
                  <Clock className="w-4 h-4 text-p01-cyan" />
                </div>
                <div>
                  <p className="text-xs font-medium text-white">Timing Noise</p>
                  <p className="text-xs text-p01-chrome/60">
                    Randomize payment times
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-p01-pink/10 flex items-center justify-center flex-shrink-0">
                  <EyeOff className="w-4 h-4 text-p01-pink" />
                </div>
                <div>
                  <p className="text-xs font-medium text-white">Stealth Addresses</p>
                  <p className="text-xs text-p01-chrome/60">
                    Unique address per payment
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* Section Toggle */}
      <div className="px-4 mb-4">
        <div className="flex gap-1 p-1 bg-p01-surface rounded-xl">
          <button
            onClick={() => setActiveSection('personal')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 py-3 rounded-lg transition-all font-medium text-sm',
              activeSection === 'personal'
                ? 'bg-p01-cyan text-p01-void'
                : 'text-p01-chrome/60 hover:text-p01-chrome'
            )}
          >
            <User className="w-4 h-4" />
            Personal
          </button>
          <button
            onClick={() => setActiveSection('services')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 py-3 rounded-lg transition-all font-medium text-sm',
              activeSection === 'services'
                ? 'bg-p01-pink text-p01-void'
                : 'text-p01-chrome/60 hover:text-p01-chrome'
            )}
          >
            <Grid className="w-4 h-4" />
            Services
          </button>
        </div>
      </div>

      {/* Services Section */}
      {activeSection === 'services' && (
        <div className="px-4 pb-4">
          {/* Section Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Grid className="w-4 h-4 text-p01-pink" />
              <span className="text-sm font-semibold text-white">Available Services</span>
            </div>
            <span className="text-xs text-p01-chrome/60">
              {SDK_SERVICES.length} services
            </span>
          </div>

          {/* Info Banner */}
          <div className="flex items-center gap-2 p-3 bg-p01-pink/10 rounded-lg border border-p01-pink/20 mb-4">
            <Info className="w-4 h-4 text-p01-pink flex-shrink-0" />
            <p className="text-xs text-p01-chrome/80">
              Prices are set by service providers via SDK. Subscribe with one tap.
            </p>
          </div>

          {/* Services Grid */}
          <div className="space-y-2">
            {SDK_SERVICES.map((service, index) => (
              <ServiceCard
                key={service.id}
                service={service}
                index={index}
                onSubscribe={() => handleSubscribeService(service)}
                isSubscribed={serviceStreams.some(s =>
                  s.name.toLowerCase().includes(service.name.toLowerCase()) &&
                  s.status === 'active'
                )}
              />
            ))}
          </div>

          {/* Active Subscriptions */}
          {serviceStreams.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="w-4 h-4 text-green-400" />
                <span className="text-sm font-semibold text-white">
                  Your Subscriptions ({serviceStreams.length})
                </span>
              </div>
              <div className="space-y-2">
                {serviceStreams.map((sub, index) => (
                  <SubscriptionCard
                    key={sub.id}
                    subscription={sub}
                    index={index}
                    onClick={() => navigate(`/subscriptions/${sub.id}`)}
                    accentColor="p01-pink"
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Personal Payments Section */}
      {activeSection === 'personal' && (
        <div className="px-4 pb-4">
          {/* Section Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-p01-cyan" />
              <span className="text-sm font-semibold text-white">Personal Payments</span>
            </div>
            <span className="text-xs text-p01-chrome/60">
              {personalStreams.length} stream{personalStreams.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Info Banner */}
          <div className="flex items-center gap-2 p-3 bg-p01-cyan/10 rounded-lg border border-p01-cyan/20 mb-4">
            <Info className="w-4 h-4 text-p01-cyan flex-shrink-0" />
            <p className="text-xs text-p01-chrome/80">
              Create custom payment streams for salaries, allowances, or recurring transfers.
            </p>
          </div>

          {/* Create Button */}
          <button
            onClick={handleCreatePersonalStream}
            className="w-full flex items-center justify-center gap-2 py-4 bg-p01-cyan text-p01-void font-semibold rounded-xl hover:bg-p01-cyan/90 transition-colors mb-4"
          >
            <Plus className="w-5 h-5" />
            Create Payment Stream
          </button>

          {/* Personal Streams List */}
          {personalStreams.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-16 h-16 rounded-full bg-p01-cyan/10 flex items-center justify-center mb-4">
                <Wallet className="w-7 h-7 text-p01-cyan" />
              </div>
              <p className="text-sm text-p01-chrome/60 mb-1">
                No personal streams yet
              </p>
              <p className="text-xs text-p01-chrome/40">
                Create one to pay salaries or recurring transfers
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {personalStreams.map((sub, index) => (
                <SubscriptionCard
                  key={sub.id}
                  subscription={sub}
                  index={index}
                  onClick={() => navigate(`/subscriptions/${sub.id}`)}
                  accentColor="p01-cyan"
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Security Info */}
      <div className="px-4 pb-4 mt-auto">
        <div className="flex items-start gap-2 p-3 bg-p01-cyan/10 rounded-lg">
          <ShieldCheck className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
          <p className="text-xs text-p01-chrome">
            <span className="text-p01-cyan font-medium">Protected: </span>
            All streams are secured on Solana. Recipients can only receive approved amounts.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Service Card Component - For available SDK services
 */
function ServiceCard({
  service,
  index,
  onSubscribe,
  isSubscribed,
}: {
  service: typeof SDK_SERVICES[0];
  index: number;
  onSubscribe: () => void;
  isSubscribed: boolean;
}) {
  const Icon = service.icon;

  return (
    <motion.button
      initial={{ x: -10, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ delay: index * 0.03 }}
      onClick={onSubscribe}
      disabled={isSubscribed}
      className={cn(
        'w-full flex items-center gap-3 p-3.5 bg-p01-surface rounded-xl transition-colors text-left',
        isSubscribed
          ? 'border border-green-500/30'
          : 'border border-p01-border hover:bg-p01-elevated'
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          'w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0',
          isSubscribed ? 'bg-green-500/10' : 'bg-p01-pink/10'
        )}
      >
        <Icon className={cn('w-5 h-5', isSubscribed ? 'text-green-400' : 'text-p01-pink')} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{service.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          {isSubscribed && (
            <span className="px-1.5 py-0.5 text-[9px] bg-green-500/20 text-green-400 rounded font-medium">
              ACTIVE
            </span>
          )}
          <span className="text-xs text-p01-chrome/60">{service.category}</span>
        </div>
      </div>

      {/* Price */}
      <div className="text-right flex-shrink-0">
        <p className="text-sm font-semibold text-white">{service.price} SOL</p>
        <p className="text-xs text-p01-chrome/60">/{service.frequency}</p>
      </div>

      {/* Subscribe button */}
      {!isSubscribed && (
        <div className="px-3 py-2 bg-p01-pink text-p01-void text-xs font-semibold rounded-lg flex-shrink-0">
          Subscribe
        </div>
      )}
    </motion.button>
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

/**
 * Subscription Card Component - For user's active subscriptions
 */
function SubscriptionCard({
  subscription: sub,
  index,
  onClick,
  accentColor = 'p01-cyan',
}: {
  subscription: StreamSubscription;
  index: number;
  onClick: () => void;
  accentColor?: 'p01-cyan' | 'p01-pink';
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
  const isActive = sub.status === 'active';
  const isPaused = sub.status === 'paused';
  const initial = sub.name.slice(0, 1).toUpperCase();

  const getStatusText = () => {
    if (isPaused) return 'Stream paused';
    if (daysUntilNext <= 0) return 'Payment due now';
    if (daysUntilNext === 1) return 'Due tomorrow';
    return `Next in ${daysUntilNext} days`;
  };

  return (
    <motion.button
      initial={{ x: -10, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ delay: index * 0.04 }}
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3.5 bg-p01-surface rounded-xl hover:bg-p01-elevated transition-colors text-left"
    >
      {/* Logo */}
      <div
        className={cn(
          'w-11 h-11 rounded-xl flex items-center justify-center relative flex-shrink-0',
          isActive ? 'bg-p01-border' : 'bg-p01-border/50'
        )}
        style={brandColor && isActive ? {
          boxShadow: `0 0 0 1px ${brandColor}30`,
          background: `linear-gradient(135deg, ${brandColor}15, transparent)`,
        } : undefined}
      >
        {logo ? (
          <img
            src={logo}
            alt={sub.name}
            className={cn('w-6 h-6', !isActive && 'opacity-50')}
            style={{
              filter: brandColor && isActive
                ? `drop-shadow(0 0 1px ${brandColor})`
                : 'invert(1)',
            }}
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span
            className={cn('text-lg font-bold', isActive ? 'text-p01-chrome/60' : 'text-p01-chrome/40')}
          >
            {initial}
          </span>
        )}

        {/* Privacy indicator */}
        {hasPrivacyFeatures && isActive && (
          <div className={cn(
            'absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center',
            accentColor === 'p01-pink' ? 'bg-p01-pink' : 'bg-p01-cyan'
          )}>
            <Shield className="w-2.5 h-2.5 text-p01-void" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            'text-sm font-medium truncate',
            isActive ? 'text-white' : 'text-p01-chrome/60'
          )}
        >
          {serviceInfo?.name || sub.name}
        </p>

        {/* Status row */}
        <div className="flex items-center gap-1.5 mt-0.5">
          {isPaused && (
            <span className="px-1.5 py-0.5 text-[9px] bg-yellow-500/20 text-yellow-500 rounded font-medium">
              PAUSED
            </span>
          )}
          <span className="text-xs text-p01-chrome/60">{getStatusText()}</span>
        </div>

        {/* Privacy badges */}
        {hasPrivacyFeatures && isActive && (
          <div className="flex items-center gap-1 mt-1.5 flex-wrap">
            {sub.amountNoise > 0 && (
              <span className={cn(
                'px-1.5 py-0.5 text-[9px] rounded',
                accentColor === 'p01-pink' ? 'bg-p01-pink/20 text-p01-pink' : 'bg-p01-cyan/20 text-p01-cyan'
              )}>
                +/-{sub.amountNoise}%
              </span>
            )}
            {sub.timingNoise > 0 && (
              <span className={cn(
                'px-1.5 py-0.5 text-[9px] rounded',
                accentColor === 'p01-pink' ? 'bg-p01-pink/20 text-p01-pink' : 'bg-p01-cyan/20 text-p01-cyan'
              )}>
                +/-{sub.timingNoise}h
              </span>
            )}
            {sub.useStealthAddress && (
              <span className="px-1.5 py-0.5 text-[9px] bg-p01-pink/20 text-p01-pink rounded">
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
            'text-sm font-semibold',
            isActive ? 'text-white' : 'text-p01-chrome/60'
          )}
        >
          {sub.amount.toFixed(sub.amount < 1 ? 4 : 2)} SOL
        </p>
        <p className="text-xs text-p01-chrome/60">
          {formatInterval(sub.interval)}
        </p>
      </div>

      <ChevronRight className="w-4 h-4 text-p01-chrome/40 flex-shrink-0" />
    </motion.button>
  );
}
