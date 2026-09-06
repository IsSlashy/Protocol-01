/**
 * WHICH WITHDRAWAL CIRCUIT THE MOBILE SCREENS ACTUALLY RUN, AND WHAT IS
 * REFUSED FIRST.
 *
 * ⛔ THE POINT OF THIS FILE IS THAT THE C1 + C3 PAIR IS STILL REACHED, and
 * reached by TWO different doors. A source scan cannot say that — `apps/web`
 * learned it the expensive way: for a few hours its v3 branch was dead code in
 * production, a v3-only note was unwithdrawable from the app, and every test
 * stayed green, because every one of them measured that v3 was DEFINED. So
 * every routing claim below is made by calling `routeUnshieldSpend` and
 * looking at which leg ran.
 *
 * WHAT IT DOES NOT MEASURE, said plainly. The three legs are closures, so
 * nothing here proves a circuit-7 proof verifies, that the store funds the
 * right amount, or that the wire hides anything. `unshieldV4.test.ts` pins the
 * wire bytes and what the prepare refuses; this file pins the DECISION — the
 * layer that lives in two expo-router screens and would otherwise have no
 * test at all.
 *
 * 🚨 AND THE CIRCUIT-7 ROUTE ON THIS SURFACE IS NOT ANONYMITY BY ITSELF. The
 * stealth signer is funded by the user's wallet a few seconds before the
 * withdrawal, and the sweep back lands seconds after it — measured on the v3
 * pair (slot 481,027,703). Circuit 7 removes `stark_commitment` from the wire;
 * it does not remove the funding edge. "v4 seul = FAUX VERT" (2026-08-16).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  V4Unprovable,
  buildMerkleProofFromLeavesV3,
  MERKLE_DEPTH,
  C7_SUBTREE_DEPTH,
} from './index';
import { routeUnshieldSpend } from './spendRouting';

/** The service, read as text. Pins the fail-closed split against the source. */
const SERVICE = readFileSync(join(__dirname, 'index.ts'), 'utf8');

/**
 * MEASURED 2026-08-26 and quoted from the web twin's fixtures: the live epoch
 * is slot/7200 = 67,838. Five digits. That is what a pre-blinding note carries
 * in `depositEpoch`.
 */
const EPOCH_BLINDED = 67838n;
/** What `deriveNoteBlinding` produces instead: a 63-bit PRF draw. */
const PRF_BLINDED = 7284991002338477113n;

/** The message the root pre-flight really throws — pinned below against the source. */
const ROOT_PREFLIGHT_FAILURE =
  "PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots " +
  '(current + 100 historical). Aborting before proof rent is spent. ' +
  'Wait ~10s for the RPC to index recent transactions, then retry.';

function legs() {
  return {
    prepareV4: vi.fn(async () => ({ v4: 'prepared' })),
    spendV4: vi.fn(async () => 'SIG_V4'),
    spendPair: vi.fn(async () => 'SIG_V3'),
  };
}

function route(depositEpoch: bigint, l = legs(), onProgress?: (s: string) => void) {
  return routeUnshieldSpend({ receipt: { depositEpoch }, ...l, onProgress });
}

describe('door 1 — a note circuit 7 would only appear to protect', () => {
  it('routes an epoch-blinded note to the pair, never to circuit 7', async () => {
    const l = legs();
    await expect(route(EPOCH_BLINDED, l)).resolves.toEqual({ txSig: 'SIG_V3', version: 'v3' });
    // ⛔ NOT "it threw" — it must reach the pair and SPEND. A guard that blocked
    // the note would strand every note received through a transfer, which the
    // sender still mints with a real epoch.
    expect(l.spendPair).toHaveBeenCalledTimes(1);
    // Not even attempted: the classification is synchronous, so no proving
    // time is burned discovering what the blinding already said.
    expect(l.prepareV4).not.toHaveBeenCalled();
    expect(l.spendV4).not.toHaveBeenCalled();
  });

  it('lets a PRF-blinded note onto circuit 7, and proves it by what runs next', async () => {
    const l = legs();
    await expect(route(PRF_BLINDED, l)).resolves.toEqual({ txSig: 'SIG_V4', version: 'v4' });
    expect(l.prepareV4).toHaveBeenCalledTimes(1);
    expect(l.spendV4).toHaveBeenCalledWith({ v4: 'prepared' });
    expect(l.spendPair).not.toHaveBeenCalled();
  });

  it('tells the user the withdrawal became the linkable kind', async () => {
    const steps: string[] = [];
    await route(EPOCH_BLINDED, legs(), (s) => steps.push(s));
    // A silent downgrade is the failure this whole change exists to avoid.
    expect(steps.join(' | ')).toMatch(/falling back to the C1 \+ C3 pair/i);
  });
});

