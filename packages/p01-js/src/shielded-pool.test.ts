/**
 * Tests for Protocol 01 Shielded Pool Primitives
 *
 * Tests cover:
 * - Receipt JSON serialization/deserialization round-trip
 * - Receipt encryption/decryption with password
 * - RelayerClient retry logic with mocked fetch
 * - Pool info types and delay tier estimation
 * - Proof generator throws without snarkjs
 * - Shield parameter validation
 * - Unshield parameter validation
 * - Commitment placeholder computation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  receiptToJSON,
  receiptFromJSON,
  serializeReceipt,
  deserializeReceipt,
} from './receipt-manager';

import {
  validateShieldParams,
  validateUnshieldParams,
  estimateDelayTier,
  isValidDenomination,
  computeCommitmentPlaceholder,
  shield,
  STANDARD_DENOMINATIONS,
  MERKLE_TREE_DEPTH,
  MAX_LEAVES,
  resolveTokenMintForPool,
} from './shielded-pool';

import type { ShieldReceipt } from './shielded-pool';

import { RelayerClient } from './relayer-client';
import type { RelayerConfig } from './relayer-client';

import {
  generateDenominatedPoolProof,
  verifyProof,
} from './proof-generator';

// ============ Test Fixtures ============

function createMockReceipt(): ShieldReceipt {
  return {
    secret: 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344',
    nullifierPreimage: '11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd',
    depositEpoch: 12345678,
    tokenMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    commitment: 'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00',
    leafIndex: 42,
    denomination: 100,
    pool: 'PoolPDA11111111111111111111111111111111111111',
  };
}

// ============ Receipt JSON Serialization ============

describe('receiptToJSON / receiptFromJSON', () => {
  it('should round-trip a receipt through JSON', () => {
    const original = createMockReceipt();
    const json = receiptToJSON(original);
    const restored = receiptFromJSON(json);

    expect(restored.secret).toBe(original.secret);
    expect(restored.nullifierPreimage).toBe(original.nullifierPreimage);
    expect(restored.depositEpoch).toBe(original.depositEpoch);
    expect(restored.tokenMint).toBe(original.tokenMint);
    expect(restored.commitment).toBe(original.commitment);
    expect(restored.leafIndex).toBe(original.leafIndex);
    expect(restored.denomination).toBe(original.denomination);
    expect(restored.pool).toBe(original.pool);
  });

  it('should produce valid JSON output', () => {
    const receipt = createMockReceipt();
    const json = receiptToJSON(receipt);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('should throw on invalid JSON input', () => {
    expect(() => receiptFromJSON('not-json')).toThrow('Invalid JSON');
  });

  it('should throw on missing required fields', () => {
    const incomplete = JSON.stringify({ secret: 'abc' });
    expect(() => receiptFromJSON(incomplete)).toThrow('missing required field');
  });

  it('should throw on empty JSON object', () => {
    expect(() => receiptFromJSON('{}')).toThrow('missing required field');
  });

  it('should preserve all field types correctly', () => {
    const original = createMockReceipt();
    const json = receiptToJSON(original);
    const restored = receiptFromJSON(json);

    expect(typeof restored.secret).toBe('string');
    expect(typeof restored.nullifierPreimage).toBe('string');
    expect(typeof restored.depositEpoch).toBe('number');
    expect(typeof restored.tokenMint).toBe('string');
    expect(typeof restored.commitment).toBe('string');
    expect(typeof restored.leafIndex).toBe('number');
    expect(typeof restored.denomination).toBe('number');
    expect(typeof restored.pool).toBe('string');
  });
});

// ============ Receipt Encryption ============

describe('serializeReceipt / deserializeReceipt', () => {
  it('should round-trip a receipt through encryption', async () => {
    const original = createMockReceipt();
    const password = 'test-password-123!';

    const encrypted = await serializeReceipt(original, password);
    const restored = await deserializeReceipt(encrypted, password);

    expect(restored.secret).toBe(original.secret);
    expect(restored.nullifierPreimage).toBe(original.nullifierPreimage);
    expect(restored.depositEpoch).toBe(original.depositEpoch);
    expect(restored.tokenMint).toBe(original.tokenMint);
    expect(restored.commitment).toBe(original.commitment);
    expect(restored.leafIndex).toBe(original.leafIndex);
    expect(restored.denomination).toBe(original.denomination);
    expect(restored.pool).toBe(original.pool);
  });

  it('should produce different ciphertext for the same receipt (random nonce)', async () => {
    const receipt = createMockReceipt();
    const password = 'password';

    const encrypted1 = await serializeReceipt(receipt, password);
    const encrypted2 = await serializeReceipt(receipt, password);

    // Due to random salt and nonce, outputs should differ
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('should fail decryption with wrong password', async () => {
    const receipt = createMockReceipt();
    const encrypted = await serializeReceipt(receipt, 'correct-password');

    await expect(
      deserializeReceipt(encrypted, 'wrong-password')
    ).rejects.toThrow('Decryption failed');
  });

  it('should fail on empty encrypted data', async () => {
    await expect(
      deserializeReceipt('', 'password')
    ).rejects.toThrow('Encrypted receipt data is required');
  });

  it('should fail on empty password for encryption', async () => {
    const receipt = createMockReceipt();
    await expect(
      serializeReceipt(receipt, '')
    ).rejects.toThrow('Password is required');
  });

  it('should fail on empty password for decryption', async () => {
    await expect(
      deserializeReceipt('somedata', '')
    ).rejects.toThrow('Password is required');
  });

  it('should fail on invalid base64 input', async () => {
    await expect(
      deserializeReceipt('!!!invalid-base64!!!', 'password')
    ).rejects.toThrow();
  });

  it('should fail on truncated encrypted data', async () => {
    const receipt = createMockReceipt();
    const encrypted = await serializeReceipt(receipt, 'password');
    // Truncate to just a few characters
    const truncated = encrypted.substring(0, 10);

    await expect(
      deserializeReceipt(truncated, 'password')
    ).rejects.toThrow();
  });

  it('should produce base64 output', async () => {
    const receipt = createMockReceipt();
    const encrypted = await serializeReceipt(receipt, 'password');

    // Base64 regex check
    expect(encrypted).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

// ============ RelayerClient ============

describe('RelayerClient', () => {
  it('should require a url in config', () => {
    expect(() => new RelayerClient({ url: '' })).toThrow('requires a url');
  });

  it('should normalize trailing slashes from url', () => {
    const client = new RelayerClient({ url: 'https://example.com///' });
    expect(client.getUrl()).toBe('https://example.com');
  });

  it('should store configuration correctly', () => {
    const client = new RelayerClient({
      url: 'https://relay.example.com',
      timeout: 5000,
      maxRetries: 5,
    });
    expect(client.getUrl()).toBe('https://relay.example.com');
  });

  describe('retry logic', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should succeed on first attempt when server responds correctly', async () => {
      const mockResponse = {
        online: true,
        supportedTokens: ['USDC'],
        feePercent: 1.0,
        version: '1.0.0',
      };

      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = new RelayerClient({
        url: 'https://relay.test',
        timeout: 5000,
        maxRetries: 3,
      });

      const status = await client.getStatus();
      expect(status.online).toBe(true);
      expect(status.feePercent).toBe(1.0);
      expect(callCount).toBe(1);
    });

    it('should retry on 500 errors and eventually succeed', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount < 3) {
          return new Response('Server Error', { status: 500 });
        }
        return new Response(
          JSON.stringify({
            online: true,
            supportedTokens: [],
            feePercent: 0.5,
            version: '1.0.0',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const client = new RelayerClient({
        url: 'https://relay.test',
        timeout: 5000,
        maxRetries: 3,
      });

      const status = await client.getStatus();
      expect(status.online).toBe(true);
      expect(callCount).toBe(3);
    });

    it('should not retry on 4xx client errors', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response(
          JSON.stringify({
            code: 'INVALID_PROOF',
            message: 'The submitted proof is invalid.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const client = new RelayerClient({
        url: 'https://relay.test',
        timeout: 5000,
        maxRetries: 3,
      });

      await expect(client.getStatus()).rejects.toThrow('INVALID_PROOF');
      expect(callCount).toBe(1);
    });

    it('should throw after exhausting retries', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('Server Error', { status: 500 });
      });

      const client = new RelayerClient({
        url: 'https://relay.test',
        timeout: 5000,
        maxRetries: 2,
      });

      await expect(client.getStatus()).rejects.toThrow('failed after 3 attempts');
    });

    it('should validate submitUnshield params', async () => {
      const client = new RelayerClient({ url: 'https://relay.test' });

      await expect(
        client.submitUnshield({
          proof: null as any,
          publicSignals: ['1'],
          recipient: 'addr',
          pool: 'pool',
        })
      ).rejects.toThrow('proof is required');

      await expect(
        client.submitUnshield({
          proof: { pi_a: [], pi_b: [], pi_c: [] },
          publicSignals: [],
          recipient: 'addr',
          pool: 'pool',
        })
      ).rejects.toThrow('publicSignals are required');

      await expect(
        client.submitUnshield({
          proof: { pi_a: [], pi_b: [], pi_c: [] },
          publicSignals: ['1'],
          recipient: '',
          pool: 'pool',
        })
      ).rejects.toThrow('recipient address is required');
    });
  });
});

// ============ Shield Parameter Validation ============

describe('validateShieldParams', () => {
  it('should accept valid SOL shield params', () => {
    expect(() =>
      validateShieldParams({
        token: 'SOL',
        denomination: 1,
        wallet: { publicKey: 'test' },
      })
    ).not.toThrow();
  });

  it('should accept valid USDC shield params', () => {
    expect(() =>
      validateShieldParams({
        token: 'USDC',
        denomination: 100,
        wallet: { publicKey: 'test' },
      })
    ).not.toThrow();
  });

  it('should accept all standard denominations', () => {
    for (const denom of STANDARD_DENOMINATIONS) {
      expect(() =>
        validateShieldParams({
          token: 'USDC',
          denomination: denom,
          wallet: { publicKey: 'test' },
        })
      ).not.toThrow();
    }
  });

  it('should reject invalid token', () => {
    expect(() =>
      validateShieldParams({
        token: 'BTC' as any,
        denomination: 1,
        wallet: { publicKey: 'test' },
      })
    ).toThrow('Invalid token');
  });

  it('should reject invalid denomination', () => {
    expect(() =>
      validateShieldParams({
        token: 'USDC',
        denomination: 50,
        wallet: { publicKey: 'test' },
      })
    ).toThrow('Invalid denomination');
  });

  it('should reject missing wallet', () => {
    expect(() =>
      validateShieldParams({
        token: 'USDC',
        denomination: 1,
        wallet: null,
      })
    ).toThrow('Wallet is required');
  });
});

// ============ Unshield Parameter Validation ============

describe('validateUnshieldParams', () => {
  it('should accept valid unshield params without relayer', () => {
    expect(() =>
      validateUnshieldParams({
        receipt: createMockReceipt(),
        recipientAddress: '11111111111111111111111111111111',
        useRelayer: false,
      })
    ).not.toThrow();
  });

  it('should accept valid unshield params with relayer', () => {
    expect(() =>
      validateUnshieldParams({
        receipt: createMockReceipt(),
        recipientAddress: '11111111111111111111111111111111',
        useRelayer: true,
        relayerUrl: 'https://relay.example.com',
      })
    ).not.toThrow();
  });

  it('should reject missing receipt', () => {
    expect(() =>
      validateUnshieldParams({
        receipt: null as any,
        recipientAddress: '11111111111111111111111111111111',
        useRelayer: false,
      })
    ).toThrow('Receipt is required');
  });

  it('should reject receipt missing secret', () => {
    const receipt = createMockReceipt();
    receipt.secret = '';
    expect(() =>
      validateUnshieldParams({
        receipt,
        recipientAddress: '11111111111111111111111111111111',
        useRelayer: false,
      })
    ).toThrow('missing secret');
  });

  it('should reject invalid recipient address', () => {
    expect(() =>
      validateUnshieldParams({
        receipt: createMockReceipt(),
        recipientAddress: 'short',
        useRelayer: false,
      })
    ).toThrow('Invalid recipient address');
  });

  it('should reject relayer mode without relayerUrl', () => {
    expect(() =>
      validateUnshieldParams({
        receipt: createMockReceipt(),
        recipientAddress: '11111111111111111111111111111111',
        useRelayer: true,
      })
    ).toThrow('relayerUrl is required');
  });
});

// ============ Delay Tier Estimation ============

describe('estimateDelayTier', () => {
  it('should return 6h for small pools (< 10 notes)', () => {
    expect(estimateDelayTier(0)).toEqual({ tier: '6h', delayMs: 6 * 60 * 60 * 1000 });
    expect(estimateDelayTier(5)).toEqual({ tier: '6h', delayMs: 6 * 60 * 60 * 1000 });
    expect(estimateDelayTier(9)).toEqual({ tier: '6h', delayMs: 6 * 60 * 60 * 1000 });
  });

  it('should return 1h for medium pools (10-49 notes)', () => {
    expect(estimateDelayTier(10)).toEqual({ tier: '1h', delayMs: 60 * 60 * 1000 });
    expect(estimateDelayTier(30)).toEqual({ tier: '1h', delayMs: 60 * 60 * 1000 });
    expect(estimateDelayTier(49)).toEqual({ tier: '1h', delayMs: 60 * 60 * 1000 });
  });

  it('should return 10min for large pools (50-199 notes)', () => {
    expect(estimateDelayTier(50)).toEqual({ tier: '10min', delayMs: 10 * 60 * 1000 });
    expect(estimateDelayTier(100)).toEqual({ tier: '10min', delayMs: 10 * 60 * 1000 });
    expect(estimateDelayTier(199)).toEqual({ tier: '10min', delayMs: 10 * 60 * 1000 });
  });

  it('should return instant for very large pools (200+ notes)', () => {
    expect(estimateDelayTier(200)).toEqual({ tier: 'instant', delayMs: 0 });
    expect(estimateDelayTier(1000)).toEqual({ tier: 'instant', delayMs: 0 });
    expect(estimateDelayTier(10000)).toEqual({ tier: 'instant', delayMs: 0 });
  });
});

// ============ Denomination Validation ============

describe('isValidDenomination', () => {
  it('should accept standard denominations', () => {
    expect(isValidDenomination(1)).toBe(true);
    expect(isValidDenomination(10)).toBe(true);
    expect(isValidDenomination(100)).toBe(true);
    expect(isValidDenomination(1000)).toBe(true);
  });

  it('should reject non-standard denominations', () => {
    expect(isValidDenomination(0)).toBe(false);
    expect(isValidDenomination(5)).toBe(false);
    expect(isValidDenomination(50)).toBe(false);
    expect(isValidDenomination(500)).toBe(false);
    expect(isValidDenomination(10000)).toBe(false);
    expect(isValidDenomination(-1)).toBe(false);
  });
});

// ============ Token Mint Resolution ============

describe('resolveTokenMintForPool', () => {
  it('should resolve SOL to wrapped SOL mint', () => {
    const mint = resolveTokenMintForPool('SOL');
    expect(mint).toBe('So11111111111111111111111111111111111111112');
  });

  it('should resolve USDC to devnet mint by default', () => {
    const mint = resolveTokenMintForPool('USDC');
    expect(mint).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  });

  it('should resolve USDC to mainnet mint when specified', () => {
    const mint = resolveTokenMintForPool('USDC', 'mainnet-beta');
    expect(mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });
});

// ============ Commitment Placeholder ============

describe('computeCommitmentPlaceholder', () => {
  it('should produce a 64-character hex string (32 bytes)', () => {
    const commitment = computeCommitmentPlaceholder(
      'aa'.repeat(32),
      'bb'.repeat(32),
      12345678,
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
    );
    expect(commitment).toHaveLength(64);
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be deterministic for the same inputs', () => {
    const args = [
      'aa'.repeat(32),
      'bb'.repeat(32),
      12345678,
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    ] as const;

    const c1 = computeCommitmentPlaceholder(...args);
    const c2 = computeCommitmentPlaceholder(...args);
    expect(c1).toBe(c2);
  });

  it('should produce different commitments for different inputs', () => {
    const c1 = computeCommitmentPlaceholder(
      'aa'.repeat(32), 'bb'.repeat(32), 100, 'mint1'
    );
    const c2 = computeCommitmentPlaceholder(
      'cc'.repeat(32), 'dd'.repeat(32), 200, 'mint2'
    );
    expect(c1).not.toBe(c2);
  });
});

// ============ Shield Function ============

describe('shield', () => {
  it('should generate a receipt with all required fields', async () => {
    // shield() generates the receipt locally (transaction submission is a TODO)
    const receipt = await shield({
      token: 'USDC',
      denomination: 100,
      wallet: { publicKey: 'test' },
    });

    expect(receipt.secret).toBeTruthy();
    expect(receipt.secret).toHaveLength(64); // 32 bytes hex
    expect(receipt.nullifierPreimage).toBeTruthy();
    expect(receipt.nullifierPreimage).toHaveLength(64);
    expect(receipt.depositEpoch).toBeGreaterThan(0);
    expect(receipt.tokenMint).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(receipt.commitment).toHaveLength(64);
    expect(receipt.denomination).toBe(100);
    expect(receipt.leafIndex).toBe(-1); // Unknown until on-chain confirmation
    expect(receipt.pool).toContain('USDC');
  });

  it('should generate unique secrets each time', async () => {
    const r1 = await shield({
      token: 'USDC',
      denomination: 10,
      wallet: { publicKey: 'test' },
    });
    const r2 = await shield({
      token: 'USDC',
      denomination: 10,
      wallet: { publicKey: 'test' },
    });

    expect(r1.secret).not.toBe(r2.secret);
    expect(r1.nullifierPreimage).not.toBe(r2.nullifierPreimage);
  });
});

// ============ Proof Generator ============

describe('generateDenominatedPoolProof', () => {
  it('should throw when pathElements is missing', async () => {
    await expect(
      generateDenominatedPoolProof(
        { root: '123', secret: '456' },
        { wasmPath: '/test.wasm', zkeyPath: '/test.zkey' }
      )
    ).rejects.toThrow('pathElements');
  });

  it('should throw when wasmPath is not provided', async () => {
    await expect(
      generateDenominatedPoolProof({ root: '123' }, {})
    ).rejects.toThrow('wasmPath is required');
  });

  it('should throw when zkeyPath is not provided', async () => {
    await expect(
      generateDenominatedPoolProof(
        { root: '123', pathElements: [], pathIndices: [] },
        { wasmPath: '/test.wasm' }
      )
    ).rejects.toThrow('zkeyPath is required');
  });

  it('should throw when no config is provided', async () => {
    await expect(
      generateDenominatedPoolProof({ root: '123' })
    ).rejects.toThrow();
  });
});

describe('verifyProof', () => {
  it('should throw when vkPath is not provided', async () => {
    await expect(
      verifyProof(
        { pi_a: [], pi_b: [], pi_c: [] },
        ['1', '2']
      )
    ).rejects.toThrow('vkPath is required');
  });

  it('should throw when vkPath points to a non-existent file', async () => {
    await expect(
      verifyProof(
        { pi_a: [], pi_b: [], pi_c: [] },
        ['1', '2'],
        '/nonexistent/vk.json'
      )
    ).rejects.toThrow();
  });
});

// ============ Constants ============

describe('constants', () => {
  it('should export correct standard denominations', () => {
    expect(STANDARD_DENOMINATIONS).toEqual([1, 10, 100, 1000]);
  });

  it('should export correct Merkle tree depth', () => {
    expect(MERKLE_TREE_DEPTH).toBe(15);
  });

  it('should export correct max leaves', () => {
    expect(MAX_LEAVES).toBe(32768); // 2^15
  });
});
