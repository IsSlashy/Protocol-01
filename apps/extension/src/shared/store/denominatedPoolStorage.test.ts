/**
 * WHAT THE NOTE STORE PUTS ON DISK, AND WHAT IT REFUSES TO PUT THERE.
 *
 * 🚨 THIS FILE EXISTS BECAUSE THE ANSWER USED TO BE "THE SPENDING SECRET, IN
 * DECIMAL". `serializeReceipt` writes `secret` and `nullifierPreimage` as plain
 * strings and the persist adapter was a bare `chrome.storage.local.set`, so
 * every note in the wallet was a finished withdrawal for anyone who could read
 * the profile directory: no extension privilege needed, no password, and for a
 * received or imported note no other copy of the secret anywhere.
 *
 * ⛔ THE OBVIOUS TEST IS THE USELESS ONE. Asserting that `encryptForSession`
 * returns something unreadable measures AES, which is not in doubt. What was in
 * doubt, and what is measured below, is the three ways an encryption layer
 * bolted onto an existing store loses money instead of protecting it:
 *
 *   1. It cannot read what is already on disk, so every note in every existing
 *      wallet becomes unspendable the moment the fix ships.
 *   2. A popup opened while locked reads nothing, then saves that nothing over
 *      the ciphertext.
 *   3. It "handles" a locked write by falling back to cleartext, which is the
 *      defect wearing a different hat.
 *
 * The adapter is driven DIRECTLY rather than through `persist`, because going
 * through zustand would measure its hydration timing and hide these three.
 * `never persists a secret in the clear` is the one case that does go through
 * the real store, end to end, so the wiring is pinned too.
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';

// jsdom ships `crypto.getRandomValues` but no `crypto.subtle`, and
// `sessionCrypto` is AES-256-GCM over WebCrypto. Node's implementation is the
// same algorithm, so this changes nothing the test asserts; without it the file
// cannot run at all.
if (!(globalThis.crypto as Crypto | undefined)?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
}

import { encryptedNoteStorage, useDenominatedPoolStore } from './denominatedPool';
import { useWalletStore } from './wallet';
import {
  setSessionPassword,
  clearSessionPassword,
  isEncryptedBlob,
} from '../services/sessionCrypto';
import type { ShieldReceipt } from '../services/denominatedPool';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY = 'p01-denominated-pool';
const PASSWORD = 'correct-horse-battery-staple';

/**
 * The secret every assertion below hunts for. A real 63-bit blinding-era value,
 * long enough that finding it as a substring cannot be a coincidence.
 */
const SECRET = '7284991002338477113';
const NULLIFIER_PREIMAGE = '5310015551332299001';
const COMMITMENT = '1234567890123456789';
const POOL = '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS';

/** Exactly the bytes the pre-encryption adapter left in chrome.storage.local. */
const CLEARTEXT_RECORD = JSON.stringify({
  state: {
    serializedNotes: [
      {
        secret: SECRET,
        nullifierPreimage: NULLIFIER_PREIMAGE,
        depositEpoch: '67838',
        tokenMint: '0',
        commitment: COMMITMENT,
        leafIndex: 30,
        denomination: '1000000000',
        pool: POOL,
        token: 'SOL',
        denominationHuman: 1,
        shieldedAt: 1756000000000,
        source: 'received',
      },
    ],
    counterByPool: { [POOL]: 3 },
  },
  version: 0,
});

const RECEIPT: ShieldReceipt = {
  secret: BigInt(SECRET),
  nullifierPreimage: BigInt(NULLIFIER_PREIMAGE),
  depositEpoch: 67838n,
  tokenMint: 0n,
  commitment: BigInt(COMMITMENT),
  leafIndex: 30,
  denomination: 1_000_000_000n,
  pool: POOL,
  token: 'SOL',
  denominationHuman: 1,
  shieldedAt: 1_756_000_000_000,
  source: 'received',
};

// ---------------------------------------------------------------------------
// Lock / unlock, driven the way the wallet store drives them
// ---------------------------------------------------------------------------

function unlockSession(): void {
  setSessionPassword(PASSWORD);
}

async function lockSession(): Promise<void> {
  clearSessionPassword();
  // `clearSessionPassword` removes the stored copy without awaiting it. Clear
  // the area too so `loadSessionPassword` cannot win a race and report a
  // password this test believes is gone.
  await chrome.storage.session.clear();
}

async function diskValue(): Promise<unknown> {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY];
}

