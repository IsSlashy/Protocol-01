import React from 'react';
import { usePayment } from './use-payment';
import { useSpecter } from './provider';
import type { PaymentOptions, PaymentResult, SpecterError } from '../types';

interface PayButtonProps extends Omit<PaymentOptions, 'reference'> {
  /** Button label */
  label?: string;
  /** Style variant */
  variant?: 'primary' | 'secondary' | 'minimal';
  /** Additional CSS class */
  className?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Success callback */
  onSuccess?: (result: PaymentResult) => void;
  /** Error callback */
  onError?: (error: SpecterError) => void;
  /** Children (overrides label) */
  children?: React.ReactNode;
}

/**
 * Ready-to-use Pay button component
 *
 * @example
 * ```tsx
 * <PayButton
 *   recipient="seller_wallet"
 *   amount={25}
 *   token="USDC"
 *   onSuccess={(result) => console.log('Paid!', result)}
 * />
 *
 * // Custom label
 * <PayButton
 *   recipient="seller_wallet"
 *   amount={100}
 *   label="Buy Now - $100"
 * />
 *
 * // Custom children
 * <PayButton recipient="seller_wallet" amount={50}>
 *   <MyCustomIcon /> Pay with Specter
 * </PayButton>
 * ```
 */
export function PayButton({
  recipient,
  amount,
  token = 'USDC',
  private: isPrivate = true,
  memo,
  label,
  variant = 'primary',
  className = '',
  disabled = false,
  onSuccess,
  onError,
  children,
}: PayButtonProps) {
  const { isInstalled, isConnected } = useSpecter();
  const { pay, isLoading, error } = usePayment();

  const handleClick = async () => {
    const result = await pay({
      recipient,
      amount,
      token,
      private: isPrivate,
      memo,
    });

    if (result) {
      onSuccess?.(result);
    } else if (error) {
      onError?.(error);
    }
  };

  const buttonLabel = children || label || `Pay ${amount} ${token}`;

  const baseStyles: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: variant === 'minimal' ? '8px 16px' : '12px 24px',
    borderRadius: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '16px',
    fontWeight: 600,
    cursor: disabled || isLoading ? 'not-allowed' : 'pointer',
    opacity: disabled || isLoading ? 0.7 : 1,
    transition: 'all 0.2s ease',
    border: 'none',
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      background: 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)',
      color: '#050505',
    },
    secondary: {
      background: '#ffffff',
      color: '#050505',
      border: '2px solid #00ff88',
    },
    minimal: {
      background: 'transparent',
      color: '#00ff88',
    },
  };

  if (!isInstalled) {
    return (
      <a
        href="https://specter.protocol/download"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          ...baseStyles,
          ...variantStyles[variant],
          textDecoration: 'none',
        }}
        className={className}
      >
        Install Specter Wallet
      </a>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isLoading}
      style={{ ...baseStyles, ...variantStyles[variant] }}
      className={className}
    >
      {isLoading ? (
        <>
          <LoadingSpinner />
          Processing...
        </>
      ) : (
        <>
          <ShieldIcon />
          {buttonLabel}
        </>
      )}
    </button>
  );
}

function ShieldIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <path d="M21 12a9 9 0 11-6.219-8.56" />
    </svg>
  );
}
