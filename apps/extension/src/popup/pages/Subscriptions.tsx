import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  Bot,
  Briefcase,
  CheckCircle,
  ChevronRight,
  Clock,
  Cloud,
  Compass,
  CreditCard,
  Dumbbell,
  EyeOff,
  Gamepad2,
  GraduationCap,
  Grid,
  Info,
  Loader2,
  MessageCircle,
  Music,
  Newspaper,
  Palette,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Shield,
  ShieldCheck,
  Shuffle,
  Target,
  User,
  Wallet,
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
import { fetchAllServices, type OnchainServiceEntry } from '@/shared/services/onchainServiceRegistry';
import { formatRelativeTime } from '@/shared/utils';
import {
  Amount,
  Button,
  Eyebrow,
  EmptyState,
  Hairline,
  Panel,
  Pill,
  Screen,
} from '@/popup/ui';

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

// Subscribe tiles come from the ON-CHAIN service registry (p01_registry, devnet)
// — the SAME source the mobile app reads — so both apps show identical merchants,
// real prices, and the retailer needed to subscribe. (Previously a hardcoded list
// with invented prices, which diverged from the phone: Disney+ showed 0.1 here but
// 0.06 on-chain.) Fetched at runtime into component state; see the effect below.
type DisplayService = {
  id: string;
  name: string;
  logo?: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  price: number; // SOL
  frequency: 'monthly';
  category: string;
  retailer?: string;
  serviceId?: string;
};

const CATEGORY_ICON: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  streaming: Play,
  music: Music,
  ai: Bot,
  'ai services': Bot,
  saas: Cloud,
  cloud: Cloud,
  gaming: Gamepad2,
  news: Newspaper,
  fitness: Dumbbell,
};
function iconForCategory(cat: string): React.ComponentType<{ className?: string; style?: React.CSSProperties }> {
  return CATEGORY_ICON[(cat || '').toLowerCase()] ?? CreditCard;
}
function mapOnchainService(e: OnchainServiceEntry): DisplayService {
  return {
    id: e.slug,
    name: e.name,
    icon: iconForCategory(e.category),
    price: e.priceAtomic / 1e9,
    frequency: 'monthly',
    category: e.category || 'Service',
    retailer: e.retailer,
    serviceId: e.slug,
  };
}


