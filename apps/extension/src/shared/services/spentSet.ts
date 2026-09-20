/**
 * THE POOL'S SPENT SET, ASKED POOL-WIDE — never one note's nullifier PDA.
 *
 * ⛔ READ THIS BEFORE REPLACING IT WITH A PER-NOTE LOOKUP, which is what it
 * replaced on this surface (2026-09-16).
 *
 * A note's nullifier is secret until the spend publishes it. The previous code
 * asked the RPC about ONE note at a time: `CreateSubscription.tsx` batched a
 * `getMultipleAccountsInfo` over every stored note's nullifier PDA on mount,
 * and `store/denominatedPool.ts` asked `getAccountInfo` for one PDA seconds
 * before a withdrawal. Both handed the provider addresses that DO NOT EXIST
 * YET. Days later one of them is created by a spend, and the provider joins on
 * the PDA to recover the device that pre-queried it. On the relayed route the
 * spend arrives from another IP, so that join is the only thing tying the two
 * together — and it was being handed over for free.
 *
 * This asks a different question: "which nullifier records exist for this
 * pool". The answer is identical for every caller and says nothing about who
 * is asking. Membership is then decided on the device, with no further
 * request.
 *
 * WHAT IS PINNED, AND WHERE (LEAK-LEDGER rule G3 — a privacy comment names its
 * test): `services/spentSet.test.ts` measures that one `getProgramAccounts`
 * goes out per pool, that no request argument names a note in any spelling,
 * that a failure is raised rather than answered with an empty set, and that
 * the cache key cannot carry the RPC key. `popup/pages/CreateSubscription.test.tsx`
 * measures the same two properties on the subscribe screen's mount, and
 * `spentSet.test.ts` section 5 on `subscriptionVault.ts::subscribePrivate`.
 *
 * Twin of `apps/web/lib/privacy/pool/denominatedPool.ts::fetchSpentNullifierSet`
 * (the same pool-wide read).
 */

import type { Connection, PublicKey } from '@solana/web3.js';

import {
  ZK_SHIELDED_PROGRAM_ID,
  createNullifierV3,
  deriveNullifierPDA,
  goldilocksU64To32,
} from './denominatedPool';

/**
 * `NullifierRecord` is 8 + 32 + 1 bytes and its first field after the Anchor
 * discriminator is the pool it belongs to
 * (`programs/zk_shielded/src/state/nullifier_set.rs:146-156`). Those two facts
 * are what let the whole set be fetched without naming a single note: the
 * filter is the POOL, and the account body holds nothing else worth reading.
 */
export const NULLIFIER_RECORD_LEN = 41;
export const NULLIFIER_RECORD_POOL_OFFSET = 8;

/** How long one pool-wide answer is reused. */
export const SPENT_SET_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  set: Set<string>;
}

const cache = new Map<string, CacheEntry>();
/** Reads already on the wire, so two callers for one pool make one request. */
const inFlight = new Map<string, Promise<Set<string>>>();

/**
 * The cache key: the endpoint's HOST and the pool. Never the endpoint itself.
 *
 * 🚨 THE URL CARRIES THE HELIUS API KEY in its query string
 * (`packages/rpc-config/src/endpoints.ts:58-60`), so keying on it would write
 * that key into every cache entry — the mistake HIST-1 is removing from the
 * web history cache. The host is still needed: a pool PDA is derived from mint
 * and denomination, so the same address exists on devnet and mainnet, and one
 * cluster's spent set must never answer the other's question. Both halves are
 * pinned in `spentSet.test.ts` ("the 30 s cache").
 */
function cacheKey(connection: Connection, poolPDA: PublicKey): string {
  let host = '';
  try {
    host = new URL(connection.rpcEndpoint).host;
  } catch {
    host = '';
  }
  return `${host}|${poolPDA.toBase58()}`;
}

/**
 * Every spent nullifier in one pool, as a set of PDA addresses.
 *
 * ⛔ IT THROWS. A caller that cannot learn the spent set must refuse, never
 * carry on as though nothing were spent: the empty set reads as "all your
 * notes are live", which is exactly the answer that burns a ~2-minute proof on
 * a dead note, or spends a counter twice. A failure is not cached either, so
 * one bad response does not strand the wallet for the whole window.
 */
export async function fetchSpentNullifierSet(
  connection: Connection,
  poolPDA: PublicKey,
): Promise<Set<string>> {
  const key = cacheKey(connection, poolPDA);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < SPENT_SET_TTL_MS) return hit.set;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    const accounts = await connection.getProgramAccounts(ZK_SHIELDED_PROGRAM_ID, {
      // `dataSlice: 0` — the addresses are the answer. The body is only the
      // pool key we already filtered on, plus a bump.
      dataSlice: { offset: 0, length: 0 },
      filters: [
        { dataSize: NULLIFIER_RECORD_LEN },
        { memcmp: { offset: NULLIFIER_RECORD_POOL_OFFSET, bytes: poolPDA.toBase58() } },
      ],
    });
    return new Set(accounts.map((a) => a.pubkey.toBase58()));
  })();

  inFlight.set(key, request);
  try {
    const set = await request;
    cache.set(key, { at: Date.now(), set });
    return set;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Is this note's nullifier in the set? Decided on the device — no request.
 *
 * The nullifier is recomputed locally with `createNullifierV3`, exactly as the
 * spend would, so the comparison needs nothing from the network beyond the
 * pool-wide answer already in hand.
 */
export function isNullifierSpentInSet(
  spent: ReadonlySet<string>,
  poolPDA: PublicKey,
  nullifierPreimage: bigint,
  secret: bigint,
): boolean {
  const nullifier = createNullifierV3(nullifierPreimage, secret);
  const [nullifierPDA] = deriveNullifierPDA(poolPDA, goldilocksU64To32(nullifier));
  return spent.has(nullifierPDA.toBase58());
}

/** Drop every cached answer. For tests, and for a caller that must re-read. */
export function clearSpentNullifierSetCache(): void {
  cache.clear();
  inFlight.clear();
}
