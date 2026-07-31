/**
 * seedDerivation — the single root every /pay pool secret grows from, and the
 * only place a user secret can be mixed in.
 *
 * THE FLAW THIS EXISTS TO CLOSE
 * ─────────────────────────────
 * Today (`poolHandlers.setPoolSeed`) the pool seed is
 *
 *   poolSeed = HKDF-SHA256(ikm = walletSignature, salt = ∅, info = 'p01:web:poolseed:v1')
 *
 * and `walletSignature` is ONE Ed25519 signature over a fixed message
 * (`components/pay/PayApp.tsx:192-203`, deliberately deterministic so the keys
 * are recoverable next session). Every note secret, every nullifier preimage,
 * every note blinding, both proof-upload ephemerals and the ML-KEM note-encryption
 * keypair are HKDF expansions of that one seed — see the enumeration at the
 * bottom of this comment.
 *
 * Ed25519 is Shor-breakable. An adversary who archives the chain today and
 * recovers the wallet's private key after CRQC availability re-signs the fixed
 * derivation message, reproduces `poolSeed`, and re-derives the ENTIRE shielded
 * history retroactively — every note this wallet ever held, spent or unspent.
 * That is harvest-now-decrypt-later, and it is NOT fixed by swapping X25519 for
 * ML-KEM anywhere, because the leak is in the DERIVATION, not in a KEM: the
 * ciphertexts are fine, the key that opens them is regenerable from a broken
 * signature scheme.
 *
 * THE FIX
 * ───────
 * HKDF-Extract is HMAC(key = salt, msg = ikm). The salt slot was `undefined`,
 * i.e. a block of zeros. Putting a user-held secret there means the attacker
 * needs the signature AND the passphrase; the signature alone yields nothing.
 *
 *   v2:  passSalt = scrypt(NFKC(passphrase),
 *                          salt   = SHA256('p01:web:passphrase-salt:v1' ‖ signature),
 *                          N,r,p  = 2^16, 8, 1)
 *        poolSeed = HKDF-SHA256(ikm = signature, salt = passSalt,
 *                               info = 'p01:web:poolseed:v2')
 *
 * The scrypt salt is bound to the signature, so (a) no cross-user precomputation
 * is possible, and (b) pre-quantum the salt is itself secret. Post-quantum the
 * attacker holds the signature, so the only thing left is the passphrase's own
 * entropy plus one memory-hard scrypt per guess. MEASURED on the dev box:
 * N=2^16 costs 129 ms and 64 MB per attempt (N=2^14 36 ms/16 MB, N=2^15 60 ms/32 MB,
 * N=2^17 246 ms/128 MB). That is worth roughly 20 bits against a funded attacker
 * and NOT more — the passphrase must carry the real entropy. A six-word diceware
 * phrase (~77 bits) is the intended input; a dictionary word is not.
 *
 * BACKWARD COMPATIBILITY IS THE HARD PART
 * ───────────────────────────────────────
 * Notes already on devnet were derived with `salt = ∅`. Changing the derivation
 * without keeping the old one readable would strand live funds — a worse bug
 * than the one being fixed. So the derivation is VERSIONED and the old path stays
 * first-class:
 *
 *   - no passphrase   → { active: v1 }              (byte-identical to today)
 *   - with passphrase → { active: v2, legacy: v1 }
 *
 * A wallet that adopts a passphrase keeps its v1 seed for the whole session.
 * Callers scan, spend and sweep across `seedsInSearchOrder(...)`, which returns
 * the salted seed first and the legacy seed second, so pre-existing notes stay
 * discoverable and spendable forever. Only NEW notes are created under v2.
 *
 * RECOVERY — READ THIS BEFORE WIRING ANY UI
 * ─────────────────────────────────────────
 * `shieldEphemeral.ts:79-84` is load-bearing: the proof-upload ephemeral must be
 * re-derivable from the wallet signature alone, on any device, forever, or a
 * crashed shield strands its float. That property SURVIVES this change verbatim
 * for a user who still has their passphrase — v2 is a pure function of
 * (signature, passphrase), with no stored state and no randomness.
 *
 * For a user who LOSES the passphrase it does not survive, and there is no
 * recovery path, by construction. This is the Mullvad trade: no account, no
 * reset, no support ticket. Every note created under v2, and any float stranded
 * on a v2 ephemeral, is permanently unreachable. Notes created before the
 * passphrase was set are unaffected — they are v1 and the wallet signature alone
 * still reaches them. Anything that surfaces this feature to a user MUST say
 * that in those words before the passphrase is accepted.
 *
 * COVERAGE — every consumer of the seed, i.e. everything this salt now protects
 * ────────────────────────────────────────────────────────────────────────────
 *   denominatedPool.deriveNoteMaterial   note secret + nullifier preimage
 *   noteBlinding.deriveNoteBlinding      the commitment's blinding factor
 *   shieldEphemeral.deriveShieldEphemeral    depositor / proof-buffer authority
 *   unshieldEphemeral.deriveUnshieldEphemeral withdrawal proof-buffer authority
 *   noteCrypto.deriveNoteEncryptionKeys  X25519 + ML-KEM-768 note-encryption keys
 *
 * All five take the pool seed as their `walletSeed` argument and are reached only
 * through `poolHandlers.requireSeeds`, so salting the root covers all five with
 * no possibility of one being missed. `seedDerivation.test.ts` asserts exactly
 * that list changes under a different passphrase, and that all five are
 * byte-identical to today when no passphrase is set.
 *
 * NOT covered, because neither derives from the wallet signature and Shor
 * therefore does not reach either:
 *
 *   relayEphemeralRecovery.deriveEphemeralForRelay — used by
 *     `denominatedPool.transferDenominatedStarkV3` (line 2020). Its IKM is a
 *     random per-device seed and its job id is `crypto.getRandomValues`, so the
 *     wallet key says nothing about it. It carries transient proof-buffer float,
 *     never a note secret. (Separately, and already documented in
 *     `shieldEphemeral.ts:79-84`, that randomness is why it is NOT re-derivable
 *     after a reload inside a Worker — which is why the shield path does not use it.)
 *
 *   denominatedPool.transferDenominatedStarkV3 recipient notes — minted at lines
 *     1875-1876 with `secureRandomU64()`, i.e. CSPRNG, not seed-derived. A
 *     transfer's bearer note was never derivable from the signature and is not
 *     derivable from the passphrase either.
 *
 * STILL EXPOSED — DO NOT READ THIS FILE AS "/pay SURVIVES SHOR"
 * ────────────────────────────────────────────────────────────
 * This module covers the POOL seed and nothing else. The other half of /pay —
 * the stealth identity — has the identical flaw, untouched, one package away:
 *
 *   packages/pay-core/src/worker/workerCore.ts:205
 *     walletSeed = HKDF-SHA256(ikm = signature, salt = ∅,
 *                              info = 'p01:web:walletseed:v2', 64)
 *
 * SAME Ed25519 signature, SAME empty salt slot. From it come the stealth
 * SPENDING keypair, the VIEWING keypair and the ML-KEM keypair that decide which
 * incoming payments are yours. A Shor adversary who recovers the Phantom key
 * re-signs the same deterministic message and reproduces all three — so the
 * recipient-side privacy of every stealth payment opens retroactively, and given
 * the known view/spend coupling the spend authority goes with it. The pool
 * passphrase does not reach that derivation and was never routed to it.
 *
 * The same flaw is also unfixed in the extension and the mobile app.
 *
 * So the honest statement of what this change buys, and the ONLY one that should
 * appear in any external claim: pool NOTE secrets and pool EPHEMERALS can now be
 * gated on a user secret, for a wallet that has one, for notes created after it
 * was set. Nothing else.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** 1 = signature only (legacy, salt ∅). 2 = signature + user passphrase. */
