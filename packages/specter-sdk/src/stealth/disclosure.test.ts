/**
 * What the stealth scheme and the README say about who can spend, and what the
 * README says about double spends. Audit v1, findings F44 and F51.
 *
 * F44 (founder item; this is the disclosure). The stealth address's full
 * Ed25519 secret is `deriveStealthSeed(spendingPubKey, sharedSecret)`: no
 * recipient SECRET goes into it. The sender knows both inputs (it chose the
 * ephemeral key and ran the KEM encapsulation), and so does anyone holding the
 * viewing secret (plus the KEM secret in hybrid mode). So the sender and any
 * viewing-key holder can sign for the address. The README said "a unique
 * address only the recipient can spend from". Changing the scheme (P = B +
 * H(s)·G) changes every address already derived: a founder decision. Until
 * then the README and the JSDoc must say it, and the behaviour pin below keeps
 * them honest: if the scheme is fixed, that pin fails and the disclosure must
 * be revised with it.
 *
 * F51. The README presented the pool's nullifier PDAs as an unconditional
 * double-spend guarantee. In v1 a leaf commitment is one 64-bit Goldilocks
 * element: two openings of one commitment cost about 2^32 Poseidon
 * evaluations, and give two nullifiers for one deposit (F2,
 * docs/SECURITY-LEVELS.md).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';

vi.mock('../types', async () => {
  const actual = await vi.importActual<typeof import('../types')>('../types');
  return {
    ...actual,
    SpecterError: actual.P01Error,
    SpecterErrorCode: actual.P01ErrorCode,
    SpecterWallet: undefined,
  };
});

// Record the KEM shared secret the SENDER obtains when it encapsulates: it is
// the sender's own computation, so it knows this value.
const senderKemSecrets: Uint8Array[] = [];
vi.mock('../utils/crypto', async () => {
  const actual = await vi.importActual<typeof import('../utils/crypto')>('../utils/crypto');
  return {
    ...actual,
    kemEncapsulate: (pk: Uint8Array) => {
      const r = actual.kemEncapsulate(pk);
      senderKemSecrets.push(new Uint8Array(r.sharedSecret));
      return r;
    },
  };
});

import { deriveStealthPublicKey, deriveStealthPrivateKey } from './derive';
import {
  deriveSharedSecret,
  deriveStealthSeed,
  deriveHybridSharedSecret,
  kemGenerateKeypair,
} from '../utils/crypto';
import { encodeStealthMetaAddress } from '../utils/helpers';
import type { StealthMetaAddress } from '../types';

const PKG = resolve(__dirname, '..', '..');
const README = readFileSync(resolve(PKG, 'README.md'), 'utf8');
const GENERATE_TS = readFileSync(resolve(__dirname, 'generate.ts'), 'utf8');
const DERIVE_TS = readFileSync(resolve(__dirname, 'derive.ts'), 'utf8');

/** The JSDoc block that sits right above `export function <name>(`. */
function jsdocOf(src: string, name: string): string {
  const at = src.indexOf(`export function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(0);
  const open = src.lastIndexOf('/**', at);
  return src.slice(open, at);
}

const SENDER_CAN_SPEND = /sender[\s\S]{0,160}(viewing[- ]key|viewing secret|view key)[\s\S]{0,200}(spend|sign)/i;

describe('F44: the sender and any viewing-key holder can spend a stealth payment', () => {
  function v2Meta() {
    const spending = Keypair.generate();
    const viewing = nacl.box.keyPair();
    const kem = kemGenerateKeypair();
    const meta: StealthMetaAddress = {
      spendingPubKey: spending.publicKey.toBytes(),
      viewingPubKey: viewing.publicKey,
      kemPubKey: kem.publicKey,
      encoded: encodeStealthMetaAddress(spending.publicKey.toBytes(), viewing.publicKey, kem.publicKey),
    };
    return { viewing, kem, meta };
  }

  it('behaviour pin: the sender alone derives the stealth address secret (v2 hybrid)', () => {
    const { meta } = v2Meta();
    const ephemeral = nacl.box.keyPair();
    senderKemSecrets.length = 0;
    const sent = deriveStealthPublicKey(meta, ephemeral.secretKey);
    expect(senderKemSecrets).toHaveLength(1);

    // Only public data (the meta-address) plus what the sender computed itself:
    // its ephemeral secret and the KEM shared secret of its own encapsulation.
    const classic = deriveSharedSecret(ephemeral.secretKey, meta.viewingPubKey);
    const shared = deriveHybridSharedSecret(classic, senderKemSecrets[0]!, {
      ephemeralPubKey: sent.ephemeralPubKey,
      kemCiphertext: sent.kemCiphertext,
    });
    const senderKeypair = nacl.sign.keyPair.fromSeed(deriveStealthSeed(meta.spendingPubKey, shared));

    expect(Buffer.from(senderKeypair.publicKey).equals(sent.stealthPubKey.toBuffer())).toBe(true);
  });

  it('behaviour pin: the viewing and KEM secrets, with no spending secret, give the spending key', () => {
    const { viewing, kem, meta } = v2Meta();
    const sent = deriveStealthPublicKey(meta, nacl.box.keyPair().secretKey);
    // First argument is the spending PUBLIC key: nothing secret about spending.
    const kp = deriveStealthPrivateKey(meta.spendingPubKey, viewing.secretKey, sent.ephemeralPubKey, kem.secretKey, sent.kemCiphertext);
    expect(kp.publicKey.toBase58()).toBe(sent.stealthPubKey.toBase58());
  });

  it('the README no longer says only the recipient can spend', () => {
    expect(README).not.toMatch(/only the recipient can spend/i);
  });

  it('the README says the sender and any viewing-key holder can spend', () => {
    expect(README).toMatch(SENDER_CAN_SPEND);
  });

  it('the JSDoc of generateStealthAddress and deriveStealthPrivateKey says it too', () => {
    expect(jsdocOf(GENERATE_TS, 'generateStealthAddress')).toMatch(SENDER_CAN_SPEND);
    expect(jsdocOf(DERIVE_TS, 'deriveStealthPrivateKey')).toMatch(SENDER_CAN_SPEND);
  });
});

describe('F51: the README does not sell nullifier PDAs as an unconditional double-spend guarantee', () => {
  it('the nullifier bullet carries the F2 / 64-bit caveat', () => {
    const bullet = README.split('\n').find((l) => /nullifier record/i.test(l));
    expect(bullet, 'no nullifier-record bullet in the README').toBeDefined();
    expect(bullet!).toMatch(/F2/);
    expect(bullet!).toMatch(/2\^32/);
    expect(bullet!).toMatch(/SECURITY-LEVELS\.md/);
  });

  it('the 2^32 figure carries its regime: classical birthday, and the quantum BHT figure (SECURITY-LEVELS.md: 32.00 / 21.33)', () => {
    const bullet = README.split('\n').find((l) => /nullifier record/i.test(l))!;
    expect(bullet).toMatch(/2\^32[^.]{0,80}classical[^.]{0,40}birthday/i);
    expect(bullet).toMatch(/2\^21\.3[^.]{0,80}quantum[^.]{0,80}BHT/i);
  });
});
