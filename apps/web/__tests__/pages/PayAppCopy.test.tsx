/**
 * The entry screens must not contradict the relay, the way the result screens
 * used to contradict it in the other direction.
 *
 * 🚨 THE SHAPE OF THE MISTAKE THIS PINS
 * ─────────────────────────────────────
 * On 2026-08-21 an audit found six screens telling a tester the OPPOSITE of what
 * the deployment does, and fixed them. On 2026-08-22 a second pass found the
 * same defect still live in three places — and every survivor had one thing in
 * common: **it is read BEFORE the user acts.** The audit had walked the rendered
 * result screens.
 *
 *   `/app` banner ................ "Depositing … always comes from your address
 *                                   by name" — while step 01, four hundred lines
 *                                   below in the same file, said it does not.
 *   `SOCIAL_DESCRIPTION` ......... "Depositing names your address" — six lines
 *                                   below a DESCRIPTION that had it right. A meta
 *                                   tag renders nowhere, so a walk of the screens
 *                                   cannot see it, and it is the one string that
 *                                   TRAVELS to people who never open the page.
 *   Subscribe `CostDisclosure` ... "your wallet signs one deposit of roughly
 *                                   1 SOL", stated unconditionally, while the
 *                                   result screen says the wallet signed nothing.
 *
 * ⛔ WHY TEXT ASSERTIONS AND NOT RENDERING. These are module-level string
 * constants and static JSX; rendering them proves they render. What has to hold
 * is that a specific CLAIM is absent and its replacement present, and that is a
 * property of the source. Same reason `topologyInvariants.test.ts` reads text.
 *
 * ⚠️ A TEST THAT ONLY FORBIDS THE OLD SENTENCE IS HALF A TEST. Deleting the
 * paragraph would pass it. Each case below therefore pins the ABSENCE of the
 * false claim and the PRESENCE of the true one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PAY_PAGE = join(__dirname, '../../app/(pay)/app/page.tsx');
const SUBSCRIBE = join(__dirname, '../../components/pay/SubscribePanel.tsx');
const POOL = join(__dirname, '../../components/pay/PoolPanel.tsx');

const read = (p: string) => readFileSync(p, 'utf8');

/** Comments must not satisfy a claim about what the page SAYS. */
function codeOnly(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the /app banner', () => {
  it('no longer claims the deposit names the buyer', () => {
    const rendered = codeOnly(read(PAY_PAGE));
    expect(
      rendered,
      'The banner claims the deposit carries the buyer\'s address. An ordinary deposit is the ' +
        'relayed shape or it is refused (PoolPanel passes depositPublicly: treasuryMode), and ' +
        'leaf 72 was re-read by RPC with the buyer absent from the account keys.',
    ).not.toMatch(/comes from your address by name/);
  });

  it('states what the wallet actually does instead of saying nothing', () => {
    const rendered = codeOnly(read(PAY_PAGE));
    // The true fact: one public signature to the deployment, which then funds
    // the key that touches the pool.
    expect(rendered).toMatch(/one public\s*\n?\s*signature paying this deployment/);
    expect(rendered).toMatch(/not on the pool\s*\n?\s*transaction/);
  });

  it('still refuses to answer, in the banner, who paid for a spend', () => {
    // Per-screen facts belong to the screen. The banner asserting one would be
    // the same defect wearing the opposite sign.
    expect(codeOnly(read(PAY_PAGE))).toMatch(/Each screen says who paid for that screen/);
  });
});

describe('the link preview, which is read by people who never open the page', () => {
  it('no longer says depositing names your address', () => {
    // ⚠️ codeOnly, and the first run of this test is why: the comment recording
    // the correction QUOTES the sentence it removed. Forbidding the words
    // everywhere would forbid writing down what changed and when — which is the
    // only reason the next reader will not restore it.
    expect(codeOnly(read(PAY_PAGE))).not.toMatch(/Depositing names your address/);
  });

  it('describes the payment-then-funding shape', () => {
    const src = read(PAY_PAGE);
    const match = src.match(/const SOCIAL_DESCRIPTION =\s*\n?\s*"([^"]+)"/);
    expect(match, 'SOCIAL_DESCRIPTION was renamed or removed').not.toBeNull();
    const social = match![1];
    expect(social).toMatch(/signs one public payment to this deployment/);
    expect(social).toMatch(/funds the key that touches the pool/);
    // The two disclosures that must never leave a preview.
    expect(social).toMatch(/Not audited/);
    expect(social).toMatch(/No mainnet deployment/);
  });

  it('agrees with the meta description in the same file', () => {
    // 🚨 THE ACTUAL BUG WAS DISAGREEMENT, not either sentence alone. Both
    // strings describe the same mechanism and they sat six lines apart giving
    // opposite answers for a day.
    const src = read(PAY_PAGE);
    const desc = src.match(/const DESCRIPTION =\s*\n?\s*"([^"]+)"/)?.[1] ?? '';
    const social = src.match(/const SOCIAL_DESCRIPTION =\s*\n?\s*"([^"]+)"/)?.[1] ?? '';
    for (const s of [desc, social]) {
      expect(s, 'one of the two metadata strings claims the deposit names the buyer').not.toMatch(
        /names your address|comes from your address/,
      );
      expect(s).toMatch(/this deployment/);
    }
  });
});

describe('the subscribe cost disclosure, read before signing', () => {
  it('no longer asserts the wallet fronts the proof rent', () => {
    const rendered = codeOnly(read(SUBSCRIBE));
    expect(
      rendered,
      'CostDisclosure is static and said the wallet signs a ~1 SOL deposit. The funder answers ' +
        'ready:true in production, and the result screen in this same file says the wallet ' +
        'signed nothing. The false one is the one read before the click.',
    ).not.toMatch(/your wallet signs one deposit of roughly 1 SOL/);
  });

  it('names both shapes and says what decides', () => {
    const rendered = codeOnly(read(SUBSCRIBE));
    expect(rendered).toMatch(/roughly 1 SOL is locked/);
    expect(rendered).toMatch(/funder if\s*\n?\s*it is available/);
    expect(rendered).toMatch(/your own\s*\n?\s*wallet if it is not/);
    // And it must point at where the answer actually appears.
    expect(rendered).toMatch(/screen after the purchase names which happened/);
  });

  it('keeps the two hard sentences it has always carried', () => {
    // The disclosure was softened in one place; nothing else may have moved.
    const rendered = codeOnly(read(SUBSCRIBE));
    expect(rendered).toMatch(/There is no cancel and no refund/);
    expect(rendered).toMatch(/hides your wallet only as well as the pool does/);
  });
});

describe('the withdrawal payout line', () => {
  it('does not leave "reaches it" to be read as "can see it"', () => {
    const rendered = codeOnly(read(POOL));
    expect(rendered).not.toMatch(/Only your wallet's signature reaches it/);
    expect(rendered).not.toMatch(/Only your wallet&apos;s signature reaches it/);
  });

  it('separates who can spend from who can see, in that order', () => {
    const rendered = codeOnly(read(POOL));
    expect(rendered).toMatch(/Only your key can spend it — anyone can see it/);
    // The sentence that made the old wording dangerous must still be there:
    // the payout address is public and reaches wherever you sweep.
    expect(rendered).toMatch(/whoever\s*\n?\s*reads this reaches whoever you sweep it to/);
  });
});
