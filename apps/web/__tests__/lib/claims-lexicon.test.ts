/**
 * Claims lexicon guard for the marketing site.
 *
 * WHY THIS EXISTS. `stark/tests/zk_feasibility.rs` recovers a private witness
 * from published proof bytes by Lagrange interpolation in under a second: the
 * prover is not zero-knowledge, and anyone with a cargo command can prove it.
 * This repo has a documented history of the opposite claim returning through
 * one-line dictionary edits (46 false claims on record, the Arcium strings, the
 * "124-bit" figure). Sibling guard: `__tests__/lib/i18n-parity.test.ts`.
 *
 * WHY IT IS CONTEXTUAL AND NOT A WORD BAN. "post-quantum" applied to the STARK
 * proofs, the note encryption or the stealth addresses is TRUE (hash-based
 * construction, X25519 + ML-KEM-768 per FIPS 203) and must keep passing.
 * Applied to signatures, payments or transactions it is FALSE (Solana verifies
 * Ed25519 and nothing else) and must fail. Likewise "zero-knowledge" must stay
 * usable in sentences that state the property is NOT held. A blunt ban would
 * go red on true sentences and be disabled at the first false positive, which
 * is how a guard dies.
 *
 * SCOPE. String VALUES of the two locale dictionaries. Comments in the source
 * files are not scanned: they are not rendered, and several of them document
 * removals by quoting the removed words.
 *
 * EVERY exception is named key by key, each with its justification. No
 * catch-all patterns in the allowlists.
 */
import { describe, it, expect } from 'vitest';
import en from '@/i18n/en';
import fr from '@/i18n/fr';

type Dict = Record<string, unknown>;

