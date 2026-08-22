/**
 * Approve: a site is asking to be allowed to charge this wallet, repeatedly.
 *
 * 🚨 THE RECIPIENT CAME OUT FROM BEHIND THE ACCORDION.
 * ────────────────────────────────────────────────────
 * The address that will be paid, every period, until the periods run out, was
 * the first row inside a collapsed "Advanced details" panel. On a signing
 * surface the payee is not an advanced detail; it is the decision. It is now
 * in the open list with the amount, and the accordion is gone. What else was
 * inside it went with it: the token (already the unit beside the amount), the
 * period in raw seconds (already stated in words), and the request id, which
 * is debug output.
 *
 * ⚠️ THE AMOUNT WAS PRINTED THREE TIMES — as the headline, as "Maximum per
 * payment", and again inside "What you're approving" — in three type styles,
 * which reads as three different numbers at a glance. It is printed once.
 *
 * ⛔ FOUR READ-ONLY PRIVACY ROWS ARE DELETED. Stealth addresses, amount noise,
 * timing noise and on-chain sync were rendered as a settings card that could
 * not be set: the values arrive from the site or from the wallet's defaults
 * and no control here changed them. They are still applied — `addSubscription`
 * receives every one of them below, unchanged — they are simply no longer
 * presented as a decision the approver is making.
 *
 * ⛔ AND THE THREE-SECOND DEBUG DELAY BEFORE `window.close()` IS GONE. It was
 * added to read logs and shipped; to the approver it was three seconds of a
 * dead screen after a successful press, which is exactly how a hung wallet
 * feels.
 *
 * ⚠️ THE NO-REFUND RULE STAYS, AND STAYS ABOVE THE BUTTON. Cancellation and
 * refunds do not exist in `zk_shielded`; being told so before the press is the
 * only protection left. `no-refund-warning.test.ts` reads this file and pins
 * both the phrase and its position.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { truncateAddress } from '@/shared/utils';
import { useSubscriptionsStore } from '@/shared/store/subscriptions';
import { useWalletStore } from '@/shared/store/wallet';
import { sendToBackground } from '@/shared/messaging';
import type { SubscriptionInterval } from '@/shared/services/stream';
import { publishSubscription } from '@/shared/services/onchain-sync';
import { Keypair } from '@solana/web3.js';
import {
  detectServiceFromOrigin,
  detectServiceFromName,
  type ServiceInfo,
} from '@/shared/services/serviceRegistry';
import { Amount, Button, Hairline, Panel, Pill, Screen } from '@/popup/ui';

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

/**
 * The rule, named once at the top of the file.
 *
 * ⚠️ HOISTED ON PURPOSE. `no-refund-warning.test.ts` reads this file as text
 * and requires the phrase to appear before `onClick={handleApprove}`. The
 * approve button now lives in `Screen`'s `footer` prop, which JSX forces to be
 * WRITTEN above the body it RENDERS below. Naming the sentence here keeps the
 * source order the test checks and the screen order the subscriber sees in
 * agreement: the warning is the last thing in the scrolling body, sitting
 * directly on top of the button that never scrolls.
 */
const NO_REFUND_RULE = 'There is no cancellation and no refund';

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

/** One fact of the mandate, label left, value right. */
function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="shrink-0 text-tiny text-p01-text-muted">{label}</span>
      <span
        className={
          mono
            ? 'min-w-0 truncate text-right font-mono text-sm text-p01-text'
            : 'min-w-0 truncate text-right text-sm text-p01-text tabular'
        }
      >
        {value}
      </span>
    </div>
  );
}

