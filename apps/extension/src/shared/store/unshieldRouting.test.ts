/**
 * WHICH WITHDRAWAL CIRCUIT THIS STORE ACTUALLY RUNS, AND WHAT IT REFUSES FIRST.
 *
 * ⛔ THE POINT OF THIS FILE IS THAT v3 IS STILL REACHED, and it is reached by
 * TWO different doors. A source scan cannot say that — `apps/web` learned it the
 * expensive way: for a few hours its v3 branch was dead code in production, a
 * v3-only note was unwithdrawable from the app, and `spendRouting.test.ts` plus
 * 561 other tests stayed green throughout, because every one of them measured
 * that v3 was DEFINED. So every routing claim below is made by calling
 * `unshieldNote` and looking at which service function ran.
 *
 * WHAT IT DOES NOT MEASURE, said plainly. The service is mocked, so nothing here
 * proves a circuit-7 proof verifies, that the instruction is well formed, or
 * that the wire hides anything. `services/unshieldV4.test.ts` pins the wire
 * bytes and sweeps them for the commitment; this file pins the DECISION, which
 * is the layer that had no test at all — `unshieldNote` could have been replaced
 * with `return { txSig: 'x', version: 'v4' }` and all 381 extension tests stayed
 * green.
 *
 * 🚨 AND THE CIRCUIT-7 ROUTE ON THIS SURFACE IS NOT ANONYMITY. `createWalletSigner`
 * hands the USER'S OWN WALLET to the proof-buffer upload and to the unshield
 * instruction as payer. Circuit 7 removes `stark_commitment` from the wire; it
 * does not remove the depositor's signature from the withdrawal, so an observer
 * who saw that wallet deposit into this pool still has it. That is the finding
 * this repository already recorded as "v4 seul = FAUX VERT" (2026-08-16), and
 * `refuses to pay the funder` below is a PARTIAL measure against it, not a fix.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';

// The service functions the store routes between. Hoisted so `vi.mock` below —
// which is itself hoisted above the imports — can close over them.
const svc = vi.hoisted(() => ({
  findPoolV3: vi.fn(),
  prepareUnshield: vi.fn(),
  unshieldDenominatedStarkV3: vi.fn(),
  prepareUnshieldV4: vi.fn(),
  unshieldDenominatedStarkV4: vi.fn(),
  isNullifierSpent: vi.fn(),
}));

/**
 * ⚠️ SPREAD THE REAL MODULE, DO NOT REPLACE IT — this is the anti-vacuity
 * choice. `V4Unprovable` reaches the store from here, and if this factory
 * invented its own class the store would route on a class the service never
 * throws, while every test below still passed. The real class is imported and
 * only the six functions are overridden.
 */
vi.mock('../services/denominatedPool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/denominatedPool')>();
  return { ...actual, ...svc };
});

/** No RPC in this file. `getConnection` returns an object with no methods, so
 *  any code path that tried to reach the network would throw, loudly. */
vi.mock('../services/wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/wallet')>();
  return { ...actual, getConnection: () => CONNECTION_WITH_NO_METHODS };
});

const CONNECTION_WITH_NO_METHODS = {} as never;

import {
  V4Unprovable,
  buildMerkleProofFromLeavesV3,
  MERKLE_DEPTH,
  C7_SUBTREE_DEPTH,
} from '../services/denominatedPool';
import {
  useDenominatedPoolStore,
  whyCircuit7Cannot,
  LEGACY_BLINDING_CEILING,
} from './denominatedPool';
import { useWalletStore } from './wallet';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The unlocked wallet. It signs, it pays the buffer rent, and it is the payee
 *  the refusal exists to reject. */
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
/** Any other address. Real base58 — the USDC devnet mint, borrowed as a payee. */
const ELSEWHERE = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const POOL = {
  token: 'SOL' as const,
  denomination: 1,
  denominationHuman: 1,
  poolPDA: new PublicKey('6NUS4E5PhQLxnYca6mCVGs3HcwXcgF1qEZtzm392jrBS'),
  treePDA: new PublicKey('GGJQwEigkoSk3pzg6eiLtt1cu2kYfCtV5JewNJsMkNdi'),
  tokenMint: new PublicKey('11111111111111111111111111111111'),
};

/**
 * MEASURED 2026-08-26 and quoted straight from the web twin's fixtures: the live
 * epoch is slot/7200 = 67,838. Five digits. That is what a pre-blinding note
 * carries in `depositEpoch`.
 */
