/**
 * Protocol 01 Subscription Widget
 *
 * A complete pricing widget for subscription payments.
 */

import React, { useState, useCallback } from 'react';
import { useP01, useP01SDK, useP01Theme } from './P01Provider';
import type { SubscriptionWidgetProps, PricingTier } from './types';
import { getIntervalName } from '../utils';

export function SubscriptionWidget({
  tiers,
  title = 'Choose Your Plan',
  description,
  showPrivacyOptions = true,
  onSuccess,
  onError,
  className = '',
  style,
  theme: customTheme,
}: SubscriptionWidgetProps) {
  const { isConnected, isP01Wallet, connect } = useP01();
  const sdk = useP01SDK();
  const defaultTheme = useP01Theme();
  const theme = { ...defaultTheme, ...customTheme };

  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [enablePrivacy, setEnablePrivacy] = useState(true);

  // Handle tier selection
  const handleSelectTier = useCallback(async (tier: PricingTier) => {
    if (loading) return;

    setSelectedTier(tier.id);

    try {
      // Connect if not connected
      if (!isConnected) {
        await connect();
        return;
      }

      // Check if P01 wallet (required for subscriptions)
      if (!isP01Wallet) {
        throw new Error('Stream Secure subscriptions require Protocol 01 wallet. Please install P-01 wallet.');
      }

      if (!sdk) {
        throw new Error('SDK not initialized');
      }

      setLoading(true);

      // Apply privacy options if enabled
      const privacyOptions = enablePrivacy && tier.suggestedPrivacy
        ? tier.suggestedPrivacy
        : undefined;

      // Create subscription
      const result = await sdk.createSubscription({
        amount: tier.price,
        token: tier.token,
        interval: tier.interval,
        maxPayments: tier.maxPayments,
        description: tier.description || tier.name,
        suggestedPrivacy: privacyOptions,
        trialDays: tier.trialDays,
      });

      onSuccess?.({
        tierId: tier.id,
        subscriptionId: result.subscriptionId,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Subscription failed');
      onError?.(error);
    } finally {
      setLoading(false);
      setSelectedTier(null);
    }
  }, [isConnected, isP01Wallet, sdk, enablePrivacy, loading, connect, onSuccess, onError]);

  // Widget container styles
  const containerStyles: React.CSSProperties = {
    fontFamily: theme.fontFamily,
    backgroundColor: theme.backgroundColor,
    borderRadius: theme.borderRadius,
    padding: '32px',
    maxWidth: '900px',
    margin: '0 auto',
    ...style,
  };

  return (
    <div className={`p01-subscription-widget ${className}`} style={containerStyles}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '32px' }}>
        <h2 style={{
          color: theme.textColor,
          fontSize: '28px',
          fontWeight: 700,
          margin: '0 0 8px 0',
        }}>
          {title}
        </h2>
        {description && (
          <p style={{
            color: theme.mutedColor,
            fontSize: '16px',
            margin: 0,
          }}>
            {description}
          </p>
        )}
      </div>

      {/* Privacy Toggle */}
      {showPrivacyOptions && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          marginBottom: '24px',
        }}>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            color: theme.mutedColor,
            fontSize: '14px',
          }}>
            <input
              type="checkbox"
              checked={enablePrivacy}
              onChange={(e) => setEnablePrivacy(e.target.checked)}
              style={{ accentColor: theme.primaryColor }}
            />
            <ShieldIcon color={enablePrivacy ? theme.primaryColor : theme.mutedColor} />
            Enable Privacy Features
          </label>
        </div>
      )}

      {/* Pricing Tiers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(tiers.length, 3)}, 1fr)`,
        gap: '24px',
      }}>
        {tiers.map((tier) => (
          <TierCard
            key={tier.id}
            tier={tier}
            theme={theme}
            isSelected={selectedTier === tier.id}
            isLoading={loading && selectedTier === tier.id}
            isConnected={isConnected}
            onSelect={() => handleSelectTier(tier)}
          />
        ))}
      </div>

      {/* Footer */}
      <div style={{
        textAlign: 'center',
        marginTop: '24px',
        color: theme.mutedColor,
        fontSize: '12px',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
          <LockIcon color={theme.primaryColor} />
          Secured by Protocol 01 Stream Secure
        </span>
      </div>
    </div>
  );
}

