import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Shield,
  AlertCircle,
  Loader2,
  ChevronDown,
  Zap,
} from 'lucide-react';
import { cn } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { useWalletStore } from '@/shared/store/wallet';
import { validateRecipient, SubscriptionInterval } from '@/shared/services/stream';

const INTERVALS: { value: SubscriptionInterval; label: string; days: number }[] = [
  { value: 'daily', label: 'Daily', days: 1 },
  { value: 'weekly', label: 'Weekly', days: 7 },
  { value: 'monthly', label: 'Monthly', days: 30 },
  { value: 'yearly', label: 'Yearly', days: 365 },
];

export default function CreateSubscription() {
  const navigate = useNavigate();
  const { addSubscription, processPayment } = useSubscriptionsStore();
  const { _keypair, network, isUnlocked } = useWalletStore();

  // Form state
  const [name, setName] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [interval, setInterval] = useState<SubscriptionInterval>('monthly');
  const [maxPayments, setMaxPayments] = useState('12');


  // UI state
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validation
  const isValidRecipient = recipient.length === 0 || validateRecipient(recipient);
  const isValidAmount = amount.length === 0 || (parseFloat(amount) > 0 && !isNaN(parseFloat(amount)));
  const canSubmit = name.trim() && recipient && isValidRecipient && amount && isValidAmount && isUnlocked && _keypair;

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

  const handleCreate = async () => {
    if (!canSubmit || !_keypair) return;

    setIsCreating(true);
    setError(null);

    try {
      // Create subscription
      const subscription = addSubscription({
        name: name.trim(),
        recipient,
        amount: parseFloat(amount),
        interval,
        maxPayments: parseInt(maxPayments) || 0,
      });

      // Execute first payment immediately
      await processPayment(subscription.id, _keypair, network);

      navigate(`/subscriptions/${subscription.id}`);
    } catch (err) {
      console.error('[CreateSub] Error:', err);
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
        {/* Name Input */}
        <div>
          <label className="text-xs font-medium text-p01-chrome/60 mb-2 block">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter subscription name"
            className="w-full px-4 py-3 bg-p01-surface border border-p01-border rounded-xl text-white placeholder:text-p01-chrome/40 focus:border-p01-cyan focus:outline-none"
          />
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

        {/* Info Box */}
        <div className="bg-p01-cyan/10 rounded-xl p-4 border border-p01-cyan/30">
          <div className="flex items-start gap-3">
            <Zap className="w-4 h-4 text-p01-cyan flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs text-p01-chrome">
                <span className="text-p01-cyan font-medium">Instant start: </span>
                First payment is sent immediately. Next payments are automatic.
              </p>
            </div>
          </div>
        </div>

        {/* Privacy Info */}
        <div className="bg-p01-surface rounded-xl p-4 border border-p01-border">
          <div className="flex items-start gap-3">
            <Shield className="w-4 h-4 text-p01-chrome/60 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-p01-chrome/60">
              Privacy built-in: amounts and timing are randomized.
            </p>
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
              Sending first payment...
            </>
          ) : (
            <>
              <Zap className="w-5 h-5" />
              Start & Pay Now
            </>
          )}
        </button>
        {!isUnlocked && (
          <p className="text-center text-xs text-red-400 mt-2">
            Unlock your wallet to create subscriptions
          </p>
        )}
      </div>
    </div>
  );
}
