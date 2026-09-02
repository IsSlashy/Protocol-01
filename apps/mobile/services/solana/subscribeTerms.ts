/**
 * What the subscribe screen is about to buy, resolved from its route params.
 *
 * Two ways in. Discover pushes `{ service: <registry PDA> }` and nothing else;
 * older callers and deep links pass the terms spelled out (`retailer`,
 * `priceLamports`, `intervalSlots`, `supportsVault`, ...). Both end in the same
 * `SubscribeTerms`, and a registry entry, when there is one, wins over every
 * spelled-out field.
 *
 * Why the entry has to win: a merchant checks a customer's key with
 * `verifyMerchantLicense`, which requires the vault's rate and interval to
 * equal the registry entry EXACTLY, bigint for bigint. So the values that go
 * into the vault are copied from the entry verbatim, never through a float,
 * and the license tag is the entry's slug. Between commit cfdc0732 and this
 * file the screen never read `service` at all, so the registry path could not
 * be reached from the app's own navigation.
 *
 * Pure: no React, no RPC, so it is testable as a function.
 */

import type { ServiceEntry } from './serviceRegistry';
import { licenseServiceTag } from '../license/derive';

export interface SubscribeRouteParams {
  /** Registry entry PDA, as Discover pushes it. */
  service?: string;
  serviceId?: string;
  serviceName?: string;
  servicePda?: string;
  retailer?: string;
  priceLamports?: string;
  intervalSlots?: string;
  supportsOneshot?: string;
  supportsVault?: string;
  verified?: string;
  iconKey?: string;
  category?: string;
  // Legacy params (older screens still pass these).
  price?: string;
  frequency?: string;
}

export interface SubscribeTerms {
  /** Where the terms came from. */
  source: 'registry' | 'params';
  /**
   * True while a `service` PDA was given but no entry has been supplied yet.
   * The screen must not open a vault in this state: the terms below are the
   * spelled-out fallbacks, which for a Discover push are empty.
   */
  awaitingRegistry: boolean;
  /** Registry slug, or '' for a recipient without one. */
  serviceId: string;
  serviceName: string;
  servicePda: string | null;
  /** Retailer base58, unvalidated; `null` when nothing supplied one. */
  retailer: string | null;
  priceLamports: bigint;
  intervalSlots: bigint;
  supportsOneshot: boolean;
  supportsVault: boolean;
  verified: boolean;
  iconKey: string;
  category: string | null;
  /** Legacy display frequency, only ever from params. */
  frequency: string | null;
  /**
   * The tag hashed into `license_commitment`: the slug when there is one,
   * else the retailer address (`licenseServiceTag`). `null` without a retailer.
   */
  licenseTag: string | null;
}

/** Monthly, in slots, when nothing says otherwise. */
export const DEFAULT_INTERVAL_SLOTS = 6_480_000n;

function safeBigInt(value: string | undefined): bigint | null {
  if (value === undefined || value === '') return null;
  try {
    const n = BigInt(value);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

/** Terms copied verbatim from a registry entry. */
export function termsFromRegistryEntry(entry: ServiceEntry): SubscribeTerms {
  const retailer = entry.retailer.toBase58();
  return {
    source: 'registry',
    awaitingRegistry: false,
    serviceId: entry.slug,
    serviceName: entry.name || entry.slug,
    servicePda: entry.pda.toBase58(),
    retailer,
    priceLamports: entry.priceAtomic,
    intervalSlots: entry.intervalSlots,
    supportsOneshot: entry.supportsOneshot,
    supportsVault: entry.supportsVault,
    verified: entry.verified,
    iconKey: entry.iconKey || entry.slug,
    category: entry.category || null,
    frequency: null,
    licenseTag: licenseServiceTag(entry.slug, retailer),
  };
}

/** Terms as older callers spell them out on the route. */
export function termsFromRouteParams(params: SubscribeRouteParams): SubscribeTerms {
  const serviceId = params.serviceId || '';
  const retailer = params.retailer || null;
  const priceLamports =
    safeBigInt(params.priceLamports) ??
    BigInt(Math.round(parseFloat(params.price || '0') * 1e9) || 0);
  return {
    source: 'params',
    awaitingRegistry: !!params.service,
    serviceId,
    serviceName: params.serviceName || 'Service',
    servicePda: params.servicePda || params.service || null,
    retailer,
    priceLamports,
    intervalSlots: safeBigInt(params.intervalSlots) ?? DEFAULT_INTERVAL_SLOTS,
    supportsOneshot: params.supportsOneshot !== '0',
    supportsVault: params.supportsVault === '1',
    verified: params.verified === '1',
    iconKey: params.iconKey || serviceId,
    category: params.category || null,
    frequency: params.frequency || null,
    licenseTag: retailer ? licenseServiceTag(serviceId, retailer) : null,
  };
}

/**
 * The entry wins whenever one is supplied; otherwise the spelled-out params
 * carry, flagged `awaitingRegistry` if a `service` PDA is still unresolved.
 */
export function resolveSubscribeTerms(
  params: SubscribeRouteParams,
  entry: ServiceEntry | null | undefined,
): SubscribeTerms {
  return entry ? termsFromRegistryEntry(entry) : termsFromRouteParams(params);
}
