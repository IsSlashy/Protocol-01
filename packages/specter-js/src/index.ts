/**
 * @p01/js - Protocol 01 SDK
 *
 * Privacy-first payment SDK for Solana with Stream Secure subscriptions.
 *
 * @example Basic usage
 * ```ts
 * import { P01 } from '@p01/js';
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
 */

export { P01, type P01Config } from './client';
export { createPayButton, type PayButtonOptions } from './pay-button';
export { createSubscribeButton, type SubscribeButtonOptions } from './subscribe-button';
export * from './types';
export * from './constants';
