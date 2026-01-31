/**
 * P01AuthServer Tests
 *
 * Tests the server-side auth SDK: signature verification, timestamp
 * validation, subscription proof checking, middleware, and session
 * store integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks -- must be hoisted before the module under test is imported
// ---------------------------------------------------------------------------

const mockNaclVerify = vi.fn().mockReturnValue(true);

vi.mock('tweetnacl', () => ({
  default: {
    sign: {
      detached: {
        verify: (...args: any[]) => mockNaclVerify(...args),
      },
    },
  },
}));

const mockBs58Decode = vi.fn((input: string) => new Uint8Array(32).fill(0));

vi.mock('bs58', () => ({
  default: {
    decode: (...args: any[]) => mockBs58Decode(...args),
  },
}));

// Mock @solana/web3.js to avoid real RPC or heavy crypto dependencies
const mockGetTokenAccountBalance = vi.fn();

vi.mock('@solana/web3.js', () => {
  class MockPublicKey {
    private _key: string;
    constructor(key: string | Uint8Array) {
      this._key = typeof key === 'string' ? key : 'DERIVED_WALLET';
    }
    toBase58() { return this._key; }
    toBuffer() { return Buffer.alloc(32); }
    static findProgramAddressSync(_seeds: any[], _programId: any) {
      return [new MockPublicKey('ATA_ADDRESS'), 255];
    }
  }
  class MockConnection {
    constructor(_url: string) {}
    getTokenAccountBalance(ata: any) {
      return mockGetTokenAccountBalance(ata);
    }
  }
  return {
    PublicKey: MockPublicKey,
    Connection: MockConnection,
  };
});

// ---------------------------------------------------------------------------
// Now import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { P01AuthServer, type ServerSessionStore } from './server';
import type { AuthResponse, AuthSession, SubscriptionProof } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig() {
  return {
    serviceId: 'test-service',
  };
}

function makeResponse(overrides: Partial<AuthResponse> = {}): AuthResponse {
  return {
    sessionId: 'sess-1',
    wallet: 'DERIVED_WALLET',
    signature: 'SIG_B58',
    publicKey: 'PK_B58',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    sessionId: 'sess-1',
    serviceId: 'test-service',
    challenge: 'random-challenge',
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

function createMockSessionStore(): ServerSessionStore & { map: Map<string, AuthSession> } {
  const map = new Map<string, AuthSession>();
  return {
    map,
    get: vi.fn(async (id: string) => map.get(id) ?? null),
    set: vi.fn(async (session: AuthSession) => { map.set(session.sessionId, session); }),
    delete: vi.fn(async (id: string) => { map.delete(id); }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P01AuthServer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNaclVerify.mockReturnValue(true);
    mockBs58Decode.mockImplementation((input: string) => new Uint8Array(32).fill(0));
    mockGetTokenAccountBalance.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('sets default maxTimestampAge to 60 000 ms', async () => {
      const server = new P01AuthServer(defaultConfig());
      // Provide a timestamp just barely over 60s old => should fail
      const oldTimestamp = Date.now() - 61_000;
      const result = await server.verifyCallback(makeResponse({ timestamp: oldTimestamp }));
      expect(result.success).toBe(false);
      expect(result.error).toBe('Timestamp expired or invalid');
    });

    it('sets default RPC URL to mainnet-beta', () => {
      // We can't easily inspect private config, but constructing with
      // a subscriptionMint will create a Connection with the default URL.
      // If this didn't throw, the Connection was created successfully.
      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });
      expect(server).toBeDefined();
    });

    it('does not create Connection when no subscriptionMint', () => {
      const server = new P01AuthServer(defaultConfig());
      // No subscription => no RPC calls should ever happen
      expect(server).toBeDefined();
    });

    it('respects custom maxTimestampAge', async () => {
      const server = new P01AuthServer({
        ...defaultConfig(),
        maxTimestampAge: 10_000, // only 10 seconds
      });
      // 15 seconds old should fail with 10s window
      const oldTs = Date.now() - 15_000;
      const result = await server.verifyCallback(makeResponse({ timestamp: oldTs }));
      expect(result.success).toBe(false);
      expect(result.error).toBe('Timestamp expired or invalid');
    });
  });

  // -----------------------------------------------------------------------
  // verifyCallback
  // -----------------------------------------------------------------------

  describe('verifyCallback', () => {
    it('rejects expired timestamps', async () => {
      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(
        makeResponse({ timestamp: Date.now() - 120_000 })
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Timestamp expired or invalid');
    });

    it('rejects far-future timestamps', async () => {
      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(
        makeResponse({ timestamp: Date.now() + 60_000 })
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Timestamp expired or invalid');
    });

    it('accepts timestamps within the allowed window', async () => {
      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(
        makeResponse({ timestamp: Date.now() - 30_000 })
      );
      expect(result.success).toBe(true);
      expect(result.wallet).toBe('DERIVED_WALLET');
    });

    it('returns success with wallet when signature is valid', async () => {
      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(makeResponse());
      expect(result.success).toBe(true);
      expect(result.wallet).toBe('DERIVED_WALLET');
    });

    it('returns error when signature is invalid', async () => {
      mockNaclVerify.mockReturnValueOnce(false);
      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(makeResponse());
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('passes session challenge to signature verification when session provided', async () => {
      const server = new P01AuthServer(defaultConfig());
      const session = makeSession({ challenge: 'THE_CHALLENGE' });
      const response = makeResponse();

      await server.verifyCallback(response, session);

      // The sign message should include the challenge from the session
      // We verify indirectly: nacl.verify was called (signature was checked)
      expect(mockNaclVerify).toHaveBeenCalled();
    });

    it('falls back to session store when no session argument given', async () => {
      const store = createMockSessionStore();
      const session = makeSession({ challenge: 'STORED_CHALLENGE' });
      store.map.set('sess-1', session);

      const server = new P01AuthServer({
        ...defaultConfig(),
        sessionStore: store,
      });

      await server.verifyCallback(makeResponse());
      expect(store.get).toHaveBeenCalledWith('sess-1');
    });

    it('works without session store or session argument (empty challenge)', async () => {
      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(makeResponse());
      // Should still succeed -- challenge defaults to ''
      expect(result.success).toBe(true);
    });

    it('catches and returns generic errors', async () => {
      mockNaclVerify.mockImplementationOnce(() => {
        throw new Error('Unexpected internal error');
      });

      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(makeResponse());
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('handles error without message property', async () => {
      mockNaclVerify.mockImplementationOnce(() => {
        throw {};  // no .message
      });

      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(makeResponse());
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });
  });

  // -----------------------------------------------------------------------
  // verifySignature
  // -----------------------------------------------------------------------

  describe('verifySignature', () => {
    it('returns true when nacl verifies successfully', async () => {
      const server = new P01AuthServer(defaultConfig());
      const valid = await server.verifySignature(makeResponse(), 'challenge');
      expect(valid).toBe(true);
      expect(mockNaclVerify).toHaveBeenCalledOnce();
    });

    it('returns false when nacl verification fails', async () => {
      mockNaclVerify.mockReturnValueOnce(false);
      const server = new P01AuthServer(defaultConfig());
      const valid = await server.verifySignature(makeResponse(), 'challenge');
      expect(valid).toBe(false);
    });

    it('returns false when wallet does not match public key', async () => {
      // Our mock PublicKey.toBase58() returns the string passed to constructor.
      // bs58.decode returns Uint8Array(32), and MockPublicKey(Uint8Array) returns 'DERIVED_WALLET'.
      // So if response.wallet !== 'DERIVED_WALLET', verification fails.
      const server = new P01AuthServer(defaultConfig());
      const valid = await server.verifySignature(
        makeResponse({ wallet: 'DIFFERENT_WALLET' }),
        'challenge'
      );
      expect(valid).toBe(false);
      // nacl.verify should NOT be called because wallet mismatch returns early
      expect(mockNaclVerify).not.toHaveBeenCalled();
    });

    it('returns false when bs58.decode throws', async () => {
      mockBs58Decode.mockImplementationOnce(() => {
        throw new Error('Invalid base58');
      });

      const server = new P01AuthServer(defaultConfig());
      const valid = await server.verifySignature(makeResponse(), 'challenge');
      expect(valid).toBe(false);
    });

    it('constructs the correct sign message format', async () => {
      const server = new P01AuthServer({ serviceId: 'netflix' });
      const response = makeResponse({
        sessionId: 'sess-42',
        timestamp: 1700000000000,
      });

      await server.verifySignature(response, 'my-challenge');

      // The TextEncoder encodes "P01-AUTH:netflix:sess-42:my-challenge:1700000000000"
      // We check nacl was called with the right messageBytes (first argument)
      const expectedMessage = 'P01-AUTH:netflix:sess-42:my-challenge:1700000000000';
      const expectedBytes = new TextEncoder().encode(expectedMessage);

      expect(mockNaclVerify).toHaveBeenCalled();
      const actualMessageBytes = mockNaclVerify.mock.calls[0][0];
      expect(actualMessageBytes).toEqual(expectedBytes);
    });

    it('uses empty string as challenge when none provided', async () => {
      const server = new P01AuthServer({ serviceId: 'svc' });
      const response = makeResponse({
        sessionId: 'sess-99',
        timestamp: 1234567890000,
      });

      await server.verifySignature(response); // no challenge

      const expectedMessage = 'P01-AUTH:svc:sess-99::1234567890000';
      const expectedBytes = new TextEncoder().encode(expectedMessage);
      const actualMessageBytes = mockNaclVerify.mock.calls[0][0];
      expect(actualMessageBytes).toEqual(expectedBytes);
    });
  });

  // -----------------------------------------------------------------------
  // verifySubscription
  // -----------------------------------------------------------------------

  describe('verifySubscription', () => {
    it('returns true when no subscriptionMint configured', async () => {
      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifySubscription('WALLET');
      expect(result).toBe(true);
    });

    it('returns false when on-chain balance is zero', async () => {
      mockGetTokenAccountBalance.mockResolvedValueOnce({
        value: { amount: '0' },
      });

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const result = await server.verifySubscription('WALLET');
      expect(result).toBe(false);
    });

    it('returns true when on-chain balance is positive', async () => {
      mockGetTokenAccountBalance.mockResolvedValueOnce({
        value: { amount: '1000' },
      });

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const result = await server.verifySubscription('WALLET');
      expect(result).toBe(true);
    });

    it('returns false when getTokenAccountBalance throws (no account)', async () => {
      mockGetTokenAccountBalance.mockRejectedValueOnce(
        new Error('Account not found')
      );

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const result = await server.verifySubscription('WALLET');
      expect(result).toBe(false);
    });

    it('validates provided proof before checking on-chain', async () => {
      // Proof has invalid (zero) balance -- should fail before RPC call
      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const badProof: SubscriptionProof = {
        mint: 'MINT_ADDR',
        tokenAccount: 'TA',
        balance: '0',
        slot: 1,
        blockhash: 'bh',
      };

      const result = await server.verifySubscription('WALLET', badProof);
      expect(result).toBe(false);
      // Should not have called RPC since proof validation failed
      expect(mockGetTokenAccountBalance).not.toHaveBeenCalled();
    });

    it('validates proof mint matches configured mint', async () => {
      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'CORRECT_MINT',
      });

      const wrongMintProof: SubscriptionProof = {
        mint: 'WRONG_MINT',
        tokenAccount: 'TA',
        balance: '100',
        slot: 1,
        blockhash: 'bh',
      };

      const result = await server.verifySubscription('WALLET', wrongMintProof);
      expect(result).toBe(false);
    });

    it('proceeds to on-chain check after valid proof', async () => {
      mockGetTokenAccountBalance.mockResolvedValueOnce({
        value: { amount: '500' },
      });

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const validProof: SubscriptionProof = {
        mint: 'MINT_ADDR',
        tokenAccount: 'TA',
        balance: '500',
        slot: 1,
        blockhash: 'bh',
      };

      const result = await server.verifySubscription('WALLET', validProof);
      expect(result).toBe(true);
      expect(mockGetTokenAccountBalance).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // validateSubscriptionProof
  // -----------------------------------------------------------------------

  describe('validateSubscriptionProof', () => {
    it('returns false when mint is missing', () => {
      const server = new P01AuthServer(defaultConfig());
      const result = server.validateSubscriptionProof({
        mint: '',
        tokenAccount: 'TA',
        balance: '100',
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(false);
    });

    it('returns false when balance is missing', () => {
      const server = new P01AuthServer(defaultConfig());
      const result = server.validateSubscriptionProof({
        mint: 'MINT',
        tokenAccount: 'TA',
        balance: '',
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(false);
    });

    it('returns false when balance is zero', () => {
      const server = new P01AuthServer(defaultConfig());
      const result = server.validateSubscriptionProof({
        mint: 'MINT',
        tokenAccount: 'TA',
        balance: '0',
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(false);
    });

    it('returns false when balance is negative', () => {
      const server = new P01AuthServer(defaultConfig());
      const result = server.validateSubscriptionProof({
        mint: 'MINT',
        tokenAccount: 'TA',
        balance: '-10',
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(false);
    });

    it('returns false when proof mint does not match configured mint', () => {
      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'EXPECTED_MINT',
      });
      const result = server.validateSubscriptionProof({
        mint: 'OTHER_MINT',
        tokenAccount: 'TA',
        balance: '100',
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(false);
    });

    it('returns false when proof is expired', () => {
      const server = new P01AuthServer(defaultConfig());
      const result = server.validateSubscriptionProof({
        mint: 'MINT',
        tokenAccount: 'TA',
        balance: '100',
        expiresAt: Date.now() - 1_000,
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(false);
    });

    it('returns true for valid proof without expiry', () => {
      const server = new P01AuthServer(defaultConfig());
      const result = server.validateSubscriptionProof({
        mint: 'MINT',
        tokenAccount: 'TA',
        balance: '100',
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(true);
    });

    it('returns true for valid proof with future expiry', () => {
      const server = new P01AuthServer(defaultConfig());
      const result = server.validateSubscriptionProof({
        mint: 'MINT',
        tokenAccount: 'TA',
        balance: '100',
        expiresAt: Date.now() + 60_000,
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(true);
    });

    it('accepts proof with matching configured mint', () => {
      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MY_MINT',
      });
      const result = server.validateSubscriptionProof({
        mint: 'MY_MINT',
        tokenAccount: 'TA',
        balance: '1',
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(true);
    });

    it('accepts very large balances', () => {
      const server = new P01AuthServer(defaultConfig());
      const result = server.validateSubscriptionProof({
        mint: 'MINT',
        tokenAccount: 'TA',
        balance: '999999999999999999',
        slot: 1,
        blockhash: 'bh',
      });
      expect(result).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // verifyCallback with subscription
  // -----------------------------------------------------------------------

  describe('verifyCallback with subscription', () => {
    it('returns subscription not active when on-chain check fails', async () => {
      mockGetTokenAccountBalance.mockRejectedValueOnce(new Error('No account'));

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const result = await server.verifyCallback(makeResponse());
      expect(result.success).toBe(false);
      expect(result.error).toBe('Subscription not active');
    });

    it('returns subscriptionActive: true when on-chain balance is positive', async () => {
      mockGetTokenAccountBalance.mockResolvedValueOnce({
        value: { amount: '1000' },
      });

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const result = await server.verifyCallback(makeResponse());
      expect(result.success).toBe(true);
      expect(result.subscriptionActive).toBe(true);
      expect(result.wallet).toBe('DERIVED_WALLET');
    });

    it('does not check subscription when no mint configured', async () => {
      const server = new P01AuthServer(defaultConfig());
      const result = await server.verifyCallback(makeResponse());

      expect(result.success).toBe(true);
      expect(result.subscriptionActive).toBeUndefined();
      expect(mockGetTokenAccountBalance).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // middleware
  // -----------------------------------------------------------------------

  describe('middleware', () => {
    function mockReqResNext(headers: Record<string, string> = {}) {
      const req: any = { headers };
      const res: any = {};
      const next = vi.fn();
      return { req, res, next };
    }

    it('calls next() immediately when no x-p01-auth header', async () => {
      const server = new P01AuthServer(defaultConfig());
      const mw = server.middleware();
      const { req, res, next } = mockReqResNext();

      await mw(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.p01Auth).toBeUndefined();
    });

    it('sets req.p01Auth on valid auth header', async () => {
      const server = new P01AuthServer(defaultConfig());
      const mw = server.middleware();

      const authData = makeResponse();
      const encoded = Buffer.from(JSON.stringify(authData)).toString('base64');

      const { req, res, next } = mockReqResNext({
        'x-p01-auth': encoded,
      });

      await mw(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.p01Auth).toBeDefined();
      expect(req.p01Auth.wallet).toBe('DERIVED_WALLET');
    });

    it('calls next() without p01Auth on invalid auth header (malformed JSON)', async () => {
      const server = new P01AuthServer(defaultConfig());
      const mw = server.middleware();

      const { req, res, next } = mockReqResNext({
        'x-p01-auth': 'not-valid-base64!!!',
      });

      await mw(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.p01Auth).toBeUndefined();
    });

    it('calls next() without p01Auth when verification fails', async () => {
      mockNaclVerify.mockReturnValueOnce(false);

      const server = new P01AuthServer(defaultConfig());
      const mw = server.middleware();

      const authData = makeResponse();
      const encoded = Buffer.from(JSON.stringify(authData)).toString('base64');
      const { req, res, next } = mockReqResNext({
        'x-p01-auth': encoded,
      });

      await mw(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.p01Auth).toBeUndefined();
    });

    it('includes subscriptionActive in req.p01Auth when subscription is verified', async () => {
      mockGetTokenAccountBalance.mockResolvedValueOnce({
        value: { amount: '500' },
      });

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });
      const mw = server.middleware();

      const authData = makeResponse();
      const encoded = Buffer.from(JSON.stringify(authData)).toString('base64');
      const { req, res, next } = mockReqResNext({
        'x-p01-auth': encoded,
      });

      await mw(req, res, next);

      expect(req.p01Auth).toBeDefined();
      expect(req.p01Auth.subscriptionActive).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // checkSubscription
  // -----------------------------------------------------------------------

  describe('checkSubscription', () => {
    it('returns active: true when no mint configured', async () => {
      const server = new P01AuthServer(defaultConfig());
      const result = await server.checkSubscription('WALLET');
      expect(result.active).toBe(true);
      expect(result.balance).toBeUndefined();
    });

    it('returns active: true with balance when on-chain balance is positive', async () => {
      mockGetTokenAccountBalance.mockResolvedValueOnce({
        value: { amount: '750' },
      });

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const result = await server.checkSubscription('WALLET');
      expect(result.active).toBe(true);
      expect(result.balance).toBe('750');
    });

    it('returns active: false when on-chain balance is zero', async () => {
      mockGetTokenAccountBalance.mockResolvedValueOnce({
        value: { amount: '0' },
      });

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const result = await server.checkSubscription('WALLET');
      expect(result.active).toBe(false);
      expect(result.balance).toBe('0');
    });

    it('returns active: false when RPC call fails', async () => {
      mockGetTokenAccountBalance.mockRejectedValueOnce(
        new Error('Network error')
      );

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT_ADDR',
      });

      const result = await server.checkSubscription('WALLET');
      expect(result.active).toBe(false);
      expect(result.balance).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Full flow integration
  // -----------------------------------------------------------------------

  describe('full verification flow', () => {
    it('verifies callback with session store lookup', async () => {
      const store = createMockSessionStore();
      const session = makeSession({ challenge: 'STORE_CHALLENGE' });
      store.map.set('sess-1', session);

      const server = new P01AuthServer({
        ...defaultConfig(),
        sessionStore: store,
      });

      const result = await server.verifyCallback(makeResponse());
      expect(result.success).toBe(true);
      expect(result.wallet).toBe('DERIVED_WALLET');
      expect(store.get).toHaveBeenCalledWith('sess-1');
    });

    it('verifies callback with explicit session (bypasses store)', async () => {
      const store = createMockSessionStore();
      const server = new P01AuthServer({
        ...defaultConfig(),
        sessionStore: store,
      });

      const session = makeSession({ challenge: 'EXPLICIT_CHALLENGE' });
      const result = await server.verifyCallback(makeResponse(), session);

      expect(result.success).toBe(true);
      // Store should NOT have been queried because explicit session was provided
      expect(store.get).not.toHaveBeenCalled();
    });

    it('full flow with subscription: timestamp -> signature -> subscription', async () => {
      mockGetTokenAccountBalance.mockResolvedValueOnce({
        value: { amount: '1000' },
      });

      const store = createMockSessionStore();
      const session = makeSession({ challenge: 'FLOW_CHALLENGE' });
      store.map.set('sess-1', session);

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'FLOW_MINT',
        sessionStore: store,
      });

      const result = await server.verifyCallback(makeResponse());

      expect(result.success).toBe(true);
      expect(result.wallet).toBe('DERIVED_WALLET');
      expect(result.subscriptionActive).toBe(true);
      expect(mockNaclVerify).toHaveBeenCalledOnce();
      expect(mockGetTokenAccountBalance).toHaveBeenCalledOnce();
    });

    it('short-circuits on timestamp failure (no signature or subscription check)', async () => {
      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT',
      });

      const result = await server.verifyCallback(
        makeResponse({ timestamp: Date.now() - 120_000 })
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Timestamp expired or invalid');
      expect(mockNaclVerify).not.toHaveBeenCalled();
      expect(mockGetTokenAccountBalance).not.toHaveBeenCalled();
    });

    it('short-circuits on signature failure (no subscription check)', async () => {
      mockNaclVerify.mockReturnValueOnce(false);

      const server = new P01AuthServer({
        ...defaultConfig(),
        subscriptionMint: 'MINT',
      });

      const result = await server.verifyCallback(makeResponse());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid signature');
      expect(mockGetTokenAccountBalance).not.toHaveBeenCalled();
    });
  });
});
