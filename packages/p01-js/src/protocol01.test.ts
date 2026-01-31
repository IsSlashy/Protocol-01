/**
 * Unit tests for the Protocol01 SDK class.
 *
 * These tests mock the browser environment (window, providers) to verify
 * the SDK's behavior for connect, disconnect, payments, subscriptions,
 * and event handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Protocol01 } from './protocol01';
import {
  Protocol01Error,
  Protocol01ErrorCode,
  type Protocol01Provider,
  type ConnectResult,
  type PaymentResult,
  type SubscriptionResult,
  type Subscription,
  type Protocol01Event,
} from './types';
import { TOKENS, DEFAULT_CONFIG } from './constants';

// ============================================================
// Mock Helpers
// ============================================================

/**
 * Create a mock Protocol01 native provider.
 */
function createMockProvider(overrides: Partial<Protocol01Provider> = {}): Protocol01Provider {
  return {
    isProtocol01: true,
    version: '1.0.0',
    connect: vi.fn().mockResolvedValue({
      publicKey: 'MockPublicKey123456789',
      supportsProtocol01: true,
    } satisfies ConnectResult),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockResolvedValue(true),
    getPublicKey: vi.fn().mockResolvedValue('MockPublicKey123456789'),
    requestPayment: vi.fn().mockResolvedValue({
      paymentId: 'pay_test_123',
      signature: 'sig_test_abc',
      amount: 15.99,
      token: 'USDC',
      isPrivate: false,
      confirmation: 'confirmed',
      timestamp: Date.now(),
      orderId: 'order_test_1',
    } satisfies PaymentResult),
    createSubscription: vi.fn().mockResolvedValue({
      subscriptionId: 'sub_test_123',
      address: 'addr_test_abc',
      signature: 'sig_sub_abc',
      firstPaymentMade: true,
      nextPaymentAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    } satisfies SubscriptionResult),
    getSubscriptions: vi.fn().mockResolvedValue([
      {
        id: 'sub_test_123',
        address: 'addr_test_abc',
        merchantId: 'test-merchant',
        merchantName: 'Test Merchant',
        tokenMint: TOKENS.USDC,
        tokenSymbol: 'USDC',
        amountPerPeriod: 15.99,
        periodSeconds: 2592000,
        maxPeriods: 12,
        periodsPaid: 1,
        totalPaid: 15.99,
        nextPaymentAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
        status: 'active',
      } satisfies Subscription,
    ]),
    cancelSubscription: vi.fn().mockResolvedValue({ success: true }),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a mock Solana provider (fallback).
 */
function createMockSolanaProvider() {
  return {
    connect: vi.fn().mockResolvedValue({
      publicKey: { toString: () => 'SolanaPublicKey12345' },
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signTransaction: vi.fn(),
    signAllTransactions: vi.fn(),
    signMessage: vi.fn(),
  };
}

/**
 * Set up the global window object with optional providers.
 */
function setupBrowserEnv(options: {
  protocol01Provider?: Protocol01Provider | null;
  solanaProvider?: ReturnType<typeof createMockSolanaProvider> | null;
} = {}) {
  const { protocol01Provider = null, solanaProvider = null } = options;

  // Create a minimal window mock
  const windowMock: Record<string, unknown> = {
    document: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  if (protocol01Provider) {
    windowMock['protocol01'] = protocol01Provider;
  }
  if (solanaProvider) {
    windowMock['solana'] = solanaProvider;
  }

  // Set global window
  (globalThis as any).window = windowMock;

  return windowMock;
}

/**
 * Clean up the global window object.
 */
function cleanupBrowserEnv() {
  delete (globalThis as any).window;
}

// Default valid merchant config for tests.
const VALID_CONFIG = {
  merchantId: 'test-merchant',
  merchantName: 'Test Merchant',
};

// ============================================================
// Constructor Tests
// ============================================================

describe('Protocol01 - constructor', () => {
  afterEach(() => {
    cleanupBrowserEnv();
    vi.restoreAllMocks();
  });

  it('should create an instance with valid config', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    expect(p01).toBeInstanceOf(Protocol01);
  });

  it('should apply default configuration values', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    const config = p01.getMerchantConfig();

    expect(config.merchantId).toBe('test-merchant');
    expect(config.merchantName).toBe('Test Merchant');
    expect(config.defaultToken).toBe(DEFAULT_CONFIG.defaultToken);
    expect(config.network).toBe(DEFAULT_CONFIG.network);
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
    expect(config.autoConnect).toBe(DEFAULT_CONFIG.autoConnect);
  });

  it('should override defaults with provided config values', () => {
    const p01 = new Protocol01({
      ...VALID_CONFIG,
      defaultToken: 'SOL',
      network: 'devnet',
      timeout: 30000,
      autoConnect: true,
    });
    const config = p01.getMerchantConfig();

    expect(config.defaultToken).toBe('SOL');
    expect(config.network).toBe('devnet');
    expect(config.timeout).toBe(30000);
    expect(config.autoConnect).toBe(true);
  });

  it('should store optional config fields', () => {
    const p01 = new Protocol01({
      ...VALID_CONFIG,
      merchantLogo: 'https://example.com/logo.png',
      merchantCategory: 'streaming',
      webhookUrl: 'https://api.example.com/webhook',
      rpcEndpoint: 'https://custom-rpc.example.com',
    });
    const config = p01.getMerchantConfig();

    expect(config.merchantLogo).toBe('https://example.com/logo.png');
    expect(config.merchantCategory).toBe('streaming');
    expect(config.webhookUrl).toBe('https://api.example.com/webhook');
    expect(config.rpcEndpoint).toBe('https://custom-rpc.example.com');
  });

  it('should throw Protocol01Error for missing merchantId', () => {
    expect(() => new Protocol01({
      merchantId: '',
      merchantName: 'Test',
    })).toThrow(Protocol01Error);
  });

  it('should throw Protocol01Error for missing merchantName', () => {
    expect(() => new Protocol01({
      merchantId: 'test-123',
      merchantName: '',
    })).toThrow(Protocol01Error);
  });

  it('should throw Protocol01Error for merchantId exceeding 64 chars', () => {
    expect(() => new Protocol01({
      merchantId: 'x'.repeat(65),
      merchantName: 'Test',
    })).toThrow(Protocol01Error);
  });

  it('should trigger provider initialization in browser environment', () => {
    const provider = createMockProvider();
    setupBrowserEnv({ protocol01Provider: provider });

    // Constructor should detect the browser and start initialization
    const p01 = new Protocol01(VALID_CONFIG);
    expect(p01).toBeInstanceOf(Protocol01);
  });
});

// ============================================================
// Connection Tests
// ============================================================

describe('Protocol01 - connect / disconnect', () => {
  let mockProvider: Protocol01Provider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = createMockProvider();
    setupBrowserEnv({ protocol01Provider: mockProvider });
  });

  afterEach(() => {
    cleanupBrowserEnv();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should connect using Protocol01 native provider', async () => {
    const p01 = new Protocol01(VALID_CONFIG);

    // Advance timers to complete the provider detection timeout
    await vi.advanceTimersByTimeAsync(3100);

    const result = await p01.connect();

    expect(result.publicKey).toBe('MockPublicKey123456789');
    expect(result.supportsProtocol01).toBe(true);
    expect(p01.isConnected()).toBe(true);
    expect(p01.getPublicKey()).toBe('MockPublicKey123456789');
  });

  it('should disconnect and reset state', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    await p01.connect();
    expect(p01.isConnected()).toBe(true);

    await p01.disconnect();
    expect(p01.isConnected()).toBe(false);
    expect(p01.getPublicKey()).toBeNull();
    expect(mockProvider.disconnect).toHaveBeenCalled();
  });

  it('should throw WALLET_NOT_INSTALLED when no provider is available', async () => {
    cleanupBrowserEnv();
    // No browser env - no providers
    const p01 = new Protocol01(VALID_CONFIG);

    await expect(p01.connect()).rejects.toThrow(Protocol01Error);
    await expect(p01.connect()).rejects.toThrow('No compatible wallet found');
  });

  it('should connect via Solana provider as fallback', async () => {
    cleanupBrowserEnv();
    const solanaProvider = createMockSolanaProvider();
    setupBrowserEnv({ solanaProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    const result = await p01.connect();

    expect(result.publicKey).toBe('SolanaPublicKey12345');
    expect(result.supportsProtocol01).toBe(false);
    expect(p01.isConnected()).toBe(true);
  });

  it('should throw CONNECTION_REJECTED when user rejects connection', async () => {
    const rejectingProvider = createMockProvider({
      connect: vi.fn().mockRejectedValue(new Error('User rejected the request')),
    });
    cleanupBrowserEnv();
    setupBrowserEnv({ protocol01Provider: rejectingProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    try {
      await p01.connect();
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Protocol01Error);
      expect((error as Protocol01Error).code).toBe(Protocol01ErrorCode.CONNECTION_REJECTED);
      expect((error as Protocol01Error).recoverable).toBe(true);
    }
  });

  it('should wrap unknown errors during connect', async () => {
    const failingProvider = createMockProvider({
      connect: vi.fn().mockRejectedValue(new Error('Unknown network issue')),
    });
    cleanupBrowserEnv();
    setupBrowserEnv({ protocol01Provider: failingProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    try {
      await p01.connect();
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Protocol01Error);
      expect((error as Protocol01Error).code).toBe(Protocol01ErrorCode.UNKNOWN);
    }
  });

  it('should return false for isConnected before connecting', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    expect(p01.isConnected()).toBe(false);
  });

  it('should return null for getPublicKey before connecting', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    expect(p01.getPublicKey()).toBeNull();
  });
});

// ============================================================
// Payment Tests
// ============================================================

describe('Protocol01 - requestPayment', () => {
  let mockProvider: Protocol01Provider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = createMockProvider();
    setupBrowserEnv({ protocol01Provider: mockProvider });
  });

  afterEach(() => {
    cleanupBrowserEnv();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should request a payment successfully', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const result = await p01.requestPayment({
      amount: 15.99,
      description: 'Test Payment',
    });

    expect(result.paymentId).toBe('pay_test_123');
    expect(result.signature).toBe('sig_test_abc');
    expect(mockProvider.requestPayment).toHaveBeenCalledOnce();
  });

  it('should pass merchant info in the internal payment request', async () => {
    const p01 = new Protocol01({
      ...VALID_CONFIG,
      merchantLogo: 'https://example.com/logo.png',
      merchantCategory: 'streaming',
    });
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.requestPayment({
      amount: 9.99,
      description: 'Test',
    });

    const callArg = (mockProvider.requestPayment as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.merchantId).toBe('test-merchant');
    expect(callArg.merchantName).toBe('Test Merchant');
    expect(callArg.merchantLogo).toBe('https://example.com/logo.png');
    expect(callArg.merchantCategory).toBe('streaming');
  });

  it('should resolve token mint and convert amount to raw units', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.requestPayment({
      amount: 15.99,
      token: 'USDC',
    });

    const callArg = (mockProvider.requestPayment as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.tokenMint).toBe(TOKENS.USDC);
    expect(callArg.amount).toBe(15990000); // 15.99 * 10^6
  });

  it('should use default token when none is specified', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.requestPayment({
      amount: 10,
    });

    const callArg = (mockProvider.requestPayment as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.tokenMint).toBe(TOKENS.USDC);
  });

  it('should generate an orderId when none is provided', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.requestPayment({
      amount: 5,
    });

    const callArg = (mockProvider.requestPayment as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.orderId).toMatch(/^order_/);
  });

  it('should use the provided orderId', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.requestPayment({
      amount: 5,
      orderId: 'my-custom-order',
    });

    const callArg = (mockProvider.requestPayment as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.orderId).toBe('my-custom-order');
  });

  it('should throw WALLET_NOT_CONNECTED when not connected', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    // Do not connect

    await expect(p01.requestPayment({
      amount: 10,
    })).rejects.toThrow(Protocol01Error);

    try {
      await p01.requestPayment({ amount: 10 });
    } catch (error) {
      expect((error as Protocol01Error).code).toBe(Protocol01ErrorCode.WALLET_NOT_CONNECTED);
    }
  });

  it('should throw INVALID_AMOUNT for zero amount', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await expect(p01.requestPayment({
      amount: 0,
    })).rejects.toThrow(Protocol01Error);
  });

  it('should throw INVALID_AMOUNT for negative amount', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await expect(p01.requestPayment({
      amount: -5,
    })).rejects.toThrow('Amount must be greater than 0');
  });

  it('should throw PAYMENT_REJECTED when user rejects payment', async () => {
    const rejectProvider = createMockProvider({
      requestPayment: vi.fn().mockRejectedValue(new Error('User rejected the request')),
    });
    cleanupBrowserEnv();
    setupBrowserEnv({ protocol01Provider: rejectProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    try {
      await p01.requestPayment({ amount: 10 });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Protocol01Error);
      expect((error as Protocol01Error).code).toBe(Protocol01ErrorCode.PAYMENT_REJECTED);
    }
  });

  it('should pass metadata and memo to the provider', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.requestPayment({
      amount: 10,
      metadata: { planType: 'premium', userId: '12345' },
      memo: 'Netflix Premium Monthly',
    });

    const callArg = (mockProvider.requestPayment as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.metadata).toEqual({ planType: 'premium', userId: '12345' });
    expect(callArg.memo).toBe('Netflix Premium Monthly');
  });

  it('should pass useStealthAddress option', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.requestPayment({
      amount: 10,
      useStealthAddress: true,
    });

    const callArg = (mockProvider.requestPayment as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.useStealthAddress).toBe(true);
  });
});

