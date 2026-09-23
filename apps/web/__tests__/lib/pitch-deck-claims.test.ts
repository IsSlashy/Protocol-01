/**
 * Claims guard for the pitch deck — docs/PROTOCOL_01_PITCH_DECK.html.
 *
 * WHY THIS EXISTS. [AUDIT-V1 R1 2026-09-22] The deck is the source of
 * `apps/web/public/pitch-deck.pdf`, which the site serves at /pitch-deck.pdf and
 * `docs/HACKATHON.md:4` hands to judges and grant evaluators. `claims-lexicon`
 * only reads the two i18n dictionaries, so the deck drifted on its own and
 * said, in the audit of v1:
 *   - "Every link between the two is severed by ZK-STARK proofs ..."
 *   - "HIDDEN  The customer's wallet identity / transaction history / any link
 *     between two subscribers"
 *   - "Privacy that survives a future quantum adversary", "Post-quantum hardened"
 *   - "~10s on-chain settlement", "Native ZK"
 * while the repo's own sources say the opposite:
 *   - README.md "The pool hides neither today" (the wallet funds the ephemeral
 *     key in the clear; three RPC calls walk back to it);
 *   - the subscription screen (en.ts poolCaveat): "This subscription is not
 *     unlinkable to your wallet";
 *   - app/api/issue-note/route.ts: against the issuer the anonymity set is one;
 *   - README.md: the web pool seed is HKDF(one Ed25519 signature), so a quantum
 *     adversary re-derives every note retroactively;
 *   - docs/BENCHMARK-2026-09-13.md: 18.6 s / 23.0 s / 20.8 s measured, not ~10 s;
 *   - README.md: "zero-knowledge" is not used as a property of this protocol.
 *
 * SCOPE. The rendered text of the HTML (tags stripped, entities left as they
 * are), and, since the audit v1 close-out (lane L5, 2026-09-23, finding F16),
 * the text of the two PDFs printed from it: `docs/PROTOCOL_01_PITCH_DECK.pdf`
 * and the served copy `apps/web/public/pitch-deck.pdf`. The HTML was fixed in
 * round 1 and the PDFs were never regenerated, so the site kept serving
 * "severed", "HIDDEN" and "~10s" while this file was green. The PDF text is read
 * by `pdfText.ts` (no dependency) and compared with whitespace removed, because
 * a printed PDF places glyphs, not words.
 *
 * F69 (round 4) added one refuted claim: "hiding is statistical in the
 * random-oracle model". The simulation argument behind it treats the next-row
 * openings as unpublished; every proof publishes them
 * (`stark/tests/next_row_openings_are_published.rs`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pdfText, squash } from './pdfText';

const ROOT = join(__dirname, '../../../..');
const DECK = 'docs/PROTOCOL_01_PITCH_DECK.html';

function deckText(): string {
  const html = readFileSync(join(ROOT, DECK), 'utf8');
  const body = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

const KEM_KEYS_FROM_ED25519 =
  'apps/web/lib/privacy/pool/noteCrypto.ts deriveNoteEncryptionKeys: the X25519 + ML-KEM-768 keys are HKDF of a seed that is one Ed25519 wallet signature, so they are only as safe as that wallet secret (F65)';

const HYBRID_NOT_STANDARDISED =
  'NIST standardised ML-KEM (FIPS 203), not the hybrid X25519 + ML-KEM-768 stealth construction; slide 09 calls that construction "own design, not a reference port" (F16/F65)';

/** Each pattern is a claim the repo's own measurements or disclaimers refute. */
const REFUTED: Array<[RegExp, string]> = [
  [/\bsever(ed|s)?\b/i, 'README.md: "The pool hides neither today"; the wallet funds the ephemeral key in the clear'],
  [/HIDDEN\s+The customer's wallet identity/i, 'en.ts poolCaveat: "This subscription is not unlinkable to your wallet"'],
  [/HIDDEN\s+The customer's transaction history/i, 'README.md: each note is linkable to its deposit; the effective set is one'],
  [/HIDDEN\s+Any link between two subscribers/i, 'README.md: anyone can enumerate a merchant\'s subscriber vaults'],
  [/survives a future quantum adversary/i, 'README.md: the web pool seed comes from an Ed25519 signature, re-derivable by a quantum adversary'],
  [/post-quantum hardened/i, 'README.md: "The *stack* is not in that position"; Solana verifies Ed25519 only'],
  [/~\s*10\s*s\b/i, 'docs/BENCHMARK-2026-09-13.md: 18.6 s shield, 23.0 s subscribe, 20.8 s unshield'],
  [/\bNative ZK\b/i, 'README.md: "zero-knowledge" is not used as a property of this protocol'],
  [/\bZK-STARK\b/i, 'README.md: "zero-knowledge" is not used as a property of this protocol'],
  [/zero[-\s]?knowledge/i, 'README.md: "zero-knowledge" is not used as a property of this protocol'],
  [/\buntraceable\b/i, 'forbidden property word'],
  [/\btrustless\b/i, 'forbidden property word'],
  [/\b128[-\s]?bits?\b/i, 'forbidden property figure (docs/SECURITY-LEVELS.md)'],
  [/cryptography is proven/i, 'no external audit has run (slide 08 says so itself)'],
  [/hiding is statistical/i, 'docs/zk-simulation-argument.md: the simulation argument does not hold as written (F69)'],
  [/no longer falls to Shor/i, KEM_KEYS_FROM_ED25519],
  [/stealth addresses are now standardi[sz]ed/i, HYBRID_NOT_STANDARDISED],
];

/**
 * The same refuted claims, as phrases compared with whitespace removed: a PDF
 * printed by Chromium keeps glyph order, not word spacing.
 */
const REFUTED_IN_PDF: Array<[string, string]> = [
  ['severed', REFUTED[0][1]],
  ["HIDDEN The customer's wallet identity", REFUTED[1][1]],
  ["HIDDEN The customer's transaction history", REFUTED[2][1]],
  ['HIDDEN Any link between two subscribers', REFUTED[3][1]],
  ['survives a future quantum adversary', REFUTED[4][1]],
  ['post-quantum hardened', REFUTED[5][1]],
  ['~10s', REFUTED[6][1]],
  ['Native ZK', REFUTED[7][1]],
  ['ZK-STARK', REFUTED[8][1]],
  ['zero-knowledge', REFUTED[9][1]],
  ['untraceable', 'forbidden property word'],
  ['trustless', 'forbidden property word'],
  ['128-bit', 'forbidden property figure'],
  ['128 bits', 'forbidden property figure'],
  ['cryptography is proven', REFUTED[13][1]],
  ['hiding is statistical', 'docs/zk-simulation-argument.md: the simulation argument does not hold as written (F69)'],
  ['no longer falls to Shor', KEM_KEYS_FROM_ED25519],
  ['stealth addresses are now standardised', HYBRID_NOT_STANDARDISED],
];

const PDFS = ['docs/PROTOCOL_01_PITCH_DECK.pdf', 'apps/web/public/pitch-deck.pdf'];

describe('[AUDIT-V1 R1] pitch deck claims', () => {
  const text = deckText();

  for (const [pattern, why] of REFUTED) {
    it(`does not claim ${pattern}`, () => {
      const m = text.match(pattern);
      expect(m ? text.slice(Math.max(0, m.index! - 60), m.index! + 90) : null, why).toBeNull();
    });
  }

  it('states that a subscription is linkable to the paying wallet', () => {
    expect(text).toMatch(/linkable to (the|your|their) (customer's )?wallet/i);
  });

  it('says the ML-KEM keys are re-derived from the Ed25519 wallet key (F65)', () => {
    expect(text, KEM_KEYS_FROM_ED25519).toMatch(/ML-KEM[^.]{0,80}Shor[^.]{0,80}re-?deriv\w*[^.]{0,60}Ed25519/i);
  });

  it('quotes the measured devnet flow times, not a rounded-down one', () => {
    for (const measured of ['18.6 s', '23.0 s', '20.8 s']) expect(text).toContain(measured);
  });
});

describe('[AUDIT-V1 close-out F16] the printed pitch deck PDFs carry the corrected deck', () => {
  for (const pdf of PDFS) {
    const curly = /[‘’]/g;
    const text = squash(pdfText(join(ROOT, pdf))).replace(curly, "'");
    const norm = (s: string) => squash(s).replace(curly, "'");

    it(`${pdf} has text to read`, () => {
      expect(text.length).toBeGreaterThan(2000);
    });

    for (const [phrase, why] of REFUTED_IN_PDF) {
      it(`${pdf} does not claim "${phrase}"`, () => {
        const i = text.indexOf(norm(phrase));
        expect(i < 0 ? null : text.slice(Math.max(0, i - 50), i + 80), why).toBeNull();
      });
    }

    it(`${pdf} states that a subscription is linkable to the paying wallet`, () => {
      expect(text).toMatch(/linkableto(the|your|their)(customer's)?wallet/);
    });

    it(`${pdf} says the ML-KEM keys are re-derived from the Ed25519 wallet key (F65)`, () => {
      expect(text, KEM_KEYS_FROM_ED25519).toMatch(/ML-KEM[^.]{0,80}Shor[^.]{0,80}re-?deriv\w*[^.]{0,60}Ed25519/i);
    });

    it(`${pdf} quotes the measured devnet flow times`, () => {
      for (const measured of ['18.6 s', '23.0 s', '20.8 s']) expect(text).toContain(squash(measured));
    });
  }
});
