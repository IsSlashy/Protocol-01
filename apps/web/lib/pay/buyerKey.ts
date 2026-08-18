/**
 * The buyer key that is not a wallet, and that survives a reload.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `PayApp.tsx` used to create this identity with `Keypair.generate()` straight
 * into `useState`. It therefore lived exactly as long as the tab, and the app
 * sealed notes and derived license keys to it anyway.
 *
 * That is not a theoretical hazard. MEASURED 2026-08-17/18, devnet: a reload
 * regenerated the identity three times in one evening. Each time, a note the
 * deployment had already issued and sealed to the previous address became
 * unopenable, and the single-use claim code that paid for it was already spent.
 * `app/api/issue-note/route.ts` re-seals the same leaf to the same recipient
 * exactly so a retry recovers — and that branch could never once fire, because
 * the recipient address never survived long enough to ask twice.
 *
 * So the key is persisted. Everything downstream is unchanged: `p01Keypair`
 * already substitutes for the wallet adapter throughout `PayApp.tsx`.
 *
 * ⛔ WHAT THIS IS NOT
 * ───────────────────
 * It is NOT encrypted at rest, and it cannot be. `sealedStore` encrypts under
 * `meta`, and on this path `meta` is derived by signing WITH this key — so the
 * key cannot protect itself. Anything that reads this browser's origin storage
 * reads the key, and the key alone can spend the notes and open every
 * subscription bought with it.
 *
 * Callers must say that to the user rather than let this comment be the only
 * place it is written down.
 */

import { Keypair } from '@solana/web3.js';

/**
 * Versioned on purpose. A future format change must not silently reinterpret
 * bytes that spend money; it gets a new key and leaves this one readable.
 */
export const BUYER_KEY_STORAGE = 'p01_buyer_key_v1';

/** Where the backup acknowledgement lives, keyed per identity. */
const BACKED_UP_PREFIX = 'p01_buyer_key_backed_up_v1:';

/**
 * Is origin storage usable at all?
 *
 * Private windows, embedded webviews and storage-partitioned iframes all throw
 * or silently no-op here. A caller that skips this check hands out an identity
 * that dies on the next navigation — which is the exact failure this module was
 * written to end, reintroduced through the back door.
 */
export function storageAvailable(): boolean {
  try {
    const probe = '__p01_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** Read the stored buyer key, or null when there is none or it is unusable. */
export function loadBuyerKey(): Keypair | null {
  try {
    const raw = window.localStorage.getItem(BUYER_KEY_STORAGE);
    if (!raw) return null;
    const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
    // A truncated or hand-edited value must not throw halfway through app boot.
    if (bytes.length !== 64) return null;
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

/**
 * Persist a buyer key.
 *
 * Returns false when storage refused, and the caller must treat that as fatal
 * rather than continuing with an in-memory identity: a note sealed to a key
 * that cannot be reloaded is money the user cannot reach.
 */
export function saveBuyerKey(kp: Keypair): boolean {
  try {
    window.localStorage.setItem(BUYER_KEY_STORAGE, JSON.stringify([...kp.secretKey]));
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget the stored key.
 *
 * ⚠️ This is destructive in the way that matters: the license key of every
 * subscription bought under it is recomputed from the note's secret, so a
 * cleared key with no saved copy is a subscription that can never be shown
 * again. Callers confirm before calling.
 */
export function clearBuyerKey(): void {
  try {
    const kp = loadBuyerKey();
    window.localStorage.removeItem(BUYER_KEY_STORAGE);
    if (kp) window.localStorage.removeItem(BACKED_UP_PREFIX + kp.publicKey.toBase58());
  } catch {
    /* nothing stored, nothing to forget */
  }
}

/** The 64-byte secret as hex — what the user copies or downloads. */
export function exportBuyerKeyHex(kp: Keypair): string {
  return [...kp.secretKey].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse a pasted or imported secret back into a keypair.
 *
 * Accepts the hex this module exports, and a JSON byte array, because that is
 * what `solana-keygen` writes and someone will paste one.
 */
export function importBuyerKeyHex(text: string): Keypair | null {
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith('[')) {
      const bytes = Uint8Array.from(JSON.parse(trimmed) as number[]);
      return bytes.length === 64 ? Keypair.fromSecretKey(bytes) : null;
    }
    const hex = trimmed.replace(/\s+/g, '').toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(hex)) return null;
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return Keypair.fromSecretKey(bytes);
  } catch {
    return null;
  }
}

/** Has this identity been through the backup step? */
export function isBackedUp(pubkey: string): boolean {
  try {
    return window.localStorage.getItem(BACKED_UP_PREFIX + pubkey) === '1';
  } catch {
    return false;
  }
}

/** Record that the user copied or downloaded the secret and typed it back. */
export function markBackedUp(pubkey: string): void {
  try {
    window.localStorage.setItem(BACKED_UP_PREFIX + pubkey, '1');
  } catch {
    /* the gate simply asks again next time, which is the safe direction */
  }
}

/**
 * The check the backup step asks for.
 *
 * The last four characters of the secret, case-insensitive. Enough to prove the
 * user actually has the value in front of them, short enough that nobody
 * defeats the gate by clicking through — which is the only thing it is for.
 */
export function backupAnswerMatches(kp: Keypair, answer: string): boolean {
  const hex = exportBuyerKeyHex(kp);
  return answer.trim().toLowerCase() === hex.slice(-4);
}
