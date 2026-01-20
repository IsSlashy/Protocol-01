/**
 * Subscribe Button - Easy integration for Stream Secure subscriptions
 *
 * @example
 * ```html
 * <div id="specter-subscribe"></div>
 * <script>
 *   Specter.createSubscribeButton('#specter-subscribe', {
 *     recipient: 'merchant_wallet',
 *     merchantName: 'Netflix',
 *     amount: 15.99,
 *     period: 'monthly',
 *     onSuccess: (sub) => console.log('Subscribed!', sub),
 *   });
 * </script>
 * ```
 */

import { Specter } from './client';
import { SubscriptionOptions, SubscriptionResult, SpecterError } from './types';
import { PERIODS } from './constants';

export interface SubscribeButtonOptions extends SubscriptionOptions {
  /** Button text */
  label?: string;
  /** Button style preset */
  theme?: 'dark' | 'light' | 'minimal';
  /** Custom CSS class */
  className?: string;
  /** Show price in button */
  showPrice?: boolean;
  /** Success callback */
  onSuccess?: (result: SubscriptionResult) => void;
  /** Error callback */
  onError?: (error: SpecterError) => void;
  /** Loading state callback */
  onLoading?: (loading: boolean) => void;
}

/**
 * Create a Subscribe with Specter button
 */
export function createSubscribeButton(
  selector: string | HTMLElement,
  options: SubscribeButtonOptions
): { destroy: () => void } {
  const container =
    typeof selector === 'string'
      ? document.querySelector(selector)
      : selector;

  if (!container) {
    throw new Error(`Container not found: ${selector}`);
  }

  const {
    label,
    theme = 'dark',
    className = '',
    showPrice = true,
    onSuccess,
    onError,
    onLoading,
    ...subscriptionOptions
  } = options;

  // Generate label
  const periodLabel = getPeriodLabel(subscriptionOptions.period);
  const priceLabel = showPrice
    ? `$${subscriptionOptions.amount}/${periodLabel}`
    : '';
  const buttonLabel = label || `Subscribe ${priceLabel}`;

  // Create button element
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `specter-subscribe-button specter-subscribe-button--${theme} ${className}`;
  button.innerHTML = `
    <span class="specter-subscribe-button__icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/>
      </svg>
    </span>
    <span class="specter-subscribe-button__content">
      <span class="specter-subscribe-button__label">${buttonLabel}</span>
      <span class="specter-subscribe-button__secure">Stream Secure</span>
    </span>
  `;

  // Add styles
  injectStyles();

  // Handle click
  let isLoading = false;
  const specter = new Specter();

  button.addEventListener('click', async () => {
    if (isLoading) return;

    isLoading = true;
    button.classList.add('specter-subscribe-button--loading');
    button.disabled = true;
    onLoading?.(true);

    try {
      // Connect if needed
      if (!specter.isConnected()) {
        await specter.connect();
      }

      // Create subscription
      const result = await specter.subscribe(subscriptionOptions);
      onSuccess?.(result);
    } catch (error) {
      onError?.(error as SpecterError);
    } finally {
      isLoading = false;
      button.classList.remove('specter-subscribe-button--loading');
      button.disabled = false;
      onLoading?.(false);
    }
  });

  container.appendChild(button);

  return {
    destroy: () => {
      button.remove();
    },
  };
}

function getPeriodLabel(period: SubscriptionOptions['period']): string {
  if (typeof period === 'number') {
    if (period === PERIODS.daily) return 'day';
    if (period === PERIODS.weekly) return 'week';
    if (period === PERIODS.monthly) return 'mo';
    if (period === PERIODS.yearly) return 'year';
    return 'period';
  }

  switch (period) {
    case 'daily':
      return 'day';
    case 'weekly':
      return 'week';
    case 'biweekly':
      return '2 weeks';
    case 'monthly':
      return 'mo';
    case 'quarterly':
      return 'quarter';
    case 'yearly':
      return 'year';
    default:
      return 'period';
  }
}

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .specter-subscribe-button {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 14px 28px;
      border: none;
      border-radius: 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .specter-subscribe-button--dark {
      background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
      color: #ffffff;
    }

    .specter-subscribe-button--dark:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(139, 92, 246, 0.4);
    }

    .specter-subscribe-button--light {
      background: #ffffff;
      color: #7c3aed;
      border: 2px solid #8b5cf6;
    }

    .specter-subscribe-button--light:hover {
      background: #f5f3ff;
    }

    .specter-subscribe-button--minimal {
      background: transparent;
      color: #8b5cf6;
      padding: 10px 20px;
    }

    .specter-subscribe-button--minimal:hover {
      background: rgba(139, 92, 246, 0.1);
    }

    .specter-subscribe-button:disabled {
      opacity: 0.7;
      cursor: not-allowed;
      transform: none !important;
    }

    .specter-subscribe-button__content {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }

    .specter-subscribe-button__label {
      font-size: 16px;
      font-weight: 600;
    }

    .specter-subscribe-button__secure {
      font-size: 11px;
      opacity: 0.8;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .specter-subscribe-button__secure::before {
      content: '🔒';
      font-size: 10px;
    }

    .specter-subscribe-button--loading .specter-subscribe-button__icon {
      animation: specter-pulse 1s ease-in-out infinite;
    }

    @keyframes specter-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `;
  document.head.appendChild(style);
}
