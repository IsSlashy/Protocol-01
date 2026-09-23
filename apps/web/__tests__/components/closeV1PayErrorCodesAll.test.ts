/**
 * close-v1 blockers, F57: EVERY refusal code the deployment or the pool client
 * can hand a /pay panel has a sentence in English AND in French.
 *
 * Gate r1 (open item 7): `PAYMENT_EXPIRED`, `PAYMENT_FAILED_ON_CHAIN` and
 * `RELAYED_EPHEMERAL_UNBOUND` were missing from `components/pay/errorCodes.ts`,
 * so a French buyer got the English detail, and the list only grew when
 * someone remembered to grow it.
 *
 * So the list is not written here. It is READ from the sources:
 *   - every `code: 'X'` a route under `app/api` returns in its JSON (the client
 *     puts it at the start of the message, `shieldClient.ts` claimForPayment);
 *   - every `'X: ...'` a client module throws, and every `${X}: ...` whose X
 *     is a constant spelled as its own name (`export const X = 'X'`).
 * A code added to any of them with no en and fr sentence turns this red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import en from '@/i18n/en';
import fr from '@/i18n/fr';
import { POOL_ERROR_CODES, localizePoolError, poolErrorCode } from '@/components/pay/errorCodes';

const WEB = path.resolve(__dirname, '../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(WEB, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) sources(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(rel);
  }
  return out;
}
const code = (rel: string) =>
  readFileSync(path.join(WEB, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const CODE = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+';

function codesInTheSources(): Map<string, string> {
  const found = new Map<string, string>();
  const files = [...sources('app'), ...sources('lib'), ...sources('components')];
  const text = new Map(files.map((f) => [f, code(f)]));
  const selfNamed = new Set<string>();
  for (const t of text.values()) {
    for (const m of t.matchAll(new RegExp(`const (${CODE}) = ['"]([A-Z0-9_]+)['"]`, 'g'))) {
      if (m[1] === m[2]) selfNamed.add(m[1]);
    }
  }
  for (const [f, t] of text) {
    if (f.startsWith(`app${path.sep}api`)) {
      for (const m of t.matchAll(new RegExp(`\\bcode: ['"](${CODE})['"]`, 'g'))) found.set(m[1], f);
    }
    if (f.startsWith('lib') || f.startsWith('components')) {
      for (const m of t.matchAll(new RegExp(`['"\`](${CODE}): `, 'g'))) found.set(m[1], f);
      for (const m of t.matchAll(new RegExp(`\\$\\{(${CODE})\\}: `, 'g'))) {
        if (selfNamed.has(m[1])) found.set(m[1], f);
      }
    }
  }
  return found;
}

type Dict = Record<string, unknown>;
const lookup = (d: unknown, k: string) =>
  k.split('.').reduce<unknown>((a, p) => (a as Dict | undefined)?.[p], d) as string;
const tEn = (k: string) => lookup(en, k);
const tFr = (k: string) => lookup(fr, k);

describe('F57 · every code a /pay panel can receive has an en and an fr sentence', () => {
  const found = codesInTheSources();

  it('the scan finds the codes it is there for (its own control)', () => {
    for (const c of [
      'PAYMENT_EXPIRED',
      'PAYMENT_FAILED_ON_CHAIN',
      'RELAYED_EPHEMERAL_UNBOUND',
      'EXCHANGE_DISABLED',
      'POOL_TREE_DIVERGED',
      'C1C3_SPEND_DISABLED',
    ]) {
      expect(found.has(c), `${c} was not found in the sources`).toBe(true);
    }
    // `KEY_NOT_RECOVERABLE` is a constant holding an English sentence, not a
    // code, and the scan must not mistake it for one.
    expect(found.has('KEY_NOT_RECOVERABLE')).toBe(false);
  });

  it('🚨 every code in the sources is one errorCodes.ts maps', () => {
    const missing = [...found.keys()].filter((c) => !(POOL_ERROR_CODES as readonly string[]).includes(c));
    expect(
      missing.map((c) => `${c} (${found.get(c)})`),
      'a code the panels can receive with no sentence',
    ).toEqual([]);
  });

  for (const c of POOL_ERROR_CODES) {
    it(`${c}: a sentence in en and in fr, never the code, never the English in fr`, () => {
      const raw = `${c}: detail the lib or the route wrote in English`;
      expect(poolErrorCode(raw)).toBe(c);
      expect(poolErrorCode(`Error: ${raw}`)).toBe(c);
      const e = localizePoolError(raw, tEn);
      const f = localizePoolError(raw, tFr);
      expect(typeof e, `en has no sentence for ${c}`).toBe('string');
      expect(typeof f, `fr has no sentence for ${c}`).toBe('string');
      expect(e).not.toContain(c);
      expect(f).not.toContain(c);
      expect(e.length).toBeGreaterThan(40);
      expect(f.length).toBeGreaterThan(40);
      expect(f).not.toBe(e);
    });
  }

  it('the three codes of gate r1 say what happened to the money', () => {
    const say = (c: string, t: (k: string) => string) => localizePoolError(`${c}: x`, t);
    // Nothing moved.
    expect(say('PAYMENT_EXPIRED', tEn)).toMatch(/nothing was paid/i);
    expect(say('PAYMENT_EXPIRED', tFr)).toMatch(/rien n’a été payé/i);
    expect(say('PAYMENT_FAILED_ON_CHAIN', tEn)).toMatch(/paid nothing/i);
    expect(say('PAYMENT_FAILED_ON_CHAIN', tFr)).toMatch(/n’a rien payé/i);
    // The payment WAS made and a note is owed: the one thing the buyer must
    // not do is pay again.
    expect(say('RELAYED_EPHEMERAL_UNBOUND', tEn)).toMatch(/Do NOT shield again/);
    expect(say('RELAYED_EPHEMERAL_UNBOUND', tFr)).toMatch(/Ne blindez PAS à nouveau/);
    expect(say('RELAYED_EPHEMERAL_UNBOUND', tEn)).toMatch(/support/);
    expect(say('RELAYED_EPHEMERAL_UNBOUND', tFr)).toMatch(/support/);
  });

  it('every relayed-fallback refusal tells the buyer not to pay a second time', () => {
    for (const c of POOL_ERROR_CODES.filter((x) => x.startsWith('RELAYED_'))) {
      expect(localizePoolError(`${c}: x`, tEn), c).toMatch(/Do NOT shield again/);
      expect(localizePoolError(`${c}: x`, tFr), c).toMatch(/Ne blindez PAS à nouveau/);
    }
  });
});
