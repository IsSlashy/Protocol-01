/**
 * Audit v1, finding F77 (residual): the stealth derivation in stealth.ts was
 * fixed in round 4, but its two callers still handed out stealth payments the
 * recipient could not take:
 *
 *  - PrivateStream (`useStealthAddress`) paid each tick to a fresh one-time
 *    address and DISCARDED the ephemeral public key and view tag. Without them
 *    the recipient can derive no key for the address: every tick was paid to
 *    an address nobody could spend from.
 *  - SecurityManager.scanIncomingPayments returned `privateKey`, typed as the
 *    "one-time private key to spend". It is a raw scalar, not an ed25519
 *    seed: `Keypair.fromSeed(privateKey)` / `ed25519.sign(m, privateKey)` hash
 *    it again and sign for an unrelated key. The payment named no address and
 *    the manager offered no way to sign for it.
 *
 * Pinned here: from what the stream records, the recipient derives the key
 * that controls each paid address; the manager's payment names the address
 * and signs for it; a seed-style use of the scalar does NOT control it.
 *
 * Run: cd packages/p01-js && pnpm exec vitest run --config vitest.unit.config.ts src/security/stealthRecipients.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PublicKey } from '@solana/web3.js';

import { PrivateStream, type ShieldReceipt } from '../private-stream';
import { SecurityManager, SecurityError } from './manager';
import {
  deriveStealthPrivateKey,
  generateStealthKeyPair,
  generateStealthAddress,
  createMetaAddressFromKeyPair,
  stealthPublicKeyFromPrivateKey,
} from './stealth';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

function receipts(n: number): ShieldReceipt[] {
  return Array.from({ length: n }, (_, i) => ({
    secret: `s${i}`,
    nullifierPreimage: `n${i}`,
    depositEpoch: 1,
    tokenMint: 'So11111111111111111111111111111111111111112',
    commitment: `c${i}`,
    leafIndex: i,
    denomination: 10,
    pool: `p${i}`,
  }));
}

describe('PrivateStream stealth ticks can be spent by the recipient (F77)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('records, for every paid tick, what the recipient needs to derive the key of that address', async () => {
    const keys = generateStealthKeyPair();
    const stream = PrivateStream.create({
      token: 'SOL',
      denomination: 10,
      totalTicks: 3,
      recipientAddress: 'RecipientAddress11111111111111111111111111111',
      useStealthAddress: true,
      recipientSpendingPubKey: hex(keys.spendPublicKey),
      recipientViewingPubKey: hex(keys.scanPublicKey),
      useRelayer: false,
      jitter: { minIntervalMs: 10_000, maxIntervalMs: 20_000 },
    });
    stream.setReceipts(receipts(3));
    const paid: string[] = [];
    stream.start(async (_r, addr) => {
      paid.push(addr);
      return `sig_${paid.length}`;
    });
    for (let i = 0; i < 3; i++) await vi.advanceTimersToNextTimerAsync();
    expect(paid).toHaveLength(3);

    // Survives a persistence round trip, since the stream is meant to be stored.
    const ticks = (PrivateStream.fromJSON(stream.toJSON()).getStatus() as unknown as {
      stealthTicks?: { signature: string; address: string; ephemeralPublicKey: string; viewTag: number }[];
    }).stealthTicks;
    expect(ticks, 'the stream records no stealth tick data').toBeDefined();
    expect(ticks!.map((t) => t.address)).toEqual(paid);
    expect(ticks!.map((t) => t.signature)).toEqual(['sig_1', 'sig_2', 'sig_3']);
    for (const t of ticks!) {
      const k = deriveStealthPrivateKey(fromHex(t.ephemeralPublicKey), keys.scanPrivateKey, keys.spendPrivateKey);
      expect(new PublicKey(stealthPublicKeyFromPrivateKey(k)).toBase58()).toBe(t.address);
    }
  });
});

describe('SecurityManager stealth payments name their address and sign for it (F77)', () => {
  it('scanIncomingPayments returns the paid address, and signStealthPayment verifies under it', () => {
    const recipient = new SecurityManager();
    const keys = recipient.generateStealthKeys();
    const paid = generateStealthAddress(createMetaAddressFromKeyPair(keys));

    const [payment] = recipient.scanIncomingPayments([
      {
        signature: 'sig',
        ephemeralPublicKey: paid.ephemeralPublicKey,
        viewTag: paid.viewTag,
        recipient: paid.address,
        amount: 1,
        tokenMint: 'So11111111111111111111111111111111111111112',
        timestamp: 0,
      },
    ]);
    expect(payment).toBeDefined();
    expect((payment as unknown as { address?: string }).address).toBe(paid.address);

    const message = new TextEncoder().encode('a Solana message');
    const sign = (recipient as unknown as { signStealthPayment?: (m: Uint8Array, p: typeof payment) => Uint8Array }).signStealthPayment;
    expect(typeof sign, 'SecurityManager has no signStealthPayment').toBe('function');
    const sig = sign!.call(recipient, message, payment);
    expect(ed25519.verify(sig, message, new PublicKey(paid.address).toBytes())).toBe(true);
  });

  describe('signStealthPayment refuses a key that does not control the recorded address', () => {
    const message = new TextEncoder().encode('a Solana message');

    function scanned() {
      const recipient = new SecurityManager();
      const keys = recipient.generateStealthKeys();
      const meta = createMetaAddressFromKeyPair(keys);
      const paid = generateStealthAddress(meta);
      const [payment] = recipient.scanIncomingPayments([
        {
          signature: 'sig',
          ephemeralPublicKey: paid.ephemeralPublicKey,
          viewTag: paid.viewTag,
          recipient: paid.address,
          amount: 1,
          tokenMint: 'So11111111111111111111111111111111111111112',
          timestamp: 0,
        },
      ]);
      expect(payment).toBeDefined();
      expect(payment!.address).toBe(paid.address);
      return { recipient, meta, payment: payment! };
    }

    function expectRefused(fn: () => unknown) {
      let thrown: unknown;
      try {
        fn();
      } catch (e) {
        thrown = e;
      }
      expect(thrown, 'signStealthPayment signed for an address its key does not control').toBeInstanceOf(SecurityError);
      expect((thrown as Error).message).toBe('This payment key does not control the payment address.');
    }

    it('when the recorded address is another stealth address of the same recipient', () => {
      const { recipient, meta, payment } = scanned();
      const other = generateStealthAddress(meta).address;
      expect(other).not.toBe(payment.address);
      expectRefused(() => recipient.signStealthPayment(message, { ...payment, address: other }));
    });

    it('when the key is the key of another payment', () => {
      const a = scanned();
      const b = scanned();
      expect(hex(b.payment.privateKey)).not.toBe(hex(a.payment.privateKey));
      expectRefused(() => a.recipient.signStealthPayment(message, { ...a.payment, privateKey: b.payment.privateKey }));
    });
  });

  it('negative control: using the scalar as an ed25519 seed signs for another key', () => {
    const keys = generateStealthKeyPair();
    const paid = generateStealthAddress(createMetaAddressFromKeyPair(keys));
    const k = deriveStealthPrivateKey(paid.ephemeralPublicKey, keys.scanPrivateKey, keys.spendPrivateKey);
    expect(new PublicKey(ed25519.getPublicKey(k)).toBase58()).not.toBe(paid.address);
  });
});