// ============================================================
// Subscription Tests
// ============================================================

describe('Protocol01 - createSubscription', () => {
  let mockProvider: Protocol01Provider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = createMockProvider();
    setupBrowserEnv({ protocol01Provider: mockProvider });
  });

  afterEach(() => {
    cleanupBrowserEnv();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should create a subscription successfully', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const result = await p01.createSubscription({
      amount: 15.99,
      interval: 'monthly',
      description: 'Test Plan',
    });

    expect(result.subscriptionId).toBe('sub_test_123');
    expect(result.address).toBe('addr_test_abc');
    expect(result.firstPaymentMade).toBe(true);
    expect(mockProvider.createSubscription).toHaveBeenCalledOnce();
  });

  it('should resolve interval and convert to internal format', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.createSubscription({
      amount: 15.99,
      interval: 'monthly',
    });

    const callArg = (mockProvider.createSubscription as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.periodSeconds).toBe(2592000); // monthly
    expect(callArg.tokenMint).toBe(TOKENS.USDC);
    expect(callArg.amountPerPeriod).toBe(15990000); // 15.99 * 10^6
  });

  it('should pass maxPayments as maxPeriods (0 default for unlimited)', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.createSubscription({
      amount: 10,
      interval: 'monthly',
    });

    const callArg = (mockProvider.createSubscription as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.maxPeriods).toBe(0); // unlimited
  });

  it('should pass specified maxPayments', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.createSubscription({
      amount: 10,
      interval: 'monthly',
      maxPayments: 12,
    });

    const callArg = (mockProvider.createSubscription as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.maxPeriods).toBe(12);
  });

  it('should normalize privacy options', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.createSubscription({
      amount: 10,
      interval: 'monthly',
      suggestedPrivacy: {
        amountNoise: 50,  // Should be clamped to 25
        timingNoise: 2,
        useStealthAddress: true,
      },
    });

    const callArg = (mockProvider.createSubscription as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.suggestedPrivacy.amountNoise).toBe(25); // clamped
    expect(callArg.suggestedPrivacy.timingNoise).toBe(2);
    expect(callArg.suggestedPrivacy.useStealthAddress).toBe(true);
  });

  it('should throw WALLET_NOT_CONNECTED when not connected', async () => {
    const p01 = new Protocol01(VALID_CONFIG);

    await expect(p01.createSubscription({
      amount: 10,
      interval: 'monthly',
    })).rejects.toThrow(Protocol01Error);
  });

  it('should throw INVALID_AMOUNT for invalid amounts', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await expect(p01.createSubscription({
      amount: -5,
      interval: 'monthly',
    })).rejects.toThrow(Protocol01Error);
  });

  it('should throw INVALID_INTERVAL for invalid intervals', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await expect(p01.createSubscription({
      amount: 10,
      interval: 100, // too short (less than 3600s)
    })).rejects.toThrow(Protocol01Error);
  });

  it('should require Protocol01 wallet for subscriptions (not Solana fallback)', async () => {
    cleanupBrowserEnv();
    const solanaProvider = createMockSolanaProvider();
    setupBrowserEnv({ solanaProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    try {
      await p01.createSubscription({
        amount: 10,
        interval: 'monthly',
      });
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Protocol01Error);
      expect((error as Protocol01Error).code).toBe(Protocol01ErrorCode.WALLET_NOT_INSTALLED);
    }
  });

  it('should pass merchant info in subscription request', async () => {
    const p01 = new Protocol01({
      ...VALID_CONFIG,
      merchantCategory: 'streaming',
      webhookUrl: 'https://hooks.example.com/p01',
    });
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.createSubscription({
      amount: 10,
      interval: 'monthly',
      description: 'Pro Plan',
      subscriptionRef: 'ref-123',
    });

    const callArg = (mockProvider.createSubscription as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.merchantId).toBe('test-merchant');
    expect(callArg.merchantName).toBe('Test Merchant');
    expect(callArg.merchantCategory).toBe('streaming');
    expect(callArg.webhookUrl).toBe('https://hooks.example.com/p01');
    expect(callArg.description).toBe('Pro Plan');
    expect(callArg.subscriptionRef).toBe('ref-123');
  });
});

