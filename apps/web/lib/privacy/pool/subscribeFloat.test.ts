/**
 * 🚨 THE DISCLOSED FLOAT IS THE TRANSFERRED FLOAT.
 *
 * Run: cd apps/web && pnpm test:pool
 *
 * WHAT WENT WRONG
 * ───────────────
 * `SubscribePanel`'s cost box — read BEFORE the user signs — said "roughly 1 SOL
 * is locked to hold space for the two proofs, the same pair a withdrawal needs".
 * On the route this app actually takes, circuit 7, there is ONE buffer and the
 * float is a little over half that. The copy carried its own literal, so it had
 * nothing to disagree with when `prepareSubscribeJobV4` started pricing one
 * buffer instead of two.
 *
 * ⛔ SO NOTHING HERE IS A SECOND LITERAL EITHER. Every figure in this file comes
 * from one of four places, none of which is this file:
 *
 *   the module    `SUBSCRIBE_FLOAT_LAMPORTS`, which is `subscribeFloorLamports`
 *                 over the measured wire sizes — the same function the job
 *                 prices its transfer with.
 *   the job       `prepareSubscribeJobV4` is EXECUTED below against a fake RPC
 *                 that answers rent with the real rent-exemption formula, and
 *                 its floor is compared to the module's figure. That is the
 *                 assertion that actually holds the copy honest.
 *   the chain     `packages/stark-prover/deployed-verifier.json` (a devnet
 *                 transaction the deployed verifier accepted) and
 *                 `cross_circuit_confusion.rs` (the re-measured size table) are
 *                 re-read for the proof sizes.
 *   devnet        `prefundAmount.ts` records the C1 + C3 subscribe pre-fund as
 *                 1_035_725_040 lamports, seen on 4 of 4 subscriptions. That
 *                 number is parsed out of that file and compared to what this
 *                 module computes — which is what proves `rentExemptLamports`
 *                 really does reproduce `getMinimumBalanceForRentExemption`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js';

import {
  MEASURED_PROOF_BYTES,
  NULLIFIER_RENT,
  E_TX_FEE_BUDGET,
  PROOF_BUFFER_HEADER_BYTES,
  SUBSCRIBE_FLOAT_LAMPORTS,
  SUBSCRIBE_FLOAT_SOL,
  SUBSCRIPTION_VAULT_LEN,
  floatSol,
  proofBufferRentLamports,
  rentExemptLamports,
  subscribeFloorLamports,
} from './subscribeFloat';

// The circuit-7 preparer is the one expensive step: ~5.5 s of proving plus a
// full event scan. Stubbed so the PRICING lines below — which are the subject —
// run for real against a fake RPC.
vi.mock('./subscribePrivateStarkV4', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subscribePrivateStarkV4')>();
  return { ...actual, prepareSubscribeV4: vi.fn() };
});

// Same reason for the v3 route: `prepareUnshieldJob` is the withdrawal
// preparer, pinned in its own file. Everything else in `./unshieldEphemeral` —
// `deriveUnshieldEphemeral` above all, which the v4 job calls for real — stays
// actual.
vi.mock('./unshieldEphemeral', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./unshieldEphemeral')>();
  return { ...actual, prepareUnshieldJob: vi.fn() };
});

import { prepareSubscribeV4 } from './subscribePrivateStarkV4';
import { prepareSubscribeJob, prepareSubscribeJobV4 } from './subscribeEphemeral';
import { prepareUnshieldJob } from './unshieldEphemeral';
import type { PoolConfig, ShieldReceipt } from './denominatedPool';

const REPO = join(__dirname, '../../../../..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

// ---------------------------------------------------------------------------
// The measured inputs, re-read from the records that measured them
// ---------------------------------------------------------------------------

describe('the wire sizes the estimate rests on are the measured ones', () => {
  it('C7 is the size of a proof the DEPLOYED verifier accepted on devnet', () => {
    const record = read('packages/stark-prover/deployed-verifier.json');
    const m = record.match(/"circuit_id":\s*7,\s*"proof_bytes":\s*(\d+)/);
    expect(m, 'deployed-verifier.json no longer records the accepted C7 proof size').not.toBeNull();
    expect(
      MEASURED_PROOF_BYTES.c7,
      'the C7 wire size moved. Every figure in the subscribe cost disclosure moves with it',
    ).toBe(Number(m![1]));
  });

  it('C1 and C3 come from the re-measured size table, not from the pre-B4 numbers', () => {
    const table = read('programs/p01_stark_verifier/tests/cross_circuit_confusion.rs');
    const m = table.match(/const RECORDED: \[usize; 8\]\s*=\s*\[([^\]]*)\]/);
    expect(m, 'the RECORDED proof-size table was restructured').not.toBeNull();
    const sizes = m![1].split(',').map((t) => Number(t.trim().replace(/_/g, '')));
    expect(sizes).toHaveLength(8);
    // Indexed by circuit id, which is what makes this a lookup and not a guess.
    expect(MEASURED_PROOF_BYTES.c1).toBe(sizes[1]);
    expect(MEASURED_PROOF_BYTES.c3).toBe(sizes[3]);
    expect(MEASURED_PROOF_BYTES.c7).toBe(sizes[7]);
    // ⛔ 258,958 is the pre-B4 pair and is still quoted in places. The cut C7
    // buys is 1.9x, and a disclosure built on 258,958 would understate the
    // fallback route rather than overstate it.
    expect(MEASURED_PROOF_BYTES.c1 + MEASURED_PROOF_BYTES.c3).toBeLessThan(258_958);
  });
});

// ---------------------------------------------------------------------------
// The rent formula, against a figure measured on devnet
// ---------------------------------------------------------------------------

describe('rentExemptLamports reproduces getMinimumBalanceForRentExemption', () => {
  it('lands on the exact pre-fund devnet showed 4 times out of 4', () => {
    // `prefundAmount.ts` exists because that number was a `memcmp` fingerprint.
    // It is therefore a MEASURED total for the C1 + C3 subscribe: two buffer
    // rents, the nullifier record, the fee budget and the vault's rent.
    // Flattened first: the sentence wraps across two comment lines, so the
    // number sits behind a ` * ` continuation.
    const src = read('apps/web/lib/privacy/pool/prefundAmount.ts')
      .replace(/^\s*\*/gm, ' ')
      .replace(/\s+/g, ' ');
    const m = src.match(/subscribe pre-fund came to ([\d_]+) lamports/);
    expect(m, 'prefundAmount.ts no longer records the measured subscribe pre-fund').not.toBeNull();
    const measuredOnDevnet = Number(m![1].replace(/_/g, ''));

    expect(
      SUBSCRIBE_FLOAT_LAMPORTS.pair,
      'the computed C1 + C3 float no longer matches what devnet actually charged, so either the ' +
        'rent formula, a rent constant, or a proof size is wrong — and the C7 figure the panel ' +
        'shows is built from the same three',
    ).toBe(measuredOnDevnet);
  });

  it('is the account-overhead formula, not a table', () => {
    // Cheap independent check of the same function at a different length: the
    // vault's own rent must be the same shape.
    expect(rentExemptLamports(SUBSCRIPTION_VAULT_LEN)).toBe((128 + 361) * 3480 * 2);
    expect(proofBufferRentLamports(MEASURED_PROOF_BYTES.c7)).toBe(
      rentExemptLamports(PROOF_BUFFER_HEADER_BYTES + MEASURED_PROOF_BYTES.c7),
    );
  });
});

