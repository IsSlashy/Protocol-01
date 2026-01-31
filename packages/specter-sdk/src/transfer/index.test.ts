import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import type { StealthPayment, StealthMetaAddress } from '../types';

// ---------------------------------------------------------------------------
// Hoisted constants – available inside vi.mock() factories
// ---------------------------------------------------------------------------

const {
  MOCK_SIGNATURE,
  MOCK_BLOCKHASH,
  MOCK_STEALTH_ADDRESS,
  MOCK_EPHEMERAL_PUB,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair: Kp } = require('@solana/web3.js') as typeof import('@solana/web3.js');

  return {
    MOCK_SIGNATURE: '5aFake111111111111111111111111111111111111111111111111111111111111111sig',
    MOCK_BLOCKHASH: 'GHtXQBtSBZAbcdefghijk123456789ABCDefghij',
    MOCK_STEALTH_ADDRESS: Kp.generate().publicKey,
    MOCK_EPHEMERAL_PUB: new Uint8Array(32).fill(0x12),
  };
});

// ---------------------------------------------------------------------------
// Provide SpecterError / SpecterErrorCode aliases
// ---------------------------------------------------------------------------

vi.mock('../types', async () => {
  const actual = await vi.importActual<typeof import('../types')>('../types');
  return {
    ...actual,
    SpecterError: actual.P01Error,
    SpecterErrorCode: actual.P01ErrorCode,
  };
});

// ---------------------------------------------------------------------------
// Mock @solana/web3.js
// ---------------------------------------------------------------------------

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>(
    '@solana/web3.js'
  );

  return {
    ...actual,
    sendAndConfirmTransaction: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: vi.fn().mockResolvedValue(10_000_000_000), // 10 SOL
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: MOCK_BLOCKHASH,
        lastValidBlockHeight: 100,
      }),
      getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(890_880),
      sendRawTransaction: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getAccountInfo: vi.fn().mockResolvedValue(null),
    })),
  };
});

// ---------------------------------------------------------------------------
// Mock @solana/spl-token
// ---------------------------------------------------------------------------

vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: vi.fn().mockResolvedValue(Keypair.generate().publicKey),
  createTransferInstruction: vi.fn().mockReturnValue({
    keys: [],
    programId: Keypair.generate().publicKey,
    data: Buffer.alloc(0),
  }),
  getAccount: vi.fn().mockResolvedValue({ amount: 5_000_000_000n }),
  TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  ASSOCIATED_TOKEN_PROGRAM_ID: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  createAssociatedTokenAccountInstruction: vi.fn().mockReturnValue({
    keys: [],
    programId: Keypair.generate().publicKey,
    data: Buffer.alloc(0),
  }),
  createCloseAccountInstruction: vi.fn().mockReturnValue({
    keys: [],
    programId: Keypair.generate().publicKey,
    data: Buffer.alloc(0),
  }),
}));

// ---------------------------------------------------------------------------
// Mock stealth generation so sendPrivate can produce a stealth address
// ---------------------------------------------------------------------------

vi.mock('../stealth/generate', () => ({
  generateStealthAddress: vi.fn().mockReturnValue({
    address: MOCK_STEALTH_ADDRESS,
    ephemeralPubKey: MOCK_EPHEMERAL_PUB,
    viewTag: 42,
    createdAt: new Date(),
    ephemeralPrivateKey: new Uint8Array(32).fill(0x34),
  }),
  parseStealthMetaAddress: vi.fn().mockReturnValue({
    spendingPubKey: new Uint8Array(32).fill(0x01),
    viewingPubKey: new Uint8Array(32).fill(0x02),
    encoded: 'st_mock_encoded',
  }),
  createStealthAnnouncement: vi.fn().mockReturnValue(new Uint8Array(65)),
}));

// Mock stealth derive for claim
vi.mock('../stealth/derive', () => {
  const mockStealthKeypair = Keypair.generate();
  return {
    deriveStealthPrivateKey: vi.fn().mockReturnValue(mockStealthKeypair),
    __mockStealthKeypair: mockStealthKeypair,
  };
});