// ============================================================
// getSubscriptions / getSubscription / cancelSubscription
// ============================================================

describe('Protocol01 - subscription management', () => {
  let mockProvider: Protocol01Provider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = createMockProvider();
    setupBrowserEnv({ protocol01Provider: mockProvider });
  });

  afterEach(() => {
    cleanupBrowserEnv();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should get subscriptions for the merchant', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const subs = await p01.getSubscriptions();

    expect(subs).toHaveLength(1);
    expect(subs[0]!.id).toBe('sub_test_123');
    expect(subs[0]!.status).toBe('active');
    expect(mockProvider.getSubscriptions).toHaveBeenCalledWith('test-merchant');
  });

  it('should return empty array when using Solana fallback (no native provider)', async () => {
    cleanupBrowserEnv();
    const solanaProvider = createMockSolanaProvider();
    setupBrowserEnv({ solanaProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const subs = await p01.getSubscriptions();
    expect(subs).toEqual([]);
  });

  it('should get a specific subscription by ID', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const sub = await p01.getSubscription('sub_test_123');
    expect(sub).not.toBeNull();
    expect(sub!.id).toBe('sub_test_123');
  });

  it('should return null for a non-existent subscription ID', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const sub = await p01.getSubscription('non-existent-id');
    expect(sub).toBeNull();
  });

  it('should cancel a subscription', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await p01.cancelSubscription('sub_test_123');
    expect(mockProvider.cancelSubscription).toHaveBeenCalledWith('sub_test_123');
  });

  it('should throw WALLET_NOT_CONNECTED for getSubscriptions when not connected', async () => {
    const p01 = new Protocol01(VALID_CONFIG);

    await expect(p01.getSubscriptions()).rejects.toThrow(Protocol01Error);
  });

  it('should throw WALLET_NOT_INSTALLED for cancelSubscription without native provider', async () => {
    cleanupBrowserEnv();
    const solanaProvider = createMockSolanaProvider();
    setupBrowserEnv({ solanaProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    await expect(p01.cancelSubscription('sub-1')).rejects.toThrow(Protocol01Error);
  });
});

