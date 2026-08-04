/**
 * serviceRegistry — the live vendor roster, read from the `p01_registry`
 * program on devnet.
 *
 * ## The layout is NOT re-derived here
 *
 * Every byte offset comes from `packages/specter-sdk/src/service-registry/
 * account.ts`, imported by relative path and used verbatim. Three independent
 * hand-rolled copies of this layout already exist in the repo
 * (`apps/mobile/services/solana/serviceRegistry.ts` reuses the SDK;
 * `apps/extension/src/shared/services/onchainServiceRegistry.ts` re-implements
 * it), and a fourth that drifts is how a roster silently turns into garbage
 * names and a wrong `retailer` — which is the JOIN KEY between a subscription
 * vault and the tile that represents it. So: one decoder, imported.
 *
 * The relative import works because pnpm already resolves `@protocol-01/
 * pay-core` to `packages/pay-core/src/*.ts` for this app (see
 * `PayApp.tsx:35`), i.e. the bundler and `tsc` already compile workspace
 * TypeScript from outside `apps/web`. `account.ts` imports nothing but
 * `@solana/web3.js`, which this app already depends on.
 *
 * ## A failed read is a failure, never an empty roster
 *
 * The defect pattern this file exists to avoid: an RPC error or a decode
 * failure collapsing into `[]`, which the UI then renders as the honest
 * sentence "no vendors are available". Six vendors are registered and attested
 * on devnet, so an empty list is almost always a broken read. Therefore:
 *
 *   - an RPC throw propagates as `ServiceRegistryError`;
 *   - matched accounts that ALL fail to decode throw too;
 *   - a genuinely empty program returns a snapshot whose `matchedAccounts` is
 *     0, so the caller can say "the registry answered and it was empty" rather
 *     than "no vendors";
 *   - only successful snapshots are ever cached.
 */

import { Buffer } from 'buffer';
import { PublicKey, type Commitment, type Connection } from '@solana/web3.js';

import {
  SERVICE_REGISTRY_DISCRIMINATOR,
  decodeServiceRegistryAccount,
  type ServiceRegistryAccount,
} from '../../../../packages/specter-sdk/src/service-registry/account';

export { SERVICE_REGISTRY_DISCRIMINATOR };
export type { ServiceRegistryAccount };

/** `p01_registry` — DEVNET. The registry is not deployed on mainnet/testnet. */
export const REGISTRY_PROGRAM_ID = new PublicKey(
  'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB',
);

/**
 * The mint a service uses for native SOL pricing: `SystemProgram.programId`.
 * Matches `ServiceRegistryAccount.tokenMint` for every SOL-priced vendor.
 */
export const NATIVE_SOL_SENTINEL_MINT = '11111111111111111111111111111111';

/** Solana's nominal slot time. Used only for turning slots into human periods. */
export const SLOT_SECONDS = 0.4;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * One vendor, as the /pay UI needs it.
 *
 * The first nine fields are the contract callers are written against. `pda`,
 * `owner` and `tokenMint` come along because they are not cosmetic: `tokenMint`
 * decides how `priceAtomic` is scaled, and `(retailer, tokenMint)` — not
 * `retailer` alone — is what identifies a vault's service, since one retailer
 * may list a SOL plan and an SPL plan.
 */
export interface ServiceEntry {
  /** Per-owner unique id, and the string the license key is scoped to. */
  slug: string;
  name: string;
  iconKey: string;
  category: string;
  /** Payment recipient. The subscription vault is seeded on this key. */
  retailer: PublicKey;
  /** Price per period, in the smallest unit of `tokenMint`. */
  priceAtomic: bigint;
  /** Billing period, in slots. */
  intervalSlots: bigint;
  /** Protocol-attested badge. Unverified vendors are BADGED, not hidden. */
  verified: boolean;
  /** Merchant has not paused the listing. */
  active: boolean;

  /** The `ServiceRegistry` PDA this was decoded from. */
  pda: PublicKey;
  /** Merchant wallet that registered the listing. */
  owner: PublicKey;
  /** `NATIVE_SOL_SENTINEL_MINT` for SOL-priced plans. */
  tokenMint: PublicKey;
}

export interface FetchServicesOptions {
  /** Drop paused listings. Default `true`. */
  activeOnly?: boolean;
  /** Drop unattested listings. Default `false` — the UI badges them instead. */
  verifiedOnly?: boolean;
  commitment?: Commitment;
  programId?: PublicKey;
}

