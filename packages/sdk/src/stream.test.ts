import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';

import { P01StreamClient, createDevnetClient, createMainnetClient } from './stream';
import { StreamStatus } from './types';
import { STREAM_PROGRAM_ID_DEVNET, STREAM_PROGRAM_ID_MAINNET, RPC_ENDPOINTS } from './constants';

// ============================================================
// P01StreamClient constructor & basic properties
// ============================================================
describe('P01StreamClient', () => {
  describe('constructor', () => {
    it('should create a client with devnet config', () => {
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });
      expect(client).toBeInstanceOf(P01StreamClient);
      expect(client.getProgramId().equals(STREAM_PROGRAM_ID_DEVNET)).toBe(true);
    });

    it('should create a client with mainnet config', () => {
      const client = new P01StreamClient({
        network: 'mainnet-beta',
        rpcUrl: RPC_ENDPOINTS['mainnet-beta'],
      });
      expect(client.getProgramId().equals(STREAM_PROGRAM_ID_MAINNET)).toBe(true);
    });

    it('should use custom programId when provided', () => {
      const customId = PublicKey.unique();
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
        programId: customId,
      });
      expect(client.getProgramId().equals(customId)).toBe(true);
    });

    it('should use default RPC endpoint when rpcUrl is empty', () => {
      // When rpcUrl is falsy, it should fall back to RPC_ENDPOINTS[network]
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: '',
      });
      expect(client.getConnection()).toBeInstanceOf(Connection);
    });
  });

  describe('wallet connection', () => {
    let client: P01StreamClient;

    beforeEach(() => {
      client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });
    });

    it('should initially have no wallet connected', () => {
      expect(client.publicKey).toBeNull();
      expect(client.isConnected).toBe(false);
    });

    it('should connect a wallet provider', () => {
      const walletPubkey = PublicKey.unique();
      const mockWallet = {
        publicKey: walletPubkey,
        connected: true,
        signTransaction: vi.fn(),
        signAllTransactions: vi.fn(),
        signMessage: vi.fn(),
      };

      client.connect(mockWallet);
      expect(client.publicKey).not.toBeNull();
      expect(client.publicKey!.equals(walletPubkey)).toBe(true);
      expect(client.isConnected).toBe(true);
    });

    it('should disconnect a wallet provider', () => {
      const mockWallet = {
        publicKey: PublicKey.unique(),
        connected: true,
        signTransaction: vi.fn(),
        signAllTransactions: vi.fn(),
        signMessage: vi.fn(),
      };

      client.connect(mockWallet);
      expect(client.isConnected).toBe(true);

      client.disconnect();
      expect(client.publicKey).toBeNull();
      expect(client.isConnected).toBe(false);
    });
  });

  describe('getConnection', () => {
    it('should return a Connection instance', () => {
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });
      expect(client.getConnection()).toBeInstanceOf(Connection);
    });
  });

  describe('createStream (wallet guard)', () => {
    it('should throw "Wallet not connected" when no wallet is connected', async () => {
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });

      await expect(
        client.createStream({
          recipient: PublicKey.unique(),
          mint: PublicKey.unique(),
          amountPerInterval: 1000,
          intervalSeconds: 3600,
          totalIntervals: 10,
          streamName: 'test',
        })
      ).rejects.toThrow('Wallet not connected');
    });
  });

  describe('cancelStream (wallet guard)', () => {
    it('should throw "Wallet not connected" when no wallet is connected', async () => {
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });

      await expect(client.cancelStream(PublicKey.unique())).rejects.toThrow(
        'Wallet not connected'
      );
    });
  });

  describe('withdrawFromStream (wallet guard)', () => {
    it('should throw "Wallet not connected" when no wallet is connected', async () => {
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });

      await expect(client.withdrawFromStream(PublicKey.unique())).rejects.toThrow(
        'Wallet not connected'
      );
    });
  });

  describe('getMyStreams (wallet guard)', () => {
    it('should throw "Wallet not connected" when no wallet is connected', async () => {
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });

      await expect(client.getMyStreams()).rejects.toThrow('Wallet not connected');
    });
  });

  describe('getStream', () => {
    it('should return null when no account is found', async () => {
      const mockConn = {
        getAccountInfo: vi.fn().mockResolvedValue(null),
      } as unknown as Connection;

      // Use a minimal config with the mock connection injected
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });
      // Override the internal connection for testing
      (client as unknown as { connection: Connection }).connection = mockConn;

      const result = await client.getStream(PublicKey.unique());
      expect(result).toBeNull();
    });

    it('should parse a valid stream account buffer', async () => {
      const streamPubkey = PublicKey.unique();
      const sender = PublicKey.unique();
      const recipient = PublicKey.unique();
      const mint = PublicKey.unique();
      const buf = buildStreamBuffer(sender, recipient, mint, {
        amountPerInterval: BigInt(5000),
        intervalSeconds: 3600,
        totalIntervals: 12,
        intervalsPaid: 3,
        createdAt: 1700000000,
        lastWithdrawalAt: 1700010000,
        status: 0, // Active
        streamName: 'TEST-STREAM',
      });

      const mockConn = {
        getAccountInfo: vi.fn().mockResolvedValue({
          data: buf,
          executable: false,
          lamports: 0,
          owner: STREAM_PROGRAM_ID_DEVNET,
        }),
      } as unknown as Connection;

      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });
      (client as unknown as { connection: Connection }).connection = mockConn;

      const stream = await client.getStream(streamPubkey);
      expect(stream).not.toBeNull();
      expect(stream!.publicKey.equals(streamPubkey)).toBe(true);
      expect(stream!.sender.equals(sender)).toBe(true);
      expect(stream!.recipient.equals(recipient)).toBe(true);
      expect(stream!.mint.equals(mint)).toBe(true);
      expect(stream!.amountPerInterval).toBe(BigInt(5000));
      expect(stream!.intervalSeconds).toBe(3600);
      expect(stream!.totalIntervals).toBe(12);
      expect(stream!.intervalsPaid).toBe(3);
      expect(stream!.createdAt).toBe(1700000000);
      expect(stream!.lastWithdrawalAt).toBe(1700010000);
      expect(stream!.status).toBe(StreamStatus.Active);
      expect(stream!.streamName).toBe('TEST-STREAM');
    });

    it('should return null on malformed buffer', async () => {
      const mockConn = {
        getAccountInfo: vi.fn().mockResolvedValue({
          data: Buffer.alloc(5), // too small to parse
          executable: false,
          lamports: 0,
          owner: STREAM_PROGRAM_ID_DEVNET,
        }),
      } as unknown as Connection;

      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });
      (client as unknown as { connection: Connection }).connection = mockConn;

      const result = await client.getStream(PublicKey.unique());
      expect(result).toBeNull();
    });
  });

  describe('getWithdrawableAmount', () => {
    it('should delegate to calculateWithdrawableAmount', () => {
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date(1700020000 * 1000));

      const stream = {
        publicKey: PublicKey.unique(),
        sender: PublicKey.unique(),
        recipient: PublicKey.unique(),
        mint: PublicKey.unique(),
        amountPerInterval: BigInt(1000),
        intervalSeconds: 3600,
        totalIntervals: 10,
        intervalsPaid: 2,
        createdAt: 1700000000,
        lastWithdrawalAt: 1700010000,
        status: StreamStatus.Active,
        streamName: 'TEST',
      };

      // elapsed = (1700020000 - 1700010000) / 3600 = floor(2.777) = 2
      // remaining = 10 - 2 = 8
      // intervalsToPay = min(2, 8) = 2
      // amount = 1000 * 2 = 2000
      const amount = client.getWithdrawableAmount(stream);
      expect(amount).toBe(BigInt(2000));

      vi.useRealTimers();
    });
  });

  describe('getRefundAmount', () => {
    it('should delegate to calculateRefundAmount', () => {
      const client = new P01StreamClient({
        network: 'devnet',
        rpcUrl: RPC_ENDPOINTS.devnet,
      });

      const stream = {
        publicKey: PublicKey.unique(),
        sender: PublicKey.unique(),
        recipient: PublicKey.unique(),
        mint: PublicKey.unique(),
        amountPerInterval: BigInt(500),
        intervalSeconds: 3600,
        totalIntervals: 10,
        intervalsPaid: 4,
        createdAt: 1700000000,
        lastWithdrawalAt: 1700010000,
        status: StreamStatus.Active,
        streamName: 'TEST',
      };

      // remaining = 10 - 4 = 6, refund = 500 * 6 = 3000
      const refund = client.getRefundAmount(stream);
      expect(refund).toBe(BigInt(3000));
    });
  });
});

