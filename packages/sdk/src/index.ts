/**
 * @protocol-01/streams -- Payment streams for Solana.
 *
 * Create, manage, and withdraw from continuous payment streams
 * with time-based token unlocking.
 *
 * @example
 * ```ts
 * import { createDevnetClient } from '@protocol-01/streams';
 *
 * const client = createDevnetClient();
 * client.connect(wallet);
 * const sig = await client.createStream({ ... });
 * ```
 *
 * @packageDocumentation
 */

export * from './stream';
export * from './types';
export * from './constants';
export * from './utils';
