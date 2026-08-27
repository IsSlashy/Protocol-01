/**
 * WHICH CIRCUIT A SUBSCRIBE REQUEST REACHES, and what happens when its terms
 * move between the two messages.
 *
 * The withdrawal's twin of this file (`poolHandlersUnshieldV4.test.ts`) had one
 * routing question to answer: is a payee present. This one has a harder shape,
 * because a subscribe's proof is bound to FIVE things rather than one — the
 * vault (which transitively carries retailer, subscriber commitment and mint),
 * `rate`, `interval_slots`, `vk_hash_subscriber` and the licence commitment. All
 * five are inputs to `prepare`, and all five can drift before `execute`.
 *
 * 🚨 WHAT DRIFT COSTS, AND WHY IT IS WORTH A WHOLE FILE. If a different value
 * reaches the encoder than reached the prover, the 132-byte digest moves, the
 * buffer's `public_inputs_hash` stops matching, and the chain answers
 * `InvalidProof` — AFTER a ~78-chunk upload has been paid for, with no
 * indication of which field moved. Every refusal here replaces that with a
 * sentence, before the pre-fund is even priced.
 *
 * 💰 AND THE COLLISION, which is a FUND-LOSS shape already paid for once on the
 * v4 withdrawal. `subscribe:<pool>:<leaf>` names no terms while the job it
 * identifies is bound to them, and the ephemeral is deterministic in (seed,
 * pool, leaf) — so two prepares of one note for two retailers would land on one
 * map key, the second replacing the first, with the FIRST caller's pre-fund
 * sitting on exactly the signer the SECOND caller's proof spends from.
 * Everything looks green. The v4 job id is qualified by the vault to close it,
 * and the last test in this file is what measures that.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';

import type { RecoveredNote } from '../pool/poolNotes';
import { buildSubscribePrivateStarkV4Ix } from '../pool/subscribePrivateStarkV4';
import { goldilocksToLeBytes32, goldilocksU64To32 } from '../pool/denominatedPool';
import { decodeLicenseKey } from '../license';

const SIGNATURE = new Uint8Array(64);
const META = 'meta-under-test';
const POOL_58 = 'HfSsGRgVFJGBiiEtRXrHocNPw5dyTQ78hEZH8GWpXaAG'; // 0.1 SOL pool
const DENOM = 0.1;
const LEAF = 11;

const OWNER = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
const RETAILER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OTHER_RETAILER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const RATE = '250000';
const INTERVAL = '216000';

const V3_JOB_ID = `subscribe:${POOL_58}:${LEAF}`;

/** A vault PDA is opaque here; the stub just has to be deterministic in retailer. */
function fakeVaultFor(retailer: string): string {
  return retailer === RETAILER ? 'VAULT_FOR_RETAILER' : 'VAULT_FOR_OTHER';
}
function v4JobIdFor(retailer: string): string {
  return `subscribe-v4:${POOL_58}:${LEAF}:${fakeVaultFor(retailer)}`;
}

const NOTE: RecoveredNote = {
  counter: LEAF,
  spent: false,
  receipt: {
    leafIndex: LEAF,
    commitment: 123456789n,
    nullifierPreimage: 111n,
    secret: 222n,
    noteBlinding: 7_284_991_002_338_477_113n,
    tokenMint: 0n,
    depositEpoch: 0n,
    amount: 100_000_000n,
  },
} as unknown as RecoveredNote;

/**
 * The COMPLETE terms object the worker handed the circuit-7 prepare, kept
 * verbatim beside the summarised `prepareV4` row.
 *
 * 🚨 THIS IS THE ONLY CHANNEL THE WORKER HAS INTO THE WIRE. Every one of these
 * six values is either an instruction argument or a digest input, so a leak
 * planted anywhere in `handlePoolSubscribePrepare` has to travel through this
 * object to reach the chain. The leak sweep at the bottom of this file
 * serialises a real v4 instruction out of it — which is why the terms are kept
 * whole here rather than reduced to the booleans the routing tests need.
 */
type CapturedTerms = {
  retailer: PublicKey;
  subscriberCommitment: bigint;
  rate: bigint;
  intervalSlots: bigint;
  vkHashSubscriber: Uint8Array;
  licenseCommitment?: Uint8Array;
};

