/**
 * seedDerivation — parity, coverage and recovery gates.
 *
 * THE THREE THINGS THIS FILE EXISTS TO PROVE
 * ──────────────────────────────────────────
 *  1. PARITY. With no passphrase, every derived secret is byte-for-byte what the
 *     pre-passphrase build produced. If this ever goes red, live devnet notes
 *     have been stranded — that is a fund-loss regression, not a test failure to
 *     be "fixed" by updating the expected bytes.
 *  2. COVERAGE. A different passphrase moves EVERY consumer of the pool seed.
 *     The list is written out explicitly: a derivation that is added later and
 *     not added here would silently keep deriving from the wallet signature
 *     alone, which voids the whole property while looking green.
 *  3. RECOVERY. A wallet that adopts a passphrase still reaches the notes it
 *     shielded before it — same commitment, same nullifier, same withdrawal
 *     ephemeral.
 *
 * Runs under `vitest.pool.config.mts` (node, real @solana/web3.js).
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import {
  MIN_PASSPHRASE_CHARS,
  SCRYPT_N,
  assertPassphraseAcceptable,
  derivePassphraseSalt,
  derivePoolSeedLegacy,
  derivePoolSeedSalted,
  derivePoolSeeds,
  normalizePassphrase,
  seedForDerivation,
  seedsInSearchOrder,
  wipePoolSeeds,
} from './seedDerivation';
import { createCommitmentV3, createNullifierV3, deriveNoteMaterial, pubkeyToField, SOL_POOLS_V3 } from './denominatedPool';
import { deriveNoteBlinding } from './noteBlinding';
import { deriveShieldEphemeral } from './shieldEphemeral';
import { deriveUnshieldEphemeral } from './unshieldEphemeral';
import { createNoteEncryptionAddress, deriveNoteEncryptionKeys } from './noteCrypto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A stand-in for the 64-byte Ed25519 signature Phantom returns. Fixed so the
 *  frozen vectors below are reproducible. */
const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 7 + 13) & 0xff;

/** A second wallet, for the "salt is bound to the wallet" check. */
const OTHER_SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) OTHER_SIGNATURE[i] = (i * 11 + 3) & 0xff;

const PASS_A = 'correct horse battery staple';
const PASS_B = 'nine tigers argue quietly beneath rain';

const POOL = SOL_POOLS_V3[0].poolPDA;
const OTHER_POOL = SOL_POOLS_V3[1].poolPDA;

/**
 * THE ORIGINAL FORMULA, transcribed from the code this change replaced
 * (`poolHandlers.setPoolSeed` at 8a9600a8):
 *
 *   hkdf(sha256, signature, undefined, utf8ToBytes('p01:web:poolseed:v1'), 32)
 *
 * Written out longhand rather than imported, so a change to the module under
 * test cannot move the expectation with it.
 */
function legacySeedAsShipped(signature: Uint8Array): Uint8Array {
  return hkdf(sha256, signature, undefined, utf8ToBytes('p01:web:poolseed:v1'), 32);
}

// ---------------------------------------------------------------------------
// 1. PARITY GATE — no passphrase reproduces the shipped derivation exactly
// ---------------------------------------------------------------------------

