/**
 * Guards for the stealth-sweep claim.
 *
 * The record is the only copy of the material that reconstructs a stealth
 * recipient's private key, so the assertions are about what MUST survive
 * serialisation, and about the sweep never throwing away an unsettled claim.
 */
import { describe, it, expect, vi } from 'vitest';

import { buildPendingStealthSweep, executeStealthSweep } from './stealthSweep';

const STEALTH = {
  address: 'C4MqLbExStealthRecipientAddressPlaceholder',
  ephemeralPublicKey: '3Nc7fLdEphemeralX25519PubkeyBase58',
  viewTag: 42,
  kemCiphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
};

describe('buildPendingStealthSweep', () => {
  it('captures every sender-side value the recipient key needs', () => {
    const rec = buildPendingStealthSweep({
      noteId: '7b8c9d0e1f2a3b4c',
      poolPDA: '9CvrqUAeqEbYbfvQDrHK7TnbaSGCsRPKb2SkAULhSarQ',
      destination: '4vGBhCsonwAxMUHKFPGSz9x8R9R4NxJxMwHnyDz92ajo',
      stealth: STEALTH,
    });
    // Losing any one of these three loses the money.
    expect(rec.ephemeralPublicKey).toBe(STEALTH.ephemeralPublicKey);
    expect(rec.viewTag).toBe(42);
    expect(rec.kemCiphertextHex).toBe('deadbeef');
  });

  it('survives a JSON round-trip — it is persisted, not held in RAM', () => {
    const rec = buildPendingStealthSweep({
      noteId: 'n',
      poolPDA: 'p',
      destination: 'd',
      stealth: STEALTH,
    });
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
  });

  it('tolerates a pre-hybrid payment with no KEM ciphertext', () => {
    const rec = buildPendingStealthSweep({
      noteId: 'n',
      poolPDA: 'p',
      destination: 'd',
      stealth: { address: 'a', ephemeralPublicKey: 'e' },
    });
    expect(rec.kemCiphertextHex).toBeUndefined();
    expect(rec.viewTag).toBeUndefined();
  });
});

describe('executeStealthSweep', () => {
  const rec = buildPendingStealthSweep({
    noteId: 'n',
    poolPDA: 'p',
    destination: '4vGBhCsonwAxMUHKFPGSz9x8R9R4NxJxMwHnyDz92ajo',
    stealth: STEALTH,
  });

  it('reports unsettled instead of throwing when the RPC dies', async () => {
    const conn = {
      getBalance: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    } as any;
    const out = await executeStealthSweep(conn, rec);
    // settled:false is what keeps the claim — and therefore the key — alive.
    expect(out.settled).toBe(false);
    expect(out.swept).toBe(0);
    expect(out.error).toBeTruthy();
  });
});
