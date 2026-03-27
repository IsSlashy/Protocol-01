import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { encryptForRelayer, decryptRelayJob } from './encrypt';
import { selectRelayer } from './select';
import { generateJobId } from './submit';
import { PublicKey, Keypair } from '@solana/web3.js';
import type { RelayerNodeInfo } from './types';

describe('relay/encrypt v1 (classic X25519)', () => {
  it('encrypts and decrypts a payload round-trip', () => {
    const relayerKeys = nacl.box.keyPair();
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const encrypted = encryptForRelayer(payload, relayerKeys.publicKey);
    expect(encrypted[0]).toBe(0x01); // v1 version byte
    expect(encrypted.length).toBeGreaterThan(payload.length);

    const decrypted = decryptRelayJob(encrypted, relayerKeys.secretKey);
    expect(decrypted).not.toBeNull();
    expect(Array.from(decrypted!)).toEqual(Array.from(payload));
  });

  it('fails to decrypt with wrong key', () => {
    const relayerKeys = nacl.box.keyPair();
    const wrongKeys = nacl.box.keyPair();
    const payload = new Uint8Array([10, 20, 30]);

    const encrypted = encryptForRelayer(payload, relayerKeys.publicKey);
    const decrypted = decryptRelayJob(encrypted, wrongKeys.secretKey);
    expect(decrypted).toBeNull();
  });

  it('handles large payloads (1232 bytes — max Solana tx)', () => {
    const relayerKeys = nacl.box.keyPair();
    const payload = new Uint8Array(1232);
    payload.fill(0xab);

    const encrypted = encryptForRelayer(payload, relayerKeys.publicKey);
    const decrypted = decryptRelayJob(encrypted, relayerKeys.secretKey);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.length).toBe(1232);
    expect(decrypted![0]).toBe(0xab);
  });

  it('rejects truncated ciphertext', () => {
    const relayerKeys = nacl.box.keyPair();
    const encrypted = encryptForRelayer(new Uint8Array([1]), relayerKeys.publicKey);

    const truncated = encrypted.slice(0, 10);
    const result = decryptRelayJob(truncated, relayerKeys.secretKey);
    expect(result).toBeNull();
  });
});

describe('relay/encrypt v2 (hybrid X25519 + ML-KEM-768)', () => {
  it('encrypts and decrypts with hybrid PQ round-trip', () => {
    const relayerKeys = nacl.box.keyPair();
    const kemKeys = ml_kem768.keygen();
    const payload = new Uint8Array([42, 43, 44, 45]);

    const encrypted = encryptForRelayer(payload, relayerKeys.publicKey, kemKeys.publicKey);
    expect(encrypted[0]).toBe(0x02); // v2 version byte
    // v2 overhead: 1 + 32 + 1088 + 24 + 16 = 1161
    expect(encrypted.length).toBe(payload.length + 1161);

    const decrypted = decryptRelayJob(encrypted, relayerKeys.secretKey, kemKeys.secretKey);
    expect(decrypted).not.toBeNull();
    expect(Array.from(decrypted!)).toEqual(Array.from(payload));
  });

  it('fails v2 decrypt with wrong KEM secret key', () => {
    const relayerKeys = nacl.box.keyPair();
    const kemKeys = ml_kem768.keygen();
    const wrongKemKeys = ml_kem768.keygen();
    const payload = new Uint8Array([1, 2, 3]);

    const encrypted = encryptForRelayer(payload, relayerKeys.publicKey, kemKeys.publicKey);
    const decrypted = decryptRelayJob(encrypted, relayerKeys.secretKey, wrongKemKeys.secretKey);
    expect(decrypted).toBeNull();
  });

  it('fails v2 decrypt with wrong X25519 key', () => {
    const relayerKeys = nacl.box.keyPair();
    const wrongX25519 = nacl.box.keyPair();
    const kemKeys = ml_kem768.keygen();
    const payload = new Uint8Array([7, 8, 9]);

    const encrypted = encryptForRelayer(payload, relayerKeys.publicKey, kemKeys.publicKey);
    const decrypted = decryptRelayJob(encrypted, wrongX25519.secretKey, kemKeys.secretKey);
    expect(decrypted).toBeNull();
  });

  it('fails v2 decrypt without KEM secret key', () => {
    const relayerKeys = nacl.box.keyPair();
    const kemKeys = ml_kem768.keygen();
    const payload = new Uint8Array([5]);

    const encrypted = encryptForRelayer(payload, relayerKeys.publicKey, kemKeys.publicKey);
    // Try decrypting v2 without providing KEM key
    const decrypted = decryptRelayJob(encrypted, relayerKeys.secretKey);
    expect(decrypted).toBeNull();
  });

  it('handles large payloads with hybrid encryption', () => {
    const relayerKeys = nacl.box.keyPair();
    const kemKeys = ml_kem768.keygen();
    const payload = new Uint8Array(1232);
    payload.fill(0xcd);

    const encrypted = encryptForRelayer(payload, relayerKeys.publicKey, kemKeys.publicKey);
    const decrypted = decryptRelayJob(encrypted, relayerKeys.secretKey, kemKeys.secretKey);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.length).toBe(1232);
    expect(decrypted![0]).toBe(0xcd);
  });
});

describe('relay/select', () => {
  function makeRelayer(seed: number): RelayerNodeInfo {
    const kp = Keypair.generate();
    return {
      address: kp.publicKey,
      operator: kp.publicKey,
      encryptionKey: nacl.box.keyPair().publicKey,
      stake: 1_000_000_000,
      jobsCompleted: 0,
      jobsFailed: 0,
      reputationScore: 5000,
      isActive: true,
    };
  }

  it('selects from a single relayer', () => {
    const relayers = [makeRelayer(1)];
    const jobId = generateJobId();
    const result = selectRelayer(relayers, 'blockhash123', jobId);
    expect(result.index).toBe(0);
    expect(result.relayer.address.equals(relayers[0]!.address)).toBe(true);
  });

  it('distributes across multiple relayers', () => {
    const relayers = Array.from({ length: 5 }, (_, i) => makeRelayer(i));
    const selected = new Set<string>();

    // Run 50 times with different job IDs — should hit multiple relayers
    for (let i = 0; i < 50; i++) {
      const jobId = generateJobId();
      const result = selectRelayer(relayers, 'blockhash_' + i, jobId);
      selected.add(result.relayer.address.toBase58());
    }

    // Should have selected at least 2 different relayers
    expect(selected.size).toBeGreaterThanOrEqual(2);
  });

  it('is deterministic for same inputs', () => {
    const relayers = Array.from({ length: 3 }, (_, i) => makeRelayer(i));
    const jobId = generateJobId();
    const blockhash = 'fixed_blockhash';

    const r1 = selectRelayer(relayers, blockhash, jobId);
    const r2 = selectRelayer(relayers, blockhash, jobId);

    expect(r1.index).toBe(r2.index);
    expect(r1.relayer.address.toBase58()).toBe(r2.relayer.address.toBase58());
  });

  it('throws on empty relayer list', () => {
    expect(() => selectRelayer([], 'hash', generateJobId())).toThrow(
      'No active relayers',
    );
  });
});

describe('relay/submit', () => {
  it('generates unique 32-byte job IDs', () => {
    const id1 = generateJobId();
    const id2 = generateJobId();
    expect(id1.length).toBe(32);
    expect(id2.length).toBe(32);
    expect(Buffer.from(id1).equals(Buffer.from(id2))).toBe(false);
  });
});