describe('parity with the pre-passphrase derivation', () => {
  it('reproduces the shipped seed byte-for-byte when no passphrase is given', () => {
    const expected = legacySeedAsShipped(SIGNATURE);
    for (const passphrase of [undefined, null, '', '   ', '\t\n  ']) {
      const set = derivePoolSeeds(SIGNATURE, passphrase);
      expect(set.activeVersion).toBe(1);
      expect(set.legacy).toBeUndefined();
      expect(bytesToHex(set.active)).toBe(bytesToHex(expected));
    }
  });

  it('pins the unsalted seed to a frozen vector', () => {
    // Computed from the shipped formula at base commit 8a9600a8 for the fixed
    // SIGNATURE above. If this constant ever has to change, the derivation
    // changed and every devnet note derived under it is unreachable. Do NOT
    // update it to match new code — that is how funds get stranded silently.
    const FROZEN = '0f2fcbf0b014543c0d98779359dff29470e4c548be10243b1c40b2e483689e32';
    expect(bytesToHex(legacySeedAsShipped(SIGNATURE))).toBe(FROZEN);
    expect(bytesToHex(derivePoolSeedLegacy(SIGNATURE))).toBe(FROZEN);
    expect(bytesToHex(derivePoolSeeds(SIGNATURE).active)).toBe(FROZEN);
  });

  it('reproduces every downstream secret byte-for-byte with no passphrase', () => {
    const shipped = legacySeedAsShipped(SIGNATURE);
    const now = derivePoolSeeds(SIGNATURE).active;

    // deriveNoteMaterial — note secret + nullifier preimage
    expect(deriveNoteMaterial(now, POOL, 7)).toEqual(deriveNoteMaterial(shipped, POOL, 7));
    // deriveNoteBlinding — the commitment's blinding factor
    expect(deriveNoteBlinding(now, POOL, 7)).toBe(deriveNoteBlinding(shipped, POOL, 7));
    // deriveShieldEphemeral — depositor / C6 proof-buffer authority
    expect(deriveShieldEphemeral(now, POOL, 7).publicKey.toBase58()).toBe(
      deriveShieldEphemeral(shipped, POOL, 7).publicKey.toBase58(),
    );
    // deriveUnshieldEphemeral — C1/C3 proof-buffer authority
    expect(deriveUnshieldEphemeral(now, POOL, 7).publicKey.toBase58()).toBe(
      deriveUnshieldEphemeral(shipped, POOL, 7).publicKey.toBase58(),
    );
    // deriveNoteEncryptionKeys — X25519 + ML-KEM-768 note-encryption keypair
    expect(createNoteEncryptionAddress(now)).toBe(createNoteEncryptionAddress(shipped));
  });
});