// ============ Tier Card Component ============

interface TierCardProps {
  tier: PricingTier;
  theme: any;
  isSelected: boolean;
  isLoading: boolean;
  isConnected: boolean;
  onSelect: () => void;
}

function TierCard({ tier, theme, isSelected, isLoading, isConnected, onSelect }: TierCardProps) {
  const intervalName = typeof tier.interval === 'string'
    ? tier.interval
    : getIntervalName(tier.interval);

  return (
    <div
      style={{
        backgroundColor: theme.surfaceColor,
        borderRadius: theme.borderRadius,
        border: tier.popular
          ? `2px solid ${theme.primaryColor}`
          : `1px solid ${theme.borderColor}`,
        padding: '24px',
        position: 'relative',
        transition: 'all 0.2s ease',
        transform: isSelected ? 'scale(1.02)' : 'scale(1)',
      }}
    >
      {/* Popular Badge */}
      {tier.popular && (
        <div style={{
          position: 'absolute',
          top: '-12px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: theme.primaryColor,
          color: theme.backgroundColor,
          padding: '4px 16px',
          borderRadius: '12px',
          fontSize: '12px',
          fontWeight: 600,
        }}>
          Most Popular
        </div>
      )}

      {/* Tier Name */}
      <h3 style={{
        color: theme.textColor,
        fontSize: '20px',
        fontWeight: 600,
        margin: '0 0 8px 0',
        textAlign: 'center',
      }}>
        {tier.name}
      </h3>

      {/* Price */}
      <div style={{ textAlign: 'center', marginBottom: '16px' }}>
        <span style={{
          color: theme.textColor,
          fontSize: '40px',
          fontWeight: 700,
        }}>
          {tier.price}
        </span>
        <span style={{
          color: theme.mutedColor,
          fontSize: '16px',
          marginLeft: '4px',
        }}>
          {tier.token || 'USDC'}/{intervalName}
        </span>
      </div>

      {/* Description */}
      {tier.description && (
        <p style={{
          color: theme.mutedColor,
          fontSize: '14px',
          textAlign: 'center',
          margin: '0 0 16px 0',
        }}>
          {tier.description}
        </p>
      )}

      {/* Features */}
      {tier.features && tier.features.length > 0 && (
        <ul style={{
          listStyle: 'none',
          padding: 0,
          margin: '0 0 20px 0',
        }}>
          {tier.features.map((feature, index) => (
            <li
              key={index}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: theme.textColor,
                fontSize: '14px',
                marginBottom: '8px',
              }}
            >
              <CheckIcon color={theme.successColor} />
              {feature}
            </li>
          ))}
        </ul>
      )}

      {/* Trial Badge */}
      {tier.trialDays && tier.trialDays > 0 && (
        <div style={{
          textAlign: 'center',
          marginBottom: '16px',
          color: theme.primaryColor,
          fontSize: '13px',
          fontWeight: 500,
        }}>
          {tier.trialDays} day free trial
        </div>
      )}

      {/* Subscribe Button */}
      <button
        onClick={onSelect}
        disabled={isLoading}
        style={{
          width: '100%',
          padding: '14px 24px',
          backgroundColor: tier.popular ? theme.primaryColor : 'transparent',
          color: tier.popular ? theme.backgroundColor : theme.primaryColor,
          border: tier.popular ? 'none' : `2px solid ${theme.primaryColor}`,
          borderRadius: '10px',
          fontSize: '16px',
          fontWeight: 600,
          cursor: isLoading ? 'not-allowed' : 'pointer',
          opacity: isLoading ? 0.7 : 1,
          transition: 'all 0.2s ease',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
        }}
      >
        {isLoading ? (
          <>
            <LoadingSpinner color={tier.popular ? theme.backgroundColor : theme.primaryColor} />
            Processing...
          </>
        ) : (
          isConnected ? 'Subscribe Now' : 'Connect Wallet'
        )}
      </button>
    </div>
  );
}

// ============ Icons ============

function CheckIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShieldIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon({ color }: { color: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  );
}

function LoadingSpinner({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: 'p01-spin 1s linear infinite' }}
    >
      <style>
        {`@keyframes p01-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="32"
        strokeDashoffset="12"
      />
    </svg>
  );
}
