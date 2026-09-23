/**
 * WHAT THE README MAY SAY ABOUT WHERE A SUBSCRIPTION PAYS OUT.
 *
 * Audit v1 round 4 (claims axis): README.md said the permissionless claim "can
 * only ever land on the retailer's registered address" and that "the program
 * pins the payout to the registered retailer address", inside the Service
 * Registry section, so "registered" reads as "checked against p01_registry".
 *
 * The program does no such check. `subscribe_private_stark_v4` (the path the
 * web app uses) takes the retailer as an unvalidated account
 * ("CHECK: Any pubkey can be a retailer"), copies it into `vault.retailer`
 * together with a caller-chosen `rate` and `interval_slots`, and names no
 * registry account; `claim_period` then pins the payout to `vault.retailer`.
 * What is pinned is the retailer named when the vault was created.
 *
 * This case reads the program source, so it stays honest if that changes: the
 * moment a subscribe instruction really reads the registry, the README may say
 * "registered" again and this case stops asserting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');

const SUBSCRIBE_FILES = [
  'programs/zk_shielded/src/instructions/subscribe_private_stark_v4.rs',
  'programs/zk_shielded/src/instructions/subscribe_private_stark.rs',
];

/** True when no subscribe instruction validates the retailer against anything. */
function retailerIsUnvalidated(): boolean {
  return SUBSCRIBE_FILES.every((f) => {
    const src = read(f);
    return /CHECK: Any pubkey can be a retailer/.test(src) && !/p01_registry|registry/i.test(src);
  });
}

/** README paragraphs, split on blank lines. */
function paragraphs(text: string): string[] {
  return text.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s+/g, ' ').trim());
}

describe('README: the payout destination claim matches the program', () => {
  it('reads the program as it is today (positive control)', () => {
    expect(retailerIsUnvalidated(), 'a subscribe instruction now reads the registry; revisit this case').toBe(
      true,
    );
  });

  it('never says the program pins the payout to a REGISTERED retailer address', () => {
    if (!retailerIsUnvalidated()) return;
    const readme = read('README.md');
    const offending = paragraphs(readme).filter(
      (p) =>
        /(payout|claim)/i.test(p) &&
        /(pins?|land|lands|only ever)/i.test(p) &&
        /registered (retailer )?address|retailer's registered/i.test(p),
    );
    expect(
      offending,
      'README ties the subscription payout to a registered address, but the program pins it to ' +
        'whatever retailer the subscriber named (subscribe_private_stark_v4.rs "Any pubkey can be ' +
        'a retailer"; claim_period.rs `retailer.key() == vault.retailer`).',
    ).toEqual([]);
  });

  it('says what the program does pin: the retailer named when the vault was created', () => {
    if (!retailerIsUnvalidated()) return;
    const readme = read('README.md');
    expect(readme).toMatch(/retailer (?:named|recorded|the subscriber named)[^.]*vault/i);
    // And that the registry binding is a client-side check, not the program's.
    expect(readme).toMatch(/registry[^.]*(client|SDK)[^.]*not (?:by )?the program|not checked on chain|no instruction reads the registry/i);
  });
});
