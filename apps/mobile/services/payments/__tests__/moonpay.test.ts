/**
 * MoonPay service tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMoonPayUrl,
  signMoonPayUrl,
  loadMoonPayConfigFromEnv,
  type MoonPayConfig,
  type MoonPayBuyParams,
} from '../moonpay';

const baseParams: MoonPayBuyParams = {
  fiatAmount: 100,
  fiatCurrency: 'EUR',
  cryptoCurrency: 'sol',
  stealthAddress: 'StealthAbc123XYZ',
  userEmail: 'user@example.com',
};

describe('signMoonPayUrl', () => {
  it('is deterministic for the same inputs', () => {
    const q = '?apiKey=pk_test_abc&baseCurrencyAmount=100&baseCurrencyCode=eur';
    const sig1 = signMoonPayUrl(q, 'sk_test_secret');
    const sig2 = signMoonPayUrl(q, 'sk_test_secret');
    expect(sig1).toBe(sig2);
    expect(sig1.length).toBeGreaterThan(0);
  });

  it('changes when secret changes', () => {
    const q = '?apiKey=pk_test_abc';
    expect(signMoonPayUrl(q, 'sk_a')).not.toBe(signMoonPayUrl(q, 'sk_b'));
  });

  it('changes when query changes', () => {
    const s = 'sk_test_x';
    expect(signMoonPayUrl('?a=1', s)).not.toBe(signMoonPayUrl('?a=2', s));
  });

  it('throws when secret is empty', () => {
    expect(() => signMoonPayUrl('?a=1', '')).toThrow(/secretKey/);
  });

  it('accepts full URL and extracts query', () => {
    const full = 'https://buy.moonpay.com?apiKey=pk_test&foo=bar';
    const query = '?apiKey=pk_test&foo=bar';
    expect(signMoonPayUrl(full, 'sk_test_x')).toBe(signMoonPayUrl(query, 'sk_test_x'));
  });
});

describe('createMoonPayUrl', () => {
  const configLive: MoonPayConfig = {
    mode: 'live',
    apiKey: 'pk_live_abc',
    secretKey: 'sk_live_secret',
  };
  const configSandbox: MoonPayConfig = {
    mode: 'sandbox',
    apiKey: 'pk_test_abc',
    secretKey: 'sk_test_secret',
  };
  const configSandboxNoSecret: MoonPayConfig = {
    mode: 'sandbox',
    apiKey: 'pk_test_abc',
  };

  it('uses live base URL in live mode', () => {
    const { widgetUrl } = createMoonPayUrl(baseParams, configLive);
    expect(widgetUrl.startsWith('https://buy.moonpay.com?')).toBe(true);
  });

  it('uses sandbox base URL in sandbox mode', () => {
    const { widgetUrl } = createMoonPayUrl(baseParams, configSandbox);
    expect(widgetUrl.startsWith('https://buy-sandbox.moonpay.com?')).toBe(true);
  });

  it('includes all required params', () => {
    const { widgetUrl } = createMoonPayUrl(baseParams, configSandbox);
    expect(widgetUrl).toContain('apiKey=pk_test_abc');
    expect(widgetUrl).toContain('currencyCode=sol');
    expect(widgetUrl).toContain('walletAddress=StealthAbc123XYZ');
    expect(widgetUrl).toContain('baseCurrencyCode=eur');
    expect(widgetUrl).toContain('baseCurrencyAmount=100');
    expect(widgetUrl).toContain('email=user%40example.com');
  });

  it('appends signature when secret is set', () => {
    const res = createMoonPayUrl(baseParams, configSandbox);
    expect(res.signed).toBe(true);
    expect(res.widgetUrl).toMatch(/[&?]signature=/);
  });

  it('omits signature and warns when no secret', () => {
    const res = createMoonPayUrl(baseParams, configSandboxNoSecret);
    expect(res.signed).toBe(false);
    expect(res.widgetUrl).not.toContain('signature=');
  });

  it('returns a UUID-v4 session id', () => {
    const { sessionId } = createMoonPayUrl(baseParams, configSandbox);
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('throws when stealthAddress missing', () => {
    expect(() =>
      createMoonPayUrl({ ...baseParams, stealthAddress: '' }, configSandbox),
    ).toThrow(/stealthAddress/);
  });

  it('throws when fiat amount invalid', () => {
    expect(() =>
      createMoonPayUrl({ ...baseParams, fiatAmount: 0 }, configSandbox),
    ).toThrow(/fiatAmount/);
  });

  it('throws when apiKey missing', () => {
    expect(() =>
      createMoonPayUrl(baseParams, { ...configSandbox, apiKey: '' }),
    ).toThrow(/apiKey/);
  });
});

describe('loadMoonPayConfigFromEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.EXPO_PUBLIC_MOONPAY_API_KEY;
    delete process.env.EXPO_PUBLIC_MOONPAY_SECRET_KEY;
    delete process.env.EXPO_PUBLIC_MOONPAY_MODE;
  });

  it('throws when api key is missing', () => {
    expect(() => loadMoonPayConfigFromEnv()).toThrow(/EXPO_PUBLIC_MOONPAY_API_KEY/);
  });

  it('returns config with sandbox default mode', () => {
    process.env.EXPO_PUBLIC_MOONPAY_API_KEY = 'pk_test_abc';
    const c = loadMoonPayConfigFromEnv();
    expect(c.mode).toBe('sandbox');
    expect(c.apiKey).toBe('pk_test_abc');
    expect(c.secretKey).toBeUndefined();
  });

  it('reads live mode and secret key from env', () => {
    process.env.EXPO_PUBLIC_MOONPAY_API_KEY = 'pk_live_abc';
    process.env.EXPO_PUBLIC_MOONPAY_SECRET_KEY = 'sk_live_xyz';
    process.env.EXPO_PUBLIC_MOONPAY_MODE = 'live';
    const c = loadMoonPayConfigFromEnv();
    expect(c.mode).toBe('live');
    expect(c.secretKey).toBe('sk_live_xyz');
  });

  it('throws on invalid mode', () => {
    process.env.EXPO_PUBLIC_MOONPAY_API_KEY = 'pk_test_abc';
    process.env.EXPO_PUBLIC_MOONPAY_MODE = 'prod';
    expect(() => loadMoonPayConfigFromEnv()).toThrow(/mode/i);
  });
});
