import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  sanitizeCountry,
  sanitizeInterest,
  sanitizeLocale,
  sanitizeSource,
  sha256Hex,
  tokenHash,
  isTokenShape,
} from '@/lib/waitlist/validate';

describe('sanitizeCountry() -- ISO alpha-2 guard', () => {
  it('uppercases and accepts a two-letter code', () => {
    expect(sanitizeCountry('fr')).toBe('FR');
    expect(sanitizeCountry('JP')).toBe('JP');
    expect(sanitizeCountry(' us ')).toBe('US');
  });

  it('drops anything that is not exactly two letters', () => {
    expect(sanitizeCountry('FRA')).toBeUndefined();
    expect(sanitizeCountry('F')).toBeUndefined();
    expect(sanitizeCountry('12')).toBeUndefined();
    expect(sanitizeCountry('')).toBeUndefined();
    expect(sanitizeCountry(null)).toBeUndefined();
    expect(sanitizeCountry(undefined)).toBeUndefined();
  });
});

describe('normalizeEmail() -- waitlist email validation', () => {
  it('accepts a plain valid email unchanged', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('lowercases the address', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
  });

  it('rejects an address with an internal space', () => {
    expect(normalizeEmail('us er@example.com')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
  });

  it('rejects an address longer than 254 chars', () => {
    const long = `${'a'.repeat(250)}@x.co`; // 255 chars total
    expect(long.length).toBeGreaterThan(254);
    expect(normalizeEmail(long)).toBeNull();
  });

  it('accepts an address of exactly 254 chars', () => {
    const local = 'a'.repeat(254 - '@x.co'.length);
    const at254 = `${local}@x.co`;
    expect(at254.length).toBe(254);
    expect(normalizeEmail(at254)).toBe(at254);
  });

  it('rejects an address with no @', () => {
    expect(normalizeEmail('userexample.com')).toBeNull();
  });

  it('rejects an address with a double @', () => {
    expect(normalizeEmail('user@@example.com')).toBeNull();
  });

  it('rejects an address with no dot in the domain', () => {
    expect(normalizeEmail('user@example')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});

describe('sanitizeInterest() -- enum guard', () => {
  it('passes through each known interest', () => {
    for (const i of ['mobile', 'extension', 'sdk']) {
      expect(sanitizeInterest(i)).toBe(i);
    }
  });

  it('drops an unknown interest', () => {
    expect(sanitizeInterest('gaming')).toBeUndefined();
    // 'merchant' was removed from the offer (no consumable API/merchant tools)
    expect(sanitizeInterest('merchant')).toBeUndefined();
  });

  it('drops non-string input', () => {
    expect(sanitizeInterest(123)).toBeUndefined();
    expect(sanitizeInterest(undefined)).toBeUndefined();
  });
});

describe('sanitizeLocale() -- locale coercion', () => {
  it('passes through each supported locale', () => {
    expect(sanitizeLocale('en')).toBe('en');
    expect(sanitizeLocale('fr')).toBe('fr');
  });

  it('defaults unknown or missing locales to en', () => {
    expect(sanitizeLocale('de')).toBe('en');
    expect(sanitizeLocale(undefined)).toBe('en');
    expect(sanitizeLocale(999)).toBe('en');
  });

  /**
   * Japanese was dropped on 2026-08-11. Records signed up before then can still
   * carry locale 'ja' in KV, so the coercion has to land them somewhere valid
   * rather than leaking an unsupported value into the email copy lookup. This is
   * the legacy path, and it is the reason lib/waitlist/email.ts routes every
   * lookup through copyFor().
   */
  it('folds the retired ja locale into en rather than passing it through', () => {
    expect(sanitizeLocale('ja')).toBe('en');
  });
});

describe('sanitizeSource() -- attribution source', () => {
  it('lowercases and keeps allowed characters', () => {
    expect(sanitizeSource('Twitter')).toBe('twitter');
    expect(sanitizeSource('newsletter_2026')).toBe('newsletter_2026');
    expect(sanitizeSource('utm:launch/hero-cta')).toBe('utm:launch/hero-cta');
  });

  it('strips disallowed characters', () => {
    expect(sanitizeSource('hello world!')).toBe('helloworld');
    expect(sanitizeSource('a@b#c')).toBe('abc');
  });

  it('caps the result at 64 chars', () => {
    const out = sanitizeSource('a'.repeat(200));
    expect(out).toHaveLength(64);
  });

  it('returns undefined when nothing survives sanitizing', () => {
    expect(sanitizeSource('!!!')).toBeUndefined();
    expect(sanitizeSource('')).toBeUndefined();
    expect(sanitizeSource(undefined)).toBeUndefined();
  });
});

describe('sha256Hex() / tokenHash() -- deterministic hashing', () => {
  it('matches known SHA-256 test vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic for the same input', () => {
    expect(sha256Hex('protocol-01')).toBe(sha256Hex('protocol-01'));
  });

  it('produces different digests for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });

  it('tokenHash is the sha256 of the token', () => {
    const token = 'deadbeef'.repeat(8);
    expect(tokenHash(token)).toBe(sha256Hex(token));
    expect(tokenHash(token)).toHaveLength(64);
  });
});

describe('isTokenShape() -- token format guard', () => {
  it('accepts a 64-char lowercase hex string', () => {
    expect(isTokenShape('a'.repeat(64))).toBe(true);
    expect(isTokenShape('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('rejects wrong length, uppercase, or non-hex', () => {
    expect(isTokenShape('a'.repeat(63))).toBe(false);
    expect(isTokenShape('a'.repeat(65))).toBe(false);
    expect(isTokenShape('A'.repeat(64))).toBe(false);
    expect(isTokenShape('g'.repeat(64))).toBe(false);
    expect(isTokenShape(undefined)).toBe(false);
  });
});
