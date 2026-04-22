/**
 * Mobile-side helper for the on-chain Service Registry.
 *
 * Fetches verified + active services, caches them in AsyncStorage so the app
 * boots fast, and exposes a stable `useServiceRegistry` React hook.
 *
 * The cache is stale-while-revalidate: the hook returns whatever was cached
 * immediately and then refetches from the chain in the background.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { useEffect, useState } from 'react';
import { fetchAllServices as sdkFetchAllServices } from '@protocol-01/specter-sdk';
import { getConnection } from './connection';

/**
 * Local mirror of `@protocol-01/specter-sdk`'s `ServiceEntry`.
 *
 * The specter-sdk is declared as a workspace dep in `apps/mobile/package.json`
 * so the static import above is Metro-safe. Keeping the shape inline avoids
 * depending on the SDK's type surface at the app boundary.
 */
export interface ServiceEntry {
  pda: PublicKey;
  owner: PublicKey;
  retailer: PublicKey;
  tokenMint: PublicKey;
  priceAtomic: bigint;
  intervalSlots: bigint;
  subscriberCount: bigint;
  supportsOneshot: boolean;
  supportsVault: boolean;
  verified: boolean;
  active: boolean;
  bump: number;
  createdAt: number;
  updatedAt: number;
  slug: string;
  name: string;
  iconKey: string;
  category: string;
  metadataUri: string;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const CACHE_KEY = 'p01_service_registry_v1';
/** Background refresh interval; the cache is ALSO returned immediately. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

interface CachedService {
  pda: string;
  owner: string;
  retailer: string;
  tokenMint: string;
  priceAtomic: string; // stringified bigint
  intervalSlots: string;
  subscriberCount: string;
  supportsOneshot: boolean;
  supportsVault: boolean;
  verified: boolean;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  slug: string;
  name: string;
  iconKey: string;
  category: string;
  metadataUri: string;
}

interface CacheEnvelope {
  fetchedAt: number;
  services: CachedService[];
}

function serviceToCache(s: ServiceEntry): CachedService {
  return {
    pda: s.pda.toBase58(),
    owner: s.owner.toBase58(),
    retailer: s.retailer.toBase58(),
    tokenMint: s.tokenMint.toBase58(),
    priceAtomic: s.priceAtomic.toString(),
    intervalSlots: s.intervalSlots.toString(),
    subscriberCount: s.subscriberCount.toString(),
    supportsOneshot: s.supportsOneshot,
    supportsVault: s.supportsVault,
    verified: s.verified,
    active: s.active,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    slug: s.slug,
    name: s.name,
    iconKey: s.iconKey,
    category: s.category,
    metadataUri: s.metadataUri,
  };
}

function cacheToService(c: CachedService): ServiceEntry {
  return {
    pda: new PublicKey(c.pda),
    owner: new PublicKey(c.owner),
    retailer: new PublicKey(c.retailer),
    tokenMint: new PublicKey(c.tokenMint),
    priceAtomic: BigInt(c.priceAtomic),
    intervalSlots: BigInt(c.intervalSlots),
    subscriberCount: BigInt(c.subscriberCount),
    supportsOneshot: c.supportsOneshot,
    supportsVault: c.supportsVault,
    verified: c.verified,
    active: c.active,
    bump: 0, // not persisted — recompute if ever needed
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    slug: c.slug,
    name: c.name,
    iconKey: c.iconKey,
    category: c.category,
    metadataUri: c.metadataUri,
  };
}

async function readCache(): Promise<CacheEnvelope | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const env = JSON.parse(raw) as CacheEnvelope;
    if (!Array.isArray(env.services)) return null;
    return env;
  } catch (err) {
    console.warn('[ServiceRegistry] cache read failed:', (err as Error).message);
    return null;
  }
}

async function writeCache(services: ServiceEntry[]): Promise<void> {
  try {
    const env: CacheEnvelope = {
      fetchedAt: Date.now(),
      services: services.map(serviceToCache),
    };
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(env));
  } catch (err) {
    console.warn('[ServiceRegistry] cache write failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Low-level fetch
// ---------------------------------------------------------------------------

export interface FetchServicesParams {
  /** Only verified services (defaults to `true` for end-user UI). */
  verifiedOnly?: boolean;
  /** Include inactive listings (default `false`). */
  includeInactive?: boolean;
  /** Override commitment level. */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Fetch the service registry directly from the chain (no cache).
 */
export async function fetchServiceRegistry(
  params: FetchServicesParams = {},
): Promise<ServiceEntry[]> {
  const connection = getConnection();
  const verifiedOnly = params.verifiedOnly ?? true;
  const activeOnly = !params.includeInactive;
  console.log(
    `[ServiceRegistry] fetch start verifiedOnly=${verifiedOnly} activeOnly=${activeOnly}`,
  );
  try {
    const results = await sdkFetchAllServices(connection, {
      activeOnly,
      verifiedOnly,
      commitment: params.commitment ?? 'confirmed',
    });
    console.log(
      `[ServiceRegistry] fetch returned ${results.length} service(s): ` +
        results.map(s => s.name).join(', '),
    );
    // sdkFetchAllServices returns the same shape; cast to be explicit at the
    // app boundary (the SDK re-exports its own internal type).
    return results as unknown as ServiceEntry[];
  } catch (err) {
    console.warn('[ServiceRegistry] fetch threw:', (err as Error).message);
    throw err;
  }
}

/**
 * Refresh the on-disk cache. Returns the fresh list.
 */
export async function refreshServiceRegistryCache(
  params: FetchServicesParams = {},
): Promise<ServiceEntry[]> {
  const services = await fetchServiceRegistry(params);
  await writeCache(services);
  return services;
}

/**
 * Read the on-disk cache synchronously via promise. Returns `[]` if empty.
 */
export async function readCachedServices(): Promise<ServiceEntry[]> {
  const env = await readCache();
  if (!env) return [];
  return env.services.map(cacheToService);
}

// ---------------------------------------------------------------------------
// React hook — stale-while-revalidate
// ---------------------------------------------------------------------------

export interface UseServiceRegistryState {
  services: ServiceEntry[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Force a refetch from chain. */
  refresh: () => Promise<void>;
}

export function useServiceRegistry(
  params: FetchServicesParams = {},
): UseServiceRegistryState {
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (force: boolean) => {
    console.log(`[ServiceRegistry] hook.load(force=${force}) verifiedOnly=${params.verifiedOnly}`);
    try {
      setError(null);
      // Always show cached results for instant paint, then refresh from chain.
      // `force=true` skips the cached paint (used for pull-to-refresh).
      if (!force) {
        const cached = await readCachedServices();
        console.log(`[ServiceRegistry] cache had ${cached.length} entries`);
        if (cached.length > 0) {
          setServices(cached);
          setLoading(false);
        }
      }
      setRefreshing(true);
      const fresh = await fetchServiceRegistry(params);
      console.log(`[ServiceRegistry] applying ${fresh.length} services to state`);
      setServices(fresh);
      await writeCache(fresh);
    } catch (err) {
      const msg = (err as Error).message;
      console.warn('[ServiceRegistry] refresh failed:', msg);
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    console.log(
      `[ServiceRegistry] hook mounted verifiedOnly=${params.verifiedOnly} includeInactive=${params.includeInactive}`,
    );
    // First load: force a fresh fetch so the user always sees live on-chain
    // state after an app restart (matches the "dynamic" requirement).
    void load(true);
    const interval = setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.verifiedOnly, params.includeInactive, params.commitment]);

  return {
    services,
    loading,
    refreshing,
    error,
    refresh: () => load(true),
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Convert `intervalSlots` (0.4s per slot) to a human-readable frequency
 * label. Falls back to a "every N days" string for non-standard intervals.
 */
export function formatInterval(intervalSlots: bigint): string {
  const slots = Number(intervalSlots);
  const seconds = slots * 0.4;
  const days = Math.round(seconds / 86_400);

  if (days >= 28 && days <= 31) return 'monthly';
  if (days === 7) return 'weekly';
  if (days === 14) return 'biweekly';
  if (days === 365 || days === 366) return 'yearly';
  if (days === 1) return 'daily';
  if (days >= 1) return `every ${days} days`;
  return `every ${Math.round(seconds / 3600)} h`;
}

/** Format `priceAtomic` for native SOL. Expand when we accept SPLs. */
export function formatPriceSOL(priceAtomic: bigint): string {
  const sol = Number(priceAtomic) / LAMPORTS_PER_SOL;
  return sol < 1 ? sol.toFixed(4).replace(/\.?0+$/, '') : sol.toFixed(2);
}

/** Map on-chain `iconKey` → Ionicons glyph name (best effort). */
export function iconKeyToIonicons(iconKey: string): string {
  const map: Record<string, string> = {
    netflix: 'play-circle',
    spotify: 'musical-notes',
    youtube: 'logo-youtube',
    disney: 'film',
    chatgpt: 'chatbubbles',
    github: 'logo-github',
    figma: 'color-palette',
    notion: 'document-text',
    apple: 'logo-apple',
    amazon: 'logo-amazon',
    hbo: 'tv',
    twitch: 'logo-twitch',
    discord: 'logo-discord',
    default: 'cube-outline',
  };
  return map[iconKey.toLowerCase()] ?? map.default ?? 'cube-outline';
}