const EPOCH_BLINDED = '67838';
/** What `deriveNoteBlinding` produces instead: a 63-bit PRF draw. */
const PRF_BLINDED = '7284991002338477113';

const NOTE_ID = '1234567890123456789';

/** The service, read as text. Two describes pin against it — the fail-closed
 *  split, and the fact that the exhibit below is a message it can really throw. */
const SERVICE = readFileSync(join(__dirname, '../services/denominatedPool.ts'), 'utf8');

function seedNote(depositEpoch: string) {
  useDenominatedPoolStore.setState({
    serializedNotes: [
      {
        secret: '11',
        nullifierPreimage: '22',
        depositEpoch,
        tokenMint: '0',
        commitment: NOTE_ID,
        leafIndex: 30,
        denomination: '1000000000',
        pool: POOL.poolPDA.toBase58(),
        token: 'SOL',
        denominationHuman: 1,
        shieldedAt: 0,
      },
    ],
    loading: false,
    error: null,
  });
}

function unshield(over: { recipient?: string; emergency?: boolean } = {}) {
  return useDenominatedPoolStore.getState().unshieldNote({ noteId: NOTE_ID, ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  useWalletStore.setState({
    publicKey: WALLET,
    network: 'devnet',
    // `createWalletSigner` only needs this to be present — it is captured in a
    // closure and `tx.sign(keypair)` is never reached, because every service
    // function that would build a transaction is mocked.
    _keypair: { placeholder: true } as never,
  });
  svc.findPoolV3.mockReturnValue(POOL);
  svc.isNullifierSpent.mockResolvedValue(false);
  svc.prepareUnshield.mockResolvedValue({ v3: 'prepared' });
  svc.unshieldDenominatedStarkV3.mockResolvedValue('SIG_V3');
  svc.prepareUnshieldV4.mockResolvedValue({ v4: 'prepared' });
  svc.unshieldDenominatedStarkV4.mockResolvedValue('SIG_V4');
  seedNote(PRF_BLINDED);
});

// ---------------------------------------------------------------------------

describe('refusal 1 — the payee is the funder', () => {
  /**
   * The refusal has to land BEFORE any RPC and before proving. On this surface
   * the payee is known twenty lines above the prepare, so refusing early returns
   * the same answer for free instead of after 2-3 minutes and a ~78-chunk
   * upload. The assertions on the mocks are the proof of "before": if the guard
   * ever sinks below them, these turn red rather than merely passing.
   */
  it('refuses a blank recipient, because blank means the funding wallet', async () => {
    await expect(unshield()).rejects.toThrow(/Refusing to withdraw to the wallet that pays/);
    expect(svc.isNullifierSpent).not.toHaveBeenCalled();
    expect(svc.prepareUnshieldV4).not.toHaveBeenCalled();
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
  });

  it('refuses the same address typed out, so the two spellings agree', async () => {
    await expect(unshield({ recipient: WALLET })).rejects.toThrow(
      /Refusing to withdraw to the wallet that pays/,
    );
    expect(svc.prepareUnshieldV4).not.toHaveBeenCalled();
  });

  it('says WHAT to do instead, because a refusal nobody can act on gets deleted', async () => {
    // Named field on the same screen, not a derived payout address: this package
    // has no payout store and no sweep, so an address it invented would hold the
    // money with no way to spend it. See the comment at the guard.
    await expect(unshield()).rejects.toThrow(/Send to/);
  });

  it('does NOT claim the withdrawal is anonymous once the payee changes', async () => {
    // 🚨 THE HONESTY ASSERTION. On apps/web an ephemeral signs, so refusing the
    // payee is decisive. Here the wallet still signs and still rents the buffer.
    // A message that implied otherwise would be the same category of error as
    // shipping v4 with no blinding guard: a measure that LOOKS like it closed
    // something.
    const err = await unshield().then(
      () => {
        throw new Error('the withdrawal was NOT refused');
      },
      (e: Error) => e,
    );
    expect(err.message).toMatch(/does NOT make this withdrawal anonymous/);
    expect(err.message).toMatch(/your own wallet signs/);
  });

  it('lets a third-party payee through, and proves it by what runs next', async () => {
    await expect(unshield({ recipient: ELSEWHERE })).resolves.toEqual({
      txSig: 'SIG_V4',
      version: 'v4',
    });
    expect(svc.prepareUnshieldV4).toHaveBeenCalledTimes(1);
    // And the payee it proved for is the one that was asked for — circuit 7
    // binds sha256(recipient), so a proof bound to anything else is a doomed
    // upload.
    expect((svc.prepareUnshieldV4.mock.calls[0][1] as PublicKey).toBase58()).toBe(ELSEWHERE);
  });
});

describe('refusal 2 — a note circuit 7 would only appear to protect', () => {
  it('routes an epoch-blinded note to the C1 + C3 pair, never to circuit 7', async () => {
    seedNote(EPOCH_BLINDED);
    await expect(unshield({ recipient: ELSEWHERE })).resolves.toEqual({
      txSig: 'SIG_V3',
      version: 'v3',
    });
    // ⛔ NOT "it threw" — it must reach v3 and SPEND. A guard that blocked the
    // note would strand leaf 30 of the 0.1 SOL pool, and on this surface every
    // note ever received through an extension transfer, since `prepareTransfer`
    // still mints those with a real epoch.
    expect(svc.unshieldDenominatedStarkV3).toHaveBeenCalledTimes(1);
    // Not even attempted: the classification is synchronous, so no proving time
    // is burned discovering what the blinding already said.
    expect(svc.prepareUnshieldV4).not.toHaveBeenCalled();
    expect(svc.unshieldDenominatedStarkV4).not.toHaveBeenCalled();
  });

  it('lets a PRF-blinded note onto circuit 7', async () => {
    await unshield({ recipient: ELSEWHERE });
    expect(svc.unshieldDenominatedStarkV4).toHaveBeenCalledTimes(1);
    expect(svc.unshieldDenominatedStarkV3).not.toHaveBeenCalled();
  });

  it('tells the user the withdrawal became the linkable kind', async () => {
    seedNote(EPOCH_BLINDED);
    const steps: string[] = [];
    await useDenominatedPoolStore
      .getState()
      .unshieldNote({ noteId: NOTE_ID, recipient: ELSEWHERE, onProgress: (s) => steps.push(s) });
    // A silent downgrade is the failure this whole change exists to avoid.
    expect(steps.join(' | ')).toMatch(/falling back to the C1 \+ C3 pair/i);
  });

  it('states the reason, and it is the one the web twin states', () => {
    const why = whyCircuit7Cannot({ depositEpoch: BigInt(EPOCH_BLINDED) });
    expect(why).toMatch(/circuit 7 needs at least/);
    expect(why).toMatch(/predates commitment blinding/);
    expect(why).toContain('67838');
    expect(whyCircuit7Cannot({ depositEpoch: BigInt(PRF_BLINDED) })).toBeNull();
  });

  it('puts the threshold where the two populations actually are', () => {
    // Not a magic number: an assertion about the gap it sits in.
    expect(LEGACY_BLINDING_CEILING).toBe(2n ** 32n);
    expect(BigInt(EPOCH_BLINDED)).toBeLessThan(LEGACY_BLINDING_CEILING); // every real epoch
    expect(LEGACY_BLINDING_CEILING).toBeLessThan(2n ** 63n); // every PRF draw's range
    expect(LEGACY_BLINDING_CEILING / BigInt(EPOCH_BLINDED)).toBeGreaterThan(60_000n);
    // The boundary itself, both sides of it.
    expect(whyCircuit7Cannot({ depositEpoch: LEGACY_BLINDING_CEILING })).toBeNull();
    expect(whyCircuit7Cannot({ depositEpoch: LEGACY_BLINDING_CEILING - 1n })).not.toBeNull();
  });

  it('admits a low-entropy blinding that sits just above the ceiling — accepted, not missed', async () => {
    /**
     * ⛔ THIS PINS A HOLE, NOT A PROPERTY, AND IT IS HERE SO THE HOLE CANNOT BE
     * REDISCOVERED AS A SURPRISE. The guard classifies by MAGNITUDE. On a note
     * that arrived through `importNoteAction` the magnitude is the SENDER's
     * choice — `shareableNoteToReceipt` checks only that the commitment
     * recomputes, and the circuit cannot constrain a blinding
     * (`stark/src/air/spend.rs:908-913`). So a sender can pick 2**32 + 1: one
     * over the line, ~2**32 Poseidon evaluations from the published nullifier
     * back to the leaf, and routed to the circuit this screen calls the private
     * one.
     *
     * Accepted, with the reasoning written at `whyCircuit7Cannot`: the outcome
     * is never worse than the pair (which publishes the commitment at zero
     * work), the sender who would do it already holds the nullifier, and
     * `source: 'received'` is the lever if that trade ever changes. If someone
     * pulls that lever, this test is the one that goes red and points at the
     * decision.
     */
    seedNote((LEGACY_BLINDING_CEILING + 1n).toString());
    await expect(unshield({ recipient: ELSEWHERE })).resolves.toEqual({
      txSig: 'SIG_V4',
      version: 'v4',
    });
  });

  it('misroutes the NATURAL population in the safe direction only', () => {
    // A `deriveNoteBlinding` draw is 63 bits; the ~2**-31 of them that land under
    // the ceiling are sent to the pair, which always works and merely publishes
    // the commitment. There is no input that sends a PRF-blinded note somewhere
    // MORE linkable than the pair — the error the threshold can make is the one
    // that costs privacy nobody had, not the one that claims privacy nobody has.
    const unluckyPrfDraw = LEGACY_BLINDING_CEILING - 7n;
    expect(whyCircuit7Cannot({ depositEpoch: unluckyPrfDraw })).not.toBeNull();
    expect(2n ** 63n / LEGACY_BLINDING_CEILING).toBe(2n ** 31n);
  });
});

describe('refusal 3 — what prepareUnshieldV4 itself throws', () => {
  /**
   * The message the ROOT PRE-FLIGHT throws, quoted from the service. ⛔ THIS IS
   * THE EXHIBIT ON PURPOSE, and the depth throw is not.
   *
   * `prepareUnshieldV4` has two `throw new V4Unprovable` sites, and only this
   * one can fire. MEASURED below in "the depth throw is defence in depth":
   * `buildMerkleProofFromLeavesV3` returns a path of exactly `MERKLE_DEPTH` = 15
   * elements every time, so `pathElements.length < 12` is unreachable against
   * today's builder. An earlier draft of this file used the depth message here,
   * which made the fallback look exercised by a door nothing can open — the
   * routing was right, the exhibit was not.
   *
   * This one is the real second door to v3, and it is the door a PRF-blinded
   * note needs: `prepareUnshieldV4` has no stored-path fast path, so it always
   * rebuilds from events, and a note whose root has aged out of the pool's
   * 100-root ring lands here. Without the fallback, that note would be
   * unwithdrawable from this client.
   */
  const ROOT_PREFLIGHT_FAILURE =
    "PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots " +
    '(current + 100 historical). Aborting before proof rent is spent. ' +
    'Wait ~10s for the RPC to index recent transactions, then retry.';

  it('the exhibit is a message prepareUnshieldV4 can really throw', () => {
    // ⚠️ WITHOUT THIS THE EXHIBIT CAN DRIFT INTO FICTION, which is the exact
    // defect being repaired here: the previous exhibit was syntactically fine,
    // routed correctly, and named a branch production cannot enter. A fixture
    // is only worth its name if the service can produce it, so pin it.
    expect(SERVICE).toMatch(
      /throw new V4Unprovable\([\s\S]{0,40}PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots/,
    );
    expect(ROOT_PREFLIGHT_FAILURE).toContain(
      "PRE-FLIGHT FAIL: the rebuilt Merkle root is not among the pool's known roots",
    );
  });

  it('a V4Unprovable from prepare reaches the C1 + C3 pair', async () => {
    svc.prepareUnshieldV4.mockRejectedValue(new V4Unprovable(ROOT_PREFLIGHT_FAILURE));
    await expect(unshield({ recipient: ELSEWHERE })).resolves.toEqual({
      txSig: 'SIG_V3',
      version: 'v3',
    });
    expect(svc.prepareUnshieldV4).toHaveBeenCalledTimes(1);
    expect(svc.unshieldDenominatedStarkV3).toHaveBeenCalledTimes(1);
  });

  it('the depth throw routes the same way, though nothing can reach it today', async () => {
    // Kept because the service keeps the branch: routing is asserted for BOTH
    // V4Unprovable sites, so a builder change that makes the depth throw live
    // does not also have to discover that the store handles it. ⚠️ This test
    // says nothing about production reachability — the measurement below does.
    svc.prepareUnshieldV4.mockRejectedValue(
      new V4Unprovable('Merkle path is 3 deep; circuit 7 needs at least 12.'),
    );
    await expect(unshield({ recipient: ELSEWHERE })).resolves.toEqual({
      txSig: 'SIG_V3',
      version: 'v3',
    });
    expect(svc.unshieldDenominatedStarkV3).toHaveBeenCalledTimes(1);
  });

  it('a plain Error from prepare FAILS CLOSED and never touches v3', async () => {
    // ⛔ THE SAFETY PROPERTY. "The prover published 5 felts" is a defect to
    // surface. Answering it by republishing this note's commitment on the C1 +
    // C3 pair would report a successful withdrawal and hide the bug — the exact
    // failure the pair exists to remove.
    svc.prepareUnshieldV4.mockRejectedValue(
      new Error('Circuit 7 must publish exactly 6 felts, got 5.'),
    );
    await expect(unshield({ recipient: ELSEWHERE })).rejects.toThrow(/exactly 6 felts/);
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
    expect(svc.unshieldDenominatedStarkV3).not.toHaveBeenCalled();
  });

  it('routes on the TYPE, not on the wording', async () => {
    // The same sentence the fallback allows, thrown as a plain Error, must NOT
    // fall back. This is what a string needle could not tell apart, and it is
    // why this surface uses a class: the extension has no worker boundary to
    // strip the prototype, so `instanceof` survives.
    svc.prepareUnshieldV4.mockRejectedValue(new Error(ROOT_PREFLIGHT_FAILURE));
    await expect(unshield({ recipient: ELSEWHERE })).rejects.toThrow(/PRE-FLIGHT FAIL/);
    expect(svc.unshieldDenominatedStarkV3).not.toHaveBeenCalled();
  });

  it('a failure at EXECUTE never retries on v3', async () => {
    // ⛔ THE CATCH WRAPS PREPARE ONLY, AND THIS IS WHAT SAYS SO. By the time
    // `unshieldDenominatedStarkV4` throws, a proof may already be uploaded and
    // the nullifier PDA initialised; a v3 retry would pay the buffer rent a
    // second time and then die on the double-spend guard with the note gone.
    svc.unshieldDenominatedStarkV4.mockRejectedValue(new Error('upload died at chunk 61'));
    await expect(unshield({ recipient: ELSEWHERE })).rejects.toThrow(/chunk 61/);
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
    expect(svc.unshieldDenominatedStarkV3).not.toHaveBeenCalled();
  });
});

describe('the pre-flight both routes share', () => {
  it('refuses an already-spent note before either prepare', async () => {
    // One getAccountInfo. Without it a double-spend attempt costs ~2 SOL of
    // buffer rent and 2-3 minutes to learn what the on-chain guard says for
    // free. It was missing on this path entirely until 2026-08-26.
    svc.isNullifierSpent.mockResolvedValue(true);
    await expect(unshield({ recipient: ELSEWHERE })).rejects.toThrow(/already been withdrawn/);
    expect(svc.prepareUnshieldV4).not.toHaveBeenCalled();
    expect(svc.prepareUnshield).not.toHaveBeenCalled();
  });

  it('runs on the v3 route too, not only on circuit 7', async () => {
    seedNote(EPOCH_BLINDED);
    svc.isNullifierSpent.mockResolvedValue(true);
    await expect(unshield({ recipient: ELSEWHERE })).rejects.toThrow(/already been withdrawn/);
    expect(svc.unshieldDenominatedStarkV3).not.toHaveBeenCalled();
  });
});

describe('what the store does with the note afterwards', () => {
  it('drops a note spent on circuit 7', async () => {
    await unshield({ recipient: ELSEWHERE });
    expect(useDenominatedPoolStore.getState().serializedNotes).toHaveLength(0);
    expect(useDenominatedPoolStore.getState().loading).toBe(false);
  });

  it('drops a note spent on the pair, and keeps one that was refused', async () => {
    seedNote(EPOCH_BLINDED);
    await unshield({ recipient: ELSEWHERE });
    expect(useDenominatedPoolStore.getState().serializedNotes).toHaveLength(0);

    seedNote(PRF_BLINDED);
    await unshield().catch(() => undefined); // payee refusal
    expect(useDenominatedPoolStore.getState().serializedNotes).toHaveLength(1);
    expect(useDenominatedPoolStore.getState().error).toMatch(/Refusing to withdraw/);
  });

  it('still forwards `emergency` to the v3 leg, unchanged', async () => {
    seedNote(EPOCH_BLINDED);
    await unshield({ recipient: ELSEWHERE, emergency: true });
    // 8th argument, exactly where it was before circuit 7 existed. v4 has no
    // min_epoch field at all, so it takes no such argument — asserted by arity.
    expect(svc.unshieldDenominatedStarkV3.mock.calls[0][7]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anti-vacuity, against the source. Behaviour above cannot reach the two throws
// inside `prepareUnshieldV4` without running the WASM prover, and the whole
// fail-closed split lives in which constructor those throws use.
// ---------------------------------------------------------------------------

describe('the service really is the shape this store routes on', () => {
  it('defines V4Unprovable, and it is the class this file imported', () => {
    expect(SERVICE).toMatch(/export class V4Unprovable extends Error/);
    expect(new V4Unprovable('x')).toBeInstanceOf(Error);
    expect(new V4Unprovable('x').name).toBe('V4Unprovable');
  });

  it('throws it for exactly the two note-shaped failures, and no others', () => {
    const thrown = SERVICE.match(/throw new V4Unprovable\(/g) ?? [];
    expect(thrown).toHaveLength(2);
    expect(SERVICE).toMatch(/throw new V4Unprovable\([\s\S]{0,40}PRE-FLIGHT FAIL/);
    expect(SERVICE).toMatch(/throw new V4Unprovable\([\s\S]{0,80}circuit 7 needs at least/);
  });

  it('leaves the two PROVER-defect throws as plain Errors, so they fail closed', () => {
    // If either of these ever became V4Unprovable, a broken prover would be
    // answered by republishing the commitment and reporting success.
    //
    // 🚨 ANCHORED TO THE NEAREST PRECEDING `throw new`, NOT TO A WINDOW. The
    // first draft read the 120 characters before the message and asked whether
    // `throw new Error(` appeared anywhere inside — which a NEIGHBOURING
    // statement's throw can satisfy while the throw that actually carries this
    // message says something else entirely. That is the shape of the hollow
    // guard this repository already shipped once, the one that matched a
    // destructuring instead of the `require!` it claimed to pin (2026-08-25).
    // `lastIndexOf` takes the nearest throw and the anchored regex allows only
    // `Error(` plus whitespace and the opening backtick between it and the
    // message, so an interposed throw of any kind fails instead of passing.
    for (const phrase of [
      'Circuit 7 must publish exactly 6 felts',
      'Circuit 7 published a recipient hash that does not match',
    ]) {
      const at = SERVICE.indexOf(phrase);
      expect(at, `${phrase} is no longer in the service`).toBeGreaterThan(-1);
      const throwAt = SERVICE.lastIndexOf('throw new ', at);
      expect(throwAt, `${phrase} is not preceded by any throw`).toBeGreaterThan(-1);
      expect(SERVICE.slice(throwAt, at), phrase).toMatch(/^throw new Error\(\s*`?$/);
    }
  });

  /**
   * ⛔ THE ONE MEASUREMENT IN THIS FILE THAT RUNS PRODUCTION CODE, and it exists
   * because a routing test can be right about the mechanism and wrong about
   * which door opens. `prepareUnshieldV4` has two V4Unprovable sites; only the
   * root pre-flight is reachable, and this is what says so with arithmetic
   * rather than by reading the comment above the throw.
   */
  it('the depth throw is defence in depth — the builder cannot produce a short path', () => {
    // The REAL builder, not a fixture: `vi.mock` above spreads the actual module
    // and overrides only the six routed functions, so this is the function
    // `prepareUnshieldV4` calls.
    const leaves = [111n, 222n, 333n, 444n];
    for (let target = 0; target < leaves.length; target++) {
      const { pathElements, pathIndices } = buildMerkleProofFromLeavesV3({
        leavesByIndex: leaves,
        targetLeafIndex: target,
      });
      // One element per level, unconditionally, for MERKLE_DEPTH levels.
      expect(pathElements).toHaveLength(MERKLE_DEPTH);
      expect(pathIndices).toHaveLength(MERKLE_DEPTH);
    }
    // 15 >= 12, so `pathElements.length < C7_SUBTREE_DEPTH` is unreachable and
    // the 12/3 split always has both halves. If a future builder returns a
    // variable-depth path, THIS goes red — and the depth throw becomes a live
    // door that the routing test above already covers.
    expect(MERKLE_DEPTH).toBeGreaterThanOrEqual(C7_SUBTREE_DEPTH);
  });
});
