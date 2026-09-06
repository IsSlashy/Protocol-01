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
  // `prepareUnshieldJob` is reused verbatim by subscribeEphemeral.ts and by
  // subscribePrivateStark.ts, and a note whose blinding is unknown can be spent
  // nowhere else. Switching the shared function would have broken the
  // subscription silently.
  { surface: 'apps/web', rel: 'apps/web/lib/privacy/pool/unshieldEphemeral.ts', routesV4: true },
  // Wired 2026-08-26, and its fallback is proven differently from web's. The
  // extension has no worker boundary on this path, so it does not route on a
  // string inside an error message — `prepareUnshieldV4` throws a typed
  // `V4Unprovable` and the store catches THAT. Reworded messages cannot break
  // it. Reachability is measured behaviourally in
  // `apps/extension/src/shared/store/unshieldRouting.test.ts`, through both
  // doors: an epoch-blinded note, and a `V4Unprovable` from prepare. Both SPEND
  // on the C1 + C3 pair — they do not merely throw.
  { surface: 'apps/extension', rel: 'apps/extension/src/shared/store/denominatedPool.ts', routesV4: true },
  // Cut over 2026-09-06: `unshieldNoteStarkV4` in the store, reached through
  // `routeUnshieldSpend` (services/denominatedPool/spendRouting.ts) from both
  // withdraw screens; the pair stays reachable for a `V4Unprovable` note.
  { surface: 'apps/mobile', rel: 'apps/mobile/stores/denominatedPoolStore.ts', routesV4: true },
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
   *
   * 🚨 READ WHAT THIS MEASURES BEFORE CITING IT: v3 is DEFINED, not v3 is
   * REACHED. The two came apart on 2026-08-26 and this assertion did not move.
   *
   * `unshieldEphemeral.ts` defines both pairs and names both instructions, so
   * the regex below hits whatever any caller actually does. For apps/web the
   * file that decides is no longer this one: `shieldClient.ts` types the payee
   * and the wallet as REQUIRED and sends both on every withdrawal, so the worker
   * takes the circuit-7 branch every time, and the only thing that still reaches
   * the C1 + C3 pair is `handlePoolUnshieldPrepare`'s fallback when the circuit-7
   * rebuild cannot place the note's root. For a few hours there was no such
   * fallback — the v3 branch was dead code in production and a v3-only note was
   * unwithdrawable from the web app — and this test stayed green throughout,
   * along with the other 561 in the suite.
   *
   * Reachability is measured behaviourally in
   * `lib/privacy/worker/poolHandlersUnshieldV4.test.ts`, under "a note circuit 7
   * cannot prove still reaches the C1 + C3 pair": it makes the circuit-7 prepare
   * fail and asserts the C1 + C3 prepare runs and the answer says `v3`. THAT is
   * the assertion to point at. This one is a name check, and a name check is all
   * a regex over a definitions file can ever be.
   */
  it('keeps v3 DEFINED, which is weaker than reachable — see the note above', () => {
    for (const { surface, rel } of ROUTERS) {
      expect(codeOf(rel), `${surface} dropped the v3 path entirely`).toMatch(
        /unshieldDenominatedStarkV3/,
      );
    }
  });

  /**
   * ⛔ THE SUBSCRIPTION MUST NOT FOLLOW THE WITHDRAWAL — AND THE REASON CHANGED
   * ON 2026-08-27 WITHOUT THE CONCLUSION CHANGING.
   *
   * This used to read "there is no `subscribe_private_stark_v4` on chain, so the
   * subscribe path needs the C1 + C3 pair". THERE NOW IS
   * (`programs/zk_shielded/src/lib.rs:549`), and the subscribe IS wired to
   * circuit 7 — through its OWN `prepareSubscribeJobV4`, never the withdrawal's.
   *
   * The reason it must keep its own is stronger than the old one: the two v4
   * instructions bind DIFFERENT digests. `prepareUnshieldJobV4` binds
   * `sha256(recipient)`; `subscribe_private_stark_v4` rebuilds a 132-byte
   * `"P01:C7:SUBSCRIBE:v1" || vault || rate || interval_slots || vk_hash ||
   * license` composite, because `rate` and `interval_slots` are half the
   * economic statement and `claim_period` is permissionless. A buffer minted by
   * the withdrawal's prepare fails the subscribe handler's public-inputs-hash
   * check at the END of a ~78-chunk upload.
   *
   * So this checks THREE things now, in both directions: the shared v3 prepare
   * is still reached, the withdrawal's v4 prepare is still NOT, and the
   * subscribe's own v4 prepare IS. A one-directional check would let a silent
   * REMOVAL through, which is the same shape as the bug this file exists to
   * catch, pointing the other way.
   */
  it('keeps the subscription on its OWN v4 prepare, and on the shared v3 one', () => {
    const sub = codeOf('apps/web/lib/privacy/pool/subscribeEphemeral.ts');
    expect(sub, 'subscribeEphemeral no longer reuses prepareUnshieldJob').toMatch(
      /\bprepareUnshieldJob\b/,
    );
    expect(
      /\bprepareUnshieldJobV4\b/.test(sub),
      "subscribeEphemeral reached for the WITHDRAWAL's circuit-7 prepare, which binds " +
        'sha256(recipient) — the subscribe handler rebuilds a domain-tagged composite and ' +
        'would refuse that proof only after the whole upload was paid for',
    ).toBe(false);
    // ⛔ THE CALL STATEMENT, NOT THE NAME. MEASURED 2026-08-27: this was first
    // written as `.toMatch(/\bprepareSubscribeV4\b/)` and it was HOLLOW —
    // renaming the CALL to `prepareSubscribeV4NOPE(` left it GREEN, because the
    // identifier still appears in the import list at the top of the file and
    // `codeOf` strips comments but not imports. This repo has shipped three
    // hollow guards of exactly that shape.
    expect(
      sub,
      'subscribeEphemeral lost its own circuit-7 route, so every subscription now ' +
        "republishes the note's commitment through the C1 + C3 pair",
    ).toContain('const prepared = await prepareSubscribeV4(');
  });
});
