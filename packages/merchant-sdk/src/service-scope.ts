import { PublicKey } from '@solana/web3.js';
import type { SubscriptionVaultAccount } from './vaults';

/**
 * The subset of a `ServiceRegistry` entry that a vault can be checked against.
 *
 * ## Why this exists
 *
 * `SubscriptionVault` records no service. Its PDA is
 * `[b"subscription_vault", retailer, subscriber_id, token_mint]`, so a merchant
 * that registers two services under the SAME `retailer` and `token_mint` gets
 * ONE vault per subscriber covering both — holding one `license_commitment`.
 *
 * `verifyLicenseKey` took a `serviceId` and did `void serviceId`. A key issued
 * for the cheap service therefore verified against the expensive one: the
 * commitment matched, and nothing else was consulted. That is entitlement
 * escalation, not a naming inconsistency.
 *
 * The registry does carry the missing facts, and they are immutable after
 * registration (`instructions.ts:146` — "`retailer` and `tokenMint` are
 * intentionally immutable post-registration"). Price and interval are written
 * into the vault verbatim at subscribe time as `rate` and `interval_slots`. So
 * the tuple below is enough to say whether a given vault was created for a
 * given service, using public on-chain data and no merchant secret.
 */
export interface ServiceScope {
  /** Payment recipient the service registered. */
  retailer: PublicKey;
  /** Token mint the service prices in. */
  tokenMint: PublicKey;
  /** Price per period, in the smallest unit of `tokenMint`. */
  priceAtomic: bigint;
  /** Billing period in slots. */
  intervalSlots: bigint;
}

export interface ServiceScopeMatch {
  matches: boolean;
  /** Populated when `matches` is false. */
  reason?: string;
  /**
   * True when the scope cannot distinguish this service from another one the
   * same merchant might run. See {@link vaultMatchesService}.
   */
  ambiguous?: boolean;
}

/**
 * Whether `vault` was plausibly created for the service described by `scope`.
 *
 * ## What this does and does not prove
 *
 * It proves the vault agrees with everything the service published: recipient,
 * mint, price and period. It cannot prove more, because the chain stores no
 * service identifier on the vault.
 *
 * So if a merchant runs two services with the same retailer, the same mint,
 * the SAME price and the SAME interval, the two are indistinguishable on chain
 * and this returns `matches: true, ambiguous: true`. That is reported rather
 * than silently passed: two products that agree on recipient, currency, price
 * and billing period are the same product as far as any observer can tell, and
 * a merchant relying on them being separate needs to know the chain does not
 * agree. The fix on their side is a distinct `retailer` key per service, which
 * the registry already allows and which makes the vault PDAs disjoint.
 */
export function vaultMatchesService(
  vault: Pick<SubscriptionVaultAccount, 'retailer' | 'tokenMint' | 'rate' | 'intervalSlots'>,
  scope: ServiceScope,
  opts: { otherServices?: ServiceScope[] } = {},
): ServiceScopeMatch {
  if (!vault.retailer.equals(scope.retailer)) {
    return { matches: false, reason: 'vault pays a different retailer than this service registered' };
  }
  if (!vault.tokenMint.equals(scope.tokenMint)) {
    return { matches: false, reason: 'vault is denominated in a different token than this service' };
  }
  if (vault.rate !== scope.priceAtomic) {
    return {
      matches: false,
      reason: `vault rate ${vault.rate} does not match the service price ${scope.priceAtomic}`,
    };
  }
  if (vault.intervalSlots !== scope.intervalSlots) {
    return {
      matches: false,
      reason: `vault interval ${vault.intervalSlots} does not match the service interval ${scope.intervalSlots}`,
    };
  }

  const collides = (opts.otherServices ?? []).some(
    (s) =>
      s.retailer.equals(scope.retailer) &&
      s.tokenMint.equals(scope.tokenMint) &&
      s.priceAtomic === scope.priceAtomic &&
      s.intervalSlots === scope.intervalSlots,
  );
  return collides ? { matches: true, ambiguous: true } : { matches: true };
}

/**
 * Options accepted by every entitlement check that can be scoped to a service.
 *
 * Lives here rather than next to any one caller because both the license paths
 * (`license.ts`) and the access-check paths (`vaults.ts`) take it, and putting
 * it in either of those would make the other import a module that imports it
 * back.
 */
export interface ServiceScopedOptions {
  /**
   * Registry facts for the service the caller is being asked to grant access
   * TO. Supply this and `serviceId` becomes enforceable; omit it and the check
   * is only against the merchant, so a subscription to one of the merchant's
   * services passes for any other that shares a retailer, mint, price and
   * interval.
   */
  service?: ServiceScope;
  /**
   * The merchant's other services, used only to report when `service` cannot
   * discriminate. Cheap to pass if the merchant already caches its registry.
   */
  otherServices?: ServiceScope[];
  /**
   * Refuse to answer at all when `service` was not supplied, instead of quietly
   * answering a weaker question. Recommended in production.
   *
   * Without it, omitting `service` degrades the check silently: the caller gets
   * a confident `true` for "a vault naming this merchant exists and is inside a
   * period someone paid for", which a stranger can arrange without ever talking
   * to the merchant. That is the self-minted-vault hole, and the shape of the
   * failure — a boolean that is simply weaker than the caller believes — is why
   * it needs an explicit opt-out rather than a comment.
   */
  requireService?: boolean;
  /**
   * Called when the scope check was SKIPPED because `service` was absent.
   *
   * The companion to `requireService` for callers who cannot fail closed yet:
   * a channel to discover the omission in logs. `verifyAccessToken` already
   * reports the same fact as `serviceChecked` in its result; the vault helpers
   * return a vault or `null` and have nowhere to put it.
   */
  onServiceUnchecked?: (info: { vault: string; retailer: string }) => void;
}

/** Build a {@link ServiceScope} from a decoded registry entry. */
export function serviceScopeFromRegistry(entry: {
  retailer: PublicKey;
  tokenMint: PublicKey;
  priceAtomic: bigint;
  intervalSlots: bigint;
}): ServiceScope {
  return {
    retailer: entry.retailer,
    tokenMint: entry.tokenMint,
    priceAtomic: entry.priceAtomic,
    intervalSlots: entry.intervalSlots,
  };
}
