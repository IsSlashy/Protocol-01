/**
 * close-v1, lane L4: the French dictionary carries the same facts as the
 * English one for every sentence the internal v1 audit corrected.
 *
 * The audit fixed `en.ts` (auditV1PublicClaims, auditV1R2WithdrawalLink,
 * auditV1R3PqAndC7Claims) and left `fr.ts` on the pre-audit text: a French
 * visitor was still told that nullifiers make a double spend impossible, that
 * Grover is "atténuée par la taille du condensé", that the prover blob is the
 * retired 36c1fd4e, that transfer, split and subscribe enforce a maturity
 * delay, that the relayer and the AI agent are current, and "Auto-conservation"
 * on the landing page (findings F15, F17, F19, F20, F21, F23, F24, F26, F50,
 * F65, F66 of AUDIT-V1-FINDINGS.json).
 *
 * Two layers:
 *  1. per finding, the French sentence is checked for the fact it must state
 *     and the false one it must not;
 *  2. a mechanical guard over every audited key: each number the English
 *     sentence states (2^31.5, 889,691, 1/16, 2026-09-12 ...) appears in the
 *     French one once both are normalised (thousands separators dropped,
 *     decimal comma read as a point). A translation that keeps the old figure
 *     or drops the new one goes red here without anyone writing a regex for it.
 *
 * The English sentences for F21 (detail10), F46 (zkSPL) and F53 (Poseidon
 * width) are pinned in auditV1PublicClaims.test.ts; the /pay sentences of F50,
 * F65 and F66 in auditV1R2WithdrawalLink.test.ts and auditV1R3PqAndC7Claims.test.ts.
 */
import { describe, it, expect } from 'vitest';
import en from '@/i18n/en';
import fr from '@/i18n/fr';

type Dict = Record<string, unknown>;

function read(d: unknown, dotted: string): string {
  const v = dotted.split('.').reduce<unknown>((acc, k) => (acc as Dict | undefined)?.[k], d);
  if (typeof v !== 'string') throw new Error(`${dotted} is not a string`);
  return v;
}

const F = (k: string) => read(fr, k);

/** Every key the audit rewrote in en.ts, and the ones this lane rewrites. */
const AUDITED_KEYS = [
  'hero.desc4',
  'waitlist.admissionBody',
  'docs.sections.zkProofs.desc',
  'docs.sections.zkProofs.detail3',
  'docs.sections.zkProofs.detail4',
  'docs.sections.zkProofs.detail5',
  'docs.sections.zkProofs.detail7',
  'docs.sections.zkProofs.detail10',
  'docs.sections.shieldedPool.desc',
  'docs.sections.shieldedPool.detail6',
  'docs.sections.poseidonHash.detail3',
  'docs.sections.poseidonHash.detail5',
  'docs.sections.nullifiers.desc',
  'docs.sections.denominatedPools.desc',
  'docs.sections.denominatedPools.detail3',
  'docs.sections.denominatedPools.detail4',
  'docs.sections.noteSplitting.desc',
  'docs.sections.noteSplitting.detail2',
  'docs.sections.noteSplitting.detail4',
  'docs.sections.zkspl.desc',
  'docs.sections.zkspl.detail4',
  'docs.sections.zkspl.detail5',
  'docs.sections.aiAgent.title',
  'docs.sections.aiAgent.desc',
  'docs.sections.migrationHistory.detail1',
  'docs.sections.migrationHistory.detail3',
  'docs.sections.migrationHistory.detail4',
  'docs.guaranteeNoDouble',
  'roadmap.items.confidentialBalances.desc',
  'pay.page.limitsLede',
  'pay.page.limit2Title',
  'pay.page.limit2Body',
  'pay.shared.byStealthAddress',
  'pay.pool.withdrawnPayout',
  'pay.pool.contributedNote',
  'pay.pool.depositFunderBody',
  'pay.send.discCurious',
  'pay.send.discWeb',
  'pay.receive.discWhere',
  'pay.receive.discCurious',
  'pay.subscribe.costRentPart3',
  'pay.subscribe.costCommitment',
] as const;

/**
 * The numbers a sentence states, normalised so "889,691" (en) and "889 691"
 * (fr), "2^31.5" and "2^31,5", "21.33" and "21,33" compare equal.
 */
function numbersOf(s: string, locale: 'en' | 'fr'): Set<string> {
  let t = s;
  if (locale === 'en') {
    t = t.replace(/(\d),(?=\d{3}\b)/g, '$1');
  } else {
    t = t.replace(/(\d)[   ](?=\d{3}\b)/g, '$1').replace(/(\d),(\d)/g, '$1.$2');
  }
  return new Set(t.match(/\d+(?:\.\d+)?/g) ?? []);
}

