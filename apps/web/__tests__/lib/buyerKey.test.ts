/**
 * The buyer key that must survive a reload.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THESE CASES. A key that does not come back is money that does not come
 * back: notes are sealed to it and license keys are recomputed from the note it
 * spends. MEASURED 2026-08-17/18 — three reloads, three orphaned identities,
 * three spent claim codes. So the round trip is pinned, and so is the refusal
 * to hand back something that is not exactly a key.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  BUYER_KEY_STORAGE,
  loadBuyerKey,
  saveBuyerKey,
  clearBuyerKey,
  exportBuyerKeyHex,
  importBuyerKeyHex,
  isBackedUp,
  markBackedUp,
  backupAnswerMatches,
  storageAvailable,
} from '@/lib/pay/buyerKey';

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('the round trip', () => {
  it('gives back the same key after a reload', () => {
    const kp = Keypair.generate();
    expect(saveBuyerKey(kp)).toBe(true);
    const back = loadBuyerKey();
    expect(back?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    // The SECRET, not just the address: an identity that can be named but not
    // spent from is the same loss wearing a different face.
    expect(back && [...back.secretKey]).toEqual([...kp.secretKey]);
  });

  it('returns null when nothing was stored', () => {
    expect(loadBuyerKey()).toBeNull();
  });

  it('returns null rather than throwing on a corrupt value', () => {
    // Hand-edited storage, a half-written value, a format from another app.
    // This runs during app boot, so a throw here is a blank page.
    for (const junk of ['not json', '[]', '[1,2,3]', '{}', 'null']) {
      window.localStorage.setItem(BUYER_KEY_STORAGE, junk);
      expect(loadBuyerKey(), junk).toBeNull();
    }
  });

  it('forgets the key on clear', () => {
    const kp = Keypair.generate();
    saveBuyerKey(kp);
    markBackedUp(kp.publicKey.toBase58());
    clearBuyerKey();
    expect(loadBuyerKey()).toBeNull();
    // The backup acknowledgement goes with it, or a NEW key inherits the old
    // one's "already backed up" and the gate never fires again.
    expect(isBackedUp(kp.publicKey.toBase58())).toBe(false);
  });
});

describe('storage that refuses', () => {
  it('reports unavailable rather than pretending', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(storageAvailable()).toBe(false);
  });

  it('reports a failed save, so the caller can refuse to continue', () => {
    // ⛔ The dangerous shape is a save that quietly does nothing: the app would
    // hand out an identity, seal a paid note to it, and lose it on reload —
    // exactly the bug this module exists to end.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(saveBuyerKey(Keypair.generate())).toBe(false);
  });
});

describe('export and import', () => {
  it('round-trips through hex', () => {
    const kp = Keypair.generate();
    const hex = exportBuyerKeyHex(kp);
    expect(hex).toHaveLength(128);
    expect(importBuyerKeyHex(hex)?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('accepts the JSON byte array solana-keygen writes', () => {
    const kp = Keypair.generate();
    const json = JSON.stringify([...kp.secretKey]);
    expect(importBuyerKeyHex(json)?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('tolerates whitespace and case from a copy-paste', () => {
    const kp = Keypair.generate();
    const hex = exportBuyerKeyHex(kp).toUpperCase();
    expect(importBuyerKeyHex(`  ${hex}\n`)?.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('refuses anything that is not exactly a key', () => {
    for (const junk of ['', 'hello', 'ab'.repeat(63), 'zz'.repeat(64), '[1,2,3]']) {
      expect(importBuyerKeyHex(junk), junk).toBeNull();
    }
  });
});

describe('the backup gate', () => {
  it('accepts the last four characters of the secret, any case', () => {
    const kp = Keypair.generate();
    const hex = exportBuyerKeyHex(kp);
    expect(backupAnswerMatches(kp, hex.slice(-4))).toBe(true);
    expect(backupAnswerMatches(kp, hex.slice(-4).toUpperCase())).toBe(true);
    expect(backupAnswerMatches(kp, ` ${hex.slice(-4)} `)).toBe(true);
  });

  it('refuses an empty answer, so a blank field cannot pass the gate', () => {
    // The gate exists to prove the user has the value in front of them. An
    // empty string trivially "matching" would make it decorative.
    expect(backupAnswerMatches(Keypair.generate(), '')).toBe(false);
    expect(backupAnswerMatches(Keypair.generate(), '   ')).toBe(false);
  });

  it('refuses the wrong four characters', () => {
    const kp = Keypair.generate();
    const hex = exportBuyerKeyHex(kp);
    expect(backupAnswerMatches(kp, hex.slice(0, 4))).toBe(false);
  });

  it('is remembered per identity, never globally', () => {
    const a = Keypair.generate();
    const b = Keypair.generate();
    markBackedUp(a.publicKey.toBase58());
    expect(isBackedUp(a.publicKey.toBase58())).toBe(true);
    expect(isBackedUp(b.publicKey.toBase58())).toBe(false);
  });
});