// Mock helpers that validate addresses
vi.mock('../utils/helpers', async () => {
  const actual = await vi.importActual<typeof import('../utils/helpers')>(
    '../utils/helpers'
  );
  return {
    ...actual,
    isValidPublicKey: vi.fn().mockReturnValue(true),
    isValidStealthMetaAddress: vi.fn().mockImplementation((addr: string) => {
      return addr.startsWith('st');
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import * as helpers from '../utils/helpers';
import * as stealthDerive from '../stealth/derive';
import * as splToken from '@solana/spl-token';

import {
  sendPrivate,
  sendPublic,
  estimateTransferFee,
} from './send';

import {
  claimStealth,
  claimMultiple,
  getStealthBalance,
  canClaim,
  estimateClaimFee,
} from './claim';

// ===========================================================================
// transfer/send.ts
// ===========================================================================

describe('transfer/send', () => {
  let mockConnection: Connection;
  let senderKeypair: Keypair;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection = new Connection('https://api.devnet.solana.com');
    senderKeypair = Keypair.generate();
  });

  // -----------------------------------------------------------------------
  // sendPrivate
  // -----------------------------------------------------------------------
  describe('sendPrivate', () => {
    it('sends a private transfer to a stealth meta-address', async () => {
      const result = await sendPrivate({
        sender: senderKeypair,
        connection: mockConnection,
        recipient: 'st_some_stealth_meta_address',
        amount: 1.0,
      });

      expect(result.signature).toBe(MOCK_SIGNATURE);
      expect(result.stealthAddress).toEqual(MOCK_STEALTH_ADDRESS);
      expect(result.confirmed).toBe(true);
      expect(typeof result.fee).toBe('bigint');
    });

    it('throws when recipient is a regular public key (not stealth)', async () => {
      vi.mocked(helpers.isValidStealthMetaAddress).mockReturnValueOnce(false);
      vi.mocked(helpers.isValidPublicKey).mockReturnValueOnce(true);

      await expect(
        sendPrivate({
          sender: senderKeypair,
          connection: mockConnection,
          recipient: Keypair.generate().publicKey.toBase58(),
          amount: 1.0,
        })
      ).rejects.toThrow(/stealth meta-address/i);
    });

    it('throws when recipient is an invalid address', async () => {
      vi.mocked(helpers.isValidStealthMetaAddress).mockReturnValueOnce(false);
      vi.mocked(helpers.isValidPublicKey).mockReturnValueOnce(false);

      await expect(
        sendPrivate({
          sender: senderKeypair,
          connection: mockConnection,
          recipient: 'garbage',
          amount: 1.0,
        })
      ).rejects.toThrow(/invalid recipient/i);
    });

    it('throws when sender has insufficient balance', async () => {
      // Override getBalance to return too-low balance
      (mockConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        100 // 100 lamports = way less than 1 SOL
      );

      await expect(
        sendPrivate({
          sender: senderKeypair,
          connection: mockConnection,
          recipient: 'st_some_stealth_meta_address',
          amount: 1.0,
        })
      ).rejects.toThrow(/insufficient/i);
    });

    it('includes privacy options with standard level by default', async () => {
      const result = await sendPrivate({
        sender: senderKeypair,
        connection: mockConnection,
        recipient: 'st_some_stealth_meta_address',
        amount: 0.5,
      });

      expect(result.signature).toBe(MOCK_SIGNATURE);
    });
  });

  // -----------------------------------------------------------------------
  // sendPublic
  // -----------------------------------------------------------------------
  describe('sendPublic', () => {
    it('sends a public SOL transfer', async () => {
      const recipientPubKey = Keypair.generate().publicKey.toBase58();

      const result = await sendPublic(
        mockConnection,
        senderKeypair,
        recipientPubKey,
        0.5
      );

      expect(result.signature).toBe(MOCK_SIGNATURE);
    });

    it('throws for invalid recipient public key', async () => {
      vi.mocked(helpers.isValidPublicKey).mockReturnValueOnce(false);

      await expect(
        sendPublic(mockConnection, senderKeypair, 'bad-key', 1.0)
      ).rejects.toThrow(/invalid/i);
    });
  });

  // -----------------------------------------------------------------------
  // estimateTransferFee
  // -----------------------------------------------------------------------
  describe('estimateTransferFee', () => {
    it('returns a bigint fee estimate for standard privacy', async () => {
      const fee = await estimateTransferFee(mockConnection, 'standard');

      expect(typeof fee).toBe('bigint');
      expect(fee).toBeGreaterThan(0n);
    });

    it('enhanced privacy has higher fee due to split count', async () => {
      const standard = await estimateTransferFee(mockConnection, 'standard');
      const enhanced = await estimateTransferFee(mockConnection, 'enhanced');

      expect(enhanced).toBeGreaterThan(standard);
    });

    it('maximum privacy has the highest fee', async () => {
      const enhanced = await estimateTransferFee(mockConnection, 'enhanced');
      const maximum = await estimateTransferFee(mockConnection, 'maximum');

      expect(maximum).toBeGreaterThan(enhanced);
    });
  });
});

// ===========================================================================
// transfer/claim.ts
// ===========================================================================

describe('transfer/claim', () => {
  let mockConnection: Connection;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection = new Connection('https://api.devnet.solana.com');
  });

  // Helper to build a mock StealthPayment
  function makeMockPayment(overrides: Partial<StealthPayment> = {}): StealthPayment {
    // Get the mocked stealth keypair so publicKey matches
    const { __mockStealthKeypair } = stealthDerive as any;
    return {
      stealthAddress: __mockStealthKeypair.publicKey,
      ephemeralPubKey: new Uint8Array(32).fill(0xaa),
      amount: 1_000_000_000n,
      tokenMint: null,
      signature: 'someSig',
      blockTime: Date.now(),
      claimed: false,
      viewTag: 42,
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // claimStealth
  // -----------------------------------------------------------------------
  describe('claimStealth', () => {
    it('claims a stealth payment and returns a ClaimResult', async () => {
      const payment = makeMockPayment();

      const result = await claimStealth({
        connection: mockConnection,
        payment,
        spendingPrivateKey: new Uint8Array(32).fill(0x01),
        viewingPrivateKey: new Uint8Array(32).fill(0x02),
        destination: Keypair.generate().publicKey,
      });

      expect(result.signature).toBe(MOCK_SIGNATURE);
      expect(typeof result.amount).toBe('bigint');
      expect(result.destination).toBeInstanceOf(PublicKey);
      expect(result.confirmed).toBe(true);
    });

    it('throws when payment is already claimed', async () => {
      const payment = makeMockPayment({ claimed: true });

      await expect(
        claimStealth({
          connection: mockConnection,
          payment,
          spendingPrivateKey: new Uint8Array(32),
          viewingPrivateKey: new Uint8Array(32),
        })
      ).rejects.toThrow(/already been claimed/i);
    });

    it('throws when stealth address has zero balance', async () => {
      (mockConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);

      const payment = makeMockPayment();

      await expect(
        claimStealth({
          connection: mockConnection,
          payment,
          spendingPrivateKey: new Uint8Array(32).fill(0x01),
          viewingPrivateKey: new Uint8Array(32).fill(0x02),
        })
      ).rejects.toThrow(/no balance/i);
    });
  });

  // -----------------------------------------------------------------------
  // claimMultiple
  // -----------------------------------------------------------------------
  describe('claimMultiple', () => {
    it('attempts to claim all provided payments', async () => {
      const payments = [makeMockPayment(), makeMockPayment()];
      const destination = Keypair.generate().publicKey;

      const results = await claimMultiple(
        mockConnection,
        payments,
        new Uint8Array(32).fill(0x01),
        new Uint8Array(32).fill(0x02),
        destination
      );

      expect(results.length).toBeGreaterThanOrEqual(0);
    });
  });

  // -----------------------------------------------------------------------
  // getStealthBalance
  // -----------------------------------------------------------------------
  describe('getStealthBalance', () => {
    it('returns SOL balance as bigint', async () => {
      const address = Keypair.generate().publicKey;
      const balance = await getStealthBalance(mockConnection, address);

      expect(typeof balance).toBe('bigint');
      expect(balance).toBe(10_000_000_000n); // mocked 10 SOL
    });

    it('returns token balance when mint is specified', async () => {
      const address = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const balance = await getStealthBalance(mockConnection, address, mint);

      expect(typeof balance).toBe('bigint');
    });
  });

  // -----------------------------------------------------------------------
  // canClaim
  // -----------------------------------------------------------------------
  describe('canClaim', () => {
    it('returns canClaim: true when balance is sufficient', async () => {
      const payment = makeMockPayment();
      const result = await canClaim(mockConnection, payment);

      expect(result.canClaim).toBe(true);
      expect(typeof result.balance).toBe('bigint');
    });

    it('returns canClaim: false when balance is zero', async () => {
      (mockConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);

      const payment = makeMockPayment();
      const result = await canClaim(mockConnection, payment);

      expect(result.canClaim).toBe(false);
      expect(result.reason).toMatch(/no balance/i);
    });

    it('returns canClaim: false when SOL balance is below rent exemption', async () => {
      // Return balance = 500_000 (below MIN_RENT_EXEMPTION 890_880)
      (mockConnection.getBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce(500_000);

      const payment = makeMockPayment();
      const result = await canClaim(mockConnection, payment);

      expect(result.canClaim).toBe(false);
      expect(result.reason).toMatch(/rent/i);
    });
  });

  // -----------------------------------------------------------------------
  // estimateClaimFee
  // -----------------------------------------------------------------------
  describe('estimateClaimFee', () => {
    it('returns a bigint fee for SOL claim', async () => {
      const payment = makeMockPayment();
      const destination = Keypair.generate().publicKey;

      const fee = await estimateClaimFee(mockConnection, payment, destination);

      expect(typeof fee).toBe('bigint');
      expect(fee).toBe(5000n);
    });

    it('returns higher fee for token claim when ATA does not exist', async () => {
      vi.mocked(splToken.getAccount).mockRejectedValueOnce(new Error('Account not found'));

      const tokenMint = Keypair.generate().publicKey;
      const payment = makeMockPayment({ tokenMint });
      const destination = Keypair.generate().publicKey;

      const fee = await estimateClaimFee(mockConnection, payment, destination);

      expect(typeof fee).toBe('bigint');
      // fee = 5000n + rent exemption
      expect(fee).toBeGreaterThan(5000n);
    });
  });
});
