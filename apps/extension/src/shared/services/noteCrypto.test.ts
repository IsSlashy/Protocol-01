/**
 * Tests for post-quantum note encryption (hybrid X25519 + ML-KEM-768).
 * No WASM — ml-kem + tweetnacl are pure JS, so jsdom/node both work.
 */
import { describe, it, expect } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  deriveNoteEncryptionKeys,
  createNoteEncryptionAddress,
  parseNoteEncryptionAddress,
  isNoteEncryptionAddress,
  isEncryptedNoteBlob,
  encryptNote,
  decryptNote,
} from './noteCrypto';

const seedA = new Uint8Array(32).fill(7);
const seedB = new Uint8Array(32).fill(9);

// base64 helpers mirroring the module's (popup uses btoa/atob).
function b64decode(str: string): Uint8Array {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// A REAL legacy v1 blob (no version byte, static-salt HKDF) encrypted to
// `seedA = fill(7)`, generated with the pre-hardening algorithm. This is the
// fund-loss regression guard: notes minted before the hardening MUST still
// decrypt. Plaintext = the JSON below.
const LEGACY_V1_BLOB =
  'p01enc1:l/3+qRRxUgHZZuAHEOrP6jpPjZCbpLx9zgR8rh90GRpPo9QzwbPCwBkqWQ30V6NWqL17n9HKypwk2wlXyGCjenZOf1Rrk0C2+dXk/HHLm1FlcXN/jc4mmRktrkTrZd6ca/qnDWNFIuwkn4NFRDy2pV2JUXMPaeRro5ZIM7Xah9j3k9ChDDF9actYcJ3pvck8NVUJ4iKSf/mJyxgvjpd6ufxFUUGaSg+BzCqzgn/lRBs4aW7RD601kBtug0DBMgnoVhlEoNri84f+Y3SWdLw1nex0Jj9kMxYAr/78V1ESla+JqGRHdTuVBgOPrARlo6rPiWO4HZXAC/X5QeCn2Ruhc4/MD4qs5+58GuFDLYqijGRJuQRDwGIgODGQh+LX0GJ/GuBTWr+53kr5lL6NYX8nb+3RIa+OEKtXnjc6kMshhVXI3/xODpHz2E6zSd2wb4yqHpJWPwnrUnFXFWTHsaeKH9EyYSKjai2etgiOr5vEXGnnXrAaxw4YhS4tyD/1Pf2B5gJvt+SQhpMyF1u2cs14u2Ok4Ix5MSUxVqFig3kP2RFFscjYXVDVpd8q5XkeQS4v2hiQk4srn6L0hV3Pj0263bw3N4u0CxaMcnq3fuuYgJ/K0VvxwpLdsbxZd4n7jDrj/nAlC8qjW5At+gy+KWYV7sVataHhLKJGBWnrvjrhw1fl5HoOKQqEp1E+1oIGZpfedMKtVenyijgpN/CF3/EjegcIs5/LXtPkkecvMWwaRQU4n5isLXBjygD9bJmdY1dJzyh6dwSCxYSmCickQLT/I21viX9PO0FfBdewj0uQ9wdCK3pVsizdfAm/5lNqmZKqdNk/0QpxzqK7DssAonPeSrWLJCwGj8RTUBb8RPOaRtPv+YU+lLBEVR1eErvfWItQQF4+NxtgZE+aJZkA38r2P69MfeDdy/5Q8Ls6R9mJoX6vdTCB1LF3KGm+IlNc8B0h/PMTYG8gS43pT49fPhHhIMYAElaFgZWo1SkvfphreZbX5p4vKDGDJ4+aZm3BMw+cPMpBx7wiUOBzDN0oda0XjY4SmWktLWWz+4VKMtqpP41RzlvpRtSQCcAjsqWojcOJ9dKxz23amFRqPowXCj+C7N4gjDmazbaaVmEwj59W4+WEUjcMd7XK5zw/0HKW3UCv5cFRHB9r2rZYHHfTUx/fyLQn58ejYQU1M2uH0LeGrGlOj3w6cEgpFiFURdRYvi3JbDZPMjQSQcikHKRIymG5pgoHSFMRnnrucok8MzYV3y3F8W+g/QPDP3IRflHSvhp69ygvu+2grVrQxgGJWeHHnkKbWxwvdT1aUjNF/DjBuRmUKClMIW2K7dVqi0H75Ip045WYp5Bkko12L/74XhB6PLbh8atEPT9GPTtcxeUlbjiG/PfuW6ZXUe8F/c1ap4cxRMGYAB8JpFlFckhu0wDdzUdjDiXizF7TBTIhiJpuIP9Rx/VO3YMOiAIPaKhu/QqcXDTSPhMoCd/SpyOV9To9/fU9JgmR0PyRawOAQA+Jo2taR641C7XTBBKpRaJziOPsdISODzxYOADtf3c5cBstmk/W0HqgtRZfgGzFBz/QeGZIkcfOE+wlLXNNBwXBjYY/Xi7mQoJvqtO/U6kATjYsW3SweBeIAUNOfCRPng==';
const LEGACY_V1_PLAINTEXT = JSON.stringify({
  hello: 'world',
  n: 123,
  big: '12345678901234567890',
  legacy: true,
});

describe('deriveNoteEncryptionKeys', () => {
  it('is deterministic for the same seed', () => {
    const k1 = deriveNoteEncryptionKeys(seedA);
    const k2 = deriveNoteEncryptionKeys(seedA);
    expect(Buffer.from(k1.x25519Pub)).toEqual(Buffer.from(k2.x25519Pub));
    expect(Buffer.from(k1.kemPub)).toEqual(Buffer.from(k2.kemPub));
    expect(Buffer.from(k1.kemSec)).toEqual(Buffer.from(k2.kemSec));
  });

  it('differs for different seeds', () => {
    const k1 = deriveNoteEncryptionKeys(seedA);
    const k2 = deriveNoteEncryptionKeys(seedB);
    expect(Buffer.from(k1.x25519Pub)).not.toEqual(Buffer.from(k2.x25519Pub));
    expect(Buffer.from(k1.kemPub)).not.toEqual(Buffer.from(k2.kemPub));
  });

  it('has correct key sizes (X25519 32, ML-KEM-768 pub 1184)', () => {
    const k = deriveNoteEncryptionKeys(seedA);
    expect(k.x25519Pub.length).toBe(32);
    expect(k.x25519Sec.length).toBe(32);
    expect(k.kemPub.length).toBe(1184);
  });
});

describe('note address', () => {
  it('round-trips the public keys', () => {
    const addr = createNoteEncryptionAddress(seedA);
    expect(addr.startsWith('p01pq:')).toBe(true);
    expect(isNoteEncryptionAddress(addr)).toBe(true);
    const parsed = parseNoteEncryptionAddress(addr);
    const keys = deriveNoteEncryptionKeys(seedA);
    expect(Buffer.from(parsed.x25519Pub)).toEqual(Buffer.from(keys.x25519Pub));
    expect(Buffer.from(parsed.kemPub)).toEqual(Buffer.from(keys.kemPub));
  });

  it('rejects junk', () => {
    expect(isNoteEncryptionAddress('nope')).toBe(false);
    expect(isNoteEncryptionAddress('p01pq:zzzz')).toBe(false);
  });
});

describe('encrypt / decrypt (v2 hardened)', () => {
  const addrA = createNoteEncryptionAddress(seedA);
  const msg = utf8ToBytes(JSON.stringify({ hello: 'world', n: 123, big: '12345678901234567890' }));

  it('round-trips for the addressed recipient', () => {
    const blob = encryptNote(addrA, msg);
    expect(isEncryptedNoteBlob(blob)).toBe(true);
    const out = decryptNote(seedA, blob);
    expect(Buffer.from(out)).toEqual(Buffer.from(msg));
  });

  it('writes the v2 layout (leading 0x02 version byte inside the payload)', () => {
    const blob = encryptNote(addrA, msg);
    const raw = b64decode(blob.slice('p01enc1:'.length));
    expect(raw[0]).toBe(0x02);
    // 1 version + 32 ephPub + 1088 kemCt + 24 nonce + ct(>=17) → strictly longer.
    expect(raw.length).toBeGreaterThan(1 + 32 + 1088 + 24);
  });

  it('is non-deterministic (fresh ephemeral + nonce per call)', () => {
    expect(encryptNote(addrA, msg)).not.toBe(encryptNote(addrA, msg));
  });

  it('cannot be decrypted by a different wallet (PQ + classical both bind)', () => {
    const blob = encryptNote(addrA, msg);
    expect(() => decryptNote(seedB, blob)).toThrow(/decryption failed/i);
  });

  it('rejects a tampered ciphertext', () => {
    const blob = encryptNote(addrA, msg);
    const i = blob.length - 5;
    const tampered = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1);
    expect(() => decryptNote(seedA, tampered)).toThrow();
  });

  it('rejects a malformed blob', () => {
    expect(() => decryptNote(seedA, 'p01enc1:short')).toThrow();
    expect(() => decryptNote(seedA, 'not-a-blob')).toThrow(/prefix/i);
  });
});