describe('guard: every number an audited English sentence states is in its French twin', () => {
  it('the normaliser reads both locales the same way (anti-vacuity)', () => {
    expect([...numbersOf('889,691 CU, 2^31.5 queries, 21.33 bits, 2026-09-12', 'en')].sort()).toEqual(
      ['09', '12', '2', '2026', '21.33', '31.5', '889691'].sort(),
    );
    expect([...numbersOf('889 691 CU, 2^31,5 requêtes, 21,33 bits, 2026-09-12', 'fr')].sort()).toEqual(
      ['09', '12', '2', '2026', '21.33', '31.5', '889691'].sort(),
    );
  });

  for (const key of AUDITED_KEYS) {
    it(`fr.${key} states every number en.${key} states`, () => {
      const want = numbersOf(read(en, key), 'en');
      const have = numbersOf(F(key), 'fr');
      const missing = [...want].filter((n) => !have.has(n));
      expect(missing, `fr.${key} lacks ${missing.join(', ')}\nfr: ${F(key)}`).toEqual([]);
    });
  }
});

describe('F15 / F51: no unconditional double-spend guarantee in French', () => {
  it('the guarantees card', () => {
    expect(F('docs.guaranteeNoDouble')).not.toMatch(/uniques par engagement/);
    expect(F('docs.guaranteeNoDouble')).toMatch(/64 bits/);
    expect(F('docs.guaranteeNoDouble')).toMatch(/F2/);
  });
  it('the nullifier section', () => {
    expect(F('docs.sections.nullifiers.desc')).not.toMatch(/exactement un nullifieur valide/);
    expect(F('docs.sections.nullifiers.desc')).toMatch(/64 bits/);
  });
  it('the pool and split details carry the v1 limit', () => {
    expect(F('docs.sections.denominatedPools.detail3')).toMatch(/F2/);
    expect(F('docs.sections.denominatedPools.detail3')).not.toMatch(/prévention atomique de la double dépense/);
    expect(F('docs.sections.noteSplitting.detail4')).toMatch(/F2/);
  });
});

describe('F17: the landing line does not say "Auto-conservation"', () => {
  it('hero.desc4 says the deployment can spend a note it hands over', () => {
    expect(F('hero.desc4')).not.toMatch(/^Auto-conservation/);
    expect(F('hero.desc4')).toMatch(/peut la dépenser/);
  });
  it('the contribution card says the deployment can spend the note it handed over', () => {
    expect(F('pay.pool.contributedNote')).toMatch(/peut la dépenser/);
  });
});

describe('F19: Grover is not "mitigated by digest size" in French either', () => {
  it('zkProofs.detail7 and poseidonHash.detail5 state the 64-bit digest bounds', () => {
    expect(F('docs.sections.zkProofs.detail7')).not.toMatch(/atténuée par la taille du condensé/);
    expect(F('docs.sections.zkProofs.detail7')).toMatch(/21,33/);
    expect(F('docs.sections.poseidonHash.detail5')).toMatch(/64 bits/);
    expect(F('docs.sections.poseidonHash.detail5')).toMatch(/32,00/);
    expect(F('docs.sections.poseidonHash.detail5')).not.toMatch(/simple accélération quadratique de Grover$/);
  });
});

describe('F20 / F21 / F26: the blob, the deployment and the FRI parameters in French', () => {
  it('names the shipped blob, not the retired 36c1fd4e', () => {
    expect(F('docs.sections.zkProofs.detail5')).toMatch(/241caaab/);
    expect(F('docs.sections.zkProofs.detail5')).toMatch(/240 172/);
    expect(F('docs.sections.zkProofs.detail5')).not.toMatch(/36c1fd4e|274 224/);
  });
  it('names the current verifier deployment', () => {
    expect(F('docs.sections.zkProofs.detail4')).toMatch(/497 235 406/);
    expect(F('docs.sections.zkProofs.detail4')).not.toMatch(/491 973 056/);
  });
  it('the parameter line: 27 queries on C1 and C2 only, 22 bits of grinding', () => {
    expect(F('docs.sections.zkProofs.detail3')).not.toMatch(/16 bits de grinding/);
    expect(F('docs.sections.zkProofs.detail3')).toMatch(/22 bits de grinding/);
    expect(F('docs.sections.zkProofs.detail3')).not.toMatch(/27 sur les quatre autres/);
  });
  it('detail10 no longer says the achieved rate was measured lower', () => {
    expect(F('docs.sections.zkProofs.detail10')).not.toMatch(/mesuré plus bas/);
    expect(F('docs.sections.zkProofs.detail10')).toMatch(/1\/16/);
  });
});

