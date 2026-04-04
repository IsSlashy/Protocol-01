import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Shield,
  Loader2,
  EyeOff,
  Lock,
  Shuffle,
  Clock,
  Zap,
  User,
  Building,
  ChevronRight,
  Check,
} from 'lucide-react';
import { cn } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { useWalletStore } from '@/shared/store/wallet';
import { useShieldedStore } from '@/shared/store/shielded';
import { SubscriptionInterval } from '@/shared/services/stream';

// ─── Types ──────────────────────────────────────────────────────────────────

type SubscriptionType = 'p2p' | 'b2b';
type PrivacyMode = 'standard' | 'noise' | 'zk';

const PRIVACY_MODES = [
  {
    id: 'standard' as PrivacyMode,
    name: 'Standard',
    desc: 'Direct payment, visible on-chain',
    icon: Zap,
    color: '#39c5bb',
    features: ['Fast execution', 'Lowest fees'],
  },
  {
    id: 'noise' as PrivacyMode,
    name: 'Noise + Timing',
    desc: 'Randomized amounts & timing',
    icon: Shuffle,
    color: '#ff77a8',
    features: ['±15% amount noise', '±4h timing jitter', 'Pattern-resistant'],
  },
  {
    id: 'zk' as PrivacyMode,
    name: 'ZK Private',
    desc: 'Pay from shielded pool — untraceable',
    icon: Shield,
    color: '#00ffe5',
    features: ['Zero-knowledge proof', 'Fully untraceable', 'Consumes shielded note'],
  },
];

// ─── Pre-configured B2B services ────────────────────────────────────────────

const B2B_SERVICES = [
  { name: 'Protocol 01 Pro', recipient: 'P01pro...wallet', amount: 9.99, interval: 'monthly' as SubscriptionInterval, logo: '/01-miku.png', desc: 'Premium privacy features' },
  { name: 'VPN Service', recipient: 'VPNsrv...wallet', amount: 4.99, interval: 'monthly' as SubscriptionInterval, logo: '🔒', desc: 'Anonymous VPN access' },
  { name: 'Cloud Storage', recipient: 'Cloud...wallet', amount: 2.99, interval: 'monthly' as SubscriptionInterval, logo: '☁️', desc: 'Encrypted storage 100GB' },
];

// ═══════════════════════════════════════════════════════════════════════════

