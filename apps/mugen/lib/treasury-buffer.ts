/**
 * Treasury Buffer — Layer 2 routing wallet (MVP)
 *
 * Sits between the on-ramp (MoonPay) payout and the user's final stealth
 * recipient. Instead of the on-ramp sending SOL directly to the stealth
 * address (which burns a chain-visible link between the KYC'd deposit and
 * the recipient), the on-ramp sends to a shared buffer wallet controlled
 * by the Mugen backend. After a randomized delay (20–120s) mixed with
 * other pending routes, the buffer forwards the funds to the final
 * stealth address.
 *
 * This breaks direct timing correlation: an observer sees "buffer received
 * X from MoonPay at t1" and "buffer sent Y to stealthB at t2", but t2-t1
 * varies and the buffer is a pool with many concurrent users.
 *
 * ⚠️ MVP honesty disclaimer:
 *   - Single buffer wallet (not multi-jurisdiction / not rotated).
 *   - Uniform-random delay in a fixed window (not true Poisson-distributed).
 *   - No anonymity-set proof. Only direct timing correlation is broken.
 *   - Production hardening needs: multiple buffer wallets across regions,
 *     Poisson-arrival-based release schedule, proof-of-delivery, and
 *     coin-joined forwarding transactions.
 *
 * State is persisted via `getStorage()` (Upstash Redis in prod, in-memory
 * fallback in dev). On-chain funding transactions remain the source of
 * truth for user funds; the registry is just a scheduler/ledger view.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { loadKeypair } from './keypair-loader';
import { getStorage } from './storage';

// ─── Types ──────────────────────────────────────────────────────────────────

export type RouteStatus = 'pending' | 'funded' | 'paid' | 'failed' | 'expired';

export interface BufferRoutingEntry {
  id: string;
  sourceFrom: 'moonpay' | 'manual';
  fiatAmount: number;
  fiatCurrency: 'EUR' | 'USD';
  destStealthAddress: string;
  expectedSolAmount: number; // lamports
  registeredAt: number; // ms epoch
  scheduledPayoutAt: number; // ms epoch (random 20–120s after register)
  /** Hard deadline after which the cohort gate is bypassed for this route. */
  cohortGateExpiry: number;
  status: RouteStatus;
  fundingTx?: string;
  payoutTx?: string;
  failureReason?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MIN_DELAY_MS = 20_000;
const MAX_DELAY_MS = 120_000;
const ROUTE_EXPIRY_MS = 30 * 60 * 1000; // 30 min — drop unfunded routes
const FUNDING_SCAN_LIMIT = 50;
const LAMPORTS_TOLERANCE_BPS = 100; // 1% — cover tiny fee variations from on-ramp

// k-anonymity floor: a funded route is held until either (a) cohort size of
// concurrent ready routes ≥ MIN_COHORT_SIZE, or (b) the route's individual
// cohortGateExpiry (registeredAt + MAX_COHORT_WAIT_MS) is reached. Both are
// env-overridable so prod can tighten without redeploys.
const MIN_COHORT_SIZE = Math.max(
  1,
  Number.parseInt(process.env.MUGEN_TREASURY_MIN_COHORT ?? '3', 10) || 3,
);
const MAX_COHORT_WAIT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.MUGEN_TREASURY_MAX_COHORT_WAIT_MS ?? '600000', 10) ||
    600_000,
);

// Storage keys
const KEY_ROUTE = (id: string) => `mugen:treasury:route:${id}`;
const KEY_ACTIVE_LIST = 'mugen:treasury:active';
const KEY_CURSOR = 'mugen:treasury:last-scanned-signature';
const KEY_LAST_TICK = 'mugen:treasury:last-tick-at';
const KEY_LAST_PAYOUT = 'mugen:treasury:last-payout-at';

// In-process cache for the buffer keypair (cheap — only loaded once per
// Node instance; persistence is owned by env/fs via loadKeypair()).
let cachedBufferKeypair: Keypair | null = null;