describe('door 2 — what prepareUnshieldV4 itself throws', () => {
  it('the exhibit is a message prepareUnshieldV4 can really throw', () => {
    // ⚠️ WITHOUT THIS THE EXHIBIT CAN DRIFT INTO FICTION. A fixture is only
    // worth its name if the service can produce it.
    expect(SERVICE).toMatch(
      /throw new V4Unprovable\([\s\S]{0,40}PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots/,
    );
  });

  it('a V4Unprovable from prepare reaches the pair', async () => {
    const l = legs();
    l.prepareV4.mockRejectedValue(new V4Unprovable(ROOT_PREFLIGHT_FAILURE));
    await expect(route(PRF_BLINDED, l)).resolves.toEqual({ txSig: 'SIG_V3', version: 'v3' });
    expect(l.prepareV4).toHaveBeenCalledTimes(1);
    expect(l.spendPair).toHaveBeenCalledTimes(1);
    expect(l.spendV4).not.toHaveBeenCalled();
  });

  it('the depth throw routes the same way, though nothing can reach it today', async () => {
    const l = legs();
    l.prepareV4.mockRejectedValue(
      new V4Unprovable('Merkle path is 3 deep; circuit 7 needs at least 11.'),
    );
    await expect(route(PRF_BLINDED, l)).resolves.toEqual({ txSig: 'SIG_V3', version: 'v3' });
    expect(l.spendPair).toHaveBeenCalledTimes(1);
  });

  it('a plain Error from prepare FAILS CLOSED and never touches the pair', async () => {
    // ⛔ THE SAFETY PROPERTY. "The prover published 5 felts" is a defect to
    // surface. Answering it by republishing this note's commitment on the pair
    // would report a successful withdrawal and hide the bug.
    const l = legs();
    l.prepareV4.mockRejectedValue(new Error('Circuit 7 must publish exactly 6 felts, got 5.'));
    await expect(route(PRF_BLINDED, l)).rejects.toThrow(/exactly 6 felts/);
    expect(l.spendPair).not.toHaveBeenCalled();
    expect(l.spendV4).not.toHaveBeenCalled();
  });

  it('routes on the TYPE, not on the wording', async () => {
    // The same sentence the fallback allows, thrown as a plain Error, must NOT
    // fall back.
    const l = legs();
    l.prepareV4.mockRejectedValue(new Error(ROOT_PREFLIGHT_FAILURE));
    await expect(route(PRF_BLINDED, l)).rejects.toThrow(/PRE-FLIGHT FAIL/);
    expect(l.spendPair).not.toHaveBeenCalled();
  });

  it('a failure at EXECUTE never retries on the pair', async () => {
    // ⛔ THE CATCH WRAPS PREPARE ONLY, AND THIS IS WHAT SAYS SO. By the time
    // the spend throws, a proof may already be uploaded and the nullifier PDA
    // initialised; a v3 retry would pay the buffer rent a second time and then
    // die on the double-spend guard with the note gone.
    const l = legs();
    l.spendV4.mockRejectedValue(new Error('upload died at chunk 61'));
    await expect(route(PRF_BLINDED, l)).rejects.toThrow(/chunk 61/);
    expect(l.spendPair).not.toHaveBeenCalled();
  });

  it('a V4Unprovable thrown at EXECUTE does not fall back either', async () => {
    // The allow-list is scoped to the prepare. Even the "note-shaped" class
    // must not reopen the door once something may have been spent.
    const l = legs();
    l.spendV4.mockRejectedValue(new V4Unprovable(ROOT_PREFLIGHT_FAILURE));
    await expect(route(PRF_BLINDED, l)).rejects.toBeInstanceOf(V4Unprovable);
    expect(l.spendPair).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Anti-vacuity, against the source. Behaviour above cannot reach the throws
// inside `prepareUnshieldV4` without running the WASM prover, and the whole
// fail-closed split lives in which constructor those throws use.
// ---------------------------------------------------------------------------

describe('the service really is the shape the router routes on', () => {
  it('defines V4Unprovable, and it is the class this file imported', () => {
    expect(SERVICE).toMatch(/export class V4Unprovable extends Error/);
    expect(new V4Unprovable('x')).toBeInstanceOf(Error);
    expect(new V4Unprovable('x').name).toBe('V4Unprovable');
  });

  it('throws it for exactly the two note-shaped failures, and no others', () => {
    const thrown = SERVICE.match(/throw new V4Unprovable\(/g) ?? [];
    expect(thrown).toHaveLength(2);
    expect(SERVICE).toMatch(/throw new V4Unprovable\([\s\S]{0,40}PRE-FLIGHT FAIL/);
    expect(SERVICE).toMatch(/throw new V4Unprovable\([\s\S]{0,80}circuit 7 needs at least/);
  });

  it('leaves the three PROVER-defect throws as plain Errors, so they fail closed', () => {
    // Anchored to the nearest preceding `throw new`, not to a window: an
    // interposed throw of any kind fails instead of passing.
    for (const phrase of [
      'Circuit 7 must publish exactly 6 felts',
      'Circuit 7 published a recipient hash that does not match',
      'Circuit 7 published a non-canonical nullifier',
    ]) {
      const at = SERVICE.indexOf(phrase);
      expect(at, `${phrase} is no longer in the service`).toBeGreaterThan(-1);
      const throwAt = SERVICE.lastIndexOf('throw new ', at);
      expect(throwAt, `${phrase} is not preceded by any throw`).toBeGreaterThan(-1);
      expect(SERVICE.slice(throwAt, at), phrase).toMatch(/^throw new Error\(\s*`?$/);
    }
  });

  it('the depth throw is defence in depth — the builder cannot produce a short path', () => {
    // The REAL builder, the one `prepareUnshieldV4` calls.
    const leaves = [111n, 222n, 333n, 444n];
    for (let target = 0; target < leaves.length; target++) {
      const { pathElements, pathIndices } = buildMerkleProofFromLeavesV3({
        leavesByIndex: leaves,
        targetLeafIndex: target,
      });
      expect(pathElements).toHaveLength(MERKLE_DEPTH);
      expect(pathIndices).toHaveLength(MERKLE_DEPTH);
    }
    // 15 >= 11, so `pathElements.length < C7_SUBTREE_DEPTH` is unreachable and
    // the 11/4 split always has both halves. If a future builder returns a
    // variable-depth path, THIS goes red.
    expect(MERKLE_DEPTH).toBeGreaterThanOrEqual(C7_SUBTREE_DEPTH);
  });

  it('both screens route through the helper, and keep the pair as the fallback', () => {
    // The decision is only worth testing if the screens use it.
    for (const screen of ['denominated-unshield.tsx', 'denominated-unshield-batch.tsx']) {
      const src = readFileSync(join(__dirname, '../../app/(main)/(privacy)', screen), 'utf8');
      expect(src, screen).toMatch(/routeUnshieldSpend\(\{/);
      expect(src, screen).toMatch(/prepareV4: \(\) => prepareUnshieldNoteV4\(/);
      expect(src, screen).toMatch(/unshieldNoteStarkV4\(/);
      expect(src, screen).toMatch(/spendPair,/);
      expect(src, screen).toMatch(/unshieldNoteStarkV3\(/);
    }
  });
});