export default function CreateSubscription() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { addSubscription, processPayment } = useSubscriptionsStore();
  const { _keypair, network, isUnlocked } = useWalletStore();
  const { shieldedBalance } = useShieldedStore();

  // Pre-fill from URL params (when coming from dApp approval or service selection)
  const prefillName = searchParams.get('name') || '';
  const prefillRecipient = searchParams.get('recipient') || '';
  const prefillAmount = searchParams.get('amount') || '';

  const [step, setStep] = useState<'type' | 'mode' | 'confirm'>('type');
  const [subType, setSubType] = useState<SubscriptionType>('p2p');
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('noise');
  const [selectedService, setSelectedService] = useState<typeof B2B_SERVICES[0] | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // For P2P, use prefilled data; for B2B, use selected service
  const activeName = subType === 'b2b' && selectedService ? selectedService.name : prefillName;
  const activeRecipient = subType === 'b2b' && selectedService ? selectedService.recipient : prefillRecipient;
  const activeAmount = subType === 'b2b' && selectedService ? selectedService.amount : parseFloat(prefillAmount) || 0;
  const activeInterval: SubscriptionInterval = subType === 'b2b' && selectedService ? selectedService.interval : 'monthly';

  const handleCreate = async () => {
    if (!_keypair || !isUnlocked) return;
    setIsCreating(true);

    try {
      const noiseSettings = privacyMode === 'noise'
        ? { amountNoise: 15, timingNoise: 4 }
        : privacyMode === 'zk'
        ? { useZkPool: true }
        : {};

      const subscription = addSubscription({
        name: activeName,
        recipient: activeRecipient,
        amount: activeAmount,
        interval: activeInterval,
        maxPayments: 0, // unlimited
        ...noiseSettings,
      });

      // Execute first payment
      await processPayment(subscription.id, _keypair, network);

      navigate('/subscriptions', { replace: true });
    } catch (err) {
      console.error('[Subscription] Create error:', err);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => step === 'type' ? navigate(-1) : setStep(step === 'confirm' ? 'mode' : 'type')}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <h1 className="text-white font-display font-bold tracking-wide text-sm">
            {step === 'type' ? 'NEW SUBSCRIPTION' : step === 'mode' ? 'PRIVACY MODE' : 'CONFIRM'}
          </h1>
          <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
            STREAM SECURE
          </p>
        </div>
        <div className="w-9" />
      </header>

      <div className="flex-1 overflow-y-auto p-4">

        {/* ═══ STEP 1: Type Selection ═══ */}
        {step === 'type' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
            <p className="text-p01-chrome text-xs font-mono mb-4 text-center">
              Select subscription type
            </p>

            {/* P2P Personal */}
            <button
              onClick={() => { setSubType('p2p'); setStep('mode'); }}
              className={cn(
                'w-full p-4 rounded-xl border text-left transition-all',
                'bg-p01-surface border-p01-border hover:border-p01-cyan/40',
              )}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-p01-cyan/15 flex items-center justify-center">
                  <User className="w-5 h-5 text-p01-cyan" />
                </div>
                <div className="flex-1">
                  <p className="text-white font-medium text-sm">Personal (P2P)</p>
                  <p className="text-p01-chrome text-[11px] mt-0.5">
                    Pay a friend or personal service recurring
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-p01-chrome/50" />
              </div>
            </button>

            {/* B2B Services */}
            <div>
              <button
                onClick={() => setSubType('b2b')}
                className={cn(
                  'w-full p-4 rounded-xl border text-left transition-all',
                  subType === 'b2b' ? 'bg-p01-pink/5 border-p01-pink/30' : 'bg-p01-surface border-p01-border hover:border-p01-pink/40',
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-p01-pink/15 flex items-center justify-center">
                    <Building className="w-5 h-5 text-p01-pink" />
                  </div>
                  <div className="flex-1">
                    <p className="text-white font-medium text-sm">Services (B2B)</p>
                    <p className="text-p01-chrome text-[11px] mt-0.5">
                      Subscribe to a business or dApp service
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-p01-chrome/50" />
                </div>
              </button>

              {/* Service list */}
              {subType === 'b2b' && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="mt-2 space-y-2 pl-2">
                  {B2B_SERVICES.map((svc) => (
                    <button
                      key={svc.name}
                      onClick={() => { setSelectedService(svc); setStep('mode'); }}
                      className={cn(
                        'w-full p-3 rounded-lg border text-left transition-all flex items-center gap-3',
                        selectedService?.name === svc.name
                          ? 'bg-p01-pink/10 border-p01-pink/30'
                          : 'bg-p01-dark border-p01-border hover:border-p01-pink/20',
                      )}
                    >
                      <span className="text-lg">{typeof svc.logo === 'string' && svc.logo.startsWith('/') ? <img src={svc.logo} className="w-7 h-7 rounded" /> : svc.logo}</span>
                      <div className="flex-1">
                        <p className="text-white text-xs font-medium">{svc.name}</p>
                        <p className="text-p01-chrome text-[10px]">{svc.desc}</p>
                      </div>
                      <span className="text-p01-cyan text-xs font-mono">${svc.amount}/mo</span>
                    </button>
                  ))}
                  <p className="text-p01-chrome/50 text-[10px] font-mono text-center pt-1">
                    More services added via dApp integration
                  </p>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}

        {/* ═══ STEP 2: Privacy Mode ═══ */}
        {step === 'mode' && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-3">
            <p className="text-p01-chrome text-xs font-mono mb-4 text-center">
              How should payments be made?
            </p>

            {PRIVACY_MODES.map((mode) => (
              <button
                key={mode.id}
                onClick={() => setPrivacyMode(mode.id)}
                className={cn(
                  'w-full p-4 rounded-xl border text-left transition-all',
                  privacyMode === mode.id
                    ? 'border-opacity-50'
                    : 'bg-p01-surface border-p01-border hover:border-opacity-30',
                )}
                style={{
                  borderColor: privacyMode === mode.id ? mode.color : undefined,
                  background: privacyMode === mode.id ? `${mode.color}08` : undefined,
                }}
              >
                <div className="flex items-start gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center mt-0.5"
                    style={{ background: `${mode.color}15` }}
                  >
                    <mode.icon className="w-5 h-5" style={{ color: mode.color }} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-white font-medium text-sm">{mode.name}</p>
                      {privacyMode === mode.id && (
                        <Check className="w-3.5 h-3.5" style={{ color: mode.color }} />
                      )}
                    </div>
                    <p className="text-p01-chrome text-[11px] mt-0.5">{mode.desc}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {mode.features.map((f) => (
                        <span
                          key={f}
                          className="text-[9px] font-mono px-1.5 py-0.5 rounded-full"
                          style={{ background: `${mode.color}12`, color: mode.color, border: `1px solid ${mode.color}25` }}
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </button>
            ))}

            {/* ZK balance warning */}
            {privacyMode === 'zk' && (
              <div className="p-3 rounded-lg bg-[#00ffe5]/5 border border-[#00ffe5]/20 flex items-center gap-2">
                <Lock className="w-4 h-4 text-[#00ffe5] shrink-0" />
                <p className="text-[#00ffe5] text-[10px] font-mono">
                  Shielded balance: {shieldedBalance.toFixed(4)} SOL — each payment consumes a shielded note
                </p>
              </div>
            )}

            <button
              onClick={() => setStep('confirm')}
              className="w-full mt-4 py-3 rounded-xl bg-p01-cyan text-p01-void font-bold font-display text-sm tracking-wider hover:bg-p01-cyan/90 transition-colors"
            >
              Continue
            </button>
          </motion.div>
        )}

        {/* ═══ STEP 3: Confirm ═══ */}
        {step === 'confirm' && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
            {/* Summary card */}
            <div className="p-4 rounded-xl bg-gradient-to-br from-p01-surface to-p01-dark border border-p01-cyan/20">
              <p className="text-p01-chrome text-[10px] font-mono tracking-wider mb-3">SUBSCRIPTION SUMMARY</p>

              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-p01-chrome text-xs">Type</span>
                  <span className="text-white text-xs font-mono">{subType === 'p2p' ? 'Personal P2P' : 'B2B Service'}</span>
                </div>
                {activeName && (
                  <div className="flex justify-between">
                    <span className="text-p01-chrome text-xs">Name</span>
                    <span className="text-white text-xs font-mono">{activeName}</span>
                  </div>
                )}
                {activeAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-p01-chrome text-xs">Amount</span>
                    <span className="text-p01-cyan text-xs font-mono font-bold">{activeAmount} SOL / {activeInterval}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-p01-chrome text-xs">Privacy</span>
                  <span className="text-xs font-mono" style={{ color: PRIVACY_MODES.find(m => m.id === privacyMode)?.color }}>
                    {PRIVACY_MODES.find(m => m.id === privacyMode)?.name}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-p01-chrome text-xs">Duration</span>
                  <span className="text-white text-xs font-mono">Unlimited</span>
                </div>
              </div>
            </div>

            {/* Privacy badge */}
            <div className="p-3 rounded-lg bg-p01-dark border border-p01-border flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-p01-cyan shrink-0" />
              <p className="text-p01-chrome text-[10px] font-mono">
                {privacyMode === 'standard'
                  ? 'Payments visible on-chain. Fast and minimal fees.'
                  : privacyMode === 'noise'
                  ? 'Amounts ±15%, timing ±4h. Pattern analysis resistant.'
                  : 'Fully untraceable. Each payment from shielded pool with ZK proof.'}
              </p>
            </div>

            {/* Actions */}
            <button
              onClick={handleCreate}
              disabled={isCreating || !isUnlocked}
              className={cn(
                'w-full py-3 rounded-xl font-bold font-display text-sm tracking-wider transition-colors flex items-center justify-center gap-2',
                isCreating
                  ? 'bg-p01-cyan/30 text-p01-void cursor-wait'
                  : 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90',
              )}
            >
              {isCreating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4" />
                  Start Subscription
                </>
              )}
            </button>

            <p className="text-p01-chrome/40 text-[9px] font-mono text-center">
              First payment sent immediately. Cancel anytime.
            </p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
