/**
 * poolHandlers — WHICH CIRCUIT A WITHDRAWAL MESSAGE ROUTES TO.
 *
 * `unshieldV4Job.test.ts` proves the circuit-7 job itself behaves (it refuses
 * its own funder, its job id cannot collide with the v3 one). This file proves
 * the WORKER picks the right one of the two and carries the choice through to
 * execute, which is where the interesting failures live:
 *
 *   a v3 request that silently became v4   the subscription proves on a circuit
 *                                          the program has no instruction for,
 *                                          and dies at the END of a ~150-tx
 *                                          upload.
 *   a v4 request that silently became v3   the note's commitment is published
 *                                          in cleartext again. Nothing fails.
 *                                          The withdrawal still lands. The only
 *                                          symptom is a privacy claim that has
 *                                          stopped being true.
 *   a v4 job that silently changed payee   the withdrawal lands, and it pays
 *                                          somebody else. This one is money.
 *
 * The middle one is why every assertion here is written in BOTH directions: the
 * fallback works, so nothing else in the suite would ever notice it.
 *
 * Everything that touches the chain or a prover is stubbed. What is measured is
 * exclusively which function the handler called, with which arguments, and what
 * it told the caller it had done.
 *
 * Runs under `vitest.pool.config.mts` (node) — its include is `lib/** /*.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RecoveredNote } from '../pool/poolNotes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNATURE = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIGNATURE[i] = (i * 7 + 3) & 0xff;

const META = 'meta-under-test';
const POOL_58 = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG'; // 0.1 SOL pool
const DENOM = 0.1;
const LEAF = 11;

/** The user's wallet. Identity only — it is what arms the payee refusal. */
const OWNER = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
/** A derived payout address: a third party, so the refusal must NOT fire. */
const RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
/** A DIFFERENT payee, for the mismatch. Circuit 7 was never proved for it. */
const OTHER_PAYEE = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/**
 * THE REAL JOB-ID FORMULAE, not placeholders — and the difference is the entire
 * subject of the "two payees" describe below.
 *
 * The first draft of this file stubbed `'unshield-v4:job'`, a constant. A
 * constant is accidentally safe in the one way that matters here: it is
 * different from nothing, so nothing can collide with it. The real formula
 * (unshieldEphemeral.ts:445) is `unshield-v4:<pool>:<leaf>` and names NO payee,
 * while the job it identifies is bound to exactly one. A stub that does not
 * reproduce that cannot see the overwrite it causes, which is why the first
 * version of this file passed while the defect was live.
 */
const V3_JOB_ID = `unshield:${POOL_58}:${LEAF}`;
const V4_JOB_ID = `unshield-v4:${POOL_58}:${LEAF}`;

const NOTE: RecoveredNote = {
  counter: LEAF,
  spent: false,
  receipt: {
    secret: 11_001n,
    nullifierPreimage: 11_002n,
    noteBlinding: 7n,
    tokenMint: 0n,
    commitment: 11_003n,
    leafIndex: LEAF,
    denomination: 100_000_000n,
    pool: POOL_58,
    token: 'SOL',
    denominationHuman: DENOM,
    shieldedAt: 0,
    source: 'shielded',
  },
};

/**
 * Every call the handler made, in order, with the arguments that decide the
 * outcome. Recorded rather than spied so an assertion can pin ARGUMENT ORDER:
 * `prepareUnshieldJobV4(receipt, recipient, ownerPubkey, …)` puts two
 * interchangeable-looking `PublicKey`s side by side, and swapping them compiles,
 * runs, and turns the payee refusal into a check of the wallet against itself.
 */
const seen = {
  prepareV3: [] as Array<{ leafIndex: number }>,
  prepareV4: [] as Array<{ leafIndex: number; recipient: string; ownerPubkey: string }>,
  executeV3: [] as Array<{ jobId: string; recipient: string; ownerPubkey: string }>,
  // `boundPayee` is `ctx.recipient` — the payee circuit 7 was proved against,
  // read back off the STORED job. Recording it is what makes a swapped payee
  // observable at all: without it a test can only see that *a* v4 send happened,
  // which is precisely what a silent overwrite looks like from the outside.
  executeV4: [] as Array<{ jobId: string; boundPayee: string; ownerPubkey: string }>,
  prepareSubscribe: [] as number[],
};

