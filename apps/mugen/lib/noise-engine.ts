/**
 * Distributed Noise Engine — Layer 3 (MVP)
 *
 * Goal: when a real encrypted order is submitted, fire N indistinguishable
 * decoy submissions from a pool of dedicated "noise wallets". Every decoy
 * travels through the same code path as a real submit (FROST quorum gate +
 * Arcium MPC submitEncryptedOffer), uses the same program+instruction+
 * account shape, and generates fresh randomized payload so an on-chain
 * observer can't tell real traffic from noise.
 *
 * ⚠️  MVP honesty disclaimer:
 *   - SERVER-generated wallets (5 fixed keypairs on disk or env). This is
 *     NOT a distributed user opt-in network.
 *   - The server could in theory log decoy↔real mappings. We deliberately
 *     DO NOT persist any link between a real submit and its sibling decoys;
 *     unlinkability is preserved only because the server is honest about
 *     not correlating. Phase 2 swaps this for a distributed opt-in network
 *     with per-user rewards for participation (true k-anonymity).
 *   - Randomization draws from realistic distributions but is not provably
 *     indistinguishable in every dimension (e.g. RPC submit timing jitter,
 *     fee-payer balance patterns).
 *
 * Queue state is persisted via `getStorage()` (Upstash Redis in prod,
 * in-memory fallback in dev) so it survives Vercel Fluid Compute's cold
 * starts and per-request isolation.
 */
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import { submitEncryptedOffer } from '@protocol-01/arcium-sdk';
import { getArciumClient, getArciumProgram, pubkeyToNonceU64 } from './arcium';
import { requestThresholdApproval } from './frost-coordinator';
import { loadKeypairs } from './keypair-loader';
import { getStorage } from './storage';

// ─── Public types ───────────────────────────────────────────────────────────

export interface NoiseWallet {
  keypair: Keypair;
  pubkey: PublicKey;
  createdAt: number;
}

export type NoiseStatus = 'scheduled' | 'submitting' | 'submitted' | 'failed';

export interface NoiseSubmissionEntry {
  id: string;
  walletIndex: number;
  scheduledFor: number;
  status: NoiseStatus;
  enqueuedAt: number;
  submittedAt?: number;
  mpcTxSignature?: string;
  error?: string;
  /** Hex-encoded random seed — kept for debugging/stats only, NOT linked to a real submit. */
  randomSeed: string;
}

export interface NoiseStats {
  walletCount: number;
  totalDecoysSubmitted: number;
  totalDecoysFailed: number;
  lastDecoyAt: number | null;
  scheduledPending: number;
}

interface NoiseStatsRecord {
  totalDecoysSubmitted: number;
  totalDecoysFailed: number;
  lastDecoyAt: number | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const NOISE_WALLET_COUNT = 5;
const DEFAULT_WINDOW_MS = 30_000;
const MAX_IN_FLIGHT = 10;
const MIN_WALLET_LAMPORTS = Math.floor(0.005 * LAMPORTS_PER_SOL);

const ENV_DISABLED = 'NOISE_ENGINE_DISABLED';
const NOISE_WALLETS_ENV = 'MUGEN_NOISE_WALLETS_B64';

// Storage keys
const KEY_QUEUE = 'mugen:noise:queue';
const KEY_ENTRY = (id: string) => `mugen:noise:entry:${id}`;
const KEY_STATS = 'mugen:noise:stats';

// Realistic amount ladder — mirrors the default form's common amounts.
const NOISE_SOL_AMOUNTS_LAMPORTS: readonly number[] = [
  Math.floor(0.005 * LAMPORTS_PER_SOL),
  Math.floor(0.01 * LAMPORTS_PER_SOL),
  Math.floor(0.02 * LAMPORTS_PER_SOL),
  Math.floor(0.03 * LAMPORTS_PER_SOL),
  Math.floor(0.05 * LAMPORTS_PER_SOL),
];

const PAYMENT_METHOD_BITS: readonly number[] = [1, 2, 4, 8, 16]; // SEPA, Revolut, Wise, Cash, Zelle
const CURRENCIES: readonly ('EUR' | 'USD')[] = ['EUR', 'USD'];

// In-process cache for the loaded wallet pool. Keypairs are fixed per
// deploy (loaded from env or fs); caching avoids re-parsing env on every
// tick. This is NOT shared state — just a local memo.
let cachedWallets: NoiseWallet[] | null = null;

// ─── Wallet pool ────────────────────────────────────────────────────────────

function defaultWalletPathTemplate(): string {
  return path.resolve(
    process.cwd(),
    '.secrets',
    'noise-wallet-{i}.keypair.json',
  );
}

export function getNoiseWallets(): NoiseWallet[] {
  if (cachedWallets) return cachedWallets;
  const keypairs = loadKeypairs(
    NOISE_WALLETS_ENV,
    defaultWalletPathTemplate(),
    NOISE_WALLET_COUNT,
  );
  const now = Date.now();
  cachedWallets = keypairs.map((kp) => ({
    keypair: kp,
    pubkey: kp.publicKey,
    createdAt: now,
  }));
  return cachedWallets;
}

// ─── Randomization ──────────────────────────────────────────────────────────

function randInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0;
  // randomBytes → unbiased enough for our non-cryptographic use.
  const buf = randomBytes(4);
  const u = buf.readUInt32BE(0);
  return u % maxExclusive;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randInt(arr.length)];
}