// ─── Env-var-first keypair loading ──────────────────────────────────────────

const BUFFER_KEYPAIR_ENV = 'MUGEN_TREASURY_BUFFER_KEYPAIR_B64';

function defaultBufferKeypairPath(): string {
  // Resolve relative to cwd — matches Vercel's runtime cwd (apps/mugen) and
  // the local dev layout described in apps/mugen/.secrets/.
  return path.resolve(process.cwd(), '.secrets', 'treasury-buffer-keypair.json');
}

function loadBufferKeypair(): Keypair {
  if (cachedBufferKeypair) return cachedBufferKeypair;
  cachedBufferKeypair = loadKeypair(BUFFER_KEYPAIR_ENV, defaultBufferKeypairPath());
  return cachedBufferKeypair;
}

export function getBufferWalletPubkey(): PublicKey {
  return loadBufferKeypair().publicKey;
}

/**
 * Expose the keypair to the background runner (which needs it to sign
 * payouts). Not re-exported via the public API surface of this module to
 * discourage use from request handlers — API routes should never sign
 * arbitrary payouts, only the runner loop does.
 */
export function getBufferKeypairForRunner(): Keypair {
  return loadBufferKeypair();
}

// ─── Route registration ─────────────────────────────────────────────────────

function randomDelayMs(): number {
  // Uniform-random within [MIN_DELAY_MS, MAX_DELAY_MS]. MVP — not Poisson.
  const range = MAX_DELAY_MS - MIN_DELAY_MS;
  return MIN_DELAY_MS + Math.floor(Math.random() * (range + 1));
}

export async function registerPendingRoute(args: {
  sourceFrom: 'moonpay' | 'manual';
  fiatAmount: number;
  fiatCurrency: 'EUR' | 'USD';
  destStealthAddress: string;
  expectedSolAmount: number;
}): Promise<BufferRoutingEntry> {
  // Validate stealth address format upfront so we fail fast before money
  // moves; PublicKey constructor throws on malformed input.
  // eslint-disable-next-line no-new
  new PublicKey(args.destStealthAddress);
  if (!Number.isFinite(args.expectedSolAmount) || args.expectedSolAmount <= 0) {
    throw new Error('expectedSolAmount must be a positive lamport amount');
  }
  if (!Number.isFinite(args.fiatAmount) || args.fiatAmount <= 0) {
    throw new Error('fiatAmount must be positive');
  }
  const now = Date.now();
  const entry: BufferRoutingEntry = {
    id: randomUUID(),
    sourceFrom: args.sourceFrom,
    fiatAmount: args.fiatAmount,
    fiatCurrency: args.fiatCurrency,
    destStealthAddress: args.destStealthAddress,
    expectedSolAmount: Math.floor(args.expectedSolAmount),
    registeredAt: now,
    scheduledPayoutAt: now + randomDelayMs(),
    cohortGateExpiry: now + MAX_COHORT_WAIT_MS,
    status: 'pending',
  };
  const storage = getStorage();
  await storage.set(KEY_ROUTE(entry.id), entry);
  await storage.lpush(KEY_ACTIVE_LIST, entry.id);
  return entry;
}

// ─── Registry queries ───────────────────────────────────────────────────────

async function loadAllActiveRoutes(): Promise<BufferRoutingEntry[]> {
  const storage = getStorage();
  const ids = await storage.lrange<string>(KEY_ACTIVE_LIST, 0, -1);
  if (ids.length === 0) return [];
  const out: BufferRoutingEntry[] = [];
  for (const id of ids) {
    const entry = await storage.get<BufferRoutingEntry>(KEY_ROUTE(id));
    if (entry) out.push(entry);
  }
  return out;
}

export async function listRoutes(filter?: {
  status?: RouteStatus;
  limit?: number;
}): Promise<BufferRoutingEntry[]> {
  const all = await loadAllActiveRoutes();
  const out: BufferRoutingEntry[] = [];
  for (const entry of all) {
    if (filter?.status && entry.status !== filter.status) continue;
    out.push(entry);
    if (filter?.limit !== undefined && out.length >= filter.limit) break;
  }
  return out;
}