/**
 * Injected failure for the circuit-7 prepare.
 *
 * `prepareUnshieldV4` has no stored-path shortcut — it always rebuilds the
 * Merkle path from event history (unshieldEphemeral.ts:385-388) — so it can
 * fail on a note the C1 + C3 pair still spends, because that pair tries the
 * path captured at shield time first. That is a ROUTING fact about two
 * functions, and this variable is the only way to reach it without an RPC.
 */
let v4PrepareFailure: Error | null = null;

// ---------------------------------------------------------------------------
// Chain stubs
// ---------------------------------------------------------------------------

vi.mock('../pool/poolNotes', () => ({
  scanPoolForSeed: async () => ({ notes: [NOTE] }),
  // One seed, one note, at one leaf. Derivation search is `poolHandlersDerivation
  // .test.ts`'s subject and is deliberately not re-tested here.
  recoverNotes: async (_c: unknown, _p: unknown, _s: unknown, opts?: { onlyLeaf?: number }) =>
    opts?.onlyLeaf === LEAF ? [NOTE] : [],
}));

vi.mock('../pool/recoverFloat', () => ({ recoverStuckFloat: async () => [] }));

vi.mock('../pool/shieldEphemeral', () => ({
  readTreeLeafCount: async () => 40,
  prepareShield: async () => {
    throw new Error('not exercised');
  },
  executeShield: async () => {
    throw new Error('not exercised');
  },
  recordShieldBreadcrumb: async () => undefined,
}));

/**
 * The subscribe path, stubbed at the ONE function that proves the point: it
 * records the call and stops, so `handlePoolSubscribePrepare` never reaches the
 * STARK wasm it would otherwise import to compute `subscriberCommitment`. The
 * real `prepareSubscribeJob` calls `prepareUnshieldJob` verbatim
 * (subscribeEphemeral.ts:115) and is pinned as such by `spendRouting.test.ts`.
 */
vi.mock('../pool/subscribeEphemeral', () => ({
  prepareSubscribeJob: async (receipt: { leafIndex: number }) => {
    seen.prepareSubscribe.push(receipt.leafIndex);
    throw new Error('SUBSCRIBE_REACHED_PREPARE_SUBSCRIBE_JOB');
  },
  executeSubscribe: async () => {
    throw new Error('not exercised');
  },
}));

vi.mock('../pool/unshieldEphemeral', () => ({
  prepareUnshieldJob: async (receipt: { leafIndex: number }, poolConfig: unknown) => {
    seen.prepareV3.push({ leafIndex: receipt.leafIndex });
    return {
      jobId: V3_JOB_ID,
      poolConfig,
      receipt,
      ephemeral: { publicKey: { toBase58: () => 'EPH_V3' } },
      requiredLamports: 456,
      rawRequiredLamports: 400,
      prepared: {},
    };
  },
  executeUnshield: async (
    ctx: { jobId: string },
    _conn: unknown,
    recipient: PublicKey,
    ownerPubkey: PublicKey,
  ) => {
    seen.executeV3.push({
      jobId: ctx.jobId,
      recipient: recipient.toBase58(),
      ownerPubkey: ownerPubkey.toBase58(),
    });
    return { txSig: 'V3_TX' };
  },
  prepareUnshieldJobV4: async (
    receipt: { leafIndex: number },
    recipient: PublicKey,
    ownerPubkey: PublicKey,
    poolConfig: unknown,
  ) => {
    seen.prepareV4.push({
      leafIndex: receipt.leafIndex,
      recipient: recipient.toBase58(),
      ownerPubkey: ownerPubkey.toBase58(),
    });
    // Recorded BEFORE the throw: a fallback test has to be able to see that
    // circuit 7 was genuinely attempted and not skipped.
    if (v4PrepareFailure) throw v4PrepareFailure;
    return {
      // ⛔ PAYEE-INDEPENDENT, exactly as the real one is. Do NOT "fix" this stub
      // by adding the payee to it: keeping two payees apart is the handler's
      // job, and a stub that does it for them measures nothing.
      jobId: V4_JOB_ID,
      poolConfig,
      receipt,
      ephemeral: { publicKey: { toBase58: () => 'EPH_V4' } },
      // Carried in the context because circuit 7 bound it at prove time. The
      // execute handler reads it back off this field, so it is the fixture the
      // mismatch and collision tests both turn on.
      recipient,
      // Materially smaller than the v3 figure: one proof buffer, not two.
      requiredLamports: 231,
      rawRequiredLamports: 200,
      prepared: {},
    };
  },
  executeUnshieldV4: async (
    ctx: { jobId: string; recipient: PublicKey },
    _conn: unknown,
    ownerPubkey: PublicKey,
  ) => {
    // `ctx.recipient`, never an argument: `executeUnshieldV4` TAKES no recipient
    // — the payee it pays comes off the stored context. That is exactly why an
    // overwritten context redirects the money rather than failing.
    seen.executeV4.push({
      jobId: ctx.jobId,
      boundPayee: ctx.recipient.toBase58(),
      ownerPubkey: ownerPubkey.toBase58(),
    });
    return { txSig: 'V4_TX' };
  },
}));