export default function Subscriptions() {
  const navigate = useNavigate();
  const [showPrivacyInfo, setShowPrivacyInfo] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [services, setServices] = useState<DisplayService[]>([]);

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

  // Auto-sync from chain once a wallet is connected, so subscriptions made on
  // ANOTHER device with the SAME wallet (e.g. on the phone) surface without the
  // user having to hit the Sync button. Runs once per mount; the connected
  // wallet's on-chain P01_SUB_V1 memos are the source.
  const autoSyncedRef = useRef(false);
  useEffect(() => {
    if (!publicKey || autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    (async () => {
      setIsSyncing(true);
      try {
        await syncFromChain(publicKey, network);
      } catch (error) {
        console.error('[Streams] auto-sync failed:', error);
      } finally {
        setIsSyncing(false);
      }
    })();
  }, [publicKey, network, syncFromChain]);

  // Load the merchant catalog from the ON-CHAIN registry (same source as mobile)
  // so prices/merchants match across devices. Devnet-only; [] elsewhere.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entries = await fetchAllServices(network, { activeOnly: true });
        if (!cancelled) setServices(entries.map(mapOnchainService));
      } catch (error) {
        console.error('[Subscriptions] fetchAllServices failed:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [network]);

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
    services.some(svc => s.name.toLowerCase().includes(svc.name.toLowerCase()))
  );
  const personalStreams = sortedSubs.filter(s =>
    !services.some(svc => s.name.toLowerCase().includes(svc.name.toLowerCase()))
  );

  // Graded score for how many privacy FEATURES a subscription has switched on,
  // averaged over active ones. It counts features; it does not measure how much
  // an observer can learn, and 100 does not mean anonymous — a ZK-shielded
  // subscription is still set up by a transaction the user's wallet signs, with
  // the merchant named in it (subscriptionVault.ts:806-807, 1023). Labelled
  // "Privacy Features" in the UI for that reason, never "Privacy Score".
  //  - Standard (classic, fully visible on-chain): 0
  //  - amount noise / timing noise: 25 each
  //  - stealth address: +50
  //  - ZK shielded pool: 100
  const subPrivacyScore = (s: typeof subscriptions[number]): number => {
    if (s.useZkPool) return 100;
    let v = 0;
    if (s.useStealthAddress) v += 50;
    if (s.amountNoise > 0) v += 25;
    if (s.timingNoise > 0) v += 25;
    return Math.min(v, 100);
  };
  const activeSubs = subscriptions.filter(s => s.status === 'active');
  const activeCount = activeSubs.length;
  const privacyScore = activeCount > 0
    ? Math.round(activeSubs.reduce((sum, s) => sum + subPrivacyScore(s), 0) / activeCount)
    : 0;

  // Next payment
  const activeStreams = subscriptions.filter(s => s.status === 'active');
  const nextDue = activeStreams.length > 0
    ? Math.min(...activeStreams.map(s => s.nextPayment))
    : null;

  const handleSubscribeService = (service: DisplayService) => {
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


  return (
    /**
     * 🎯 REBUILT 2026-08-23. This tab was 491 lines of render behind a
     * Personal / Services segmented control that opened on Personal, i.e. on
     * the half being parked. It then showed a merchant catalog, a privacy
     * score, a sync banner and two separate stream lists, and a merchant you
     * had already subscribed to rendered `disabled`, so the only way to open
     * that subscription was to scroll past the whole catalog to a second list.
     *
     * It is one question now: what am I paying for. The catalog moved to the
     * Discover tab, which is the screen built to sell it; keeping a second
     * copy here is what forced the mode switch in the first place.
     *
     * ⛔ The "Create Payment Stream" button is gone with the personal section.
     * Subscriptions start from a merchant, and a merchant is on Discover.
     */
    <Screen
      title="Subscriptions"
      action={
        <button
          onClick={handleSync}
          disabled={isSyncing}
          aria-label="Sync subscriptions from chain"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-p01-text-muted transition-colors duration-exit hover:text-p01-text disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
        >
          <RefreshCw className={isSyncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
        </button>
      }
    >
      <div className="flex flex-col gap-5">
        {activeSubscriptions.length > 0 && (
          <div className="flex items-start justify-between">
            <div>
              <Eyebrow>Monthly</Eyebrow>
              <div className="mt-1.5">
                <Amount value={stats.monthlyCost.toFixed(3)} unit="SOL" size="lg" />
              </div>
            </div>
            <div className="text-right">
              <Eyebrow>Next payment</Eyebrow>
              <p className="mt-1.5 text-sm text-p01-text tabular">
                {stats.nextDue ? formatRelativeTime(stats.nextDue) : "None due"}
              </p>
            </div>
          </div>
        )}

        {activeSubscriptions.length === 0 ? (
          /* An empty state that names the next step. The old one said "No
             subscriptions yet" and stopped, on a tab whose only other control
             was a mode switch. */
          <EmptyState
            icon={RefreshCw}
            title="No subscriptions yet"
            body="Subscribe to a merchant and they are paid on a schedule, without ever receiving your name, your email or a card number."
            action={
              <Button icon={Compass} onClick={() => navigate("/discover")}>
                Browse merchants
              </Button>
            }
          />
        ) : (
          <div>
            <Eyebrow>Active</Eyebrow>
            <div className="mt-1.5">
              {sortedSubs.map((sub, i) => (
                <div key={sub.id}>
                  {i > 0 && <Hairline className="bg-p01-border-soft" />}
                  <button
                    onClick={() => navigate(`/subscriptions/${sub.id}`)}
                    className="flex min-h-[44px] w-full items-center gap-3 py-3 text-left transition-colors duration-exit hover:bg-p01-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-p01-border bg-p01-surface font-display text-base">
                      {(sub.name || "?").slice(0, 1).toUpperCase()}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-p01-text">{sub.name}</span>
                        {sub.status === "paused" && <Pill tone="warn">Paused</Pill>}
                        {sub.useZkPool && <Pill tone="good">Private</Pill>}
                      </span>
                      <span className="mt-0.5 block truncate text-tiny text-p01-text-dim">
                        {sub.status === "active"
                          ? `Next ${formatRelativeTime(sub.nextPayment)}`
                          : "Not collecting"}
                      </span>
                    </span>

                    <span className="shrink-0 text-right">
                      <span className="block text-sm text-p01-text tabular">
                        {sub.amount} {sub.tokenSymbol}
                      </span>
                      <span className="block text-tiny text-p01-text-dim">
                        {formatInterval(sub.interval)}
                      </span>
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeSubscriptions.length > 0 && (
          <Button variant="secondary" full icon={Compass} onClick={() => navigate("/discover")}>
            Browse merchants
          </Button>
        )}

        {/* ⚠️ The one thing this tab must keep saying. It is the founder's
            standing decision, and it is the fact a subscriber is most likely
            to be surprised by. It is not hidden behind a disclosure. */}
        <Panel tone="warn">
          <p className="text-tiny text-p01-text">
            There is no cancellation and no refund. Only the merchant collecting its periods can
            close a vault, and the final collection sweeps whatever is left in it.
          </p>
        </Panel>
      </div>
    </Screen>
  );
}
