import React from 'react';
import { useSubscription } from './use-subscription';
import { useSpecter } from './provider';
import type { SubscriptionOptions, SubscriptionResult, SpecterError } from '../types';

interface SubscribeButtonProps extends SubscriptionOptions {
  /** Button label */
  label?: string;
  /** Show price in button */
  showPrice?: boolean;
  /** Style variant */
  variant?: 'primary' | 'secondary' | 'minimal';
  /** Additional CSS class */
  className?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Success callback */
  onSuccess?: (result: SubscriptionResult) => void;
  /** Error callback */
  onError?: (error: SpecterError) => void;
  /** Children (overrides label) */
  children?: React.ReactNode;
}

/**
 * Ready-to-use Subscribe button component for Stream Secure
 *
 * @example
 * ```tsx
 * // Basic usage
 * <SubscribeButton
 *   recipient="merchant_wallet"
 *   merchantName="Netflix"
 *   amount={15.99}
 *   period="monthly"
 *   maxPayments={12}
 *   onSuccess={(sub) => console.log('Subscribed!', sub)}
 * />
 *
 * // Custom styling
 * <SubscribeButton
 *   recipient="merchant_wallet"
 *   merchantName="Spotify"
 *   amount={9.99}
 *   period="monthly"
 *   variant="secondary"
 *   label="Start Premium"
 * />
 * ```
 */
export function SubscribeButton({
  recipient,
  merchantName,
  merchantLogo,
  amount,
  token = 'USDC',
  period,
  maxPayments,
  description,
  metadata,
  label,
  showPrice = true,
  variant = 'primary',
  className = '',
  disabled = false,
  onSuccess,
  onError,
  children,
}: SubscribeButtonProps) {
  const { isInstalled } = useSpecter();
  const { subscribe, isLoading, error } = useSubscription();

  const handleClick = async () => {
    const result = await subscribe({
      recipient,
      merchantName,
      merchantLogo,
      amount,
      token,
      period,
      maxPayments,
      description,
      metadata,
    });

    if (result) {
      onSuccess?.(result);
    } else if (error) {
      onError?.(error);
    }
  };

  // Generate label
  const periodLabel = getPeriodLabel(period);
  const priceText = showPrice ? `$${amount}/${periodLabel}` : '';
  const buttonLabel = children || label || `Subscribe ${priceText}`;

  const baseStyles: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    padding: variant === 'minimal' ? '10px 20px' : '14px 28px',
    borderRadius: '14px',
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
      background: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)',
      color: '#ffffff',
    },
    secondary: {
      background: '#ffffff',
      color: '#7c3aed',
      border: '2px solid #8b5cf6',
    },
    minimal: {
      background: 'transparent',
      color: '#8b5cf6',
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
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <StreamIcon />
            {buttonLabel}
          </span>
          <span style={{ fontSize: '11px', opacity: 0.8, marginTop: '2px' }}>
            🔒 Stream Secure
          </span>
        </div>
      )}
    </button>
  );
}

function getPeriodLabel(period: SubscriptionOptions['period']): string {
  if (typeof period === 'number') {
    return 'period';
  }

  switch (period) {
    case 'daily':
      return 'day';
    case 'weekly':
      return 'week';
    case 'biweekly':
      return '2wk';
    case 'monthly':
      return 'mo';
    case 'quarterly':
      return 'qtr';
    case 'yearly':
      return 'yr';
    default:
      return 'period';
  }
}

function StreamIcon() {
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
      <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
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
