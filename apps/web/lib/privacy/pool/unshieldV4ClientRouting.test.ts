/**
 * THE CLIENT HALF OF THE CIRCUIT-7 HANDSHAKE — what `unshieldFromPool` puts on
 * the worker wire, and what it must never put on it.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHY A WIRE TEST AND NOT A BEHAVIOUR TEST
 * ────────────────────────────────────────
 * Nothing here proves a withdrawal works; `unshieldV4Job.test.ts` covers the
 * guards and a devnet run covers the rest. What this file covers is the one
 * thing neither can see: two halves of a protocol living in different files,
 * joined by fields that are ALL OPTIONAL, which is exactly the shape `tsc` lets
 * drift without a word.
 *
 * Every failure mode here is therefore silent by construction:
 *
 *   drop `recipient` at prepare       the worker builds a v3 job, the
 *                                     withdrawal publishes the note's
 *                                     commitment again, and nothing errors
 *                                     anywhere. The user is simply told a thing
 *                                     that stopped being true.
 *   DROP `recipient` at execute on a  the worker can only refuse a payee it was
 *   v4 job                            GIVEN. Omitting it is what made a swapped
 *                                     payee invisible — see the collision note
 *                                     in `poolHandlersUnshieldV4.test.ts`. This
 *                                     file used to assert the opposite, on the
 *                                     reasoning that "the only value that can
 *                                     never be wrong is no value at all", which
 *                                     is circular: no value is also the only one
 *                                     that can never be CHECKED.
 *   drop `recipient` at execute on a  a v3 proof names no payee, so the job
 *   v3 job                            dies at the one moment it costs money:
 *                                     the pre-fund between prepare and execute
 *                                     has already landed.
 *
 * ⛔ AND THE ONE THAT WOULD BREAK THE DEMO. `subscribeFromPool` must send
 * NEITHER field.
 *
 * 🚨 UPDATED 2026-08-27. This used to reason "`handlePoolSubscribePrepare`
 * reaches `prepareUnshieldJob` verbatim and `programs/zk_shielded/src/lib.rs`
 * exposes exactly one v4". Both halves have moved: `subscribe_private_stark_v4`
 * is registered (lib.rs:549), and the subscribe prepare now routes to circuit 7
 * through `prepareSubscribeJobV4`, falling back to `prepareSubscribeJob` — and
 * so to `prepareUnshieldJob` — only when the rebuild cannot place the note.
 *
 * The requirement is unchanged and its reason is STRONGER. `recipient` and
 * `ownerPubkey` are the WITHDRAWAL's circuit-7 inputs, and the two v4
 * instructions bind DIFFERENT digests: `sha256(recipient)` there, a 132-byte
 * `"P01:C7:SUBSCRIBE:v1" || vault || rate || interval_slots || vk_hash ||
 * license` composite here. A subscription carrying the withdrawal's fields would
 * ask for a proof its own handler refuses at the END of a ~78-chunk upload, in
 * the flow the 2026-09-04 deck is entirely about. The subscribe sends its OWN
 * three fields instead, and the test below asserts both directions.
 *
 * Asserted on the ACTUAL request object rather than on the type, because the
 * type only stops a subscribe request that names the fields — it says nothing
 * about a future refactor routing a subscribe through the withdrawal request
 * kind.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';

// shieldClient's module graph reaches the wasm prover and the worker bridge.
// None of it is under test: this file reads the request objects handed to
// `poolRequest` and stubs everything that would leave the process.
const poolRequest = vi.fn();
vi.mock('../workerClient', () => ({
  poolRequest: (...args: unknown[]) => poolRequest(...args),
}));

const fundEphemeralForJob = vi.fn();
const fetchFunderLookup = vi.fn();
vi.mock('./ephemeralFunder', () => ({
  fundEphemeralForJob: (...args: unknown[]) => fundEphemeralForJob(...args),
  fetchFunderLookup: (...args: unknown[]) => fetchFunderLookup(...args),
  funderTicket: () => null,
}));

vi.mock('./denominatedPool', () => ({ findPoolV3: () => null }));

import { unshieldFromPool, subscribeFromPool } from '../shieldClient';

const OWNER = new PublicKey('7gWpzSZAqUiN6uZ9NkfB1gZ5gYtvUvQyFAUhZTjJ6Trh');
/** A derived payout address — where a withdrawal is supposed to pay. */
const PAYOUT = new PublicKey('SysvarC1ock11111111111111111111111111111111');
const RETAILER = new PublicKey('QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB');
const EPHEMERAL = '11111111111111111111111111111112';