// ---------------------------------------------------------------------------
// The two routes are materially different, which is WHY the copy must branch
// ---------------------------------------------------------------------------

describe('the two routes cost different money', () => {
  it('circuit 7 is under the pair, by enough that one sentence cannot cover both', () => {
    expect(SUBSCRIBE_FLOAT_LAMPORTS.c7).toBeLessThan(SUBSCRIBE_FLOAT_LAMPORTS.pair);
    // Nearly 2x — the exact overstatement the old copy carried. Written as a
    // comparison rather than a ratio literal so it states the fact and nothing
    // more: quoting the pair's figure for a C7 spend is not a rounding error.
    expect(SUBSCRIBE_FLOAT_LAMPORTS.c7 * 2).toBeGreaterThan(SUBSCRIBE_FLOAT_LAMPORTS.pair);
    expect(SUBSCRIBE_FLOAT_SOL.c7).not.toBe(SUBSCRIBE_FLOAT_SOL.pair);
  });

  it('SUBSCRIBE_FLOAT_SOL is the formatted form of the lamport figures', () => {
    expect(SUBSCRIBE_FLOAT_SOL.c7).toBe(floatSol(SUBSCRIBE_FLOAT_LAMPORTS.c7));
    expect(SUBSCRIBE_FLOAT_SOL.pair).toBe(floatSol(SUBSCRIBE_FLOAT_LAMPORTS.pair));
  });

  it('both routes share ONE formula — only the buffer rent differs', () => {
    const vaultRent = rentExemptLamports(SUBSCRIPTION_VAULT_LEN);
    expect(SUBSCRIBE_FLOAT_LAMPORTS.c7).toBe(
      subscribeFloorLamports({
        proofBufferRent: proofBufferRentLamports(MEASURED_PROOF_BYTES.c7),
        vaultRent,
      }),
    );
    expect(SUBSCRIBE_FLOAT_LAMPORTS.pair).toBe(
      subscribeFloorLamports({
        proofBufferRent:
          proofBufferRentLamports(MEASURED_PROOF_BYTES.c1) +
          proofBufferRentLamports(MEASURED_PROOF_BYTES.c3),
        vaultRent,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// ⛔ THE ASSERTION THAT HOLDS THE COPY HONEST: run the job, compare the floor
// ---------------------------------------------------------------------------

const POOL_PDA = new PublicKey('11111111111111111111111111111112');
const TOKEN_MINT = SystemProgram.programId;

const POOL_CONFIG = {
  poolPDA: POOL_PDA,
  tokenMint: TOKEN_MINT,
} as unknown as PoolConfig;

/** A note that circuit 7 will accept: a PRF blinding, not a deposit epoch. */
const RECEIPT = {
  leafIndex: 7,
  noteBlinding: 9_000_000_000_000_000_000n,
  nullifierPreimage: 12_345n,
  secret: 67_890n,
} as unknown as ShieldReceipt;

/** Every rent length the code under test asked the RPC for, in order. */
let rentFor: number[] = [];

function rentFaithfulConnection(): Connection {
  return {
    // Nothing is spent — `isNullifierSpent` reads the nullifier PDA.
    getAccountInfo: async () => null,
    getMinimumBalanceForRentExemption: async (len: number) => {
      rentFor.push(len);
      return rentExemptLamports(len);
    },
  } as unknown as Connection;
}

describe('prepareSubscribeJobV4 prices exactly what the disclosure quotes', () => {
  beforeEach(() => {
    rentFor = [];
    vi.mocked(prepareSubscribeV4).mockResolvedValue({
      c7ProofResult: {
        proofBytes: new Uint8Array(0),
        publicInputs: [],
        proofSize: MEASURED_PROOF_BYTES.c7,
      },
    } as never);
  });

  async function runJob() {
    return prepareSubscribeJobV4(
      RECEIPT,
      POOL_CONFIG,
      rentFaithfulConnection(),
      new Uint8Array(32).fill(9),
      {
        retailer: Keypair.generate().publicKey,
        subscriberCommitment: 4_242_424_242n,
        rate: 100_000_000n,
        intervalSlots: 216_000n,
        vkHashSubscriber: new Uint8Array(32),
      },
    );
  }

  it('rents ONE proof buffer, and the disclosure says so', async () => {
    await runJob();
    expect(
      rentFor,
      'the v4 subscribe asked the RPC to price a different set of accounts than one C7 buffer ' +
        'plus the vault. v3 named TWO buffers here; if that came back, the panel is quoting the ' +
        'wrong route',
    ).toEqual([PROOF_BUFFER_HEADER_BYTES + MEASURED_PROOF_BYTES.c7, SUBSCRIPTION_VAULT_LEN]);
  });

  it('⛔ its floor IS the figure the cost disclosure renders', async () => {
    const ctx = await runJob();
    expect(
      ctx.rawRequiredLamports,
      'the float SubscribePanel discloses before the user signs is no longer the float ' +
        'prepareSubscribeJobV4 transfers. Whichever one moved, the user is reading a number that ' +
        'is not the one being locked',
    ).toBe(SUBSCRIBE_FLOAT_LAMPORTS.c7);
    // And the transferred figure is the jittered one, never the exact floor —
    // `prefundAmount.ts` explains why quoting the constant is the fingerprint.
    expect(ctx.requiredLamports).toBeGreaterThanOrEqual(ctx.rawRequiredLamports);
  });

  it('the disclosed SOL string is what that floor rounds to', async () => {
    const ctx = await runJob();
    expect(SUBSCRIBE_FLOAT_SOL.c7).toBe(floatSol(ctx.rawRequiredLamports));
  });
});

describe('the fallback route is priced by the same terms', () => {
  it('the v3 job is the withdrawal floor plus the vault rent, which is the pair figure', async () => {
    // The withdrawal preparer is the expensive half and is pinned in its own
    // file; what is asserted here is the COMPOSITION — that a subscribe adds the
    // vault's rent on top and nothing else — and that the sum is the number the
    // panel shows for this route.
    rentFor = [];
    const pairBuffers =
      proofBufferRentLamports(MEASURED_PROOF_BYTES.c1) +
      proofBufferRentLamports(MEASURED_PROOF_BYTES.c3);
    const withdrawalFloor = pairBuffers + NULLIFIER_RENT + E_TX_FEE_BUDGET;

    vi.mocked(prepareUnshieldJob).mockResolvedValue({
      jobId: 'unshield:x:7',
      poolConfig: POOL_CONFIG,
      receipt: RECEIPT,
      ephemeral: Keypair.generate(),
      requiredLamports: withdrawalFloor,
      rawRequiredLamports: withdrawalFloor,
      prepared: {},
    } as never);

    const ctx = await prepareSubscribeJob(
      RECEIPT,
      POOL_CONFIG,
      rentFaithfulConnection(),
      new Uint8Array(32),
    );

    expect(rentFor).toEqual([SUBSCRIPTION_VAULT_LEN]);
    expect(ctx.rawRequiredLamports).toBe(SUBSCRIBE_FLOAT_LAMPORTS.pair);
  });
});
