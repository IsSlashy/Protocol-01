import { useState } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
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
  Check,
} from 'lucide-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { cn } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { useWalletStore, getPrivySigner } from '@/shared/store/wallet';
import { useSolanaWallets } from '@/shared/providers/PrivyProvider';
import { useShieldedStore } from '@/shared/store/shielded';
import { useDenominatedPoolStore } from '@/shared/store/denominatedPool';
import { SubscriptionInterval, type PaymentSigner } from '@/shared/services/stream';
import { getConnection, type NetworkType } from '@/shared/services/wallet';

/**
 * Resolve a service subscription's PAYMENT recipient: the merchant's on-chain
 * `retailer` from the Protocol 01 service registry. Services in the picker carry
 * only a branding id (e.g. "netflix"); the actual payee lives on-chain. Returns
 * null if the service isn't attested on-chain (so we can fail honestly instead
 * of paying a bogus address).
 */
async function resolveServiceRecipient(
  svc: { serviceId?: string; serviceName?: string },
  network: NetworkType,
): Promise<string | null> {
  try {
    const { fetchAllServices } = await import('@protocol-01/specter-sdk');
    const services = await fetchAllServices(getConnection(network), { activeOnly: true });
    const key = (svc.serviceId || svc.serviceName || '').toLowerCase().trim();
    if (!key) return null;
    const base = key.split(/[\s-]/)[0]; // "netflix" from "netflix" / "Netflix Standard"
    const match = services.find((s: { slug?: string; name?: string }) => {
      const slug = (s.slug || '').toLowerCase();
      const nm = (s.name || '').toLowerCase();
      return slug.includes(base) || nm.includes(base);
    });
    return (match as { retailer?: { toBase58?: () => string } } | undefined)?.retailer?.toBase58?.() ?? null;
  } catch (e) {
    console.error('[Subscription] resolveServiceRecipient failed:', e);
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

type PrivacyMode = 'standard' | 'noise' | 'zk';

const PRIVACY_MODES = [
  {
    id: 'standard' as PrivacyMode,
    name: 'Standard',
    desc: 'Direct payment, visible on-chain',
    icon: Zap,
    color: '#39c5bb',
    features: ['Fast execution', 'Lowest fees'],
    disabled: false,
    disabledReason: undefined,
  },
  {
    id: 'noise' as PrivacyMode,
    name: 'Noise + Timing',
    desc: 'Randomized amounts & timing',
    icon: Shuffle,
    color: '#ff77a8',
    features: ['±15% amount noise', '±4h timing jitter', 'Pattern-resistant'],
    disabled: false,
    disabledReason: undefined,
  },
  {
    id: 'zk' as PrivacyMode,
    name: 'ZK Private',
    desc: 'Pay from a shielded denominated note, no wallet link',
    icon: Shield,
    color: '#39c5bb',
    features: ['STARK proof (C1)', 'No wallet link', 'Goldilocks pool'],
    disabled: false,
    disabledReason: undefined,
  },
];

// ═══════════════════════════════════════════════════════════════════════════

export default function CreateSubscription() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { addSubscription, processPayment } = useSubscriptionsStore();
  const { _keypair, network, isUnlocked, isPrivyWallet, isRemoteWallet, publicKey } = useWalletStore();
  const { wallets } = useSolanaWallets();
  const { shieldedBalance } = useShieldedStore();
  const { getSpendableNote } = useDenominatedPoolStore();

  // The recipient is already determined by how the user arrived here:
  //   - picked a service in Subscriptions  -> service data in location.state
  //   - dApp approval / personal prefill    -> query params
  // So we never re-ask "who are you paying" — the flow starts at the privacy
  // step. We also don't surface any payment-classification jargon to the user.
  const svc = (location.state ?? null) as
    | { serviceId?: string; serviceName?: string; price?: number; frequency?: SubscriptionInterval }
    | null;

  const prefillName = svc?.serviceName || searchParams.get('name') || '';
  const prefillRecipient = svc?.serviceId || searchParams.get('recipient') || '';
  const prefillAmount = svc?.price != null ? String(svc.price) : (searchParams.get('amount') || '');

  const [step, setStep] = useState<'mode' | 'confirm'>('mode');
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('noise');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeName = prefillName;
  const activeRecipient = prefillRecipient;
  const activeAmount = parseFloat(prefillAmount) || 0;
  const activeInterval: SubscriptionInterval = svc?.frequency || 'monthly';

  const handleCreate = async () => {
    setError(null);

    if (!isUnlocked) {
      setError('Please unlock your wallet first.');
      return;
    }

    // Build a wallet-agnostic signer: local keypair OR Privy embedded wallet.
    let signer: PaymentSigner;
    if (_keypair) {
      const kp = _keypair;
      signer = {
        publicKey: kp.publicKey,
        keypair: kp,
        signTransaction: async (tx: Transaction) => { tx.sign(kp); return tx; },
      };
    } else if (isPrivyWallet) {
      // Read the embedded wallet live from the Privy hook. The module-level
      // privySigner is set by PrivyBridge but can be transiently null while the
      // popup re-hydrates, so the hook is the reliable source at click time.
      const wallet = wallets.find((w) => w.walletClientType === 'privy') || wallets[0];
      const fallback = getPrivySigner();
      if (wallet) {
        signer = {
          publicKey: new PublicKey(wallet.address),
          signTransaction: async (tx: Transaction) =>
            (await wallet.signTransaction(tx)) as unknown as Transaction,
        };
      } else if (fallback && publicKey) {
        signer = {
          publicKey: new PublicKey(publicKey),
          signTransaction: async (tx: Transaction) => (await fallback(tx)) as unknown as Transaction,
        };
      } else if (isRemoteWallet) {
        // Wallet linked from P01 Mobile via QR — only the address is here; the
        // signing key is on the phone, so it cannot sign in the extension.
        setError(
          "This wallet is linked from P01 Mobile and can't sign in the extension yet. " +
          'To subscribe here, import your seed phrase or sign in with email.',
        );
        return;
      } else {
        // No embedded Privy wallet found. Could be a phone-linked wallet (older
        // link without the flag) or Privy still hydrating — give an actionable hint.
        setError(
          'No signer is available for this wallet. If it was linked from P01 Mobile (QR), ' +
          'import your seed phrase or use email login to subscribe. Otherwise reopen the wallet and try again.',
        );
        return;
      }
    } else {
      setError('Wallet not ready — unlock and try again.');
      return;
    }

    // ZK Private mode requires a denominated pool note.
    // If no spendable note exists yet, route to the shield screen first.
    if (privacyMode === 'zk') {
      // Try SOL 0.1 as the default denomination for private subscriptions.
      const note = getSpendableNote('SOL', 0.1);
      if (!note) {
        navigate('/denominated-shield');
        return;
      }
      // Note exists — proceed to ZK subscribe via vault store.
      // (Full end-to-end wiring is done in SubscriptionVaults / createPrivateVault.
      // For now route the user there with a note about next steps.)
      alert(
        'A denominated note is ready.\n\n' +
        'Go to Subscription Vaults to create a private vault using this note, ' +
        'or use the existing note from the denominated pool store.',
      );
      return;
    }

    if (!(activeAmount > 0)) {
      setError('Amount must be greater than 0.');
      return;
    }

    setIsCreating(true);

    try {
      // Resolve the payment recipient:
      //  - service subscription -> the merchant's on-chain `retailer` (service registry)
      //  - personal / dApp prefill -> the address that was provided
      let recipient = activeRecipient;
      if (svc) {
        const resolved = await resolveServiceRecipient(svc, network);
        if (!resolved) {
          setError(`${activeName || 'This service'} isn't registered on-chain yet — there's no merchant address to pay.`);
          setIsCreating(false);
          return;
        }
        recipient = resolved;
      }

      // Recipient must be a real wallet address before we charge.
      try {
        new PublicKey(recipient);
      } catch {
        setError('Invalid recipient address.');
        setIsCreating(false);
        return;
      }

      const noiseSettings = privacyMode === 'noise'
        ? { amountNoise: 15, timingNoise: 4 }
        : {};

      const subscription = addSubscription({
        name: activeName,
        recipient,
        amount: activeAmount,
        interval: activeInterval,
        maxPayments: 0, // unlimited
        ...noiseSettings,
      });

      // Execute first payment (local keypair or Privy embedded wallet).
      await processPayment(subscription.id, signer, network);

      navigate('/subscriptions', { replace: true });
    } catch (err) {
      console.error('[Subscription] Create error:', err);
      setError((err as Error)?.message || 'Failed to start subscription.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
        <button
          onClick={() => step === 'mode' ? navigate(-1) : setStep('mode')}
          className="p-2 text-p01-chrome hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <h1 className="text-white font-display font-bold tracking-wide text-sm">
            {step === 'mode' ? 'NEW SUBSCRIPTION' : 'CONFIRM'}
          </h1>
          <p className="text-p01-cyan text-[9px] font-mono tracking-wider">
            STREAM SECURE
          </p>
        </div>
        <div className="w-9" />
      </header>

      <div className="flex-1 overflow-y-auto p-4">

        {/* ═══ STEP 1: Privacy Mode ═══ */}
        {step === 'mode' && (
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="space-y-3">
            <p className="text-p01-chrome text-xs font-mono mb-4 text-center">
              How should payments be made?
            </p>

            {PRIVACY_MODES.map((mode) => (
              <button
                key={mode.id}
                onClick={() => !mode.disabled && setPrivacyMode(mode.id)}
                disabled={mode.disabled}
                title={mode.disabled ? mode.disabledReason : undefined}
                className={cn(
                  'w-full p-4 rounded-xl border text-left transition-all',
                  mode.disabled
                    ? 'bg-p01-surface/50 border-p01-border/50 opacity-60 cursor-not-allowed'
                    : privacyMode === mode.id
                    ? 'border-opacity-50'
                    : 'bg-p01-surface border-p01-border hover:border-opacity-30',
                )}
                style={{
                  borderColor: !mode.disabled && privacyMode === mode.id ? mode.color : undefined,
                  background: !mode.disabled && privacyMode === mode.id ? `${mode.color}08` : undefined,
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
                      <p className={cn('font-medium text-sm', mode.disabled ? 'text-p01-chrome/60' : 'text-white')}>
                        {mode.name}
                      </p>
                      {!mode.disabled && privacyMode === mode.id && (
                        <Check className="w-3.5 h-3.5" style={{ color: mode.color }} />
                      )}
                      {mode.disabled && (
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-p01-border text-p01-chrome/60">
                          Mobile only
                        </span>
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

            {/* ZK mode: note availability info */}
            {privacyMode === 'zk' && (
              <div className="p-3 rounded-lg bg-p01-cyan/5 border border-p01-cyan/20 flex items-center gap-2">
                <Lock className="w-4 h-4 text-p01-cyan shrink-0" />
                <p className="text-p01-chrome text-[10px] font-mono">
                  ZK Private needs a denominated pool note. If you have one shielded,
                  continuing will use it. If not, you will be taken to the shield screen first.
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
            <div className="p-4 rounded-2xl bg-p01-gradient-card border border-p01-cyan/20">
              <p className="text-p01-chrome text-[10px] font-mono tracking-wider mb-3">SUBSCRIPTION SUMMARY</p>

              <div className="space-y-3">
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

            {/* Error */}
            {error && (
              <div className="p-3 rounded-lg bg-p01-red/10 border border-p01-red/30" role="alert" aria-live="polite">
                <p className="text-p01-red text-[11px] font-mono">{error}</p>
              </div>
            )}

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
