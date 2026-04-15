/**
 * Unit tests for the Mugen P2P exchange MPC module.
 *
 * These are pure unit tests — no devnet calls, no real MPC computation.
 * The ArciumClient and anchor.Program are mocked; we assert on:
 *   1. Encryption is called with the right plaintext values.
 *   2. The correct MPC instruction is submitted.
 *   3. Return shapes match the documented API.
 *   4. Failures in the downstream program.rpc call are wrapped.
 *
 * NOTE: The Mugen SDK (as of 2026-04-13) does NOT perform input validation
 * on orderType / currency / amounts before calling into the MPC layer.
 * Invalid inputs therefore either (a) pass through unchanged or (b) throw
 * from a downstream dependency (e.g. `createHash` rejects non-string
 * currency). The tests below document the *actual* behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import {
  submitEncryptedOffer,
  blindTakeOrder,
  cancelEncryptedOffer,
  currencyToHash,
  generateNonce,
  MUGEN_CIRCUITS,
  type EncryptedOfferParams,
  type BlindTakeParams,
} from '../src/mugen';
import type { ArciumClient } from '../src/client';

// ─── Mock helpers ────────────────────────────────────────────────────────────

interface MockEncryptPayload {
  ciphertexts: number[][];
  publicKey: Uint8Array;
  nonce: Uint8Array;
}

interface MockClient {
  encrypt: ReturnType<typeof vi.fn>;
  newComputationOffset: ReturnType<typeof vi.fn>;
  getComputationAccounts: ReturnType<typeof vi.fn>;
  awaitFinalization: ReturnType<typeof vi.fn>;
  nonceToU128: ReturnType<typeof vi.fn>;
  connection: {
    getTransaction: ReturnType<typeof vi.fn>;
  };
}

interface MockMethodsBuilder {
  accountsPartial: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
}

interface MockProgram {
  methods: {
    mugenSubmitOffer: ReturnType<typeof vi.fn>;
    mugenBlindTake: ReturnType<typeof vi.fn>;
    mugenCancelOffer: ReturnType<typeof vi.fn>;
  };
  __builders: {
    submit: MockMethodsBuilder;
    blindTake: MockMethodsBuilder;
    cancel: MockMethodsBuilder;
  };
}

function makePayload(blocks = 2): MockEncryptPayload {
  const ciphertexts: number[][] = [];
  for (let i = 0; i < blocks; i++) {
    ciphertexts.push(new Array(32).fill(0).map((_, j) => (i * 32 + j) & 0xff));
  }
  return {
    ciphertexts,
    publicKey: new Uint8Array(32).map((_, i) => (i + 1) & 0xff),
    nonce: new Uint8Array(16).map((_, i) => (i + 128) & 0xff),
  };
}

function makeMockClient(): MockClient {
  return {
    encrypt: vi.fn((_values: bigint[]) => makePayload(2)),
    newComputationOffset: vi.fn(() => new anchor.BN(42)),
    getComputationAccounts: vi.fn((_circuit: string, _offset: anchor.BN) => ({
      computationAccount: 'compAcc',
      clusterAccount: 'clusterAcc',
      mxeAccount: 'mxeAcc',
      mempoolAccount: 'mempoolAcc',
      executingPool: 'execPool',
      compDefAccount: 'compDefAcc',
    })),
    awaitFinalization: vi.fn(async (_offset: anchor.BN) => 'finalize-sig-123'),
    nonceToU128: vi.fn((_nonce: Uint8Array) => new anchor.BN(1)),
    connection: {
      getTransaction: vi.fn(),
    },
  };
}

function makeBuilder(rpcSig: string): MockMethodsBuilder {
  const builder: Partial<MockMethodsBuilder> = {};
  builder.rpc = vi.fn(async () => rpcSig);
  builder.accountsPartial = vi.fn(() => builder as MockMethodsBuilder);
  return builder as MockMethodsBuilder;
}

function makeMockProgram(): MockProgram {
  const submit = makeBuilder('sig-submit');
  const blindTake = makeBuilder('sig-take');
  const cancel = makeBuilder('sig-cancel');
  return {
    methods: {
      mugenSubmitOffer: vi.fn(() => submit),
      mugenBlindTake: vi.fn(() => blindTake),
      mugenCancelOffer: vi.fn(() => cancel),
    },
    __builders: { submit, blindTake, cancel },
  };
}

// Cast helpers — the SDK types are wider than our minimal mocks.
const asClient = (m: MockClient) => m as unknown as ArciumClient;
const asProgram = (m: MockProgram) => m as unknown as anchor.Program;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const validOffer: EncryptedOfferParams = {
  cryptoAmount: 100_000_000n, // 0.1 SOL
  fiatAmount: 1500n, // $15.00
  currency: 'USD',
  paymentMethods: 0b0011,
  makerNonce: 0xDEADBEEFCAFEn,
};

const validTake: BlindTakeParams = {
  desiredCrypto: 100_000_000n,
  maxFiat: 2000n,
  currency: 'USD',
  paymentMethods: 0b0001,
  takerNonce: 0xFEEDFACEBEEFn,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Mugen SDK — helpers', () => {
  it('currencyToHash is deterministic and case-insensitive', () => {
    const a = currencyToHash('USD');
    const b = currencyToHash('usd');
    const c = currencyToHash('EUR');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(typeof a).toBe('bigint');
  });

  it('generateNonce returns a bigint u64', () => {
    const n1 = generateNonce();
    const n2 = generateNonce();
    expect(typeof n1).toBe('bigint');
    expect(n1).not.toBe(n2); // astronomically unlikely collision
    expect(n1 < 2n ** 64n).toBe(true);
  });

  it('MUGEN_CIRCUITS exposes the three expected circuit names', () => {
    expect(MUGEN_CIRCUITS.SUBMIT_OFFER).toBe('mugen_submit_offer');
    expect(MUGEN_CIRCUITS.BLIND_TAKE).toBe('mugen_blind_take');
    expect(MUGEN_CIRCUITS.CANCEL_OFFER).toBe('mugen_cancel_offer');
  });
});

describe('submitEncryptedOffer', () => {
  let client: MockClient;
  let program: MockProgram;

  beforeEach(() => {
    client = makeMockClient();
    program = makeMockProgram();
  });

  it('happy path — returns OfferReceipt with offset, nonce, signature', async () => {
    const receipt = await submitEncryptedOffer(
      asClient(client),
      asProgram(program),
      validOffer,
    );

    expect(receipt).toMatchObject({
      makerNonce: validOffer.makerNonce,
      signature: 'sig-submit',
    });
    expect(receipt.computationOffset).toBeInstanceOf(anchor.BN);
    expect(receipt.computationOffset.eq(new anchor.BN(42))).toBe(true);
    expect(client.getComputationAccounts).toHaveBeenCalledWith(
      MUGEN_CIRCUITS.SUBMIT_OFFER,
      expect.any(anchor.BN),
    );
    expect(program.methods.mugenSubmitOffer).toHaveBeenCalledTimes(1);
    expect(program.__builders.submit.rpc).toHaveBeenCalledWith({
      commitment: 'confirmed',
    });
  });

  it('encrypts the 5 plaintext fields (crypto, fiat, currency hash, payments, nonce)', async () => {
    await submitEncryptedOffer(
      asClient(client),
      asProgram(program),
      validOffer,
    );

    expect(client.encrypt).toHaveBeenCalledTimes(1);
    const encryptedValues = client.encrypt.mock.calls[0][0] as bigint[];
    expect(encryptedValues).toHaveLength(5);
    expect(encryptedValues[0]).toBe(validOffer.cryptoAmount);
    expect(encryptedValues[1]).toBe(validOffer.fiatAmount);
    expect(encryptedValues[2]).toBe(currencyToHash(validOffer.currency));
    expect(encryptedValues[3]).toBe(BigInt(validOffer.paymentMethods));
    expect(encryptedValues[4]).toBe(validOffer.makerNonce);
  });

  it('plaintext sensitive fields NEVER appear in the submitted instruction args', async () => {
    await submitEncryptedOffer(
      asClient(client),
      asProgram(program),
      validOffer,
    );

    const args = program.methods.mugenSubmitOffer.mock.calls[0];
    // args = [computationOffset, ct0, ct1, pubKey, nonce]
    expect(args).toHaveLength(5);
    const flattened = JSON.stringify(args);
    // cryptoAmount 100_000_000 and fiat 1500 should not be found as raw numbers
    // in the serialized instruction args (they are inside opaque ciphertext bytes).
    expect(flattened).not.toContain('100000000');
    expect(flattened).not.toContain('"1500"');
  });

  it('wraps downstream RPC failures with a descriptive error', async () => {
    program.__builders.submit.rpc.mockRejectedValueOnce(
      new Error('cluster unreachable'),
    );
    await expect(
      submitEncryptedOffer(asClient(client), asProgram(program), validOffer),
    ).rejects.toThrow(/Mugen MPC computation failed.*cluster unreachable/);
  });

  it('non-string currency throws from downstream createHash (no explicit validation)', async () => {
    const bad = {
      ...validOffer,
      currency: 123 as unknown as string,
    };
    // Documents: SDK does not validate currency type — createHash throws instead.
    await expect(
      submitEncryptedOffer(asClient(client), asProgram(program), bad),
    ).rejects.toThrow();
  });

  it('zero cryptoAmount is NOT rejected at the SDK layer (MPC is the authority)', async () => {
    // Documents: the SDK does not reject zero amounts — the MPC circuit
    // handles all business-rule validation. If a guard is ever added, this
    // test should be flipped to `.rejects.toThrow`.
    const zeroAmount = { ...validOffer, cryptoAmount: 0n };
    await expect(
      submitEncryptedOffer(asClient(client), asProgram(program), zeroAmount),
    ).resolves.toMatchObject({ signature: 'sig-submit' });
    const encryptedValues = client.encrypt.mock.calls[0][0] as bigint[];
    expect(encryptedValues[0]).toBe(0n);
  });
});

describe('blindTakeOrder', () => {
  let client: MockClient;
  let program: MockProgram;

  beforeEach(() => {
    client = makeMockClient();
    program = makeMockProgram();
  });

  it('happy path — no match — returns matched=false with zeroed fields', async () => {
    client.connection.getTransaction.mockResolvedValueOnce({
      meta: { logMessages: ['Program log: MugenNoMatch'] },
    });

    const result = await blindTakeOrder(
      asClient(client),
      asProgram(program),
      validTake,
    );

    expect(result.matched).toBe(false);
    expect(result.cryptoAmount).toBe(0n);
    expect(result.fiatAmount).toBe(0n);
    expect(result.makerNonce).toBe(0n);
    expect(result.takerNonce).toBe(0n);
    expect(result.signature).toBe('finalize-sig-123');
    expect(client.awaitFinalization).toHaveBeenCalledTimes(1);
  });

  it('happy path — match — parses MugenMatch log into revealed fields', async () => {
    client.connection.getTransaction.mockResolvedValueOnce({
      meta: {
        logMessages: [
          'Program log: entered mugen_blind_take',
          'Program log: MugenMatch: crypto=100000000, fiat=1500, maker=244837814094590, taker=280421825952495',
        ],
      },
    });

    const result = await blindTakeOrder(
      asClient(client),
      asProgram(program),
      validTake,
    );

    expect(result.matched).toBe(true);
    expect(result.cryptoAmount).toBe(100_000_000n);
    expect(result.fiatAmount).toBe(1500n);
    expect(result.makerNonce).toBe(244837814094590n);
    expect(result.takerNonce).toBe(280421825952495n);
    expect(result.currencyHash).toBe(currencyToHash(validTake.currency));
    expect(result.signature).toBe('finalize-sig-123');
  });

  it('encrypts the buyer query before submission (no plaintext leak)', async () => {
    client.connection.getTransaction.mockResolvedValueOnce({
      meta: { logMessages: [] },
    });

    await blindTakeOrder(asClient(client), asProgram(program), validTake);

    expect(client.encrypt).toHaveBeenCalledTimes(1);
    const encryptedValues = client.encrypt.mock.calls[0][0] as bigint[];
    expect(encryptedValues).toHaveLength(5);
    expect(encryptedValues[0]).toBe(validTake.desiredCrypto);
    expect(encryptedValues[1]).toBe(validTake.maxFiat);
    expect(encryptedValues[2]).toBe(currencyToHash(validTake.currency));
    expect(encryptedValues[3]).toBe(BigInt(validTake.paymentMethods));
    expect(encryptedValues[4]).toBe(validTake.takerNonce);

    // And the right circuit was selected
    expect(client.getComputationAccounts).toHaveBeenCalledWith(
      MUGEN_CIRCUITS.BLIND_TAKE,
      expect.any(anchor.BN),
    );
  });

  it('returns matched=false when the callback tx cannot be fetched', async () => {
    client.connection.getTransaction.mockResolvedValueOnce(null);
    const result = await blindTakeOrder(
      asClient(client),
      asProgram(program),
      validTake,
    );
    expect(result.matched).toBe(false);
    expect(result.signature).toBe('finalize-sig-123');
  });

  it('wraps awaitFinalization errors', async () => {
    client.awaitFinalization.mockRejectedValueOnce(new Error('timed out'));
    await expect(
      blindTakeOrder(asClient(client), asProgram(program), validTake),
    ).rejects.toThrow(/Mugen MPC computation failed.*timed out/);
  });
});

describe('cancelEncryptedOffer', () => {
  let client: MockClient;
  let program: MockProgram;

  beforeEach(() => {
    client = makeMockClient();
    program = makeMockProgram();
  });

  it('happy path — encrypts the maker nonce and submits the cancel instruction', async () => {
    const nonce = 0xCAFEBABE1234n;
    const sig = await cancelEncryptedOffer(
      asClient(client),
      asProgram(program),
      nonce,
    );

    expect(sig).toBe('sig-cancel');
    expect(client.encrypt).toHaveBeenCalledTimes(1);
    const encryptedValues = client.encrypt.mock.calls[0][0] as bigint[];
    expect(encryptedValues).toEqual([nonce]);

    expect(client.getComputationAccounts).toHaveBeenCalledWith(
      MUGEN_CIRCUITS.CANCEL_OFFER,
      expect.any(anchor.BN),
    );
    expect(program.methods.mugenCancelOffer).toHaveBeenCalledTimes(1);
  });

  it('cancel uses a single ciphertext block (1 plaintext value)', async () => {
    await cancelEncryptedOffer(
      asClient(client),
      asProgram(program),
      0x1234n,
    );
    // submit/take call mugenSubmitOffer/BlindTake with 2 blocks;
    // cancel calls mugenCancelOffer with 1 block.
    const args = program.methods.mugenCancelOffer.mock.calls[0];
    // args = [computationOffset, ct0, pubKey, nonce] — 4 args, not 5.
    expect(args).toHaveLength(4);
  });

  it('throws if the nonce is not a bigint (plain encrypt fail)', async () => {
    // Documents: there is no explicit input guard; the mocked encrypt still
    // accepts anything. To get a realistic invalid-nonce throw, we simulate
    // the encryption layer rejecting a non-bigint value, mirroring what the
    // real RescueCipher does for malformed inputs.
    client.encrypt.mockImplementationOnce((values: unknown[]) => {
      if (values.some((v) => typeof v !== 'bigint')) {
        throw new Error('Rescue encrypt: non-bigint input');
      }
      return makePayload(1);
    });

    // NOTE: encrypt() is called OUTSIDE the try/catch that wraps program.rpc,
    // so this throw propagates raw (not wrapped as "Mugen MPC computation
    // failed"). This documents the actual SDK behavior.
    await expect(
      cancelEncryptedOffer(
        asClient(client),
        asProgram(program),
        'not-a-nonce' as unknown as bigint,
      ),
    ).rejects.toThrow(/non-bigint/);
  });

  it('wraps downstream RPC failures', async () => {
    program.__builders.cancel.rpc.mockRejectedValueOnce(
      new Error('signature verify failed'),
    );
    await expect(
      cancelEncryptedOffer(asClient(client), asProgram(program), 1n),
    ).rejects.toThrow(/Mugen MPC computation failed.*signature verify failed/);
  });
});
