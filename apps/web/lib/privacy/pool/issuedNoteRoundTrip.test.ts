/**
 * The composition `/api/issue-note` performs, end to end, with no chain.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY THIS EXISTS
 * ───────────────
 * Issuance is not one function, it is a chain of five, and every link is
 * independently tested while the JOIN between them is not:
 *
 *   deriveNoteMaterial + deriveNoteBlinding  →  the treasury's secrets
 *   createCommitmentV3                       →  the leaf the chain must hold
 *   encryptNote(recipient p01pq address)     →  the sealed blob
 *   decryptNote(recipient seed)              →  the recipient opens it
 *   shareableNoteToReceipt                   →  the import refuses a mismatch
 *
 * The failure mode of a wrong join is not an exception, it is a note that looks
 * received and cannot be spent — and it surfaces at the END of a subscription
 * attempt, after a claim has been consumed and ~150 uploads have run.
 *
 * The argument order alone has already been wrong once here: `createCommitmentV3`
 * takes `(nullifierPreimage, secret, …)` and both are bigints, so the swapped
 * version type-checks and produces a commitment that is on no tree.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import {
  createCommitmentV3,
  deriveNoteMaterial,
  pubkeyToField,
  shareableNoteToReceipt,
  getPoolsForTokenV3,
  type ShareableNote,
} from './denominatedPool';
import { deriveNoteBlinding } from './noteBlinding';
import { createNoteEncryptionAddress, decryptNote, encryptNote } from './noteCrypto';

/** Stands in for `P01_TREASURY_POOL_SEED`. */
const TREASURY_SEED = new Uint8Array(32).fill(3);
/** The buyer's pool seed, which the treasury never sees. */
const BUYER_SEED = new Uint8Array(32).fill(200);
const LEAF = 26;

/** Exactly what the route builds, minus the Merkle path and the chain check. */
function issue(seed: Uint8Array, pool: ReturnType<typeof getPoolsForTokenV3>[number], leafIndex: number) {
  const { secret, nullifierPreimage } = deriveNoteMaterial(seed, pool.poolPDA, leafIndex);
  const noteBlinding = deriveNoteBlinding(seed, pool.poolPDA, leafIndex);
  const commitment = createCommitmentV3(
    nullifierPreimage,
    secret,
    noteBlinding,
    pubkeyToField(pool.tokenMint),
  );
  const note: ShareableNote = {
    version: 1,
    pool: pool.poolPDA.toBase58(),
    secret: secret.toString(),
    nullifier_preimage: nullifierPreimage.toString(),
    deposit_epoch: noteBlinding.toString(),
    token_mint: pubkeyToField(pool.tokenMint).toString(),
    commitment: commitment.toString(),
    leafIndex,
    token: pool.token,
    denominationHuman: pool.denomination,
  };
  return { note, commitment };
}

const POOL = getPoolsForTokenV3('SOL')[0]!;

