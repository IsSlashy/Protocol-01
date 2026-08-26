/**
 * THE SEND SCREEN'S DISCLOSURE, PINNED ON BOTH SIDES OF A CONDITIONAL.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHAT CHANGED AND WHY THAT IS DANGEROUS
 * ──────────────────────────────────────
 * Until 2026-08-26 this copy stated one unconditional fact: the recipient's
 * withdrawal republishes the commitment the sender's deposit published, so the
 * exit is publicly matchable to that deposit. Measured on devnet, leaf 16,
 * commitment 8901821612542787864.
 *
 * Wiring the web withdrawal to circuit 7 made that CONDITIONALLY false, and a
 * conditional is the most fragile thing a disclosure can be. It rots in two
 * opposite directions and neither one raises an error:
 *
 *   softened   the sentence is deleted or hedged into nothing because "we
 *              fixed that now". It remains true for the extension, for the
 *              phone, and for any note that cannot be proved on circuit 7 —
 *              and the sender does NOT choose which client the recipient
 *              withdraws from, so it is the case they control least.
 *   stale      the extension or the phone gains a v4 route, this copy keeps
 *              naming them as the ones that publish, and the screen is now
 *              scaring users about something that stopped happening.
 *
 * ⛔ SO THIS FILE MEASURES THE CLAIM, IT DOES NOT JUST MATCH THE STRING.
 * The copy names the extension and the phone; the last describe block goes and
 * re-reads what those two surfaces actually route to. A surface gaining circuit
 * 7 turns this copy red instead of leaving it quietly wrong — which is the only
 * mechanism that has ever kept a disclosure honest in this repository.
 *
 * BE HONEST ABOUT WHAT THIS IS: it reads files as text. `SendForm.test.tsx`
 * RENDERS the component and pins the matchable half through the DOM, which is
 * the stronger evidence; this file covers the half that has no render assertion
 * and the cross-surface fact that no render could see.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../../..');
const SEND_FORM = 'apps/web/components/pay/SendForm.tsx';

function rawOf(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8');
}

/**
 * The file with every comment removed — block, JSX `{/* … *\/}` and whole-line
 * `//` alike — then flattened to single spaces.
 *
 * Both steps are load-bearing. Without the strip, a sentence sitting in a source
 * comment would satisfy an assertion about what the USER is shown, which is the
 * exact way a copy test becomes decorative. Without the flatten, nothing
 * matches: JSX wraps prose across lines at whatever column Prettier chose, so
 * every phrase below spans two or three lines in the file.
 */
