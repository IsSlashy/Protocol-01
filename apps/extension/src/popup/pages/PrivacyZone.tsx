import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Shield,
  ShieldCheck,
  ShieldOff,
  Waves,
  Clock,
  Users,
  Shuffle,
  Zap,
  Info,
  RefreshCw,
  Trash2,
  Activity,
  Radio,
  Bluetooth,
} from 'lucide-react';
import {
  usePrivacyStore,
  getPrivacyScoreColor,
  getPrivacyScoreLabel,
  getNoiseLevelDescription,
} from '@/shared/store/privacy';
import { NoiseLevel } from '@/shared/services/privacyZone';
import { cn } from '@/shared/utils';

export default function PrivacyZone() {
  const navigate = useNavigate();

  const {
    config,
    stats,
    walletPrivacyScore,
    nearbyUsers,
    mixingPools,
    pendingBatchCount,
    setEnabled,
    setNoiseLevel,
    setBatchingEnabled,
    setDecoyEnabled,
    setMixingEnabled,
    setAutoPrivacy,
    executePendingBatch,
    clearPendingBatch,
    refreshNearbyUsers,
    refreshMixingPools,
    clearHistory,
  } = usePrivacyStore();

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);

  // Refresh data on mount
  useEffect(() => {
    refreshNearbyUsers();
    refreshMixingPools();
  }, []);

  const noiseLevels: { value: NoiseLevel; label: string; icon: React.ReactNode }[] = [
    { value: 'low', label: 'Low', icon: <Waves className="w-4 h-4" /> },
    { value: 'medium', label: 'Medium', icon: <Waves className="w-5 h-5" /> },
    { value: 'high', label: 'High', icon: <Waves className="w-6 h-6" /> },
  ];

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
            <Shield className="w-5 h-5 text-p01-cyan" />
            <h1 className="text-white font-display font-bold tracking-wide">Privacy Zone</h1>
          </div>
        </div>
        <button
          onClick={() => setShowInfoModal(true)}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
        >
          <Info className="w-5 h-5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto pb-4">
        {/* Privacy Score Card */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="mx-4 mt-4 bg-p01-surface rounded-2xl p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {config.enabled ? (
                <div className="w-12 h-12 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                  <ShieldCheck className="w-6 h-6 text-p01-cyan" />
                </div>
              ) : (
                <div className="w-12 h-12 rounded-full bg-p01-border flex items-center justify-center">
                  <ShieldOff className="w-6 h-6 text-p01-chrome/60" />
                </div>
              )}
              <div>
                <p className="text-white font-medium">
                  {config.enabled ? 'Privacy Zone Active' : 'Privacy Zone Disabled'}
                </p>
                <p className="text-p01-chrome text-xs">
                  {config.enabled
                    ? `${getNoiseLevelDescription(config.noiseLevel)}`
                    : 'Enable for enhanced privacy'}
                </p>
              </div>
            </div>

            {/* Toggle */}
            <button
              onClick={() => setEnabled(!config.enabled)}
              className={cn(
                'w-14 h-8 rounded-full transition-colors relative',
                config.enabled ? 'bg-p01-cyan' : 'bg-p01-border'
              )}
            >
              <motion.span
                layout
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className={cn(
                  'absolute top-1 w-6 h-6 rounded-full bg-white shadow-md',
                  config.enabled ? 'left-7' : 'left-1'
                )}
              />
            </button>
          </div>

          {/* Privacy Score */}
          <div className="bg-p01-void rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-p01-chrome text-xs font-mono tracking-wider">
                WALLET PRIVACY SCORE
              </span>
              <span className={cn('text-xs font-medium', getPrivacyScoreColor(walletPrivacyScore))}>
                {getPrivacyScoreLabel(walletPrivacyScore)}
              </span>
            </div>
            <div className="flex items-end gap-3">
              <span className={cn('text-4xl font-display font-bold', getPrivacyScoreColor(walletPrivacyScore))}>
                {walletPrivacyScore}
              </span>
              <span className="text-p01-chrome text-lg mb-1">/100</span>
            </div>
            {/* Progress bar */}
            <div className="mt-3 h-2 bg-p01-border rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${walletPrivacyScore}%` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
                className={cn(
                  'h-full rounded-full',
                  walletPrivacyScore >= 80
                    ? 'bg-green-500'
                    : walletPrivacyScore >= 60
                    ? 'bg-p01-cyan'
                    : walletPrivacyScore >= 40
                    ? 'bg-yellow-500'
                    : 'bg-orange-500'
                )}
              />
            </div>
          </div>
        </motion.div>

        {/* Noise Level Selector */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="mx-4 mt-4"
        >
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            NOISE LEVEL
          </p>
          <div className="bg-p01-surface rounded-xl p-4">
            <div className="flex gap-2">
              {noiseLevels.map((level) => (
                <button
                  key={level.value}
                  onClick={() => setNoiseLevel(level.value)}
                  disabled={!config.enabled}
                  className={cn(
                    'flex-1 py-3 rounded-lg text-sm font-medium transition-all flex flex-col items-center gap-2',
                    config.noiseLevel === level.value && config.enabled
                      ? 'bg-p01-cyan/20 text-p01-cyan border border-p01-cyan/40'
                      : config.enabled
                      ? 'bg-p01-void text-p01-chrome/60 hover:text-white'
                      : 'bg-p01-void text-p01-chrome/30 cursor-not-allowed'
                  )}
                >
                  {level.icon}
                  <span>{level.label}</span>
                </button>
              ))}
            </div>
            <p className="text-p01-chrome/60 text-xs mt-3 text-center">
              {config.enabled
                ? getNoiseLevelDescription(config.noiseLevel)
                : 'Enable Privacy Zone to adjust noise level'}
            </p>
          </div>
        </motion.div>

        {/* Privacy Features */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="mx-4 mt-4"
        >
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            PRIVACY FEATURES
          </p>
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            {/* Transaction Batching */}
            <FeatureToggle
              icon={<Clock className="w-5 h-5 text-violet-400" />}
              iconBg="bg-violet-500/20"
              title="Transaction Batching"
              description="Group transactions to obscure timing"
              enabled={config.batchingEnabled}
              onToggle={setBatchingEnabled}
              disabled={!config.enabled}
            />

            {/* Decoy Transactions */}
            <FeatureToggle
              icon={<Shuffle className="w-5 h-5 text-orange-400" />}
              iconBg="bg-orange-500/20"
              title="Decoy Transactions"
              description="Generate noise to confuse analysis"
              enabled={config.decoyEnabled}
              onToggle={setDecoyEnabled}
              disabled={!config.enabled}
            />

            {/* Pool Mixing */}
            <FeatureToggle
              icon={<Users className="w-5 h-5 text-blue-400" />}
              iconBg="bg-blue-500/20"
              title="Pool Mixing"
              description="Mix with other users for anonymity"
              enabled={config.mixingEnabled}
              onToggle={setMixingEnabled}
              disabled={!config.enabled}
            />

            {/* Auto Privacy */}
            <FeatureToggle
              icon={<Zap className="w-5 h-5 text-yellow-400" />}
              iconBg="bg-yellow-500/20"
              title="Auto Privacy"
              description="Apply privacy to all transactions"
              enabled={config.autoPrivacy}
              onToggle={setAutoPrivacy}
              disabled={!config.enabled}
              isLast
            />
          </div>
        </motion.div>

        {/* Pending Batch */}
        {pendingBatchCount > 0 && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="mx-4 mt-4"
          >
            <div className="bg-p01-surface rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-p01-cyan/20 flex items-center justify-center">
                    <Activity className="w-5 h-5 text-p01-cyan animate-pulse" />
                  </div>
                  <div>
                    <p className="text-white font-medium">Pending Batch</p>
                    <p className="text-p01-chrome text-xs">
                      {pendingBatchCount} transaction{pendingBatchCount > 1 ? 's' : ''} waiting
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => executePendingBatch()}
                  className="flex-1 py-2.5 bg-p01-cyan text-p01-void font-medium rounded-lg hover:bg-p01-cyan/90 transition-colors"
                >
                  Execute Now
                </button>
                <button
                  onClick={clearPendingBatch}
                  className="px-4 py-2.5 bg-p01-void text-p01-chrome font-medium rounded-lg hover:text-white transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {/* Nearby Users (Simulated) */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4 }}
          className="mx-4 mt-4"
        >
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-p01-chrome/60 text-xs font-medium tracking-wider">
              NEARBY USERS (SIMULATED)
            </p>
            <button
              onClick={refreshNearbyUsers}
              className="p-1 text-p01-chrome hover:text-white transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
          <div className="bg-p01-surface rounded-xl p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-p01-pink/20 flex items-center justify-center">
                <Radio className="w-5 h-5 text-p01-pink" />
              </div>
              <div className="flex-1">
                <p className="text-white font-medium">
                  {nearbyUsers.length} Protocol 01 User{nearbyUsers.length !== 1 ? 's' : ''}
                </p>
                <p className="text-p01-chrome text-xs">Available for local mixing</p>
              </div>
            </div>
            <div className="bg-p01-void rounded-lg p-3">
              <div className="flex items-center gap-2 text-p01-chrome/60 text-xs">
                <Bluetooth className="w-4 h-4" />
                <span>
                  Bluetooth mixing coming soon with mobile app
                </span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Statistics */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mx-4 mt-4"
        >
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            PRIVACY STATISTICS
          </p>
          <div className="bg-p01-surface rounded-xl p-4">
            <div className="grid grid-cols-2 gap-4">
              <StatCard
                label="Protected Txs"
                value={stats.totalProtectedTransactions}
                icon={<Shield className="w-4 h-4 text-p01-cyan" />}
              />
              <StatCard
                label="Decoys Generated"
                value={stats.totalDecoysGenerated}
                icon={<Shuffle className="w-4 h-4 text-orange-400" />}
              />
              <StatCard
                label="Mixed Txs"
                value={stats.totalMixedTransactions}
                icon={<Users className="w-4 h-4 text-blue-400" />}
              />
              <StatCard
                label="Batched Txs"
                value={stats.totalBatchedTransactions}
                icon={<Clock className="w-4 h-4 text-violet-400" />}
              />
            </div>

            <button
              onClick={() => setShowClearConfirm(true)}
              className="w-full mt-4 py-2 text-p01-chrome/60 text-xs hover:text-red-400 transition-colors"
            >
              Clear Privacy History
            </button>
          </div>
        </motion.div>

        {/* Mixing Pools Info */}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mx-4 mt-4 mb-4"
        >
          <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
            MIXING POOLS
          </p>
          <div className="bg-p01-surface rounded-xl overflow-hidden">
            {mixingPools.map((pool, index) => (
              <div
                key={pool.id}
                className={cn(
                  'p-4 flex items-center justify-between',
                  index < mixingPools.length - 1 && 'border-b border-p01-border/50'
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                    <Users className="w-5 h-5 text-green-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium capitalize">
                      {pool.id.replace('pool-', 'Pool ')}
                    </p>
                    <p className="text-p01-chrome text-xs">
                      {pool.participants.length} participants
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-white text-sm font-mono">
                    {pool.minMixAmount}-{pool.maxMixAmount} SOL
                  </p>
                  <p className="text-p01-chrome text-xs">Range</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Clear History Confirmation Modal */}
      {showClearConfirm && (
        <div className="absolute inset-0 bg-black/80 flex items-end justify-center p-4 z-50">
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full bg-p01-surface rounded-2xl p-5"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash2 className="w-6 h-6 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-display font-bold text-white">
                  Clear Privacy History?
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  This will reset all statistics
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="flex-1 py-3 bg-p01-void text-white font-medium rounded-xl hover:bg-p01-border transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  clearHistory();
                  setShowClearConfirm(false);
                }}
                className="flex-1 py-3 bg-red-500 text-white font-medium rounded-xl hover:bg-red-600 transition-colors"
              >
                Clear
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
                <Shield className="w-6 h-6 text-p01-cyan" />
              </div>
              <div>
                <h3 className="text-lg font-display font-bold text-white">
                  About Privacy Zone
                </h3>
                <p className="text-sm text-p01-chrome/60">
                  Bluetooth Noising Technology
                </p>
              </div>
            </div>

            <div className="space-y-4 text-sm">
              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">What is Privacy Zone?</h4>
                <p className="text-p01-chrome/80">
                  Privacy Zone creates a protective "noise field" around your transactions,
                  making on-chain analysis significantly harder.
                </p>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">How it works</h4>
                <ul className="text-p01-chrome/80 space-y-2">
                  <li><strong>Batching:</strong> Groups transactions to obscure timing patterns</li>
                  <li><strong>Decoys:</strong> Generates fake transactions that cancel out</li>
                  <li><strong>Mixing:</strong> Combines your tx with others in a privacy pool</li>
                  <li><strong>Fuzzing:</strong> Slightly randomizes amounts</li>
                </ul>
              </div>

              <div className="bg-p01-void rounded-xl p-4">
                <h4 className="text-white font-medium mb-2">Coming Soon</h4>
                <p className="text-p01-chrome/80">
                  Mobile app with Bluetooth-based local mixing will allow nearby
                  Protocol 01 users to create truly decentralized privacy pools.
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

// Feature Toggle Component
function FeatureToggle({
  icon,
  iconBg,
  title,
  description,
  enabled,
  onToggle,
  disabled,
  isLast,
}: {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
  isLast?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between p-4',
        !isLast && 'border-b border-p01-border/50'
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center', iconBg)}>
          {icon}
        </div>
        <div>
          <p className={cn('font-medium', disabled ? 'text-p01-chrome/40' : 'text-white')}>
            {title}
          </p>
          <p className={cn('text-xs', disabled ? 'text-p01-chrome/30' : 'text-p01-chrome/60')}>
            {description}
          </p>
        </div>
      </div>
      <button
        onClick={() => onToggle(!enabled)}
        disabled={disabled}
        className={cn(
          'w-12 h-7 rounded-full transition-colors relative',
          disabled
            ? 'bg-p01-border/50 cursor-not-allowed'
            : enabled
            ? 'bg-p01-cyan'
            : 'bg-p01-border'
        )}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className={cn(
            'absolute top-1 w-5 h-5 rounded-full shadow-md',
            disabled ? 'bg-p01-chrome/50' : 'bg-white',
            enabled ? 'left-6' : 'left-1'
          )}
        />
      </button>
    </div>
  );
}

// Stat Card Component
function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-p01-void rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-p01-chrome/60 text-xs">{label}</span>
      </div>
      <p className="text-white text-xl font-display font-bold">{value}</p>
    </div>
  );
}
