/**
 * @protocol-01/merchant-sdk
 *
 * Server-side helpers for merchants integrating with Protocol 01.
 *
 *   1. **Register a service** — write a `ServiceRegistry` PDA so every
 *      Protocol 01 client picks the service up in their subscription UI.
 *
 *   2. **Detect one-shot unshield payments** — parse a Solana signature
 *      and confirm it transferred the expected amount to the retailer
 *      wallet with a matching invoice memo (`p01:<slug>:...`).
 *
 *   3. **Watch vault subscriptions** — enumerate `SubscriptionVault`
 *      accounts whose `retailer` matches the merchant, so recurring
 *      private subscribers can be granted access.
 *
 * Design goals:
 *   - Framework-agnostic. Works in Node.js, Next.js routes, Cloudflare
 *     Workers, Deno. No wallet adapter dependency; callers bring their
 *     own `Keypair` or `signTransaction` callback.
 *   - No network side effects at import time. Everything is explicit.
 *   - The lower-level registry helpers live in `@protocol-01/specter-sdk`
 *     and are re-exported here for ergonomics.
 */

export * from './config';
export * from './registration';
export * from './payments';
export * from './vaults';
export * from './access-token';
export * from './license';
export * from './claim';

// Re-export the lower-level registry helpers so merchants only need one dep.
export {
  buildRegisterServiceIx,
  buildUpdateServiceIx,
  buildDeregisterServiceIx,
  buildBumpSubscriberCountIx,
  buildAttestServiceIx,
  decodeServiceRegistryAccount,
  fetchService,
  fetchServiceByPda,
  fetchAllServices,
  getServicePDA,
  PROTOCOL_VERIFIED_AUTHORITY,
  REGISTRY_PROGRAM_ID,
  SERVICE_REGISTRY_DISCRIMINATOR,
  SERVICE_REGISTRY_MAX_SIZE,
  type ServiceEntry,
  type ServiceRegistryAccount,
  type RegisterServiceArgs,
  type UpdateServiceArgs,
  type FetchServicesOptions,
} from '@protocol-01/specter-sdk/service-registry';