function copyOf(rel: string): string {
  return rawOf(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ');
}

describe('the send disclosure states BOTH halves of what a withdrawal publishes', () => {
  /**
   * ANTI-VACUITY, and it comes first. Every assertion below is a regex over a
   * transformed string. If the transform ever produced an empty string — a
   * moved file, a comment-strip that ate the body — the `.not.toMatch` cases
   * would all pass while measuring absolutely nothing.
   */
  it('is actually reading the rendered copy, not a stripped-empty file', () => {
    const copy = copyOf(SEND_FORM);
    expect(copy.length).toBeGreaterThan(2000);
    // A line that is unambiguously rendered JSX, and that the strip must keep.
    expect(copy).toMatch(/No transaction is sent\. That is what makes it private\./);
    // And the strip must actually have removed the file header, which states
    // the same facts in prose and would otherwise satisfy everything below.
    expect(copy).not.toMatch(/WHAT IS CLAIMED HERE AND WHAT IS NOT/);
  });

  /**
   * THE HALF THAT IS STILL TRUE. `SendForm.test.tsx` renders this same sentence;
   * it is restated here because the two failures read completely differently to
   * whoever is deleting it — one says "a DOM query found nothing", this one says
   * why the sentence may not go.
   */
  it('keeps the matchable case, which two of three clients still produce', () => {
    expect(
      copyOf(SEND_FORM),
      'the withdrawal→deposit link is still the measured truth on the phone, and on ' +
        'any note that cannot be proved on circuit 7',
    ).toMatch(/publicly matchable to your deposit/);
  });

  it('says WHICH clients that is true of, instead of stating it unconditionally', () => {
    const copy = copyOf(SEND_FORM);
    // Named, because the sender does not choose it — this screen hands the note
    // to somebody else, and their client is their decision.
    expect(copy).toMatch(/From the phone/);
    // 🚨 THE EXTENSION MOVED CATEGORY ON 2026-08-26 AND MUST NOT BE DROPPED.
    // It stopped publishing the commitment, so listing it with the phone became
    // false — but it has no derived ephemeral either, so promoting it to the
    // web app's paragraph would have been the worse error: the reader would
    // infer a payer separation that client does not have. It gets its own
    // sentence, and that sentence must keep BOTH halves.
    expect(copy).toMatch(/From the Protocol 01 extension/);
    expect(
      copy,
      'the extension paragraph dropped the half that says their own wallet signs',
    ).toMatch(/own wallet signs the withdrawal and rents the proof buffer/);
    expect(copy).toMatch(/depends on the client they withdraw from/);
    expect(copy).toMatch(/does not let you pick it/);
  });

  it('says the other half too: this app publishes no commitment', () => {
    const copy = copyOf(SEND_FORM);
    expect(copy).toMatch(/From this web app/);
    expect(copy).toMatch(/circuit-7 proof/);
    expect(copy).toMatch(/no commitment reaches the wire/);
  });

  /**
   * 🚨 AND IT IS NOT TRUE OF EVERY NOTE, WHICH THIS FILE PINNED WRONG AT FIRST.
   *
   * The first version of this test pinned the sentence "From this web app it no
   * longer does" verbatim, and that sentence was FALSE for one note that exists
   * on devnet today: leaf 30 of the 0.1 SOL pool. It was deposited before
   * `noteBlinding` landed, so the third input to its commitment is the deposit
   * EPOCH rather than a 63-bit PRF draw. Circuit 7 keeps the commitment off the
   * wire either way — but the nullifier is published by construction, and
   * `commitment = poseidon(nullifier, poseidon(epoch, token_mint))`, so its leaf
   * comes back from a few thousand candidate epochs.
   *
   * `prepareUnshieldJobV4` now refuses that note, so it routes to the C1 + C3
   * pair — visibly matchable, and honest about it. The copy has to say that,
   * because "this app no longer links your deposit" would otherwise be a promise
   * broken by exactly the note the user is least likely to think about.
   *
   * ⛔ The guard and this sentence are one claim in two files. Delete the guard
   * and this test still passes; that is why `unshieldV4Job.test.ts` pins the
   * guard's behaviour and its fallback needle separately.
   */
  it('carves out the pre-blinding note instead of promising every note', () => {
    const copy = copyOf(SEND_FORM);
    expect(copy).toMatch(/deposited before we randomised the blinding/);
    expect(copy).toMatch(/deposit epoch/);
    expect(copy).toMatch(/withdraws it the old way rather than pretend/);
    // And the claim it does make is scoped, not universal.
    expect(copy).toMatch(/for a note deposited recently/);
  });

  /**
   * 🚨 AND IT MAY NOT BE READ AS UNLINKABILITY. Circuit 7 removes the
   * commitment and NOTHING else: the recipient is still in the v4 instruction
   * data and still sits at `remaining_accounts[0]`, and whoever pre-funded the
   * ephemeral is still one hop behind the fee payer. The 2026-08-25 session note
   * records three RPC routes that still reach the wallet.
   */
  it('does not upgrade the v4 case into a privacy claim it has not earned', () => {
    const copy = copyOf(SEND_FORM);
    expect(copy).not.toMatch(/unlinkab/i);
    expect(copy).not.toMatch(/untraceab/i);
    // The concessions that keep the v4 sentence from reading as "you are safe".
    expect(copy).toMatch(/still names the address being paid/);
    expect(copy).toMatch(/one hop behind the fee payer/);
  });

  it('has dropped the old unconditional sentence, which is now wrong on this app', () => {
    expect(copyOf(SEND_FORM)).not.toMatch(
      /What it does not hide: when they withdraw, the withdrawal publishes the same note commitment/,
    );
  });
});

describe('the stale instruction in the file header is gone, not just obeyed', () => {
  /**
   * The header carried "Do not soften it before `docs/C7_SPEND_CIRCUIT_PLAN.md`
   * ships". That plan HAS shipped, and a reader following the instruction
   * literally afterwards would conclude the sentence may now be deleted —
   * which is false for two of the three withdrawal routes. An instruction whose
   * condition has been met is not guidance any more, it is a trapdoor.
   */
  it('the plan it gated on really did ship, so the instruction is spent', () => {
    expect(existsSync(join(REPO, 'docs/C7_SPEND_CIRCUIT_PLAN.md'))).toBe(true);
  });

  it('the deadline-shaped instruction has been replaced by a shape-shaped one', () => {
    const raw = rawOf(SEND_FORM);
    expect(raw).not.toMatch(/Do not soften it\s*\n?\s*\*?\s*before/);
    // What replaced it: the rule is the SHAPE of the claim, which cannot expire.
    expect(raw).toMatch(/CONDITIONAL/);
    expect(raw).toMatch(/THE SENDER DOES NOT CHOOSE WHICH/);
  });
});

describe('⛔ the copy names each surface — this re-measures them', () => {
  /**
   * The assertion that makes this file worth running. The disclosure asserts a
   * fact about OTHER applications; nothing in apps/web changes when those move,
   * so without this the copy would simply go stale in silence the day one of
   * them is wired to circuit 7.
   *
   * Mirrors `spendRouting.test.ts`, deliberately rather than accidentally: that
   * file pins the routing as an engineering fact, this one pins that the USER
   * IS TOLD the same thing. They fail together, and the second failure is the
   * one that names the screen to fix.
   */
  /**
   * 🚨 THIS LIST SHRANK ON 2026-08-26 AND THAT IS THE WHOLE VALUE OF THE FILE.
   * The extension was wired to circuit 7, the copy still said "from the
   * extension or the phone the withdrawal republishes the commitment", and this
   * assertion went red inside the same test run that wired it. Nothing else in
   * 585 pool tests noticed, because nothing else reads the sentence.
   */
  const STILL_V3: Array<{ surface: string; rel: string }> = [
    { surface: 'the phone', rel: 'apps/mobile/stores/denominatedPoolStore.ts' },
  ];

  it('the surfaces named as v3 really are, which is what the copy tells the user', () => {
    for (const { surface, rel } of STILL_V3) {
      const code = rawOf(rel)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');

      expect(code, `${surface} (${rel}) no longer calls the v3 spend at all`).toMatch(
        /\bunshieldDenominatedStarkV3\s*\(/,
      );
      expect(
        /\bunshieldDenominatedStarkV4\s*\(/.test(code),
        `${surface} now routes circuit 7, so SendForm's disclosure is telling users it ` +
          `publishes the commitment when it no longer does — update the copy at ` +
          `${SEND_FORM} and then this list`,
      ).toBe(false);
    }
  });

  /**
   * The other direction. apps/web IS the surface the v4 half of the copy is
   * about, so if it lost its circuit-7 route the copy would be promising
   * something no code delivers — the worse of the two rots, because it reads as
   * a privacy improvement.
   */
  it('and apps/web really does route the v4 spend the copy credits it with', () => {
    const code = rawOf('apps/web/lib/privacy/pool/unshieldEphemeral.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
    expect(code).toMatch(/\bunshieldDenominatedStarkV4\s*\(/);
    // The client half of the same claim: the screen only gets a v4 job because
    // `unshieldFromPool` sends the payee at prepare. Pinned in full by
    // `unshieldV4ClientRouting.test.ts`; named here so a reader of THIS file
    // knows the copy depends on it.
    expect(
      rawOf('apps/web/lib/privacy/shieldClient.ts').replace(/\/\*[\s\S]*?\*\//g, ' '),
    ).toMatch(/kind: 'poolUnshieldPrepare'[\s\S]{0,400}recipient: recipient\.toBase58\(\)/);
  });
});
