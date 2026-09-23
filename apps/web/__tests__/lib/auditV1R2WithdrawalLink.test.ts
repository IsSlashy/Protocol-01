/**
 * The /app page's "Before you sign" limit 2, against the withdrawal path this
 * same web client takes (audit v1, round 2, axis 8, fix lane 4).
 *
 * The page said, to every visitor and with no condition: "Unshielding
 * republishes the same commitment the deposit published … This is not fixed,
 * no client-side change can hide it", and its lede said the deposit-withdrawal
 * link is not hidden. The web client withdraws a recent note on ONE circuit-7
 * proof (`unshieldEphemeral.ts` → `prepareUnshieldV4`), whose public inputs are
 * the nullifier, the subtree root and sha256(recipient) and no commitment
 * (`unshield_denominated_stark_v4.rs` `c7_pub_bytes`; the prover test
 * "publishes six felts and NOT the note commitment"; BENCHMARK-2026-09-13 §6c
 * "NO DEPOSIT FIELD APPEARS IN THE WITHDRAWAL"). The pairing by commitment
 * remains only for the phone and for a note deposited before the blinding was
 * randomised, which falls back to the C1 + C3 pair. The same dictionary
 * already says so in `threatObservers` and `withdrawnPayout`.
 *
 * The premise is read from the source, so if the web client ever stops using
 * circuit 7 by default, the first case goes red and the copy must be revisited.
 *
 * Scope: `en` only. `fr` carries the same key (i18n-parity.test.ts) and the
 * same stale sentence; it is not owned by this lane.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import en from '@/i18n/en';
import fr from '@/i18n/fr';

const REPO = path.resolve(__dirname, '../../../..');
const page = en.pay.page;

describe('premise: the web client withdraws a recent note on circuit 7, with a legacy fallback', () => {
  it('unshieldEphemeral.ts calls prepareUnshieldV4 and falls back only for an epoch-blinded note', () => {
    const src = readFileSync(path.join(REPO, 'apps/web/lib/privacy/pool/unshieldEphemeral.ts'), 'utf8');
    expect(src).toMatch(/prepareUnshieldV4\(/);
    expect(src).toMatch(/LEGACY_BLINDING_CEILING/);
  });

  it('the circuit-7 public bytes on chain are nullifier, subtree root and the recipient digest only', () => {
    const src = readFileSync(
      path.join(REPO, 'programs/zk_shielded/src/instructions/unshield_denominated_stark_v4.rs'),
      'utf8',
    );
    const fn = src.slice(src.indexOf('fn c7_pub_bytes('));
    const signature = fn.slice(0, fn.indexOf('{'));
    expect(signature).toMatch(/nullifier_u64: u64, subtree_root: u64, recipient: &Pubkey/);
    expect(signature).not.toMatch(/commitment/i);
  });
});

describe('limit 2 states the deposit-withdrawal pairing for the paths where it holds, not for every withdrawal', () => {
  it('does not say every unshield republishes the deposit commitment', () => {
    expect(page.limit2Body).not.toMatch(/^Unshielding republishes/);
  });

  it('does not call the pairing unfixed, or impossible to hide on the client', () => {
    expect(page.limit2Body).not.toMatch(/not fixed/i);
    expect(page.limit2Body).not.toMatch(/no client-side change can hide it/i);
  });

  it('names the circuit-7 withdrawal and the two cases where the commitment still appears', () => {
    expect(page.limit2Body).toMatch(/circuit 7|circuit-7/i);
    expect(page.limit2Body).toMatch(/phone/i);
    expect(page.limit2Body).toMatch(/before .*blinding/i);
  });

  it('does not overcorrect: it still says what can pair a circuit-7 withdrawal with its deposit', () => {
    expect(page.limit2Body).toMatch(/timing|minutes|hours/i);
  });

  it('the lede no longer says the deposit-withdrawal link is not hidden, without a condition', () => {
    expect(page.limitsLede).not.toMatch(/neither is the link between a deposit and the withdrawal/i);
  });

  it('agrees with threatObservers, which already scopes the pairing to the phone and pre-blinding notes', () => {
    const all = JSON.stringify(en);
    expect(all).toMatch(/still the case from the phone, and for any note deposited before we randomised the blinding/);
  });
});

// ---------------------------------------------------------------------------
// close-v1, lane L4. F50 (fr part) and the F05 web mitigation.
//
// F05: a C1 + C3 spend binds neither the payee, nor the new note, nor the
// merchant, so a copier of the public proof bytes steals the note (litesvm,
// 995,000,000 lamports). The web builders now refuse that spend by default
// (`C1C3_SPEND_DISABLED`, lane L3), so a pre-blinding note, which only the
// pair can spend, can no longer be spent from this web app until v2. Limit 2
// said it "asks you to press again after saying so": that second press now
// ends in the refusal, and the sentence must say so in both locales.
// ---------------------------------------------------------------------------

describe('F05: limit 2 does not offer the C1 + C3 pair as a way to spend a pre-blinding note', () => {
  it('en: no "press again", and the note cannot be spent from this web app until v2', () => {
    expect(page.limit2Body).not.toMatch(/asks you to press again/);
    expect(page.limit2Body).toMatch(/cannot be spent from this web app until v2/);
  });

  it('fr: the same', () => {
    expect(fr.pay.page.limit2Body).not.toMatch(/appuyer (à nouveau|de nouveau)/);
    expect(fr.pay.page.limit2Body).toMatch(/ne peut pas être dépensée depuis cette application web avant la v2/);
  });
});

describe('F50, fr: limit 2 in French states the pairing where it holds, not for every withdrawal', () => {
  const p = fr.pay.page;
  it('does not say every unshield republishes the deposit commitment, or that no client change can hide it', () => {
    expect(p.limit2Body).not.toMatch(/^Le déblindage republie/);
    expect(p.limit2Body).not.toMatch(/aucun changement côté client ne peut le cacher/);
    expect(p.limit2Body).not.toMatch(/Ce n’est pas corrigé/);
  });
  it('names the circuit-7 withdrawal, the phone and the pre-blinding note, and the timing', () => {
    expect(p.limit2Body).toMatch(/circuit 7/);
    expect(p.limit2Body).toMatch(/téléphone/);
    expect(p.limit2Body).toMatch(/avant .*aveuglement/);
    expect(p.limit2Body).toMatch(/minutes|heures/);
  });
  it('the French title and lede are scoped too', () => {
    expect(p.limit2Title).not.toMatch(/^Un retrait peut être apparié à son dépôt$/);
    expect(p.limitsLede).not.toMatch(/et le lien entre un dépôt et le retrait qui le dépense, non plus\.$/);
  });
});
