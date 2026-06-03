/**
 * Stage S1 tests — shared SDK pairing helpers.
 *
 * Covers (docs/pairing-ledger-spec.md §3 S1-T4):
 *   - full round-trip (build QR#1 → encrypt QR#2 → decrypt → recover mnemonic)
 *   - SAS mismatch on a tampered QR#1
 *   - SAS mismatch on a tampered QR#2 (the Finding #1 regression)
 *   - expired-TTL reject
 *   - nonce-mismatch reject
 *   - BIP39-checksum reject
 *   - low-order X25519 point reject (encrypt + decrypt)
 *   - chunk splice / drop / duplicate reject
 *   - oversized-input reject
 */

import { describe, it, expect } from 'vitest';
import { generateMnemonic } from 'bip39';

import {
  generateEphemeralPairingKeys,
  encryptToPairingBundle,
  decryptWithEphemeral,
  parsePairingBlob,
  b64encode,
  b64decode,
  X25519_LEN,
  KEM_PUBLIC_LEN,
  KEM_CIPHERTEXT_LEN,
} from './box';
import {
  buildPairingQr1,
  parsePairingQr1,
  encodePairingPayload,
  decodePairingPayload,
  computeSAS,
  sasEqual,
  chunkPairingCiphertext,
  reassemblePairingChunks,
  ConsumedNonceSet,
  PAIRING_WALLET_KIND_SEED,
  PAIRING_TTL_SECS,
  PAIR_QR1_PREFIX,
  MAX_PAIRING_INPUT_CHARS,
} from './protocol';

// ─── helpers ──────────────────────────────────────────────────────────────────
const NOW = 1_900_000_000; // fixed clock for deterministic expiry tests

function freshNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Run a full ceremony and return all the intermediate material so individual
 * tests can tamper with one piece.
 */
function runCeremony(opts?: { mnemonic?: string; now?: number }) {
  const mnemonic = opts?.mnemonic ?? generateMnemonic(128);
  const now = opts?.now ?? NOW;

  // RECEIVER: generate ephemeral bundle + QR#1.
  const recv = generateEphemeralPairingKeys();
  const pairingNonce = freshNonce();
  const expiry = now + PAIRING_TTL_SECS;
  const qr1 = buildPairingQr1(
    { x25519Pub: recv.x25519Pub, kemPub: recv.kemPub },
    pairingNonce,
    expiry,
  );

  // SENDER: scan QR#1, build payload + QR#2.
  const scanned = parsePairingQr1(qr1);
  const payload = encodePairingPayload({
    pairingNonce: scanned.pairingNonce,
    timestamp: now,
    walletKind: PAIRING_WALLET_KIND_SEED,
    mnemonic,
  });
  const enc = encryptToPairingBundle(scanned.bundle, payload);

  return { mnemonic, now, recv, pairingNonce, expiry, qr1, scanned, payload, enc };
}

// ─── round-trip ────────────────────────────────────────────────────────────────
describe('pairing round-trip', () => {
  it('recovers the mnemonic across the full 2-QR handshake (12 words)', () => {
    const c = runCeremony();
    const out = decryptWithEphemeral(c.recv, c.enc.blob);
    const decoded = decodePairingPayload(out, c.pairingNonce, c.expiry, c.now);
    expect(decoded.mnemonic).toBe(c.mnemonic);
    expect(decoded.walletKind).toBe(PAIRING_WALLET_KIND_SEED);
  });

  it('recovers a 24-word mnemonic in a single frame', () => {
    const mnemonic = generateMnemonic(256);
    const c = runCeremony({ mnemonic });
    const out = decryptWithEphemeral(c.recv, c.enc.blob);
    const decoded = decodePairingPayload(out, c.pairingNonce, c.expiry, c.now);
    expect(decoded.mnemonic).toBe(mnemonic);
  });

  it('produces an identical SAS on both devices over both frames', () => {
    const c = runCeremony();
    // Receiver side computes SAS from its bundle + the scanned-back QR#2 material.
    const blob = parsePairingBlob(c.enc.blob);
    const sasSender = computeSAS(
      c.scanned.bundle,
      c.scanned.pairingNonce,
      c.expiry,
      c.enc.ephX25519Pub,
      c.enc.kemCiphertext,
    );
    const sasReceiver = computeSAS(
      { x25519Pub: c.recv.x25519Pub, kemPub: c.recv.kemPub },
      c.pairingNonce,
      c.expiry,
      blob.ephX25519Pub,
      blob.kemCiphertext,
    );
    expect(sasEqual(sasSender, sasReceiver)).toBe(true);
    expect(sasSender).toMatch(/^\d{6}$/);
  });
});

// ─── SAS mismatch on tampered QR#1 ──────────────────────────────────────────────
describe('SAS mismatch (tampered QR#1)', () => {
  it('changes the SAS when the receiver bundle is swapped (MITM on QR#1)', () => {
    const c = runCeremony();
    const honest = computeSAS(
      c.scanned.bundle,
      c.scanned.pairingNonce,
      c.expiry,
      c.enc.ephX25519Pub,
      c.enc.kemCiphertext,
    );
    // Attacker substitutes their OWN receive bundle in QR#1.
    const attacker = generateEphemeralPairingKeys();
    const tampered = computeSAS(
      { x25519Pub: attacker.x25519Pub, kemPub: attacker.kemPub },
      c.scanned.pairingNonce,
      c.expiry,
      c.enc.ephX25519Pub,
      c.enc.kemCiphertext,
    );
    expect(sasEqual(honest, tampered)).toBe(false);
  });
});

