import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '../i18n/en';
import fr from '../i18n/fr';
import ja from '../i18n/ja';

/**
 * THE APP MAY NOT OVERSTATE WHAT IT HIDES.
 *
 * Sibling of `no-refund-warning.test.ts`, and written for the same reason: the
 * privacy copy on these screens was written before any of it was measured, and
 * nothing was watching it. Three agents changed what the clients actually hide
 * on 2026-08-04 and every stale sentence stayed green.
 *
 * The measured facts this file exists to protect, each one confirmed on devnet
 * rather than reasoned about:
 *
 *  1. THE ANONYMITY SET IS ONE. A spend republishes the note commitment its
 *     deposit published — `publicInputs[1]` of the C1 proof becomes the
 *     `stark_commitment` instruction argument
 *     (services/denominatedPool/index.ts:3192 -> :3277 -> :2941). Leaf 16,
 *     commitment 8901821612542787864, appears in both the deposit and the
 *     withdrawal. Only the C7 spend circuit changes this.
 *  2. THE WALLET STILL PUBLICLY FUNDS THE ONE-TIME KEY, on both legs
 *     (stores/denominatedPoolStore.ts:1207-1223 depositing, :1460-1473
 *     withdrawing), and the residual is swept back to it (:1256-1259).
 *     Dropping the wallet as SIGNER is real and worth saying; it is not
 *     anonymity.
 *  3. USDC DEPOSITS STILL USE THE WALLET AS DEPOSITOR. `useEphemeralDepositor`
 *     is `pool.token === 'SOL' && localKp !== null` (:1176) because the
 *     ephemeral has no funded ATA. This is the asymmetry most likely to be
 *     flattened by a future copy edit, so it gets its own assertion.
 *  4. THE WITHDRAWAL RECIPIENT IS SWEPT BACK AUTOMATICALLY after 3-7s
 *     (:1566-1570; ~8s measured at :1424-1426). It is a relay, not a hiding
 *     place, and the delay was deliberately not grown.
 *
 * Sources are read rather than rendered, for the reason the sibling file gives:
 * the property is a property of the source. Comments are stripped first, so a
 * comment recording what a line USED to say is not itself counted as a claim —
 * which is what lets the fixes stay documented in place.
 */

const APP = process.cwd(); // vitest runs with cwd = apps/mobile

