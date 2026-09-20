/**
 * The pool's spent-nullifier set: ONE question per pool, identical for every
 * user, with membership decided on this device.
 *
 * 🚨 THIS EXISTS TO CLOSE A DEANONYMISATION CHANNEL. Read before replacing any
 * of it with a per-note lookup, which is what it replaced.
 *
 * A note's nullifier is secret until the spend publishes it, and its PDA does
 * not exist until then either. The store used to ask the RPC about those
 * addresses BEFORE they existed: `findSafeShieldCounter` read two PDAs per
 * candidate counter (up to 1,024 pairs) before any money moved,
 * `refreshNoteStatuses` read two per held note on every screen mount, and three
 * spend pre-flights each read the one the spend was about to create. The
 * provider gets a list of addresses from this phone's IP; days later one of
 * them appears on chain, and it joins the two. That needs no relayer and
 * survives an honest one.
 *
 * What is asked instead: "which nullifier records exist for this pool". The
 * answer is the same for every caller and says nothing about who asked. The
 * pool key is a memcmp filter, so the response is bounded by the pool's spent
 * count (64 records on the 1 SOL pool, probes/logs/01-sizing.log), and
 * `dataSlice: 0` asks for no bodies — the addresses ARE the answer.
 *
 * Pinned by `spentSet.test.ts` (the rules below) and by
 * `storeNullifierReads.test.ts` (that the five call sites use them).
 *
 * NO CACHE, on purpose. Two of the callers are spend pre-flights, and a cached
 * set would answer them from a state older than the spend they guard. One
 * request per call is the honest version; the extension's twin caches for its
 * mount-only flow (EXT-RPC).
 *
 * WHAT THIS DOES NOT CLOSE: the provider still sees that this IP asked about
 * this pool, and still sees the spend when it lands. What it no longer sees is
 * an address that only this wallet could have named before the fact.
 */
import { PublicKey, type Connection } from '@solana/web3.js';

import {
  ZK_SHIELDED_PROGRAM_ID,
  bigintToLeBytes32,
  createNullifier,
  deriveNoteMaterial,
  deriveNullifierPDA,
} from '../denominatedPool';
import {
  computeGoldilocksPoolNullifier,
  goldilocksNullifierToBytes,
} from '../zk/goldilocks-poseidon';

/**
 * `NullifierRecord` — 8 byte discriminator + 32 byte pool + 1 byte bump, with
 * the pool at offset 8 (`programs/zk_shielded/src/state/nullifier_set.rs`).
 * The record does NOT hold the nullifier: that value lives only in the PDA
 * seeds, which is why the set can be fetched without naming a single note.
 */
export const NULLIFIER_RECORD_LEN = 41;
export const NULLIFIER_RECORD_POOL_OFFSET = 8;

/** Base58 PDA addresses. Pair it with the membership helpers below. */
export type SpentSet = ReadonlySet<string>;

/**
 * The two PDAs a note would write, one per spend path. They differ because the
 * hash does: Groth16 unshield / transfer writes Poseidon(np, secret) over
 * BN254; STARK unshield / subscribe writes Goldilocks Poseidon(np, secret) as
 * 8 bytes LE plus a zero tail. Checking only one left STARK-spent notes marked
 * 'mature' until a 60 s proof died on `already in use`.
 */
export function nullifierPDAsForNote(
  poolPDA: PublicKey,
  nullifierPreimage: bigint,
  secret: bigint,
): { g16: string; stark: string } {
  const g16Null = createNullifier(nullifierPreimage, secret);
  const [g16] = deriveNullifierPDA(poolPDA, bigintToLeBytes32(g16Null));
  const starkNull = computeGoldilocksPoolNullifier(nullifierPreimage, secret);
  const [stark] = deriveNullifierPDA(poolPDA, goldilocksNullifierToBytes(starkNull));
  return { g16: g16.toBase58(), stark: stark.toBase58() };
}

/** Is this note spent, through either path? Local, no RPC. */
export function isNoteSpentInSet(
  spentSet: SpentSet,
  poolPDA: PublicKey,
  nullifierPreimage: bigint,
  secret: bigint,
): boolean {
  const { g16, stark } = nullifierPDAsForNote(poolPDA, nullifierPreimage, secret);
  return spentSet.has(g16) || spentSet.has(stark);
}

/**
 * The pre-flight form. The three spend actions hold the value the transaction
 * is about to publish — the circuit-7 proof's first public input, which IS the
 * Goldilocks nullifier — rather than the receipt, so they ask with that.
 */
export function isGoldilocksNullifierSpentInSet(
  spentSet: SpentSet,
  poolPDA: PublicKey,
  nullifierGoldilocks: bigint,
): boolean {
  const [pda] = deriveNullifierPDA(poolPDA, goldilocksNullifierToBytes(nullifierGoldilocks));
  return spentSet.has(pda.toBase58());
}

/**
 * Every spent nullifier in one pool, as PDA addresses.
 *
 * ⛔ THROWS on a failed read, and never answers with an empty set. The counter
 * search below turns "nothing is spent" into "counter 0 is free", and a re-used
 * counter produces a note with a fresh commitment and a colliding nullifier
 * that no withdrawal can ever spend. `spentSet.test.ts` carries both the
 * fail-closed case and the fail-open control that shows what it costs.
 */
