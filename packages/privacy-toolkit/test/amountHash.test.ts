import { describe, it, expect } from 'vitest';
import { createAmountHash, zeroAmountHash } from '../src/commitment/amountHash';

describe('Amount Hash', () => {
  it('creates deterministic amount hashes', () => {
    const h1 = createAmountHash(100n, 42n);
    const h2 = createAmountHash(100n, 42n);
    expect(h1).toBe(h2);
  });

  it('different amounts produce different hashes', () => {
    const h1 = createAmountHash(100n, 42n);
    const h2 = createAmountHash(200n, 42n);
    expect(h1).not.toBe(h2);
  });

  it('same amount different salt produces different hash', () => {
    const h1 = createAmountHash(100n, 42n);
    const h2 = createAmountHash(100n, 43n);
    expect(h1).not.toBe(h2);
  });

  it('zero amount hash is deterministic', () => {
    const z1 = zeroAmountHash();
    const z2 = zeroAmountHash();
    expect(z1).toBe(z2);
  });

  it('zero amount hash equals createAmountHash(0, 0)', () => {
    const z = zeroAmountHash();
    const manual = createAmountHash(0n, 0n);
    expect(z).toBe(manual);
  });
});