export type DerivationVersion = 1 | 2;

/** Legacy info string — MUST NOT change, it names every note already on-chain. */
const POOL_SEED_INFO_V1 = utf8ToBytes('p01:web:poolseed:v1');

/** Salted info string. Separate from v1 so the two seeds can never coincide even
 *  if the passphrase stretch ever degenerated to zeros. */
const POOL_SEED_INFO_V2 = utf8ToBytes('p01:web:poolseed:v2');

/** Domain separator for the scrypt salt. */
const PASSPHRASE_SALT_DOMAIN = utf8ToBytes('p01:web:passphrase-salt:v1');

/**
 * scrypt cost. 2^16 ⇒ 64 MB and ~129 ms measured in node on the dev box; the
 * derivation runs ONCE per session, inside the Web Worker, so the user never
 * sees it on the UI thread. Raising it is a one-line change but it is
 * FORMAT-BREAKING — every v2 note derived under the old N becomes unreachable —
 * so it must be versioned into a v3 info string, never edited in place.
 */
export const SCRYPT_N = 1 << 16;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;

/**
 * Shortest passphrase accepted. Below this the stretch buys nothing measurable
 * while permanently splitting the wallet's note namespace in two — all cost, no
 * benefit, and the cost is denominated in stranded funds. Rejecting is safe
 * (loud failure); silently accepting a four-character passphrase is not.
 *
 * This is a LENGTH floor, not an entropy floor. `'aaaaaaaaaaaa'` passes, and so
 * does one common dictionary word of twelve letters — both fall to an offline
 * guess in seconds even at 129 ms per attempt. Nothing in this module measures
 * entropy, so whatever surfaces the prompt is the only thing standing between a
 * user and a passphrase that costs them their notes without protecting them.
 */
export const MIN_PASSPHRASE_CHARS = 12;

/** Seed length every downstream derivation expects. */
const SEED_LEN = 32;

/**
 * Canonical form of a user passphrase, or null when there is none.
 *
 * NFKC so the same phrase typed on a different keyboard/IME produces the same
 * bytes — a normalisation mismatch here is indistinguishable from a typo and
 * costs the user their notes. Outer whitespace is stripped for the same reason;
 * inner spacing is preserved because it is entropy (diceware).
 */
