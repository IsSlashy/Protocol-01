import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * THE WARNING HAS TO REACH THE SUBSCRIBER BEFORE THEY PAY.
 *
 * Cancellation and refunds were deleted from `zk_shielded`. A subscription is
 * a one-way prepaid envelope, so the only protection a subscriber has left is
 * being told that BEFORE the money moves. That statement shipped with no test
 * at all: deleting the entire warning block from `CreateSubscription.tsx` left
 * all 9 extension test files and 145 tests green. Measured, not assumed.
 *
 * ## Why this file lives in shared/services and reads sources
 *
 * `vitest.config.ts` EXCLUDES `src/popup/*.test.{ts,tsx}` — every popup page
 * test is currently unrun because of a react-router React-instance split — so
 * a test placed next to the page would never execute and would be worse than
 * no test at all. It also means nothing that renders these pages can guard
 * this today.
 *
 * Reading the sources sidesteps both problems. The property being pinned is
 * "the paying screens state the rule, above the button, and no subscription
 * screen promises a cancellation the protocol cannot perform". That is a
 * property of the source, and unlike a render test it cannot be satisfied by
 * a mock.
 */

// vitest runs with cwd = apps/extension. `readFileSync` throws if a page is
// renamed or moved, which is the correct outcome: a warning that moved out of
// this list is a warning nobody is checking any more.
const readRaw = (name: string) =>
  readFileSync(resolve(process.cwd(), 'src/popup/pages', name), 'utf8');

/**
 * The source as a subscriber could experience it: comments removed (a comment
 * explaining what the copy used to say must not count as the copy, in either
 * direction) and whitespace flattened (JSX wraps a sentence across lines, so
 * `There is no\n cancellation and no refund` has to match).
 */
const read = (name: string) =>
  readRaw(name)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ');

/** Every screen where a subscriber commits money to a subscription. */
const PAYING_SCREENS = ['CreateSubscription.tsx', 'ApproveSubscription.tsx'] as const;

/** Every screen that talks about a subscription at all. */
const SUBSCRIPTION_SCREENS = [
  ...PAYING_SCREENS,
  'SubscriptionDetails.tsx',
  'SubscriptionVaults.tsx',
  'Subscriptions.tsx',
] as const;

/**
 * Phrasings that PROMISE a cancellation. Nothing on chain can cancel a
 * subscription or send a lamport back to a subscriber, so any of these on a
 * subscription screen is a false claim made at the moment money moves.
 *
 * The negated forms the screens are supposed to carry ("cannot be cancelled",
 * "no cancellation and no refund") deliberately do not match.
 */
const CANCEL_PROMISES: readonly RegExp[] = [
  /pause or cancel/i,
  /cancel (?:anytime|any time|at any time)/i,
  /Until cancelled/i,
  /Remember to cancel/i,
  /\bcancelSubscription\b/,
  /\bcancelNormal\b/,
  /\bcancelPrivateStark\b/,
];

describe('the no-refund rule reaches the subscriber before they pay', () => {
  it.each(PAYING_SCREENS)('%s states that there is no cancellation and no refund', (name) => {
    expect(read(name)).toMatch(/no cancellation and no refund/i);
  });

  it('CreateSubscription states the rule ABOVE the button that moves the money', () => {
    const src = read('CreateSubscription.tsx');
    const warningAt = src.search(/no cancellation and no refund/i);
    const buttonAt = src.indexOf('onClick={handleCreate}');
    expect(warningAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(-1);
    // A warning underneath the submit button is read after committing, which
    // is not a warning.
    expect(warningAt).toBeLessThan(buttonAt);
  });

  it('ApproveSubscription states the rule ABOVE the approve button', () => {
    const src = read('ApproveSubscription.tsx');
    const warningAt = src.search(/no cancellation and no refund/i);
    const buttonAt = src.indexOf('onClick={handleApprove}');
    expect(warningAt).toBeGreaterThan(-1);
    expect(buttonAt).toBeGreaterThan(-1);
    expect(warningAt).toBeLessThan(buttonAt);
  });

  it('CreateSubscription offers pause and resume, the only controls that exist', () => {
    const src = read('CreateSubscription.tsx');
    expect(src).toMatch(/pause/i);
    expect(src).toMatch(/resume/i);
  });
});

describe('no subscription screen promises a cancellation', () => {
  it.each(SUBSCRIPTION_SCREENS)('%s', (name) => {
    const src = read(name);
    expect(CANCEL_PROMISES.filter((re) => re.test(src)).map(String)).toEqual([]);
  });
});
