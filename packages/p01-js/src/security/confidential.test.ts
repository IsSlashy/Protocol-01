import { describe, it, expect } from 'vitest';

import {
  createConfidentialTransfer,
  verifyConfidentialTransfer,
  createPrivateTransferWithLight,
} from './confidential';
import { hashSHA256, bigIntToBytes } from './crypto';
import type { ConfidentialTransfer } from './types';

/**
 * Audit v1, round 4 (axis 8, public claims): the exported "confidential
 * transfer" API had no proof system behind it.
 *  - verifyConfidentialTransfer checked only the shape of the object, so any
 *    forgery passed.
 *  - createConfidentialTransfer published sha256(bigIntToBytes(amount, 32)) for each amount
 *    as "public inputs", so enumerating amounts recovered them at once.
 * There is no range proof in this package, so neither function may claim to
 * provide one: verification must fail closed and creation must refuse rather
 * than publish amount-derived data.
 */

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('verifyConfidentialTransfer fails closed', () => {
  it('rejects a forged transfer: zero commitments, a 1-byte proof, empty public inputs', () => {
    const forged: ConfidentialTransfer = {
      senderCommitment: new Uint8Array(32),
      recipientCommitment: new Uint8Array(32),
      transferCommitment: new Uint8Array(32),
      proof: {
        type: 'bulletproof',
        proof: new Uint8Array([1]),
        publicInputs: [new Uint8Array(0), new Uint8Array(0), new Uint8Array(0)],
        verificationKeyHash: '',
      },
    };
    expect(verifyConfidentialTransfer(forged)).toBe(false);
  });
});

describe('createConfidentialTransfer does not publish the amounts', () => {
  it('never returns public inputs from which the transfer amount can be enumerated', () => {
    let transfer: ConfidentialTransfer | undefined;
    try {
      transfer = createConfidentialTransfer(4242n, 10000n, 7n);
    } catch {
      transfer = undefined; // refusing is an acceptable way not to leak
      // (recipientBalance is 7, not 0: createCommitment(0) throws in crypto.ts,
      // which would make this test pass without testing anything.)
    }
    if (transfer) {
      const leaked = transfer.proof.publicInputs.some((pi) => {
        for (let v = 0n; v <= 20000n; v++) if (eq(pi, hashSHA256(bigIntToBytes(v, 32)))) return true;
        return false;
      });
      expect(leaked).toBe(false);
      // Whatever it returns can never be accepted without a real range proof.
      expect(verifyConfidentialTransfer(transfer)).toBe(false);
    }
  });

  it('refuses with an explicit error, since this package has no range proof', () => {
    expect(() => createConfidentialTransfer(4242n, 10000n, 7n)).toThrow(/no range proof/i);
  });

  it('keeps its input checks ahead of the refusal', () => {
    expect(() => createConfidentialTransfer(0n, 10n, 0n)).toThrow(/must be positive/);
    expect(() => createConfidentialTransfer(11n, 10n, 0n)).toThrow(/Insufficient balance/);
  });

  it('the Light stub no longer points callers at createConfidentialTransfer', async () => {
    await expect(
      createPrivateTransferWithLight(1n, 'x', { programId: 'p', rpcEndpoint: 'r' }),
    ).rejects.toThrow(/not yet implemented/);
    await expect(
      createPrivateTransferWithLight(1n, 'x', { programId: 'p', rpcEndpoint: 'r' }),
    ).rejects.not.toThrow(/Use createConfidentialTransfer/);
  });
});