vi.mock('../pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pool/denominatedPool')>();
  return {
    ...actual,
    fetchPoolCommitments: async () =>
      new Map([
        [
          NOTE.receipt.commitment.toString(),
          { commitment: NOTE.receipt.commitment, leafIndex: LEAF },
        ],
      ]),
    fetchSpentNullifierSet: async () => new Set<string>(),
    readPoolUnspentCount: async () => 7,
  };
});

// Imported after the mocks so the handler binds to the stubs.
const { clearPoolState, configurePoolHandlers, handlePoolRequest, setPoolSeed } = await import(
  './poolHandlers'
);

// ---------------------------------------------------------------------------

function prepareReq(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'poolUnshieldPrepare' as const,
    meta: META,
    token: 'SOL' as const,
    denomination: DENOM,
    leafIndex: LEAF,
    ...overrides,
  };
}

beforeEach(() => {
  clearPoolState();
  seen.prepareV3 = [];
  seen.prepareV4 = [];
  seen.executeV3 = [];
  seen.executeV4 = [];
  seen.prepareSubscribe = [];
  v4PrepareFailure = null;
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE);
});

// ===========================================================================

describe('a prepare with no payee is the v3 path, unchanged', () => {
  it('proves on C1 + C3 and never touches the circuit-7 prepare', async () => {
    const res = await handlePoolRequest(prepareReq());

    expect(seen.prepareV3).toEqual([{ leafIndex: LEAF }]);
    // The other direction, and it is the one that matters: a v3 request that
    // reached circuit 7 would prove against an instruction the subscription
    // has no on-chain equivalent of.
    expect(seen.prepareV4).toEqual([]);
    expect(res.jobId).toBe(V3_JOB_ID);
    expect(res.requiredLamports).toBe(456);
    expect(res.ephemeralPubkey).toBe('EPH_V3');
  });

  it('says v3 out loud, so the caller never has to infer it from the job id', async () => {
    const res = await handlePoolRequest(prepareReq());
    expect(res.version).toBe('v3');
  });

  /**
   * The HALF-SPECIFIED request — exactly one of the pair.
   *
   * 🚨 THIS USED TO BE A SILENT v3, AND THAT WAS THE DEFECT. A caller that means
   * circuit 7 and drops one field got the C1 + C3 pair, which republishes the
   * note's commitment in cleartext, with nothing raised anywhere: the withdrawal
   * still lands, and the only symptom is a privacy claim that has quietly
   * stopped being true. No caller legitimately holds one of the two — the payee
   * is a circuit input and the wallet arms the payee refusal — so a request
   * carrying one is a programming error, and the one thing a programming error
   * must not do is succeed by publishing MORE than it was asked to.
   *
   * NEITHER field is still v3, unchanged, and neither is what the subscribe path
   * sends. The refusal is only for the half-specified shape.
   */
  it('refuses a half-specified request rather than silently publishing the commitment', async () => {
    await expect(handlePoolRequest(prepareReq({ recipient: RECIPIENT }))).rejects.toThrow(
      /both `recipient` and `ownerPubkey`/,
    );
    await expect(handlePoolRequest(prepareReq({ ownerPubkey: OWNER }))).rejects.toThrow(
      /both `recipient` and `ownerPubkey`/,
    );

    // NEITHER circuit ran. A refusal that still proved something would have
    // spent the ~5.5 seconds it exists to save.
    expect(seen.prepareV3).toEqual([]);
    expect(seen.prepareV4).toEqual([]);
  });

  it('names the field that is missing, because "invalid request" is not actionable', async () => {
    // ⚠️ Asserted on the phrase that names the ABSENT field, not on the field
    // name alone: the sentence mentions both fields, so `/ownerPubkey/` would
    // pass for either half and measure nothing.
    const missingWallet = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT }),
    ).catch((e: Error) => e);
    expect(String(missingWallet)).toContain('missing `ownerPubkey`');

    const missingPayee = await handlePoolRequest(prepareReq({ ownerPubkey: OWNER })).catch(
      (e: Error) => e,
    );
    expect(String(missingPayee)).toContain('missing `recipient`');
  });
});

