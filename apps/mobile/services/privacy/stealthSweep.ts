/**
 * stealthSweep — make the stealth recipient's key material survive the process,
 * so the sweep back to the wallet stops having to happen 8 seconds later.
 *
 * WHAT WAS MEASURED
 * ─────────────────
 * Devnet, 2026-08-04. The V3 withdrawal at slot 481,027,681 paid a stealth
 * recipient. That recipient forwarded 0.994995 SOL to the user's wallet at slot
 * 481,027,703 — EIGHT SECONDS later, sig 36AA328ZmYqy…, and the amounts line up
 * exactly (1.000 in, 0.995 out). A stealth address that sweeps to the wallet
 * inside the same minute, for the same amount, is a rename of the wallet, not a
 * hop.
 *
 * WHY IT WAS 8 SECONDS — THE ACTUAL CONSTRAINT
 * ────────────────────────────────────────────
 * Not caution, and not a design choice about timing. The stealth recipient is
 * produced by `utils/crypto/stealth.ts:generateStealthAddress`, whose FIRST line
 * is `nacl.box.keyPair()` — a fresh random X25519 ephemeral. The recipient's
 * private key can only be recomputed from
 *
 *     (ephemeralPublicKey, viewTag, kemCiphertext)   [sender side]
 *   + (viewingSecretKey, spendingPubKey, kemSecretKey)   [held in SecureStore]
 *
 * and the first three lived ONLY in a local `stealthResult` variable. They were
 * never persisted and are not published on chain by the unshield instruction.
 *
 * So before this file existed, the window between "the withdrawal landed" and
 * "the sweep confirmed" was a window in which killing the app destroyed the only
 * copy of the key to the money. The 3-7 second delay
 * (`denominatedPoolStore.ts`, `sweepDelay = 3000 + random(4000)`) was as long as
 * anyone dared. And a sweep that merely FAILED — the `catch` logged
 * "Sweep failed (funds in stealth)" and moved on — lost the denomination
 * permanently.
 *
 * THE FIX, AND WHAT IT DOES AND DOES NOT BUY
 * ──────────────────────────────────────────
 * Persist the three sender-side values, in the store's ENCRYPTED slice, BEFORE
 * the withdrawal is submitted. Then the sweep is recoverable, deferrable,
 * retryable and re-targetable, because the key can be rebuilt on any later run
 * from data at rest plus the SecureStore keys.
 *
 * That closes a fund-loss hole. It does NOT by itself buy privacy, and nothing
 * here should be described as if it does:
 *
 *   - The withdrawal publishes the note commitment that the deposit also
 *     published (CONFIRMED on the pair above: leaf 16 = 8901821612542787864 in
 *     both transactions). The deposit↔withdrawal link is therefore already
 *     public, and NO sweep schedule changes that. Only the C7 spend circuit
 *     does — `docs/C7_SPEND_CIRCUIT_PLAN.md`.
 *   - Consequently, delaying the sweep is worth close to nothing against an
 *     analyst who follows commitments, and worth a little against one who only
 *     follows value and timing. Saying more than that would be a claim the code
 *     does not deliver.
 *
 * What the persistence genuinely enables is the option: the sweep no longer HAS
 * to be immediate, so a user (or a later UI) can hold the funds at the stealth
 * address, or send them somewhere that is not the wallet they deposited from —
 * which is the only version of this hop that would ever be worth anything.
 */

