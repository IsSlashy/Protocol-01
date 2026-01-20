/**
 * Protocol 01 Payment Button
 *
 * A button component for one-time payments.
 */

import React, { useState, useCallback } from 'react';
import { useP01, useP01SDK, useP01Theme } from './P01Provider';
import type { PaymentButtonProps } from './types';

export function PaymentButton({
  amount,
  token = 'USDC',
  description,
  orderId,
  useStealthAddress,
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading: externalLoading = false,
  onSuccess,
  onError,
  className = '',
  style,
}: PaymentButtonProps) {
  const { isConnected, connect } = useP01();
  const sdk = useP01SDK();
  const theme = useP01Theme();
  const [loading, setLoading] = useState(false);

  const isLoading = loading || externalLoading;

  // Generate button text
  const buttonText = children ?? `Pay ${amount} ${token}`;

  // Handle click
  const handleClick = useCallback(async () => {
    if (isLoading || disabled) return;

    try {
      // Connect if not connected
      if (!isConnected) {
        await connect();
        return;
      }

      if (!sdk) {
        throw new Error('SDK not initialized');
      }

      setLoading(true);

      // Request payment
      const result = await sdk.requestPayment({
        amount,
        token,
        description,
        orderId,
        useStealthAddress,
      });

      onSuccess?.({
        signature: result.signature,
        paymentId: result.paymentId,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Payment failed');
      onError?.(error);
    } finally {
      setLoading(false);
    }
  }, [
    isConnected,
    sdk,
    amount,
    token,
    description,
    orderId,
    useStealthAddress,
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
      className={`p01-payment-button ${className}`}
      style={baseStyles}
    >
      {isLoading ? (
        <>
          <LoadingSpinner color={variant === 'primary' ? theme.backgroundColor : theme.primaryColor} />
          {isConnected ? 'Processing...' : 'Connecting...'}
        </>
      ) : (
        <>
          <PaymentIcon />
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

function PaymentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14m-7-7h14" strokeLinecap="round" strokeLinejoin="round" />
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
