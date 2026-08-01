import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE WARNING HAS TO REACH THE SUBSCRIBER BEFORE THEY PAY.
 *
 * Cancellation and refunds were deleted from `zk_shielded`. A subscription is
 * a one-way prepaid envelope, so the only protection a subscriber has left is
 * being told that BEFORE the money moves. That statement shipped with no test:
 * blanking all three warning strings on `(streams)/subscribe.tsx` left the
 * whole mobile suite (20 files, 298 tests) green. Measured, not assumed.
 *
 * `i18n/parity.test.ts` is NOT this test and cannot replace it. It proves the
 * fr and ja copy exists and differs from English — which stayed green while
 * the privacy-tab screens rendered hardcoded English literals and never read
 * the keys at all. A string table nobody renders is not a warning.
 *
 * The sources are read rather than rendered because rendering an expo-router
 * screen needs the whole native stack, and because the property here — "the
 * paying screens say it, above the CTA, and no subscription screen promises a
 * cancellation" — is a property of the source that a mock cannot satisfy.
 */

const APP = process.cwd(); // vitest runs with cwd = apps/mobile

const readRaw = (rel: string) => readFileSync(resolve(APP, rel), 'utf8');

/**
 * The source as a subscriber could experience it: comments removed (a comment
 * about what the copy used to say must not count as copy, in either
 * direction) and whitespace flattened, since JSX wraps sentences across lines.
 */
const read = (rel: string) =>
  readRaw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ');

/** Screens where the subscriber commits money, and the CTA each must sit above. */
const PAYING_SCREENS: readonly (readonly [string, string])[] = [
  // Opens the ZK SubscriptionVault via subscribePrivateStarkAction. This is the
  // screen where the money becomes irrecoverable.
  ['app/(main)/(privacy)/subscribe-private.tsx', 'onPress={handleSubmit}'],
  ['app/(main)/(streams)/subscribe.tsx', 'onPress={handleSubscribe}'],
];

/** Every mobile screen that talks about a subscription vault. */
const SUBSCRIPTION_SCREENS: readonly string[] = [
  ...PAYING_SCREENS.map(([f]) => f),
  'app/(main)/(privacy)/vault-detail.tsx',
  'app/(main)/(privacy)/subscription-vaults.tsx',
  'app/(main)/(streams)/[id].tsx',
];

/**
 * Phrasings that PROMISE a cancellation or a refund of a vault. Nothing on
 * chain can do either, so any of these is a false claim. The negated forms the
 * screens are supposed to carry do not match.
 */
const CANCEL_PROMISES: readonly RegExp[] = [
  /pause or cancel/i,
  /pause\/cancel/i,
  /cancel (?:anytime|any time|at any time)/i,
  /annulez? à tout moment/i,
  /refund as shielded notes/i,
  /\bcancelNormal\b/,
  /\bcancelPrivateStark\b/,
  /computeCancelPreview/,
];

/**
 * The keys that carry the rule. A paying screen must reference one of them —
 * referencing the KEY, not a literal, is what makes the fr and ja copy that
 * `i18n/parity.test.ts` guarantees actually reach the screen.
 */
const WARNING_KEYS = [
  'subscribe.oneWayTitle',
  'subscribe.oneWayBody',
  'subscribe.finalTitle',
  'subscribe.finalBody',
  'streams.noRefundNotice',
];

describe('the no-refund rule reaches the subscriber before they pay', () => {
  it.each(PAYING_SCREENS)('%s states the rule through i18n', (file) => {
    const src = read(file);
    const referenced = WARNING_KEYS.filter((k) => src.includes(k));
    expect(referenced.length).toBeGreaterThan(0);
  });

  it.each(PAYING_SCREENS)('%s states it ABOVE the button that moves the money', (file, cta) => {
    const src = read(file);
    const warningAt = Math.min(
      ...WARNING_KEYS.map((k) => src.indexOf(k)).filter((i) => i >= 0),
    );
    // Anchored on the JSX that wires the button, not on the handler's
    // definition, so moving the definition around cannot fake a pass.
    const ctaAt = src.indexOf(cta);
    expect(Number.isFinite(warningAt)).toBe(true);
    expect(ctaAt).toBeGreaterThan(-1);
    // A warning underneath the CTA is read after committing, which is not a
    // warning.
    expect(warningAt).toBeLessThan(ctaAt);
  });
});

describe('no mobile subscription screen promises a cancellation or a refund', () => {
  it.each(SUBSCRIPTION_SCREENS)('%s', (file) => {
    const src = read(file);
    expect(CANCEL_PROMISES.filter((re) => re.test(src)).map(String)).toEqual([]);
  });
});