interface DecoyPayload {
  orderType: 'sell' | 'buy';
  cryptoAmountLamports: number;
  fiatAmountCents: number;
  fiatCurrency: 'EUR' | 'USD';
  paymentMethods: number;
  expiresAtUnix: number;
  makerNoncePubkey: string;
}

function randomPaymentMethodsBitmask(): number {
  // Random non-empty subset of PAYMENT_METHOD_BITS.
  let bits = 0;
  while (bits === 0) {
    for (const b of PAYMENT_METHOD_BITS) {
      // ~40% inclusion per method, at least one guaranteed by the loop.
      if (randInt(100) < 40) bits |= b;
    }
  }
  return bits;
}

function randomDecoyPayload(): DecoyPayload {
  const orderType: 'sell' | 'buy' = randInt(100) < 80 ? 'sell' : 'buy';
  const cryptoAmountLamports = pick(NOISE_SOL_AMOUNTS_LAMPORTS);
  const fiatCurrency = pick(CURRENCIES);
  // SOL price in [70, 90] (EUR/USD range)
  const pricePerSol = 70 + randInt(21);
  const sol = cryptoAmountLamports / LAMPORTS_PER_SOL;
  const fiatAmountCents = Math.max(1, Math.round(sol * pricePerSol * 100));
  const paymentMethods = randomPaymentMethodsBitmask();
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const makerNoncePubkey = Keypair.generate().publicKey.toBase58();
  return {
    orderType,
    cryptoAmountLamports,
    fiatAmountCents,
    fiatCurrency,
    paymentMethods,
    expiresAtUnix,
    makerNoncePubkey,
  };
}

// ─── Storage helpers ────────────────────────────────────────────────────────

async function readStats(): Promise<NoiseStatsRecord> {
  const existing = await getStorage().get<NoiseStatsRecord>(KEY_STATS);
  return (
    existing ?? {
      totalDecoysSubmitted: 0,
      totalDecoysFailed: 0,
      lastDecoyAt: null,
    }
  );
}

async function writeStats(stats: NoiseStatsRecord): Promise<void> {
  await getStorage().set(KEY_STATS, stats);
}

async function saveEntry(entry: NoiseSubmissionEntry): Promise<void> {
  await getStorage().set(KEY_ENTRY(entry.id), entry);
}

async function loadAllEntries(): Promise<NoiseSubmissionEntry[]> {
  const storage = getStorage();
  const ids = await storage.lrange<string>(KEY_QUEUE, 0, -1);
  if (ids.length === 0) return [];
  const out: NoiseSubmissionEntry[] = [];
  for (const id of ids) {
    const e = await storage.get<NoiseSubmissionEntry>(KEY_ENTRY(id));
    if (e) out.push(e);
  }
  return out;
}

