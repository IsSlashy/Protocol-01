/**
 * `knownSpentNoteKeys` unions three proofs of a spend, and each exists for a
 * reason: the explicit spent record (written at spend time), the payout
 * history (retroactive proof for withdrawals made before that record existed),
 * and now the subscription records (same argument, for escrowed notes). A
 * subscription record is written only on success and names the note it
 * escrowed, so it marks that note spent instantly and offline — no RPC, no
 * scan. Records tracked by vault address carry no note identity and must
 * contribute nothing rather than a garbage key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The worker boundary is not under test; importing shieldClient must not boot one.
vi.mock('@/lib/privacy/workerClient', () => ({ poolRequest: vi.fn() }));

import {
  knownSpentNoteKeys,
  recordPayout,
  recordSpentNote,
} from '@/lib/privacy/shieldClient';
import { recordSubscription, type StoredSubscription } from '@/lib/pay/subscriptions';

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

  it('unions explicit spends, payouts, and subscription records', () => {
    recordSpentNote('w1', 'poolA:1');
    recordPayout('w1', {
      pool: 'poolB',
      leafIndex: 2,
      address: 'addr',
      txSig: 'sig',
      denomination: 1,
    });
    recordSubscription('w1', subRec({ pool: 'poolC', leafIndex: 19 }));

    const keys = knownSpentNoteKeys('w1');
    expect(keys.has('poolA:1')).toBe(true);
    expect(keys.has('poolB:2')).toBe(true);
    // The subscribed note is spent the instant the record lands, offline.
    expect(keys.has('poolC:19')).toBe(true);
  });

  it('a subscription tracked by vault address contributes no key', () => {
    // Track-by-address knows the vault but not the note that paid for it:
    // no pool, no leafIndex. It must add nothing, and certainly not a key
    // built from undefined.
    recordSubscription('w1', subRec());
    const keys = knownSpentNoteKeys('w1');
    expect(keys.size).toBe(0);
    expect(keys.has('undefined:undefined')).toBe(false);
  });

  it('keys are scoped per wallet', () => {
    recordSubscription('w1', subRec({ pool: 'poolC', leafIndex: 19 }));
    expect(knownSpentNoteKeys('w2').size).toBe(0);
  });
});