// ============================================================
// Event System Tests
// ============================================================

describe('Protocol01 - event system', () => {
  let mockProvider: Protocol01Provider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = createMockProvider();
    setupBrowserEnv({ protocol01Provider: mockProvider });
  });

  afterEach(() => {
    cleanupBrowserEnv();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should emit "connect" event on successful connection', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    const connectHandler = vi.fn();
    p01.on('connect', connectHandler);

    await p01.connect();

    expect(connectHandler).toHaveBeenCalledOnce();
    const event = connectHandler.mock.calls[0]![0] as Protocol01Event<ConnectResult>;
    expect(event.type).toBe('connect');
    expect(event.data.publicKey).toBe('MockPublicKey123456789');
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it('should emit "disconnect" event on disconnection', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const disconnectHandler = vi.fn();
    p01.on('disconnect', disconnectHandler);

    await p01.disconnect();

    expect(disconnectHandler).toHaveBeenCalledOnce();
    expect(disconnectHandler.mock.calls[0]![0].type).toBe('disconnect');
  });

  it('should emit "paymentComplete" event on successful payment', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const paymentHandler = vi.fn();
    p01.on('paymentComplete', paymentHandler);

    await p01.requestPayment({ amount: 10 });

    expect(paymentHandler).toHaveBeenCalledOnce();
    const event = paymentHandler.mock.calls[0]![0];
    expect(event.type).toBe('paymentComplete');
    expect(event.data.paymentId).toBe('pay_test_123');
  });

  it('should emit "paymentFailed" event when payment fails', async () => {
    const failingProvider = createMockProvider({
      requestPayment: vi.fn().mockRejectedValue(new Error('Insufficient funds')),
    });
    cleanupBrowserEnv();
    setupBrowserEnv({ protocol01Provider: failingProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const failHandler = vi.fn();
    p01.on('paymentFailed', failHandler);

    try {
      await p01.requestPayment({ amount: 10 });
    } catch {
      // Expected to throw
    }

    expect(failHandler).toHaveBeenCalledOnce();
    expect(failHandler.mock.calls[0]![0].type).toBe('paymentFailed');
  });

  it('should emit "subscriptionCreated" event on successful subscription creation', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const subHandler = vi.fn();
    p01.on('subscriptionCreated', subHandler);

    await p01.createSubscription({
      amount: 10,
      interval: 'monthly',
    });

    expect(subHandler).toHaveBeenCalledOnce();
    expect(subHandler.mock.calls[0]![0].type).toBe('subscriptionCreated');
    expect(subHandler.mock.calls[0]![0].data.subscriptionId).toBe('sub_test_123');
  });

  it('should emit "subscriptionCancelled" event when a subscription is cancelled', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const cancelHandler = vi.fn();
    p01.on('subscriptionCancelled', cancelHandler);

    await p01.cancelSubscription('sub_test_123');

    expect(cancelHandler).toHaveBeenCalledOnce();
    expect(cancelHandler.mock.calls[0]![0].type).toBe('subscriptionCancelled');
    expect(cancelHandler.mock.calls[0]![0].data.subscriptionId).toBe('sub_test_123');
  });

  it('should support unsubscribing via the returned function', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    const handler = vi.fn();
    const unsubscribe = p01.on('connect', handler);

    await p01.connect();
    expect(handler).toHaveBeenCalledOnce();

    // Unsubscribe
    unsubscribe();

    // Disconnect and reconnect to trigger another connect event
    await p01.disconnect();
    await p01.connect();

    // Handler should still only have been called once
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should support unsubscribing via the off method', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    const handler = vi.fn();
    p01.on('connect', handler);
    p01.off('connect', handler);

    await p01.connect();

    expect(handler).not.toHaveBeenCalled();
  });

  it('should support multiple listeners for the same event', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    const handler1 = vi.fn();
    const handler2 = vi.fn();
    p01.on('connect', handler1);
    p01.on('connect', handler2);

    await p01.connect();

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it('should not propagate errors from event handlers', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const badHandler = vi.fn().mockImplementation(() => {
      throw new Error('Handler error');
    });
    const goodHandler = vi.fn();

    p01.on('connect', badHandler);
    p01.on('connect', goodHandler);

    // Should not throw despite the bad handler
    await p01.connect();

    expect(badHandler).toHaveBeenCalledOnce();
    expect(goodHandler).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('should include timestamp in all events', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);

    const handler = vi.fn();
    p01.on('connect', handler);

    const before = Date.now();
    await p01.connect();

    const event = handler.mock.calls[0]![0] as Protocol01Event;
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
  });
});