/** Source as a user could experience it: comments gone, whitespace flattened. */
const read = (rel: string) =>
  readFileSync(resolve(APP, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ');

/** Every screen of mine that describes what shielding, sending or exiting hides. */
const PRIVACY_SCREENS: readonly string[] = [
  'app/(main)/(privacy)/index.tsx',
  'app/(main)/(privacy)/denominated-shield.tsx',
  'app/(main)/(privacy)/denominated-unshield.tsx',
  'app/(main)/(privacy)/denominated-unshield-batch.tsx',
  'app/(main)/(privacy)/denominated-transfer.tsx',
  'app/(main)/(privacy)/private-send.tsx',
  'app/(main)/(privacy)/shielded.tsx',
  'app/(main)/(privacy)/shielded-transfer.tsx',
  'app/(main)/(privacy)/confidential.tsx',
  'app/(main)/(privacy)/subscribe-private.tsx',
  'app/(main)/(streams)/create.tsx',
  'app/(main)/(streams)/subscribe.tsx',
];

/**
 * SHAPES of an overstatement, not the phrasings already found.
 *
 * The sibling file learned this the hard way: a detector built from the defects
 * already fixed cannot find the next one. So these match the FORM of an
 * absolute privacy claim — an unqualified "no one can", a "zero footprint", a
 * "breaks the link" — in each of the three shipped locales, rather than the
 * particular sentences that happened to be here on 2026-08-04.
 */
const OVERSTATEMENTS: readonly RegExp[] = [
  // English absolutes.
  /(?:completely|totally|fully|entirely|perfectly)\s+(?:private|anonymous|hidden|untraceable|unlinkable)/i,
  /\buntraceable\b/i,
  /\banonymous\b/i,
  /\banonymity\b/i,
  /zero\s+(?:wallet\s+)?footprint/i,
  /maximum\s+privacy/i,
  /(?:leaves?|leaving)\s+no\s+trace/i,
  /without\s+leaving\s+a\s+trace/i,
  /(?:hides?|masks?|conceals?)\s+(?:your\s+)?identity/i,
  /(?:no\s?one|nobody)\s+can\s+(?:see|trace|link|tell)/i,
  /(?:cannot|can't|can not)\s+(?:be\s+)?(?:traced?|linked?)/i,
  /breaks?\s+the\s+(?:on-chain\s+)?link/i,
  /\bunlinkable\b/i,
  /no\s+private\s+data\s+(?:ever\s+)?leaves/i,
  // French.
  /(?:totalement|compl[eè]tement|enti[eè]rement)\s+(?:priv|anonym)/i,
  /\bintra[cç]able\b/i,
  /aucune\s+trace/i,
  /confidentialit[eé]\s+maximale/i,
  /personne\s+ne\s+peut\s+voir/i,
  /ne\s+peut\s+pas\s+(?:tracer|relier)/i,
  // Japanese.
  /完全に(?:プライベート|匿名|秘匿)/,
  /追跡(?:不可能|できません)/,
  /痕跡(?:なし|を残さ)/,
  /誰(?:に)?も(?:見え|分から|たどれ)/,
  /匿名/,
];

/**
 * Sentences that state a limitation and therefore contain the same words
 * legitimately. Enumerated by hand rather than by weakening the shapes above:
 * adding a true sentence is a decision someone makes on purpose, whereas a
 * loosened regex forgives every future false claim as well.
 */
const TRUE_STATEMENTS: readonly RegExp[] = [
  /it does not make the two wallets unlinkable/i,
  /is not an anonymity system yet/i,
  /not\s+anonymity/i,
];

const withoutTrueStatements = (src: string) =>
  TRUE_STATEMENTS.reduce((s, re) => s.replace(new RegExp(re.source, 'gi'), ' '), src);

describe('no mobile privacy screen overstates what it hides', () => {
  it.each(PRIVACY_SCREENS)('%s', (file) => {
    const src = withoutTrueStatements(read(file));
    expect(OVERSTATEMENTS.filter((re) => re.test(src)).map(String)).toEqual([]);
  });
});

describe('no locale ships an overstated privacy claim', () => {
  /**
   * Leaf VALUES only. Key names are deliberately not scanned: `untraceable`,
   * `zeroWalletFootprint` and `zkHidesIdentity` are read by onboarding and
   * settings screens outside this pass, so their names outlived their false
   * values. What ships to a user is the value.
   */
  function leafStrings(obj: Record<string, unknown>, prefix = ''): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...leafStrings(v as Record<string, unknown>, full));
      } else if (typeof v === 'string') {
        out.push([full, v]);
      }
    }
    return out;
  }

  const DICTS = [
    ['en', en],
    ['fr', fr],
    ['ja', ja],
  ] as const;

  it.each(DICTS)('%s', (_name, dict) => {
    const offenders = leafStrings(dict as unknown as Record<string, unknown>)
      .filter(([, v]) => OVERSTATEMENTS.some((re) => re.test(withoutTrueStatements(v))))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});

describe('the deposit copy keeps SOL and USDC apart', () => {
  /**
   * The single most important assertion in this file. On SOL the wallet no
   * longer signs the pool transaction; on USDC it still does. A copy edit that
   * collapses the two into one reassuring sentence would tell a USDC depositor
   * their wallet is not on chain when it is — the exact failure this pass was
   * commissioned to prevent.
   */
  const SHIELD = 'app/(main)/(privacy)/denominated-shield.tsx';

  it('renders a different disclosure per token, chosen by the token itself', () => {
    const src = read(SHIELD);
    expect(src).toContain('shieldUnshield.depositSignerSol');
    expect(src).toContain('shieldUnshield.depositSignerUsdc');
    // Both must be selected by the token, never rendered unconditionally.
    expect(/tokenTab === 'SOL'\s*\?/.test(src)).toBe(true);
    expect(/selectedPool\.token === 'SOL'\s*\?/.test(src)).toBe(true);
  });

  it('the USDC line names the wallet as the depositor', () => {
    const usdc = en.shieldUnshield.depositSignerUsdc;
    expect(/wallet/i.test(usdc)).toBe(true);
    expect(/sign/i.test(usdc)).toBe(true);
  });

  it('the SOL line still discloses that the wallet funds the one-time key', () => {
    // "Your wallet does not sign this deposit" is only half the truth, and the
    // dangerous half to ship alone. Fact 2: the funding transfer is public and
    // one hop away.
    const sol = en.shieldUnshield.depositSignerSol;
    expect(/fund/i.test(sol)).toBe(true);
    expect(/public/i.test(sol)).toBe(true);
  });
});

describe('the withdrawal screen says the one-time recipient is only a relay', () => {
  const UNSHIELD = 'app/(main)/(privacy)/denominated-unshield.tsx';

  it('renders the relay notice', () => {
    expect(read(UNSHIELD)).toContain('shieldUnshield.recipientRelayNotice');
  });

  it('the notice states both the automatic forward and the commitment linkage', () => {
    const notice = en.shieldUnshield.recipientRelayNotice;
    expect(/automatic/i.test(notice)).toBe(true);
    expect(/commitment/i.test(notice)).toBe(true);
  });
});

describe('the detector is not just a list of the claims already found', () => {
  /** The exact strings that shipped on 2026-08-04, before this pass. */
  const SHIPPED = [
    'All proofs are generated on your phone. No private data ever leaves your device.',
    'This transfer is fully private. Amount, sender, and recipient are hidden on-chain.',
    'No one can see amounts, senders, or recipients on-chain.',
    'This breaks the on-chain link between wallets.',
    'STARK proof breaks the on-chain link to your wallet.',
    'Zero wallet footprint — maximum privacy',
    'Send and receive funds without leaving a trace. Your transactions are completely private.',
    'Zero-knowledge proof hides your identity',
    'Merchant cannot trace the payment source',
    'UNTRACEABLE',
    'Aucune trace du portefeuille — confidentialité maximale',
    'Vos transactions sont totalement privées.',
    'Personne ne peut voir à qui vous parlez.',
    '追跡不可能',
    '取引は完全にプライベートです。',
  ];

  it.each(SHIPPED)('catches the claim that shipped: %s', (sentence) => {
    expect(OVERSTATEMENTS.some((re) => re.test(withoutTrueStatements(sentence)))).toBe(true);
  });

  it.each([
    'Your funds are completely anonymous once shielded.',
    'Nobody can link your deposit to your withdrawal.',
    'Le retrait est totalement anonyme.',
    'この出金は完全に匿名です。',
  ])('catches a phrasing nobody has written yet: %s', (sentence) => {
    expect(OVERSTATEMENTS.some((re) => re.test(withoutTrueStatements(sentence)))).toBe(true);
  });

  it.each([
    'Deposits with the same amount are indistinguishable from each other.',
    'Your wallet does not sign this deposit — a one-time key does. Your wallet still funds that key with a public transfer, one hop away.',
    'Your wallet signs this USDC deposit and appears on chain as the depositor.',
    'The withdrawal republishes the note commitment your deposit published, so the two can be matched on chain.',
    'It does not make the two wallets unlinkable.',
  ])('and stays silent on the true statement: %s', (sentence) => {
    expect(OVERSTATEMENTS.filter((re) => re.test(withoutTrueStatements(sentence)))).toEqual([]);
  });
});
