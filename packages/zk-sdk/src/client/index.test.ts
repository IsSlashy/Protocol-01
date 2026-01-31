/**
 * Unit tests for ShieldedClient
 * Tests initialization, address encoding/decoding, balance, note scanning,
 * and transaction flows (shield, transfer, unshield) with mocked blockchain calls
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----- Hoisted mock variables (available to vi.mock factories) -----

const {
  MockPublicKey,
  MockNote,
  mockConnection,
  mockTransaction,
  mockCreateNote,
  mockEncryptNote,
  mockDecryptNote,
  mockGenerateSpendingKeyPair,
  mockMerkleInsert,
  mockMerkleGenerateProof,
  mockMerkleInitialize,
  mockProverInitialize,
  mockProverGenerateTransferProof,
} = vi.hoisted(() => {
  // Minimal PublicKey mock
  class MockPublicKey {
    _bytes: Uint8Array;
    constructor(input: string | Uint8Array) {
      if (typeof input === 'string') {
        this._bytes = new Uint8Array(32);
        for (let i = 0; i < Math.min(input.length, 32); i++) {
          this._bytes[i] = input.charCodeAt(i);
        }
      } else {
        this._bytes = new Uint8Array(input);
      }
    }
    toBytes(): Uint8Array {
      return this._bytes;
    }
    get publicKey(): MockPublicKey {
      return this;
    }
    static findProgramAddressSync(seeds: Uint8Array[], programId: any): [MockPublicKey, number] {
      return [new MockPublicKey('derived-pda'), 255];
    }
  }

  class MockNote {
    amount: bigint;
    ownerPubkey: bigint;
    randomness: bigint;
    tokenMint: bigint;
    commitment: bigint;
    leafIndex?: number;

    constructor(data: any) {
      this.amount = data.amount;
      this.ownerPubkey = data.ownerPubkey;
      this.randomness = data.randomness;
      this.tokenMint = data.tokenMint;
      this.commitment = data.commitment;
      this.leafIndex = data.leafIndex;
    }

    toJSON() {
      return {
        amount: this.amount,
        ownerPubkey: this.ownerPubkey,
        randomness: this.randomness,
        tokenMint: this.tokenMint,
        commitment: this.commitment,
        leafIndex: this.leafIndex,
      };
    }
  }

  return {
    MockPublicKey,
    MockNote,
    mockConnection: {
      getLatestBlockhash: vi.fn(),
      sendRawTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
    },
    mockTransaction: {
      add: vi.fn().mockReturnThis(),
      feePayer: null as any,
      recentBlockhash: null as any,
    },
    mockCreateNote: vi.fn(),
    mockEncryptNote: vi.fn(),
    mockDecryptNote: vi.fn(),
    mockGenerateSpendingKeyPair: vi.fn(),
    mockMerkleInsert: vi.fn(),
    mockMerkleGenerateProof: vi.fn(),
    mockMerkleInitialize: vi.fn(),
    mockProverInitialize: vi.fn(),
    mockProverGenerateTransferProof: vi.fn(),
  };
});

// ----- Mock external dependencies -----

vi.mock('@solana/web3.js', () => ({
  Connection: vi.fn(() => mockConnection),
  PublicKey: MockPublicKey,
  Transaction: vi.fn(() => mockTransaction),
  TransactionInstruction: vi.fn((params: any) => ({ ...params })),
  SystemProgram: { programId: new MockPublicKey('system-program') },
  Keypair: { generate: vi.fn() },
}));

vi.mock('@coral-xyz/anchor', () => ({
  Program: vi.fn(),
  AnchorProvider: vi.fn(),
  Wallet: vi.fn(),
  BN: vi.fn((n: any) => ({ toNumber: () => Number(n) })),
}));

vi.mock('../notes', () => ({
  createNote: (...args: any[]) => mockCreateNote(...args),
  Note: MockNote,
  EncryptedNote: vi.fn(),
  encryptNote: (...args: any[]) => mockEncryptNote(...args),
  decryptNote: (...args: any[]) => mockDecryptNote(...args),
  generateSpendingKeyPair: (...args: any[]) => mockGenerateSpendingKeyPair(...args),
}));

vi.mock('../merkle', () => {
  return {
    MerkleTree: vi.fn().mockImplementation(() => ({
      initialize: mockMerkleInitialize,
      insert: mockMerkleInsert,
      generateProof: mockMerkleGenerateProof,
      get root() {
        return BigInt(123456789);
      },
      get leafCount() {
        return 0;
      },
    })),
    generateMerkleProof: vi.fn(),
  };
});

vi.mock('../prover', () => ({
  ZkProver: vi.fn().mockImplementation(() => ({
    initialize: mockProverInitialize,
    generateTransferProof: mockProverGenerateTransferProof,
  })),
}));

vi.mock('../circuits', () => ({
  computeCommitment: vi.fn(async () => BigInt(42)),
  computeNullifier: vi.fn(async () => BigInt(99)),
  deriveOwnerPubkey: vi.fn(async () => BigInt(777)),
  fieldToBytes: vi.fn((field: bigint) => {
    const bytes = new Uint8Array(32);
    let v = field;
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number(v & BigInt(0xff));
      v >>= BigInt(8);
    }
    return bytes;
  }),
  bytesToField: vi.fn((bytes: Uint8Array) => {
    let result = BigInt(0);
    for (let i = bytes.length - 1; i >= 0; i--) {
      result = (result << BigInt(8)) | BigInt(bytes[i]);
    }
    return result;
  }),
  pubkeyToField: vi.fn((pubkey: Uint8Array) => {
    let result = BigInt(0);
    for (let i = pubkey.length - 1; i >= 0; i--) {
      result = (result << BigInt(8)) | BigInt(pubkey[i]);
    }
    return result;
  }),
  randomFieldElement: vi.fn(() => BigInt(12345)),
}));

// ----- Imports (after mocks) -----

import { ShieldedClient, type ShieldedClientConfig } from './index';
import { MERKLE_TREE_DEPTH } from '../constants';

// ----- Helpers -----

function createMockWallet() {
  return {
    publicKey: new MockPublicKey('test-wallet-pubkey'),
    signTransaction: vi.fn(async (tx: any) => ({
      serialize: () => new Uint8Array([1, 2, 3]),
    })),
    signAllTransactions: vi.fn(),
    payer: { publicKey: new MockPublicKey('test-wallet-pubkey') } as any,
  };
}

function createClientConfig(overrides?: Partial<ShieldedClientConfig>): ShieldedClientConfig {
  return {
    connection: mockConnection as any,
    wallet: createMockWallet() as any,
    ...overrides,
  };
}

// ----- Tests -----

describe('ShieldedClient', () => {
  let noteIdCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    noteIdCounter = 0;

    // Default mock behaviors
    mockGenerateSpendingKeyPair.mockResolvedValue({
      spendingKey: BigInt(111),
      ownerPubkey: BigInt(222),
      spendingKeyHash: BigInt(333),
    });

    mockMerkleInitialize.mockResolvedValue(undefined);
    mockProverInitialize.mockResolvedValue(undefined);
    mockMerkleInsert.mockImplementation(() => noteIdCounter++);

    mockConnection.getLatestBlockhash.mockResolvedValue({
      blockhash: 'test-blockhash',
      lastValidBlockHeight: 100,
    });
    mockConnection.sendRawTransaction.mockResolvedValue('test-signature');
    mockConnection.confirmTransaction.mockResolvedValue({ value: {} });

    mockCreateNote.mockImplementation(
      async (amount: bigint, owner: bigint, tokenMint: bigint) => {
        return new MockNote({
          amount,
          ownerPubkey: owner,
          randomness: BigInt(999),
          tokenMint,
          commitment: BigInt(42000 + noteIdCounter),
        });
      }
    );

    mockProverGenerateTransferProof.mockResolvedValue({
      proof: {
        pi_a: new Uint8Array(64),
        pi_b: new Uint8Array(128),
        pi_c: new Uint8Array(64),
      },
      publicSignals: ['1', '2', '3'],
    });

    mockMerkleGenerateProof.mockReturnValue({
      pathIndices: new Array(MERKLE_TREE_DEPTH).fill(0),
      pathElements: new Array(MERKLE_TREE_DEPTH).fill(BigInt(0)),
      leafIndex: 0,
    });
  });

  describe('constructor', () => {
    it('should create client with required config', () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      expect(client).toBeDefined();
    });

    it('should accept optional wasmPath and zkeyPath', () => {
      const config = createClientConfig({
        wasmPath: '/path/to/circuit.wasm',
        zkeyPath: '/path/to/circuit.zkey',
      });
      const client = new ShieldedClient(config);
      expect(client).toBeDefined();
    });

    it('should accept optional tokenMint', () => {
      const config = createClientConfig({
        tokenMint: new MockPublicKey('custom-token-mint') as any,
      });
      const client = new ShieldedClient(config);
      expect(client).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should initialize spending key pair from seed phrase', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      await client.initialize('test seed phrase');

      expect(mockGenerateSpendingKeyPair).toHaveBeenCalled();
    });

    it('should initialize merkle tree', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      await client.initialize('test seed phrase');

      expect(mockMerkleInitialize).toHaveBeenCalled();
    });

    it('should initialize prover', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      await client.initialize('test seed phrase');

      expect(mockProverInitialize).toHaveBeenCalled();
    });

    it('should encode seed phrase to Uint8Array for key derivation', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      await client.initialize('my secret seed');

      const call = mockGenerateSpendingKeyPair.mock.calls[0];
      expect(call[0]).toBeInstanceOf(Uint8Array);
    });
  });

  describe('getZkAddress', () => {
    it('should throw if not initialized', () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      expect(() => client.getZkAddress()).toThrow('Client not initialized');
    });

    it('should return ZkAddress after initialization', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      const addr = client.getZkAddress();

      expect(addr.receivingPubkey).toBe(BigInt(222));
      expect(addr.viewingKey).toBeInstanceOf(Uint8Array);
      expect(addr.viewingKey.length).toBe(32);
      expect(typeof addr.encoded).toBe('string');
    });

    it('should produce encoded address starting with zk:', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      const addr = client.getZkAddress();

      expect(addr.encoded.startsWith('zk:')).toBe(true);
    });
  });

  describe('decodeZkAddress (static)', () => {
    it('should decode a valid zk: address', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      const originalAddr = client.getZkAddress();
      const decoded = ShieldedClient.decodeZkAddress(originalAddr.encoded);

      expect(decoded.receivingPubkey).toBe(originalAddr.receivingPubkey);
      expect(new Uint8Array(decoded.viewingKey)).toEqual(new Uint8Array(originalAddr.viewingKey));
      expect(decoded.encoded).toBe(originalAddr.encoded);
    });

    it('should throw for invalid address format', () => {
      expect(() => ShieldedClient.decodeZkAddress('invalid-address')).toThrow(
        'Invalid ZK address format'
      );
    });

    it('should throw for address not starting with zk:', () => {
      expect(() => ShieldedClient.decodeZkAddress('pk:something')).toThrow(
        'Invalid ZK address format'
      );
    });
  });

  describe('getShieldedBalance', () => {
    it('should return 0 with no notes', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      const balance = await client.getShieldedBalance();

      expect(balance).toBe(BigInt(0));
    });

    it('should return total balance after shielding', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(1000));
      const balance = await client.getShieldedBalance();

      expect(balance).toBe(BigInt(1000));
    });

    it('should sum multiple shielded amounts', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(1000));
      await client.shield(BigInt(2000));

      const balance = await client.getShieldedBalance();

      expect(balance).toBe(BigInt(3000));
    });
  });

  describe('shield', () => {
    it('should throw if not initialized', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      await expect(client.shield(BigInt(100))).rejects.toThrow('Client not initialized');
    });

    it('should create a note with the specified amount', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(5000));

      expect(mockCreateNote).toHaveBeenCalledWith(
        BigInt(5000),
        BigInt(222), // ownerPubkey from mock
        expect.any(BigInt)
      );
    });

    it('should insert the note commitment into the merkle tree', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(5000));

      expect(mockMerkleInsert).toHaveBeenCalled();
    });

    it('should send a transaction', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(5000));

      expect(mockConnection.sendRawTransaction).toHaveBeenCalled();
      expect(mockConnection.confirmTransaction).toHaveBeenCalled();
    });

    it('should return a ShieldedTxResult', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      const result = await client.shield(BigInt(5000));

      expect(result.signature).toBe('test-signature');
      expect(result.newCommitments.length).toBe(1);
      expect(result.nullifiersSpent.length).toBe(0); // Shield has no nullifiers
      expect(result.newRoot).toBeInstanceOf(Uint8Array);
    });
  });

  describe('transfer', () => {
    it('should throw if not initialized', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      const recipient = {
        receivingPubkey: BigInt(9999),
        viewingKey: new Uint8Array(32),
        encoded: 'zk:test',
      };

      await expect(client.transfer(recipient, BigInt(100))).rejects.toThrow(
        'Client not initialized'
      );
    });

    it('should throw if insufficient balance', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      const recipient = {
        receivingPubkey: BigInt(9999),
        viewingKey: new Uint8Array(32),
        encoded: 'zk:test',
      };

      await expect(client.transfer(recipient, BigInt(100))).rejects.toThrow(
        'Insufficient shielded balance'
      );
    });

    it('should generate a ZK proof for the transfer', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      // Shield some funds first
      await client.shield(BigInt(10000));

      const recipient = {
        receivingPubkey: BigInt(9999),
        viewingKey: new Uint8Array(32),
        encoded: 'zk:test',
      };

      await client.transfer(recipient, BigInt(5000));

      expect(mockProverGenerateTransferProof).toHaveBeenCalled();
    });

    it('should return a ShieldedTxResult with nullifiers', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(10000));

      const recipient = {
        receivingPubkey: BigInt(9999),
        viewingKey: new Uint8Array(32),
        encoded: 'zk:test',
      };

      const result = await client.transfer(recipient, BigInt(5000));

      expect(result.signature).toBe('test-signature');
      expect(result.newCommitments.length).toBe(2); // recipient + change
      expect(result.nullifiersSpent.length).toBe(2);
    });

    it('should create two output notes (recipient + change)', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(10000));

      const recipient = {
        receivingPubkey: BigInt(9999),
        viewingKey: new Uint8Array(32),
        encoded: 'zk:test',
      };

      mockCreateNote.mockClear();

      await client.transfer(recipient, BigInt(3000));

      // createNote should be called twice: once for recipient, once for change
      const transferCalls = mockCreateNote.mock.calls;
      expect(transferCalls.length).toBe(2);

      // Recipient note: amount = 3000
      expect(transferCalls[0][0]).toBe(BigInt(3000));
      // Change note: amount = 7000
      expect(transferCalls[1][0]).toBe(BigInt(7000));
    });
  });

  describe('unshield', () => {
    it('should throw if not initialized', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);

      const recipient = new MockPublicKey('recipient') as any;

      await expect(client.unshield(recipient, BigInt(100))).rejects.toThrow(
        'Client not initialized'
      );
    });

    it('should throw if insufficient balance', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      const recipient = new MockPublicKey('recipient') as any;

      await expect(client.unshield(recipient, BigInt(100))).rejects.toThrow(
        'Insufficient shielded balance'
      );
    });

    it('should send transaction and return result', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(10000));

      const recipient = new MockPublicKey('recipient') as any;
      const result = await client.unshield(recipient, BigInt(5000));

      expect(result.signature).toBe('test-signature');
      expect(result.nullifiersSpent.length).toBe(2);
    });

    it('should create change note when partial withdrawal', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(10000));
      mockCreateNote.mockClear();

      const recipient = new MockPublicKey('recipient') as any;
      await client.unshield(recipient, BigInt(3000));

      // Should create a change note of 7000
      const changeCalls = mockCreateNote.mock.calls;
      expect(changeCalls.length).toBe(1); // Only change note
      expect(changeCalls[0][0]).toBe(BigInt(7000));
    });

    it('should not create change note for full withdrawal', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(10000));
      mockCreateNote.mockClear();

      // Mock so that createNote is not called at all for zero change
      const recipient = new MockPublicKey('recipient') as any;

      // We need the total note to exactly equal the withdrawal amount
      // Re-shield with exact amount
      await client.unshield(recipient, BigInt(10000));

      // No change note (changeAmount = 0)
      // The implementation checks `changeAmount > BigInt(0)` before creating change note
      // mockCreateNote should not be called since changeAmount = 0
      expect(mockCreateNote).not.toHaveBeenCalled();
    });
  });

  describe('scanForNotes', () => {
    it('should return local notes and balance', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      await client.shield(BigInt(1000));
      await client.shield(BigInt(2000));

      const result = await client.scanForNotes();

      expect(result.notes.length).toBe(2);
      expect(result.totalBalance).toBe(BigInt(3000));
    });

    it('should return empty result when no notes', async () => {
      const config = createClientConfig();
      const client = new ShieldedClient(config);
      await client.initialize('test seed');

      const result = await client.scanForNotes();

      expect(result.notes.length).toBe(0);
      expect(result.totalBalance).toBe(BigInt(0));
    });
  });
});