describe('a prepare carrying a payee and a wallet routes to circuit 7', () => {
  it('proves on the single circuit-7 trace and never on the C1 + C3 pair', async () => {
    const res = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );

    expect(seen.prepareV4).toHaveLength(1);
    expect(seen.prepareV3).toEqual([]);
    // `toContain`, not `toBe`: the handler QUALIFIES the stored key with the
    // payee — see the "two payees" describe, which is where that shape is
    // pinned exactly. What this assertion is about is that a v4 request got a
    // v4 job.
    expect(res.jobId).toContain(V4_JOB_ID);
    expect(res.version).toBe('v4');
    expect(res.ephemeralPubkey).toBe('EPH_V4');
    // Reported from the job, not assumed: one proof buffer is priced, not two.
    expect(res.requiredLamports).toBe(231);
  });

  /**
   * ARGUMENT ORDER, PINNED. `prepareUnshieldJobV4(receipt, recipient,
   * ownerPubkey, …)` puts two `PublicKey`s next to each other. Swapped, it
   * type-checks, it runs, and the refusal inside it compares the wallet against
   * the wallet — so it can never fire, and the note pays out to the wallet that
   * funded the withdrawal: the exact defect /pay shipped until 2026-08-04.
   * Nothing else in this file or the suite would see it.
   */
  it('hands the payee and the wallet down in the order the refusal depends on', async () => {
    await handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }));

    expect(seen.prepareV4[0]).toEqual({
      leafIndex: LEAF,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });
    expect(seen.prepareV4[0].recipient).not.toBe(seen.prepareV4[0].ownerPubkey);
  });

  it('sends it with executeUnshieldV4 and the payee the proof is bound to', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V4_TX');
    expect(done.denomination).toBe(DENOM);
    expect(seen.executeV4).toEqual([
      { jobId: V4_JOB_ID, boundPayee: RECIPIENT, ownerPubkey: OWNER },
    ]);
    expect(seen.executeV3).toEqual([]);
  });

  it('still accepts an execute with no recipient, because the proof already names one', async () => {
    // The contract keeps `recipient` optional at execute. This is the shape a
    // third-party caller may still send, and it must reach the STORED payee —
    // never a default, never the wallet.
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V4_TX');
    expect(seen.executeV4[0]!.boundPayee).toBe(RECIPIENT);
  });
});

// ===========================================================================
// 💰 TWO PAYEES, ONE NOTE
// ===========================================================================

/**
 * 🚨 FUND-LOSS CLASS, AND IT IS NOT THE OBVIOUS ONE.
 *
 * The v4 job id is `unshield-v4:<pool>:<leaf>` (unshieldEphemeral.ts:445) — it
 * names NO payee — while the v4 job is BOUND to one, because sha256(recipient)
 * is four of circuit 7's six public inputs. `preparedUnshields` is a Map. So a
 * second prepare of the same note for a different payee used to land on the same
 * key and replace the first job wholesale: proof, context and payee together.
 *
 * The ephemeral does not change with the payee either — it is deterministic in
 * (pool seed, pool, leaf) — so the first caller's pre-fund sits on exactly the
 * signer the second caller's proof will spend from. Execute the FIRST job id and
 * the money goes to the SECOND payee, with no error anywhere.
 *
 * ⛔ AND THE GUARD BUILT FOR THIS COULD NOT FIRE. The execute handler refuses a
 * recipient that disagrees with the stored one — but only when a recipient is
 * PASSED, and the client deliberately passed none on v4, on the reasoning that
 * "the only value that can never be wrong is no value at all". That reasoning is
 * circular: passing nothing is exactly what makes the disagreement invisible.
 *
 * The v3 path was never exposed to this. Its payee travels on the execute
 * message, so an overwritten v3 context still pays the address the caller named.
 *
 * Fixed in two independent places, and both are asserted below, because either
 * one alone leaves the other caller unprotected:
 *   1. the handler keys the store by (job, payee), so the two jobs coexist;
 *   2. the client sends the payee at execute, so the guard is live on the one
 *      path that ships (`unshieldV4ClientRouting.test.ts` pins that half).
 */