export async function fetchPoolSpentSet(
  connection: Connection,
  poolPDA: PublicKey,
): Promise<Set<string>> {
  const accounts = await connection.getProgramAccounts(ZK_SHIELDED_PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { dataSize: NULLIFIER_RECORD_LEN },
      { memcmp: { offset: NULLIFIER_RECORD_POOL_OFFSET, bytes: poolPDA.toBase58() } },
    ],
  });
  return new Set(accounts.map((a) => a.pubkey.toBase58()));
}

/**
 * The counter rule, unchanged: walk forward from `startCounter` and return the
 * first candidate whose two PDAs are BOTH absent. What changed is where the
 * answer comes from — the set above, read once, instead of one RPC round trip
 * per candidate.
 *
 * Pure: it performs no read, so it cannot leak one. Throws when the window is
 * exhausted rather than hand back a colliding counter.
 */
export function firstUnspentCounter(
  spentSet: SpentSet,
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  startCounter: number,
  maxAttempts = 1024,
): number {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = startCounter + i;
    const { secret, nullifierPreimage } = deriveNoteMaterial(walletSeed, poolPDA, candidate);
    if (!isNoteSpentInSet(spentSet, poolPDA, nullifierPreimage, secret)) return candidate;
  }
  throw new Error(
    `No free counter found after ${maxAttempts} attempts starting from ${startCounter} ` +
      `on pool ${poolPDA.toBase58()}`,
  );
}

/*
 * WHAT THE STORE CALLS. The three functions below are the whole composition
 * the store needs: read the set, apply the rule, hand the answer back. They
 * live here, not in the store, because a composition in store text could not
 * be executed by a test — a store that swallowed the read or ignored the
 * verdict stayed green (wp-logs/verify/MOB-RPC-r1-mutants.log). Measured in
 * `spentSet.test.ts` ("what the store delegates to"); that the store calls them
 * and uses the result is pinned by `storeNullifierReads.test.ts`.
 */

/**
 * The shield's counter guard: one pool-wide read, then the pure walk.
 *
 * ⛔ NO try/catch, on purpose. A failed read must reach the shield as a throw:
 * "nothing spent" would make counter 0 look free, and a re-used counter gives a
 * note whose nullifier is already on chain — funds that no withdrawal can ever
 * move. The fail-closed case and its fail-open control are in spentSet.test.ts.
 */
export async function findFirstUnspentCounter(
  connection: Connection,
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  startCounter: number,
  maxAttempts = 1024,
): Promise<number> {
  const spent = await fetchPoolSpentSet(connection, poolPDA);
  return firstUnspentCounter(spent, walletSeed, poolPDA, startCounter, maxAttempts);
}

/** One held note, as the refresh sees it: its id, its pool and its receipt secrets. */
export interface SpentCandidate {
  id: string;
  poolPDA: PublicKey;
  nullifierPreimage: bigint;
  secret: bigint;
}

/**
 * Which of these notes are spent, through either path. Local, no RPC.
 *
 * Throws when a note's pool has no set: "never read" must not read as
 * "unspent", or a spent note would show as spendable.
 */
export function spentNoteIds(
  candidates: readonly SpentCandidate[],
  setsByPool: ReadonlyMap<string, SpentSet>,
): Set<string> {
  const ids = new Set<string>();
  for (const c of candidates) {
    const set = setsByPool.get(c.poolPDA.toBase58());
    if (!set) throw new Error('spent set missing for a held note pool');
    if (isNoteSpentInSet(set, c.poolPDA, c.nullifierPreimage, c.secret)) ids.add(c.id);
  }
  return ids;
}

/**
 * The note-status refresh: one read per distinct pool, in parallel, then
 * `spentNoteIds`. A rejected read throws, and the refresh leaves every status
 * as it was.
 */
export async function fetchSpentNoteIds(
  connection: Connection,
  candidates: readonly SpentCandidate[],
): Promise<Set<string>> {
  const pools = new Map<string, PublicKey>();
  for (const c of candidates) pools.set(c.poolPDA.toBase58(), c.poolPDA);
  const keys = [...pools.keys()];
  const sets = await Promise.all(keys.map((k) => fetchPoolSpentSet(connection, pools.get(k)!)));
  return spentNoteIds(candidates, new Map(keys.map((k, i) => [k, sets[i]])));
}

/**
 * The spend pre-flight: is the Goldilocks nullifier this spend is about to
 * publish already in the pool's set. Throws on a failed read; the pre-flights
 * treat that as a network glitch and let the on-chain `init` guard decide.
 */
export async function isNullifierSpentPoolWide(
  connection: Connection,
  poolPDA: PublicKey,
  nullifierGoldilocks: bigint,
): Promise<boolean> {
  const spent = await fetchPoolSpentSet(connection, poolPDA);
  return isGoldilocksNullifierSpentInSet(spent, poolPDA, nullifierGoldilocks);
}
