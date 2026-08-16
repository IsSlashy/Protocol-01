/**
 * The offsets /explorer reads a pool at.
 *
 * WHAT WENT WRONG, AND WHY A TEST IS THE RIGHT SHAPE OF FIX
 * ────────────────────────────────────────────────────────
 * The parser carried its layout in a comment and its offsets as literals, and
 * the two disagreed. The comment ended the field list at `next_leaf_index`; the
 * literal `8 + 113` was labelled `noteCount`. 8 + 113 IS `next_leaf_index` — the
 * number of leaves ever inserted, which equals the note count only when nothing
 * has ever been spent.
 *
 * MEASURED on the live 1 SOL pool 6NUS4E5P… (devnet, 2026-08-16):
 *
 *     next_leaf_index @121 = 25      ← what the page read
 *     note_count      @169 = 6       ← what it called it
 *     total_shielded  @161 = 6_000_000_000
 *
 * `total_shielded / denomination` is 6 and confirms `note_count` independently.
 * So the page would have quoted a four-times-larger anonymity set and a
 * four-times-larger TVL — on a number whose whole job is to be honest about how
 * small the set is.
 *
 * It never actually printed that, for a second reason: the discriminator was
 * built from `account:DenominatedPool`, the V2 struct. The pools /pay writes to
 * are `DenominatedPoolV3`, so the filter matched none of them and the page
 * reported the deprecated v2 pools instead — two of which hold notes whose spend
 * instruction is commented out of the program, so their balance is not a
 * treasury and must not be shown as one.
 *
 * Two defects that cancelled into a plausible-looking page is exactly the shape
 * that survives review, so the offsets are pinned here against literals rather
 * than derived from the table that is being guarded.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { POOL_V3_OFFSETS, POOL_V3_READ_LEN } from '../../lib/metrics/onchain';

describe('DenominatedPoolV3 layout, as /explorer reads it', () => {
  it('pins every offset to the literal the program produces', () => {
    // state/pool_v3.rs:53-84, summed by hand: 8 disc + 32 authority +
    // 32 token_mint + 8 denomination + 8 epoch_delay + 32 merkle_root +
    // 1 tree_depth + 8 next_leaf_index + 32 vk_hash + 8 total_shielded.
    expect({ ...POOL_V3_OFFSETS }).toEqual({
      tokenMint: 40,
      denomination: 72,
      nextLeafIndex: 121,
      totalShielded: 161,
      noteCount: 169,
    });
  });

  it('never confuses the anonymity set with the leaves ever inserted', () => {
    // The two are 48 bytes apart and mean different things. On the measured pool
    // they are 6 and 25.
    expect(POOL_V3_OFFSETS.noteCount).not.toBe(POOL_V3_OFFSETS.nextLeafIndex);
    expect(POOL_V3_OFFSETS.noteCount - POOL_V3_OFFSETS.nextLeafIndex).toBe(48);
  });

  it('reads far enough for note_count to be in the buffer at all', () => {
    // The dataSlice was 160 bytes. note_count ends at 177, so fixing the offset
    // without widening the slice would have dropped every pool into the parser's
    // catch and reported an empty network.
    expect(POOL_V3_READ_LEN).toBe(177);
    expect(POOL_V3_READ_LEN).toBeGreaterThan(160);
    expect(POOL_V3_READ_LEN).toBeGreaterThanOrEqual(POOL_V3_OFFSETS.noteCount + 8);
  });

  it('builds the discriminator from the V3 struct name, not V2', () => {
    // Written out here so the assertion does not import the constant it guards.
    const v3 = createHash('sha256').update('account:DenominatedPoolV3').digest().subarray(0, 8);
    const v2 = createHash('sha256').update('account:DenominatedPool').digest().subarray(0, 8);

    // Pinned as literals. Comparing a hash to the same hash recomputed asserts
    // nothing at all — it agrees with itself whatever the input string is, which
    // is precisely the mistake that let `account:DenominatedPool` sit here for
    // months. These two bytes strings were read off the chain: the live 1 SOL
    // pool 6NUS4E5P… carries 0fdb9145…, not 1015c623….
    expect(v3.toString('hex')).toBe('0fdb91459434aa2a');
    expect(v2.toString('hex')).toBe('1015c623b15c448c');
    expect(v3.equals(v2)).toBe(false);
  });
});
