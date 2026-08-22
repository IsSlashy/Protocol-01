import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

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
 * ⛔ WHY TEXT AND NOT BEHAVIOUR — AND THIS PARAGRAPH CHANGED ON 2026-08-22.
 *
 * It used to say neither invariant could be refused by code, because the till's
 * key and the sink's are the operator's and held off chain: "a till this
 * deployment could spend would be a second float and the R != F split would
 * collapse". That reasoning was wrong about the property and right about the
 * risk. R != F is a statement about what appears in transactions; an observer
 * cannot see key custody, so the split survives the key coming online. The real
 * risk was behavioural — a deployment that can spend R might fund an ephemeral
 * from it — and behaviour is exactly what a test can pin.
 *
 * So invariant A is no longer prose alone: `app/api/settle-till/route.ts`
 * enforces the count, the quiet period and a randomised hold, and the tests at
 * the bottom of this file pin the guards that make holding the till's key safe.
 *
 * ⚠️ INVARIANT B IS STILL TEXT-ONLY, AND THE DISTINCTION IS THE POINT. The fee
 * sink's key stays off chain: nothing this deployment does needs to spend it,
 * so bringing it online would buy nothing and cost the same blast radius. A
 * test that treated both invariants the same would be describing a symmetry
 * that no longer exists.
 *
 * 🧠 CHANGING A PINNED INVARIANT TO MAKE A TEST PASS IS THE FAILURE MODE THIS
 * FILE EXISTS TO CATCH, so this edit is deliberate, dated, and carries its
 * reason — the same way `DocsPage` and `PayAppConnectGate` changed sides on
 * 2026-08-21 when the facts they pinned stopped being true.
 */