describe('a note the treasury derives and seals', () => {
  it('opens under the recipient’s seed and survives the import check', () => {
    // The whole chain in one case, because the whole chain is what is new. Any
    // link that drifts makes a note that looks received and cannot be spent.
    const { note, commitment } = issue(TREASURY_SEED, POOL, LEAF);
    const address = createNoteEncryptionAddress(BUYER_SEED);
    const sealed = encryptNote(address, new TextEncoder().encode(JSON.stringify(note)));

    // ⚠️ `JSON.parse` of the decrypted bytes, NOT `decodeShareableNote`.
    // The two are different formats and only one is on this path:
    // `decodeShareableNote` does an `atob` first, because it reads the
    // base64 form a human pastes. What the worker actually does with a blob is
    // `JSON.parse(new TextDecoder().decode(decryptNote(seed, blob)))`
    // (`poolHandlers.ts:1140`), and what every sealer writes is
    // `utf8ToBytes(JSON.stringify(note))` (`:1846`).
    //
    // The first draft of this test used the base64 reader and failed with
    // "Invalid character", which looked exactly like a bug in the issuance
    // route. It was a bug in the test. Worth the comment: the two decoders take
    // the same conceptual object and one of them will reject the other's output
    // every time.
    const opened = JSON.parse(
      new TextDecoder().decode(decryptNote(BUYER_SEED, sealed)),
    ) as ShareableNote;
    const receipt = shareableNoteToReceipt(opened);
    expect(receipt.commitment).toBe(commitment);
    expect(receipt.leafIndex).toBe(LEAF);
  });

  it('is refused by the import when a secret is altered', () => {
    // `shareableNoteToReceipt` recomputes the commitment from the secrets, so a
    // corrupted or fabricated note cannot enter the store looking like money —
    // and the issuer is not trusted just because it is the issuer.
    const { note } = issue(TREASURY_SEED, POOL, LEAF);
    expect(() =>
      shareableNoteToReceipt({ ...note, secret: (BigInt(note.secret) + 1n).toString() }),
    ).toThrow(/commitment does not match/);
  });

  it('cannot be opened by anyone but the recipient', () => {
    // Sealed to one p01pq address. The negative control for the sealing step:
    // an implementation that ignored the address would pass every case above.
    const { note } = issue(TREASURY_SEED, POOL, LEAF);
    const sealed = encryptNote(
      createNoteEncryptionAddress(BUYER_SEED),
      new TextEncoder().encode(JSON.stringify(note)),
    );
    expect(() => decryptNote(new Uint8Array(32).fill(99), sealed)).toThrow();
  });

  it('gives a different note per leaf, so two issuances are never the same money', () => {
    // The inventory is a list of leaf indices and each is claimed once. If the
    // derivation ignored the index, two claims would hand out one note and the
    // second buyer would fail on a nullifier collision after ~150 uploads.
    const a = issue(TREASURY_SEED, POOL, LEAF);
    const b = issue(TREASURY_SEED, POOL, LEAF + 1);
    expect(a.commitment).not.toBe(b.commitment);
  });

  it('gives a different note per treasury, so the seed is what owns it', () => {
    const mine = issue(TREASURY_SEED, POOL, LEAF);
    const theirs = issue(new Uint8Array(32).fill(4), POOL, LEAF);
    expect(mine.commitment).not.toBe(theirs.commitment);
  });
});

describe('the field the route got wrong, in the shape the route writes it', () => {
  it('rejects a base58 mint, which is what PublicKey.toString() gives', () => {
    // 🚨 THE BUG THAT BLOCKED A LIVE TEST, AND THE REASON THE SUITE ABOVE MISSED
    // IT. Every case above builds the note with `pubkeyToField(...)` — correct,
    // and therefore a reimplementation of the route rather than a test of it.
    // The route wrote `pool.tokenMint.toString()`, which is BASE58.
    //
    // For native SOL that string is `11111111111111111111111111111111`: thirty-
    // two characters, all digits. `BigInt()` parses it as a decimal number
    // instead of throwing, so the import recomputed a commitment nothing agreed
    // with and rejected the note as "commitment does not match its secrets" — a
    // message about the secrets, for a bug in a field that is not secret.
    //
    // Any mint whose base58 contains a letter throws a SyntaxError on the first
    // attempt. Native SOL is the one value in the system that fails silently,
    // which is why this is pinned rather than left to the round trip.
    const { note } = issue(TREASURY_SEED, POOL, LEAF);
    expect(POOL.tokenMint.toBase58()).toBe('11111111111111111111111111111111');
    expect(() =>
      shareableNoteToReceipt({ ...note, token_mint: POOL.tokenMint.toString() }),
    ).toThrow(/commitment does not match/);
    // And the correct form, so the case states both halves.
    expect(() =>
      shareableNoteToReceipt({ ...note, token_mint: pubkeyToField(POOL.tokenMint).toString() }),
    ).not.toThrow();
  });
});

describe('the argument order that has already been wrong once', () => {
  it('is not symmetric — swapping secret and preimage changes the commitment', () => {
    // `createCommitmentV3(nullifierPreimage, secret, …)`. Both are bigints, so
    // the swapped call type-checks and yields a leaf that is on no tree. This
    // case exists so the mistake is caught here rather than by an on-chain
    // check after a claim has been spent.
    const { secret, nullifierPreimage } = deriveNoteMaterial(TREASURY_SEED, POOL.poolPDA, LEAF);
    const blinding = deriveNoteBlinding(TREASURY_SEED, POOL.poolPDA, LEAF);
    const mint = pubkeyToField(POOL.tokenMint);
    expect(createCommitmentV3(nullifierPreimage, secret, blinding, mint)).not.toBe(
      createCommitmentV3(secret, nullifierPreimage, blinding, mint),
    );
  });

  it('needs the mint as a FIELD, not a PublicKey', () => {
    // The route passed `pool.tokenMint` directly at first. TypeScript caught
    // that one; nothing would catch a future helper that quietly accepted both.
    expect(pubkeyToField(POOL.tokenMint)).toEqual(expect.any(BigInt));
    expect(POOL.tokenMint).toBeInstanceOf(PublicKey);
  });
});