// ─── SAS mismatch on tampered QR#2 (Finding #1 regression) ──────────────────────
describe('SAS mismatch (tampered QR#2 — Finding #1)', () => {
  it('changes the SAS when QR#2 ephemeral material is swapped', () => {
    const c = runCeremony();
    const honest = computeSAS(
      c.scanned.bundle,
      c.scanned.pairingNonce,
      c.expiry,
      c.enc.ephX25519Pub,
      c.enc.kemCiphertext,
    );
    // Attacker re-encrypts to the SAME receiver but with a different ephemeral
    // key (their own QR#2). The SAS must move, or the QR#1-only SAS would miss it.
    const reenc = encryptToPairingBundle(c.scanned.bundle, c.payload);
    expect(b64encode(reenc.ephX25519Pub)).not.toBe(b64encode(c.enc.ephX25519Pub));
    const tampered = computeSAS(
      c.scanned.bundle,
      c.scanned.pairingNonce,
      c.expiry,
      reenc.ephX25519Pub,
      reenc.kemCiphertext,
    );
    expect(sasEqual(honest, tampered)).toBe(false);
  });
});

// ─── expired TTL ────────────────────────────────────────────────────────────────
describe('expired-TTL reject', () => {
  it('rejects a payload decoded after expiry', () => {
    const c = runCeremony();
    const out = decryptWithEphemeral(c.recv, c.enc.blob);
    // now == expiry → expired (strict >=).
    expect(() =>
      decodePairingPayload(out, c.pairingNonce, c.expiry, c.expiry),
    ).toThrow(/expired/i);
    // well past expiry too.
    expect(() =>
      decodePairingPayload(out, c.pairingNonce, c.expiry, c.expiry + 1000),
    ).toThrow(/expired/i);
  });

  it('accepts just before expiry', () => {
    const c = runCeremony();
    const out = decryptWithEphemeral(c.recv, c.enc.blob);
    const decoded = decodePairingPayload(out, c.pairingNonce, c.expiry, c.expiry - 1);
    expect(decoded.mnemonic).toBe(c.mnemonic);
  });
});

// ─── nonce mismatch ─────────────────────────────────────────────────────────────
describe('nonce-mismatch reject', () => {
  it('rejects QR#2 bound to a different QR#1 nonce (cross-device replay)', () => {
    const c = runCeremony();
    const out = decryptWithEphemeral(c.recv, c.enc.blob);
    const wrongNonce = freshNonce();
    expect(() =>
      decodePairingPayload(out, wrongNonce, c.expiry, c.now),
    ).toThrow(/nonce mismatch/i);
  });

  it('ConsumedNonceSet refuses a second decrypt under the same nonce', () => {
    const set = new ConsumedNonceSet();
    const nonce = freshNonce();
    expect(set.has(nonce)).toBe(false);
    set.consume(nonce);
    expect(set.has(nonce)).toBe(true);
    expect(() => set.consume(nonce)).toThrow(/already consumed/i);
  });
});

// ─── BIP39 checksum ─────────────────────────────────────────────────────────────
describe('BIP39-checksum reject', () => {
  it('rejects a mnemonic with a corrupted checksum word', () => {
    // Valid 12-word phrase, then swap the LAST word to break the checksum.
    const valid = generateMnemonic(128);
    const words = valid.split(' ');
    const last = words[words.length - 1];
    // Pick a different valid wordlist word as the replacement.
    const replacement = last === 'abandon' ? 'ability' : 'abandon';
    words[words.length - 1] = replacement;
    const broken = words.join(' ');

    const c = runCeremony();
    // Re-encode a payload carrying the BROKEN mnemonic but a valid nonce.
    const badPayload = encodePairingPayload({
      pairingNonce: c.pairingNonce,
      timestamp: c.now,
      walletKind: PAIRING_WALLET_KIND_SEED,
      mnemonic: broken,
    });
    const badEnc = encryptToPairingBundle(c.scanned.bundle, badPayload);
    const out = decryptWithEphemeral(c.recv, badEnc.blob);
    expect(() =>
      decodePairingPayload(out, c.pairingNonce, c.expiry, c.now),
    ).toThrow(/checksum/i);
  });
});