// ============================================================
// Static Methods Tests
// ============================================================

describe('Protocol01 - static methods', () => {
  afterEach(() => {
    cleanupBrowserEnv();
    vi.restoreAllMocks();
  });

  it('isInstalled should return false when no browser environment', () => {
    expect(Protocol01.isInstalled()).toBe(false);
  });

  it('isInstalled should return true when Protocol01 provider is available', () => {
    const provider = createMockProvider();
    setupBrowserEnv({ protocol01Provider: provider });
    expect(Protocol01.isInstalled()).toBe(true);
  });

  it('isInstalled should return true when Solana provider is available', () => {
    const solanaProvider = createMockSolanaProvider();
    setupBrowserEnv({ solanaProvider });
    expect(Protocol01.isInstalled()).toBe(true);
  });

  it('getInstallUrl should return the wallet install URL', () => {
    expect(Protocol01.getInstallUrl()).toBe('https://protocol01.com/wallet');
  });
});

// ============================================================
// Config Management Tests
// ============================================================

describe('Protocol01 - updateConfig / getMerchantConfig', () => {
  afterEach(() => {
    cleanupBrowserEnv();
    vi.restoreAllMocks();
  });

  it('should return a copy of the config (not a reference)', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    const config1 = p01.getMerchantConfig();
    const config2 = p01.getMerchantConfig();

    expect(config1).toEqual(config2);
    expect(config1).not.toBe(config2); // Different object references
  });

  it('should update merchantName', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    p01.updateConfig({ merchantName: 'New Name' });
    expect(p01.getMerchantConfig().merchantName).toBe('New Name');
  });

  it('should update merchantLogo', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    p01.updateConfig({ merchantLogo: 'https://new-logo.com/img.png' });
    expect(p01.getMerchantConfig().merchantLogo).toBe('https://new-logo.com/img.png');
  });

  it('should update merchantCategory', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    p01.updateConfig({ merchantCategory: 'gaming' });
    expect(p01.getMerchantConfig().merchantCategory).toBe('gaming');
  });

  it('should update webhookUrl', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    p01.updateConfig({ webhookUrl: 'https://hooks.example.com/new' });
    expect(p01.getMerchantConfig().webhookUrl).toBe('https://hooks.example.com/new');
  });

  it('should update defaultToken', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    p01.updateConfig({ defaultToken: 'SOL' });
    expect(p01.getMerchantConfig().defaultToken).toBe('SOL');
  });

  it('should not change merchantId (it is omitted from updateConfig type)', () => {
    const p01 = new Protocol01(VALID_CONFIG);
    // merchantId is not in the Partial<Omit<MerchantConfig, 'merchantId'>> type
    // so passing it would have no effect even if we force it
    p01.updateConfig({} as any);
    expect(p01.getMerchantConfig().merchantId).toBe('test-merchant');
  });

  it('should not affect fields that are not being updated', () => {
    const p01 = new Protocol01({
      ...VALID_CONFIG,
      merchantLogo: 'https://original-logo.com/img.png',
      webhookUrl: 'https://original-hook.com',
    });

    p01.updateConfig({ merchantName: 'Updated Name' });

    const config = p01.getMerchantConfig();
    expect(config.merchantName).toBe('Updated Name');
    expect(config.merchantLogo).toBe('https://original-logo.com/img.png');
    expect(config.webhookUrl).toBe('https://original-hook.com');
  });
});

