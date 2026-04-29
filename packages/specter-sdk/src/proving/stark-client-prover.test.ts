// ============================================================================
// StarkClientProver — unit tests
// ============================================================================
//
// Verifies operation-to-circuit-id routing and input validation.
// The mocked `StarkProofGenerator` lets us assert the dispatch logic without
// exercising the WASM prover or the on-chain upload pipeline.
//
// Routing is mirrored from `programs/p01_stark_verifier/src/lib.rs:15-21`:
//   - deposit / withdraw / transfer -> CONFIDENTIAL_BALANCE (4)
//   - balance-proof                 -> BALANCE_PROOF        (2)
//
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  StarkClientProver,
  ProofInputValidationError,
  validateInputs,
  circuitIdForOperation,
  buildBalanceCircuitInputs,
  buildSufficiencyCircuitInputs,
  type ConfidentialBalancePublicInputs,
  type ConfidentialBalancePrivateInputs,
  type BalanceProofPublicInputs,
  type BalanceProofPrivateInputs,
  type ZkSplProofInputs,
} from './index';

// Lightweight stand-in for `PublicKey` — `@solana/web3.js` is heavy and we
// only need an object with a `toBase58()` method to satisfy the contract
// shape used by the SDK callers.
class MockPublicKey {
  constructor(private readonly tag: string) {}
  toBase58(): string { return this.tag; }
  toString(): string { return this.tag; }
  equals(other: MockPublicKey): boolean { return this.tag === other.tag; }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function depositInputs(): {
  pub: ConfidentialBalancePublicInputs;
  priv: ConfidentialBalancePrivateInputs;
} {
  return {
    pub: {
      oldCommitment: 11n,
      newCommitment: 22n,
      amountHash: 33n,
      publicCredit: 100n,
      publicDebit: 0n,
      tokenMint: 7n,
      nonce: 1n,
    },
    priv: {
      oldBalance: 0n,
      oldSalt: 1n,
      newBalance: 100n,
      newSalt: 2n,
      amount: 0n,
      amountSalt: 0n,
      spendingKey: 99n,
      isDebit: 0,
    },
  };
}

function withdrawInputs(): {
  pub: ConfidentialBalancePublicInputs;
  priv: ConfidentialBalancePrivateInputs;
} {
  return {
    pub: {
      oldCommitment: 11n,
      newCommitment: 22n,
      amountHash: 33n,
      publicCredit: 0n,
      publicDebit: 50n,
      tokenMint: 7n,
      nonce: 2n,
    },
    priv: {
      oldBalance: 100n,
      oldSalt: 1n,
      newBalance: 50n,
      newSalt: 2n,
      amount: 0n,
      amountSalt: 0n,
      spendingKey: 99n,
      isDebit: 0,
    },
  };
}

function transferInputs(): {
  pub: ConfidentialBalancePublicInputs;
  priv: ConfidentialBalancePrivateInputs;
} {
  return {
    pub: {
      oldCommitment: 11n,
      newCommitment: 22n,
      amountHash: 33n,
      publicCredit: 0n,
      publicDebit: 0n,
      tokenMint: 7n,
      nonce: 3n,
    },
    priv: {
      oldBalance: 100n,
      oldSalt: 1n,
      newBalance: 80n,
      newSalt: 2n,
      amount: 20n,
      amountSalt: 5n,
      spendingKey: 99n,
      isDebit: 1,
    },
  };
}

function balanceProofInputs(): {
  pub: BalanceProofPublicInputs;
  priv: BalanceProofPrivateInputs;
} {
  return {
    pub: {
      balanceCommitment: 42n,
      threshold: 10n,
      tokenMint: 7n,
    },
    priv: {
      balance: 100n,
      salt: 1n,
      spendingKey: 99n,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock generator
// ---------------------------------------------------------------------------

function makeMockGenerator() {
  return vi.fn().mockImplementation(async (
    circuitId: number,
    _privateInputs: Record<string, string | string[] | number[]>,
  ) => {
    return {
      proofBuffer: new MockPublicKey(`mock-pda-circuit-${circuitId}`),
      circuitId,
      publicInputs: [1n, 2n, 3n],
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('circuitIdForOperation', () => {
  it('routes deposit to CONFIDENTIAL_BALANCE (4)', () => {
    expect(circuitIdForOperation('deposit')).toBe(4);
  });

  it('routes withdraw to CONFIDENTIAL_BALANCE (4)', () => {
    expect(circuitIdForOperation('withdraw')).toBe(4);
  });

  it('routes transfer to CONFIDENTIAL_BALANCE (4)', () => {
    expect(circuitIdForOperation('transfer')).toBe(4);
  });

  it('routes balance-proof to BALANCE_PROOF (2)', () => {
    expect(circuitIdForOperation('balance-proof')).toBe(2);
  });
});

describe('StarkClientProver — constructor validation', () => {
  it('throws when neither generator nor config is supplied', () => {
    expect(() => new StarkClientProver({})).toThrow(/generator.*config.*required/);
  });

  it('throws when both generator and config are supplied', () => {
    const generator = makeMockGenerator();
    expect(
      () => new StarkClientProver({
        generator,
        // The config object will not be exercised — the constructor
        // short-circuits before consulting it.
        config: { connection: {} as never, payer: {} as never },
      }),
    ).toThrow(/either.*OR.*not both/);
  });
});

describe('StarkClientProver.prove — operation routing', () => {
  let generator: ReturnType<typeof makeMockGenerator>;
  let prover: StarkClientProver;

  beforeEach(() => {
    generator = makeMockGenerator();
    prover = new StarkClientProver({ generator });
  });

  it('routes deposit -> circuit 4 (CONFIDENTIAL_BALANCE)', async () => {
    const { pub, priv } = depositInputs();
    const result = await prover.prove({ operation: 'deposit', public: pub, private: priv });

    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator.mock.calls[0]![0]).toBe(4);
    expect(result.circuitId).toBe(4);
    expect(result.proofBuffer.toBase58()).toBe('mock-pda-circuit-4');
  });

  it('routes withdraw -> circuit 4 (CONFIDENTIAL_BALANCE)', async () => {
    const { pub, priv } = withdrawInputs();
    await prover.prove({ operation: 'withdraw', public: pub, private: priv });
    expect(generator.mock.calls[0]![0]).toBe(4);
  });

  it('routes transfer -> circuit 4 (CONFIDENTIAL_BALANCE)', async () => {
    const { pub, priv } = transferInputs();
    await prover.prove({ operation: 'transfer', public: pub, private: priv });
    expect(generator.mock.calls[0]![0]).toBe(4);
  });

  it('routes balance-proof -> circuit 2 (BALANCE_PROOF)', async () => {
    const { pub, priv } = balanceProofInputs();
    const result = await prover.prove({ operation: 'balance-proof', public: pub, private: priv });

    expect(generator.mock.calls[0]![0]).toBe(2);
    expect(result.circuitId).toBe(2);
    expect(result.proofBuffer.toBase58()).toBe('mock-pda-circuit-2');
  });

  it('passes the flat string-keyed input map to the generator', async () => {
    const { pub, priv } = depositInputs();
    await prover.prove({ operation: 'deposit', public: pub, private: priv });

    const map = generator.mock.calls[0]![1] as Record<string, string>;
    expect(map.spendingKey).toBe('99');
    expect(map.oldBalance).toBe('0');
    expect(map.newBalance).toBe('100');
    expect(map.tokenMint).toBe('7');
    expect(map.publicCredit).toBe('100');
    expect(map.publicDebit).toBe('0');
  });

  it('throws on an unknown operation', async () => {
    const { pub, priv } = depositInputs();
    const bogus = { operation: 'invalid-op', public: pub, private: priv } as unknown as ZkSplProofInputs;
    await expect(prover.prove(bogus)).rejects.toThrow(/Unknown operation/);
    expect(generator).not.toHaveBeenCalled();
  });
});

describe('StarkClientProver.prove — input validation', () => {
  let generator: ReturnType<typeof makeMockGenerator>;
  let prover: StarkClientProver;

  beforeEach(() => {
    generator = makeMockGenerator();
    prover = new StarkClientProver({ generator });
  });

  it('rejects a deposit with publicCredit = 0', async () => {
    const { pub, priv } = depositInputs();
    pub.publicCredit = 0n;
    await expect(
      prover.prove({ operation: 'deposit', public: pub, private: priv }),
    ).rejects.toBeInstanceOf(ProofInputValidationError);
    expect(generator).not.toHaveBeenCalled();
  });

  it('rejects a deposit with publicDebit > 0', async () => {
    const { pub, priv } = depositInputs();
    pub.publicDebit = 50n;
    await expect(
      prover.prove({ operation: 'deposit', public: pub, private: priv }),
    ).rejects.toBeInstanceOf(ProofInputValidationError);
  });

  it('rejects a withdraw with publicDebit = 0', async () => {
    const { pub, priv } = withdrawInputs();
    pub.publicDebit = 0n;
    await expect(
      prover.prove({ operation: 'withdraw', public: pub, private: priv }),
    ).rejects.toBeInstanceOf(ProofInputValidationError);
  });

  it('rejects a transfer with amount = 0', async () => {
    const { pub, priv } = transferInputs();
    priv.amount = 0n;
    await expect(
      prover.prove({ operation: 'transfer', public: pub, private: priv }),
    ).rejects.toBeInstanceOf(ProofInputValidationError);
  });

  it('rejects a balance-proof with negative threshold', async () => {
    const { pub, priv } = balanceProofInputs();
    pub.threshold = -1n;
    await expect(
      prover.prove({ operation: 'balance-proof', public: pub, private: priv }),
    ).rejects.toBeInstanceOf(ProofInputValidationError);
  });
});

describe('validateInputs — direct invocation', () => {
  it('passes valid deposit inputs', () => {
    const { pub, priv } = depositInputs();
    expect(() =>
      validateInputs({ operation: 'deposit', public: pub, private: priv }),
    ).not.toThrow();
  });

  it('throws ProofInputValidationError with violations array', () => {
    const { pub, priv } = depositInputs();
    pub.publicCredit = 0n;
    pub.publicDebit = 5n;

    try {
      validateInputs({ operation: 'deposit', public: pub, private: priv });
      expect.fail('expected validateInputs to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProofInputValidationError);
      const e = err as ProofInputValidationError;
      expect(e.operation).toBe('deposit');
      expect(e.violations.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('Input builders', () => {
  it('buildBalanceCircuitInputs stringifies all bigints', () => {
    const { pub, priv } = depositInputs();
    const map = buildBalanceCircuitInputs(pub, priv);
    expect(map.spendingKey).toBe('99');
    expect(map.tokenMint).toBe('7');
    expect(map.amount).toBe('0');
    expect(map.publicCredit).toBe('100');
    // every value must be a string (not a bigint or number)
    for (const v of Object.values(map)) {
      expect(typeof v).toBe('string');
    }
  });

  it('buildSufficiencyCircuitInputs stringifies all bigints', () => {
    const { pub, priv } = balanceProofInputs();
    const map = buildSufficiencyCircuitInputs(pub, priv);
    expect(map.balance).toBe('100');
    expect(map.threshold).toBe('10');
    expect(map.tokenMint).toBe('7');
    for (const v of Object.values(map)) {
      expect(typeof v).toBe('string');
    }
  });
});
