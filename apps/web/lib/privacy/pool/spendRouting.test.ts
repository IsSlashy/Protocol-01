/**
 * WHICH SPEND PATH EACH CLIENT ACTUALLY ROUTES TO — measured, not assumed.
 *
 * BE HONEST ABOUT WHAT THIS IS: it reads three files as text. It cannot prove a
 * client behaves correctly and must never be cited as evidence that it does.
 * It exists to make ONE fact explicit that the tree currently leaves implicit,
 * and that a reader of the commit log would get backwards.
 *
 * 🚨 THE FACT: circuit 7 is built, deployed, proven on devnet, and exported by
 * the web and extension service layers — and NO CLIENT CALLS IT. Every shipping
 * withdrawal on all three surfaces still goes through
 * `unshieldDenominatedStarkV3`, which publishes the note commitment as a public
 * input at a fixed offset. That is precisely the linkage C7 exists to remove.
 *
 * How that reads from outside: `91207b23` is titled "the web client CAN spend
 * on one circuit-7 proof" — capability, not routing — and it touched services,
 * a worker, the prover and tests, but no store and no UI. The distinction is
 * exact and easy to lose, and the session note written that evening recorded
 * apps/web as "complet", which is true of the service and false of the screen.
 *
 * Mobile states its choice in full at `services/denominatedPool/index.ts` and
 * pins it at `services/privacy/storeWiring.test.ts` — it is blocked on an
 * unmeasured on-device proving time, not on effort. Web and extension carried
 * no such statement at all, so their v3 routing was indistinguishable from an
 * oversight. This file is that statement.
 *
 * ⛔ A GREEN RUN HERE IS NOT APPROVAL. It records what the tree does today. When
 * a client is wired to v4, this test SHOULD fail — read the comment on the
 * assertion before changing it, and change it deliberately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../../..');

/** Strip comments so a mention in prose is never a match. */
function codeOf(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The file on each surface that decides which withdrawal path runs. */
const ROUTERS: Array<{ surface: string; rel: string }> = [
  { surface: 'apps/web', rel: 'apps/web/lib/privacy/pool/unshieldEphemeral.ts' },
  { surface: 'apps/extension', rel: 'apps/extension/src/shared/store/denominatedPool.ts' },
  { surface: 'apps/mobile', rel: 'apps/mobile/stores/denominatedPoolStore.ts' },
];

/** The file on each surface that DEFINES the v4 entry points, where one exists. */
const SERVICES: Array<{ surface: string; rel: string }> = [
  { surface: 'apps/web', rel: 'apps/web/lib/privacy/pool/denominatedPool.ts' },
  { surface: 'apps/extension', rel: 'apps/extension/src/shared/services/denominatedPool.ts' },
];

describe('the withdrawal path each client routes to', () => {
  /**
   * ANTI-VACUITY, and it has to come first. Every assertion below is a
   * `not.toMatch` on a symbol name. If the names were wrong — renamed,
   * misspelled, moved — all of them would pass while measuring nothing. This
   * proves the names are real before anything leans on their absence.
   */
  it('finds the v4 entry points where they are supposed to be defined', () => {
    for (const { surface, rel } of SERVICES) {
      const code = codeOf(rel);
      expect(code, `${surface}: prepareUnshieldV4 is not defined in ${rel}`).toMatch(
        /export\s+async\s+function\s+prepareUnshieldV4\b/,
      );
      expect(code, `${surface}: unshieldDenominatedStarkV4 is not defined in ${rel}`).toMatch(
        /export\s+async\s+function\s+unshieldDenominatedStarkV4\b/,
      );
    }
  });

  it('is v3 on all three surfaces, and that is the whole point of this file', () => {
    for (const { surface, rel } of ROUTERS) {
      const code = codeOf(rel);
      expect(code, `${surface} (${rel}) does not call the v3 spend at all`).toMatch(
        /\bunshieldDenominatedStarkV3\s*\(/,
      );
      // When this fails, a client has been wired to circuit 7. That is the
      // goal, not a regression: move the surface into the list below, say in
      // the commit what it now routes, and re-check the disclosure copy on that
      // screen -- it currently tells the user the spend is linkable, and for a
      // v4 spend that sentence stops being true about the commitment while
      // staying true about the fee payer.
      expect(
        code,
        `${surface} now calls the v4 spend -- see the comment above this assertion`,
      ).not.toMatch(/\bunshieldDenominatedStarkV4\s*\(/);
    }
  });

  /**
   * v3 is not going away and must not be treated as legacy. Notes whose
   * blinding is unknown -- unspent leaf 30 among them -- can ONLY be spent on
   * the C1 + C3 pair, so `unshield_denominated_stark_v3` stays registered
   * on-chain indefinitely. Any future routing is a CHOICE per note, never a
   * migration.
   */
  it('keeps v3 reachable, because some notes can be spent nowhere else', () => {
    for (const { surface, rel } of ROUTERS) {
      expect(codeOf(rel), `${surface} dropped the v3 path entirely`).toMatch(
        /unshieldDenominatedStarkV3/,
      );
    }
  });
});
