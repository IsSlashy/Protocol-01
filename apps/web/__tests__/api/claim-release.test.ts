/**
 * A refusal must never keep the customer's payment.
 *
 * Run: cd apps/web && pnpm test
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * Two endpoints take a one-shot claim BEFORE they read the chain, which is the
 * right order — `incr` is what stops two simultaneous requests being served the
 * same payment. What was wrong is that the claim stayed taken through every
 * refusal below it, and most of those refusals are not errors at all. They are
 * ordinary operational states:
 *
 *   /api/relay-to-buyer  the RPC has not caught up with the payment yet. It
 *                        answers 404 "confirm it and retry" — and the retry
 *                        hits 409 "already relayed". Forever. The buyer's
 *                        lamports are on chain, the deployment kept them, and
 *                        the endpoint meant to forward them is shut.
 *
 *   /api/issue-note      the stock is too young, or every note is held by
 *                        another address because the buyer reloaded the page.
 *                        The all-spent refusal even ends with the words
 *                        "Nothing was charged." — which stopped being true the
 *                        moment `incr` returned.
 *
 * Both now release the claim on every path that hands nothing over.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A REQUEST TEST
 * ───────────────────────────────────────────────
 * The property is a quantifier — EVERY refusal below the claim releases it —
 * and the dangerous case is the one nobody wrote yet. A behavioural test pins
 * the paths that exist today and says nothing about the `return bad(...)` a
 * future change adds three lines lower, which is exactly how this got here.
 *
 * The failure mode is also invisible from the outside: the response looks
 * correctly refused, the status code is right, and the money is simply gone. No
 * error is logged, because nothing errored.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES = [
  {
    name: 'relay-to-buyer',
    path: 'app/api/relay-to-buyer/route.ts',
    /** Everything after this line runs with the payment already claimed. */
    claimedAfter: "if (claim !== 1) return bad(409, 'this payment has already been relayed');",
  },
  {
    name: 'issue-note',
    path: 'app/api/issue-note/route.ts',
    /** The release helper is defined after the `minted` check on purpose: an
     *  unminted code must stay burned, so nothing above this may release. */
    claimedAfter: 'const release = async (res: NextResponse) => {',
  },
] as const;

function source(rel: string): string {
  return readFileSync(join(__dirname, '../../', rel), 'utf8');
}

/**
 * Remove `//` line comments and block comments.
 *
 * Without this the scan reads a sentence ABOUT the rule as a violation of it:
 * the release helper's own doc comment contains the words
 * "EVERY `return bad(...)` BELOW THIS POINT MUST GO THROUGH HERE", and the first
 * run of this suite failed on exactly that line. The Rust guards in
 * `programs/zk_shielded/tests/` strip comments for the same reason and say the
 * same thing: a comment describing a constraint must never be mistaken for the
 * constraint.
 *
 * Not a parser. It does not understand a `//` inside a string literal, and its
 * failure mode is to remove too much — which makes the scan miss a violation
 * rather than invent one. That is the wrong direction for a guard, so the
 * `finds-something-to-check` case below pins that the stripped source is still
 * substantial.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*/gm, '$1');
}

describe('every refusal after the claim gives the claim back', () => {
  for (const route of ROUTES) {
    const src = source(route.path);
    const at = src.indexOf(route.claimedAfter);

    it(`${route.name}: the anchor this scan depends on still exists`, () => {
      // A scan whose anchor has been renamed silently checks an empty region
      // and passes. That is the same shape of false green the whole suite is
      // about, so it is asserted rather than assumed.
      expect(at, `anchor not found in ${route.path}: ${route.claimedAfter}`).toBeGreaterThan(-1);
    });

    it(`${route.name}: no bare "return bad(" survives below it`, () => {
      const below = stripComments(src.slice(at + route.claimedAfter.length));
      // `return release(bad(...))` contains "return release(bad(", never
      // "return bad(", so a plain match is exactly the violation set.
      const bare = below
        .split('\n')
        .map((line, i) => ({ line: line.trim(), i }))
        .filter(({ line }) => line.includes('return bad('));

      expect(
        bare.map((b) => b.line),
        `These refusals keep a paid claim. Wrap each in release(...):\n` +
          bare.map((b) => `  ${route.path}: ${b.line}`).join('\n'),
      ).toEqual([]);
    });

    it(`${route.name}: releases through the store, not by letting a key expire`, () => {
      // `p01:note:claim:*` is incr'd with no TTL, so "it will expire" is not a
      // fallback that exists. The release has to be an explicit del.
      const below = src.slice(at);
      expect(below).toMatch(/await kv\.del\(/);
    });

    it(`${route.name}: still refuses a second request while one is in flight`, () => {
      // The release must not become "no claim at all". The incr and its !== 1
      // refusal are what make two simultaneous callers safe, and releasing only
      // reopens the window after this request has decided to send nothing.
      expect(src).toMatch(/await kv\.incr\(/);
      expect(src).toMatch(/!== 1/);
    });
  }

  it('the comment stripper leaves real code behind', () => {
    // The stripper's failure mode is removing too much, which would make every
    // scan above pass on an empty string. Pin that it does not.
    const stripped = stripComments(source('app/api/relay-to-buyer/route.ts'));
    expect(stripped).toMatch(/await kv\.incr\(/);
    expect(stripped).toMatch(/return release\(bad\(/);
    expect(stripped).not.toMatch(/MUST GO THROUGH HERE/);
    expect(stripped.length).toBeGreaterThan(1000);
  });

  it('issue-note does NOT release a claim that was never minted', () => {
    // 🚨 THE ANTI-ABUSE PROPERTY, and it is a matter of ORDER rather than of a
    // condition. The 402 for an unminted code promises "the code is now consumed
    // either way, so a guessed code cannot be retried". If the release helper
    // were defined above that check, or that refusal were wrapped, a guesser
    // could probe a code space for free.
    const src = source('app/api/issue-note/route.ts');
    const unminted = src.indexOf("'this claim code was never issued against a payment'");
    const helper = src.indexOf('const release = async (res: NextResponse) => {');

    expect(unminted).toBeGreaterThan(-1);
    expect(helper).toBeGreaterThan(-1);
    expect(
      unminted,
      'the unminted refusal must come BEFORE the release helper exists, or a guessed code becomes retryable',
    ).toBeLessThan(helper);
  });

  it('issue-note does NOT release an already-used claim either', () => {
    // Same reasoning from the other side: the 409 for a spent claim must not be
    // able to un-spend it.
    const src = source('app/api/issue-note/route.ts');
    const used = src.indexOf("'this claim code has already been used'");
    const helper = src.indexOf('const release = async (res: NextResponse) => {');
    expect(used).toBeGreaterThan(-1);
    expect(used).toBeLessThan(helper);
  });
});
