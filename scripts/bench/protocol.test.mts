/**
 * node --test scripts/bench/protocol.test.mts
 *
 * manifest.json must say which protocol a run measured. Against the tree as it
 * is: v1 as deployed, a pre-v2 baseline. When WP10 moves the client to v5,
 * these values change and this test says so before a run is labelled wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readProtocol, BASELINE_LABEL } from './protocol.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the manifest protocol block reads v1 as deployed from the source tree', () => {
  const p = readProtocol(ROOT);
  assert.deepEqual(p.errors, []);
  assert.equal(p.verifier_program_id, 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs');
  assert.equal(p.pool_program_id, 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c');
  assert.deepEqual(p.pool, {
    token: 'SOL', denomination_sol: 1,
    pool_pda: '6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS',
    tree_pda: 'GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi',
    pool_version: 'v3',
  });
  assert.equal(p.routes.deposit!.instruction, 'shield_denominated_v3');
  assert.equal(p.routes.withdrawal!.instruction, 'unshield_denominated_stark_v4');
  assert.equal(p.routes.subscription!.instruction, 'subscribe_private_stark_v4');
  for (const r of Object.values(p.routes)) assert.ok(r.found, r.instruction);
  assert.match(BASELINE_LABEL, /pre-v2 \(pre-WP10\) baseline/);
});

test('a tree without the sources reports errors instead of empty ids', () => {
  const p = readProtocol(path.join(ROOT, 'does-not-exist'));
  assert.ok(p.errors.length >= 3);
  assert.equal(p.pool, null);
});
