/**
 * @protocol-01/specter-js - Protocol 01 SDK
 *
 * @deprecated Use `@protocol-01/privacy-sdk` instead. See docs/MIGRATION.md.
 *
 * Privacy-first payment SDK for Solana with Stream Secure subscriptions.
 *
 * @example Basic usage
 * ```ts
 * import { P01 } from '@protocol-01/specter-js';
 *
 * const p01 = new P01();
 * await p01.connect();
 *
 * // One-time payment
 * await p01.pay({
 *   recipient: 'wallet_address',
 *   amount: 10,
 *   token: 'USDC',
 * });
 *
 * // Create subscription (Stream Secure)
 * await p01.subscribe({
 *   recipient: 'merchant_address',
 *   merchantName: 'Netflix',
 *   amount: 15.99,
 *   token: 'USDC',
 *   period: 'monthly',
 *   maxPayments: 12,
 * });
 * ```
 *
 * @example Error handling
 * ```ts
 * import { P01, isUserRejection, isNetworkError, isTimeoutError } from '@protocol-01/specter-js';
 *
 * try {
 *   await p01.pay({ recipient, amount: 10 });
 * } catch (error) {
 *   if (isUserRejection(error)) {
 *     // User declined in wallet popup
 *   } else if (isNetworkError(error)) {
 *     // RPC / network failure
 *   } else if (isTimeoutError(error)) {
 *     // Operation timed out
 *   }
 * }
 * ```
 */

// ─── Deprecation Warning ─────────────────────────────────────────────────────
if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production') {
  const DEPRECATION_WARNED = Symbol.for('p01.specter-js.deprecated');
  const g = globalThis as any;
  if (!g[DEPRECATION_WARNED]) {
    g[DEPRECATION_WARNED] = true;
    // eslint-disable-next-line no-console
    console.warn('[@protocol-01/specter-js] This package is deprecated. Migrate to @protocol-01/privacy-sdk. See docs/MIGRATION.md.');
  }
}

export { P01, Specter, type P01Config, type SpecterConfig } from './client';
export { createPayButton, type PayButtonOptions } from './pay-button';
export { createSubscribeButton, type SubscribeButtonOptions } from './subscribe-button';
export * from './types';
export * from './constants';