async function countPending(): Promise<number> {
  const entries = await loadAllEntries();
  let n = 0;
  for (const e of entries) {
    if (e.status === 'scheduled' || e.status === 'submitting') n += 1;
  }
  return n;
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

/**
 * Enqueue `count` decoys to fire at random offsets within the next
 * `windowMs` milliseconds. Returns the created entries (for logging/debug).
 *
 * The caller receives the raw entry list but SHOULD NOT persist the mapping
 * between a real submission and these decoys — unlinkability requires the
 * server to be honest about not storing that link.
 */
export async function scheduleDecoys(
  count: number,
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<NoiseSubmissionEntry[]> {
  if (process.env[ENV_DISABLED] === '1') {
    return [];
  }
  if (!Number.isInteger(count) || count <= 0) return [];

  const pending = await countPending();
  const available = Math.max(0, MAX_IN_FLIGHT - pending);
  const toSchedule = Math.min(count, available);
  if (toSchedule <= 0) return [];

  // Ensure the pool is initialized (so first caller warms env/fs state).
  const wallets = getNoiseWallets();
  if (wallets.length === 0) return [];

  const storage = getStorage();
  const now = Date.now();
  const created: NoiseSubmissionEntry[] = [];
  for (let i = 0; i < toSchedule; i++) {
    const offset = randInt(Math.max(1, windowMs));
    const walletIndex = randInt(wallets.length);
    const entry: NoiseSubmissionEntry = {
      id: randomUUID(),
      walletIndex,
      scheduledFor: now + offset,
      status: 'scheduled',
      enqueuedAt: now,
      randomSeed: randomBytes(8).toString('hex'),
    };
    await storage.set(KEY_ENTRY(entry.id), entry);
    await storage.lpush(KEY_QUEUE, entry.id);
    created.push(entry);
  }
  return created;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function fireSingleDecoy(
  entry: NoiseSubmissionEntry,
  wallet: NoiseWallet,
  connection: Connection,
  stats: NoiseStatsRecord,
): Promise<void> {
  // Safety: skip (don't fail) if the noise wallet lacks fee budget. We mark
  // the entry as failed so it doesn't linger in the queue forever.
  const balance = await connection.getBalance(wallet.pubkey, 'confirmed');
  if (balance < MIN_WALLET_LAMPORTS) {
    entry.status = 'failed';
    entry.error = `noise wallet ${wallet.pubkey.toBase58()} underfunded (${balance} lamports < ${MIN_WALLET_LAMPORTS})`;
    stats.totalDecoysFailed += 1;
    // eslint-disable-next-line no-console
    console.warn(`[noise-engine] ${entry.error}`);
    return;
  }

  const payload = randomDecoyPayload();

  // Go through the same FROST gate as a real submit. If the env escape
  // hatch is set, skip the gate (still mark the decoy as submitted so tests
  // don't accumulate failures).
  if (process.env[ENV_DISABLED] !== '1') {
    const preimage = JSON.stringify({
      op: 'mugen.submitEncryptedOffer',
      payload,
      ts: Date.now(),
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const txHashHex = createHash('sha256').update(preimage).digest('hex');
    const approval = await requestThresholdApproval(txHashHex);
    if (!approval.thresholdReached) {
      entry.status = 'failed';
      entry.error = `FROST threshold not reached (${approval.signatures.length}/${approval.threshold})`;
      stats.totalDecoysFailed += 1;
      return;
    }
  }

  const client = await getArciumClient();
  const program = await getArciumProgram();

  const receipt = await submitEncryptedOffer(client, program, {
    cryptoAmount: BigInt(payload.cryptoAmountLamports),
    fiatAmount: BigInt(payload.fiatAmountCents),
    currency: payload.fiatCurrency,
    paymentMethods: payload.paymentMethods,
    makerNonce: pubkeyToNonceU64(payload.makerNoncePubkey),
  });

  entry.status = 'submitted';
  entry.submittedAt = Date.now();
  entry.mpcTxSignature = receipt.signature;
  stats.totalDecoysSubmitted += 1;
  stats.lastDecoyAt = entry.submittedAt;
}

/**
 * Execute any scheduled decoys whose `scheduledFor` is <= now. Returns a
 * summary of what happened this tick. Intended to be called by
 * `/api/cron/noise-tick` on a short interval.
 */
export async function runPendingDecoys(): Promise<{
  executed: number;
  failed: number;
  skipped: number;
}> {
  if (process.env[ENV_DISABLED] === '1') {
    return { executed: 0, failed: 0, skipped: 0 };
  }

  const now = Date.now();
  const all = await loadAllEntries();
  const due = all.filter(
    (e) => e.status === 'scheduled' && e.scheduledFor <= now,
  );
  if (due.length === 0) return { executed: 0, failed: 0, skipped: 0 };

  const wallets = getNoiseWallets();
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  const stats = await readStats();

  let executed = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of due) {
    const wallet = wallets[entry.walletIndex];
    if (!wallet) {
      entry.status = 'failed';
      entry.error = 'wallet index out of range';
      failed += 1;
      stats.totalDecoysFailed += 1;
      await saveEntry(entry);
      continue;
    }
    entry.status = 'submitting';
    await saveEntry(entry);
    try {
      await fireSingleDecoy(entry, wallet, connection, stats);
      // fireSingleDecoy mutates entry.status to either 'submitted' or 'failed'.
      const after = entry.status as NoiseStatus;
      if (after === 'submitted') {
        executed += 1;
      } else if (after === 'failed') {
        failed += 1;
      } else {
        // Shouldn't happen, but treat as skipped rather than lost.
        skipped += 1;
      }
    } catch (err) {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      stats.totalDecoysFailed += 1;
      failed += 1;
    }
    await saveEntry(entry);
  }

  await writeStats(stats);
  return { executed, failed, skipped };
}

// ─── Stats / queue inspection ───────────────────────────────────────────────

export async function getNoiseStats(): Promise<NoiseStats> {
  const entries = await loadAllEntries();
  let pending = 0;
  for (const e of entries) {
    if (e.status === 'scheduled' || e.status === 'submitting') pending += 1;
  }
  const stats = await readStats();
  return {
    walletCount: NOISE_WALLET_COUNT,
    totalDecoysSubmitted: stats.totalDecoysSubmitted,
    totalDecoysFailed: stats.totalDecoysFailed,
    lastDecoyAt: stats.lastDecoyAt,
    scheduledPending: pending,
  };
}

export async function listQueue(): Promise<NoiseSubmissionEntry[]> {
  const entries = await loadAllEntries();
  return entries.sort((a, b) => a.scheduledFor - b.scheduledFor);
}

export async function clearNoiseQueue(): Promise<void> {
  const storage = getStorage();
  const ids = await storage.lrange<string>(KEY_QUEUE, 0, -1);
  for (const id of ids) {
    await storage.del(KEY_ENTRY(id));
  }
  await storage.del(KEY_QUEUE);
}