const ROUTE = join(__dirname, '../../../app/api/relay-to-buyer/route.ts');
const SETTLER = join(__dirname, '../../../app/api/settle-till/route.ts');
const routeSource = (): string => readFileSync(ROUTE, 'utf8');
const settlerSource = (): string => readFileSync(SETTLER, 'utf8');

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
      // ⚠️ WAS 'HOLDS BY OPERATOR DISCIPLINE, NOT BY CONSTRUCTION' until
      // 2026-08-22. The discipline became a cron job; pinning the old sentence
      // would now pin a lie that reads as caution.
      'ENFORCED BY A MACHINE, AND UNTIL 2026-08-22 IT WAS NOT',
    ]) {
      expect(
        src.includes(needle),
        `The settlement invariant was deleted from relay-to-buyer/route.ts.\n\n` +
          `The only thing that moves value from the till to the float is an operator settling\n` +
          `R into F, and that transfer carries forward EVERY address the till names. An auditor\n` +
          `walks deposit -> ephemeral -> float -> its history -> till -> its history and arrives\n` +
          `at the set of everyone who paid the till. Settling one purchase identifies that\n` +
          `buyer exactly. Since 2026-08-22 the settler refuses one — but the ROUTE is where the\n` +
          `rule is written down, and a rule enforced in one file and recorded nowhere is one\n` +
          `refactor away from being enforced by nothing.\n\n` +
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

/**
 * The guards that make holding the till's spending key safe.
 *
 * 🚨 THESE ARE THE PRICE OF THE PARAGRAPH THAT CHANGED. Bringing
 * `P01_TILL_SECRET_KEY` online is defensible only while the till cannot be spent
 * as a second float, and "cannot" has to mean something checkable. Each test
 * below is one clause of that argument.
 */
describe('the till key is online, and confined', () => {
  /** Every TypeScript source file under apps/web, excluding build output. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) sourceFiles(full, out);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
  }

  it('P01_TILL_SECRET_KEY is read in the settler and nowhere else', () => {
    // ⛔ THE WHOLE ARGUMENT IN ONE ASSERTION. The claim is not "we would never
    // fund an ephemeral from the till"; it is "there is exactly one function
    // that could spend the till at all". A second reader of this variable
    // silently retires that claim, and nothing else in the suite would notice.
    const root = join(__dirname, '../../..');
    // ⚠️ CODE, NOT MENTIONS — and the first run of this test caught the
    // difference. `relay-to-buyer/route.ts` NAMES the variable in the paragraph
    // explaining why it is confined, which is documentation working exactly as
    // intended. A grep over raw text would forbid writing the rule down next to
    // the rule, and the same `codeOnly` helper the invariants above use exists
    // for precisely this distinction.
    const hits = sourceFiles(root)
      .filter((f) => codeOnly(readFileSync(f, 'utf8')).includes('P01_TILL_SECRET_KEY'))
      .map((f) => f.replace(root, '').split(sep).join('/'));
    const allowed = new Set([
      '/app/api/settle-till/route.ts',
      '/lib/privacy/pool/settleTillRoute.test.ts',
      '/lib/privacy/pool/topologyInvariants.test.ts',
    ]);
    const unexpected = hits.filter((h) => !allowed.has(h));
    expect(
      unexpected,
      `The till's spending key is read outside the settler:\n  ${unexpected.join('\n  ')}\n\n` +
        `Holding that key online is only defensible while ONE function can spend it. A second\n` +
        `reader means the till can become a second float — buyer -> R -> ephemeral -> deposit,\n` +
        `which is the 2026-08-18 two-hop walk with the middle step relabelled.`,
    ).toEqual([]);
    expect(hits).toContain('/app/api/settle-till/route.ts');
  });

  it('the settler has exactly one destination, and it is the float keypair', () => {
    const code = codeOnly(settlerSource());
    // Taken from the keypair that signs, never from an env address that could
    // drift from it and never from the request.
    expect(code).toMatch(/toPubkey:\s*p\.funder\.publicKey/);
    // No destination may be read off the wire. `request.json()` never appears,
    // and neither does a searchParams read for an address.
    expect(code).not.toMatch(/\.json\(\)/);
    expect(code).not.toMatch(/searchParams\.get\(\s*['"](to|destination|recipient)['"]/);
  });

  it('the settler refuses when the till key and the float key are the same', () => {
    // R == F is the collapse itself. Settling into itself would report success
    // forever while the float never refilled.
    expect(codeOnly(settlerSource())).toMatch(/if \(t === f\)/);
  });

  it('the settler refuses a till key that is not the address buyers are told to pay', () => {
    // Sweeping the wrong address succeeds, reports a settlement, and leaves the
    // real till filling — a green light over an untouched leak.
    expect(codeOnly(settlerSource())).toMatch(/declaredOk !== t/);
  });

  it('the settler never buys continuity with the batch floor', () => {
    // The cheap escape from an empty float is a smaller batch, and it is the
    // one move that cannot be undone. The refusal must exist in code, not only
    // in the policy module's prose.
    const code = codeOnly(settlerSource());
    expect(code).toMatch(/decision\.verdict !== 'settle'/);
    expect(code).toMatch(/decideSettlement/);
  });

  it('the settler locks, so two ticks cannot each sweep', () => {
    // Two overlapping cron ticks would each build a full sweep; the second
    // moves whatever arrived in between, which is a settlement of one purchase
    // manufactured by the route that exists to prevent it.
    const code = codeOnly(settlerSource());
    expect(code).toMatch(/K\.lock/);
    expect(code).toMatch(/lock !== 1/);
  });
});

describe('INVARIANT B is still text-only, deliberately', () => {
  it('the fee sink has no spending key anywhere in the app', () => {
    // Nothing this deployment does needs to spend the sink, so bringing its key
    // online would buy nothing and cost the same blast radius the till's did.
    const root = join(__dirname, '../../..');
    function walk(dir: string, out: string[] = []): string[] {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(e.name)) out.push(full);
      }
      return out;
    }
    const hits = walk(root)
      // This file names the patterns it searches for, so it matches itself.
      .filter((f) => !f.endsWith(join('pool', 'topologyInvariants.test.ts')))
      .filter((f) =>
        /P01_FEE_WALLET_SECRET|P01_FEE_SECRET_KEY|P01_SINK_SECRET/.test(
          codeOnly(readFileSync(f, 'utf8')),
        ),
      )
      .map((f) => f.replace(root, '').split(sep).join('/'));
    expect(hits, 'The fee sink acquired a spending key. Invariant B assumes it has none.').toEqual(
      [],
    );
  });
});