export async function getRouteById(
  id: string,
): Promise<BufferRoutingEntry | null> {
  return (await getStorage().get<BufferRoutingEntry>(KEY_ROUTE(id))) ?? null;
}

export interface CohortInfo {
  /** Configured minimum members before any release. */
  minCohortSize: number;
  /** Currently funded + scheduled-time-passed routes (the live cohort). */
  cohortCandidatesCount: number;
  /** True when the next runner pass would release the cohort. */
  cohortReady: boolean;
  /** Per-route deadline after which the gate is bypassed. */
  cohortGateExpiry: number;
  /** Convenience — ms remaining on this route's deadline. */
  cohortWaitMsRemaining: number;
}

/** Compute live cohort context for a single route. */
export async function getCohortInfoForRoute(
  entry: BufferRoutingEntry,
): Promise<CohortInfo> {
  const all = await loadAllActiveRoutes();
  const now = Date.now();
  const candidates = all.filter(
    (e) => e.status === 'funded' && e.scheduledPayoutAt <= now,
  );
  return {
    minCohortSize: MIN_COHORT_SIZE,
    cohortCandidatesCount: candidates.length,
    cohortReady: candidates.length >= MIN_COHORT_SIZE,
    cohortGateExpiry: entry.cohortGateExpiry,
    cohortWaitMsRemaining: Math.max(0, entry.cohortGateExpiry - now),
  };
}

async function saveRoute(entry: BufferRoutingEntry): Promise<void> {
  await getStorage().set(KEY_ROUTE(entry.id), entry);
}

/**
 * Find the most recent pending route for a given destination stealth address.
 * Used by the MoonPay webhook (which carries our externalTransactionId =
 * destStealthAddress) to reconcile incoming funds without a chain scan.
 */
export async function findPendingRouteByStealth(
  destStealthAddress: string,
): Promise<BufferRoutingEntry | null> {
  const all = await loadAllActiveRoutes();
  const matches = all.filter(
    (e) => e.status === 'pending' && e.destStealthAddress === destStealthAddress,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.registeredAt - a.registeredAt);
  return matches[0]!;
}

/**
 * Mark a pending route as funded WITHOUT requiring a chain scan. Called by
 * the MoonPay webhook once MoonPay confirms the on-ramp transaction. The
 * runner will still pay it out via the usual cohort gate.
 */
export async function markRouteFundedFromWebhook(
  id: string,
  fundingTx: string,
): Promise<BufferRoutingEntry | null> {
  const entry = await getRouteById(id);
  if (!entry) return null;
  if (entry.status !== 'pending') return entry;
  entry.status = 'funded';
  entry.fundingTx = fundingTx;
  await saveRoute(entry);
  return entry;
}

// ─── Funding detection ──────────────────────────────────────────────────────

/**
 * Scan the buffer wallet's recent signatures, look at incoming SOL
 * transfers, and mark any matching `pending` route as `funded`.
 *
 * Matching heuristic: the first incoming transfer with amount within
 * ±LAMPORTS_TOLERANCE_BPS of a pending route's `expectedSolAmount` claims
 * that route. This is MVP-simple; production would reconcile against
 * MoonPay webhook `transactionId` metadata.
 */
