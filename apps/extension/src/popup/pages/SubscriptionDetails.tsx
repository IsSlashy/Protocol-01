/**
 * One subscription: what it costs, what it has cost, and the key that proves
 * it is yours.
 *
 * 🚨 THE ENTITLEMENT WAS WRITTEN AND NEVER READ
 * ─────────────────────────────────────────────
 * `CreateSubscription` mints a license key, persists it through
 * `useLicenseStore.saveLicense`, and shows it once at the moment of purchase.
 * `getLicense` was called from nowhere in the extension. So the one artefact a
 * subscriber actually needs — the string a merchant checks against the
 * on-chain `license_commitment`, with no account and no email behind it — was
 * a thing you had to copy in the ninety seconds it was on screen or lose.
 *
 * It is stored, keyed by `${retailer}:${mode}`, and this screen is where a
 * subscription is looked at afterwards. So it is read here, in full, with a
 * copy button.
 *
 * 🎯 WHAT ELSE CHANGED. Six panels became four. "Privacy Active" and "ZK
 * Shielded Payment" were two separate cards saying overlapping things about
 * the same subscription in two different accent colours (one of them the
 * retired pink); the noise preview repeated the amount that is already the
 * headline. Statistics that read "Unlimited / No limit" for every merchant
 * subscription ever created are not statistics.
 */

import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  KeyRound,
  Pause,
  Play,
} from 'lucide-react';
import { cn, truncateAddress } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { useWalletStore } from '@/shared/store/wallet';
import { useLicenseStore } from '@/shared/store/license';
import { formatInterval, PaymentRecord } from '@/shared/services/stream';
import { getSolscanUrl } from '@/shared/services/transactions';
import {
  detectServiceFromName,
  detectServiceFromOrigin,
  type ServiceInfo,
} from '@/shared/services/serviceRegistry';
import { Amount, Button, EmptyState, Eyebrow, Hairline, Panel, Pill, Screen } from '@/popup/ui';

