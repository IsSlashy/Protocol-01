/**
 * [close-v1 F05, gate r1 open item 4] The Subscribe tab's cost box says the
 * truth about the C1 + C3 pair, in English AND in French.
 *
 * Since F05 the web builders refuse a C1 + C3 spend unless the deployment opts
 * in (`NEXT_PUBLIC_P01_ALLOW_C1C3_SPEND=1`, default off,
 * `lib/privacy/pool/denominatedPool.ts`), with `C1C3_SPEND_DISABLED` before
 * anything is proved, funded or sent. `pay.subscribe.costCommitment` still
 * called the pair "the fallback" and ended "the screen after the purchase names
 * which one ran": a buyer read that this tab might run it, and nothing pinned
 * the sentence in either language.
 */
import { describe, it, expect } from 'vitest';
import en from '@/i18n/en';
import fr from '@/i18n/fr';

const EN = en.pay.subscribe.costCommitment;
const FR = fr.pay.subscribe.costCommitment;

describe('F05 · pay.subscribe.costCommitment', () => {
  it('still says what circuit 7 hides, in both languages', () => {
    expect(EN).toMatch(/A circuit-7 subscription carries no note commitment/);
    expect(FR).toMatch(/Un abonnement en circuit 7 ne porte aucun engagement de note/);
  });

  it('🚨 does not imply that the C1 + C3 pair can run from this tab', () => {
    expect(EN, 'en still promises a screen naming which one ran').not.toMatch(/names which one ran/);
    expect(FR, 'fr still promises a screen naming which one ran').not.toMatch(/dit lequel a tourné/);
    // "Fallback" is what the web app would drop to on its own; it no longer does.
    expect(EN).not.toMatch(/fallback/i);
    expect(FR).not.toMatch(/repli/i);
  });

  it('says the pair is switched off here and refused before anything is proved or paid', () => {
    expect(EN).toMatch(/C1 \+ C3 pair republishes the commitment and binds no payee/);
    expect(EN).toMatch(/this web app has it switched off/);
    expect(EN).toMatch(/refused before anything is proved or paid/);
    expect(FR).toMatch(/paire C1 \+ C3 republie l’engagement et ne lie aucun bénéficiaire/);
    expect(FR).toMatch(/cette application web l’a désactivée/);
    expect(FR).toMatch(/refusée avant que rien ne soit prouvé ni payé/);
  });
});