describe('two payees for one note cannot be confused for each other', () => {
  it('pays the FIRST job its own payee after a second prepare for someone else', async () => {
    const a = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const b = await handlePoolRequest(
      prepareReq({ recipient: OTHER_PAYEE, ownerPubkey: OWNER }),
    );
    expect(seen.prepareV4).toHaveLength(2);

    // Executed with NO recipient — the weakest shape a caller can send, and the
    // one the mismatch guard cannot inspect. The store alone has to be right.
    await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: a.jobId,
      ownerPubkey: OWNER,
    });

    expect(
      seen.executeV4[0]!.boundPayee,
      "the first job paid the second prepare's payee — the store was overwritten",
    ).toBe(RECIPIENT);

    // And the second job is still there, still bound to its own payee: the fix
    // must keep both, not merely protect whichever ran first.
    await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: b.jobId,
      ownerPubkey: OWNER,
    });
    expect(seen.executeV4[1]!.boundPayee).toBe(OTHER_PAYEE);
  });

  it('gives the two prepares different job ids, because the note alone does not identify one', async () => {
    const a = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const b = await handlePoolRequest(
      prepareReq({ recipient: OTHER_PAYEE, ownerPubkey: OWNER }),
    );

    expect(a.jobId).not.toBe(b.jobId);
    // The payee IS the qualifier, pinned exactly here and nowhere else. The
    // `unshield-v4:` prefix survives, because `poolRecover` and every log line
    // read job ids by eye.
    expect(a.jobId).toBe(`${V4_JOB_ID}:${RECIPIENT}`);
    expect(b.jobId).toBe(`${V4_JOB_ID}:${OTHER_PAYEE}`);
  });

  /**
   * The v3 id must NOT gain a payee. A v3 prepare does not know one — that is
   * the whole difference between the circuits — so qualifying it would key the
   * map on `undefined` and quietly make every v3 job collide with every other.
   */
  it('leaves the v3 job id alone, which never had a payee to be qualified by', async () => {
    const res = await handlePoolRequest(prepareReq());
    expect(res.jobId).toBe(V3_JOB_ID);
  });
});

describe('a v4 job refuses a payee it was not proved for', () => {
  it('throws instead of quietly preferring one of the two', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldExecute',
        jobId: prep.jobId,
        recipient: OTHER_PAYEE,
        ownerPubkey: OWNER,
      }),
    ).rejects.toThrow(/cannot pay/);

    // NOTHING WAS SENT. The refusal is worth nothing if the withdrawal went out
    // anyway and the error only described it.
    expect(seen.executeV4).toEqual([]);
    expect(seen.executeV3).toEqual([]);
  });

  it('names both payees, because "mismatch" tells the caller nothing it can act on', async () => {
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const err = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: OTHER_PAYEE,
      ownerPubkey: OWNER,
    }).catch((e: Error) => e);

    expect(String(err)).toContain(RECIPIENT);
    expect(String(err)).toContain(OTHER_PAYEE);
    // The float is on the ephemeral by now and the job is dropped. Saying so is
    // the difference between recoverable money and money the user thinks is gone.
    expect(String(err)).toMatch(/Recover funds/);
  });

  it('drops the job, so the recovery path it points at is not blocked by it', async () => {
    // `handlePoolRecover` refuses while any withdrawal is in flight. A retained
    // job would lock the user out of the one path that returns the pre-fund the
    // refusal just stranded — so the throw stays inside the handler's `finally`.
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldExecute',
        jobId: prep.jobId,
        recipient: OTHER_PAYEE,
        ownerPubkey: OWNER,
      }),
    ).rejects.toThrow(/cannot pay/);

    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldExecute',
        jobId: prep.jobId,
        ownerPubkey: OWNER,
      }),
    ).rejects.toThrow(/Unknown withdrawal job/);
  });
});

