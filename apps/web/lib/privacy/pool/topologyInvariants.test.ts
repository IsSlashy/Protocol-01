import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two topology invariants nothing can enforce, pinned the way the
 * note-secret one is.
 *
 * THE PATTERN, COPIED ON PURPOSE from `programs/zk_shielded/tests/
 * landed_invariants.rs`, where three tests guard `subscription_vault.rs:159`:
 *
 *   1. the invariant is pinned as TEXT, so a merge resolving the file to an
 *      older side fails loudly instead of silently deleting the only place it
 *      is written down. A guard that lives inside its subject dies with it.
 *   2. the SUBJECT is pinned separately, with comments stripped, so the code
 *      the invariant is about must still be what the invariant says it is. A
 *      warning about a mechanism that moved is worse than no warning: it reads
 *      as reassuring.
 *   3. where a consequence can be executed rather than described, it is.
 *
 * ⛔ WHY TEXT AND NOT BEHAVIOUR. Neither of these can be refused by code. The
 * till's spending key and the fee sink's are the operator's, held off chain
 * deliberately — a till this deployment could spend would be a second float and
 * the R != F split would collapse. So there is no red state to assert and the
 * comment IS the control. That is not a weaker test; it is the only test the
 * shape of the system admits, and pretending otherwise would be the lie.
 */
const ROUTE = join(__dirname, '../../../app/api/relay-to-buyer/route.ts');
const routeSource = (): string => readFileSync(ROUTE, 'utf8');

/** Comments cannot satisfy a check about code. Same trick as `strip_comments`. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('INVARIANT — a settlement must carry more than one purchase', () => {
  it('is still written down', () => {
    const src = routeSource();
    for (const needle of [
      'A SETTLEMENT MUST CARRY MORE THAN ONE PURCHASE',
      'A set of one is not a set',
      'HOLDS BY OPERATOR DISCIPLINE, NOT BY CONSTRUCTION',
    ]) {
      expect(
        src.includes(needle),
        `The settlement invariant was deleted from relay-to-buyer/route.ts.\n\n` +
          `The only thing that moves value from the till to the float is an operator settling\n` +
          `R into F, and that transfer carries forward EVERY address the till names. An auditor\n` +
          `walks deposit -> ephemeral -> float -> its history -> till -> its history and arrives\n` +
          `at the set of everyone who paid the till. Settling one purchase identifies that\n` +
          `buyer exactly. Nothing in this deployment can refuse a bad settlement — the till's\n` +
          `key is off chain by design. The comment IS the control.\n\n` +
          `Missing: "${needle}"`,
      ).toBe(true);
    }
  });

  it('still names both halves of the rule, not just the count', () => {
    // A settlement of twenty purchases sent ninety seconds after the last one
    // re-pairs them by the clock, which is public. Dropping the timing half
    // would leave a rule that looks satisfied and is not.
    const src = routeSource();
    expect(src).toMatch(/at least N purchases/);
    expect(src).toMatch(/unrelated to any of them/);
  });

  it('still says it has been violated, with the leaf it cost', () => {
    // 🚨 An invariant with a real incident attached is obeyed; one that reads as
    // hypothetical is argued with. This one has a leaf number.
    expect(routeSource()).toMatch(/leaf 72/);
  });

  it('still points at the tool that can detect a violation', () => {
    // The claim "this can be detected" must not outlive the detector.
    const src = routeSource();
    expect(src).toContain('verify/deposit-walk.mjs');
    expect(() => readFileSync(join(__dirname, '../../../../../verify/deposit-walk.mjs'), 'utf8'))
      .not.toThrow();
  });
});

describe('INVARIANT — nothing the fee sink pays may fund this protocol', () => {
  it('is still written down', () => {
    const src = routeSource();
    for (const needle of [
      'NOTHING THE FEE SINK PAYS MAY FUND THIS PROTOCOL',
      'enumerates every customer this deployment',
      'NARROWER THAN "NEVER SPEND"',
    ]) {
      expect(
        src.includes(needle),
        `The fee-sink invariant was deleted from relay-to-buyer/route.ts.\n\n` +
          `The 1% rides inside the transaction the buyer signs, so getSignaturesForAddress on the\n` +
          `sink enumerates every customer this deployment has served. If the sink ever funds an\n` +
          `ephemeral or the float, P11 walks sink -> ephemeral -> subscription and lands on a\n` +
          `buyer — and because the sink names all of them, one transfer exposes the whole list at\n` +
          `once. The key is the operator's, so nothing here can refuse it. The comment IS the\n` +
          `control, and the readiness check below is the only part a machine can do.\n\n` +
          `Missing: "${needle}"`,
      ).toBe(true);
    }
  });

  it('keeps the prohibition narrow, because a wider one gets ignored', () => {
    // An operator sweeping revenue to a cold wallet reveals the OPERATOR, not
    // the buyers. Writing "never spend" would make the rule easy to dismiss as
    // overcautious, and a dismissed rule protects nothing.
    expect(routeSource()).toMatch(/cold wallet that\s*\n?\s*\*?\s*never touches this protocol/);
  });

  it('still HAS the detection it claims to have', () => {
    // 🚨 THE HALF THAT CAN ROT SILENTLY. The comment promises the readiness
    // answer notices a sink-to-float edge. If that check is removed, the comment
    // becomes a description of a mechanism that is not there — the exact defect
    // this repository spent 2026-08-21 removing from six other screens.
    const code = codeOnly(routeSource());
    expect(code).toContain('namesBoth(');
    expect(code).toMatch(/sinkFundedFloat/);
    expect(code).toMatch(/addresses\.feeWallet/);
    expect(code).toMatch(/addresses\.funder/);
  });

  it('treats an unreadable answer as unknown, not as clean', () => {
    // `null` from `namesBoth` means a listing was truncated. Only `true` may
    // block, and the code must not compare loosely.
    expect(codeOnly(routeSource())).toMatch(/sinkFundedFloat === true/);
  });
});

describe('the subject both invariants are about has not moved', () => {
  it('the till is still the address the payment is read at', () => {
    // Both invariants assume the buyer pays R and the float pays the ephemeral.
    // If the route went back to reading the payment at the float's index, the
    // till would stop collecting and every sentence above would be about a
    // topology that no longer exists.
    expect(codeOnly(routeSource())).toMatch(/keys\.indexOf\(till\)/);
  });

  it('the three addresses are still required to be distinct', () => {
    const code = codeOnly(routeSource());
    expect(code).toMatch(/till === funderPubkey/);
    expect(code).toMatch(/feeWallet === funderPubkey/);
    expect(code).toMatch(/feeWallet === till/);
  });
});