/**
 * Poll rather than sleep. `persist` saves on a later tick and every save runs
 * PBKDF2 at 100,000 iterations, so a fixed delay is a machine-speed lottery.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  // The store hydrates at import. Let that settle so its read cannot land in
  // the middle of a test and reset the adapter's refusal flag.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(async () => {
  await chrome.storage.local.clear();
  await lockSession();
  useWalletStore.setState({ isUnlocked: false });
  useDenominatedPoolStore.setState({ serializedNotes: [], counterByPool: {} });
  // An empty disk is a TRUTHFUL read, so this also clears any refusal left by
  // the previous test.
  await encryptedNoteStorage.getItem(KEY);
});

// ---------------------------------------------------------------------------

describe('a cleartext record already on disk', () => {
  it('still opens, byte for byte', async () => {
    await chrome.storage.local.set({ [KEY]: CLEARTEXT_RECORD });

    // No password. A legacy record has to open with the wallet still locked,
    // or hydration would refuse the notes of every wallet that predates this.
    expect(await encryptedNoteStorage.getItem(KEY)).toBe(CLEARTEXT_RECORD);
  });

  it('is rewritten encrypted on the next save, and reads back identical', async () => {
    await chrome.storage.local.set({ [KEY]: CLEARTEXT_RECORD });
    const migrated = await encryptedNoteStorage.getItem(KEY);
    expect(migrated).toBe(CLEARTEXT_RECORD);

    unlockSession();
    await encryptedNoteStorage.setItem(KEY, migrated as string);

    const onDisk = await diskValue();
    expect(isEncryptedBlob(onDisk)).toBe(true);
    expect(typeof onDisk).not.toBe('string');
    expect(JSON.stringify(onDisk)).not.toContain(SECRET);
    expect(JSON.stringify(onDisk)).not.toContain(NULLIFIER_PREIMAGE);

    // One way and lossless: the notes are still there, unchanged.
    expect(await encryptedNoteStorage.getItem(KEY)).toBe(CLEARTEXT_RECORD);
  });
});

describe('a locked session', () => {
  /** Put a real encrypted record on disk, then lock. */
  async function seedEncryptedThenLock(): Promise<unknown> {
    unlockSession();
    await encryptedNoteStorage.setItem(KEY, CLEARTEXT_RECORD);
    const blob = await diskValue();
    expect(isEncryptedBlob(blob)).toBe(true);
    await lockSession();
    return blob;
  }

  it('reads what it can and does not wipe the store', async () => {
    const blob = await seedEncryptedThenLock();

    // Nothing readable, so nothing returned. The point is what is NOT done.
    expect(await encryptedNoteStorage.getItem(KEY)).toBeNull();
    expect(await diskValue()).toEqual(blob);
  });

  it('refuses to write, and never writes the secret in the clear', async () => {
    const blob = await seedEncryptedThenLock();

    await encryptedNoteStorage.setItem(KEY, CLEARTEXT_RECORD);

    const after = await diskValue();
    expect(after).toEqual(blob);
    expect(typeof after).not.toBe('string');
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });

  it('still refuses to write after unlocking, until a read has succeeded', async () => {
    // THE WAY THIS FIX WOULD ITSELF LOSE NOTES. Hydration ran while locked, so
    // the store in memory is EMPTY while the disk is full. Unlock, save, and
    // the empty list encrypts straight over the notes.
    const blob = await seedEncryptedThenLock();
    expect(await encryptedNoteStorage.getItem(KEY)).toBeNull();

    unlockSession();
    const emptyStore = JSON.stringify({
      state: { serializedNotes: [], counterByPool: {} },
      version: 0,
    });
    await encryptedNoteStorage.setItem(KEY, emptyStore);

    expect(await diskValue()).toEqual(blob);
    // And the notes are still recoverable, which is the only thing that matters.
    expect(await encryptedNoteStorage.getItem(KEY)).toBe(CLEARTEXT_RECORD);
  });

  it('accepts writes again once a read has opened the store', async () => {
    await seedEncryptedThenLock();

    unlockSession();
    expect(await encryptedNoteStorage.getItem(KEY)).toBe(CLEARTEXT_RECORD);

    const nextRecord = JSON.stringify({
      state: { serializedNotes: [], counterByPool: { [POOL]: 4 } },
      version: 0,
    });
    await encryptedNoteStorage.setItem(KEY, nextRecord);
    expect(await encryptedNoteStorage.getItem(KEY)).toBe(nextRecord);
  });
});

describe('the store itself', () => {
  it('never persists a note secret in the clear', async () => {
    unlockSession();

    useDenominatedPoolStore.getState().addNote(RECEIPT);
    await waitFor(async () => (await diskValue()) !== undefined, 'the note to reach storage');

    const onDisk = await diskValue();
    expect(isEncryptedBlob(onDisk)).toBe(true);

    const serialised = JSON.stringify(onDisk);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(NULLIFIER_PREIMAGE);
    expect(serialised).not.toContain(COMMITMENT);
  });

  it('gets its notes back when the wallet unlocks after a blocked hydration', async () => {
    // THE OTHER HALF OF THE REFUSAL. Blocking the write stops the notes being
    // destroyed; it does not put them back on screen, and a user looking at an
    // empty note list is a user who re-imports a note or shields a second time.
    unlockSession();
    await encryptedNoteStorage.setItem(KEY, CLEARTEXT_RECORD);

    // A popup opening while locked: hydration reads nothing and the store is
    // left empty, with the ciphertext untouched underneath.
    await lockSession();
    await useDenominatedPoolStore.persist.rehydrate();
    expect(useDenominatedPoolStore.getState().serializedNotes).toHaveLength(0);
    expect(isEncryptedBlob(await diskValue())).toBe(true);

    // The user unlocks.
    unlockSession();
    useWalletStore.setState({ isUnlocked: true });

    await waitFor(
      () => useDenominatedPoolStore.getState().serializedNotes.length === 1,
      'the notes to come back after unlocking',
    );
    expect(useDenominatedPoolStore.getState().getNotes()[0].secret).toBe(BigInt(SECRET));
    expect(useDenominatedPoolStore.getState().counterByPool[POOL]).toBe(3);
  });
});
