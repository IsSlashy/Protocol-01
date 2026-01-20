/**
 * Pay Button - Easy integration for one-time payments
 *
 * @example
 * ```html
 * <div id="specter-pay"></div>
 * <script>
 *   Specter.createPayButton('#specter-pay', {
 *     recipient: 'wallet_address',
 *     amount: 10,
 *     token: 'USDC',
 *     onSuccess: (result) => console.log('Paid!', result),
 *   });
 * </script>
 * ```
 */

import { Specter } from './client';
import { PaymentOptions, PaymentResult, SpecterError } from './types';

export interface PayButtonOptions extends PaymentOptions {
  /** Button text */
  label?: string;
  /** Button style preset */
  theme?: 'dark' | 'light' | 'minimal';
  /** Custom CSS class */
  className?: string;
  /** Success callback */
  onSuccess?: (result: PaymentResult) => void;
  /** Error callback */
  onError?: (error: SpecterError) => void;
  /** Loading state callback */
  onLoading?: (loading: boolean) => void;
}

/**
 * Create a Pay with Specter button
 */
export function createPayButton(
  selector: string | HTMLElement,
  options: PayButtonOptions
): { destroy: () => void } {
  const container =
    typeof selector === 'string'
      ? document.querySelector(selector)
      : selector;

  if (!container) {
    throw new Error(`Container not found: ${selector}`);
  }

  const {
    label = `Pay ${options.amount} ${options.token || 'USDC'}`,
    theme = 'dark',
    className = '',
    onSuccess,
    onError,
    onLoading,
    ...paymentOptions
  } = options;

  // Create button element
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `specter-pay-button specter-pay-button--${theme} ${className}`;
  button.innerHTML = `
    <span class="specter-pay-button__icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    </span>
    <span class="specter-pay-button__label">${label}</span>
  `;

  // Add styles
  injectStyles();

  // Handle click
  let isLoading = false;
  const specter = new Specter();

  button.addEventListener('click', async () => {
    if (isLoading) return;

    isLoading = true;
    button.classList.add('specter-pay-button--loading');
    button.disabled = true;
    onLoading?.(true);

    try {
      // Connect if needed
      if (!specter.isConnected()) {
        await specter.connect();
      }

      // Make payment
      const result = await specter.pay(paymentOptions);
      onSuccess?.(result);
    } catch (error) {
      onError?.(error as SpecterError);
    } finally {
      isLoading = false;
      button.classList.remove('specter-pay-button--loading');
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

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .specter-pay-button {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 24px;
      border: none;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .specter-pay-button--dark {
      background: linear-gradient(135deg, #00ff88 0%, #00cc6a 100%);
      color: #050505;
    }

    .specter-pay-button--dark:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 20px rgba(0, 255, 136, 0.4);
    }

    .specter-pay-button--light {
      background: #ffffff;
      color: #050505;
      border: 2px solid #00ff88;
    }

    .specter-pay-button--light:hover {
      background: #f0fff5;
    }

    .specter-pay-button--minimal {
      background: transparent;
      color: #00ff88;
      padding: 8px 16px;
    }

    .specter-pay-button--minimal:hover {
      background: rgba(0, 255, 136, 0.1);
    }

    .specter-pay-button:disabled {
      opacity: 0.7;
      cursor: not-allowed;
      transform: none !important;
    }

    .specter-pay-button--loading .specter-pay-button__icon {
      animation: specter-spin 1s linear infinite;
    }

    @keyframes specter-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}
