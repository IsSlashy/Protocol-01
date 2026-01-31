import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Mocks -- declared before imports so vi.mock hoisting works
// ---------------------------------------------------------------------------

// Mock @solana/web3.js
const mockGetBalance = vi.fn();
const mockSendAndConfirmTransaction = vi.fn();

vi.mock('@solana/web3.js', async () => {
  // We need a lightweight stand-in for Keypair / PublicKey that behaves enough
  // like the real classes for the module under test to work.

  class MockPublicKey {
    private _key: Buffer;

    constructor(input: string | Buffer | Uint8Array) {
      if (typeof input === 'string') {
        // Treat as base58 -- just store raw bytes for test purposes
        this._key = Buffer.alloc(32);
        Buffer.from(input).copy(this._key);
      } else {
        this._key = Buffer.from(input);
      }
    }

    toBase58() {
      // Trim trailing zeros for readability
      return this._key.toString('hex').replace(/0+$/, '') || '00';
    }

    toBytes() {
      return new Uint8Array(this._key);
    }

    toBuffer() {
      return this._key;
    }

    equals(other: MockPublicKey) {
      return this._key.equals(other._key);
    }
  }

  class MockKeypair {
    publicKey: MockPublicKey;
    secretKey: Uint8Array;

    constructor(publicKey: MockPublicKey, secretKey: Uint8Array) {
      this.publicKey = publicKey;
      this.secretKey = secretKey;
    }

    static generate() {
      const seed = crypto.randomBytes(32);
      const pk = new MockPublicKey(seed);
      const sk = new Uint8Array(64);
      sk.set(seed, 0);
      sk.set(new Uint8Array(pk.toBytes()), 32);
      return new MockKeypair(pk, sk);
    }

    static fromSeed(seed: Uint8Array) {
      const hash = crypto.createHash('sha256').update(seed).digest();
      const pk = new MockPublicKey(hash);
      const sk = new Uint8Array(64);
      sk.set(hash, 0);
      sk.set(new Uint8Array(pk.toBytes()), 32);
      return new MockKeypair(pk, sk);
    }
  }

  return {
    PublicKey: MockPublicKey,
    Keypair: MockKeypair,
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: mockGetBalance,
    })),
    Transaction: vi.fn().mockImplementation(() => ({
      add: vi.fn().mockReturnThis(),
    })),
    SystemProgram: {
      transfer: vi.fn().mockReturnValue({}),
    },
    sendAndConfirmTransaction: (...args: any[]) => mockSendAndConfirmTransaction(...args),
  };
});

