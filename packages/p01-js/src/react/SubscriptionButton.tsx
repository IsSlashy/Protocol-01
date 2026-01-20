/**
 * Protocol 01 Subscription Button
 *
 * A button component for creating Stream Secure subscriptions.
 */

import React, { useState, useCallback } from 'react';
import { useP01, useP01SDK, useP01Theme } from './P01Provider';
import type { SubscriptionButtonProps } from './types';
import { getIntervalName } from '../utils';

export function SubscriptionButton({
  amount,
  token = 'USDC',
  interval,
  maxPayments = 0,
  description,
  subscriptionRef,
  trialDays,
  suggestedPrivacy,
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading: externalLoading = false,
  onSuccess,
  onError,
  className = '',
  style,
}: SubscriptionButtonProps) {
  const { isConnected, isP01Wallet, connect } = useP01();
  const sdk = useP01SDK();
  const theme = useP01Theme();
  const [loading, setLoading] = useState(false);

  const isLoading = loading || externalLoading;
  const intervalName = typeof interval === 'string' ? interval : getIntervalName(interval);

  // Generate button text
  const buttonText = children ?? `Subscribe ${amount} ${token}/${intervalName}`;

  // Handle click
  const handleClick = useCallback(async () => {
    if (isLoading || disabled) return;

    try {
      // Connect if not connected
      if (!isConnected) {
        await connect();
        return;
      }

      // Check if P01 wallet (required for subscriptions)
      if (!isP01Wallet) {
        throw new Error('Stream Secure subscriptions require Protocol 01 wallet');
      }

      if (!sdk) {
        throw new Error('SDK not initialized');
      }

      setLoading(true);

      // Create subscription
      const result = await sdk.createSubscription({
        amount,
        token,
        interval,
        maxPayments,
        description,
        subscriptionRef,
        trialDays,
        suggestedPrivacy,
      });

      onSuccess?.({
        subscriptionId: result.subscriptionId,
        signature: result.signature,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Subscription failed');
      onError?.(error);
    } finally {
      setLoading(false);
    }
  }, [
    isConnected,
    isP01Wallet,
    sdk,
    amount,
    token,
    interval,
    maxPayments,
    description,
    subscriptionRef,
    trialDays,
    suggestedPrivacy,
    onSuccess,
    onError,
    isLoading,
    disabled,
    connect,
  ]);

  // Compute styles
  const baseStyles: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontFamily: theme.fontFamily,
    fontWeight: 600,
    cursor: disabled || isLoading ? 'not-allowed' : 'pointer',
    opacity: disabled || isLoading ? 0.6 : 1,
    transition: 'all 0.2s ease',
    border: 'none',
    outline: 'none',
    ...getSizeStyles(size),
    ...getVariantStyles(variant, theme),
    ...style,
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isLoading}
      className={`p01-subscription-button ${className}`}
      style={baseStyles}
    >
      {isLoading ? (
        <>
          <LoadingSpinner color={variant === 'primary' ? theme.backgroundColor : theme.primaryColor} />
          {isConnected ? 'Processing...' : 'Connecting...'}
        </>
      ) : (
        <>
          <SubscriptionIcon />
          {buttonText}
        </>
      )}
    </button>
  );
}

// ============ Helper Components ============

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

function SubscriptionIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ============ Style Helpers ============

function getSizeStyles(size: 'sm' | 'md' | 'lg'): React.CSSProperties {
  switch (size) {
    case 'sm':
      return { padding: '8px 16px', fontSize: '14px', borderRadius: '8px' };
    case 'lg':
      return { padding: '16px 32px', fontSize: '18px', borderRadius: '16px' };
    case 'md':
    default:
      return { padding: '12px 24px', fontSize: '16px', borderRadius: '12px' };
  }
}

function getVariantStyles(variant: 'primary' | 'secondary' | 'outline', theme: any): React.CSSProperties {
  switch (variant) {
    case 'secondary':
      return {
        backgroundColor: theme.surfaceColor,
        color: theme.textColor,
        border: `1px solid ${theme.borderColor}`,
      };
    case 'outline':
      return {
        backgroundColor: 'transparent',
        color: theme.primaryColor,
        border: `2px solid ${theme.primaryColor}`,
      };
    case 'primary':
    default:
      return {
        backgroundColor: theme.primaryColor,
        color: theme.backgroundColor,
        border: 'none',
      };
  }
}