// ============================================================
// Wallet Info Tests
// ============================================================

describe('Protocol01 - getWalletInfo', () => {
  let mockProvider: Protocol01Provider;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProvider = createMockProvider();
    setupBrowserEnv({ protocol01Provider: mockProvider });
  });

  afterEach(() => {
    cleanupBrowserEnv();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should return null when not connected', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    const info = await p01.getWalletInfo();
    expect(info).toBeNull();
  });

  it('should return Protocol01 wallet info when using native provider', async () => {
    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const info = await p01.getWalletInfo();

    expect(info).not.toBeNull();
    expect(info!.name).toBe('Protocol 01');
    expect(info!.isProtocol01Compatible).toBe(true);
    expect(info!.publicKey).toBe('MockPublicKey123456789');
    expect(info!.features).toContain('payments');
    expect(info!.features).toContain('subscriptions');
    expect(info!.features).toContain('stealth-addresses');
    expect(info!.features).toContain('privacy-options');
    expect(info!.features).toContain('webhooks');
  });

  it('should return Solana wallet info when using fallback provider', async () => {
    cleanupBrowserEnv();
    const solanaProvider = createMockSolanaProvider();
    setupBrowserEnv({ solanaProvider });

    const p01 = new Protocol01(VALID_CONFIG);
    await vi.advanceTimersByTimeAsync(3100);
    await p01.connect();

    const info = await p01.getWalletInfo();

    expect(info).not.toBeNull();
    expect(info!.name).toBe('Solana Wallet');
    expect(info!.isProtocol01Compatible).toBe(false);
    expect(info!.features).toContain('payments');
  });
});