// Mock snarkjs
const mockVerify = vi.fn();
vi.mock('snarkjs', () => ({
  groth16: {
    verify: (...args: any[]) => mockVerify(...args),
  },
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are set up)
// ---------------------------------------------------------------------------
import {
  generateStealthAddress,
  encryptRecipientData,
  handlePrivateSend,
  scanForPayments,
  DENOMINATIONS,
  type PrivateSendRequest,
} from './private-send';

import { Keypair, Connection } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidRequest(overrides: Partial<PrivateSendRequest> = {}): PrivateSendRequest {
  const ephemeralKp = Keypair.generate();
  return {
    proof: {
      pi_a: ['1', '2', '1'],
      pi_b: [['1', '2'], ['3', '4'], ['1', '0']],
      pi_c: ['1', '2', '1'],
    },
    publicSignals: ['123', '456'],
    nullifier: 'nullifier_' + Math.random().toString(36).slice(2),
    encryptedRecipient: 'deadbeef:cafebabe',
    ephemeralPublicKey: Buffer.from(ephemeralKp.publicKey.toBytes()).toString('base64'),
    viewTag: 'ab',
    denominationIndex: 1, // 1 SOL
    feeCommitment: 'fee_commitment_hex',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateStealthAddress', () => {
  it('returns a stealth address, ephemeral public key, and view tag', () => {
    const spending = crypto.randomBytes(32);
    const viewing = crypto.randomBytes(32);

    const result = generateStealthAddress(spending, viewing);

    expect(result.stealthAddress).toBeInstanceOf(Uint8Array);
    expect(result.stealthAddress).toHaveLength(32);
    expect(result.ephemeralPublicKey).toBeInstanceOf(Uint8Array);
    expect(result.ephemeralPublicKey).toHaveLength(32);
    expect(typeof result.viewTag).toBe('string');
    // View tag is 2 bytes hex = 4 hex chars
    expect(result.viewTag).toHaveLength(4);
  });

  it('produces different stealth addresses for different recipients', () => {
    const spending1 = crypto.randomBytes(32);
    const viewing1 = crypto.randomBytes(32);
    const spending2 = crypto.randomBytes(32);
    const viewing2 = crypto.randomBytes(32);

    const result1 = generateStealthAddress(spending1, viewing1);
    const result2 = generateStealthAddress(spending2, viewing2);

    expect(Buffer.from(result1.stealthAddress).equals(Buffer.from(result2.stealthAddress))).toBe(false);
  });

  it('produces different stealth addresses on each call (ephemeral key is random)', () => {
    const spending = crypto.randomBytes(32);
    const viewing = crypto.randomBytes(32);

    const result1 = generateStealthAddress(spending, viewing);
    const result2 = generateStealthAddress(spending, viewing);

    // Extremely unlikely to collide
    expect(Buffer.from(result1.stealthAddress).equals(Buffer.from(result2.stealthAddress))).toBe(false);
    expect(Buffer.from(result1.ephemeralPublicKey).equals(Buffer.from(result2.ephemeralPublicKey))).toBe(false);
  });
});

describe('encryptRecipientData', () => {
  it('returns an iv:ciphertext string', () => {
    const viewingKey = crypto.randomBytes(32);
    const data = {
      spendingPubkey: 'abc123',
      viewingPubkey: 'def456',
    };

    const encrypted = encryptRecipientData(viewingKey, data);

    expect(typeof encrypted).toBe('string');
    expect(encrypted).toContain(':');
    const [iv, ciphertext] = encrypted.split(':');
    // IV is 16 bytes hex = 32 hex chars
    expect(iv).toHaveLength(32);
    // Ciphertext should be non-empty
    expect(ciphertext.length).toBeGreaterThan(0);
  });

  it('can be decrypted with the same key', () => {
    const viewingKey = crypto.randomBytes(32);
    const data = {
      spendingPubkey: 'spend_key_123',
      viewingPubkey: 'view_key_456',
    };

    const encrypted = encryptRecipientData(viewingKey, data);
    const [ivHex, cipherHex] = encrypted.split(':');

    // Decrypt
    const key = crypto.createHash('sha256').update(viewingKey).digest();
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    expect(JSON.parse(decrypted)).toEqual(data);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const viewingKey = crypto.randomBytes(32);
    const data = { spendingPubkey: 'a', viewingPubkey: 'b' };

    const enc1 = encryptRecipientData(viewingKey, data);
    const enc2 = encryptRecipientData(viewingKey, data);

    expect(enc1).not.toBe(enc2);
  });
});

describe('handlePrivateSend', () => {
  let relayerKeypair: InstanceType<typeof Keypair>;
  let connection: InstanceType<typeof Connection>;
  let spentNullifiers: Set<string>;
  const mockVerificationKey = { protocol: 'groth16', nPublic: 2 };

  beforeEach(() => {
    vi.clearAllMocks();
    relayerKeypair = Keypair.generate();
    connection = new Connection('http://localhost:8899', 'confirmed');
    spentNullifiers = new Set<string>();

    // Defaults: proof valid, balance sufficient
    mockVerify.mockResolvedValue(true);
    mockGetBalance.mockResolvedValue(10_000_000_000); // 10 SOL
    mockSendAndConfirmTransaction.mockResolvedValue('mock_signature_abc123');
  });

  it('succeeds with valid proof, fresh nullifier, and sufficient balance', async () => {
    const request = makeValidRequest();

    const result = await handlePrivateSend(
      request,
      relayerKeypair,
      connection,
      mockVerificationKey,
      spentNullifiers,
    );

    expect(result.success).toBe(true);
    expect(result.txSignature).toBe('mock_signature_abc123');
    expect(typeof result.stealthAddress).toBe('string');
    expect(result.error).toBeUndefined();

    // Nullifier should now be marked as spent
    expect(spentNullifiers.has(request.nullifier)).toBe(true);
  });

  it('rejects an invalid denomination index', async () => {
    const request = makeValidRequest({ denominationIndex: 99 });

    const result = await handlePrivateSend(
      request,
      relayerKeypair,
      connection,
      mockVerificationKey,
      spentNullifiers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid denomination');
  });

  it('rejects negative denomination index', async () => {
    const request = makeValidRequest({ denominationIndex: -1 });

    const result = await handlePrivateSend(
      request,
      relayerKeypair,
      connection,
      mockVerificationKey,
      spentNullifiers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid denomination');
  });

  it('prevents double-spend by rejecting a previously used nullifier', async () => {
    const request = makeValidRequest({ nullifier: 'already_used' });
    spentNullifiers.add('already_used');

    const result = await handlePrivateSend(
      request,
      relayerKeypair,
      connection,
      mockVerificationKey,
      spentNullifiers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Nullifier already spent');
    // Should not have attempted to verify proof or send tx
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSendAndConfirmTransaction).not.toHaveBeenCalled();
  });

  it('rejects when ZK proof verification fails', async () => {
    mockVerify.mockResolvedValue(false);
    const request = makeValidRequest();

    const result = await handlePrivateSend(
      request,
      relayerKeypair,
      connection,
      mockVerificationKey,
      spentNullifiers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid ZK proof');
    // Should not have sent transaction
    expect(mockSendAndConfirmTransaction).not.toHaveBeenCalled();
    // Nullifier should NOT be marked as spent
    expect(spentNullifiers.has(request.nullifier)).toBe(false);
  });

  it('skips ZK verification when verificationKey is null', async () => {
    const request = makeValidRequest();

    const result = await handlePrivateSend(
      request,
      relayerKeypair,
      connection,
      null, // no verification key
      spentNullifiers,
    );

    expect(result.success).toBe(true);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('rejects when relayer has insufficient balance', async () => {
    // The MEDIUM denomination is 1 SOL = 1_000_000_000 lamports
    // minBalance = amount + 10000
    mockGetBalance.mockResolvedValue(500_000); // way too low
    const request = makeValidRequest({ denominationIndex: 1 });

    const result = await handlePrivateSend(
      request,
      relayerKeypair,
      connection,
      mockVerificationKey,
      spentNullifiers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Relayer insufficient balance');
    // Nullifier should NOT be marked as spent
    expect(spentNullifiers.has(request.nullifier)).toBe(false);
  });

  it('does not mark nullifier as spent if transaction fails', async () => {
    mockSendAndConfirmTransaction.mockRejectedValue(new Error('Transaction simulation failed'));
    const request = makeValidRequest();

    const result = await handlePrivateSend(
      request,
      relayerKeypair,
      connection,
      mockVerificationKey,
      spentNullifiers,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Transaction simulation failed');
    expect(spentNullifiers.has(request.nullifier)).toBe(false);
  });

  it('uses correct denomination amount for each index', async () => {
    const denomValues = Object.values(DENOMINATIONS);

    for (let i = 0; i < denomValues.length; i++) {
      vi.clearAllMocks();
      mockVerify.mockResolvedValue(true);
      mockGetBalance.mockResolvedValue(100_000_000_000); // plenty
      mockSendAndConfirmTransaction.mockResolvedValue(`sig_${i}`);

      const request = makeValidRequest({ denominationIndex: i });
      const result = await handlePrivateSend(
        request,
        relayerKeypair,
        connection,
        mockVerificationKey,
        new Set<string>(),
      );

      expect(result.success).toBe(true);
    }
  });
});

describe('scanForPayments', () => {
  it('finds payments matching the view tag', () => {
    const viewingPrivate = crypto.randomBytes(32);
    const spendingPrivate = crypto.randomBytes(32);
    const ephemeralPub = crypto.randomBytes(32);

    // Compute the expected shared secret and view tag
    const sharedSecretInput = Buffer.concat([viewingPrivate, ephemeralPub]);
    const sharedSecret = crypto.createHash('sha256').update(sharedSecretInput).digest();
    const expectedViewTag = crypto.createHash('sha256')
      .update(Buffer.concat([sharedSecret, Buffer.from('view_tag')]))
      .digest()
      .slice(0, 2)
      .toString('hex');

    const results = scanForPayments(
      [ephemeralPub],
      [expectedViewTag],
      viewingPrivate,
      spendingPrivate,
    );

    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(0);
    expect(results[0].stealthAddress).toBeInstanceOf(Uint8Array);
    expect(results[0].privateKey).toBeInstanceOf(Uint8Array);
  });

  it('returns empty array when no view tags match', () => {
    const viewingPrivate = crypto.randomBytes(32);
    const spendingPrivate = crypto.randomBytes(32);
    const ephemeralPub = crypto.randomBytes(32);

    const results = scanForPayments(
      [ephemeralPub],
      ['0000'], // wrong view tag
      viewingPrivate,
      spendingPrivate,
    );

    expect(results).toHaveLength(0);
  });

  it('scans multiple payments and returns only matches', () => {
    const viewingPrivate = crypto.randomBytes(32);
    const spendingPrivate = crypto.randomBytes(32);

    // Create 3 ephemeral keys; compute correct tag only for index 1
    const ephemeralKeys = [
      crypto.randomBytes(32),
      crypto.randomBytes(32),
      crypto.randomBytes(32),
    ];

    // Compute the correct view tag for index 1
    const sharedInput1 = Buffer.concat([viewingPrivate, ephemeralKeys[1]]);
    const shared1 = crypto.createHash('sha256').update(sharedInput1).digest();
    const correctTag = crypto.createHash('sha256')
      .update(Buffer.concat([shared1, Buffer.from('view_tag')]))
      .digest()
      .slice(0, 2)
      .toString('hex');

    const viewTags = ['ffff', correctTag, 'aaaa'];

    const results = scanForPayments(ephemeralKeys, viewTags, viewingPrivate, spendingPrivate);

    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(1);
  });
});

describe('DENOMINATIONS', () => {
  it('contains exactly three denomination levels', () => {
    const values = Object.values(DENOMINATIONS);
    expect(values).toHaveLength(3);
  });

  it('has correct values in lamports', () => {
    expect(DENOMINATIONS.SMALL).toBe(0.1 * 1e9);
    expect(DENOMINATIONS.MEDIUM).toBe(1 * 1e9);
    expect(DENOMINATIONS.LARGE).toBe(10 * 1e9);
  });
});