describe('F23: no enforced maturity delay in French', () => {
  it('denominatedPools.detail4', () => {
    expect(F('docs.sections.denominatedPools.detail4')).not.toMatch(/l’appliquent tous/);
    expect(F('docs.sections.denominatedPools.detail4')).toMatch(/appelant/);
  });
});

describe('F24: removed or superseded parts are not presented as current in French', () => {
  it('no ~3 s shield', () => {
    expect(F('docs.sections.shieldedPool.detail6')).not.toMatch(/~3s|instantané/i);
    expect(F('docs.sections.shieldedPool.detail6')).toMatch(/18,6 s/);
  });
  it('no relayer path today', () => {
    expect(F('docs.sections.shieldedPool.desc')).not.toMatch(/^Les transferts privés peuvent passer par le relayeur/);
    expect(F('docs.sections.shieldedPool.desc')).toMatch(/aucun nœud relayeur/);
  });
  it('the AI agent is removed', () => {
    expect(F('docs.sections.aiAgent.title')).toMatch(/retiré/i);
    expect(F('docs.sections.aiAgent.desc')).toMatch(/Retiré le 2026-09-13/);
  });
  it('no Circom circuit, no Blake3 + Poseidon, 8 AIRs', () => {
    expect(F('docs.sections.noteSplitting.detail2')).not.toMatch(/^Circuit : note_split\.circom/);
    expect(F('docs.sections.noteSplitting.desc')).not.toMatch(/plus difficiles à tracer|une seule preuve ZK/);
    expect(F('docs.sections.migrationHistory.detail3')).not.toMatch(/Blake3 \+ Poseidon/);
    expect(F('docs.sections.migrationHistory.detail4')).not.toMatch(/\b7 AIRs\b/);
    expect(F('docs.sections.migrationHistory.detail4')).toMatch(/\b8 AIRs\b/);
  });
  it('the masking statement covers all eight circuits and still denies the property', () => {
    expect(F('docs.sections.zkProofs.desc')).not.toMatch(/contrairement aux sept autres/);
    expect(F('docs.sections.zkProofs.desc')).toMatch(/huit circuits/);
    expect(F('docs.sections.zkProofs.desc')).toMatch(/ne sont pas à divulgation nulle/);
  });
  it('the denominated-pool description does not say every withdrawal republishes the commitment', () => {
    expect(F('docs.sections.denominatedPools.desc')).not.toMatch(/le retrait publie l’engagement que le dépôt avait émis/);
  });
});

/**
 * Verifier round 1 of close-v1: each sentence below was rewritten by this lane
 * but no assertion went red when it alone was put back to its pre-lane text
 * (the number guard above only caught zkspl.detail4, through "Poseidon(0, 0)").
 * One assertion per sentence, en and fr, each red on the pre-lane dictionary.
 */
const E = (k: string) => read(en, k);

describe('F46: the zkSPL copy says what the program source does not enforce, in both languages', () => {
  it('docs.sections.zkspl.desc', () => {
    expect(E('docs.sections.zkspl.desc')).not.toMatch(/Quantum-resistant by design/);
    expect(E('docs.sections.zkspl.desc')).toMatch(/does not check the threshold/);
    expect(E('docs.sections.zkspl.desc')).toMatch(/any amount can be withdrawn/);
    expect(F('docs.sections.zkspl.desc')).not.toMatch(/Résistant au quantique par conception/);
    expect(F('docs.sections.zkspl.desc')).toMatch(/ne vérifie pas le seuil/);
    expect(F('docs.sections.zkspl.desc')).toMatch(/n’importe quel montant peut être retiré/);
  });
  it('docs.sections.zkspl.detail4 (conservation)', () => {
    expect(E('docs.sections.zkspl.detail4')).toMatch(/not enforced/);
    expect(F('docs.sections.zkspl.detail4')).toMatch(/n’est pas appliquée/);
    expect(F('docs.sections.zkspl.detail4')).toMatch(/n’importe quel montant peut être retiré/);
  });
  it('docs.sections.zkspl.detail5 (threshold)', () => {
    expect(E('docs.sections.zkspl.detail5')).toMatch(/not enforced/);
    expect(E('docs.sections.zkspl.detail5')).not.toMatch(/^Balance proof: proves/);
    expect(F('docs.sections.zkspl.detail5')).toMatch(/n’est pas appliquée/);
    expect(F('docs.sections.zkspl.detail5')).toMatch(/sans le vérifier/);
    expect(F('docs.sections.zkspl.detail5')).not.toMatch(/^Preuve de solde : prouve/);
  });
  it('roadmap.items.confidentialBalances.desc', () => {
    expect(E('roadmap.items.confidentialBalances.desc')).not.toMatch(/Quantum-resistant privacy/);
    expect(E('roadmap.items.confidentialBalances.desc')).toMatch(/does not yet enforce the balance threshold or the conservation/);
    expect(F('roadmap.items.confidentialBalances.desc')).not.toMatch(/résistante au quantique/i);
    expect(F('roadmap.items.confidentialBalances.desc')).toMatch(/n’applique pas encore le seuil de solde ni la conservation/);
  });
});