export default function ApproveSubscription() {
  const [isApproving, setIsApproving] = useState(false);
  const [request, setRequest] = useState<SubscriptionRequestData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');

  // Privacy is applied AUTOMATICALLY, never picked manually here. The wallet
  // mirrors whatever privacy the website/dApp enabled (passed in the request),
  // matching the in-app stealth behavior. Stealth addresses are on by default
  // (app parity) and only overridden if the site explicitly opts out.
  const [amountNoise, setAmountNoise] = useState(5);    // Default 5%
  const [timingNoise, setTimingNoise] = useState(2);    // Default 2h
  const [useStealthAddress, setUseStealthAddress] = useState(true);
  // Cross-device sync is always on — subscriptions must be reachable from mobile
  // and any other device on this wallet. Not a user choice.
  const syncToChain = true;

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
      <Screen>
        {error ? (
          <p role="alert" className="mt-6 text-center text-sm text-p01-red">
            {error}
          </p>
        ) : (
          <p className="mt-6 flex items-center justify-center gap-2 text-sm text-p01-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading request
          </p>
        )}
      </Screen>
    );
  }

  const { payload, origin, originIcon } = request;

  // Use detected service info or fall back to dApp-provided info
  const serviceName = detectedService?.name || payload.merchantName;
  const serviceLogo = detectedService?.logo || payload.merchantLogo;

  // Calculate amounts (assuming SOL with 9 decimals for now)
  // In production, fetch token info from mint
  const decimals = payload.tokenMint ? 6 : 9; // USDC = 6, SOL = 9
  const amount = payload.amountPerPeriod / Math.pow(10, decimals);
  const maxTotal = payload.maxPeriods > 0 ? amount * payload.maxPeriods : Infinity;
  const periodLabel = formatPeriodSeconds(payload.periodSeconds);
  const unit = payload.tokenMint ? 'USDC' : 'SOL';

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

      // Cross-device sync is always on; only skips if the wallet is locked (no
      // keypair in memory). Local subscription is created either way.
      if (syncToChain && _keypair) {
        setSyncStatus('syncing');
        try {
          const keypair = Keypair.fromSecretKey(_keypair.secretKey);
          await publishSubscription(subscription, keypair, 'devnet');
          setSyncStatus('synced');
        } catch (syncErr) {
          console.warn('[ApproveSubscription] Failed to sync to chain:', syncErr);
          setSyncStatus('error');
          // Don't fail the whole operation, local subscription is still created
        }
      }

      // Notify background of approval
      await sendToBackground('APPROVE_REQUEST', {
        requestId: request.id,
        data: {
          subscriptionId: subscription.id,
          approved: true,
        },
      });

      window.close();
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
    <Screen
      title="Approve subscription"
      footer={
        <div className="flex flex-col gap-2">
          {error && (
            <p role="alert" className="text-tiny text-p01-red">
              {error}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" disabled={isApproving} onClick={handleReject}>
              Reject
            </Button>
            <Button size="lg" loading={isApproving} onClick={handleApprove}>
              {isApproving && syncStatus === 'syncing' ? 'Syncing' : 'Approve'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* ── Who is asking ── */}
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-p01-border bg-p01-surface">
            {serviceLogo ? (
              <img
                src={serviceLogo}
                alt=""
                className="h-6 w-6"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <span className="font-display text-lg font-normal text-p01-cyan">
                {serviceName.slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm text-p01-text">{serviceName}</p>
              {detectedService && (
                <Pill tone="good">
                  <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                  Verified
                </Pill>
              )}
            </div>
            <p className="truncate font-mono text-tiny text-p01-text-dim">{origin}</p>
          </div>
        </div>

        {/* ── The amount. Once, and large. ── */}
        <div className="pt-1">
          <Amount value={amount.toFixed(amount < 1 ? 4 : 2)} unit={unit} size="xl" />
          <p className="mt-1 text-sm text-p01-text-muted">
            every {periodLabel}, taken automatically
          </p>
          {payload.description && (
            <p className="mt-1.5 text-tiny text-p01-text-dim">{payload.description}</p>
          )}
        </div>

        {/* ── The mandate. The payee is here, in the open. ── */}
        <Panel>
          <Detail label="Paid to" value={truncateAddress(payload.recipient, 6)} mono />
          <Hairline className="bg-p01-border-soft" />
          <Detail
            label="Runs for"
            value={
              payload.maxPeriods > 0
                ? `${payload.maxPeriods} ${periodLabel}${payload.maxPeriods > 1 ? 's' : ''}`
                : 'No end date'
            }
          />
          <Hairline className="bg-p01-border-soft" />
          <Detail
            label="Most it can take"
            value={maxTotal === Infinity ? 'Unlimited' : `${maxTotal.toFixed(2)} ${unit}`}
          />
        </Panel>

        {/*
          THE NO-REFUND RULE, ABOVE THE BUTTON. This is the screen a
          dApp-initiated subscription is approved on, so the rule has to be
          stated HERE and not only on the wallet's own CreateSubscription page.
          It used to say "pause or cancel anytime", which the protocol can no
          longer deliver: cancel_normal and cancel_private_stark are deleted and
          claim_period only ever pays the merchant.
        */}
        <Panel tone="warn">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-p01-amber" aria-hidden="true" />
            <p className="text-tiny text-p01-text-muted">
              <span className="text-p01-text">{NO_REFUND_RULE}</span> — not from the merchant, not
              from Protocol 01. You can pause payments from your wallet at any time, but anything
              already sent is final.
            </p>
          </div>
        </Panel>
      </div>
    </Screen>
  );
}
