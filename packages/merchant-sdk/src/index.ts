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
 *   3. **Check a subscription** — read the ONE `SubscriptionVault` a request is
 *      about (`hasActiveVaultAccessForVault` / `verifyLicenseAgainstVault`) and
 *      decide whether to serve it. `listVaultsForRetailer` still returns the
 *      whole book for reconciliation, on a schedule rather than per request.
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
// The send path for the revenue leg. Separate module so `vaults.ts -> claim.ts`
// stays the only edge between those two and nothing becomes a cycle.
export * from './claim-send';
export * from './service-scope';

// Re-export the lower-level registry helpers so merchants only need one dep.
//
// Imported by RELATIVE path into specter-sdk's source, not via the
// `@protocol-01/specter-sdk/service-registry` specifier, deliberately: tsup
// bundles the JS either way (`noExternal` used to do it), but its d.ts
// bundler resolves with node10 semantics, cannot see subpath `exports`, and
// silently left the specifier in the emitted `dist/index.d.ts`. A standalone
// `npm install` of the packed tgz then ran fine and failed `tsc --noEmit`
// with TS2307 — the JS was self-contained, the types were not. MEASURED
// 2026-08-04 on a clean consumer outside the workspace. A relative import is
// internal to both bundlers, so the types are inlined too. The slice's own
// imports stay within deps this package already declares (web3.js, bs58).
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
} from '../../specter-sdk/src/service-registry/index';