import {
  Keypair as SolKeypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from '@solana/web3.js';

import { SWEEP_FEE_RESERVE } from './ephemeralSigner';

/**
 * Everything needed to rebuild one stealth recipient's private key later.
 *
 * Persisted through the store's encrypted storage adapter. It is secret-adjacent
 * — combined with the SecureStore viewing/KEM keys it IS spend authority for the
 * funds at `stealthAddress` — so it must never be written anywhere the note
 * receipts are not already written.
 */
export interface PendingStealthSweep {
  /** Stable id: the note this withdrawal spent. One withdrawal per note. */
  noteId: string;
  poolPDA: string;
  /** base58 X25519 ephemeral public key from `generateStealthAddress`. */
  ephemeralPublicKey: string;
  /** Fast-rejection tag; optional because pre-hybrid senders had none. */
  viewTag?: number;
  /** ML-KEM-768 ciphertext, hex. Absent when the recipient had no KEM key. */
  kemCiphertextHex?: string;
  /** The address the pool paid. Lets a UI show the balance without deriving. */
  stealthAddress: string;
  /** Where the user asked the money to end up. Overridable at sweep time. */
  destination: string;
  createdAt: number;
  /** Last failure, so a stuck record explains itself instead of going quiet. */
  lastError?: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHexLocal(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Build the persisted record from a freshly generated stealth address.
 *
 * Call this BEFORE submitting the withdrawal. Calling it after re-opens exactly
 * the window this module exists to close.
 */
export function buildPendingStealthSweep(args: {
  noteId: string;
  poolPDA: string;
  destination: string;
  stealth: {
    address: string;
    ephemeralPublicKey: string;
    viewTag?: number;
    kemCiphertext?: Uint8Array;
  };
}): PendingStealthSweep {
  return {
    noteId: args.noteId,
    poolPDA: args.poolPDA,
    ephemeralPublicKey: args.stealth.ephemeralPublicKey,
    viewTag: args.stealth.viewTag,
    kemCiphertextHex: args.stealth.kemCiphertext
      ? bytesToHexLocal(args.stealth.kemCiphertext)
      : undefined,
    stealthAddress: args.stealth.address,
    destination: args.destination,
    createdAt: Date.now(),
  };
}

export interface StealthSweepOutcome {
  /** Lamports moved. 0 when the address was already empty. */
  swept: number;
  /** True when the record can be dropped: swept, or nothing left to sweep. */
  settled: boolean;
  signature?: string;
  error?: string;
}

/**
 * Rebuild the stealth recipient's keypair from a persisted record and move its
 * balance to `destinationOverride ?? record.destination`.
 *
 * Never throws: a caller is usually already handling something else, and a
 * thrown sweep would be worse than a recorded one. `settled: false` means the
 * record must be kept and retried.
 */
export async function executeStealthSweep(
  connection: Connection,
  record: PendingStealthSweep,
  destinationOverride?: string,
): Promise<StealthSweepOutcome> {
  try {
    const { getOrCreateStealthKeys } = await import('../stealth/keys');
    const { scanStealthPayment } = await import('../../utils/crypto/stealth');
    const keys = await getOrCreateStealthKeys();

    const scan = scanStealthPayment(
      record.ephemeralPublicKey,
      keys.viewingSecretKey,
      keys.spendingKey.publicKey.toBytes(),
      record.viewTag,
      record.kemCiphertextHex ? hexToBytes(record.kemCiphertextHex) : undefined,
      keys.kemSecretKey,
    );
    if (!scan.found || !scan.privateKey) {
      // The stealth keys in SecureStore do not match the ones this payment was
      // addressed to (wallet restored without them, or keys regenerated). The
      // record is useless but keeping it is free and it names the address, so
      // the loss is at least visible rather than silent.
      return {
        swept: 0,
        settled: false,
        error:
          'Stealth keys do not open this payment — the viewing/KEM keys in secure storage ' +
          'are not the ones it was addressed to.',
      };
    }

    const kp = SolKeypair.fromSecretKey(scan.privateKey);
    const bal = await connection.getBalance(kp.publicKey, 'confirmed');
    if (bal <= SWEEP_FEE_RESERVE) {
      return { swept: 0, settled: true };
    }
    const lamports = bal - SWEEP_FEE_RESERVE;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: new PublicKey(destinationOverride ?? record.destination),
        lamports,
      }),
    );
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = kp.publicKey;
    tx.sign(kp);
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, 'confirmed');
    return { swept: lamports, settled: true, signature };
  } catch (e) {
    return { swept: 0, settled: false, error: e instanceof Error ? e.message : String(e) };
  }
}