// ===========================================================================
// ⛔ v3 IS NOT LEGACY — IT HAS TO STAY REACHABLE
// ===========================================================================

/**
 * 🚨 THE WEB CLIENT NOW ASKS FOR CIRCUIT 7 ON EVERY WITHDRAWAL, so this handler
 * is the ONLY place left that can still reach the C1 + C3 pair from apps/web.
 * `unshieldFromPool` types `recipient` and `owner` as required and sends both
 * unconditionally; there is no caller that omits them. Without the fallback
 * below, the v3 branch is dead code in production and any note circuit 7 cannot
 * prove stops being withdrawable from the web app at all.
 *
 * The two prepares are NOT equivalent, and the asymmetry runs one way:
 *   `prepareUnshieldJob`  tries the Merkle path captured when the note was
 *                         shielded, and only rebuilds from history if that path
 *                         has aged out (unshieldEphemeral.ts:163-172).
 *   `prepareUnshieldV4`   has no stored-path route at all. It always rebuilds,
 *                         and refuses when the rebuilt root is outside the
 *                         pool's 100-root ring.
 *
 * ⛔ AN ALLOW-LIST, NOT A DENY-LIST, and that is the safety property. Only
 * failures of the REBUILD are routed around. Anything unrecognised is rethrown,
 * so a new failure mode fails CLOSED — loudly on v4 — rather than silently
 * finding its way onto the path that republishes the commitment. A prover that
 * cannot produce a circuit-7 trace is a bug to surface, not to route around.
 */
describe('a note circuit 7 cannot prove still reaches the C1 + C3 pair', () => {
  const PREFLIGHT = () =>
    new Error(
      "PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots " +
        '(current + 100 historical). Aborting before proof rent is spent.',
    );

  it('falls back to the v3 prepare when the rebuild has no usable root', async () => {
    v4PrepareFailure = PREFLIGHT();
    const res = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );

    // Circuit 7 was genuinely ATTEMPTED and then fell back — not skipped.
    expect(seen.prepareV4).toHaveLength(1);
    expect(seen.prepareV3).toEqual([{ leafIndex: LEAF }]);
    expect(res.jobId).toBe(V3_JOB_ID);
  });

  it('reports v3, so no screen upgrades its disclosure on a spend that publishes the commitment', async () => {
    v4PrepareFailure = PREFLIGHT();
    const res = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    expect(res.version).toBe('v3');
  });

  it('produces a job that executes as v3 — the payee is required, not stored', async () => {
    v4PrepareFailure = PREFLIGHT();
    const prep = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V3_TX');
    expect(seen.executeV3).toEqual([
      { jobId: V3_JOB_ID, recipient: RECIPIENT, ownerPubkey: OWNER },
    ]);
    expect(seen.executeV4).toEqual([]);
  });

  it('also falls back when the rebuilt path is too shallow for the circuit', async () => {
    v4PrepareFailure = new Error('Merkle path is 9 deep; circuit 7 needs at least 12.');
    const res = await handlePoolRequest(
      prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER }),
    );
    expect(res.version).toBe('v3');
  });

  /**
   * ⛔ THE PAYEE REFUSAL MUST NOT BE LAUNDERED INTO A v3 JOB.
   *
   * `prepareUnshieldJobV4` refuses `recipient === ownerPubkey` at PROVE time.
   * `prepareUnshieldJob` makes no such check — on the v3 path the refusal lives
   * inside `executeUnshield`, which runs AFTER the pre-fund has landed. So a
   * fallback that swallowed this error would convert a free refusal into a
   * stranded pre-fund, and undo the single reason the payee moved to prepare.
   */
  it('does NOT fall back when the payee is the wallet funding the withdrawal', async () => {
    v4PrepareFailure = new Error(
      'Refusing to withdraw to the wallet that funded this withdrawal — that names it ' +
        'on-chain as the pool payee.',
    );
    await expect(
      handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })),
    ).rejects.toThrow(/Refusing to withdraw to the wallet/);

    expect(seen.prepareV3, 'the refused payee reached the C1 + C3 prepare').toEqual([]);
  });

  it('does NOT fall back when the note is already spent', async () => {
    v4PrepareFailure = new Error('This note has already been withdrawn.');
    await expect(
      handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })),
    ).rejects.toThrow(/already been withdrawn/);
    expect(seen.prepareV3).toEqual([]);
  });

  it('does NOT fall back on an unrecognised failure — the allow-list fails closed', async () => {
    v4PrepareFailure = new Error('wasm prover panicked while generating the spend trace');
    await expect(
      handlePoolRequest(prepareReq({ recipient: RECIPIENT, ownerPubkey: OWNER })),
    ).rejects.toThrow(/wasm prover panicked/);
    expect(seen.prepareV3).toEqual([]);
  });

  /**
   * ANTI-VACUITY for the allow-list. The two strings it matches on are produced
   * by another file; if they were reworded the fallback would silently stop
   * firing and every test above would still pass, because they inject the
   * message themselves. This is the only assertion that reads the real source.
   */
  it('matches failures the circuit-7 prepare can actually produce', () => {
    const src = readFileSync(join(__dirname, '../pool/denominatedPool.ts'), 'utf8');
    expect(src, 'the root pre-flight no longer says PRE-FLIGHT FAIL').toContain(
      'PRE-FLIGHT FAIL',
    );
    expect(src, 'the subtree-depth refusal was reworded').toContain('circuit 7 needs at least');

    // And the two it deliberately does NOT match, for the same reason.
    const eph = readFileSync(join(__dirname, '../pool/unshieldEphemeral.ts'), 'utf8');
    expect(eph).toContain('Refusing to withdraw to the wallet');
    expect(eph).toContain('already been withdrawn');
  });
});