const seen = {
  prepareV3: [] as number[],
  prepareV4Terms: [] as CapturedTerms[],
  prepareV4: [] as Array<{
    leafIndex: number;
    retailer: string;
    rate: string;
    intervalSlots: string;
    hasLicence: boolean;
    vkFirstByte: number;
  }>,
  executeV3: [] as string[],
  // `boundRate` and `boundRetailer` are read back off the STORED job, never off
  // the execute message. Recording them is what makes a swapped term observable
  // at all: without it a test can only see that *a* v4 send happened, which is
  // precisely what a silent overwrite looks like from the outside.
  executeV4: [] as Array<{ jobId: string; boundRetailer: string; boundRate: string }>,
};

/** Injected failure for the circuit-7 prepare, so the fallback is reachable. */
let v4PrepareFailure: Error | null = null;

// ---------------------------------------------------------------------------
// Chain stubs
// ---------------------------------------------------------------------------

vi.mock('../pool/poolNotes', () => ({
  scanPoolForSeed: async () => ({ notes: [NOTE] }),
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
 * The STARK wasm, stubbed at the one call the subscribe prepare makes into it.
 * The real `computeCommitment` boots a nested worker and takes seconds; nothing
 * in this file is about the commitment's VALUE, only about whether the terms
 * that travel beside it survive intact.
 */
vi.mock('../pool/starkProver', () => ({
  starkProver: {
    start: async () => undefined,
    computeCommitment: async () => '987654321',
  },
}));

vi.mock('../pool/unshieldEphemeral', () => ({
  prepareUnshieldJob: async () => {
    throw new Error('not exercised');
  },
  executeUnshield: async () => {
    throw new Error('not exercised');
  },
  prepareUnshieldJobV4: async () => {
    throw new Error('not exercised');
  },
  executeUnshieldV4: async () => {
    throw new Error('not exercised');
  },
}));

vi.mock('../pool/subscribeEphemeral', () => ({
  prepareSubscribeJob: async (receipt: { leafIndex: number }, poolConfig: unknown) => {
    seen.prepareV3.push(receipt.leafIndex);
    return {
      jobId: V3_JOB_ID,
      poolConfig,
      receipt,
      ephemeral: { publicKey: { toBase58: () => 'EPH_V3' } },
      requiredLamports: 1_030_000_000,
      rawRequiredLamports: 1_000_000_000,
      prepared: {},
    };
  },
  executeSubscribe: async (ctx: { jobId: string }) => {
    seen.executeV3.push(ctx.jobId);
    return { txSig: 'V3_TX', vaultPDA: new PublicKey(RETAILER) };
  },
  prepareSubscribeJobV4: async (
    receipt: { leafIndex: number },
    poolConfig: { denomination: number },
    _conn: unknown,
    _seed: unknown,
    terms: CapturedTerms,
  ) => {
    seen.prepareV4Terms.push(terms);
    seen.prepareV4.push({
      leafIndex: receipt.leafIndex,
      retailer: terms.retailer.toBase58(),
      rate: terms.rate.toString(),
      intervalSlots: terms.intervalSlots.toString(),
      hasLicence: !!terms.licenseCommitment,
      vkFirstByte: terms.vkHashSubscriber[0]!,
    });
    // Recorded BEFORE the throw: a fallback test has to see that circuit 7 was
    // genuinely attempted and not skipped.
    if (v4PrepareFailure) throw v4PrepareFailure;
    return {
      // Qualified by the vault, exactly as the real one is. ⛔ Do NOT "simplify"
      // this stub to a leaf-only id: keeping two term-sets apart is the job
      // under test, and a stub that collides for them measures nothing.
      jobId: v4JobIdFor(terms.retailer.toBase58()),
      poolConfig,
      receipt,
      ephemeral: { publicKey: { toBase58: () => 'EPH_V4' } },
      binding: {
        vault: { toBase58: () => fakeVaultFor(terms.retailer.toBase58()) },
        rate: terms.rate,
        intervalSlots: terms.intervalSlots,
        vkHashSubscriber: terms.vkHashSubscriber,
        licenseCommitment: terms.licenseCommitment,
      },
      subscriberCommitment: 987_654_321n,
      retailer: terms.retailer,
      // Materially smaller than the v3 figure: ONE proof buffer, not two.
      requiredLamports: 553_000_000,
      rawRequiredLamports: 550_000_000,
      prepared: {},
    };
  },
  executeSubscribeV4: async (ctx: {
    jobId: string;
    retailer: PublicKey;
    binding: { rate: bigint };
  }) => {
    // Read off the STORED context, never off the execute message: that is what
    // makes an overwritten job observable as the wrong money moving.
    seen.executeV4.push({
      jobId: ctx.jobId,
      boundRetailer: ctx.retailer.toBase58(),
      boundRate: ctx.binding.rate.toString(),
    });
    return { txSig: 'V4_TX', vaultPDA: new PublicKey(RETAILER) };
  },
}));

vi.mock('../pool/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pool/denominatedPool')>();
  return {
    ...actual,
    // Deliberately EMPTY, so `origin` is null and the deposit-funder walk is
    // skipped. Who deposited the note is `shieldClient`'s question and has its
    // own tests; this file is about the terms.
    fetchPoolCommitments: async () => new Map(),
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
    kind: 'poolSubscribePrepare' as const,
    meta: META,
    token: 'SOL' as const,
    denomination: DENOM,
    leafIndex: LEAF,
    ...overrides,
  };
}

/** A prepare that asks for circuit 7: all three terms present. */
function v4PrepareReq(overrides: Record<string, unknown> = {}) {
  return prepareReq({
    retailer: RETAILER,
    rate: RATE,
    intervalSlots: INTERVAL,
    ...overrides,
  });
}

function executeReq(jobId: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'poolSubscribeExecute' as const,
    jobId,
    ownerPubkey: OWNER,
    retailer: RETAILER,
    rate: RATE,
    intervalSlots: INTERVAL,
    ...overrides,
  };
}

beforeEach(() => {
  clearPoolState();
  seen.prepareV3 = [];
  seen.prepareV4 = [];
  seen.prepareV4Terms = [];
  seen.executeV3 = [];
  seen.executeV4 = [];
  v4PrepareFailure = null;
  configurePoolHandlers('http://localhost:8899');
  setPoolSeed(META, SIGNATURE);
});

// ===========================================================================

describe('a subscribe prepare with no terms is the v3 path, unchanged', () => {
  it('proves on C1 + C3 and never touches the circuit-7 prepare', async () => {
    const res = await handlePoolRequest(prepareReq());
    expect(seen.prepareV3).toEqual([LEAF]);
    // The other direction, and it is the one that matters: the shared v3 prepare
    // must stay reachable, because a note whose blinding is unknown can be spent
    // nowhere else.
    expect(seen.prepareV4).toEqual([]);
    expect(res.jobId).toBe(V3_JOB_ID);
    expect(res.version).toBe('v3');
    expect(res.requiredLamports).toBe(1_030_000_000);
  });

  it('still executes on the v3 sender, with the terms read off the execute message', async () => {
    const prep = await handlePoolRequest(prepareReq());
    const done = await handlePoolRequest(executeReq(prep.jobId));
    expect(seen.executeV3).toEqual([V3_JOB_ID]);
    expect(seen.executeV4).toEqual([]);
    expect(done.txSig).toBe('V3_TX');
  });
});

describe('a subscribe prepare carrying its terms is the circuit-7 path', () => {
  it('routes to the v4 prepare and hands it every digest input', async () => {
    const res = await handlePoolRequest(v4PrepareReq());
    expect(seen.prepareV3).toEqual([]);
    expect(seen.prepareV4).toEqual([
      {
        leafIndex: LEAF,
        retailer: RETAILER,
        rate: RATE,
        intervalSlots: INTERVAL,
        // 🚨 DERIVED AT PREPARE, not at execute. The licence commitment is 33 of
        // the digest's 132 bytes, so it has to exist before the proof does. The
        // v3 path derives it at execute, which is still correct there because
        // nothing binds it.
        hasLicence: true,
        vkFirstByte: 0,
      },
    ]);
    expect(res.version).toBe('v4');
    expect(res.jobId).toBe(v4JobIdFor(RETAILER));
    // Materially smaller than the v3 float: one proof buffer, not two.
    expect(res.requiredLamports).toBe(553_000_000);
    expect(res.ephemeralPubkey).toBe('EPH_V4');
  });

  it('executes on the v4 sender with the terms it PROVED, not the ones resent', async () => {
    const prep = await handlePoolRequest(v4PrepareReq());
    const done = await handlePoolRequest(executeReq(prep.jobId));
    expect(seen.executeV3).toEqual([]);
    expect(seen.executeV4).toEqual([
      { jobId: v4JobIdFor(RETAILER), boundRetailer: RETAILER, boundRate: RATE },
    ]);
    expect(done.txSig).toBe('V4_TX');
    expect(done.licenseKey).toMatch(/^P01-/);
  });

  /**
   * ALL THREE, OR NONE — never "as much as you gave me".
   *
   * 🚨 A HALF-SPECIFIED REQUEST MUST NOT BE A SILENT v3. Every one of the three
   * is a circuit-7 digest input, so a caller holding two of them meant circuit 7
   * and dropped a field. Answering with the C1 + C3 pair republishes this note's
   * commitment in cleartext and raises nothing: the subscription still lands,
   * and the only symptom is a privacy claim that has quietly stopped being true.
   */
  it('refuses a half-specified request rather than silently publishing the commitment', async () => {
    for (const partial of [
      { retailer: RETAILER },
      { rate: RATE },
      { intervalSlots: INTERVAL },
      { retailer: RETAILER, rate: RATE },
      { rate: RATE, intervalSlots: INTERVAL },
    ]) {
      await expect(handlePoolRequest(prepareReq(partial))).rejects.toThrow(
        /`retailer`, `rate` and `intervalSlots` all on the/,
      );
    }
    // NEITHER circuit ran. A refusal that still proved something would have
    // spent the seconds it exists to save.
    expect(seen.prepareV3).toEqual([]);
    expect(seen.prepareV4).toEqual([]);
  });
});

describe('a note circuit 7 cannot prove still reaches the C1 + C3 pair', () => {
  /**
   * ⛔ WITHOUT THIS FALLBACK THE NOTE BECOMES UNSUBSCRIBABLE FROM THE WEB APP.
   * `subscribeFromPool` types the three terms as required and sends them on
   * every subscription, so this branch is the ONLY route apps/web has left to
   * the pair. `prepareSubscribeV4` has no stored-path shortcut and always
   * rebuilds from history; `prepareSubscribeJob` inherits `prepareUnshieldJob`'s
   * stored path. The asymmetry is real and runs one way.
   */
  it('falls back on a root the rebuild could not place, and says v3', async () => {
    v4PrepareFailure = new Error(
      "PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots.",
    );
    const res = await handlePoolRequest(v4PrepareReq());
    // Circuit 7 was genuinely ATTEMPTED — a fallback that skipped it would be a
    // silent downgrade rather than a recovery.
    expect(seen.prepareV4).toHaveLength(1);
    expect(seen.prepareV3).toEqual([LEAF]);
    expect(res.version).toBe('v3');
    expect(res.jobId).toBe(V3_JOB_ID);
  });

  it('falls back on a note that predates commitment blinding', async () => {
    v4PrepareFailure = new Error(
      'circuit 7 needs at least a randomised blinding, and this note carries its deposit epoch.',
    );
    const res = await handlePoolRequest(v4PrepareReq());
    expect(res.version).toBe('v3');
    expect(seen.prepareV3).toEqual([LEAF]);
  });

  /**
   * ⛔ AN ALLOW-LIST, NOT A DENY-LIST, and that is the whole safety property.
   * A prover that cannot produce a circuit-7 trace, or a caller that named a
   * vault the seeds do not derive, is a bug to SURFACE — not to route around
   * onto the path that republishes the note's commitment.
   */
  it('rethrows anything else, so a new failure mode fails CLOSED', async () => {
    v4PrepareFailure = new Error('the prover exploded in some entirely new way');
    await expect(handlePoolRequest(v4PrepareReq())).rejects.toThrow(/entirely new way/);
    expect(seen.prepareV3).toEqual([]);
  });
});

describe('the terms are CHECK-ONLY at execute, and a disagreement is refused', () => {
  /**
   * The proof already carries them. This branch may not APPLY anything the
   * caller resends — only refuse a disagreement, and refuse it BEFORE the
   * pre-fund is spent rather than after a ~78-chunk upload returns
   * `InvalidProof` with no indication of which field moved.
   */
  async function preparedJobId(): Promise<string> {
    const prep = await handlePoolRequest(v4PrepareReq());
    return prep.jobId;
  }

  it('refuses a rate that changed between the two messages', async () => {
    const jobId = await preparedJobId();
    await expect(handlePoolRequest(executeReq(jobId, { rate: '1' }))).rejects.toThrow(
      /proved at a rate of 250000/,
    );
    expect(seen.executeV4).toEqual([]);
  });

  it('refuses an interval that changed between the two messages', async () => {
    const jobId = await preparedJobId();
    await expect(
      handlePoolRequest(executeReq(jobId, { intervalSlots: '1' })),
    ).rejects.toThrow(/proved at an interval of 216000 slots/);
    expect(seen.executeV4).toEqual([]);
  });

  it('refuses a retailer that changed between the two messages', async () => {
    const jobId = await preparedJobId();
    await expect(
      handlePoolRequest(executeReq(jobId, { retailer: OTHER_RETAILER })),
    ).rejects.toThrow(/proved for retailer/);
    expect(seen.executeV4).toEqual([]);
  });

  it('refuses a serviceId that changed, because it moves the licence commitment', async () => {
    // `serviceId` reaches the digest INDIRECTLY: it picks the service tag, the
    // tag derives the licence secret from the note secret, and blake3 of that is
    // the 33-byte licence slot. A caller changing it between the two messages
    // moves the digest exactly as surely as changing the rate does.
    const jobId = await preparedJobId();
    await expect(
      handlePoolRequest(executeReq(jobId, { serviceId: 'some-other-service' })),
    ).rejects.toThrow(/service tag/);
    expect(seen.executeV4).toEqual([]);
  });

  it('refuses a vkHashSubscriber that changed', async () => {
    const jobId = await preparedJobId();
    await expect(
      handlePoolRequest(
        executeReq(jobId, { vkHashSubscriber: Array.from(new Uint8Array(32).fill(1)) }),
      ),
    ).rejects.toThrow(/different vkHashSubscriber/);
    expect(seen.executeV4).toEqual([]);
  });

  it('lets a matching set through to the sender', async () => {
    const jobId = await preparedJobId();
    await handlePoolRequest(executeReq(jobId));
    expect(seen.executeV4).toHaveLength(1);
  });
});

describe('💰 two prepares of one note for two retailers cannot collide', () => {
  /**
   * THE FUND-LOSS SHAPE, already paid for once on the v4 withdrawal.
   *
   * The ephemeral is deterministic in (seed, pool, leaf) and does NOT vary with
   * the terms. So if both prepares minted the same job id, the second would
   * replace the first in `preparedSubscribes` — proof, context and terms
   * together — and the first caller's pre-fund would be sitting on exactly the
   * signer the second caller's proof spends from. Executing the FIRST job id
   * would open the SECOND caller's vault, with no error anywhere.
   */
  /**
   * 🚨 THE THREE TESTS BELOW WERE HOLLOW, MEASURED 2026-08-27.
   *
   * An adversary dropped `:${vaultPDA.toBase58()}` from the job id in
   * `subscribeEphemeral.ts:510` — the qualification that stops two prepares of
   * the same note colliding — and all three STAYED GREEN.
   *
   * The reason is structural, not a typo: `prepareSubscribeJobV4` is MOCKED
   * here, and `v4JobIdFor()` above rebuilds the id from a template this file
   * owns. Both sides of the comparison moved together, so the source's real
   * construction was never exercised at all. A test that computes the expected
   * value the same way the code does can only ever agree with itself.
   *
   * ⚠️ This one IS a source scan, and a source scan is all a mocked path
   * leaves available. It is narrow on purpose: it asserts the vault is IN the
   * id, nothing about correctness beyond that. The behavioural half is the
   * three tests below; this is what keeps them from being satisfied by their
   * own mock.
   */
  it('builds the job id from the vault in the SOURCE, not just in this file', () => {
    // Comment-stripped by split/join rather than by regex: this file has been
    // rewritten by tooling twice and regex escapes did not survive it.
    const raw = readFileSync(join(__dirname, '../pool/subscribeEphemeral.ts'), 'utf8');
    const src = raw
      .split('/*')
      .map((part, i) => (i === 0 ? part : part.slice(part.indexOf('*/') + 2)))
      .join('')
      .split('\n')
      .map((line) => {
        const i = line.indexOf('//');
        return i < 0 ? line : line.slice(0, i);
      })
      .join('\n');

    const m = src.match(/`subscribe-v4:[^`]*`/);
    expect(
      m,
      'the v4 subscribe job id template is gone or was renamed — re-aim this guard',
    ).not.toBeNull();
    expect(
      m![0],
      'the v4 job id no longer names the vault, so two prepares of the same note with ' +
        'DIFFERENT terms collide on one key: the second replaces the first, and executing ' +
        "the first id opens the second caller's vault, with no error anywhere",
    ).toMatch(/vault/i);

    // ANTI-VACUITY: the v3 template must NOT carry a vault, or the assertion
    // above could be matching an unrelated occurrence of the word.
    const v3 = src.match(/`subscribe:[^`]*`/);
    if (v3) expect(v3[0]).not.toMatch(/vault/i);
  });


  it('mints two distinct job ids, so neither prepare can overwrite the other', async () => {
    const a = await handlePoolRequest(v4PrepareReq());
    const b = await handlePoolRequest(v4PrepareReq({ retailer: OTHER_RETAILER }));
    expect(a.jobId).not.toBe(b.jobId);
  });

  it('keeps BOTH jobs executable, each against the retailer it was proved for', async () => {
    // The real assertion: after the second prepare, the FIRST job id still opens
    // the FIRST retailer's vault. Under the collision it would have opened the
    // second's, and the txSig would have looked exactly the same.
    const a = await handlePoolRequest(v4PrepareReq());
    const b = await handlePoolRequest(v4PrepareReq({ retailer: OTHER_RETAILER }));

    await handlePoolRequest(executeReq(a.jobId));
    await handlePoolRequest(executeReq(b.jobId, { retailer: OTHER_RETAILER }));

    expect(seen.executeV4).toEqual([
      { jobId: v4JobIdFor(RETAILER), boundRetailer: RETAILER, boundRate: RATE },
      { jobId: v4JobIdFor(OTHER_RETAILER), boundRetailer: OTHER_RETAILER, boundRate: RATE },
    ]);
  });

  it('drops a job once it has run, so a replay cannot reuse the proof', async () => {
    const prep = await handlePoolRequest(v4PrepareReq());
    await handlePoolRequest(executeReq(prep.jobId));
    await expect(handlePoolRequest(executeReq(prep.jobId))).rejects.toThrow(
      /Unknown subscription job/,
    );
    expect(seen.executeV4).toHaveLength(1);
  });
});

// ===========================================================================
// THE PROPERTY — the one thing circuit 7 exists to deliver
// ===========================================================================

/**
 * 🚨 EVERYTHING ABOVE CHECKS THAT v4 IS WIRED CORRECTLY. That is necessary and
 * it is not sufficient, and the difference is the whole reason this block
 * exists: a WIRING bug produces a transaction that fails, and a LEAK produces a
 * transaction that SUCCEEDS while quietly naming the deposit that funded it.
 * Nothing else in apps/web measured the second kind on the subscribe path.
 *
 * MEASURED 2026-08-26: replacing `licenseCommitment(licenseSecret)` at
 * `poolHandlers.ts:2875` with the note's own commitment re-introduced the exact
 * v3 leak — the note commitment published in the clear as an instruction
 * argument — and the whole pool suite stayed green at 655/655. The property
 * circuit 7 was built to deliver had no test on this path at all.
 *
 * WHY A BYTE SWEEP AND NOT A FIELD ASSERTION
 * ──────────────────────────────────────────
 * A field can be renamed, reordered, or folded into another and the bytes stay
 * exactly where they were. An observer reads bytes. So this sweeps EVERY 8-byte
 * window of the serialised instruction, in both endiannesses, for every value
 * that names the note — rather than asserting that some field called
 * `stark_commitment` is absent.
 *
 * ⛔ AND IT SWEEPS THE WORKER'S OWN BYTES, WHICH IS WHERE THE MOBILE COPY OF
 * THIS TEST GOES HOLLOW. `apps/mobile/services/denominatedPool/unshieldV4.test.ts`
 * sweeps for two constants (`0xdeadbeefcafebabe`, `0x7fedcba987654321`) that are
 * never fed to its builder and cannot appear in its output under ANY mutation:
 * it asserts that an instruction does not contain two numbers nobody put there.
 * Its anti-vacuity test only proves the loop can find the subtree root, which is
 * published on purpose.
 *
 * Here the forbidden values are the FIXTURE NOTE'S OWN, they reach the encoder
 * through the only channel the worker has (`terms`, captured above), and the
 * licence secret is recovered by decoding the key the worker itself issued
 * rather than re-derived — so a broken derivation cannot agree with itself. The
 * anti-vacuity test plants a real commitment in each of the three 32-byte slots
 * the worker fills and requires the sweep to name the byte offset it landed on.
 *
 * ⚠️ WHAT THIS CANNOT SAY. It touches no RPC and no wasm, so a green run says
 * nothing about whether a circuit-7 proof verifies. That is
 * `packages/stark-prover/scripts/c7-live-proof.ts`.
 */

/** Account keys are opaque to the sweep; only the DATA is swept. */
const WIRE_ACCOUNTS = {
  payer: new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'),
  vaultPDA: new PublicKey('11111111111111111111111111111112'),
  poolPDA: new PublicKey(POOL_58),
  treePDA: new PublicKey('11111111111111111111111111111113'),
  nullifierPDA: new PublicKey('11111111111111111111111111111114'),
  c7ProofBuffer: new PublicKey('11111111111111111111111111111115'),
};

/**
 * The tree-and-nullifier half of the payload, which `prepareSubscribeV4`
 * produces rather than the worker.
 *
 * ⚠️ THE NULLIFIER IS NOT IN THE FORBIDDEN SET AND MUST NOT BE. It is the
 * double-spend guard and a PDA seed; it is published by construction on every
 * circuit and cannot be hidden. What must not appear is its PREIMAGE, which is
 * a note secret — and that IS swept for below.
 */
const NULLIFIER_ON_WIRE = 0x51f0a3c2d4e6b809n;
const POOL_ROOT_ON_WIRE = 0x2b7c9e1f5a3d8064n;
const SUBTREE_ROOT_ON_WIRE = 0x0d5e7a91c3f2b468n;
const SIBLINGS_ON_WIRE = [0x1a2b3c4d5e6f7081n, 0x2233445566778899n, 0x3141592653589793n];
const DIRECTIONS_ON_WIRE = [1, 0, 1];

/** Byte offsets of the three 32-byte slots the WORKER fills, from the v4 layout. */
const SLOT = { subscriberCommitment: 115, vkHash: 163, licence: 196 };

/**
 * Serialise a real `subscribe_private_stark_v4` instruction whose five
 * worker-controlled arguments are the bytes `handlePoolSubscribePrepare` just
 * produced — no copy of them, and no re-derivation.
 */
function serialiseFromWorkerTerms(over: Record<string, unknown> = {}): Buffer {
  const terms = seen.prepareV4Terms.at(-1);
  if (!terms) throw new Error('no circuit-7 prepare was recorded: the sweep would measure nothing');
  return buildSubscribePrivateStarkV4Ix({
    ...WIRE_ACCOUNTS,
    nullifierBytes: Uint8Array.from(goldilocksToLeBytes32(NULLIFIER_ON_WIRE)),
    merkleRootBytes: Uint8Array.from(goldilocksToLeBytes32(POOL_ROOT_ON_WIRE)),
    subtreeRoot: SUBTREE_ROOT_ON_WIRE,
    siblings: SIBLINGS_ON_WIRE,
    directions: DIRECTIONS_ON_WIRE,
    // ── from here down, every byte is the worker's ──
    retailer: terms.retailer,
    subscriberCommitmentBytes: goldilocksU64To32(terms.subscriberCommitment),
    rate: terms.rate,
    intervalSlots: terms.intervalSlots,
    vkHashSubscriber: terms.vkHashSubscriber,
    licenseCommitment: terms.licenseCommitment,
    ...over,
  }).data;
}

/** Every 8-byte window of `data`, either endianness, that equals `value`. */
function windowsHolding(data: Buffer, value: bigint): number[] {
  const hits: number[] = [];
  for (let off = 0; off + 8 <= data.length; off++) {
    // Both ways round: a field written the other endianness is still the same
    // secret sitting on the wire, and an indexer reads it just as easily.
    if (data.readBigUInt64LE(off) === value || data.readBigUInt64BE(off) === value) {
      hits.push(off);
    }
  }
  return hits;
}

describe('THE LEAK TEST: nothing on the v4 subscribe wire names the note', () => {
  /** Run a real prepare + execute, and recover the licence secret the worker issued. */
  async function subscribeOnCircuit7(): Promise<{ data: Buffer; forbidden: [string, bigint][] }> {
    const prep = await handlePoolRequest(v4PrepareReq());
    expect(prep.version).toBe('v4');
    const done = await handlePoolRequest(executeReq(prep.jobId));

    // ⛔ DECODED, NOT RE-DERIVED. Re-running `deriveLicenseSecret` here would
    // produce a test that agrees with the worker whatever either of them does.
    // The key is the worker's own output, so this is the exact 16 bytes it held.
    const licenseSecret = Buffer.from(decodeLicenseKey(done.licenseKey as string));
    expect(licenseSecret).toHaveLength(16);

    const r = NOTE.receipt;
    return {
      data: serialiseFromWorkerTerms(),
      forbidden: [
        // The v3 leak itself: published in the clear as an argument, matched
        // against the deposit's `LeafInserted` event, walked back to the payer.
        ['the note commitment', r.commitment],
        // Spends the note. On the wire it is a fund loss, not a privacy loss.
        ['the note secret', r.secret],
        // Reconstructs the published nullifier, and with it the leaf.
        ['the nullifier preimage', r.nullifierPreimage],
        // The only unknown in `poseidon(nullifier, poseidon(blinding, mint))`.
        // On the wire the commitment is rebuildable and circuit 7 bought
        // nothing — the same value `prepareSubscribeJobV4` refuses a note for
        // when it is merely a five-digit epoch.
        ['the note blinding', r.noteBlinding],
        // Not privacy: the licence KEY. Its blake3 belongs on chain; the secret
        // itself is the merchant credential, and publishing it hands anyone the
        // subscription's licence.
        ['the licence secret, low half', licenseSecret.readBigUInt64LE(0)],
        ['the licence secret, high half', licenseSecret.readBigUInt64LE(8)],
      ],
    };
  }

  it('no 8-byte window of the serialised instruction holds a value that names the note', async () => {
    const { data, forbidden } = await subscribeOnCircuit7();
    for (const [label, value] of forbidden) {
      // A zeroed fixture value would make its row of the sweep meaningless — an
      // all-zero window exists in any padded 32-byte field.
      expect(value, `${label} is 0 in the fixture, so its sweep would prove nothing`).not.toBe(0n);
      expect(
        windowsHolding(data, value),
        `${label} is on the wire of the v4 subscribe instruction`,
      ).toEqual([]);
    }
  });

  it('and the bytes swept ARE the worker s own, not a copy of them', async () => {
    // Anti-vacuity for the plumbing rather than for the loop: if `terms` never
    // reached the encoder, the sweep above would be reading an instruction the
    // worker had no hand in, and every mutation to `poolHandlers.ts` would leave
    // it green. The licence slot is the worker's 32 bytes, at 196.
    const { data } = await subscribeOnCircuit7();
    const terms = seen.prepareV4Terms.at(-1)!;
    // ALL FIVE worker-controlled arguments, not just the one the adversary used.
    // A single field checked here would let the other four be quietly cut loose
    // from the worker while this stayed green.
    expect([...data.subarray(SLOT.subscriberCommitment, SLOT.subscriberCommitment + 32)]).toEqual([
      ...goldilocksU64To32(terms.subscriberCommitment),
    ]);
    expect(data.readBigUInt64LE(147)).toBe(terms.rate);
    expect(data.readBigUInt64LE(155)).toBe(terms.intervalSlots);
    expect([...data.subarray(SLOT.vkHash, SLOT.vkHash + 32)]).toEqual([...terms.vkHashSubscriber]);
    expect(terms.licenseCommitment).toHaveLength(32);
    expect([...data.subarray(SLOT.licence, SLOT.licence + 32)]).toEqual([
      ...terms.licenseCommitment!,
    ]);
    // 196 + 32: the licence is present, so the payload is the long form.
    expect(data).toHaveLength(228);
  });

  it('THE SWEEP CAN FAIL: a planted commitment is found in every slot the worker fills', async () => {
    // The half the mobile copy of this test does not have. Plant the REAL
    // forbidden value — the fixture note's commitment — in each 32-byte slot the
    // worker chooses the contents of, and require the sweep to name the offset.
    // If the loop, the endianness handling or the encoding were wrong, these
    // would come back empty and the test above would be green for the wrong
    // reason forever.
    await subscribeOnCircuit7();
    const planted = goldilocksU64To32(NOTE.receipt.commitment);
    const slots: Array<[string, Record<string, unknown>, number]> = [
      ['the licence slot', { licenseCommitment: planted }, SLOT.licence],
      [
        'the subscriber-commitment slot',
        { subscriberCommitmentBytes: planted },
        SLOT.subscriberCommitment,
      ],
      ['the vk-hash slot', { vkHashSubscriber: planted }, SLOT.vkHash],
    ];
    for (const [label, over, offset] of slots) {
      expect(
        windowsHolding(serialiseFromWorkerTerms(over), NOTE.receipt.commitment),
        `the sweep missed a commitment planted in ${label}`,
      ).toContain(offset);
    }
  });
});