/**
 * The result of one read. The counters exist so a caller can tell the three
 * outcomes apart: a real roster, a registry that answered with nothing, and a
 * read that partially failed.
 */
export interface RegistrySnapshot {
  services: ServiceEntry[];
  /** `Date.now()` when the RPC answered. */
  fetchedAt: number;
  /** Accounts the discriminator filter matched. 0 means the program is empty. */
  matchedAccounts: number;
  /** Matched accounts that could not be decoded. Non-zero means drift. */
  decodeFailures: number;
  /** Decoded accounts dropped by `activeOnly` / `verifiedOnly`. */
  filteredOut: number;
}

/** Thrown for every failure mode. Never swallowed into an empty list. */
export class ServiceRegistryError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ServiceRegistryError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function toEntry(decoded: ServiceRegistryAccount, pda: PublicKey): ServiceEntry {
  return {
    slug: decoded.slug,
    name: decoded.name,
    iconKey: decoded.iconKey,
    category: decoded.category,
    retailer: decoded.retailer,
    priceAtomic: decoded.priceAtomic,
    intervalSlots: decoded.intervalSlots,
    verified: decoded.verified,
    active: decoded.active,
    pda,
    owner: decoded.owner,
    tokenMint: decoded.tokenMint,
  };
}

/**
 * The `memcmp` that keeps `UserRegistry` accounts (same program) out of the
 * result.
 *
 * base64, not base58, on purpose: base58 would pull in `bs58`, which this app
 * does not depend on, and `@solana/web3.js` accepts either
 * (`MemcmpFilter.encoding`). The extension's reader encodes the same filter the
 * same way.
 */
export function discriminatorFilter(): {
  memcmp: { offset: number; bytes: string; encoding: 'base64' };
} {
  return {
    memcmp: {
      offset: 0,
      bytes: Buffer.from(SERVICE_REGISTRY_DISCRIMINATOR).toString('base64'),
      encoding: 'base64',
    },
  };
}

/**
 * Read the roster straight from the chain. No cache — see
 * {@link loadServiceRegistry} for the cached entry point.
 *
 * Throws `ServiceRegistryError` when the RPC fails, and when accounts matched
 * but none of them decoded (a layout drift or a truncated `dataSlice` would
 * look exactly like "no vendors" otherwise).
 */
export async function fetchServiceRegistry(
  connection: Connection,
  opts: FetchServicesOptions = {},
): Promise<RegistrySnapshot> {
  const {
    activeOnly = true,
    verifiedOnly = false,
    commitment = 'confirmed',
    programId = REGISTRY_PROGRAM_ID,
  } = opts;

  let accounts;
  try {
    accounts = await connection.getProgramAccounts(programId, {
      commitment,
      filters: [discriminatorFilter()],
    });
  } catch (err) {
    throw new ServiceRegistryError(
      `Could not read the service registry from ${connection.rpcEndpoint}: ${(err as Error).message}`,
      err,
    );
  }

  const services: ServiceEntry[] = [];
  let decodeFailures = 0;
  let filteredOut = 0;

  for (const acc of accounts) {
    let decoded: ServiceRegistryAccount;
    try {
      decoded = decodeServiceRegistryAccount(acc.account.data);
    } catch {
      decodeFailures += 1;
      continue;
    }
    if (activeOnly && !decoded.active) {
      filteredOut += 1;
      continue;
    }
    if (verifiedOnly && !decoded.verified) {
      filteredOut += 1;
      continue;
    }
    services.push(toEntry(decoded, acc.pubkey));
  }

  if (accounts.length > 0 && decodeFailures === accounts.length) {
    throw new ServiceRegistryError(
      `The registry returned ${accounts.length} service account(s) and none of them could be ` +
        `decoded. The on-chain layout has changed, or the RPC truncated the account data. ` +
        `Refusing to report this as an empty vendor list.`,
    );
  }

  // Verified first, then alphabetical — the ordering mobile and the extension
  // both use, so the same vendor sits in the same place on every client.
  services.sort(
    (a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name),
  );

  return {
    services,
    fetchedAt: Date.now(),
    matchedAccounts: accounts.length,
    decodeFailures,
    filteredOut,
  };
}

// ---------------------------------------------------------------------------
// Cache
//
// `getProgramAccounts` is the expensive RPC call on this page and the roster
// changes on a merchant's timescale, not a user's. In-flight requests are
// deduplicated so mounting two panels does not double the load, and a REJECTED
// request is dropped from both maps — a failure must never be served as a
// cached answer, and must never leave a poisoned empty snapshot behind.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

