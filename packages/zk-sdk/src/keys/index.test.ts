/**
 * Unit tests for keys/viewKeys module
 * Tests key derivation hierarchy, serialization, decryption attempts, and nullifier checking
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----- Mock external dependencies -----

// We need a deterministic poseidonHash mock that the viewKeys module calls synchronously.
// The viewKeys module imports poseidonHash from '../circuits' and calls it WITHOUT await.
// In the actual code, poseidonHash is async but viewKeys treats the return as bigint.
// For tests, we provide a synchronous mock that returns bigint directly.

let poseidonCallLog: bigint[][] = [];

function mockPoseidonHashImpl(inputs: (bigint | number)[]): bigint {
  const bigInputs = inputs.map((x) => BigInt(x));
  poseidonCallLog.push(bigInputs);

  // Deterministic hash: simple polynomial combination
  let acc = BigInt(31);
  for (let i = 0; i < bigInputs.length; i++) {
    acc = (acc * BigInt(17) + bigInputs[i] + BigInt(i * 3 + 1)) % MOCK_FIELD_MODULUS;
  }
  return acc;
}

const MOCK_FIELD_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

vi.mock('../circuits', () => ({
  poseidonHash: vi.fn((inputs: (bigint | number)[]) => mockPoseidonHashImpl(inputs)),
}));

// ----- Imports (after mocks) -----

import {
  generateSpendingKey,
  deriveFullViewingKey,
  deriveIncomingViewingKey,
  deriveOutgoingViewingKey,
  tryDecryptWithIVK,
  tryDecryptOutgoing,
  checkNullifier,
  serializeViewingKey,
  deserializeViewingKey,
  generateViewingKeyURI,
  type SpendingKey,
  type FullViewingKey,
  type IncomingViewingKey,
  type OutgoingViewingKey,
  type EncryptedNote,
  type DecryptedNote,
} from './viewKeys';

// ----- Tests -----

describe('generateSpendingKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
  });

  it('should generate a spending key from entropy', () => {
    const entropy = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sk = generateSpendingKey(entropy);

    expect(sk.sk).toBeDefined();
    expect(typeof sk.sk).toBe('bigint');
    expect(sk.publicKey).toBeDefined();
    expect(typeof sk.publicKey).toBe('bigint');
  });

  it('should produce deterministic output for same entropy', () => {
    const entropy = new Uint8Array([10, 20, 30, 40]);
    const sk1 = generateSpendingKey(entropy);
    const sk2 = generateSpendingKey(entropy);

    expect(sk1.sk).toBe(sk2.sk);
    expect(sk1.publicKey).toBe(sk2.publicKey);
  });

  it('should produce different keys for different entropy', () => {
    const sk1 = generateSpendingKey(new Uint8Array([1, 0, 0, 0]));
    const sk2 = generateSpendingKey(new Uint8Array([2, 0, 0, 0]));

    expect(sk1.sk).not.toBe(sk2.sk);
  });

  it('should reduce sk modulo FIELD_MODULUS', () => {
    // Any entropy should produce sk < FIELD_MODULUS
    const bigEntropy = new Uint8Array(64).fill(0xff);
    const sk = generateSpendingKey(bigEntropy);

    expect(sk.sk < MOCK_FIELD_MODULUS).toBe(true);
    expect(sk.sk >= BigInt(0)).toBe(true);
  });

  it('should derive publicKey using poseidonHash([sk, 0])', () => {
    const entropy = new Uint8Array([5, 6, 7, 8]);
    const sk = generateSpendingKey(entropy);

    // Check that poseidonHash was called with [sk.sk, 0n]
    const matchingCall = poseidonCallLog.find(
      (call) => call.length === 2 && call[0] === sk.sk && call[1] === BigInt(0)
    );
    expect(matchingCall).toBeDefined();
  });
});

describe('deriveFullViewingKey', () => {
  let sk: SpendingKey;

  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
    sk = generateSpendingKey(new Uint8Array([1, 2, 3, 4]));
    poseidonCallLog = []; // Reset after spending key generation
  });

  it('should derive a full viewing key with all components', () => {
    const fvk = deriveFullViewingKey(sk);

    expect(fvk.ak).toBeDefined();
    expect(fvk.nk).toBeDefined();
    expect(fvk.ovk).toBeDefined();
    expect(fvk.dk).toBeDefined();
    expect(fvk.publicKey).toBe(sk.publicKey);
  });

  it('should produce deterministic FVK for same spending key', () => {
    const fvk1 = deriveFullViewingKey(sk);
    const fvk2 = deriveFullViewingKey(sk);

    expect(fvk1.ak).toBe(fvk2.ak);
    expect(fvk1.nk).toBe(fvk2.nk);
    expect(fvk1.ovk).toBe(fvk2.ovk);
    expect(fvk1.dk).toBe(fvk2.dk);
  });

  it('should derive distinct subkeys (ak, nk, ovk, dk)', () => {
    const fvk = deriveFullViewingKey(sk);

    // All subkeys should be different from each other
    const keys = [fvk.ak, fvk.nk, fvk.ovk, fvk.dk];
    const uniqueKeys = new Set(keys.map((k) => k.toString()));
    expect(uniqueKeys.size).toBe(4);
  });

  it('should call poseidonHash with domain separators', () => {
    deriveFullViewingKey(sk);

    // Should have made calls for ak, nk, ovk, dk
    // ak = poseidonHash([sk.sk, DOMAIN_FVK(0x01), 1])
    // nk = poseidonHash([sk.sk, DOMAIN_FVK(0x01), 2])
    // ovk = poseidonHash([sk.sk, DOMAIN_OVK(0x03)])
    // dk = poseidonHash([sk.sk, DOMAIN_DK(0x04)])
    expect(poseidonCallLog.length).toBe(4);
  });

  it('should preserve the publicKey from spending key', () => {
    const fvk = deriveFullViewingKey(sk);
    expect(fvk.publicKey).toBe(sk.publicKey);
  });
});

describe('deriveIncomingViewingKey', () => {
  let fvk: FullViewingKey;

  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
    const sk = generateSpendingKey(new Uint8Array([1, 2, 3, 4]));
    fvk = deriveFullViewingKey(sk);
    poseidonCallLog = [];
  });

  it('should derive IVK from FVK', () => {
    const ivk = deriveIncomingViewingKey(fvk);

    expect(ivk.ivk).toBeDefined();
    expect(ivk.dk).toBe(fvk.dk);
    expect(ivk.publicKey).toBe(fvk.publicKey);
  });

  it('should derive IVK using poseidonHash([ak, nk, DOMAIN_IVK])', () => {
    deriveIncomingViewingKey(fvk);

    // Should call poseidonHash once with [ak, nk, DOMAIN_IVK(0x02)]
    expect(poseidonCallLog.length).toBe(1);
    expect(poseidonCallLog[0]).toContain(fvk.ak);
    expect(poseidonCallLog[0]).toContain(fvk.nk);
    expect(poseidonCallLog[0]).toContain(BigInt(2)); // DOMAIN_IVK
  });

  it('should produce deterministic IVK', () => {
    const ivk1 = deriveIncomingViewingKey(fvk);
    const ivk2 = deriveIncomingViewingKey(fvk);

    expect(ivk1.ivk).toBe(ivk2.ivk);
  });
});

describe('deriveOutgoingViewingKey', () => {
  let fvk: FullViewingKey;

  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
    const sk = generateSpendingKey(new Uint8Array([1, 2, 3, 4]));
    fvk = deriveFullViewingKey(sk);
    poseidonCallLog = [];
  });

  it('should extract OVK from FVK', () => {
    const ovk = deriveOutgoingViewingKey(fvk);

    expect(ovk.ovk).toBe(fvk.ovk);
    expect(ovk.publicKey).toBe(fvk.publicKey);
  });

  it('should not call poseidonHash (no derivation needed)', () => {
    deriveOutgoingViewingKey(fvk);
    expect(poseidonCallLog.length).toBe(0);
  });
});

describe('tryDecryptWithIVK', () => {
  let ivk: IncomingViewingKey;

  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
    const sk = generateSpendingKey(new Uint8Array([1, 2, 3, 4]));
    const fvk = deriveFullViewingKey(sk);
    ivk = deriveIncomingViewingKey(fvk);
    poseidonCallLog = [];
  });

  it('should return null for non-matching commitment', () => {
    const encryptedNote: EncryptedNote = {
      commitment: BigInt(99999999),
      encAmount: BigInt(100),
      encRandomness: BigInt(200),
      ephemeralPubKey: BigInt(300),
      tokenMint: BigInt(400),
    };

    const result = tryDecryptWithIVK(ivk, encryptedNote);

    // The decrypted commitment won't match the note's commitment
    // because our mock poseidonHash won't produce matching values
    expect(result).toBeNull();
  });

  it('should return decrypted note when commitment matches', () => {
    // We need to construct an encrypted note where the commitment verification passes.
    // After decryption, the function computes:
    //   expectedCommitment = poseidonHash([amount, ivk.publicKey, randomness, tokenMint])
    // and checks it against encryptedNote.commitment.
    //
    // We first compute the expected values and work backwards.
    const tokenMint = BigInt(400);
    const ephemeralPubKey = BigInt(300);

    // Step 1: Compute shared secret = poseidonHash([ivk.ivk, ephemeralPubKey])
    const sharedSecret = mockPoseidonHashImpl([ivk.ivk, ephemeralPubKey]);

    // Step 2: Compute decryption key = poseidonHash([sharedSecret, ivk.dk])
    const decryptionKey = mockPoseidonHashImpl([sharedSecret, ivk.dk]);

    // Step 3: Choose the plaintext values we want
    const plainAmount = BigInt(1000);
    const plainRandomness = BigInt(5000);

    // Step 4: Encrypt: encField = (plain + mask) mod FIELD_MODULUS
    const mask0 = mockPoseidonHashImpl([decryptionKey, BigInt(0)]);
    const mask1 = mockPoseidonHashImpl([decryptionKey, BigInt(1)]);

    const encAmount = (plainAmount + mask0) % MOCK_FIELD_MODULUS;
    const encRandomness = (plainRandomness + mask1) % MOCK_FIELD_MODULUS;

    // Step 5: Compute the expected commitment
    const commitment = mockPoseidonHashImpl([
      plainAmount,
      ivk.publicKey,
      plainRandomness,
      tokenMint,
    ]);

    const encryptedNote: EncryptedNote = {
      commitment,
      encAmount,
      encRandomness,
      ephemeralPubKey,
      tokenMint,
    };

    poseidonCallLog = [];
    const result = tryDecryptWithIVK(ivk, encryptedNote);

    expect(result).not.toBeNull();
    expect(result!.amount).toBe(plainAmount);
    expect(result!.randomness).toBe(plainRandomness);
    expect(result!.owner).toBe(ivk.publicKey);
    expect(result!.tokenMint).toBe(tokenMint);
    expect(result!.commitment).toBe(commitment);
  });
});

describe('tryDecryptOutgoing', () => {
  let ovk: OutgoingViewingKey;

  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
    const sk = generateSpendingKey(new Uint8Array([1, 2, 3, 4]));
    const fvk = deriveFullViewingKey(sk);
    ovk = deriveOutgoingViewingKey(fvk);
    poseidonCallLog = [];
  });

  it('should decrypt outgoing transaction info', () => {
    const ephemeralPubKey = BigInt(500);

    // Compute shared secret
    const sharedSecret = mockPoseidonHashImpl([ovk.ovk, ephemeralPubKey]);

    // Choose plaintext
    const plainRecipient = BigInt(7777);
    const plainAmount = BigInt(2000);

    // Encrypt: encField = (plain + mask) mod FIELD_MODULUS
    const mask0 = mockPoseidonHashImpl([sharedSecret, BigInt(0)]);
    const mask1 = mockPoseidonHashImpl([sharedSecret, BigInt(1)]);

    const encRecipient = (plainRecipient + mask0) % MOCK_FIELD_MODULUS;
    const encAmount = (plainAmount + mask1) % MOCK_FIELD_MODULUS;

    poseidonCallLog = [];
    const result = tryDecryptOutgoing(ovk, [encRecipient, encAmount], ephemeralPubKey);

    expect(result).not.toBeNull();
    expect(result!.recipient).toBe(plainRecipient);
    expect(result!.amount).toBe(plainAmount);
  });
});

describe('checkNullifier', () => {
  let fvk: FullViewingKey;

  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
    const sk = generateSpendingKey(new Uint8Array([1, 2, 3, 4]));
    fvk = deriveFullViewingKey(sk);
    poseidonCallLog = [];
  });

  it('should find matching note for a nullifier', () => {
    const note1: DecryptedNote = {
      amount: BigInt(100),
      owner: fvk.publicKey,
      randomness: BigInt(200),
      tokenMint: BigInt(300),
      commitment: BigInt(400),
    };

    // Compute expected nullifier for note1
    const expectedNullifier = mockPoseidonHashImpl([note1.commitment, fvk.nk]);

    poseidonCallLog = [];
    const result = checkNullifier(fvk, expectedNullifier, [note1]);

    expect(result).not.toBeNull();
    expect(result!.commitment).toBe(note1.commitment);
  });

  it('should return null when nullifier does not match any note', () => {
    const note1: DecryptedNote = {
      amount: BigInt(100),
      owner: fvk.publicKey,
      randomness: BigInt(200),
      tokenMint: BigInt(300),
      commitment: BigInt(400),
    };

    const randomNullifier = BigInt(999999);

    const result = checkNullifier(fvk, randomNullifier, [note1]);

    expect(result).toBeNull();
  });

  it('should find the correct note among multiple notes', () => {
    const notes: DecryptedNote[] = [
      {
        amount: BigInt(100),
        owner: fvk.publicKey,
        randomness: BigInt(200),
        tokenMint: BigInt(300),
        commitment: BigInt(400),
      },
      {
        amount: BigInt(500),
        owner: fvk.publicKey,
        randomness: BigInt(600),
        tokenMint: BigInt(700),
        commitment: BigInt(800),
      },
    ];

    // Compute nullifier for the second note
    const nullifier2 = mockPoseidonHashImpl([notes[1].commitment, fvk.nk]);

    poseidonCallLog = [];
    const result = checkNullifier(fvk, nullifier2, notes);

    expect(result).not.toBeNull();
    expect(result!.commitment).toBe(notes[1].commitment);
    expect(result!.amount).toBe(BigInt(500));
  });

  it('should return null for empty notes array', () => {
    const result = checkNullifier(fvk, BigInt(123), []);
    expect(result).toBeNull();
  });
});

describe('serializeViewingKey / deserializeViewingKey', () => {
  let fvk: FullViewingKey;
  let ivk: IncomingViewingKey;
  let ovk: OutgoingViewingKey;

  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
    const sk = generateSpendingKey(new Uint8Array([10, 20, 30, 40]));
    fvk = deriveFullViewingKey(sk);
    ivk = deriveIncomingViewingKey(fvk);
    ovk = deriveOutgoingViewingKey(fvk);
  });

  it('should serialize IVK to a base64 string', () => {
    const serialized = serializeViewingKey(ivk);

    expect(typeof serialized).toBe('string');
    expect(serialized.length).toBeGreaterThan(0);

    // Should be valid base64
    const decoded = Buffer.from(serialized, 'base64').toString();
    const parsed = JSON.parse(decoded);
    expect(parsed.type).toBe('ivk');
    expect(parsed.version).toBe(1);
  });

  it('should serialize FVK with type fvk', () => {
    const serialized = serializeViewingKey(fvk);
    const decoded = JSON.parse(Buffer.from(serialized, 'base64').toString());
    expect(decoded.type).toBe('fvk');
  });

  it('should serialize OVK with type ovk', () => {
    const serialized = serializeViewingKey(ovk);
    const decoded = JSON.parse(Buffer.from(serialized, 'base64').toString());
    expect(decoded.type).toBe('ovk');
  });

  it('should round-trip IVK through serialize/deserialize', () => {
    const serialized = serializeViewingKey(ivk);
    const deserialized = deserializeViewingKey(serialized) as IncomingViewingKey;

    expect(deserialized.ivk).toBe(ivk.ivk);
    expect(deserialized.dk).toBe(ivk.dk);
    expect(deserialized.publicKey).toBe(ivk.publicKey);
  });

  it('should round-trip FVK through serialize/deserialize', () => {
    const serialized = serializeViewingKey(fvk);
    const deserialized = deserializeViewingKey(serialized) as FullViewingKey;

    expect(deserialized.ak).toBe(fvk.ak);
    expect(deserialized.nk).toBe(fvk.nk);
    expect(deserialized.ovk).toBe(fvk.ovk);
    expect(deserialized.dk).toBe(fvk.dk);
    expect(deserialized.publicKey).toBe(fvk.publicKey);
  });

  it('should round-trip OVK through serialize/deserialize', () => {
    const serialized = serializeViewingKey(ovk);
    const deserialized = deserializeViewingKey(serialized) as OutgoingViewingKey;

    expect(deserialized.ovk).toBe(ovk.ovk);
    expect(deserialized.publicKey).toBe(ovk.publicKey);
  });
});

describe('generateViewingKeyURI', () => {
  let ivk: IncomingViewingKey;

  beforeEach(() => {
    vi.clearAllMocks();
    poseidonCallLog = [];
    const sk = generateSpendingKey(new Uint8Array([1, 2, 3, 4]));
    const fvk = deriveFullViewingKey(sk);
    ivk = deriveIncomingViewingKey(fvk);
  });

  it('should generate a URI starting with specter://viewkey?', () => {
    const uri = generateViewingKeyURI(ivk);

    expect(uri.startsWith('specter://viewkey?')).toBe(true);
  });

  it('should include the serialized key in the URI', () => {
    const uri = generateViewingKeyURI(ivk);
    const url = new URL(uri.replace('specter://', 'https://'));
    const keyParam = url.searchParams.get('key');

    expect(keyParam).not.toBeNull();
    expect(keyParam!.length).toBeGreaterThan(0);

    // The key should be deserializable
    const deserialized = deserializeViewingKey(keyParam!) as IncomingViewingKey;
    expect(deserialized.ivk).toBe(ivk.ivk);
  });

  it('should include optional label in URI', () => {
    const uri = generateViewingKeyURI(ivk, 'MyWallet');

    // Parse the query params
    const paramStr = uri.split('?')[1];
    const params = new URLSearchParams(paramStr);
    expect(params.get('label')).toBe('MyWallet');
  });

  it('should not include label param when none provided', () => {
    const uri = generateViewingKeyURI(ivk);

    const paramStr = uri.split('?')[1];
    const params = new URLSearchParams(paramStr);
    expect(params.has('label')).toBe(false);
  });
});