export default function SubscriptionDetails() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [showPaymentHistory, setShowPaymentHistory] = useState(false);
  const [copied, setCopied] = useState(false);

  const {
    getSubscription,
    pauseSubscription,
    resumeSubscription,
    error,
    clearError,
  } = useSubscriptionsStore();

  const { getLicense } = useLicenseStore();

  const subscription = id ? getSubscription(id) : undefined;

  // Detect service info from the registry: origin first (most reliable), then
  // the name. Used for the display name only — never for the payee.
  const detectedService = useMemo((): ServiceInfo | null => {
    if (!subscription) return null;
    if (subscription.origin) {
      const fromOrigin = detectServiceFromOrigin(subscription.origin);
      if (fromOrigin) return fromOrigin;
    }
    return detectServiceFromName(subscription.name);
  }, [subscription]);

  // Clear error on unmount
  useEffect(() => {
    return () => clearError();
  }, [clearError]);

  if (!subscription) {
    return (
      <Screen title="Subscription" onBack={() => navigate('/subscriptions')}>
        <EmptyState
          title="Not found"
          body="This subscription is no longer on this device."
          action={
            <Button variant="secondary" onClick={() => navigate('/subscriptions')}>
              Back to subscriptions
            </Button>
          }
        />
      </Screen>
    );
  }

  const serviceName = detectedService?.name || subscription.name;

  /**
   * The license key for this subscription. Stored keyed by
   * `${retailer}:${mode}`, so the lookup is by recipient — a private
   * subscription mints a `zk` key, a classic one a `standard` key, and
   * whichever exists is the one this subscription can present.
   */
  const license =
    getLicense(subscription.recipient, 'zk') ??
    getLicense(subscription.recipient, 'standard');

  const daysUntilNext = Math.ceil(
    (subscription.nextPayment - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const remainingPayments = subscription.maxPayments > 0
    ? subscription.maxPayments - subscription.paymentsMade
    : Infinity;

  const handlePauseResume = () => {
    if (subscription.status === 'active') {
      pauseSubscription(subscription.id);
    } else if (subscription.status === 'paused') {
      resumeSubscription(subscription.id);
    }
  };

  const paused = subscription.status === 'paused';
  const cancelled = subscription.status === 'cancelled';

  return (
    <Screen
      title={serviceName}
      onBack={() => navigate(-1)}
      footer={
        cancelled ? undefined : (
          <>
            {/*
              The no-refund rule, stated where "Cancel & Revoke" used to be.
              A subscription is a one-way prepaid envelope: money that has left
              your wallet can only ever reach the merchant, and the protocol has
              no instruction that could send any of it back. Pause and resume are
              the whole set of controls.
            */}
            <p className="mb-2.5 text-tiny text-p01-text-dim">
              Pausing freezes the clock and cuts access; your prepaid days are not lost. Money
              already sent can only ever reach the merchant — Protocol 01 cannot return it.
            </p>
            <Button full size="lg" variant="secondary" icon={paused ? Play : Pause} onClick={handlePauseResume}>
              {paused ? 'Resume' : 'Pause'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {/* ── The headline: price, and whether it is running. ── */}
        <div>
          <Eyebrow>{subscription.useZkPool ? 'Shielded subscription' : 'Subscription'}</Eyebrow>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <Amount
              value={subscription.amount.toFixed(subscription.amount < 1 ? 4 : 2)}
              unit={subscription.tokenSymbol}
              size="xl"
            />
            <span className="text-sm text-p01-text-muted">
              / {formatInterval(subscription.interval).toLowerCase()}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            {cancelled ? (
              <Pill tone="bad">Cancelled</Pill>
            ) : paused ? (
              <Pill tone="warn">Paused</Pill>
            ) : (
              <Pill tone="good">Active</Pill>
            )}
            {!cancelled && !paused && (
              <span className="text-tiny text-p01-text-dim">
                {daysUntilNext <= 0
                  ? 'Next payment is due now'
                  : `Next payment in ${daysUntilNext} day${daysUntilNext !== 1 ? 's' : ''}`}
              </span>
            )}
          </div>
        </div>

        {/* ── The key. Written at purchase, read here, nowhere else. ── */}
        {license && (
          <Panel>
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-p01-cyan" aria-hidden="true" />
              <Eyebrow>License key</Eyebrow>
            </div>
            <p className="mt-2 break-all rounded-lg border border-p01-border bg-p01-void px-3 py-2.5 font-mono text-tiny leading-relaxed text-p01-text">
              {license.licenseKey}
            </p>
            <Button
              variant="secondary"
              full
              className="mt-2.5"
              icon={copied ? Check : Copy}
              onClick={() => {
                void navigator.clipboard?.writeText(license.licenseKey);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy license key'}
            </Button>
            <p className="mt-2 text-tiny text-p01-text-dim">
              Give this to {serviceName} to unlock access. They check it against the
              commitment your subscription posted on chain, so it works without an account,
              an email or your wallet address.
            </p>
          </Panel>
        )}

        {/* ── What it has cost so far. ── */}
        <div>
          <Eyebrow>So far</Eyebrow>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-sm text-p01-text-muted">Paid</span>
            <span className="text-sm text-p01-text tabular">
              {subscription.totalPaid.toFixed(subscription.totalPaid < 1 ? 4 : 2)}{' '}
              {subscription.tokenSymbol} over {subscription.paymentsMade} payment
              {subscription.paymentsMade !== 1 ? 's' : ''}
            </span>
          </div>
          {remainingPayments !== Infinity && (
            <div className="mt-1.5 flex items-center justify-between">
              <span className="text-sm text-p01-text-muted">Left</span>
              <span className="text-sm text-p01-text tabular">
                {remainingPayments} payment{remainingPayments !== 1 ? 's' : ''}
              </span>
            </div>
          )}
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-sm text-p01-text-muted">Paid to</span>
            <span className="font-mono text-sm text-p01-text">
              {truncateAddress(subscription.recipient, 4)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-sm text-p01-text-muted">Started</span>
            <span className="text-sm text-p01-text tabular">
              {new Date(subscription.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>

        {/* ⚠️ A failed payment is the one thing on this screen the user has to
            act on, so it announces itself rather than sitting in a card. */}
        {error && (
          <p role="alert" className="text-tiny text-p01-red">
            The last payment failed. {error}
          </p>
        )}

        {/* ── History, folded away until asked for. ── */}
        <div>
          <button
            onClick={() => setShowPaymentHistory(!showPaymentHistory)}
            aria-expanded={showPaymentHistory}
            className="flex min-h-[44px] w-full items-center justify-between rounded-lg text-left transition-colors duration-exit hover:bg-p01-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
          >
            <span className="text-sm text-p01-text">Payment history</span>
            <ChevronDown
              className={cn(
                'h-4 w-4 text-p01-text-dim transition-transform duration-exit',
                showPaymentHistory && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>

          {showPaymentHistory && (
            subscription.payments.length === 0 ? (
              <p className="py-2 text-tiny text-p01-text-dim">No payments yet.</p>
            ) : (
              <div className="flex flex-col">
                {subscription.payments.slice().reverse().map((payment, i) => (
                  <div key={payment.id}>
                    {i > 0 && <Hairline className="bg-p01-border-soft" />}
                    <PaymentHistoryItem payment={payment} symbol={subscription.tokenSymbol} />
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </Screen>
  );
}

function PaymentHistoryItem({ payment, symbol }: { payment: PaymentRecord; symbol: string }) {
  const { network } = useWalletStore();

  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-p01-text tabular">
          {payment.amount.toFixed(4)} {symbol}
        </p>
        <p className="text-tiny text-p01-text-dim">
          {new Date(payment.timestamp).toLocaleString()}
        </p>
      </div>
      {payment.status === 'confirmed' ? (
        <a
          href={getSolscanUrl('tx', payment.signature, network)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-[44px] items-center gap-1 text-tiny text-p01-text-muted transition-colors duration-exit hover:text-p01-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-p01-cyan"
        >
          View
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      ) : (
        <Pill tone={payment.status === 'failed' ? 'bad' : 'warn'}>
          {payment.status === 'failed' ? 'Failed' : 'Pending'}
        </Pill>
      )}
    </div>
  );
}