/** Flatten a nested dictionary into [dotted leaf path, string value] pairs. */
function leafEntries(obj: Dict, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...leafEntries(v as Dict, full));
    } else if (typeof v === 'string') {
      out.push([full, v]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 1 - "zero-knowledge" / "divulgation nulle"
//
// The term may appear ONLY in strings that state the property is not held.
// Both conditions are enforced: the key must be allowlisted, AND the value
// must still read as a limitation. An allowlisted key whose text flips back
// to a positive claim goes red again, so the allowlist is not a hole.
// ---------------------------------------------------------------------------
const ZK_TERM = /zero[-\s]?knowledge|divulgation nulle/i;

/** The string must contain one of these denial forms to use the term at all. */
const ZK_DENIAL =
  /not zero[-\s]?knowledge|ne sont pas (encore )?à divulgation nulle|pas (encore )?à divulgation nulle/i;

const ZK_ALLOWED = new Map<string, string>([
  [
    'docs.sections.zkProofs.desc',
    'Names the property to deny it: trace values are recoverable from the published proof bytes (stark/tests/zk_feasibility.rs), masking not landed.',
  ],
  [
    'docs.guaranteeZk',
    'The guarantees card states the property is NOT held and names the witness recovery that proves it. Flips only when zk_feasibility.rs stops recovering.',
  ],
]);

// ---------------------------------------------------------------------------
// Rule 2 - "post-quantum" and its variants
//
// (a) The term may never sit on a false subject: transactions, payments or
//     signatures are Ed25519 on Solana and stay classical. One named
//     exception: the sentence that says exactly that.
// (b) Any string using the term must also name a true carrier (proofs,
//     stealth, KEM, hash, field...) so the claim stays attached to what
//     actually holds it. Label-only strings whose carrier is a sibling key
//     are excepted one by one.
// ---------------------------------------------------------------------------
const PQ_TERM =
  /post[-\s]?quant(um|ique)|quantum[-\s]?(resistant|resistance|safe)|résistan\w*\s+(au\s+)?quantique|résistance quantique/i;

const PQ_FALSE_SUBJECT = [
  // English: adjective before the noun.
  /post[-\s]?quantum (transactions?|payments?|signatures?)/i,
  /quantum[-\s]?(resistant|safe) (transactions?|payments?|signatures?)/i,
  // French: adjective after the noun, with room for one adverb in between
  // ("une transaction entièrement post-quantique").
  /(transactions?|paiements?|signatures?)( \S+)? post[-\s]?quantiques?/i,
  /(transactions?|paiements?|signatures?)( \S+)? résistant\w*\s+(au\s+)?quantique/i,
];

const PQ_FALSE_SUBJECT_ALLOWED = new Map<string, string>([
  [
    'waitlist.projectNoteSignatures',
    'The model honest sentence: it DENIES the false subject ("no protocol on this chain can offer a fully post-quantum transaction today") and points the post-quantum work at the proofs and the stealth addresses.',
  ],
]);

const PQ_CARRIER =
  /stark|proof|preuve|stealth|furtiv|kem|encapsulation|hash|hach|poseidon|goldilocks|field|corps|wots|blake3|merkle/i;

const PQ_CARRIER_ALLOWED = new Map<string, string>([
  [
    'explorer.stat.circuitsHint',
    'Two-word caption under the "STARK Circuits" stat: the carrier is the sibling label key, not this string.',
  ],
  [
    'founder.built.quantum',
    'Category label on the founder page ("Quantum Resistance") heading a list whose entries are the STARK and ML-KEM work.',
  ],
]);

// ---------------------------------------------------------------------------
// Rule 3 - "amounts are hidden"
//
// Pools are fixed-denomination and each pool address derives from its
// denomination: the amount a note moves is public. Negations pass naturally
// because the patterns require adjacency ("amounts are not hidden" does not
// match "amounts are hidden"). No exceptions today; if a true sentence ever
// trips this, name its key here with its justification.
// ---------------------------------------------------------------------------
const AMOUNTS_HIDDEN = [
  /amounts? (are |stay |remain |get |is )?(hidden|masked|shielded|concealed|invisible|unreadable)/i,
  /hides? (the |your )?amounts?/i,
  /montants? (sont |restent |demeurent )?(caché|masqué|invisibl|illisibl)/i,
  /(cache|masque)(nt)? les montants/i,
];

const AMOUNTS_HIDDEN_ALLOWED = new Map<string, string>([]);

// ---------------------------------------------------------------------------
// The scanner. Pure function over a dictionary object so the controls below
// can feed it poisoned inputs.
// ---------------------------------------------------------------------------
type Violation = { key: string; rule: string; value: string };

function scanClaims(dict: Dict): Violation[] {
  const violations: Violation[] = [];
  for (const [key, value] of leafEntries(dict)) {
    if (ZK_TERM.test(value)) {
      if (!ZK_ALLOWED.has(key)) {
        violations.push({ key, rule: 'zero-knowledge outside the allowlist', value });
      } else if (!ZK_DENIAL.test(value)) {
        violations.push({
          key,
          rule: 'allowlisted zero-knowledge key no longer reads as a limitation',
          value,
        });
      }
    }

    if (PQ_FALSE_SUBJECT.some((re) => re.test(value)) && !PQ_FALSE_SUBJECT_ALLOWED.has(key)) {
      violations.push({
        key,
        rule: 'post-quantum applied to transactions, payments or signatures',
        value,
      });
    }

    if (PQ_TERM.test(value) && !PQ_CARRIER.test(value) && !PQ_CARRIER_ALLOWED.has(key)) {
      violations.push({
        key,
        rule: 'post-quantum with no true carrier (proofs, stealth, KEM, hash...) in the same string',
        value,
      });
    }

    for (const re of AMOUNTS_HIDDEN) {
      if (re.test(value) && !AMOUNTS_HIDDEN_ALLOWED.has(key)) {
        violations.push({ key, rule: 'claims amounts are hidden', value });
        break;
      }
    }
  }
  return violations;
}

function pretty(violations: Violation[], locale: string): string[] {
  return violations.map((v) => `${locale}.${v.key} [${v.rule}]: ${v.value}`);
}

// ---------------------------------------------------------------------------
// The guard proper.
// ---------------------------------------------------------------------------
const DICTS: ReadonlyArray<readonly [string, Dict]> = [
  ['en', en as unknown as Dict],
  ['fr', fr as unknown as Dict],
];

describe('claims lexicon: what the dictionaries may and may not say', () => {
  for (const [name, dict] of DICTS) {
    it(`${name} carries no refutable claim the lexicon covers`, () => {
      expect(pretty(scanClaims(dict), name)).toEqual([]);
    });
  }

  it('every allowlisted key still exists in both dictionaries', () => {
    // A renamed key would otherwise leave a dead allowlist entry and a guard
    // that silently no longer covers what it thinks it covers.
    const allowlisted = [
      ...ZK_ALLOWED.keys(),
      ...PQ_FALSE_SUBJECT_ALLOWED.keys(),
      ...PQ_CARRIER_ALLOWED.keys(),
      ...AMOUNTS_HIDDEN_ALLOWED.keys(),
    ];
    for (const [name, dict] of DICTS) {
      const keys = new Set(leafEntries(dict).map(([k]) => k));
      for (const key of allowlisted) {
        expect(keys.has(key), `${name} lost allowlisted key ${key}`).toBe(true);
      }
    }
  });
});

/**
 * Control of the control. A guard that never catches anything is
 * indistinguishable from a guard, and this repo has been bitten by that shape
 * nine times. Each case below reintroduces a claim this repo actually shipped
 * (or its minimal form) and asserts the scanner goes red on it. If a refactor
 * of the rules ever makes one of these pass silently, the refactor is wrong.
 */
describe('claims lexicon: the guard itself bites', () => {
  it('catches the exact zero-knowledge guarantee this repo shipped until 2026-08-16', () => {
    const poisoned = { docs: { anyKey: 'Zero-knowledge: Proofs reveal nothing beyond validity' } };
    const rules = scanClaims(poisoned).map((v) => v.rule);
    expect(rules).toContain('zero-knowledge outside the allowlist');
  });

  it('catches an allowlisted key whose text flips back to a positive claim', () => {
    const poisoned = { docs: { guaranteeZk: 'Zero-knowledge: proofs reveal nothing at all' } };
    const rules = scanClaims(poisoned).map((v) => v.rule);
    expect(rules).toContain('allowlisted zero-knowledge key no longer reads as a limitation');
  });

  it('catches post-quantum payments, even when a true carrier shares the sentence', () => {
    const poisoned = {
      hero: { a: 'Post-quantum payments on Solana' },
      docs: { b: 'Fully post-quantum transactions secured by STARK proofs' },
      fr: { c: 'Des paiements entièrement post-quantiques sur Solana' },
    };
    const hits = scanClaims(poisoned).filter(
      (v) => v.rule === 'post-quantum applied to transactions, payments or signatures',
    );
    expect(hits.map((v) => v.key).sort()).toEqual(['docs.b', 'fr.c', 'hero.a']);
  });

  it('catches post-quantum floating free of any true carrier', () => {
    const poisoned = { cta: { d: 'The wallet is post-quantum' } };
    const rules = scanClaims(poisoned).map((v) => v.rule);
    expect(rules).toContain(
      'post-quantum with no true carrier (proofs, stealth, KEM, hash...) in the same string',
    );
  });

  it('catches hidden-amounts claims in both languages', () => {
    const poisoned = {
      docs: { threatAmounts: 'Transaction amounts are hidden in shielded transfers' },
      howItWorks: { zeroTraces: 'Montants masqués' },
    };
    const hits = scanClaims(poisoned).filter((v) => v.rule === 'claims amounts are hidden');
    expect(hits.map((v) => v.key).sort()).toEqual(['docs.threatAmounts', 'howItWorks.zeroTraces']);
  });

  it('passes the true sentences the rules exist to protect', () => {
    const truthful = {
      a: 'Hash-based post-quantum STARK proofs, no trusted setup',
      b: 'Adresses furtives hybrides X25519 + ML-KEM-768 (FIPS 203), post-quantiques',
      c: 'Transaction signatures are Ed25519 and stay Ed25519',
      d: 'Amounts are not hidden: pools are fixed-denomination',
      e: 'Les montants ne sont pas cachés : les pools sont à dénomination fixe',
    };
    expect(pretty(scanClaims(truthful), 'control')).toEqual([]);
  });
});
