import { describe, it, expect } from 'vitest';
import {
  LONG_TERM_COMMIT_SIZE,
  LONG_TERM_COMMIT_DOMAIN,
  computeLongTermCommitment,
  generateLongTermSecret,
  verifyLongTermCommitment,
} from './longTermCommit';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { computeHashVaultCommitment } from './helpers';

describe('long-term commitment (SHA-512, P4.5)', () => {
  describe('constants', () => {
    it('commitment size is 64 bytes (SHA-512 digest)', () => {
      expect(LONG_TERM_COMMIT_SIZE).toBe(64);
    });

    it('domain tag is the v1 long-term-commit label', () => {
      const decoded = new TextDecoder().decode(LONG_TERM_COMMIT_DOMAIN);
      expect(decoded).toBe('p01:long-term-commit-v1');
    });
  });

  describe('computeLongTermCommitment', () => {
    it('returns a 64-byte digest', () => {
      const secret = new Uint8Array(32).fill(7);
      const c = computeLongTermCommitment(secret);
      expect(c.length).toBe(64);
    });

    it('is deterministic for the same secret (no salt)', () => {
      const secret = new Uint8Array(32).fill(9);
      const c1 = computeLongTermCommitment(secret);
      const c2 = computeLongTermCommitment(secret);
      expect(c1).toEqual(c2);
    });

    it('is deterministic for the same (secret, salt) pair', () => {
      const secret = new Uint8Array(32).fill(1);
      const salt = new Uint8Array([11, 22, 33]);
      const c1 = computeLongTermCommitment(secret, salt);
      const c2 = computeLongTermCommitment(secret, salt);
      expect(c1).toEqual(c2);
    });

    it('differs when salt differs', () => {
      const secret = new Uint8Array(32).fill(2);
      const c1 = computeLongTermCommitment(secret, new Uint8Array([1]));
      const c2 = computeLongTermCommitment(secret, new Uint8Array([2]));
      expect(c1).not.toEqual(c2);
    });

    it('differs when secret differs', () => {
      const saltShared = new Uint8Array([42]);
      const c1 = computeLongTermCommitment(new Uint8Array(32).fill(1), saltShared);
      const c2 = computeLongTermCommitment(new Uint8Array(32).fill(2), saltShared);
      expect(c1).not.toEqual(c2);
    });

    it('is NOT interchangeable with computeHashVaultCommitment (SHA-256)', () => {
      const secret = new Uint8Array(32).fill(5);
      const sha256Commit = computeHashVaultCommitment(secret);
      const sha512Commit = computeLongTermCommitment(secret);
      expect(sha256Commit.length).toBe(32);
      expect(sha512Commit.length).toBe(64);
      // The first 32 bytes of the SHA-512 result must not equal the SHA-256
      // result — confirming we haven't accidentally built a scheme where an
      // adversary who can attack SHA-256 gets a free attack on our SHA-512.
      expect(sha512Commit.slice(0, 32)).not.toEqual(sha256Commit);
    });

    it('matches raw SHA-512(domain || secret || salt)', () => {
      const secret = new Uint8Array(32).fill(3);
      const salt = new Uint8Array([7, 8, 9]);
      const expectedInput = new Uint8Array(
        LONG_TERM_COMMIT_DOMAIN.length + secret.length + salt.length,
      );
      let offset = 0;
      expectedInput.set(LONG_TERM_COMMIT_DOMAIN, offset);
      offset += LONG_TERM_COMMIT_DOMAIN.length;
      expectedInput.set(secret, offset);
      offset += secret.length;
      expectedInput.set(salt, offset);
      const expected = sha512(expectedInput);
      expect(computeLongTermCommitment(secret, salt)).toEqual(expected);
    });

    it('produces different commitments for domain-tag collision attempts', () => {
      // An attacker trying to swap the domain shouldn't be able to reproduce
      // our commitment even if they pick secret/salt freely. We verify the
      // domain separation by building the same input WITHOUT the domain tag
      // and confirming the output is different.
      const secret = new Uint8Array(32).fill(4);
      const withDomain = computeLongTermCommitment(secret);
      const withoutDomain = sha512(secret);
      expect(withDomain).not.toEqual(withoutDomain);
    });

    it('accepts secrets of non-32-byte sizes', () => {
      // While generateLongTermSecret returns 32 bytes, the primitive is
      // length-agnostic so callers can commit to arbitrary payloads.
      const small = new Uint8Array([1, 2, 3]);
      const large = new Uint8Array(128).fill(0xff);
      expect(computeLongTermCommitment(small).length).toBe(64);
      expect(computeLongTermCommitment(large).length).toBe(64);
    });
  });

  describe('verifyLongTermCommitment', () => {
    it('accepts an honest commitment round-trip', () => {
      const secret = generateLongTermSecret();
      const c = computeLongTermCommitment(secret);
      expect(verifyLongTermCommitment(c, secret)).toBe(true);
    });

    it('accepts an honest commitment with salt round-trip', () => {
      const secret = generateLongTermSecret();
      const salt = new Uint8Array([9, 9, 9, 9]);
      const c = computeLongTermCommitment(secret, salt);
      expect(verifyLongTermCommitment(c, secret, salt)).toBe(true);
    });

    it('rejects a tampered commitment', () => {
      const secret = generateLongTermSecret();
      const c = computeLongTermCommitment(secret);
      const tampered = new Uint8Array(c);
      tampered[0] = tampered[0]! ^ 0x01;
      expect(verifyLongTermCommitment(tampered, secret)).toBe(false);
    });

    it('rejects a wrong secret', () => {
      const correct = generateLongTermSecret();
      const wrong = generateLongTermSecret();
      const c = computeLongTermCommitment(correct);
      expect(verifyLongTermCommitment(c, wrong)).toBe(false);
    });

    it('rejects the right secret with the wrong salt', () => {
      const secret = generateLongTermSecret();
      const c = computeLongTermCommitment(secret, new Uint8Array([1]));
      expect(verifyLongTermCommitment(c, secret, new Uint8Array([2]))).toBe(
        false,
      );
    });

    it('rejects a commitment whose length is not 64 bytes', () => {
      const secret = generateLongTermSecret();
      // sha256 gives 32 bytes — make sure we don't silently accept it.
      const shortCommit = sha256(secret);
      expect(verifyLongTermCommitment(shortCommit, secret)).toBe(false);
    });
  });

  describe('generateLongTermSecret', () => {
    it('returns 32 random bytes', () => {
      const s = generateLongTermSecret();
      expect(s.length).toBe(32);
    });

    it('produces distinct secrets on repeated calls', () => {
      const s1 = generateLongTermSecret();
      const s2 = generateLongTermSecret();
      expect(s1).not.toEqual(s2);
    });
  });
});
