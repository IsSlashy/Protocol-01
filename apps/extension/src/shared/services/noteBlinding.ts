/**
 * noteBlinding — the secret that makes a note's commitment unguessable.
 *
 * PORTED VERBATIM from apps/web/lib/privacy/pool/noteBlinding.ts on 2026-08-25,
 * alongside the mobile copy at
 * apps/mobile/services/denominatedPool/noteBlinding.ts. All three must derive
 * byte-identical values; see the domain-separator note below.
 *
 * THE PROBLEM IT SOLVES
 * ─────────────────────
 * A note's commitment is
 *
 *   commitment = poseidon(nullifier, poseidon(deposit_epoch, token_mint))
 *
 * and a withdrawal MUST publish the nullifier — it is the double-spend guard and
 * a PDA seed. With `deposit_epoch = slot / 7200`, `token_mint` fixed per pool,
 * and the nullifier public, an observer enumerates a few thousand candidate
 * epochs, recomputes the commitment, and matches it to the exact deposit leaf.
 * Anonymity set: one.
 *
 * So we put 63 bits of secret there instead, and the commitment stops being
 * computable from the nullifier.
 *
 * 🚨 THIS IS HALF OF A TWO-PART FIX, AND THIS CLIENT WAS MISSING ITS HALF.
 * Circuit 7 stops the withdrawal from publishing the commitment as an argument;
 * this stops it being RECOMPUTABLE from the argument the withdrawal cannot help
 * publishing. C7 went live on devnet on 2026-08-25 while this file did not
 * exist, so every note minted from this extension was relinkable to its deposit
 * no matter what the circuit did. Two files here already NAMED the gap, in the
 * future tense — "once this client adopts the PRF commitment blinding already
 * shipped in apps/web" (denominatedPool.ts, twice). This is that adoption.
 *
 * ⛔ DO NOT "FIX" THE INFO STRING. It says `web` and it must keep saying `web`
 * on all three surfaces. It is a domain separator, not a label: change it here
 * and a note deposited from the web app derives a DIFFERENT blinding in the
 * extension, which makes it unspendable — the funds are on chain and no client
 * can name them.
 *
 * ⛔ THE LANDMINE, and this file is where it arms. `ShieldReceipt.depositEpoch`
 * stops being an epoch and becomes a ~63-bit SECRET the moment this is wired in.
 * Publishing it hands the blinding factor to an observer and makes the whole
 * thing pointless. The known channel is the `min_epoch` instruction argument,
 * which this client already pins to `0n` on all three spend paths — that pin was
 * landed for exactly this day and must not be relaxed. The on-chain handler
 * ignores the value anyway (`unshield_denominated_stark_v3.rs`:
 * `let _ = (…, min_epoch, …)`).
 *
 * ⚠️ NO SEED-BASED RESCAN EXISTS IN THIS CLIENT. `deriveNoteMaterial` has one
 * production call site (the shield below); notes are recovered from local
 * storage only. That is a PRE-EXISTING limitation, not something this file
 * introduces — but it means a wiped profile loses extension-minted notes with or
 * without blinding, and it is why apps/web and apps/mobile carry a legacy-epoch
 * fallback in their scanners and this one has nothing to carry.
 */

import type { PublicKey } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** ⛔ Verbatim from apps/web. See the domain-separator note in the header. */
const BLINDING_INFO = utf8ToBytes('p01:web:note-blinding:v1');

/**
 * 63-bit mask. The AIR reduces this input mod the Goldilocks prime
 * (2^64 − 2^32 + 1), so any u64 is *accepted*, but values above the prime alias
 * onto smaller ones. Staying under 2^63 keeps the mapping injective, so the
 * blinding we derive is exactly the blinding the circuit uses.
 */
const MASK_63 = (1n << 63n) - 1n;

/**
 * Derive a note's blinding from the pool seed, the pool, and the leaf index the
 * note occupies — the same inputs the note's other secrets use.
 *
 * `leafIndex` is the same `counter` that `deriveNoteMaterial` takes, so the two
 * derivations always describe the same note.
 */
export function deriveNoteBlinding(
  walletSeed: Uint8Array,
  poolPDA: PublicKey,
  leafIndex: number,
): bigint {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, leafIndex, true);
  const bytes = hkdf(
    sha256,
    walletSeed,
    undefined,
    concatBytes(BLINDING_INFO, poolPDA.toBytes(), idx),
    8,
  );
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n & MASK_63;
}
