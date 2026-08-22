/**
 * A claim somebody paid for is theirs until they redeem it.
 *
 * Run: cd apps/web && pnpm test
 *
 * FOUNDER RULING, 2026-08-22: "si quelqu'un paye il doit recevoir sans date de
 * peremption ce qu'il veut". The merchant may change their prices whenever they
 * like. That changes nothing about an entitlement already sold.
 *
 * 🚨 WHAT THE EXPIRY ACTUALLY DID, WHICH IS WORSE THAN EXPIRING
 * ────────────────────────────────────────────────────────────
 * `mint-claim` wrote `claim-minted:<code>` with `{ ex: 24 * 60 * 60 }`. The
 * redemption path in `issue-note` then runs, in this order:
 *
 *   1. `incr` on `claim:<code>`            the claim is CONSUMED here
 *   2. `get` on `claim-minted:<code>`      null once the day has passed
 *   3. 402 "this claim code was never issued against a payment"
 *
 * and the release helper that hands a claim back is deliberately gated on
 * `minted`, because burning an unminted code on first touch is what makes
 * guessing cost something. So on day two the customer is told they never paid,
 * and the code is spent on the way out. They cannot retry. There is no error in
 * any log, because nothing errored.
 *
 * WHY A SOURCE SCAN
 * ─────────────────
 * The property is an absence: no expiry option reaches that write. A request
 * test would need a KV fake that models TTL, and it would still only cover the
 * one call site that exists today. What has to hold is that nobody adds `ex`
 * back to this key, including on a different line.
 *
 * ⚠️ An `ex` on `claim:<code>` (the consumption counter) would be the same bug
 * wearing the other hat: the counter lapsing would let one payment be redeemed
 * twice. Both keys are checked.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MINT = join(__dirname, '../../app/api/mint-claim/route.ts');
const ISSUE = join(__dirname, '../../app/api/issue-note/route.ts');

const read = (p: string) => readFileSync(p, 'utf8');

/** Comments explain the rule; they must not be able to satisfy it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('a paid claim never expires', () => {
  it('mint-claim writes the paid marker with no expiry', () => {
    const code = codeOnly(read(MINT));
    const write = code.match(/kv\.set\(\s*`p01:note:claim-minted:\$\{claimCode\}`[^)]*\)/);
    expect(write, 'the claim-minted write was renamed or removed').not.toBeNull();
    expect(
      write![0],
      'An expiry on this key makes a paying customer\'s code answer 402 "never issued against a ' +
        'payment" AND burns it on the way, because the release path is gated on `minted`. ' +
        'They paid, they are told they did not, and they cannot retry.',
    ).not.toMatch(/\bex\b\s*:/);
  });

  it('has no claim TTL constant left to reach for', () => {
    const code = codeOnly(read(MINT));
    expect(code).not.toMatch(/CLAIM_TTL_SECONDS/);
    expect(code).not.toMatch(/24 \* 60 \* 60/);
  });

  it('tells the caller the code does not expire, rather than staying silent', () => {
    // The webhook that hands the code to a buyer is exactly where a deadline
    // would otherwise be invented, so the answer says so out loud.
    const code = codeOnly(read(MINT));
    expect(code).toMatch(/expires:\s*false/);
    expect(code).not.toMatch(/expiresInSeconds/);
  });

  it('does not put a TTL on the consumption counter either', () => {
    // The mirror-image bug: if `claim:<code>` lapsed, `incr` would return 1 a
    // second time and one payment would buy two notes.
    const code = codeOnly(read(ISSUE));
    const perClaim = code.match(/kv\.(set|expire)\(\s*`p01:note:claim:[^`]*`[^)]*\)/g) ?? [];
    for (const call of perClaim) {
      expect(call, 'the claim counter must not be given a lifetime').not.toMatch(/\bex\b\s*:/);
      expect(call).not.toMatch(/kv\.expire/);
    }
  });

  it('keeps the single-use guarantee that the expiry was never needed for', () => {
    // Removing the deadline must not weaken what actually stops double
    // spending: the atomic increment, and the burn-on-first-touch for a code
    // that was never minted.
    const code = codeOnly(read(ISSUE));
    expect(code).toMatch(/kv\.incr\(`p01:note:claim:\$\{claimCode\}`\)/);
    expect(code).toMatch(/claimed !== 1/);
    expect(code).toMatch(/if \(!minted\)/);
  });
});