// ---------------------------------------------------------------------------
// 2. DETERMINISM
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('same signature + same passphrase gives the same seed across calls', () => {
    const a = derivePoolSeeds(SIGNATURE, PASS_A);
    const b = derivePoolSeeds(SIGNATURE, PASS_A);
    expect(bytesToHex(a.active)).toBe(bytesToHex(b.active));
    expect(a.activeVersion).toBe(2);
    expect(b.activeVersion).toBe(2);
  });

  it('is a pure function — no randomness, no stored state', () => {
    // The recovery property in shieldEphemeral.ts:79-84 depends on this: the
    // ephemeral must be re-derivable on any device, forever.
    const first = deriveShieldEphemeral(derivePoolSeeds(SIGNATURE, PASS_A).active, POOL, 42);
    const laterOnAnotherDevice = deriveShieldEphemeral(
      derivePoolSeeds(Uint8Array.from(SIGNATURE), `  ${PASS_A}  `).active,
      POOL,
      42,
    );
    expect(laterOnAnotherDevice.publicKey.toBase58()).toBe(first.publicKey.toBase58());
  });

  it('normalises unicode so the same phrase typed differently still opens the notes', () => {
    // U+00E9 vs 'e' + U+0301 — visually identical, different bytes.
    const composed = 'passphrase café rouge';
    const decomposed = 'passphrase café rouge';
    expect(composed).not.toBe(decomposed);
    expect(normalizePassphrase(composed)).toBe(normalizePassphrase(decomposed));
    expect(bytesToHex(derivePoolSeeds(SIGNATURE, composed).active)).toBe(
      bytesToHex(derivePoolSeeds(SIGNATURE, decomposed).active),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. COVERAGE GATE — a different passphrase moves EVERY seed consumer
// ---------------------------------------------------------------------------

/**
 * Every artefact that must become unreachable to an attacker holding only the
 * wallet signature. Adding a derivation to the codebase without adding it here
 * is how this property gets silently voided.
 */
function derivedArtefacts(seed: Uint8Array): Record<string, string> {
  const { secret, nullifierPreimage } = deriveNoteMaterial(seed, POOL, 5);
  const blinding = deriveNoteBlinding(seed, POOL, 5);
  const keys = deriveNoteEncryptionKeys(seed);
  return {
    'deriveNoteMaterial.secret': secret.toString(),
    'deriveNoteMaterial.nullifierPreimage': nullifierPreimage.toString(),
    'createNullifierV3': createNullifierV3(nullifierPreimage, secret).toString(),
    'createCommitmentV3': createCommitmentV3(
      nullifierPreimage,
      secret,
      blinding,
      pubkeyToField(SOL_POOLS_V3[0].tokenMint),
    ).toString(),
    'deriveNoteBlinding': blinding.toString(),
    'deriveShieldEphemeral': deriveShieldEphemeral(seed, POOL, 5).publicKey.toBase58(),
    'deriveUnshieldEphemeral': deriveUnshieldEphemeral(seed, POOL, 5).publicKey.toBase58(),
    'deriveNoteEncryptionKeys.x25519Pub': bytesToHex(keys.x25519Pub),
    'deriveNoteEncryptionKeys.kemPub': bytesToHex(keys.kemPub).slice(0, 64),
    'createNoteEncryptionAddress': createNoteEncryptionAddress(seed).slice(0, 64),
  };
}

describe('coverage — the salt reaches every seed consumer', () => {
  const noPass = derivedArtefacts(derivePoolSeeds(SIGNATURE).active);
  const withA = derivedArtefacts(derivePoolSeeds(SIGNATURE, PASS_A).active);
  const withB = derivedArtefacts(derivePoolSeeds(SIGNATURE, PASS_B).active);

  const names = Object.keys(noPass);

  it('enumerates ten artefacts, so a missing one is visible', () => {
    expect(names).toHaveLength(10);
  });

  for (const name of Object.keys(derivedArtefacts(new Uint8Array(32)))) {
    it(`${name} changes when a passphrase is added`, () => {
      expect(withA[name]).not.toBe(noPass[name]);
    });

    it(`${name} is disjoint between two different passphrases`, () => {
      expect(withA[name]).not.toBe(withB[name]);
    });
  }

  it('produces no collisions across the three derivations', () => {
    const all = [...Object.values(noPass), ...Object.values(withA), ...Object.values(withB)];
    expect(new Set(all).size).toBe(all.length);
  });
});

// ---------------------------------------------------------------------------
// 4. RECOVERY — an existing note survives adopting a passphrase
// ---------------------------------------------------------------------------

describe('backward compatibility with notes already on-chain', () => {
  /** Leaf 30 of the 0.1 SOL pool is a real unspent legacy note — see poolNotes.ts. */
  const LEGACY_LEAF = 30;

  it('keeps the legacy seed available once a passphrase is adopted', () => {
    const before = derivePoolSeeds(SIGNATURE);
    const after = derivePoolSeeds(SIGNATURE, PASS_A);
    expect(after.legacy).toBeDefined();
    expect(bytesToHex(after.legacy as Uint8Array)).toBe(bytesToHex(before.active));
  });

  it('reproduces an existing note commitment exactly, through the legacy seed', () => {
    // What the user's note looks like today, derived before the passphrase.
    const oldSeed = derivePoolSeeds(SIGNATURE).active;
    const oldMaterial = deriveNoteMaterial(oldSeed, POOL, LEGACY_LEAF);
    const oldBlinding = deriveNoteBlinding(oldSeed, POOL, LEGACY_LEAF);
    const onChainCommitment = createCommitmentV3(
      oldMaterial.nullifierPreimage,
      oldMaterial.secret,
      oldBlinding,
      pubkeyToField(SOL_POOLS_V3[0].tokenMint),
    );

    // Now the same wallet adopts a passphrase and rescans.
    const set = derivePoolSeeds(SIGNATURE, PASS_A);
    const recovered = seedsInSearchOrder(set)
      .map((candidate) => {
        const m = deriveNoteMaterial(candidate.seed, POOL, LEGACY_LEAF);
        const b = deriveNoteBlinding(candidate.seed, POOL, LEGACY_LEAF);
        return {
          derivation: candidate.derivation,
          commitment: createCommitmentV3(
            m.nullifierPreimage,
            m.secret,
            b,
            pubkeyToField(SOL_POOLS_V3[0].tokenMint),
          ),
          nullifier: createNullifierV3(m.nullifierPreimage, m.secret),
          ephemeral: deriveUnshieldEphemeral(candidate.seed, POOL, LEGACY_LEAF).publicKey.toBase58(),
        };
      })
      .find((r) => r.commitment === onChainCommitment);

    expect(recovered).toBeDefined();
    expect(recovered?.derivation).toBe(1);
    // The withdrawal must be signed by the SAME ephemeral as before, or any
    // proof buffer stranded by an earlier attempt becomes unsweepable.
    expect(recovered?.ephemeral).toBe(
      deriveUnshieldEphemeral(oldSeed, POOL, LEGACY_LEAF).publicKey.toBase58(),
    );
    expect(recovered?.nullifier).toBe(
      createNullifierV3(oldMaterial.nullifierPreimage, oldMaterial.secret),
    );
  });

  it('searches the active derivation first, then the legacy one', () => {
    const salted = derivePoolSeeds(SIGNATURE, PASS_A);
    const order = seedsInSearchOrder(salted);
    expect(order.map((c) => c.derivation)).toEqual([2, 1]);
    expect(bytesToHex(order[0].seed)).toBe(bytesToHex(salted.active));
    expect(bytesToHex(order[1].seed)).toBe(bytesToHex(derivePoolSeedLegacy(SIGNATURE)));
  });

  it('has exactly one seed to search when no passphrase is set', () => {
    const order = seedsInSearchOrder(derivePoolSeeds(SIGNATURE));
    expect(order.map((c) => c.derivation)).toEqual([1]);
  });

  it('resolves a seed by derivation version', () => {
    const salted = derivePoolSeeds(SIGNATURE, PASS_A);
    expect(bytesToHex(seedForDerivation(salted, 1) as Uint8Array)).toBe(
      bytesToHex(derivePoolSeedLegacy(SIGNATURE)),
    );
    expect(bytesToHex(seedForDerivation(salted, 2) as Uint8Array)).toBe(bytesToHex(salted.active));
    expect(seedForDerivation(derivePoolSeeds(SIGNATURE), 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. THE SALT ITSELF
// ---------------------------------------------------------------------------

describe('passphrase stretching', () => {
  it('binds the stretch to the wallet, so it cannot be precomputed across users', () => {
    const a = derivePassphraseSalt(SIGNATURE, PASS_A);
    const b = derivePassphraseSalt(OTHER_SIGNATURE, PASS_A);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('is memory-hard, not a bare hash', () => {
    // Guards against someone "optimising" the stretch away. 2^16 is the shipped
    // cost; anything at or below 2^10 would make an offline guess free.
    expect(SCRYPT_N).toBeGreaterThanOrEqual(1 << 14);
  });

  it('produces a 32-byte salt', () => {
    expect(derivePassphraseSalt(SIGNATURE, PASS_A)).toHaveLength(32);
  });

  it('refuses a passphrase too short to be worth the namespace split', () => {
    const short = 'a'.repeat(MIN_PASSPHRASE_CHARS - 1);
    expect(() => assertPassphraseAcceptable(short)).toThrow(/too short/i);
    expect(() => derivePoolSeeds(SIGNATURE, short)).toThrow(/too short/i);
    expect(() => derivePoolSeedSalted(SIGNATURE, short)).toThrow(/too short/i);
  });

  it('accepts a passphrase exactly at the minimum', () => {
    const exact = 'a'.repeat(MIN_PASSPHRASE_CHARS);
    expect(assertPassphraseAcceptable(exact)).toBe(exact);
    expect(derivePoolSeeds(SIGNATURE, exact).activeVersion).toBe(2);
  });

  it('treats whitespace-only input as no passphrase, not as a short one', () => {
    expect(normalizePassphrase('    ')).toBeNull();
    expect(derivePoolSeeds(SIGNATURE, '    ').activeVersion).toBe(1);
  });

  it('keeps inner spacing, because in a diceware phrase it is entropy', () => {
    expect(normalizePassphrase('  one two three four  ')).toBe('one two three four');
    expect(bytesToHex(derivePoolSeeds(SIGNATURE, 'one two three four').active)).not.toBe(
      bytesToHex(derivePoolSeeds(SIGNATURE, 'onetwothreefour').active),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. HYGIENE
// ---------------------------------------------------------------------------

describe('seed hygiene', () => {
  it('zeroes both seeds on wipe', () => {
    const set = derivePoolSeeds(SIGNATURE, PASS_A);
    wipePoolSeeds(set);
    expect([...set.active].every((b) => b === 0)).toBe(true);
    expect([...(set.legacy as Uint8Array)].every((b) => b === 0)).toBe(true);
  });

  it('domain-separates pools, so one pool key says nothing about another', () => {
    const seed = derivePoolSeeds(SIGNATURE, PASS_A).active;
    expect(deriveNoteMaterial(seed, POOL, 1).secret).not.toBe(
      deriveNoteMaterial(seed, OTHER_POOL as PublicKey, 1).secret,
    );
  });
});
