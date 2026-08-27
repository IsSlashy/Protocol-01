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

import {
  SUBSCRIBE_FLOAT_LAMPORTS,
  SUBSCRIBE_FLOAT_SOL,
} from '@/lib/privacy/pool/subscribeFloat';

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

  it('names both shapes of WHO PAYS and says what decides', () => {
    const rendered = codeOnly(read(SUBSCRIBE));
    expect(rendered).toMatch(/funder if\s*\n?\s*it is available/);
    expect(rendered).toMatch(/your own\s*\n?\s*wallet if it is not/);
    // And it must point at where the answer actually appears.
    expect(rendered).toMatch(/screen after the purchase names which happened/);
  });

  /**
   * 🚨 AND BOTH SHAPES OF HOW MUCH — A SECOND CONDITIONAL, AND IT WAS WRONG.
   *
   * The paragraph said "roughly 1 SOL is locked to hold space for the two proofs
   * — the same pair a withdrawal needs". Both halves were false on the route
   * this app actually takes:
   *
   *   the figure   circuit 7 rents ONE buffer, so the float is a little over
   *                half of what the sentence promised — an overstatement of
   *                nearly 2x, in the box read immediately before signing.
   *   the pair     apps/web's withdrawal stopped using C1 + C3 on 2026-08-26,
   *                so "the same pair a withdrawal needs" named a dead route.
   *
   * ⛔ OVERSTATING A COST IS NOT THE SAFE DIRECTION. It teaches the reader that
   * this panel's numbers are approximate, and the two sentences beside it — the
   * whole note is spent, there is no refund — are not.
   *
   * ⛔ AND THE FIX IS NOT A CORRECTED LITERAL. A number typed into JSX has
   * nothing to disagree with, which is exactly how this one went stale while
   * `subscribeEphemeral.ts` priced the real thing correctly the whole time. The
   * copy now INTERPOLATES `SUBSCRIBE_FLOAT_SOL`, and `subscribeFloat.test.ts`
   * pins that constant by EXECUTING `prepareSubscribeJobV4` and comparing its
   * floor to it. What is left for this file is the half that lives in the panel:
   * that the paragraph carries the constant rather than digits, and that it
   * names both routes instead of collapsing them into one number.
   */
  describe('the float figure, which was wrong by nearly 2x', () => {
    it('no longer states one figure for two routes that cost different money', () => {
      const rendered = codeOnly(read(SUBSCRIBE));
      expect(
        rendered,
        'the ~1 SOL figure is the C1 + C3 pair. This app tries circuit 7 first, which rents ONE ' +
          'buffer and locks a little over half that',
      ).not.toMatch(/roughly 1 SOL is locked/);
      expect(
        rendered,
        "apps/web has not used the C1 + C3 pair for a withdrawal since 2026-08-26",
      ).not.toMatch(/the same[\s\S]{0,40}pair a withdrawal needs/);
      // The in-flight reminder carried the SAME literal, and correcting one
      // while leaving the other is the shape this suite exists to catch.
      expect(rendered).not.toMatch(/About 1 SOL sits in a refundable deposit/);
    });

    it('interpolates the shared figure instead of carrying digits', () => {
      const rendered = codeOnly(read(SUBSCRIBE));
      expect(rendered).toMatch(/from '@\/lib\/privacy\/pool\/subscribeFloat'/);
      // Both routes, both from the module the job prices with. ⛔ If either of
      // these is ever replaced by a number, the figure can rot in silence again.
      //
      // 🚨 LE LOOKBEHIND EST LA GARDE. Sans lui ce test etait HOLLOW, mesure
      // par un adversaire le 2026-08-27 : il a supprime tout le <li> de cout
      // et le test est reste VERT. /{X}/ matche AUSSI a l'interieur de
      // ${X}, donc les deux assertions JSX etaient satisfaites par le litteral
      // de gabarit plus bas dans le fichier. L'interpolation JSX pouvait
      // disparaitre entierement sans que rien ne bouge.
      expect(rendered).toMatch(/\{SUBSCRIBE_FLOAT_SOL\.c7\}/);
      expect(rendered).toMatch(/\{SUBSCRIBE_FLOAT_SOL\.pair\}/);
      // Et le bloc lui-meme doit exister. Les assertions ci-dessus prouvent que
      // le chiffre est interpole plutot qu'en dur ; celle-ci prouve qu'il y a
      // une phrase ou l'interpoler.
      expect(rendered, 'the cost disclosure shown before signing is gone').toMatch(
        /is temporarily locked|is locked while|sits in a refundable/,
      );
      // And the progress note shown DURING the flow reads from it too.
      expect(rendered).toMatch(/\$\{SUBSCRIBE_FLOAT_SOL\.c7\}/);
      expect(rendered).toMatch(/\$\{SUBSCRIBE_FLOAT_SOL\.pair\}/);
    });

    it('says WHICH route each figure belongs to, and what decides', () => {
      const rendered = codeOnly(read(SUBSCRIBE));
      expect(rendered).toMatch(/circuit 7, which rents ONE buffer/);
      expect(rendered).toMatch(/C1 \+ C3 pair, which rents two/);
      // The one case the user cannot influence and would otherwise be surprised
      // by — the same carve-out SendForm's disclosure makes for the same notes.
      expect(rendered).toMatch(/deposited before we randomised the blinding/);
    });

    it('the two figures really are different, so one sentence could not have covered both', () => {
      // Read from the module the copy renders — never a second literal here
      // either. If these ever collapse to one value the conditional above is
      // decoration, and should be deleted rather than left saying nothing.
      expect(SUBSCRIBE_FLOAT_SOL.c7).not.toBe(SUBSCRIBE_FLOAT_SOL.pair);
      expect(Number(SUBSCRIBE_FLOAT_SOL.c7)).toBeLessThan(Number(SUBSCRIBE_FLOAT_SOL.pair));
      expect(SUBSCRIBE_FLOAT_LAMPORTS.c7).toBeLessThan(SUBSCRIBE_FLOAT_LAMPORTS.pair);
    });
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