describe('a v3 job still requires the payee at execute, because its proof names none', () => {
  it('passes the payee straight through when it is there', async () => {
    const prep = await handlePoolRequest(prepareReq());
    const done = await handlePoolRequest({
      kind: 'poolUnshieldExecute',
      jobId: prep.jobId,
      recipient: RECIPIENT,
      ownerPubkey: OWNER,
    });

    expect(done.txSig).toBe('V3_TX');
    expect(seen.executeV3).toEqual([
      { jobId: V3_JOB_ID, recipient: RECIPIENT, ownerPubkey: OWNER },
    ]);
    expect(seen.executeV4).toEqual([]);
  });

  it('refuses rather than inventing one when it is missing', async () => {
    // Making the recipient optional on the wire is what makes this reachable at
    // all. Defaulting to the wallet here is exactly how `owner` reached
    // `recipient` in PoolPanel.tsx:125 and paid the pool out to the funder.
    const prep = await handlePoolRequest(prepareReq());
    await expect(
      handlePoolRequest({
        kind: 'poolUnshieldExecute',
        jobId: prep.jobId,
        ownerPubkey: OWNER,
      }),
    ).rejects.toThrow(/names no payee/);
    expect(seen.executeV3).toEqual([]);
  });
});

// ===========================================================================
// ⛔ THE SUBSCRIPTION MUST NOT MOVE
// ===========================================================================