describe('F53: the Poseidon width, in both languages', () => {
  it('docs.sections.poseidonHash.detail3 names t=3 and says t=5 is unused and not MDS', () => {
    expect(E('docs.sections.poseidonHash.detail3')).not.toMatch(/t=3 and t=5 widths/);
    expect(E('docs.sections.poseidonHash.detail3')).toMatch(/t=5[^.]*unused, and is not MDS/);
    expect(F('docs.sections.poseidonHash.detail3')).not.toMatch(/largeurs t=3 et t=5/);
    expect(F('docs.sections.poseidonHash.detail3')).toMatch(/largeur t=3/);
    expect(F('docs.sections.poseidonHash.detail3')).toMatch(/t=5[^.]*inutilisée, et n’est pas MDS/);
  });
});

describe('F05: the deposit card does not describe the C1 + C3 pair as this app’s fallback', () => {
  it('pay.pool.depositFunderBody', () => {
    expect(E('pay.pool.depositFunderBody')).not.toMatch(/what this app tries first/);
    expect(E('pay.pool.depositFunderBody')).not.toMatch(/only the C1 \+ C3 fallback/);
    expect(E('pay.pool.depositFunderBody')).toMatch(/the only spend this app runs/);
    expect(F('pay.pool.depositFunderBody')).not.toMatch(/ce que cette app tente en premier/);
    expect(F('pay.pool.depositFunderBody')).not.toMatch(/seul le repli C1 \+ C3/);
    expect(F('pay.pool.depositFunderBody')).toMatch(/la seule dépense que cette app exécute/);
  });
});

describe('F68: the privacy-toolkit captions say BN254, legacy, not the pool hash, in both languages', () => {
  // The sdkDemo.* toolkit captions went with the sdk-demo toolkit block on
  // 2026-09-23 (privacy-toolkit's source was deleted); the docs page keys stay.
  it('the sdk-demo toolkit keys are gone in both languages', () => {
    for (const k of ['sdkDemo.sdkPrivacyToolkitDesc', 'sdkDemo.privacyToolkitDesc', 'sdkDemo.privacyToolkitCodeTitle']) {
      expect(() => E(k)).toThrow(/is not a string/);
      expect(() => F(k)).toThrow(/is not a string/);
    }
  });
  it('docs.nodePrivacyToolkitSub', () => {
    expect(E('docs.nodePrivacyToolkitSub')).toMatch(/BN254/);
    expect(E('docs.nodePrivacyToolkitSub')).toMatch(/legacy/);
    expect(F('docs.nodePrivacyToolkitSub')).toMatch(/BN254/);
    expect(F('docs.nodePrivacyToolkitSub')).toMatch(/legacy/);
  });
  it('docs.sections.clientSdk.detail8', () => {
    expect(E('docs.sections.clientSdk.detail8')).not.toMatch(/Incremental Merkle tree/);
    expect(E('docs.sections.clientSdk.detail8')).toMatch(/BN254[\s\S]*not the pool’s Goldilocks Poseidon/);
    expect(F('docs.sections.clientSdk.detail8')).not.toMatch(/Arbre de Merkle incrémental/);
    expect(F('docs.sections.clientSdk.detail8')).toMatch(/BN254[\s\S]*pas le Poseidon Goldilocks du pool/);
  });
});

describe('F24: scope and history, in both languages', () => {
  it('docs.sections.denominatedPools.desc is scoped to this web app, the phone still republishing', () => {
    expect(E('docs.sections.denominatedPools.desc')).toMatch(/From this web app a withdrawal proves/);
    expect(E('docs.sections.denominatedPools.desc')).toMatch(/the phone still republishes it/);
    expect(F('docs.sections.denominatedPools.desc')).toMatch(/Depuis cette application web, un retrait prouve/);
    expect(F('docs.sections.denominatedPools.desc')).toMatch(/le téléphone le republie encore/);
  });
  it('docs.sections.migrationHistory.detail1 says the eighth circuit, spend, came later', () => {
    expect(E('docs.sections.migrationHistory.detail1')).toMatch(/7 circuits of the time \(an eighth, spend, was added in August 2026\)/);
    expect(F('docs.sections.migrationHistory.detail1')).toMatch(/7 circuits de l’époque \(un huitième, spend, a été ajouté en août 2026\)/);
  });
});
