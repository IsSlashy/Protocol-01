/**
 * @protocol-01/specter-js - Protocol 01 SDK
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

export { P01, Specter, type P01Config, type SpecterConfig } from './client';
export { createPayButton, type PayButtonOptions } from './pay-button';
export { createSubscribeButton, type SubscribeButtonOptions } from './subscribe-button';
export * from './types';
export * from './constants';
