/**
 * Protocol Tests for P01 Auth SDK
 */

import { describe, it, expect } from 'vitest';
import {
  generateSessionId,
  generateChallenge,
  encodePayload,
  decodePayload,
  generateDeepLink,
  parseDeepLink,
  isAuthDeepLink,
  createSignMessage,
  isTimestampValid,
  isSessionExpired,
} from './protocol';
import { AuthQRPayload } from './types';

describe('Protocol Utilities', () => {
  describe('generateSessionId', () => {
    it('generates a 32-character hex string', () => {
      const id = generateSessionId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, generateSessionId));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateChallenge', () => {
    it('generates a 64-character hex string', () => {
      const challenge = generateChallenge();
      expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('encodePayload / decodePayload', () => {
    it('round-trips payload correctly', () => {
      const payload: AuthQRPayload = {
        v: 1,
        protocol: 'p01-auth',
        service: 'test-service',
        session: 'abc123',
        challenge: 'xyz789',
        callback: 'https://example.com/callback',
        exp: Date.now() + 300000,
        name: 'Test Service',
      };

      const encoded = encodePayload(payload);
      const decoded = decodePayload(encoded);

      expect(decoded).toEqual(payload);
    });

    it('throws on invalid protocol', () => {
      const invalidPayload = {
        v: 1,
        protocol: 'wrong-protocol',
        service: 'test',
        session: 'abc',
        challenge: 'xyz',
        callback: 'https://example.com',
        exp: Date.now(),
      };

      const encoded = btoa(JSON.stringify(invalidPayload))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      expect(() => decodePayload(encoded)).toThrow('Invalid protocol');
    });
  });

  describe('generateDeepLink / parseDeepLink', () => {
    it('generates valid deep link', () => {
      const payload: AuthQRPayload = {
        v: 1,
        protocol: 'p01-auth',
        service: 'test',
        session: 'session123',
        challenge: 'challenge456',
        callback: 'https://example.com/cb',
        exp: Date.now() + 300000,
      };

      const link = generateDeepLink(payload);
      expect(link).toMatch(/^p01:\/\/auth\?payload=/);
    });

    it('parses deep link back to payload', () => {
      const payload: AuthQRPayload = {
        v: 1,
        protocol: 'p01-auth',
        service: 'test',
        session: 'session123',
        challenge: 'challenge456',
        callback: 'https://example.com/cb',
        exp: Date.now() + 300000,
        name: 'Test',
      };

      const link = generateDeepLink(payload);
      const parsed = parseDeepLink(link);

      expect(parsed).toEqual(payload);
    });

    it('returns null for invalid links', () => {
      expect(parseDeepLink('https://google.com')).toBeNull();
      expect(parseDeepLink('p01://other?foo=bar')).toBeNull();
    });
  });

  describe('isAuthDeepLink', () => {
    it('detects p01:// scheme', () => {
      expect(isAuthDeepLink('p01://auth?payload=abc')).toBe(true);
    });

    it('detects https p01.app scheme', () => {
      expect(isAuthDeepLink('https://p01.app/auth?payload=abc')).toBe(true);
    });

    it('rejects other URLs', () => {
      expect(isAuthDeepLink('https://google.com')).toBe(false);
      expect(isAuthDeepLink('p01://other')).toBe(false);
    });
  });

  describe('createSignMessage', () => {
    it('creates properly formatted message', () => {
      const message = createSignMessage('netflix', 'session1', 'challenge1', 1234567890);
      expect(message).toBe('P01-AUTH:netflix:session1:challenge1:1234567890');
    });
  });

  describe('isTimestampValid', () => {
    it('accepts recent timestamps', () => {
      const recent = Date.now() - 30000; // 30 seconds ago
      expect(isTimestampValid(recent, 60000)).toBe(true);
    });

    it('rejects old timestamps', () => {
      const old = Date.now() - 120000; // 2 minutes ago
      expect(isTimestampValid(old, 60000)).toBe(false);
    });

    it('accepts slightly future timestamps', () => {
      const future = Date.now() + 3000; // 3 seconds in future
      expect(isTimestampValid(future, 60000)).toBe(true);
    });

    it('rejects far future timestamps', () => {
      const farFuture = Date.now() + 60000; // 1 minute in future
      expect(isTimestampValid(farFuture, 60000)).toBe(false);
    });
  });

  describe('isSessionExpired', () => {
    it('returns false for future expiration', () => {
      const future = Date.now() + 60000;
      expect(isSessionExpired(future)).toBe(false);
    });

    it('returns true for past expiration', () => {
      const past = Date.now() - 1000;
      expect(isSessionExpired(past)).toBe(true);
    });
  });
});

describe('Full Auth Flow', () => {
  it('simulates complete authentication', () => {
    // 1. Service creates session
    const sessionId = generateSessionId();
    const challenge = generateChallenge();
    const expiresAt = Date.now() + 300000;

    const payload: AuthQRPayload = {
      v: 1,
      protocol: 'p01-auth',
      service: 'netflix',
      session: sessionId,
      challenge,
      callback: 'https://netflix.com/auth/callback',
      exp: expiresAt,
      name: 'Netflix',
      mint: 'NFLXsubscription...',
    };

    // 2. Generate QR code data
    const deepLink = generateDeepLink(payload);
    expect(isAuthDeepLink(deepLink)).toBe(true);

    // 3. Mobile app scans and parses
    const parsedPayload = parseDeepLink(deepLink);
    expect(parsedPayload).not.toBeNull();
    expect(parsedPayload!.service).toBe('netflix');
    expect(parsedPayload!.session).toBe(sessionId);

    // 4. Mobile app creates sign message
    const timestamp = Date.now();
    const signMessage = createSignMessage(
      parsedPayload!.service,
      parsedPayload!.session,
      parsedPayload!.challenge,
      timestamp
    );
    expect(signMessage).toContain(sessionId);
    expect(signMessage).toContain(challenge);

    // 5. Verify session not expired
    expect(isSessionExpired(expiresAt)).toBe(false);
    expect(isTimestampValid(timestamp)).toBe(true);

    console.log('Full auth flow simulation passed!');
  });
});