describe('legacy v1 backward compatibility (MUST decrypt — fund loss otherwise)', () => {
  it('decrypts a real legacy v1 blob (no version byte, static-salt HKDF)', () => {
    expect(isEncryptedNoteBlob(LEGACY_V1_BLOB)).toBe(true);
    const out = decryptNote(seedA, LEGACY_V1_BLOB);
    expect(Buffer.from(out).toString('utf8')).toBe(LEGACY_V1_PLAINTEXT);
  });

  it('a legacy blob still cannot be opened by the wrong wallet', () => {
    expect(() => decryptNote(seedB, LEGACY_V1_BLOB)).toThrow(/decryption failed/i);
  });
});

describe('transcript-binding hardening (Finding #2)', () => {
  const addrA = createNoteEncryptionAddress(seedA);
  const msg = utf8ToBytes('bind-the-transcript');

  it('a swapped nonce in a v2 blob fails auth (salt binds the nonce)', () => {
    const blob = encryptNote(addrA, msg);
    const raw = b64decode(blob.slice('p01enc1:'.length));
    // Flip a bit inside the nonce region: offset 1 + 32 + 1088 .. +24.
    const nonceStart = 1 + 32 + 1088;
    raw[nonceStart] ^= 0xff;
    let s = '';
    for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
    const mutated = 'p01enc1:' + btoa(s);
    expect(() => decryptNote(seedA, mutated)).toThrow(/decryption failed/i);
  });
});