export function normalizePassphrase(passphrase: string | null | undefined): string | null {
  if (passphrase === null || passphrase === undefined) return null;
  const trimmed = passphrase.normalize('NFKC').trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Reject a passphrase that would cost the user their note namespace without
 * buying them anything. Cheap — no stretching — so a caller can validate input
 * before the wallet is ever asked to sign.
 *
 * Returns the normalized passphrase, or throws.
 */
export function assertPassphraseAcceptable(passphrase: string): string {
  const normalized = normalizePassphrase(passphrase);
  if (normalized === null) {
    throw new Error('An empty passphrase cannot be stretched — use the legacy derivation instead.');
  }
  if (normalized.length < MIN_PASSPHRASE_CHARS) {
    throw new Error(
      `Passphrase too short: ${normalized.length} characters, minimum ${MIN_PASSPHRASE_CHARS}. ` +
        'A short passphrase adds no real protection but permanently splits your notes in two.',
    );
  }
  return normalized;
}

/**
 * Stretch a passphrase into the 32-byte HKDF salt, bound to this wallet's
 * signature so the work cannot be precomputed across users.
 *
 * Throws on a passphrase shorter than `MIN_PASSPHRASE_CHARS` — see that constant.
 */
export function derivePassphraseSalt(
  signature: Uint8Array,
  passphrase: string,
): Uint8Array {
  const normalized = assertPassphraseAcceptable(passphrase);
  const scryptSalt = sha256(concatBytes(PASSPHRASE_SALT_DOMAIN, signature));
  const out = scrypt(utf8ToBytes(normalized), scryptSalt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: 32,
  });
  scryptSalt.fill(0);
  return out;
}

/**
 * The derivation every note on devnet today was created under: HKDF over the
 * wallet signature with NO salt.
 *
 * Kept forever, and kept readable. Do not "clean this up".
 */
export function derivePoolSeedLegacy(signature: Uint8Array): Uint8Array {
  return hkdf(sha256, signature, undefined, POOL_SEED_INFO_V1, SEED_LEN);
}

/** Salted derivation: the wallet signature is no longer sufficient. */
export function derivePoolSeedSalted(signature: Uint8Array, passphrase: string): Uint8Array {
  const salt = derivePassphraseSalt(signature, passphrase);
  try {
    return hkdf(sha256, signature, salt, POOL_SEED_INFO_V2, SEED_LEN);
  } finally {
    salt.fill(0);
  }
}

/**
 * Every seed one identity can legitimately hold.
 *
 * `active` is what NEW notes are created under. `legacy` is present only when
 * `active` is salted, and exists purely so notes shielded before the passphrase
 * remain discoverable and spendable.
 */
export interface PoolSeedSet {
  active: Uint8Array;
  activeVersion: DerivationVersion;
  /** The v1 seed, when `activeVersion === 2`. Never used for new notes. */
  legacy?: Uint8Array;
}

/**
 * Derive the seed set for one wallet signature.
 *
 * With no passphrase (null, undefined, '', or whitespace) this returns EXACTLY
 * the bytes the pre-passphrase build produced — the parity gate in
 * `seedDerivation.test.ts` pins that against a frozen vector.
 */
export function derivePoolSeeds(
  signature: Uint8Array,
  passphrase?: string | null,
): PoolSeedSet {
  const normalized = normalizePassphrase(passphrase);
  const legacy = derivePoolSeedLegacy(signature);
  if (normalized === null) {
    return { active: legacy, activeVersion: 1 };
  }
  return {
    active: derivePoolSeedSalted(signature, normalized),
    activeVersion: 2,
    legacy,
  };
}

export interface SeedCandidate {
  seed: Uint8Array;
  derivation: DerivationVersion;
}

/**
 * The seeds a read path (scan, note lookup, float sweep) must try, in order.
 *
 * Active first so a salted wallet resolves its own new notes without touching
 * the legacy seed; legacy second so nothing shielded before the passphrase ever
 * becomes invisible. A caller that iterates anything narrower than this WILL
 * hide funds.
 */
export function seedsInSearchOrder(set: PoolSeedSet): SeedCandidate[] {
  const out: SeedCandidate[] = [{ seed: set.active, derivation: set.activeVersion }];
  if (set.legacy && set.activeVersion !== 1) {
    out.push({ seed: set.legacy, derivation: 1 });
  }
  return out;
}

/** The seed behind a given derivation version, or null if this set has none. */
export function seedForDerivation(
  set: PoolSeedSet,
  derivation: DerivationVersion,
): Uint8Array | null {
  const hit = seedsInSearchOrder(set).find((c) => c.derivation === derivation);
  return hit ? hit.seed : null;
}

/** Zero every seed in the set. Called when sessions are cleared. */
export function wipePoolSeeds(set: PoolSeedSet): void {
  set.active.fill(0);
  set.legacy?.fill(0);
}
