/**
 * WHICH SPEND PATH EACH CLIENT ACTUALLY ROUTES TO — measured, not assumed.
 *
 * BE HONEST ABOUT WHAT THIS IS: it reads four files as text. It cannot prove a
 * client behaves correctly and must never be cited as evidence that it does.
 * It exists to keep ONE fact explicit that the tree otherwise leaves implicit,
 * and that a reader of the commit log would get backwards.
 *
 * 🚨 THE FACT: circuit 7 removes the note commitment from the wire, and for
 * most of this repository's history nothing called it. `91207b23` is titled
 * "the web client CAN spend on one circuit-7 proof" — capability, not routing —
 * and it touched services, a worker, the prover and tests, but no store and no
 * UI. The session note written that evening recorded apps/web as "complet",
 * which was true of the service and false of the screen.
 *
 * Mobile states its own choice in full at `services/denominatedPool/index.ts`
 * and pins it at `services/privacy/storeWiring.test.ts` — it is blocked on an
 * unmeasured on-device proving time, not on effort. Web and extension carried
 * no such statement at all, so their v3 routing was indistinguishable from an
 * oversight. This file is that statement, for all of them at once.
 *
 * ⛔ A GREEN RUN HERE IS NOT APPROVAL. It records what the tree does today, and
 * it is designed to go red in BOTH directions — when a surface gains v4, and
 * when a surface loses it.
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

/**
 * The file on each surface that decides which withdrawal path runs, and which
 * paths it is EXPECTED to reach today.
 *
 * `routesV4` is declared, not discovered, and the test asserts it in BOTH
 * directions. The first draft of this file only checked one way, which would
 * have let a silent REMOVAL through — the same shape as the bug it was written
 * to catch, pointing the other way.
 */
const ROUTERS: Array<{ surface: string; rel: string; routesV4: boolean }> = [
  // Wired 2026-08-26 through `prepareUnshieldJobV4` / `executeUnshieldV4`,
  // added as SIBLINGS of the v3 pair rather than replacing it:
  // `prepareUnshieldJob` is reused verbatim by subscribeEphemeral.ts:115 and by
  // subscribePrivateStark.ts, and `programs/zk_shielded/src/lib.rs` exposes
  // exactly one v4 — the withdrawal. Switching the shared function would have
  // broken the subscription silently.
  { surface: 'apps/web', rel: 'apps/web/lib/privacy/pool/unshieldEphemeral.ts', routesV4: true },
  { surface: 'apps/extension', rel: 'apps/extension/src/shared/store/denominatedPool.ts', routesV4: false },
  { surface: 'apps/mobile', rel: 'apps/mobile/stores/denominatedPoolStore.ts', routesV4: false },
];

/** The file on each surface that DEFINES the v4 entry points, where one exists. */
const SERVICES: Array<{ surface: string; rel: string }> = [
  { surface: 'apps/web', rel: 'apps/web/lib/privacy/pool/denominatedPool.ts' },
  { surface: 'apps/extension', rel: 'apps/extension/src/shared/services/denominatedPool.ts' },
];

const CALLS_V3 = /\bunshieldDenominatedStarkV3\s*\(/;
const CALLS_V4 = /\bunshieldDenominatedStarkV4\s*\(/;

describe('the withdrawal path each client routes to', () => {
  /**
   * ANTI-VACUITY, and it has to come first. The assertions below turn on two
   * regexes over symbol names. If the names were wrong — renamed, misspelled,
   * moved — every one of them would still pass while measuring nothing. This
   * proves the names are real before anything leans on them.
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

  it('routes exactly the paths each surface declares, in both directions', () => {
    for (const { surface, rel, routesV4 } of ROUTERS) {
      const code = codeOf(rel);

      // v3 is never optional, on any surface. Notes whose blinding is unknown
      // can be spent nowhere else, so every client must keep reaching it
      // whatever else it gains.
      expect(code, `${surface} (${rel}) does not call the v3 spend at all`).toMatch(CALLS_V3);

      const callsV4 = CALLS_V4.test(code);
      if (routesV4) {
        // Red here means a v4 client LOST its v4 path — a silent regression
        // back to publishing the commitment, which nothing else in the suite
        // would notice, because the v3 call it fell back to still works.
        expect(
          callsV4,
          `${surface} no longer calls the v4 spend, so its withdrawals publish the commitment again`,
        ).toBe(true);
      } else {
        // Red here means a client was wired to circuit 7. That is the goal, not
        // a regression: flip its `routesV4` above, say in the commit what it now
        // routes, and re-check the disclosure copy on that screen — it tells the
        // user the spend is linkable, and for a v4 spend that sentence stops
        // being true about the commitment while staying true about the fee payer.
        expect(
          callsV4,
          `${surface} now calls the v4 spend — see the comment above this assertion`,
        ).toBe(false);
      }
    }
  });

  /**
   * v3 is not going away and must not be treated as legacy. Notes whose
   * blinding is unknown — unspent leaf 30 among them — can ONLY be spent on the
   * C1 + C3 pair, so `unshield_denominated_stark_v3` stays registered on chain
   * indefinitely. Any routing is a CHOICE per note, never a migration.
   */
  it('keeps v3 reachable, because some notes can be spent nowhere else', () => {
    for (const { surface, rel } of ROUTERS) {
      expect(codeOf(rel), `${surface} dropped the v3 path entirely`).toMatch(
        /unshieldDenominatedStarkV3/,
      );
    }
  });

  /**
   * ⛔ THE SUBSCRIPTION MUST NOT FOLLOW THE WITHDRAWAL. There is no
   * `subscribe_private_stark_v4` on chain, so the subscribe path needs the
   * C1 + C3 pair and would break outright on a circuit-7 proof. It reuses
   * `prepareUnshieldJob` verbatim, which is exactly why the v4 work was added
   * as a sibling function rather than by changing that one.
   */
  it('leaves the subscription on the v3 prepare it shares with the withdrawal', () => {
    const sub = codeOf('apps/web/lib/privacy/pool/subscribeEphemeral.ts');
    expect(sub, 'subscribeEphemeral no longer reuses prepareUnshieldJob').toMatch(
      /\bprepareUnshieldJob\b/,
    );
    expect(
      /\bprepareUnshieldJobV4\b/.test(sub),
      'subscribeEphemeral now prepares a circuit-7 proof, and there is no subscribe_private_stark_v4 to spend it on',
    ).toBe(false);
  });
});
