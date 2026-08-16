/**
 * `knownSpentNoteKeys` unions three proofs of a spend, and each exists for a
 * reason: the explicit spent record (written at spend time), the payout
 * history (retroactive proof for withdrawals made before that record existed),
 * and now the subscription records (same argument, for escrowed notes). A
 * subscription record is written only on success and names the note it
 * escrowed, so it marks that note spent instantly and offline — no RPC, no
 * scan. Records tracked by vault address carry no note identity and must
 * contribute nothing rather than a garbage key.
 *
 * Since 2026-08-12 (leak L5) the spent and payout stores persist SEALED
 * records under an opaque per-identity label, and reading them is an async
 * worker round trip. The worker is faked here with the real `noteCrypto`
 * primitives — one fixed seed per meta, so two metas behave like the two
 * distinct identities they are in production. The real handler's envelope
 * whitelist is pinned separately in `lib/privacy/pool/storeEncryption.test.ts`;
 * this file is about the union logic and the v1 cleartext fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils.js';

import {
  createNoteEncryptionAddress,
  decryptNote,
} from '@/lib/privacy/pool/noteCrypto';

// One deterministic seed per meta: same shape as production, where the seed is
// a pure function of the wallet signature the meta stands for.
function seedFor(meta: string): Uint8Array {
  return sha256(utf8ToBytes(`test-seed:${meta}`));
}

vi.mock('@/lib/privacy/workerClient', () => ({
  poolRequest: vi.fn(async (req: { kind: string; meta: string; blobs?: string[] }) => {
    const seed = seedFor(req.meta);
    if (req.kind === 'poolStoreLabel') {
      return {
        kind: 'poolStoreLabel',
        label: bytesToHex(sha256(seed)).slice(0, 32),
        legacyAddress: createNoteEncryptionAddress(seed),
      };
    }
    if (req.kind === 'poolNoteAddress') {
      return { kind: 'poolNoteAddress', address: createNoteEncryptionAddress(seed) };
    }
    if (req.kind === 'poolOpenRecords') {
      // Minimal mirror of the worker's envelope filter — enough to open what
      // this suite sealed. The real filter is pinned in storeEncryption.test.ts.
      const payouts: unknown[] = [];
      const spentKeys: string[] = [];
      const subscriptions: unknown[] = [];
      for (const blob of req.blobs ?? []) {
        try {
          const rec = JSON.parse(new TextDecoder().decode(decryptNote(seed, blob)));
          if (rec.p01store !== 1) continue;
          if (rec.kind === 'payout') payouts.push(rec);
          else if (rec.kind === 'spent') spentKeys.push(String(rec.key));
          else if (rec.kind === 'subscription') subscriptions.push(rec);
        } catch {
          // not this identity's blob
        }
      }
      return { kind: 'poolOpenRecords', payouts, spentKeys, handoffs: [], subscriptions, skipped: 0 };
    }
    throw new Error(`unexpected pool request: ${req.kind}`);
  }),
}));

import {
  knownSpentNoteKeys,
  recordPayout,
  recordSpentNote,
} from '@/lib/privacy/shieldClient';
import { recordSubscription, type StoredSubscription } from '@/lib/pay/subscriptions';

const META_W1 = 'meta-w1';
const META_W2 = 'meta-w2';

function subRec(over: Partial<StoredSubscription> = {}): StoredSubscription {
  return {
    vaultPDA: 'vault1',
    retailer: 'retailer1',
    serviceTag: 'bitwarden-test',
    token: 'SOL',
    denomination: 1,
    rate: '50000000',
    intervalSlots: '1500',
    openedAt: 1_000,
    ...over,
  };
}

describe('knownSpentNoteKeys', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('unions explicit spends, payouts, and subscription records', async () => {
    await recordSpentNote(META_W1, 'w1', 'poolA:1');
    await recordPayout(META_W1, 'w1', {
      pool: 'poolB',
      leafIndex: 2,
      address: 'addr',
      txSig: 'sig',
      denomination: 1,
    });
    await recordSubscription(META_W1, 'w1', subRec({ pool: 'poolC', leafIndex: 19 }));

    const { keys, staleWorker } = await knownSpentNoteKeys(META_W1, 'w1');
    expect(keys.has('poolA:1')).toBe(true);
    expect(keys.has('poolB:2')).toBe(true);
    // The subscribed note is spent the instant the record lands, offline.
    expect(keys.has('poolC:19')).toBe(true);
    // A worker that answered every kind is not skewed. The skewed cases are
    // pinned in lib/privacy/pool/storeEncryption.test.ts against the REAL
    // handler; this mock always answers in full.
    expect(staleWorker).toBe(false);
  });

  it('a subscription tracked by vault address contributes no key', async () => {
    // Track-by-address knows the vault but not the note that paid for it:
    // no pool, no leafIndex. It must add nothing, and certainly not a key
    // built from undefined.
    await recordSubscription(META_W1, 'w1', subRec());
    const { keys } = await knownSpentNoteKeys(META_W1, 'w1');
    expect(keys.size).toBe(0);
    expect(keys.has('undefined:undefined')).toBe(false);
  });

  it('keys are scoped per identity', async () => {
    // One identity = one meta = one seed = one store label. A second wallet is
    // a second meta in production, and must see nothing of the first.
    await recordSpentNote(META_W1, 'w1', 'poolC:19');
    await recordSubscription(META_W1, 'w1', subRec({ pool: 'poolC', leafIndex: 19 }));
    expect((await knownSpentNoteKeys(META_W2, 'w2')).keys.size).toBe(0);
  });

  it('answers from the v1 cleartext leftovers when no session exists', async () => {
    // Records written before L5 sit in the wallet-keyed v1 stores. With no
    // worker session (meta: null) they must still be served — hiding them
    // would re-offer a spent note the moment the user has not yet signed.
    localStorage.setItem('p01_pay_spent_notes_v1', JSON.stringify({ w1: ['poolA:7'] }));
    localStorage.setItem(
      'p01_pay_pool_payouts_v1',
      JSON.stringify({
        w1: [{ pool: 'poolB', leafIndex: 9, address: 'addr', txSig: 'sig', denomination: 1 }],
      }),
    );
    const { keys, staleWorker } = await knownSpentNoteKeys(null, 'w1');
    expect(keys.has('poolA:7')).toBe(true);
    expect(keys.has('poolB:9')).toBe(true);
    // No session is not skew: the v1 view above is complete.
    expect(staleWorker).toBe(false);
  });
});
