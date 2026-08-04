/**
 * Source-level guards on `stores/denominatedPoolStore.ts`.
 *
 * BE HONEST ABOUT WHAT THIS IS: these read the file as text. They cannot prove
 * the store behaves correctly and must never be cited as evidence that it does.
 * They exist because the store cannot be imported in this test environment —
 * its graph reaches `services/zkspl/index.ts:81`, which calls
 * `SystemProgram.programId.toBase58()` at module scope, and the shared
 * `test/__mocks__/@solana/web3.js.ts` stub has no `programId`. Fixing that mock
 * would change a file shared with every other mobile suite.
 *
 * So what these guard is narrow and specific: the three regressions that this
 * change exists to prevent, each of which is visible in the source and each of
 * which has previously shipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const STORE = readFileSync(
  resolve(__dirname, '../../stores/denominatedPoolStore.ts'),
  'utf8',
);

/** Strip line and block comments so a mention in prose is not a match. */
const CODE = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('denominatedPoolStore wiring', () => {
  it('derives no key material from a wallet address any more', () => {
    // The six defective derivations were all `hmac(sha256, utf8(walletAddr), …)`.
    // Any surviving hmac call in this file is that bug or its twin.
    expect(CODE).not.toMatch(/\bhmac\s*\(/);
    expect(CODE).not.toMatch(/SolKeypair\.fromSeed\s*\(\s*seed\s*\)/);
  });

  it('routes every ephemeral signer through the secret-seeded helper', () => {
    const labels = [
      'stealth_shield_v1_',
      'stealth_unshield_',
      'stealth_unshield_v3_',
      'stealth_transfer_stark_',
      'stealth_transfer_v3_',
    ];
    for (const label of labels) {
      expect(CODE).toContain(label);
    }
    // Two shield sites (fresh + recovery) + four spend sites.
    const calls = CODE.match(/deriveStealthSigners\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the legacy sweep wired into every crash-recovery path', () => {
    // Deleting these strands pre-fix funds at addresses this app can no longer
    // reach. There are two shield sites and four spend sites.
    const sweeps = CODE.match(/sweepLegacyStealth\(/g) ?? [];
    expect(sweeps.length).toBeGreaterThanOrEqual(6);
  });

  it('does not hand the user keypair to shieldV3 as depositor', () => {
    // The measured defect: ShieldDenominatedV3 at devnet slot 481,009,924 had
    // the user's wallet as the only signer, because the store passed `localKp`
    // straight through as `overrideKeypair`.
    expect(CODE).not.toMatch(/shieldV3\([\s\S]{0,600}?localKp\s*\|\|\s*undefined/);
    expect(CODE).toMatch(/shieldV3\([\s\S]{0,600}?depositorKp\s*\|\|\s*undefined/);
    expect(CODE).toContain('deriveShieldEphemeral(');
    expect(CODE).toContain('resumeShieldPrefund(');
  });

  it('persists the stealth claim BEFORE the withdrawal is submitted', () => {
    // Order matters absolutely: the sender-side ephemeral is random and is not
    // on chain, so a record written after submission leaves a window in which a
    // process death loses the denomination.
    //
    // This MUST be checked inside each action's own body. A whole-file
    // `lastIndexOf` passes even when one path's record is deleted, because the
    // other path's record sits earlier in the file — that hollow version of
    // this test survived a mutation that removed the V3 record entirely.
    function bodyBetween(startMarker: string, endMarker: string): string {
      const from = CODE.indexOf(startMarker);
      const to = CODE.indexOf(endMarker);
      expect(from, `missing ${startMarker}`).toBeGreaterThan(-1);
      expect(to, `missing ${endMarker}`).toBeGreaterThan(from);
      return CODE.slice(from, to);
    }

    const paths: Array<[string, string, string]> = [
      ['unshieldNoteStark: async (', 'unshieldNoteStarkV3: async (', 'await unshieldStark('],
      ['unshieldNoteStarkV3: async (', 'transferNoteStark: async (', 'await unshieldDenominatedStarkV3('],
    ];
    for (const [start, end, submit] of paths) {
      const body = bodyBetween(start, end);
      const buildAt = body.indexOf('buildPendingStealthSweep(');
      const submitAt = body.indexOf(submit);
      expect(buildAt, `${start} has no buildPendingStealthSweep`).toBeGreaterThan(-1);
      expect(submitAt, `${start} has no ${submit}`).toBeGreaterThan(-1);
      expect(buildAt, `${start} records the claim AFTER submitting`).toBeLessThan(submitAt);
    }
  });

  it('persists the pending sweeps through the storage partializer', () => {
    expect(CODE).toMatch(/partialize:[\s\S]{0,400}pendingStealthSweeps/);
  });

  it('does not clear the pending sweeps on reset — they are not re-derivable', () => {
    const resetBody = CODE.slice(CODE.lastIndexOf('reset: () =>'));
    expect(resetBody).not.toMatch(/pendingStealthSweeps:\s*\[\]/);
  });
});
