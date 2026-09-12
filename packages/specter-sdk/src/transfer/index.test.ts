import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Hoisted constants – available inside vi.mock() factories
// ---------------------------------------------------------------------------

const { MOCK_SIGNATURE, MOCK_BLOCKHASH } = vi.hoisted(() => ({
  MOCK_SIGNATURE: '5aFake111111111111111111111111111111111111111111111111111111111111111sig',
  MOCK_BLOCKHASH: 'GHtXQBtSBZAbcdefghijk123456789ABCDefghij',
}));

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
      sendRawTransaction: vi.fn().mockResolvedValue(MOCK_SIGNATURE),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
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
  TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
}));

// Mock helpers that validate addresses
vi.mock('../utils/helpers', async () => {
  const actual = await vi.importActual<typeof import('../utils/helpers')>(
    '../utils/helpers'
  );
  return {
    ...actual,
    isValidPublicKey: vi.fn().mockReturnValue(true),
  };
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import * as helpers from '../utils/helpers';
import * as splToken from '@solana/spl-token';
import { sendAndConfirmTransaction } from '@solana/web3.js';

import { sendPublic } from './send';

// ===========================================================================
// transfer/send.ts — the one transfer that never touched the specter program
// ===========================================================================

describe('transfer/send', () => {
  let mockConnection: Connection;
  let senderKeypair: Keypair;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(helpers.isValidPublicKey).mockReturnValue(true);
    mockConnection = new Connection('https://api.devnet.solana.com');
    senderKeypair = Keypair.generate();
  });

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
      expect(sendAndConfirmTransaction).toHaveBeenCalledTimes(1);
      expect(splToken.createTransferInstruction).not.toHaveBeenCalled();
    });

    it('routes an SPL amount through the token program', async () => {
      const recipientPubKey = Keypair.generate().publicKey.toBase58();
      const mint = Keypair.generate().publicKey;

      const result = await sendPublic(
        mockConnection,
        senderKeypair,
        recipientPubKey,
        1,
        mint
      );

      expect(result.signature).toBe(MOCK_SIGNATURE);
      expect(splToken.getAssociatedTokenAddress).toHaveBeenCalledTimes(2);
      expect(splToken.createTransferInstruction).toHaveBeenCalledTimes(1);
    });

    it('signs through a wallet adapter when there is no secret key', async () => {
      const recipientPubKey = Keypair.generate().publicKey.toBase58();
      const adapter = {
        publicKey: Keypair.generate().publicKey,
        signTransaction: vi.fn().mockResolvedValue({ serialize: () => Buffer.alloc(0) }),
        signAllTransactions: vi.fn(),
      };

      const result = await sendPublic(mockConnection, adapter as any, recipientPubKey, 0.25);

      expect(adapter.signTransaction).toHaveBeenCalledTimes(1);
      expect(result.signature).toBe(MOCK_SIGNATURE);
      expect(sendAndConfirmTransaction).not.toHaveBeenCalled();
    });

    it('throws for invalid recipient public key', async () => {
      vi.mocked(helpers.isValidPublicKey).mockReturnValueOnce(false);

      await expect(
        sendPublic(mockConnection, senderKeypair, 'bad-key', 1.0)
      ).rejects.toThrow(/invalid/i);
    });
  });
});
