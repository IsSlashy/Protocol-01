/**
 * The one request that hands the pool seed back to the page.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY THIS EXISTS
 * ───────────────
 * The seed is every note this identity will ever own: whoever holds it derives
 * every secret, every nullifier and every commitment, and can spend all of them
 * — including notes not yet created. The whole worker boundary exists to keep
 * it inside the worker, and this is the single hole in that wall.
 *
 * It is there because `P01_TREASURY_POOL_SEED` cannot be obtained any other
 * way: it derives from a wallet signature made in a browser, so a deployment
 * that issues notes is unconfigurable without it. The alternatives are worse —
 * a wallet private key on a server, or an operator hand-porting an HKDF chain
 * and getting it subtly wrong in a way that only surfaces as notes nobody can
 * spend.
 *
 * So: the format has to be exactly what the env var expects, the confirmation
 * has to be required, and an identity with no keys has to refuse rather than
 * return something empty-looking. All three are cheap to get wrong and none of
 * them fails loudly in a browser.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  clearPoolState,
  handlePoolRequest,
  setPoolSeed,
} from '../worker/poolHandlers';

const META = 'meta-treasury';
const SIGNATURE = new Uint8Array(64).fill(9);
const CONFIRM =
  'I am configuring a note-issuing treasury and accept that this seed can spend every note it derives';

beforeEach(() => {
  clearPoolState();
});

describe('exporting the pool seed', () => {
  it('returns exactly the format P01_TREASURY_POOL_SEED expects', async () => {
    // 64 lowercase hex characters. The route parses with
    // /^[0-9a-fA-F]{64}$/ and then reads two characters at a time, so anything
    // else — a 0x prefix, base58, uppercase-only, a trailing newline — is a
    // deployment that reports "unset or not 64 hex characters" while the
    // operator is looking at a value they just copied.
    setPoolSeed(META, SIGNATURE);
    const res = await handlePoolRequest({ kind: 'poolExportSeed', meta: META, confirm: CONFIRM });
    expect(res.kind).toBe('poolExportSeed');
    expect(res.seedHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic in the signature, which is the whole recovery property', async () => {
    // The treasury's notes derive from this value. If it were not stable across
    // derivations, an env var copied today would stop matching the notes
    // tomorrow and the issuance route would refuse every leaf on its on-chain
    // check — the correct failure, for an incomprehensible reason.
    setPoolSeed(META, SIGNATURE);
    const a = await handlePoolRequest({ kind: 'poolExportSeed', meta: META, confirm: CONFIRM });
    clearPoolState();
    setPoolSeed(META, SIGNATURE);
    const b = await handlePoolRequest({ kind: 'poolExportSeed', meta: META, confirm: CONFIRM });
    expect(a.seedHex).toBe(b.seedHex);
  });

  it('gives a DIFFERENT seed for a different signature', async () => {
    // The negative control. A function that returned a constant would satisfy
    // every case above.
    setPoolSeed(META, SIGNATURE);
    const a = await handlePoolRequest({ kind: 'poolExportSeed', meta: META, confirm: CONFIRM });
    clearPoolState();
    setPoolSeed(META, new Uint8Array(64).fill(11));
    const b = await handlePoolRequest({ kind: 'poolExportSeed', meta: META, confirm: CONFIRM });
    expect(a.seedHex).not.toBe(b.seedHex);
  });

  it('reports a legacy seed, because notes may derive from THAT one', async () => {
    // A wallet that adopted a passphrase has two seeds, and notes shielded
    // before it derive from the legacy one. A treasury configured with the
    // active seed alone reproduces none of them, and the issuance route refuses
    // on its on-chain check — right failure, opaque reason. The flag is what
    // lets the operator be told.
    setPoolSeed(META, SIGNATURE, 'a passphrase this wallet adopted');
    const res = await handlePoolRequest({ kind: 'poolExportSeed', meta: META, confirm: CONFIRM });
    expect(res.hasLegacySeed).toBe(true);
    expect(res.seedHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports no legacy seed for a wallet that never had one', async () => {
    setPoolSeed(META, SIGNATURE);
    const res = await handlePoolRequest({ kind: 'poolExportSeed', meta: META, confirm: CONFIRM });
    expect(res.hasLegacySeed).toBe(false);
  });
});

describe('what it refuses', () => {
  it('refuses without the exact confirmation string', async () => {
    // Not security — anyone who can post this message can post that string. It
    // guards against the call being reached by a refactor, an autocomplete, or
    // a helper that forwards every request kind. A value that must be typed out
    // is a value somebody had to mean.
    setPoolSeed(META, SIGNATURE);
    await expect(
      handlePoolRequest({ kind: 'poolExportSeed', meta: META, confirm: 'yes' } as never),
    ).rejects.toThrow(/confirmation string does not match/);
  });

  it('refuses an identity that holds no keys, rather than returning nothing', async () => {
    // What an operator hits when they press the button before signing. An empty
    // string here would be pasted into an env var and produce a deployment that
    // issues notes derived from nothing.
    await expect(
      handlePoolRequest({ kind: 'poolExportSeed', meta: 'never-derived', confirm: CONFIRM }),
    ).rejects.toThrow(/No pool keys/);
  });
});
