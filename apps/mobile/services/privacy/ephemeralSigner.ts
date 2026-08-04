/**
 * ephemeralSigner — the deterministic per-operation signers the pool flows use,
 * and the one place their key material is decided.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 * ───────────────────────────────
 * Every ephemeral-signer derivation in `stores/denominatedPoolStore.ts` used to
 * be, verbatim:
 *
 *   hmac(sha256, key = utf8(walletAddress), msg = utf8(label))
 *
 * and BOTH inputs are public. `walletAddress` is a public key. The labels are
 * built from public values too:
 *
 *   `stealth_shield_v1_${poolPDA}_${counter}`   pool PDA is public, counter
 *                                               starts at 0 and increments
 *   `stealth_unshield_v3_${noteId}`             noteId is the first 16 hex
 *                                               chars of a commitment, and the
 *                                               commitment travels in cleartext
 *                                               in the shield instruction data
 *
 * An HMAC over two public values is not a key derivation — it is a public
 * function. Anyone could enumerate a candidate wallet's ephemeral signers
 * offline and recompute their PRIVATE keys. That gave an attacker two things:
 *
 *   1. the lamports sitting at that address. On the shield path that is the
 *      WHOLE DENOMINATION plus rent, parked there before the shield executes;
 *      on the withdrawal paths it is the pre-funded proof-buffer rent (~1.01
 *      SOL per buffer, two buffers on a V3 unshield).
 *   2. a deanonymisation oracle. Derive a candidate wallet's ephemeral address
 *      for a known public commitment, look it up on chain, and the wallet↔note
 *      link is proven from public data with no heuristics.
 *
 * The comment that used to sit at those call sites argued "privacy is preserved
 * because each (pool, counter) tuple is used at most once". That is an argument
 * about COLLISION, not about SECRECY. Uniqueness is not unpredictability. The
 * same reasoning error is written up in the memory note
 * `fix-stealth-signer-public-derivation-2026-08-03`.
 *
 * WHAT REPLACES IT
 * ────────────────
 * The same construction keyed on the wallet's SECRET seed —
 * `deriveLocalNoteSeed().noteSeed`, i.e. `secretKey[0..32)`, which is already
 * the key material every note secret in this app derives from
 * (`services/denominatedPool/index.ts:332-343`). Determinism, and therefore
 * crash-resumability, is unchanged: same wallet, same label, same signer. What
 * changes is that an observer cannot compute it.
 *
 * WHY THE LEGACY BRANCH EXISTS AND MUST NOT BE DELETED YET
 * ───────────────────────────────────────────────────────
 * Changing the derivation makes every previously-funded address unreachable by
 * the app. A user who updates mid-flow would strand real lamports — a worse bug
 * than the one being fixed. `legacy` reproduces the OLD address so the recovery
 * paths can sweep it. It is never used to sign anything new.
 *
 * WHEN IT CAN BE DELETED: only once no funded legacy address remains on any
 * cluster this app talks to. That is an observation about the chain, not about
 * the code, so it cannot be settled here. Concretely: enumerate, for every
 * wallet this build has served, `deriveLegacyEphemeral(addr, label)` over the
 * labels in `EPHEMERAL_LABELS` and the counters/noteIds that wallet used, and
 * confirm every one has a zero balance. Until someone does that and writes the
 * result down, this branch stays.
 */

import {
  Keypair as SolKeypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

import { deriveLocalNoteSeed } from '../solana/wallet';

/**
 * The label namespaces in use. Listed so the legacy-sweep audit above has a
 * definite set to enumerate rather than a grep.
 */
export const EPHEMERAL_LABELS = [
  'stealth_shield_v1_${poolPDA}_${counter}',
  'stealth_shield_v3_${poolPDA}_${counter}',
  'stealth_unshield_${noteId}',
  'stealth_unshield_v3_${noteId}',
  'stealth_transfer_stark_${noteId}',
  'stealth_transfer_v3_${noteId}',
] as const;

/** Lamports left behind by a sweep so the sweep transaction can pay for itself. */
export const SWEEP_FEE_RESERVE = 5_000;

/**
 * The current derivation: HMAC keyed on the wallet's SECRET seed.
 *
 * Pure and synchronous so it can be tested without a wallet, a device, or a
 * network. `noteSeed` MUST be secret key material — passing a public key here
 * reintroduces exactly the defect this module exists to close.
 */
export function deriveEphemeralFromSecretSeed(
  noteSeed: Uint8Array,
  label: string,
): SolKeypair {
  if (noteSeed.length < 32) {
    throw new Error(
      `deriveEphemeralFromSecretSeed: seed too short (${noteSeed.length} bytes, need >= 32)`,
    );
  }
  return SolKeypair.fromSeed(hmac(sha256, noteSeed, new TextEncoder().encode(label)));
}

/**
 * The OLD, publicly-computable derivation. Read-only recovery use.
 *
 * Exported and named so that a call site using it is obvious in review. Never
 * sign a new operation with the result — the private key is derivable by
 * anyone holding the wallet address, which is everyone.
 */
export function deriveLegacyEphemeral(walletAddr: string, label: string): SolKeypair {
  return SolKeypair.fromSeed(
    hmac(sha256, new TextEncoder().encode(walletAddr), new TextEncoder().encode(label)),
  );
}

/**
 * Resolve both signers for one operation label: the one that will be used, and
 * the pre-fix one that may still be holding funds.
 *
 * `legacyWalletAddr` is whatever the old call site fed into the HMAC key slot —
 * on the unshield paths that was `walletSigner?.publicKey ?? recipientAddress`,
 * so it must be passed through verbatim or the legacy address will not match
 * and the recovery sweep will silently find nothing.
 */
export async function deriveStealthSigners(
  label: string,
  legacyWalletAddr: string,
): Promise<{ current: SolKeypair; legacy: SolKeypair | null }> {
  const { noteSeed } = await deriveLocalNoteSeed();
  return {
    current: deriveEphemeralFromSecretSeed(noteSeed, label),
    legacy: legacyWalletAddr ? deriveLegacyEphemeral(legacyWalletAddr, label) : null,
  };
}

/**
 * Move everything at the legacy ephemeral address to `destination`, if any
 * lamports are still there.
 *
 * Best-effort by design: an empty legacy address is the expected case, and a
 * failure here must never mask the real error a caller is already handling.
 */
export async function sweepLegacyStealth(
  connection: Connection,
  legacy: SolKeypair | null,
  destination: PublicKey,
): Promise<void> {
  if (!legacy) return;
  try {
    const bal = await connection.getBalance(legacy.publicKey, 'confirmed');
    if (bal <= SWEEP_FEE_RESERVE) return;
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: legacy.publicKey,
        toPubkey: destination,
        lamports: bal - SWEEP_FEE_RESERVE,
      }),
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = legacy.publicKey;
    tx.sign(legacy);
    await sendAndConfirmTransaction(connection, tx, [legacy], { commitment: 'confirmed' });
    console.log(
      `[EphemeralSigner] legacy-sweep recovered ${bal - SWEEP_FEE_RESERVE} lamports from ` +
        legacy.publicKey.toBase58(),
    );
  } catch (e) {
    console.warn('[EphemeralSigner] legacy-sweep failed (pre-fix funds may remain):', e);
  }
}
