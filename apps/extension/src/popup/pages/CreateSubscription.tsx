import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Shield,
  Shuffle,
  Clock,
  EyeOff,
  AlertCircle,
  Loader2,
  ChevronDown,
  Info,
  Search,
  X,
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
import { cn } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { validateRecipient, SubscriptionInterval } from '@/shared/services/stream';
import {
  searchServices,
  getPopularServices,
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
function getCategoryIconComponent(category: ServiceCategory): React.ComponentType<{ className?: string; style?: React.CSSProperties }> {
  const iconName = CATEGORY_CONFIG[category]?.icon || 'CreditCard';
  return CATEGORY_ICONS[iconName] || CreditCard;
}

const INTERVALS: { value: SubscriptionInterval; label: string; days: number }[] = [
  { value: 'daily', label: 'Daily', days: 1 },
  { value: 'weekly', label: 'Weekly', days: 7 },
  { value: 'monthly', label: 'Monthly', days: 30 },
  { value: 'yearly', label: 'Yearly', days: 365 },
];

export default function CreateSubscription() {
  const navigate = useNavigate();
  const { addSubscription } = useSubscriptionsStore();
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Form state
  const [name, setName] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [interval, setInterval] = useState<SubscriptionInterval>('monthly');
  const [maxPayments, setMaxPayments] = useState('12'); // Default 12 months
  const [selectedService, setSelectedService] = useState<ServiceInfo | null>(null);

  // Service search state
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Privacy settings
  const [amountNoise, setAmountNoise] = useState(5); // Default 5%
  const [timingNoise, setTimingNoise] = useState(2); // Default 2 hours
  const [useStealthAddress, setUseStealthAddress] = useState(false);
  const [showPrivacyOptions, setShowPrivacyOptions] = useState(true);

  // UI state
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get popular services for quick selection
  const popularServices = useMemo(() => getPopularServices(), []);

  // Search results based on current query
  const searchResults = useMemo(() => {
    if (searchQuery.length < 2) return [];
    return searchServices(searchQuery, 6);
  }, [searchQuery]);

  // Auto-detect service when name changes
  useEffect(() => {
    if (name && !selectedService) {
      const detected = detectServiceFromName(name, 0.8);
      if (detected) {
        setSelectedService(detected);
      }
    }
  }, [name, selectedService]);

  // Validation
  const isValidRecipient = recipient.length === 0 || validateRecipient(recipient);
  const isValidAmount = amount.length === 0 || (parseFloat(amount) > 0 && !isNaN(parseFloat(amount)));
  const canSubmit = name.trim() && recipient && isValidRecipient && amount && isValidAmount;

  // Calculate monthly equivalent
  const calculateMonthlyEquivalent = () => {
    if (!amount || !isValidAmount) return null;
    const amountNum = parseFloat(amount);
    const multiplier = {
      daily: 30,
      weekly: 4.33,
      monthly: 1,
      yearly: 1 / 12,
    }[interval];
    return (amountNum * multiplier).toFixed(2);
  };

  const handleServiceSelect = (service: ServiceInfo) => {
    setSelectedService(service);
    setName(service.name);
    setShowSuggestions(false);
    setSearchQuery('');
  };

  const handleClearService = () => {
    setSelectedService(null);
    setName('');
    setSearchQuery('');
    nameInputRef.current?.focus();
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setSearchQuery(value);
    if (value.length >= 2) {
      setShowSuggestions(true);
    }
    // Clear selected service if user is typing something different
    if (selectedService && value.toLowerCase() !== selectedService.name.toLowerCase()) {
      setSelectedService(null);
    }
  };

  const handleNameBlur = () => {
    // Delay hiding suggestions to allow clicking on them
    setTimeout(() => setShowSuggestions(false), 200);
  };

  const handleCreate = async () => {
    if (!canSubmit) return;

    setIsCreating(true);
    setError(null);

    try {
      const subscription = addSubscription({
        name: name.trim(),
        recipient,
        amount: parseFloat(amount),
        interval,
        maxPayments: parseInt(maxPayments) || 0,
        amountNoise,
        timingNoise,
        useStealthAddress,
        merchantLogo: selectedService?.logo || undefined,
      });

      // Navigate to the new subscription's details
      navigate(`/subscriptions/${subscription.id}`);
    } catch (err) {
      setError((err as Error).message);
      setIsCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 border-b border-p01-border">
        <button
          onClick={() => navigate(-1)}
          className="p-2 -ml-2 hover:bg-p01-surface rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-p01-chrome" />
        </button>
        <h1 className="text-lg font-semibold text-white">New Subscription</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Popular Services Quick Selection */}
        <div>
          <label className="text-xs font-medium text-p01-chrome/60 mb-2 block">
            Popular Services
          </label>
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4">
            {popularServices.map((service) => {
              const CategoryIcon = getCategoryIconComponent(service.category);
              const isSelected = selectedService?.id === service.id;
              return (
                <button
                  key={service.id}
                  onClick={() => handleServiceSelect(service)}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors flex-shrink-0',
                    isSelected
                      ? 'border-p01-cyan'
                      : 'bg-p01-surface border-p01-border text-p01-chrome hover:border-p01-chrome/50'
                  )}
                  style={isSelected ? {
                    backgroundColor: `${service.color}20`,
                    borderColor: service.color,
                  } : undefined}
                >
                  {service.logo ? (
                    <img
                      src={service.logo}
                      alt={service.name}
                      className="w-4 h-4"
                      style={{
                        filter: isSelected && service.color
                          ? `drop-shadow(0 0 1px ${service.color})`
                          : 'invert(1)',
                      }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <CategoryIcon className="w-4 h-4" style={{ color: service.color }} />
                  )}
                  <span
                    className="text-xs font-medium"
                    style={isSelected ? { color: service.color } : undefined}
                  >
                    {service.name}
                  </span>
                </button>
              );
            })}
            {/* Custom option */}
            <button
              onClick={handleClearService}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors flex-shrink-0',
                !selectedService
                  ? 'bg-p01-cyan/20 border-p01-cyan text-p01-cyan'
                  : 'bg-p01-surface border-p01-border text-p01-chrome hover:border-p01-chrome/50'
              )}
            >
              <CreditCard className="w-4 h-4" />
              <span className="text-xs font-medium">Custom</span>
            </button>
          </div>
        </div>

        {/* Name Input with Service Search */}
        <div className="relative">
          <label className="text-xs font-medium text-p01-chrome/60 mb-2 block">
            Service Name
          </label>

          {/* Selected Service Display */}
          {selectedService ? (
            <div
              className="flex items-center gap-3 p-3 rounded-xl border"
              style={{
                backgroundColor: `${selectedService.color}10`,
                borderColor: `${selectedService.color}40`,
              }}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: `${selectedService.color}20` }}
              >
                {selectedService.logo ? (
                  <img
                    src={selectedService.logo}
                    alt={selectedService.name}
                    className="w-5 h-5"
                    style={{ filter: `drop-shadow(0 0 1px ${selectedService.color})` }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <span style={{ color: selectedService.color }} className="font-bold">
                    {selectedService.name.slice(0, 1)}
                  </span>
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-white">{selectedService.name}</p>
                <div className="flex items-center gap-1.5">
                  {(() => {
                    const Icon = getCategoryIconComponent(selectedService.category);
                    return <Icon className="w-3 h-3" style={{ color: selectedService.color }} />;
                  })()}
                  <span
                    className="text-xs"
                    style={{ color: selectedService.color }}
                  >
                    {getCategoryLabel(selectedService.category)}
                  </span>
                </div>
              </div>
              <button
                onClick={handleClearService}
                className="p-1.5 rounded-lg hover:bg-p01-surface/50 transition-colors"
              >
                <X className="w-4 h-4 text-p01-chrome" />
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-p01-chrome/40" />
                <input
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  onFocus={() => name.length >= 2 && setShowSuggestions(true)}
                  onBlur={handleNameBlur}
                  placeholder="Search or enter service name..."
                  className="w-full pl-10 pr-4 py-3 bg-p01-surface border border-p01-border rounded-xl text-white placeholder:text-p01-chrome/40 focus:border-p01-cyan focus:outline-none"
                />
              </div>

              {/* Search Suggestions Dropdown */}
              <AnimatePresence>
                {showSuggestions && searchResults.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="absolute z-10 left-0 right-0 mt-1 bg-p01-elevated border border-p01-border rounded-xl overflow-hidden shadow-lg"
                  >
                    {searchResults.map((service) => {
                      const CategoryIcon = getCategoryIconComponent(service.category);
                      return (
                        <button
                          key={service.id}
                          onClick={() => handleServiceSelect(service)}
                          className="w-full flex items-center gap-3 p-3 hover:bg-p01-surface transition-colors text-left"
                        >
                          <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${service.color}20` }}
                          >
                            {service.logo ? (
                              <img
                                src={service.logo}
                                alt={service.name}
                                className="w-4 h-4"
                                style={{ filter: `drop-shadow(0 0 1px ${service.color})` }}
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            ) : (
                              <CategoryIcon className="w-4 h-4" style={{ color: service.color }} />
                            )}
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-medium text-white">{service.name}</p>
                            <div className="flex items-center gap-1">
                              <CategoryIcon className="w-2.5 h-2.5" style={{ color: service.color }} />
                              <span className="text-[10px]" style={{ color: service.color }}>
                                {getCategoryLabel(service.category)}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </div>

        {/* Recipient Address */}
        <div>
          <label className="text-xs font-medium text-p01-chrome/60 mb-2 block">
            Recipient Wallet Address
          </label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Enter Solana address"
            className={cn(
              'w-full px-4 py-3 bg-p01-surface border rounded-xl text-white placeholder:text-p01-chrome/40 focus:outline-none font-mono text-sm',
              !isValidRecipient
                ? 'border-red-500 focus:border-red-500'
                : 'border-p01-border focus:border-p01-cyan'
            )}
          />
          {!isValidRecipient && (
            <p className="text-xs text-red-500 mt-1">Invalid Solana address</p>
          )}
        </div>

        {/* Amount and Interval */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-p01-chrome/60 mb-2 block">
              Amount (SOL)
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              min="0"
              step="0.001"
              className={cn(
                'w-full px-4 py-3 bg-p01-surface border rounded-xl text-white placeholder:text-p01-chrome/40 focus:outline-none',
                !isValidAmount
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-p01-border focus:border-p01-cyan'
              )}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-p01-chrome/60 mb-2 block">
              Frequency
            </label>
            <div className="relative">
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value as SubscriptionInterval)}
                className="w-full px-4 py-3 bg-p01-surface border border-p01-border rounded-xl text-white appearance-none focus:border-p01-cyan focus:outline-none"
              >
                {INTERVALS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-p01-chrome/60 pointer-events-none" />
            </div>
          </div>
        </div>

        {/* Monthly equivalent */}
        {calculateMonthlyEquivalent() && (
          <p className="text-xs text-p01-chrome/60 -mt-2">
            ~ {calculateMonthlyEquivalent()} SOL/month
          </p>
        )}

        {/* Duration */}
        <div>
          <label className="text-xs font-medium text-p01-chrome/60 mb-2 block">
            Duration (number of payments, 0 = unlimited)
          </label>
          <input
            type="number"
            value={maxPayments}
            onChange={(e) => setMaxPayments(e.target.value)}
            placeholder="12"
            min="0"
            className="w-full px-4 py-3 bg-p01-surface border border-p01-border rounded-xl text-white placeholder:text-p01-chrome/40 focus:border-p01-cyan focus:outline-none"
          />
        </div>

        {/* Privacy Options */}
        <div className="pt-2">
          <button
            onClick={() => setShowPrivacyOptions(!showPrivacyOptions)}
            className="flex items-center justify-between w-full"
          >
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-p01-cyan" />
              <span className="text-sm font-medium text-p01-cyan">Privacy Options</span>
            </div>
            <ChevronDown
              className={cn(
                'w-4 h-4 text-p01-cyan transition-transform',
                showPrivacyOptions && 'rotate-180'
              )}
            />
          </button>

          {showPrivacyOptions && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mt-4 space-y-4"
            >
              {/* Amount Noise */}
              <div className="bg-p01-surface rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Shuffle className="w-4 h-4 text-p01-cyan" />
                    <span className="text-sm font-medium text-white">Amount Noise</span>
                  </div>
                  <span className="text-sm font-mono text-p01-cyan">+/-{amountNoise}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="20"
                  value={amountNoise}
                  onChange={(e) => setAmountNoise(parseInt(e.target.value))}
                  className="w-full accent-p01-cyan"
                />
                <p className="text-xs text-p01-chrome/60 mt-2">
                  Vary payment amounts to prevent pattern detection
                </p>
              </div>

              {/* Timing Noise */}
              <div className="bg-p01-surface rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-streams" />
                    <span className="text-sm font-medium text-white">Timing Noise</span>
                  </div>
                  <span className="text-sm font-mono text-streams">+/-{timingNoise}h</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="24"
                  value={timingNoise}
                  onChange={(e) => setTimingNoise(parseInt(e.target.value))}
                  className="w-full accent-streams"
                />
                <p className="text-xs text-p01-chrome/60 mt-2">
                  Randomize payment times within this window
                </p>
              </div>

              {/* Stealth Address */}
              <div className="bg-p01-surface rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <EyeOff className="w-4 h-4 text-p01-cyan" />
                    <span className="text-sm font-medium text-white">Stealth Addresses</span>
                  </div>
                  <button
                    onClick={() => setUseStealthAddress(!useStealthAddress)}
                    className={cn(
                      'w-12 h-6 rounded-full transition-colors relative',
                      useStealthAddress ? 'bg-p01-cyan' : 'bg-p01-border'
                    )}
                  >
                    <div
                      className={cn(
                        'w-5 h-5 rounded-full bg-white absolute top-0.5 transition-transform',
                        useStealthAddress ? 'translate-x-6' : 'translate-x-0.5'
                      )}
                    />
                  </button>
                </div>
                <p className="text-xs text-p01-chrome/60 mt-2">
                  Each payment sent to a unique derived address (requires recipient support)
                </p>
              </div>
            </motion.div>
          )}
        </div>

        {/* Info Box */}
        <div className="bg-p01-cyan/10 rounded-xl p-4 border border-p01-cyan/30">
          <div className="flex items-start gap-3">
            <Info className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-p01-chrome">
                <span className="text-p01-cyan font-medium">How it works: </span>
                Payments are sent automatically when due. You'll be notified before each payment
                and can pause or cancel anytime.
              </p>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 rounded-xl p-4 border border-red-500/30">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-500">{error}</p>
            </div>
          </div>
        )}
      </div>

      {/* Create Button */}
      <div className="p-4 border-t border-p01-border">
        <button
          onClick={handleCreate}
          disabled={!canSubmit || isCreating}
          className="w-full py-3.5 bg-p01-cyan text-p01-void font-semibold rounded-xl hover:bg-p01-cyan-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Shield className="w-5 h-5" />
              Create Subscription
            </>
          )}
        </button>
      </div>
    </div>
  );
}