// ============================================================
// Protocol01Error Tests
// ============================================================

describe('Protocol01Error', () => {
  it('should be an instance of Error', () => {
    const error = new Protocol01Error(
      Protocol01ErrorCode.UNKNOWN,
      'Test error'
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(Protocol01Error);
  });

  it('should have the correct name', () => {
    const error = new Protocol01Error(
      Protocol01ErrorCode.UNKNOWN,
      'Test error'
    );
    expect(error.name).toBe('Protocol01Error');
  });

  it('should store the error code', () => {
    const error = new Protocol01Error(
      Protocol01ErrorCode.WALLET_NOT_CONNECTED,
      'Not connected'
    );
    expect(error.code).toBe(Protocol01ErrorCode.WALLET_NOT_CONNECTED);
  });

  it('should store the message', () => {
    const error = new Protocol01Error(
      Protocol01ErrorCode.UNKNOWN,
      'Custom message'
    );
    expect(error.message).toBe('Custom message');
  });

  it('should default recoverable to false', () => {
    const error = new Protocol01Error(
      Protocol01ErrorCode.UNKNOWN,
      'Test'
    );
    expect(error.recoverable).toBe(false);
  });

  it('should accept recoverable option', () => {
    const error = new Protocol01Error(
      Protocol01ErrorCode.WALLET_NOT_INSTALLED,
      'Install wallet',
      { recoverable: true }
    );
    expect(error.recoverable).toBe(true);
  });

  it('should accept details option', () => {
    const originalError = new Error('Original');
    const error = new Protocol01Error(
      Protocol01ErrorCode.UNKNOWN,
      'Wrapped error',
      { details: originalError }
    );
    expect(error.details).toBe(originalError);
  });

  it('should check error code via is() method', () => {
    const error = new Protocol01Error(
      Protocol01ErrorCode.PAYMENT_REJECTED,
      'Rejected'
    );
    expect(error.is(Protocol01ErrorCode.PAYMENT_REJECTED)).toBe(true);
    expect(error.is(Protocol01ErrorCode.UNKNOWN)).toBe(false);
  });

  it('should serialize to JSON correctly', () => {
    const error = new Protocol01Error(
      Protocol01ErrorCode.INVALID_AMOUNT,
      'Amount too high',
      { details: { max: 1000000 }, recoverable: true }
    );

    const json = error.toJSON();

    expect(json.name).toBe('Protocol01Error');
    expect(json.code).toBe(Protocol01ErrorCode.INVALID_AMOUNT);
    expect(json.message).toBe('Amount too high');
    expect(json.details).toEqual({ max: 1000000 });
    expect(json.recoverable).toBe(true);
  });
});
