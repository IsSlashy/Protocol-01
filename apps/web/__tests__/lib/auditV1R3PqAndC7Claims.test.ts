/**
 * Two claims on the /pay screens and the waitlist, checked against the code
 * this web client runs (audit v1, round 3, axis 8, fix lane 1).
 *
 * 1. "Post-quantum" sealed notes and stealth identity.
 *    Send (`pay.send.discCurious`), Receive (`pay.receive.discCurious`) and the
 *    HonestyBadge (`pay.shared.byStealthAddress`) call the X25519 + ML-KEM-768
 *    layer post-quantum with no condition. Every ML-KEM secret key behind it is
 *    a deterministic function of ONE Ed25519 signature over a public message
 *    (`message.ts` → `seedDerivation.derivePoolSeeds` → `noteCrypto`, and
 *    pay-core `workerCore.ts` for the stealth meta-address). A party who breaks
 *    the wallet's Ed25519 key — Shor on a public key that is on chain — re-signs
 *    the message and re-derives them, with no ML-KEM cryptanalysis at all. The
 *    v2 passphrase that would change this for sealed notes has no UI: nothing in
 *    `components/` or `app/` sends `poolSetPassphrase`. Only /docs (detail6)
 *    said so; the screens that seal and receive notes did not.
 *
 * 2. "That exit is NOT matchable to the deposit".
 *    A circuit-7 withdrawal publishes the note's nullifier N, and the deposit
 *    published C = P(N, P(b, mint)) with b < 2^63 (`noteBlinding.ts` MASK_63).
 *    The blinding is the only secret between them: trying every b costs about
 *    2^62 hash pairs per withdrawal classically and about 2^31.5 Grover queries.
 *    Because C is ONE ~64-bit Goldilocks element and b spans 2^63 of it, even a
 *    complete search leaves ~39% (1 - e^-0.5) of the OTHER deposits fitting as
 *    well, so it narrows rather than names. The copy said none of this.
 *
 * The premises are behavioural where that is cheap (the key re-derivation, the
 * blinding width, the commitment's shape, a scaled model of the full search),
 * so if the client stops doing what the copy now says, the premise goes red
 * first and the copy must be revisited.
 *
 * Scope: `en` only. `fr` carries the same keys (i18n-parity.test.ts) and the
 * same unqualified sentences; it is not owned by this lane.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import en from '@/i18n/en';
import fr from '@/i18n/fr';
import { buildDerivationMessage } from '@/lib/privacy/message';
import { derivePoolSeeds } from '@/lib/privacy/pool/seedDerivation';
import {
  createNoteEncryptionAddress,
  encryptNote,
  decryptNote,
} from '@/lib/privacy/pool/noteCrypto';
import { deriveNoteBlinding } from '@/lib/privacy/pool/noteBlinding';
import { goldilocksHash2to1 } from '@/lib/privacy/pool/goldilocks-poseidon';
import { createCommitmentV3, createNullifierV3 } from '@/lib/privacy/pool/denominatedPool';

const WEB = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Post-quantum sealed notes and stealth identity
// ---------------------------------------------------------------------------

describe('premise: the sealed-note ML-KEM key falls with the wallet Ed25519 key', () => {
  it('re-signing the public derivation message re-derives the key and opens a sealed note', () => {
    const victim = nacl.sign.keyPair();
    const walletPubkey = bs58.encode(victim.publicKey);
    const msg = Uint8Array.from(new TextEncoder().encode(
      buildDerivationMessage({
        walletPubkey,
        origin: 'https://protocol-01.dev',
        chainTag: 'solana:devnet',
      }),
    ));
    const seeds = derivePoolSeeds(nacl.sign.detached(msg, victim.secretKey), null);
    expect(seeds.activeVersion).toBe(1);
    const address = createNoteEncryptionAddress(seeds.active);
    const plain = Uint8Array.from(new TextEncoder().encode('{"note":"leaf 42","secret":"deadbeef"}'));
    const blob = encryptNote(address, plain);

    // The attacker holds the Ed25519 secret key only (what Shor yields), and
    // public strings. RFC 8032 signatures are deterministic.
    const attackerSeed = derivePoolSeeds(nacl.sign.detached(msg, victim.secretKey), null).active;
    expect(createNoteEncryptionAddress(attackerSeed)).toBe(address);
    expect(Array.from(decryptNote(attackerSeed, blob))).toEqual(Array.from(plain));
  });

  it('no component or page arms the v2 passphrase, so every web user runs v1', () => {
    const offenders = [...walk(path.join(WEB, 'components')), ...walk(path.join(WEB, 'app'))].filter(
      (f) => readFileSync(f, 'utf8').includes('poolSetPassphrase'),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the screens that seal and receive notes say the post-quantum layer reduces to the Ed25519 key', () => {
  const strings: Array<[string, string]> = [
    ['pay.send.discCurious', en.pay.send.discCurious],
    ['pay.receive.discCurious', en.pay.receive.discCurious],
    ['pay.shared.byStealthAddress', en.pay.shared.byStealthAddress],
  ];
  for (const [key, s] of strings) {
    it(`${key} names the Ed25519 wallet key the ML-KEM keys are derived from`, () => {
      expect(s, key).toMatch(/post-quantum/);
      expect(s, key).toMatch(/Ed25519 wallet key/);
      expect(s, key).toMatch(/derived? /);
      expect(s, key).toMatch(/quantum computer/);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Circuit-7 exit "NOT matchable" to its deposit
// ---------------------------------------------------------------------------

describe('premise: only a 63-bit blinding separates a circuit-7 nullifier from its deposit', () => {
  it('the web blinding is 63 bits wide, not narrower and not wider', () => {
    const seed = Uint8Array.from(randomBytes(32));
    const pool = Keypair.generate().publicKey;
    let maxBits = 0;
    for (let i = 0; i < 400; i++) {
      const b = deriveNoteBlinding(seed, pool, i);
      maxBits = Math.max(maxBits, b.toString(2).length);
    }
    expect(maxBits).toBe(63);
  });

  it('the commitment is P(nullifier, P(blinding, mint)), so the published nullifier plus b recomputes it', () => {
    const np = 0x1234_5678_9abc_def0n;
    const secret = 0x0fed_cba9_8765_4321n;
    const blinding = (1n << 62n) + 12345n;
    const mint = 0x42n;
    const n = createNullifierV3(np, secret);
    expect(createCommitmentV3(np, secret, blinding, mint)).toBe(
      goldilocksHash2to1(n, goldilocksHash2to1(blinding, mint)),
    );
  });

  it('a complete search narrows rather than names: ~39% of other deposits still fit (scaled model)', () => {
    // Same 1/2 ratio as 2^63 blindings against a ~2^64 field: blindings 2^13,
    // commitments truncated to 14 bits. 200 deposits, one of them the target.
    const K = 14n;
    const KM = (1n << K) - 1n;
    const BS = 1n << (K - 1n);
    const mint = 0n;
    const inner: bigint[] = [];
    for (let b = 0n; b < BS; b++) inner.push(goldilocksHash2to1(b, mint));
    const rnd = () => BigInt('0x' + randomBytes(8).toString('hex')) % 0xffffffff00000001n;
    const D = 200;
    const deps = Array.from({ length: D }, () => {
      const N = rnd();
      const b = Number(BigInt('0x' + randomBytes(2).toString('hex')) % BS);
      return { N, C: goldilocksHash2to1(N, inner[b]) & KM };
    });
    const target = deps[0];
    const reachable = new Set<bigint>();
    for (const x of inner) reachable.add(goldilocksHash2to1(target.N, x) & KM);
    expect(reachable.has(target.C)).toBe(true);
    const wrongFits = deps.slice(1).filter((d) => reachable.has(d.C)).length / (D - 1);
    // theory 1 - e^-0.5 = 0.393; sd over 199 draws ~0.035
    expect(wrongFits).toBeGreaterThan(0.25);
    expect(wrongFits).toBeLessThan(0.55);
  });
});

describe('every "not matchable" sentence carries the 63-bit bound', () => {
  const strings: Array<[string, string]> = [
    ['pay.receive.discWhere', en.pay.receive.discWhere],
    ['pay.pool.withdrawnPayout', en.pay.pool.withdrawnPayout],
    ['waitlist.admissionBody', en.waitlist.admissionBody],
  ];
  for (const [key, s] of strings) {
    it(`${key} states the 63-bit blinding and the quantum search cost`, () => {
      expect(s, key).toMatch(/63-bit blinding/);
      expect(s, key).toMatch(/2\^31\.5/);
    });
  }

  it('discWhere no longer calls the exit NOT matchable unconditionally', () => {
    expect(en.pay.receive.discWhere).not.toMatch(/that exit is NOT matchable to the deposit\./);
    expect(en.pay.receive.discWhere).toMatch(/2\^62/);
    expect(en.pay.receive.discWhere).toMatch(/four in ten/);
  });

  it('withdrawnPayout no longer says the withdrawal does not point back at its deposit, unqualified', () => {
    expect(en.pay.pool.withdrawnPayout).not.toMatch(/so it does not point back at the deposit it spends —/);
  });

  it('admissionBody no longer says the deposit link is closed, unqualified', () => {
    expect(en.waitlist.admissionBody).not.toMatch(/The spend circuit that closes the deposit link has shipped:/);
  });
});

// ---------------------------------------------------------------------------
// close-v1, lane L4 (finding F65 metadata part, F65 and F66 fr part).
// The French screens and the link previews say the same as the English ones.
// ---------------------------------------------------------------------------

describe('F65, fr: the French screens say the post-quantum layer reduces to the Ed25519 key', () => {
  const strings: Array<[string, string]> = [
    ['pay.send.discCurious', fr.pay.send.discCurious],
    ['pay.receive.discCurious', fr.pay.receive.discCurious],
    ['pay.shared.byStealthAddress', fr.pay.shared.byStealthAddress],
  ];
  for (const [key, s] of strings) {
    it(`fr.${key} names the Ed25519 wallet key the ML-KEM keys are derived from`, () => {
      expect(s, key).toMatch(/post-quantique/);
      expect(s, key).toMatch(/clé Ed25519/);
      expect(s, key).toMatch(/dérivé/);
      expect(s, key).toMatch(/ordinateur quantique/);
    });
  }
});

describe('F66, fr: every French "not matchable" sentence carries the 63-bit bound', () => {
  const strings: Array<[string, string]> = [
    ['pay.receive.discWhere', fr.pay.receive.discWhere],
    ['pay.pool.withdrawnPayout', fr.pay.pool.withdrawnPayout],
    ['waitlist.admissionBody', fr.waitlist.admissionBody],
  ];
  for (const [key, s] of strings) {
    it(`fr.${key} states the 63-bit blinding and the quantum search cost`, () => {
      expect(s, key).toMatch(/aveuglement de 63 bits/);
      expect(s, key).toMatch(/2\^31,5/);
    });
  }

  it('fr discWhere no longer calls the exit NOT matchable unconditionally', () => {
    expect(fr.pay.receive.discWhere).not.toMatch(/cette sortie n’est PAS rapprochable du dépôt\./);
    expect(fr.pay.receive.discWhere).toMatch(/2\^62/);
    expect(fr.pay.receive.discWhere).toMatch(/quatre sur dix/);
  });

  it('fr admissionBody no longer says the deposit link is closed, unqualified', () => {
    expect(fr.waitlist.admissionBody).not.toMatch(/qui referme le lien avec le dépôt est livré :/);
  });
});

describe('F65, metadata: the link previews that name ML-KEM or quantum carry the caveat', () => {
  const ROOT_LAYOUT = readFileSync(path.join(WEB, 'app/layout.tsx'), 'utf8');
  const PAY_PAGE = readFileSync(path.join(WEB, 'app/(pay)/app/page.tsx'), 'utf8');

  /** The string literals assigned to description fields and constants. */
  function descriptions(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/(?:description:\s*|const (?:SOCIAL_)?DESCRIPTION =\s*)\n?\s*"([^"]+)"/g)) out.push(m[1]);
    return out;
  }

  it('reads the descriptions it is about (anti-vacuity)', () => {
    expect(descriptions(ROOT_LAYOUT).length).toBeGreaterThanOrEqual(3);
    expect(descriptions(PAY_PAGE).length).toBeGreaterThanOrEqual(2);
  });

  it('the root layout does not promise proofs "built to outlast quantum computers"', () => {
    for (const d of descriptions(ROOT_LAYOUT)) {
      expect(d).not.toMatch(/outlast quantum computers/);
      // Amounts are public: pools are fixed-denomination (claims-lexicon rule 3).
      expect(d).not.toMatch(/hides? (both|who you pay and how much)|hide who you pay and how much/);
    }
  });

  it('every description that names ML-KEM or quantum says the keys derive from the Ed25519 wallet key', () => {
    for (const d of [...descriptions(ROOT_LAYOUT), ...descriptions(PAY_PAGE)]) {
      if (/ML-KEM|quantum/i.test(d)) {
        expect(d).toMatch(/Ed25519/);
      }
    }
  });
});
