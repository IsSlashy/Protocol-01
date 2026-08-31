/**
 * ONE DEPTH, IN EVERY PLACE THAT MIRRORS IT — the wire that broke every v4 spend.
 *
 * 🚨 THE FACT THIS PINS, AND IT WAS LIVE. Circuit 7's subtree depth moved to 11
 * on the Rust side (`stark/src/air/spend.rs` CANONICAL_DEPTH, the shipped
 * prover's own arity check in `stark/src/lib.rs`, and the on-chain verifier).
 * `denominatedPool.ts` followed and slices the Merkle path to 11. The two
 * JavaScript prover front-ends on this stack did NOT: both still demanded
 * exactly 12, and both throw BEFORE the wasm is ever called. So every circuit-7
 * spend from the web client — every v4 withdrawal — failed on an arity error
 * that reads like a caller bug, and the guard's own comment insisted the depth
 * was 12.
 *
 * Nothing caught it. The only test that exercises the real path is
 * `liveRelayedUnshieldV4.test.ts`, which is `describe.skipIf(!LIVE)` and does
 * not run in CI. A constant written on both sides of a wire and moved on only
 * one is the failure this repository keeps paying for; this file is the cheap
 * check that makes the next move loud.
 *
 * ⚠️ SCOPE: WEB AND THE PUBLISHED PACKAGE ONLY, DELIBERATELY.
 * The extension and mobile stacks carry the same constants and are MEASURED to
 * be a full wave behind — at BOTH layers, guard and slice:
 *
 *     apps/extension/src/shared/services/denominatedPool.ts   C3/C6/C7 = 12
 *     apps/extension/src/shared/workers/starkProver.worker.ts guard    = 12
 *     apps/mobile/services/denominatedPool/index.ts           C3/C6/C7 = 12
 *     apps/mobile/services/stark/StarkProver.tsx              guard    = 12
 *
 * against a Rust CANONICAL_DEPTH of 11 in all three AIRs. Neither surface can
 * produce a proof the deployed verifier accepts, for any circuit that walks a
 * Merkle path. They are NOT asserted here and NOT edited: those stacks ship
 * separately and changing them is the owner's call, not this suite's. Recorded
 * so the next reader finds it as a measurement rather than rediscovering it.
 *
 * ⛔ RUST IS THE SOURCE OF TRUTH. The circuit decides the depth; TypeScript
 * mirrors it. If this test fails, fix the mirror — do not change the Rust to
 * match a client.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { C7_SUBTREE_DEPTH } from '@/lib/privacy/pool/denominatedPool';

/** apps/web/__tests__/lib -> repository root */
const ROOT = join(__dirname, '../../../..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** The single integer a `const NAME = <n>` or `const NAME: usize = <n>` declares. */
function constant(source: string, name: string, file: string): number {
  const m = source.match(new RegExp(`${name}(?::\\s*usize)?\\s*=\\s*(\\d+)`));
  expect(m, `${name} is gone from ${file} — the guard it protects is unpinned`).toBeTruthy();
  return Number(m![1]);
}

describe("circuit 7's subtree depth", () => {
  const truth = constant(
    read('stark/src/air/spend.rs'),
    'pub const CANONICAL_DEPTH',
    'stark/src/air/spend.rs',
  );

  it('is a real depth, not a parse accident', () => {
    // Anti-vacuity: a regex that matched nothing would make every case below
    // compare undefined to undefined and pass.
    expect(truth).toBeGreaterThan(1);
    expect(truth).toBeLessThan(32);
  });

  it('is what the shipped Rust prover enforces, by name and not by literal', () => {
    // `stark/src/lib.rs` must keep checking against CANONICAL_DEPTH rather than
    // a number of its own. A literal there would be one more place to forget.
    expect(
      read('stark/src/lib.rs'),
      'the shipped prover stopped checking the path against CANONICAL_DEPTH',
    ).toMatch(/path_elements\.len\(\)\s*!=\s*CANONICAL_DEPTH/);
  });

  it('is what denominatedPool slices the Merkle path to', () => {
    expect(C7_SUBTREE_DEPTH, 'the pool client disagrees with the circuit').toBe(truth);
  });

  it('is what the web worker front-end accepts', () => {
    // 🚨 THIS IS THE ONE THAT WAS WRONG. It was 12 against a circuit of 11, and
    // it rejects before the wasm runs, so the shipped prover never got a say.
    const worker = read('apps/web/lib/privacy/pool/starkProver.worker.ts');
    expect(
      constant(worker, 'const C7_PATH_DEPTH', 'apps/web/lib/privacy/pool/starkProver.worker.ts'),
      'the web worker rejects the path the pool client builds',
    ).toBe(truth);
    expect(worker, 'the arity guard is a bare literal again').not.toMatch(
      /data\.pathElements\.length\s*!==\s*\d/,
    );
  });

  it('is what the published npm front-end accepts', () => {
    // Same guard, second copy, shipped to other people. It broke identically.
    const pkg = read('packages/stark-prover/src/index.ts');
    expect(
      constant(pkg, 'const C7_PATH_DEPTH', 'packages/stark-prover/src/index.ts'),
      'the published prover rejects the path the pool client builds',
    ).toBe(truth);
    expect(pkg, 'the arity guard is a bare literal again').not.toMatch(
      /elements\.length\s*!==\s*\d/,
    );
  });
});

describe('the three merkle circuits agree with this stack', () => {
  it('C3, C6 and C7 all slice to their own CANONICAL_DEPTH', () => {
    // C7 is the one that broke, but C3 (merkle_path) and C6 (merkle_update)
    // mirror the same way and would break the same way. Three constants, three
    // sources of truth, checked together so a partial move is loud.
    const want: Record<string, number> = {
      C3: constant(
        read('stark/src/air/merkle_path.rs'),
        'pub const CANONICAL_DEPTH',
        'stark/src/air/merkle_path.rs',
      ),
      C6: constant(
        read('stark/src/air/merkle_update.rs'),
        'pub const CANONICAL_DEPTH',
        'stark/src/air/merkle_update.rs',
      ),
      C7: constant(
        read('stark/src/air/spend.rs'),
        'pub const CANONICAL_DEPTH',
        'stark/src/air/spend.rs',
      ),
    };
    const src = read('apps/web/lib/privacy/pool/denominatedPool.ts');
    let checked = 0;
    for (const [circuit, depth] of Object.entries(want)) {
      const m = src.match(new RegExp(`const ${circuit}_SUBTREE_DEPTH\\s*=\\s*(\\d+)`));
      expect(m, `denominatedPool no longer declares ${circuit}_SUBTREE_DEPTH`).toBeTruthy();
      expect(Number(m![1]), `${circuit}_SUBTREE_DEPTH disagrees with its circuit`).toBe(depth);
      checked += 1;
    }
    // Anti-vacuity: a renamed constant must fail loudly rather than quietly
    // reduce the number of things this case looks at.
    expect(checked, 'the pool client stopped declaring one of the three depths').toBe(3);
  });
});