// ============================================================
// Factory functions
// ============================================================
describe('createDevnetClient', () => {
  it('should return a P01StreamClient configured for devnet', () => {
    const client = createDevnetClient();
    expect(client).toBeInstanceOf(P01StreamClient);
    expect(client.getProgramId().equals(STREAM_PROGRAM_ID_DEVNET)).toBe(true);
  });
});

describe('createMainnetClient', () => {
  it('should return a P01StreamClient configured for mainnet', () => {
    const client = createMainnetClient();
    expect(client).toBeInstanceOf(P01StreamClient);
    expect(client.getProgramId().equals(STREAM_PROGRAM_ID_MAINNET)).toBe(true);
  });
});

// ============================================================
// Types
// ============================================================
describe('StreamStatus enum', () => {
  it('should define Active, Paused, Cancelled, Completed', () => {
    expect(StreamStatus.Active).toBe('active');
    expect(StreamStatus.Paused).toBe('paused');
    expect(StreamStatus.Cancelled).toBe('cancelled');
    expect(StreamStatus.Completed).toBe('completed');
  });
});

// ============================================================
// Helper: build a fake stream account buffer matching the
// on-chain layout parsed by parseStreamAccount.
// ============================================================
function buildStreamBuffer(
  sender: PublicKey,
  recipient: PublicKey,
  mint: PublicKey,
  opts: {
    amountPerInterval: bigint;
    intervalSeconds: number;
    totalIntervals: number;
    intervalsPaid: number;
    createdAt: number;
    lastWithdrawalAt: number;
    status: number;
    streamName: string;
  }
): Buffer {
  // Layout:
  //   8   discriminator
  //  32   sender
  //  32   recipient
  //  32   mint
  //   8   amountPerInterval (u64 LE)
  //   8   intervalSeconds (i64 LE)
  //   8   totalIntervals (u64 LE)
  //   8   intervalsPaid (u64 LE)
  //   8   createdAt (i64 LE)
  //   8   lastWithdrawalAt (i64 LE)
  //   1   status (u8)
  //   4   streamName length (u32 LE)
  //   N   streamName bytes
  const nameBytes = Buffer.from(opts.streamName, 'utf8');
  const totalSize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 4 + nameBytes.length;
  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Discriminator (8 bytes, zeroes)
  offset += 8;

  // sender
  sender.toBuffer().copy(buf, offset);
  offset += 32;

  // recipient
  recipient.toBuffer().copy(buf, offset);
  offset += 32;

  // mint
  mint.toBuffer().copy(buf, offset);
  offset += 32;

  // amountPerInterval (u64 LE)
  buf.writeBigUInt64LE(opts.amountPerInterval, offset);
  offset += 8;

  // intervalSeconds (i64 LE)
  buf.writeBigInt64LE(BigInt(opts.intervalSeconds), offset);
  offset += 8;

  // totalIntervals (u64 LE)
  buf.writeBigUInt64LE(BigInt(opts.totalIntervals), offset);
  offset += 8;

  // intervalsPaid (u64 LE)
  buf.writeBigUInt64LE(BigInt(opts.intervalsPaid), offset);
  offset += 8;

  // createdAt (i64 LE)
  buf.writeBigInt64LE(BigInt(opts.createdAt), offset);
  offset += 8;

  // lastWithdrawalAt (i64 LE)
  buf.writeBigInt64LE(BigInt(opts.lastWithdrawalAt), offset);
  offset += 8;

  // status (u8)
  buf.writeUInt8(opts.status, offset);
  offset += 1;

  // streamName length (u32 LE)
  buf.writeUInt32LE(nameBytes.length, offset);
  offset += 4;

  // streamName bytes
  nameBytes.copy(buf, offset);

  return buf;
}
