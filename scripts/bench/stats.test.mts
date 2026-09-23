/**
 * node --test scripts/bench/stats.test.mts
 *
 * Known arrays, including an even n and ties, so a wrong median or an
 * off-by-one p90 fails here and not in a published table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { median, p90, percentile, summarize } from './stats.mts';

test('median of an odd n is the middle value', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([7]), 7);
});

test('median of an even n is the mean of the two middle values, not the upper one', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([10, 20]), 15);
  // 1..30: the two middle values are 15 and 16.
  assert.equal(median(Array.from({ length: 30 }, (_, i) => i + 1)), 15.5);
});

test('median with ties', () => {
  assert.equal(median([2, 2, 2, 9]), 2);
  assert.equal(median([1, 3, 3, 3, 8, 8]), 3);
  assert.equal(median([1, 3, 8, 8]), 5.5);
});

test('p90 is nearest-rank: an observed value, ceil(0.9 n)-th smallest', () => {
  assert.equal(p90([5, 1, 3]), 5); // rank ceil(2.7) = 3
  assert.equal(p90([4, 1, 3, 2]), 4); // rank ceil(3.6) = 4
  assert.equal(p90(Array.from({ length: 30 }, (_, i) => i + 1)), 27); // rank 27 exactly
  assert.equal(p90(Array.from({ length: 100 }, (_, i) => i + 1)), 90);
  assert.equal(p90(Array.from({ length: 31 }, (_, i) => i + 1)), 28); // rank ceil(27.9) = 28
  assert.equal(p90([7]), 7);
});

test('p90 with ties is below the max when the tail is one outlier', () => {
  // n = 10: rank 9 is the last of the nine 2s, the outlier 10 is only the max.
  assert.equal(p90([1, 2, 2, 2, 2, 2, 2, 2, 2, 10]), 2);
  assert.equal(p90([3, 3, 3, 3]), 3);
});

test('percentile bounds', () => {
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
  assert.equal(percentile([1, 2, 3, 4], 1), 1);
  assert.throws(() => percentile([1, 2], 0));
  assert.throws(() => percentile([1, 2], 101));
  assert.throws(() => percentile([1, 2], 90.5));
});

test('summarize: min, median, p90, max, spread, ratio, mean', () => {
  const s = summarize([400, 100, 300, 200]);
  assert.deepEqual(s, { n: 4, min: 100, median: 250, p90: 400, max: 400, mean: 250, spread: 300, ratio: 4 });
  assert.equal(summarize([0, 5]).ratio, null);
});

test('refuses empty and non-finite input, never mutates the input', () => {
  assert.throws(() => summarize([]));
  assert.throws(() => median([1, Number.NaN]));
  assert.throws(() => p90([1, Number.POSITIVE_INFINITY]));
  const xs = [3, 1, 2];
  summarize(xs);
  assert.deepEqual(xs, [3, 1, 2]);
});