/**
 * 🚨 UPDATED 2026-08-27. This block used to open "There is no
 * `subscribe_private_stark_v4` on chain". THERE NOW IS
 * (`programs/zk_shielded/src/lib.rs:549`), and the subscribe path is wired to it
 * through `prepareSubscribeJobV4` / `executeSubscribeV4`. Everything below still
 * holds, and the reason it matters is now STRONGER rather than gone: the two v4
 * instructions bind DIFFERENT digests — the withdrawal `sha256(recipient)`, the
 * subscribe a 132-byte `"P01:C7:SUBSCRIBE:v1" || vault || rate ||
 * interval_slots || vk_hash || license` composite. A subscription that reached
 * the WITHDRAWAL's circuit-7 branch would build a proof the subscribe handler
 * refuses at the END of a ~78-chunk upload, in the flow the 2026-09-04 demo is
 * entirely about.
 *
 * TWO independent reasons it cannot happen, checked below by two different
 * methods. It was written as THREE, and the third was measured false:
 *
 *   DISPATCH  the two kinds land in two different handlers. Measured by the
 *             runtime test below, which smuggles the v4 fields into a subscribe
 *             message through a cast so that ONLY the dispatch is under test.
 *   SOURCE    `handlePoolSubscribePrepare` contains no reference to the v4
 *             prepare at all, and `prepareSubscribeJob` calls
 *             `prepareUnshieldJob` itself (subscribeEphemeral.ts:115).
 *
 * ⛔ THE RETRACTED ONE: "`PoolSubscribePrepareRequest` has no `recipient` and no
 * `ownerPubkey`, so `tsc` refuses a subscribe message carrying either." IT DOES
 * NOT. Measured 2026-08-26 in a scratch file inside this package's tsconfig: a
 * FRESH OBJECT LITERAL of kind `poolSubscribePrepare` carrying both fields, passed
 * to `handlePoolRequest`, raised nothing — while a deliberate type error in the
 * same file raised, proving tsc had the file in the program. The cause is that
 * `handlePoolRequest` is `<R extends PoolRequest>(req: R, …)`: excess-property
 * checking does not apply when the contextual type is a bare type parameter, and
 * the constraint check is plain assignability, which two extra string fields
 * satisfy. Nothing here depended on the claim, but it was written to be leaned
 * on by the next reader, which is worse than not writing it.
 */
describe('the subscribe path cannot reach the circuit-7 branch', () => {
  it('goes to prepareSubscribeJob, and would even if the v4 fields were smuggled in', async () => {
    // The cast is NOT belt-and-braces against the typecheck — the typecheck does
    // not stop this shape (see above). It is here because `handlePoolRequest`'s
    // parameter is a union and the literal has to be admitted to reach dispatch.
    await expect(
      handlePoolRequest({
        kind: 'poolSubscribePrepare',
        meta: META,
        token: 'SOL',
        denomination: DENOM,
        leafIndex: LEAF,
        recipient: RECIPIENT,
        ownerPubkey: OWNER,
      } as unknown as Parameters<typeof handlePoolRequest>[0]),
    ).rejects.toThrow('SUBSCRIBE_REACHED_PREPARE_SUBSCRIBE_JOB');

    // It reached the C1 + C3 prepare the subscription shares with the v3
    // withdrawal, and the circuit-7 prepare was never called.
    expect(seen.prepareSubscribe).toEqual([LEAF]);
    expect(seen.prepareV4).toEqual([]);
  });

  it('leaves no v4 reference inside handlePoolSubscribePrepare', () => {
    // Newlines normalised FIRST. The repo checks out CRLF on Windows, and the
    // first draft of the extractor below searched for '\n}\n' and found nothing
    // — which the anti-vacuity assertion caught as "could not find the end of
    // handlePoolUnshieldPrepare" instead of passing a vacuous negative.
    const src = readFileSync(join(__dirname, 'poolHandlers.ts'), 'utf8').replace(/\r\n/g, '\n');

    /** The body of one top-level `async function`, up to its closing brace. */
    function bodyOf(name: string): string {
      const start = src.indexOf(`async function ${name}(`);
      expect(start, `${name} is not a top-level async function in poolHandlers.ts`).toBeGreaterThan(
        -1,
      );
      const end = src.indexOf('\n}\n', start);
      expect(end, `could not find the end of ${name}`).toBeGreaterThan(start);
      return src.slice(start, end);
    }

    // ANTI-VACUITY FIRST. Both assertions below are `indexOf` over an extracted
    // string; if the extraction were broken — a renamed function, a changed
    // brace style — the negative assertion would pass while measuring nothing.
    // A guard that matched the wrong text has already shipped once on this
    // project (2026-08-25, a scan that matched a destructuring instead of the
    // `require!`), so the positive case is asserted before anything leans on it.
    expect(bodyOf('handlePoolUnshieldPrepare')).toContain('prepareUnshieldJobV4');
    expect(bodyOf('handlePoolSubscribePrepare')).not.toContain('prepareUnshieldJobV4');
    expect(bodyOf('handlePoolSubscribePrepare')).toContain('prepareSubscribeJob');
  });
});