// ─── low-order X25519 point ─────────────────────────────────────────────────────
describe('low-order X25519 reject', () => {
  it('rejects encrypt to an all-zero receiver x25519 pubkey', () => {
    const recv = generateEphemeralPairingKeys();
    const badBundle = {
      x25519Pub: new Uint8Array(X25519_LEN), // all-zero → low-order
      kemPub: recv.kemPub,
    };
    expect(() =>
      encryptToPairingBundle(badBundle, new Uint8Array([1, 2, 3])),
    ).toThrow(/low-order|all-zero/i);
  });

  it('rejects decrypt when the embedded ephemeral pubkey is all-zero', () => {
    const c = runCeremony();
    const parsed = parsePairingBlob(c.enc.blob);
    // Forge a blob whose ephemeral pubkey is all-zero (low-order on decrypt).
    const forged =
      'p01pairenc1:' +
      b64encode(
        concat(
          new Uint8Array(X25519_LEN),
          parsed.kemCiphertext,
          parsed.nonce,
          parsed.ciphertext,
        ),
      );
    expect(() => decryptWithEphemeral(c.recv, forged)).toThrow(
      /low-order|all-zero/i,
    );
  });
});

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ─── chunk framing ──────────────────────────────────────────────────────────────
describe('chunk splice / drop / duplicate reject', () => {
  it('round-trips a chunked ciphertext', () => {
    const c = runCeremony();
    const cipherBytes = b64decode(c.enc.blob.split(':')[1] as string);
    const sessionId = crypto.getRandomValues(new Uint8Array(8));
    const frames = chunkPairingCiphertext(cipherBytes, sessionId, 300);
    expect(frames.length).toBeGreaterThan(1);
    const reassembled = reassemblePairingChunks(frames);
    expect(b64encode(reassembled)).toBe(b64encode(cipherBytes));
  });

  it('rejects a dropped chunk', () => {
    const c = runCeremony();
    const cipherBytes = b64decode(c.enc.blob.split(':')[1] as string);
    const sessionId = crypto.getRandomValues(new Uint8Array(8));
    const frames = chunkPairingCiphertext(cipherBytes, sessionId, 300);
    expect(() => reassemblePairingChunks(frames.slice(0, -1))).toThrow(
      /count mismatch|missing/i,
    );
  });

  it('rejects a duplicated chunk index', () => {
    const c = runCeremony();
    const cipherBytes = b64decode(c.enc.blob.split(':')[1] as string);
    const sessionId = crypto.getRandomValues(new Uint8Array(8));
    const frames = chunkPairingCiphertext(cipherBytes, sessionId, 300);
    const dup = [frames[0] as string, ...frames.slice(0, frames.length - 1)];
    expect(() => reassemblePairingChunks(dup)).toThrow(/duplicate/i);
  });

  it('rejects a spliced chunk from a different session', () => {
    const c = runCeremony();
    const cipherBytes = b64decode(c.enc.blob.split(':')[1] as string);
    const sessionA = crypto.getRandomValues(new Uint8Array(8));
    const sessionB = crypto.getRandomValues(new Uint8Array(8));
    const framesA = chunkPairingCiphertext(cipherBytes, sessionA, 300);
    const framesB = chunkPairingCiphertext(cipherBytes, sessionB, 300);
    const spliced = [framesA[0] as string, ...framesB.slice(1)];
    expect(() => reassemblePairingChunks(spliced)).toThrow(/sessionId mismatch/i);
  });
});

// ─── oversized / malformed input ───────────────────────────────────────────────
describe('oversized-input reject', () => {
  it('rejects a QR#1 string over the max input length', () => {
    const huge = PAIR_QR1_PREFIX + 'A'.repeat(MAX_PAIRING_INPUT_CHARS + 1);
    expect(() => parsePairingQr1(huge)).toThrow(/maximum input length/i);
  });

  it('rejects a QR#1 with the wrong prefix', () => {
    expect(() => parsePairingQr1('p01enc1:AAAA')).toThrow(/prefix/i);
  });

  it('rejects a QR#1 with the wrong decoded byte length', () => {
    const shortBody = b64encode(new Uint8Array(10));
    expect(() => parsePairingQr1(PAIR_QR1_PREFIX + shortBody)).toThrow(
      /wrong length/i,
    );
  });

  it('rejects a pairing blob that is too short', () => {
    const shortBlob =
      'p01pairenc1:' +
      b64encode(new Uint8Array(X25519_LEN + KEM_CIPHERTEXT_LEN + 24));
    expect(() => parsePairingBlob(shortBlob)).toThrow(/too short/i);
  });
});

// ─── QR#1 structural sanity ────────────────────────────────────────────────────
describe('QR#1 framing', () => {
  it('builds and parses QR#1 byte-for-byte', () => {
    const recv = generateEphemeralPairingKeys();
    const nonce = freshNonce();
    const expiry = NOW + PAIRING_TTL_SECS;
    const qr1 = buildPairingQr1(
      { x25519Pub: recv.x25519Pub, kemPub: recv.kemPub },
      nonce,
      expiry,
    );
    const parsed = parsePairingQr1(qr1);
    expect(b64encode(parsed.bundle.x25519Pub)).toBe(b64encode(recv.x25519Pub));
    expect(parsed.bundle.x25519Pub.length).toBe(X25519_LEN);
    expect(parsed.bundle.kemPub.length).toBe(KEM_PUBLIC_LEN);
    expect(b64encode(parsed.pairingNonce)).toBe(b64encode(nonce));
    expect(parsed.expiryUnixSecs).toBe(expiry);
  });
});