const snapshots = new Map<string, RegistrySnapshot>();
const inFlight = new Map<string, Promise<RegistrySnapshot>>();

function cacheKey(connection: Connection, opts: FetchServicesOptions): string {
  const programId = (opts.programId ?? REGISTRY_PROGRAM_ID).toBase58();
  return [
    programId,
    connection.rpcEndpoint,
    opts.commitment ?? 'confirmed',
    opts.activeOnly === false ? 'all' : 'active',
    opts.verifiedOnly === true ? 'verified' : 'any',
  ].join('|');
}

export interface LoadOptions extends FetchServicesOptions {
  /** Ignore any cached snapshot and re-read. */
  force?: boolean;
  /** Accept a cached snapshot younger than this. Default 5 minutes. */
  maxAgeMs?: number;
}

/** The cached snapshot for these options, if one is still fresh. */
export function peekServiceRegistry(
  connection: Connection,
  opts: LoadOptions = {},
): RegistrySnapshot | null {
  const hit = snapshots.get(cacheKey(connection, opts));
  if (!hit) return null;
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  // Strictly younger than `maxAgeMs`, so `maxAgeMs: 0` means "never serve the
  // cache" rather than "serve it for the rest of this millisecond".
  return Date.now() - hit.fetchedAt < maxAge ? hit : null;
}

/**
 * Cached read. Serves a fresh snapshot, joins an in-flight read, or fetches.
 * Propagates `ServiceRegistryError` — a caller that renders `[]` on a rejection
 * is reintroducing the exact defect this module is built to prevent.
 */
export function loadServiceRegistry(
  connection: Connection,
  opts: LoadOptions = {},
): Promise<RegistrySnapshot> {
  const key = cacheKey(connection, opts);

  if (!opts.force) {
    const fresh = peekServiceRegistry(connection, opts);
    if (fresh) return Promise.resolve(fresh);
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const p = fetchServiceRegistry(connection, opts)
    .then((snap) => {
      snapshots.set(key, snap);
      return snap;
    })
    .finally(() => {
      // Cleared on success AND on rejection: nothing about a failed read is
      // worth remembering, and leaving the rejected promise here would make
      // every later caller inherit the same failure.
      if (inFlight.get(key) === p) inFlight.delete(key);
    });

  inFlight.set(key, p);
  return p;
}

/** Drop every cached snapshot. Exported for tests and for a hard refresh. */
export function clearServiceRegistryCache(): void {
  snapshots.clear();
  inFlight.clear();
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * `intervalSlots` → a human period. Mirrors
 * `apps/mobile/services/solana/serviceRegistry.ts:295-307` so the same listing
 * reads identically on both clients.
 */
export function formatInterval(intervalSlots: bigint): string {
  const seconds = Number(intervalSlots) * SLOT_SECONDS;
  const days = Math.round(seconds / 86_400);

  if (days >= 28 && days <= 31) return 'monthly';
  if (days === 7) return 'weekly';
  if (days === 14) return 'biweekly';
  if (days === 365 || days === 366) return 'yearly';
  if (days === 1) return 'daily';
  if (days >= 1) return `every ${days} days`;
  const hours = Math.round(seconds / 3600);
  if (hours >= 1) return `every ${hours} h`;
  return `every ${Math.round(seconds)} s`;
}

/** Decimals for a service's `tokenMint`. SOL is the sentinel; SPLs are 6 here. */
export function decimalsForMint(tokenMint: PublicKey): number {
  return tokenMint.toBase58() === NATIVE_SOL_SENTINEL_MINT ? 9 : 6;
}

/** `priceAtomic` → a display string in whole tokens, trailing zeros trimmed. */
export function formatPriceAtomic(priceAtomic: bigint, decimals: number): string {
  const scale = 10 ** decimals;
  const whole = Number(priceAtomic) / scale;
  if (whole === 0) return '0';
  const s = whole < 1 ? whole.toFixed(Math.min(decimals, 6)) : whole.toFixed(2);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** `"0.05 SOL"` — the price of ONE period. */
export function formatServicePrice(service: ServiceEntry): string {
  const symbol = service.tokenMint.toBase58() === NATIVE_SOL_SENTINEL_MINT ? 'SOL' : 'USDC';
  return `${formatPriceAtomic(service.priceAtomic, decimalsForMint(service.tokenMint))} ${symbol}`;
}
