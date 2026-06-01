/**
 * Ephemeral Keypair Recovery
 * ──────────────────────────
 *
 * Every relay job pre-funds an ephemeral keypair from the user's main wallet.
 * If the wrapper crashes mid-flight (network drop, oversized tx, monitor
 * timeout), the SOL on that ephemeral is stranded.
 *
 * Phase A.1 hardens this with:
 *   - Deterministic ephemeral derivation from a session seed → re-deriveable
 *     across crashes / restarts.
 *   - Pending-job persistence in SecureStore → UI can later sweep.
 *
 * The session seed itself is generated once per device install and stored in
 * SecureStore (`p01_relay_session_seed_v1`). It's NOT the wallet seed — it's
 * a separate secret used only for relay-ephemeral derivation, so a re-install
 * cleans the slate (any stranded funds from prior installs are unrecoverable
 * once the SecureStore is wiped — same trust model as `feedback_apk_signing_wipes_notes`).
 */

import { Keypair } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { Buffer } from 'buffer';

// Extension shims for the mobile RN deps (keeps the call sites unchanged):
//  - expo-secure-store → chrome.storage.local (persists across popup close).
//  - expo-crypto getRandomBytesAsync → Web Crypto getRandomValues.
const SecureStore = {
  getItemAsync: async (k: string): Promise<string | null> => {
    const r = await chrome.storage.local.get(k);
    return (r[k] as string | undefined) ?? null;
  },
  setItemAsync: async (k: string, v: string): Promise<void> => {
    await chrome.storage.local.set({ [k]: v });
  },
};
const Crypto = {
  getRandomBytesAsync: async (n: number): Promise<Uint8Array> =>
    globalThis.crypto.getRandomValues(new Uint8Array(n)),
};

const SEED_KEY = 'p01_relay_session_seed_v1';
const PENDING_KEY = 'p01_relay_pending_v1';
const HKDF_INFO_PREFIX = utf8ToBytes('p01_relay_ephemeral_v1');

export interface PendingRelayJob {
  jobId: string;            // hex
  ephemeralPubkey: string;  // base58
  expectedLamports: number;
  createdAt: string;        // ISO 8601
  reason?: string;          // populated when wrapper errored mid-flight
}

// ── Session seed ────────────────────────────────────────────────────────

/**
 * Get-or-create the per-device 32-byte secret used to derive all relay
 * ephemerals. Persisted in SecureStore. Not synced across devices.
 */
async function getOrCreateRelaySeed(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(SEED_KEY);
  if (existing) {
    return Buffer.from(existing, 'base64');
  }
  const fresh = await Crypto.getRandomBytesAsync(32);
  await SecureStore.setItemAsync(SEED_KEY, Buffer.from(fresh).toString('base64'));
  return fresh;
}

// ── Deterministic ephemeral derivation ──────────────────────────────────

/**
 * Derive an ed25519 Keypair for a given relay job.
 *
 * Same `(sessionSeed, jobId)` → same Keypair, always. Re-deriveable for
 * sweep if the wrapper crashed mid-flight.
 */
export async function deriveEphemeralForRelay(jobId: Uint8Array): Promise<Keypair> {
  const seed = await getOrCreateRelaySeed();
  const info = concatBytes(HKDF_INFO_PREFIX, jobId);
  const ed25519Seed = hkdf(sha256, seed, undefined, info, 32);
  return Keypair.fromSeed(ed25519Seed);
}

// ── Pending job persistence ─────────────────────────────────────────────

/**
 * Append a pending entry. Called BEFORE the pre-fund tx is sent so that even
 * if the wrapper crashes immediately after, we have the data to recover.
 */
export async function addPendingRelay(entry: PendingRelayJob): Promise<void> {
  const list = await listPendingRelays();
  // Dedupe on jobId
  const filtered = list.filter((e) => e.jobId !== entry.jobId);
  filtered.push(entry);
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(filtered));
}

/**
 * Remove a pending entry. Called on successful relay-job completion when
 * the ephemeral has been fully consumed by the relay protocol.
 */
export async function removePendingRelay(jobIdHex: string): Promise<void> {
  const list = await listPendingRelays();
  const filtered = list.filter((e) => e.jobId !== jobIdHex);
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(filtered));
}

/**
 * Return all pending entries (oldest first) — UI uses this to render the
 * "Stuck funds recovery" list.
 */
export async function listPendingRelays(): Promise<PendingRelayJob[]> {
  const raw = await SecureStore.getItemAsync(PENDING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

/**
 * Mark an entry as errored mid-flight by attaching a reason. Used by the
 * wrapper when the post-prefund step throws.
 */
export async function markPendingRelayErrored(jobIdHex: string, reason: string): Promise<void> {
  const list = await listPendingRelays();
  const next = list.map((e) => (e.jobId === jobIdHex ? { ...e, reason } : e));
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(next));
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function jobIdToHex(jobId: Uint8Array): string {
  return Buffer.from(jobId).toString('hex');
}
