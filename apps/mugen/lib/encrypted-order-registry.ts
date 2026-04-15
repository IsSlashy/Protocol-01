/**
 * Persistent registry of encrypted P2P offers, backed by {@link getStorage}.
 *
 * MVP: server-side registry of encrypted orders backed by Redis (Upstash /
 * Vercel KV) in production, with an in-memory fallback for local dev.
 * Production path = parse the Arcium MPC callback output to extract the
 * matched maker's nonce directly from chain, no server state needed.
 * Blocked on arcium-anchor 0.9.2 callback output wrapper ABI.
 *
 * Honesty disclaimer: this registry briefly holds plaintext terms on the
 * Next.js server between submit and claim-match. The on-chain program
 * NEVER sees plaintext (that guarantee is preserved via Arcium MPC); the
 * server-side registry only exists so the taker can discover which maker
 * to pair with for the follow-up escrow.
 *
 * Key scheme:
 *   mugen:order:{makerNoncePubkey} → EncryptedOrderEntry (TTL = expiresAtUnix)
 *   mugen:orders:active            → Redis list of active makerNoncePubkey
 *
 * The active list may accumulate stale IDs after natural TTL expiry; readers
 * tolerate that by filtering out IDs that resolve to null on fetch. `cancel`
 * attempts a best-effort removal from the list but does not fail on mismatch.
 */
import { getStorage } from './storage';

export type OrderType = 'sell' | 'buy';
export type FiatCurrency = 'EUR' | 'USD';

export interface EncryptedOrderEntry {
  makerNoncePubkey: string;
  makerWallet: string | null;
  orderType: OrderType;
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethods: number;
  expiresAtUnix: number;
  computationOffset: string;
  mpcTxSignature: string;
  registeredAt: number;
}

export interface FindMatchQuery {
  desiredCryptoAmountLamports: number;
  maxFiatAmountCents: number;
  fiatCurrency: FiatCurrency;
  paymentMethodsMask: number;
}

const KEY_ORDER = (nonce: string) => `mugen:order:${nonce}`;
const KEY_ACTIVE_LIST = 'mugen:orders:active';

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** Store a new encrypted order in the registry. Throws on duplicate nonce. */
export async function registerEncryptedOrder(
  entry: EncryptedOrderEntry,
): Promise<void> {
  const storage = getStorage();
  const key = KEY_ORDER(entry.makerNoncePubkey);

  const existing = await storage.get<EncryptedOrderEntry>(key);
  if (existing) {
    throw new Error(
      `Duplicate maker nonce in registry: ${entry.makerNoncePubkey}`,
    );
  }

  const ttlSeconds = Math.max(1, entry.expiresAtUnix - nowUnix());
  await storage.set(key, entry, { ttlSeconds });
  await storage.lpush(KEY_ACTIVE_LIST, entry.makerNoncePubkey);
}

/**
 * Purge expired entries from the in-memory view.
 *
 * Upstash handles TTL-based key expiry natively, so only the active list
 * needs occasional pruning to avoid unbounded growth. Readers already tolerate
 * stale IDs (they resolve to null and are filtered out).
 */
export async function purgeExpired(): Promise<void> {
  const storage = getStorage();
  const ids = await storage.lrange<string>(KEY_ACTIVE_LIST, 0, -1);
  if (ids.length === 0) return;

  const keep: string[] = [];
  for (const id of ids) {
    const entry = await storage.get<EncryptedOrderEntry>(KEY_ORDER(id));
    if (entry && entry.expiresAtUnix > nowUnix()) {
      keep.push(id);
    }
  }

  if (keep.length === ids.length) return;

  // Rewrite the list: delete + lpush in reverse (lpush prepends).
  await storage.del(KEY_ACTIVE_LIST);
  for (let i = keep.length - 1; i >= 0; i--) {
    await storage.lpush(KEY_ACTIVE_LIST, keep[i]);
  }
}

/**
 * Find the first compatible sell offer for a taker query (FIFO).
 *
 * Compatibility:
 *   - entry.orderType === 'sell' (makers sell crypto for fiat, takers buy)
 *   - entry.cryptoAmountLamports >= query.desiredCryptoAmountLamports
 *   - entry.fiatAmountCents       <= query.maxFiatAmountCents
 *   - entry.fiatCurrency          === query.fiatCurrency
 *   - (entry.paymentMethods & query.paymentMethodsMask) > 0
 *   - entry.expiresAtUnix         > now()
 */
export async function findMatch(
  query: FindMatchQuery,
): Promise<EncryptedOrderEntry | null> {
  const storage = getStorage();
  const ids = await storage.lrange<string>(KEY_ACTIVE_LIST, 0, -1);
  if (ids.length === 0) return null;

  // Iterate in registration order (FIFO). lpush-prepended list → reverse.
  const now = nowUnix();
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i];
    const entry = await storage.get<EncryptedOrderEntry>(KEY_ORDER(id));
    if (!entry) continue; // stale ID — TTL expired
    if (entry.expiresAtUnix <= now) continue;
    if (entry.orderType !== 'sell') continue;
    if (entry.cryptoAmountLamports < query.desiredCryptoAmountLamports) continue;
    if (entry.fiatAmountCents > query.maxFiatAmountCents) continue;
    if (entry.fiatCurrency !== query.fiatCurrency) continue;
    if ((entry.paymentMethods & query.paymentMethodsMask) === 0) continue;
    return entry;
  }
  return null;
}

/** Look up a specific entry by maker nonce pubkey. */
export async function getByMakerNonce(
  makerNoncePubkey: string,
): Promise<EncryptedOrderEntry | null> {
  const storage = getStorage();
  const entry = await storage.get<EncryptedOrderEntry>(KEY_ORDER(makerNoncePubkey));
  if (!entry) return null;
  if (entry.expiresAtUnix <= nowUnix()) {
    // Lazily drop expired (belt-and-suspenders; TTL should have caught it)
    await storage.del(KEY_ORDER(makerNoncePubkey));
    return null;
  }
  return entry;
}

/** Remove a registered entry (e.g., after a successful claim). */
export async function removeByMakerNonce(
  makerNoncePubkey: string,
): Promise<boolean> {
  const storage = getStorage();
  const key = KEY_ORDER(makerNoncePubkey);
  const existing = await storage.get<EncryptedOrderEntry>(key);
  if (!existing) return false;
  await storage.del(key);
  // Stale ID in the active list is fine — future readers filter null.
  return true;
}

/** Admin/debug: list all active entries. */
export async function listActive(): Promise<EncryptedOrderEntry[]> {
  const storage = getStorage();
  const ids = await storage.lrange<string>(KEY_ACTIVE_LIST, 0, -1);
  if (ids.length === 0) return [];
  const now = nowUnix();
  const out: EncryptedOrderEntry[] = [];
  // Iterate FIFO (reverse because lpush prepends).
  for (let i = ids.length - 1; i >= 0; i--) {
    const entry = await storage.get<EncryptedOrderEntry>(KEY_ORDER(ids[i]));
    if (entry && entry.expiresAtUnix > now) out.push(entry);
  }
  return out;
}

/** Testing/debug helper — wipes the registry. */
export async function clearRegistry(): Promise<void> {
  const storage = getStorage();
  const ids = await storage.lrange<string>(KEY_ACTIVE_LIST, 0, -1);
  for (const id of ids) {
    await storage.del(KEY_ORDER(id));
  }
  await storage.del(KEY_ACTIVE_LIST);
}
