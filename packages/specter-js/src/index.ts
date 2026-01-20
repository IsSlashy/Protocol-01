/**
 * @specter/js - Specter Protocol SDK
 *
 * Privacy-first payment SDK for Solana with Stream Secure subscriptions.
 *
 * @example Basic usage
 * ```ts
 * import { Specter } from '@specter/js';
 *
 * const specter = new Specter();
 * await specter.connect();
 *
 * // One-time payment
 * await specter.pay({
 *   recipient: 'wallet_address',
 *   amount: 10,
 *   token: 'USDC',
 * });
 *
 * // Create subscription (Stream Secure)
 * await specter.subscribe({
 *   recipient: 'merchant_address',
 *   merchantName: 'Netflix',
 *   amount: 15.99,
 *   token: 'USDC',
 *   period: 'monthly',
 *   maxPayments: 12,
 * });
 * ```
 */

export { Specter, type SpecterConfig } from './client';
export { createPayButton, type PayButtonOptions } from './pay-button';
export { createSubscribeButton, type SubscribeButtonOptions } from './subscribe-button';
export * from './types';
export * from './constants';