type Req = Record<string, unknown>;

/** Every request object handed to the worker, in call order. */
function requests(): Req[] {
  return poolRequest.mock.calls.map((c) => c[0] as Req);
}

function requestOfKind(kind: string): Req {
  const hit = requests().filter((r) => r.kind === kind);
  expect(
    hit,
    `expected exactly one ${kind} request; the run made ${requests().length} in total`,
  ).toHaveLength(1);
  return hit[0]!;
}

/**
 * Answer the two worker calls a withdrawal makes, with the prepare reporting
 * `version`.
 *
 * `version` is a PARAMETER rather than a constant on purpose: the whole reason
 * the field exists is that the worker can answer something the client did not
 * ask for, and a fixture that always echoed the request would make the tests
 * below agree with the client no matter what it did.
 */
function arrangeUnshield(version: 'v3' | 'v4') {
  poolRequest.mockImplementation(async (req: Req) => {
    if (req.kind === 'poolUnshieldPrepare') {
      return {
        kind: 'poolUnshieldPrepare',
        jobId: version === 'v4' ? 'unshield-v4:POOL:16' : 'unshield:POOL:16',
        ephemeralPubkey: EPHEMERAL,
        requiredLamports: 1_030_290_360,
        denomination: 0.1,
        derivation: 'v1',
        version,
      };
    }
    if (req.kind === 'poolUnshieldExecute') {
      return { kind: 'poolUnshieldExecute', txSig: 'TXSIG', denomination: 0.1 };
    }
    throw new Error(`unexpected worker request: ${String(req.kind)}`);
  });
}