export async function pollForIncomingFunds(
  connection: Connection,
): Promise<number> {
  const bufferPubkey = getBufferWalletPubkey();
  const pendings = await listRoutes({ status: 'pending' });
  if (pendings.length === 0) return 0;

  const storage = getStorage();
  const lastCursor = await storage.get<string>(KEY_CURSOR);

  const sigs = await connection.getSignaturesForAddress(bufferPubkey, {
    limit: FUNDING_SCAN_LIMIT,
    until: lastCursor ?? undefined,
  });
  if (sigs.length === 0) return 0;
  // Update cursor to the most recent signature we've seen.
  await storage.set(KEY_CURSOR, sigs[0].signature);

  let matched = 0;
  // Oldest-first: process in chronological order.
  for (const sigInfo of sigs.reverse()) {
    if (sigInfo.err) continue;
    const tx = await connection.getTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx || !tx.meta) continue;
    const keys = tx.transaction.message.getAccountKeys
      ? tx.transaction.message.getAccountKeys().staticAccountKeys
      : // Legacy message shape fallback — web3 1.98 supports getAccountKeys
        // but we guard defensively.
        [];
    const bufferIdx = keys.findIndex((k) => k.equals(bufferPubkey));
    if (bufferIdx < 0) continue;
    const pre = tx.meta.preBalances[bufferIdx];
    const post = tx.meta.postBalances[bufferIdx];
    const delta = post - pre;
    if (delta <= 0) continue; // outgoing / no-op
    // Find pending route matching this incoming amount.
    const match = pendings.find((p) => {
      if (p.status !== 'pending') return false;
      const tol = Math.ceil(
        (p.expectedSolAmount * LAMPORTS_TOLERANCE_BPS) / 10_000,
      );
      return Math.abs(delta - p.expectedSolAmount) <= tol;
    });
    if (!match) continue;
    match.status = 'funded';
    match.fundingTx = sigInfo.signature;
    await saveRoute(match);
    matched += 1;
  }
  return matched;
}

// ─── Payout execution ───────────────────────────────────────────────────────

/**
 * Execute payouts for all routes whose status is `funded` AND whose
 * `scheduledPayoutAt` is <= now. Returns the number of successful payouts.
 *
 * Also expires stale `pending` routes that never saw funding.
 */
export async function executeReadyPayouts(
  connection: Connection,
  bufferKeypair: Keypair,
): Promise<number> {
  const now = Date.now();
  let paid = 0;

  const all = await loadAllActiveRoutes();

  // 1. Expire pending routes that aged out without funding.
  for (const entry of all) {
    if (
      entry.status === 'pending' &&
      now - entry.registeredAt > ROUTE_EXPIRY_MS
    ) {
      entry.status = 'expired';
      await saveRoute(entry);
    }
  }

  // 2. k-anonymity cohort gate. A funded route past `scheduledPayoutAt` is
  // a "cohort candidate". We only release candidates if the cohort has at
  // least MIN_COHORT_SIZE members — otherwise a single user paying alone
  // would expose a 1:1 timing link from buffer-in to buffer-out. Each route
  // also carries a `cohortGateExpiry` so a low-traffic period eventually
  // releases stuck routes (better an honest 1-of-1 forward than indefinite
  // hold of user funds).
  const cohortCandidates = all.filter(
    (e) => e.status === 'funded' && e.scheduledPayoutAt <= now,
  );
  const cohortReady = cohortCandidates.length >= MIN_COHORT_SIZE;

  // 3. Payout ready funded routes.
  for (const entry of all) {
    if (entry.status !== 'funded') continue;
    if (entry.scheduledPayoutAt > now) continue;
    // Hold unless cohort gate passes OR this route's wait deadline has passed.
    if (!cohortReady && now < entry.cohortGateExpiry) continue;

    try {
      const dest = new PublicKey(entry.destStealthAddress);
      // Leave a small buffer for the base signature fee (5000 lamports).
      const FEE_LAMPORTS = 5_000;
      const outAmount = Math.max(0, entry.expectedSolAmount - FEE_LAMPORTS);
      if (outAmount <= 0) {
        entry.status = 'failed';
        entry.failureReason = 'expected amount below fee floor';
        await saveRoute(entry);
        continue;
      }
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: bufferKeypair.publicKey,
          toPubkey: dest,
          lamports: outAmount,
        }),
      );
      const sig = await sendAndConfirmTransaction(
        connection,
        tx,
        [bufferKeypair],
        { commitment: 'confirmed' },
      );
      entry.status = 'paid';
      entry.payoutTx = sig;
      await saveRoute(entry);
      await getStorage().set(KEY_LAST_PAYOUT, Date.now());
      paid += 1;
    } catch (err) {
      entry.status = 'failed';
      entry.failureReason = (err as Error).message ?? 'unknown payout error';
      await saveRoute(entry);
    }
  }
  return paid;
}

