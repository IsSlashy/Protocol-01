/**
 * close-v1, lane L4: the /pay panels speak both languages about an issued
 * note, and turn the refusal codes of the other lanes into sentences.
 *
 * F07. The audit's fix put the "only copy" warning, the recovery code and the
 * restore form into PoolPanel as hard-coded English, so a French buyer read
 * the one warning that decides whether a 1 SOL note survives a cleared cache
 * in a language the rest of the screen does not use.
 *
 * F05 and friends. The builders and the worker now refuse before anything is
 * paid, with an Error whose message starts with a stable code (contract C2 of
 * close-v1/PLAN.md): `C1C3_SPEND_DISABLED` (lane L3, the copyable C1 + C3
 * spend), `POOL_TREE_DIVERGED` and `POOL_DEPOSITS_BRICKED` (lane L3
 * pre-flights), `IMPORT_NOT_ON_TREE` and `EXCHANGE_DISABLED` (lane L2). The
 * code is for machines; the panel shows the matching sentence of the
 * visitor's language.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import en from '@/i18n/en';
import fr from '@/i18n/fr';
import { POOL_ERROR_CODES, localizePoolError, poolErrorCode } from '@/components/pay/errorCodes';

const WEB = path.resolve(__dirname, '../..');

/** Source with comments removed, so a comment quoting a sentence does not count. */
function codeOnly(rel: string): string {
  return readFileSync(path.join(WEB, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\s+/g, ' ');
}

type Dict = Record<string, unknown>;
const lookup = (d: unknown, k: string) =>
  k.split('.').reduce<unknown>((a, p) => (a as Dict | undefined)?.[p], d) as string;
const tEn = (k: string) => lookup(en, k);
const tFr = (k: string) => lookup(fr, k);

describe('the refusal codes map to a sentence in each language', () => {
  it('knows the five codes of contract C2, and the payment and relay codes of gate r1 (F57)', () => {
    // Every code a panel can receive is also read from the sources by
    // `closeV1PayErrorCodesAll.test.ts`; this list pins the exact set.
    expect([...POOL_ERROR_CODES].sort()).toEqual(
      [
        'C1C3_SPEND_DISABLED', 'EXCHANGE_DISABLED', 'IMPORT_NOT_ON_TREE', 'POOL_DEPOSITS_BRICKED', 'POOL_TREE_DIVERGED',
        'PAYMENT_EXPIRED', 'PAYMENT_FAILED_ON_CHAIN', 'PAYMENT_OUTSTANDING',
        'RELAYED_EPHEMERAL_REQUIRED', 'RELAYED_EPHEMERAL_UNBOUND', 'RELAYED_FUNDING_UNSEEN', 'RELAYED_FLOAT_NOT_RETURNED',
        'FUNDER_IP_BUDGET', 'FUNDER_GLOBAL_BUDGET', 'FUNDER_UNSWEPT_GRANT',
      ].sort(),
    );
  });

  it('finds the code at the start of a message, after an Error prefix, and nowhere it is not', () => {
    expect(poolErrorCode('C1C3_SPEND_DISABLED: v3 unshield refused')).toBe('C1C3_SPEND_DISABLED');
    expect(poolErrorCode('Error: POOL_TREE_DIVERGED: root 12 != 34')).toBe('POOL_TREE_DIVERGED');
    expect(poolErrorCode('Worker said: IMPORT_NOT_ON_TREE: leaf 3')).toBe('IMPORT_NOT_ON_TREE');
    expect(poolErrorCode('The deployment could not issue a note just now.')).toBeNull();
    expect(poolErrorCode('XC1C3_SPEND_DISABLED: nope')).toBeNull();
  });

  for (const code of ['C1C3_SPEND_DISABLED', 'POOL_TREE_DIVERGED', 'POOL_DEPOSITS_BRICKED', 'IMPORT_NOT_ON_TREE', 'EXCHANGE_DISABLED']) {
    it(`${code}: a translated sentence, never the code itself`, () => {
      const raw = `${code}: detail the lib wrote in English`;
      const e = localizePoolError(raw, tEn);
      const f = localizePoolError(raw, tFr);
      expect(e).not.toContain(code);
      expect(f).not.toContain(code);
      expect(e.length).toBeGreaterThan(40);
      expect(f.length).toBeGreaterThan(40);
      expect(f).not.toBe(e);
      // Nothing was paid: every one of these refusals fires before a payment.
      expect(e).toMatch(/Nothing was (paid|spent|proved)/);
      expect(f).toMatch(/Rien n’a été (payé|dépensé|prouvé)/);
    });
  }

  it('a message without a code passes through unchanged', () => {
    expect(localizePoolError('Shield failed.', tEn)).toBe('Shield failed.');
  });

  it('C1C3_SPEND_DISABLED says the note cannot be spent from this web app until v2', () => {
    expect(en.pay.errors.c1c3SpendDisabled).toMatch(/cannot be spent from this web app until v2/);
    expect(fr.pay.errors.c1c3SpendDisabled).toMatch(/ne peut pas être dépensée depuis cette application web avant la v2/);
  });

  it('every panel that shows a pool error routes it through the mapping', () => {
    for (const f of [
      'components/pay/PoolPanel.tsx',
      'components/pay/SubscribePanel.tsx',
      'components/pay/ReceivePanel.tsx',
    ]) {
      expect(codeOnly(f), f).toMatch(/localizePoolError\(/);
    }
  });
});

describe('F07: the issued-note warning, the recovery code and the restore form are translated', () => {
  const KEYS = [
    'pay.pool.issuedOnlyCopyLead',
    'pay.pool.issuedOnlyCopyBody',
    'pay.pool.issuedOnlyCopyWithCode',
    'pay.pool.issuedOnlyCopyWithCodeShieldTab',
    'pay.pool.issuedOnlyCopyNoCode',
    'pay.pool.recoveryCodeLabel',
    'pay.pool.showRecoveryCode',
    'pay.pool.hideRecoveryCode',
    'pay.pool.restoreButton',
    'pay.pool.restoredNote',
    'pay.pool.restoreBadCode',
    'pay.pool.restoreFailed',
  ];
  for (const k of KEYS) {
    it(`${k} exists in en and fr, and fr is French`, () => {
      expect(typeof tEn(k), `en.${k}`).toBe('string');
      expect(typeof tFr(k), `fr.${k}`).toBe('string');
      expect(tFr(k)).not.toBe(tEn(k));
    });
  }

  it('no pay component hard-codes the English warning or the restore form any more', () => {
    for (const f of ['components/pay/PoolPanel.tsx', 'components/pay/IssuedNoteOnlyCopy.tsx', 'components/pay/SubscribePanel.tsx']) {
      const code = codeOnly(f);
      expect(code, f).not.toMatch(/This device holds the only copy of this note/);
      expect(code, f).not.toMatch(/>\s*Show recovery code\s*</);
      expect(code, f).not.toMatch(/>\s*Restore the note\s*</);
      expect(code, f).not.toMatch(/That is not a recovery code/);
      expect(code, f).not.toMatch(/Note restored on this device/);
      // Verifier round 2: the label of the revealed code and of the restore
      // field. Case-sensitive: the capitalised label is UI text, and the
      // sources carry it only in comments (stripped above).
      expect(code, f).not.toMatch(/Recovery code/);
    }
  });

  it('the French warning says the device holds the only copy and the seed cannot rebuild it', () => {
    expect(fr.pay.pool.issuedOnlyCopyLead).toMatch(/seule copie/);
    expect(fr.pay.pool.issuedOnlyCopyBody).toMatch(/graine/);
  });
});

describe('F09: the issuance warning of the Subscribe tab says what the issuer can do', () => {
  it('issuedBody1 and issuedNot are not empty, in either language', () => {
    for (const d of [en, fr]) {
      expect(d.pay.subscribe.issuedBody1.trim().length).toBeGreaterThan(40);
      expect(d.pay.subscribe.issuedNot.trim().length).toBeGreaterThan(0);
    }
  });

  // Verifier round 2: the negation is its own bold key, and the sentence
  // around it only reads true with it. Emptied, or softened, it says the
  // deployment cannot see the buyer.
  it('issuedNot is exactly the negation: "not" in en, "pas" in fr', () => {
    expect(en.pay.subscribe.issuedNot).toBe('not');
    expect(fr.pay.subscribe.issuedNot).toBe('pas');
    expect(en.pay.subscribe.issuedBody1).toMatch(/It does $/);
    expect(fr.pay.subscribe.issuedBody1).toMatch(/Elle ne vous cache $/);
  });

  it('the assembled sentence says the deployment can recognise and spend the note', () => {
    const e = en.pay.subscribe.issuedBody1 + en.pay.subscribe.issuedNot + en.pay.subscribe.issuedBody2;
    const f = fr.pay.subscribe.issuedBody1 + fr.pay.subscribe.issuedNot + fr.pay.subscribe.issuedBody2;
    expect(e).toMatch(/deposited by this deployment/);
    expect(e).toMatch(/can spend/);
    expect(f).toMatch(/déposée par ce déploiement/);
    expect(f).toMatch(/peut la dépenser/);
  });
});

describe('F05: the Subscribe cost copy does not promise the C1 + C3 fallback', () => {
  it('the dictionaries say a pre-blinding note cannot be spent from this web app until v2', () => {
    expect(en.pay.subscribe.costRentPart3).toMatch(/cannot be spent from this web app until v2/);
    expect(fr.pay.subscribe.costRentPart3).toMatch(/ne peut pas être dépensée depuis cette application web avant la v2/);
    expect(en.pay.subscribe.costRentPart3).not.toMatch(/when it falls back to the C1 \+ C3 pair/);
  });

  // Verifier round 1: "(finding F5)" / "(constat F5)" pointed at an audit id no
  // reader can look up (the audit report stays out of the repo, and its id is
  // F05). The copy points at limit 2 of the /pay limits section instead.
  it('the refusal and the cost copy cite no private audit id, and point at limit 2', () => {
    for (const k of ['pay.subscribe.costRentPart3', 'pay.errors.c1c3SpendDisabled']) {
      expect(tEn(k), `en.${k}`).not.toMatch(/\bF0?5\b|finding/i);
      expect(tFr(k), `fr.${k}`).not.toMatch(/\bF0?5\b|constat/i);
      expect(tEn(k), `en.${k}`).toMatch(/limit 2/);
      expect(tFr(k), `fr.${k}`).toMatch(/limite 2/);
    }
  });

  it('the in-flight note is translated and does not say this note may fall back to the pair', () => {
    const code = codeOnly('components/pay/SubscribePanel.tsx');
    expect(code).not.toMatch(/if this note falls back to the/);
    expect(code).toMatch(/t\('pay\.subscribe\.floatNote'\)/);
    expect(typeof en.pay.subscribe.floatNote).toBe('string');
    expect(fr.pay.subscribe.floatNote).not.toBe(en.pay.subscribe.floatNote);
  });
});