function withdraw() {
  return unshieldFromPool({
    meta: 'meta',
    token: 'SOL',
    denomination: 0.1,
    leafIndex: 16,
    recipient: PAYOUT,
    owner: OWNER,
    connection: {} as Connection,
    signOne: async (t) => t,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fundEphemeralForJob.mockResolvedValue({
    fundedBy: 'wallet',
    sweepTo: OWNER.toBase58(),
    funderSignature: undefined,
    funderFallbackReason: undefined,
    operatorFeeLamports: undefined,
  });
  fetchFunderLookup.mockResolvedValue({ state: 'none' });
});

describe('a withdrawal asks for circuit 7 at PREPARE', () => {
  it('sends the payee and the wallet with the prepare, which is what selects v4', async () => {
    arrangeUnshield('v4');
    await withdraw();

    const prep = requestOfKind('poolUnshieldPrepare');
    // Both, or the worker silently builds a v3 job and the withdrawal
    // republishes the commitment with nothing reporting a problem.
    expect(prep.recipient, 'no payee at prepare — circuit 7 cannot be proved').toBe(
      PAYOUT.toBase58(),
    );
    expect(prep.ownerPubkey, 'no wallet at prepare — the payee refusal cannot run early').toBe(
      OWNER.toBase58(),
    );
  });

  /**
   * ⏱️ ORDER, NOT JUST CONTENT. The payee has to be on the prepare AND the
   * prepare has to come before the pre-fund — that ordering is the entire gain
   * of moving the `recipient === ownerPubkey` refusal earlier. A refactor that
   * funded first and proved second would keep every field assertion above green
   * while handing the user back a stranded pre-fund on the refused case.
   */
  it('prepares before anyone is asked to pay for it', async () => {
    arrangeUnshield('v4');
    await withdraw();

    expect(requests()[0]!.kind).toBe('poolUnshieldPrepare');
    expect(poolRequest.mock.invocationCallOrder[0]!).toBeLessThan(
      fundEphemeralForJob.mock.invocationCallOrder[0]!,
    );
  });
});

describe('what EXECUTE carries depends on what prepare answered', () => {
  it('carries the payee on a v4 job too, so the worker can refuse a swapped one', async () => {
    arrangeUnshield('v4');
    await withdraw();

    const exec = requestOfKind('poolUnshieldExecute');
    // 💰 NOT redundant — this assertion is the client half of a fund-loss fix.
    // `executeUnshieldV4` takes no recipient: it pays whoever the STORED job
    // names. The worker refuses a recipient that disagrees with that stored
    // payee, but it can only refuse one it was GIVEN, so omitting this is
    // exactly what let a second prepare of the same note redirect the money.
    expect(
      exec.recipient,
      'a v4 execute with no payee cannot be checked against the payee the proof bound',
    ).toBe(PAYOUT.toBase58());
    // The wallet is still sent, and it is NOT the same field. It is identity —
    // it arms the payee refusal — while `sweepTo` is the one that moves money.
    expect(exec.ownerPubkey).toBe(OWNER.toBase58());
    expect(exec.sweepTo).toBe(OWNER.toBase58());
  });

  it('still carries the payee on a v3 job, which has it nowhere else', async () => {
    arrangeUnshield('v3');
    await withdraw();

    expect(
      requestOfKind('poolUnshieldExecute').recipient,
      'a C1+C3 proof names no payee — dropping this breaks every v3 withdrawal',
    ).toBe(PAYOUT.toBase58());
  });

  /**
   * 🚨 THE WORKER IS THE AUTHORITY, NOT THE REQUEST WE SENT.
   *
   * Every withdrawal now ASKS for circuit 7, and a prepare may still answer v3:
   * the handler falls back to the C1 + C3 pair when the circuit-7 rebuild cannot
   * place the note's Merkle root, and that fallback is the only route apps/web
   * has left to a note circuit 7 cannot prove. So `version` is a fact about what
   * HAPPENED, and the client cannot infer it from its own input.
   *
   * It no longer steers the execute message — the payee is now sent on both
   * circuits — and that is deliberate: a shape that is correct either way cannot
   * be got wrong at the one moment it costs money, with the pre-fund already
   * landed. What `version` still steers is what the CALLER is told, and that
   * drives a privacy claim on screen.
   *
   * Pinned with a prepare that answers 'v3' to a request carrying BOTH fields —
   * a pairing the client cannot produce by inference from its own input.
   */
  it('follows the answer, not the question, when the worker declines v4', async () => {
    arrangeUnshield('v3');
    const out = await withdraw();

    expect(requestOfKind('poolUnshieldPrepare').recipient).toBe(PAYOUT.toBase58()); // asked v4
    expect(out.version, 'reported v4 for a spend that published the commitment').toBe('v3');
  });

  it('sends the same execute shape whichever circuit answered', async () => {
    arrangeUnshield('v4');
    await withdraw();
    const onV4 = requestOfKind('poolUnshieldExecute');

    // Only this mock's CALLS are cleared — `requestOfKind` counts across them,
    // and the funder implementation set in `beforeEach` has to survive.
    poolRequest.mockClear();
    arrangeUnshield('v3');
    await withdraw();
    const onV3 = requestOfKind('poolUnshieldExecute');

    // The jobId of course differs; it names the circuit. What must not differ is
    // anything about WHO IS PAID. The subject here is the ABSENCE of a branch: a
    // message that varied by circuit would have to be chosen after the pre-fund
    // had landed, off a value the client did not control.
    const payee = (r: Req) => ({
      recipient: r.recipient,
      ownerPubkey: r.ownerPubkey,
      sweepTo: r.sweepTo,
    });
    expect(payee(onV4)).toEqual(payee(onV3));
  });

  it('reports v4 back to the caller, so a screen need not parse the jobId', async () => {
    arrangeUnshield('v4');
    expect((await withdraw()).version).toBe('v4');
  });

  it('reports v3 back to the caller, which is the half that is still linkable', async () => {
    arrangeUnshield('v3');
    expect((await withdraw()).version).toBe('v3');
  });
});

describe('⛔ the subscription must not follow the withdrawal onto circuit 7', () => {
  it('sends neither the payee nor the wallet with a subscribe prepare', async () => {
    poolRequest.mockImplementation(async (req: Req) => {
      if (req.kind === 'poolSubscribePrepare') {
        return {
          kind: 'poolSubscribePrepare',
          jobId: 'subscribe:POOL:16',
          ephemeralPubkey: EPHEMERAL,
          requiredLamports: 1_400_000_000,
          denomination: 0.1,
          derivation: 'v1',
          depositPayer: 'DEPOSITOR1111111111111111111111111111111111',
          depositFunder: 'FUNDER111111111111111111111111111111111111',
          depositSignature: 'SIG',
        };
      }
      if (req.kind === 'poolSubscribeExecute') {
        return {
          kind: 'poolSubscribeExecute',
          txSig: 'TXSIG',
          vaultPDA: 'VAULT',
          licenseKey: 'P01-X',
          serviceTag: 'tag',
          denomination: 0.1,
        };
      }
      throw new Error(`unexpected worker request: ${String(req.kind)}`);
    });

    await subscribeFromPool({
      meta: 'meta',
      token: 'SOL',
      denomination: 0.1,
      leafIndex: 16,
      retailer: RETAILER,
      rate: 1_000n,
      intervalSlots: 100n,
      owner: OWNER,
      // The co-naming check reads two signature pages. Empty on both sides is
      // the "complete history, no shared transaction" answer, which is the only
      // one that lets the run reach the worker calls this test is about.
      connection: {
        getSignaturesForAddress: async () => [],
      } as unknown as Connection,
      signOne: async (t) => t,
    });

    const prep = requestOfKind('poolSubscribePrepare');
    // 🚨 UPDATED 2026-08-27. The old message here said "there is no
    // subscribe_private_stark_v4 on chain to spend that proof on". THERE NOW IS,
    // and the subscribe routes to it — through its OWN fields. These two must
    // still be absent, for a REASON THAT IS NOW STRONGER: `recipient` and
    // `ownerPubkey` are the WITHDRAWAL's circuit-7 inputs, and the two v4
    // instructions bind different digests. A subscribe prepare carrying them
    // would ask for a proof over `sha256(recipient)`, which the subscribe
    // handler rejects after a ~78-chunk upload.
    expect(
      'recipient' in prep,
      "a subscribe prepare must not carry the WITHDRAWAL's circuit-7 payee: subscribe binds a " +
        '132-byte domain-tagged composite, not sha256(recipient)',
    ).toBe(false);
    expect('ownerPubkey' in prep, 'same field pair, same consequence').toBe(false);
    // And it DOES carry its own, so this is not merely asserting an empty
    // message. A subscribe that stopped sending these silently drops to the
    // C1 + C3 pair, which republishes the note commitment.
    expect('retailer' in prep, 'the subscribe prepare no longer asks for circuit 7').toBe(true);
    expect('rate' in prep).toBe(true);
    expect('intervalSlots' in prep).toBe(true);

    // And it went through the SUBSCRIBE request kinds, not the withdrawal ones.
    // Without this the two assertions above would also pass if the subscribe
    // had been rerouted onto `poolUnshieldPrepare` entirely.
    expect(requests().map((r) => r.kind)).toEqual([
      'poolSubscribePrepare',
      'poolSubscribeExecute',
    ]);
  });
});