// ─── Misc helpers ───────────────────────────────────────────────────────────

/** Diagnostic — lamports per SOL re-exported for UI. */
export const LAMPORTS_PER_SOL_CONST = LAMPORTS_PER_SOL;

/**
 * Health snapshot for the buffer wallet + runner. Read by the mobile UI
 * BEFORE the user taps Buy so we can clearly show "buffer offline — direct
 * stealth payout" instead of letting them register a route that will never
 * forward.
 */
export interface TreasuryHealth {
  bufferAddress: string;
  bufferBalanceLamports: number;
  /** Min balance below which forwarding will fail (signature fee + rent). */
  minBalanceLamports: number;
  healthy: boolean;
  reason?: string;
  lastTickAt: number | null;
  lastPayoutAt: number | null;
  /** Active routes broken down by status. */
  queue: Record<RouteStatus, number>;
}

const HEALTH_MIN_BALANCE_LAMPORTS = 10_000_000; // 0.01 SOL — enough for ~2000 fwds
const HEALTH_TICK_STALE_MS = 5 * 60 * 1000; // tick should run every 60s by cron

export async function getTreasuryHealth(
  connection: Connection,
): Promise<TreasuryHealth> {
  const storage = getStorage();
  const bufferPubkey = getBufferWalletPubkey();
  const [balance, lastTickAt, lastPayoutAt, all] = await Promise.all([
    connection.getBalance(bufferPubkey, 'confirmed'),
    storage.get<number>(KEY_LAST_TICK),
    storage.get<number>(KEY_LAST_PAYOUT),
    loadAllActiveRoutes(),
  ]);
  const queue: Record<RouteStatus, number> = {
    pending: 0,
    funded: 0,
    paid: 0,
    failed: 0,
    expired: 0,
  };
  for (const e of all) queue[e.status] = (queue[e.status] ?? 0) + 1;

  const reasons: string[] = [];
  if (balance < HEALTH_MIN_BALANCE_LAMPORTS) {
    reasons.push(
      `buffer balance ${balance} lamports < ${HEALTH_MIN_BALANCE_LAMPORTS}`,
    );
  }
  if (lastTickAt && Date.now() - lastTickAt > HEALTH_TICK_STALE_MS) {
    const ageSecs = Math.round((Date.now() - lastTickAt) / 1000);
    reasons.push(`runner last tick ${ageSecs}s ago (stale > 5m)`);
  }
  if (!lastTickAt) {
    reasons.push('runner has not ticked yet');
  }
  return {
    bufferAddress: bufferPubkey.toBase58(),
    bufferBalanceLamports: balance,
    minBalanceLamports: HEALTH_MIN_BALANCE_LAMPORTS,
    healthy: reasons.length === 0,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    lastTickAt: lastTickAt ?? null,
    lastPayoutAt: lastPayoutAt ?? null,
    queue,
  };
}

/** Called by the runner each tick so /api/treasury/health can report freshness. */
export async function recordRunnerTick(): Promise<void> {
  await getStorage().set(KEY_LAST_TICK, Date.now());
}

/**
 * Test/debug helper — clears the active list and cursor. Does NOT delete
 * individual route records (they eventually expire via TTL if set at the
 * storage layer, or can be manually deleted). Does not touch keypair files.
 */
export async function clearRegistry(): Promise<void> {
  const storage = getStorage();
  const ids = await storage.lrange<string>(KEY_ACTIVE_LIST, 0, -1);
  for (const id of ids) {
    await storage.del(KEY_ROUTE(id));
  }
  await storage.del(KEY_ACTIVE_LIST);
  await storage.del(KEY_CURSOR);
}
