/**
 * Regression test for the live serviceId-vs-streamId defect.
 *
 * At 8a9600a8 the two halves of the license flow disagreed:
 *
 *   app/(main)/(streams)/subscribe.tsx:406
 *     serviceId || retailerPubkey.toBase58()      ← what went ON CHAIN
 *   components/LicenseKeyCard.tsx:59
 *     props.serviceId || props.streamId           ← what was SHOWN to the user
 *
 * and `subscribe.tsx:116` sets `serviceId = params.serviceId || ''`, so for any
 * recipient without a Service Registry slug the first expression resolved to the
 * retailer address while the second resolved to a local `stream_<ts>_<rand>` id
 * that has never existed on chain. The subscriber was shown a key that no
 * merchant could ever accept, and a merchant cannot tell that apart from a
 * forgery.
 *
 * Cross-device recovery was worse: `upsertStreamFromVault` writes no `serviceId`
 * at all and mints a fresh random stream id, so on a recovered vault the
 * fallback was wrong every single time.
 *
 * These tests assert the property that was violated — the tag the poster uses
 * and the tag the display uses are the same string, and the key that results
 * matches the commitment — rather than asserting the shape of the fix.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveLicenseSecret,
  encodeLicenseKey,
  decodeLicenseKey,
  licenseCommitment,
  licenseCommitmentForSubscription,
  licenseKeyForSubscription,
  licenseServiceTag,
} from './derive';

const RETAILER = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
const NOTE_SECRET = '9182736455647382910';

const bytesToHex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

/**
 * What subscribe posts on-chain. Same function the subscribe path calls, so a
 * change there is caught here — not a re-implementation of it.
 */
function commitmentPostedBySubscribe(noteSecret: string, serviceId: string | undefined): Uint8Array {
  return licenseCommitmentForSubscription(noteSecret, { serviceId, retailerAddress: RETAILER });
}

/** What `LicenseKeyCard` shows — literally the function the component calls. */
function keyShownByCard(
  noteSecret: string,
  props: { serviceId?: string; retailerAddress: string },
): string {
  return licenseKeyForSubscription(noteSecret, {
    serviceId: props.serviceId,
    retailerAddress: props.retailerAddress,
  });
}

/** What the merchant does: blake3(decode(key)) === on-chain commitment. */
function merchantAccepts(key: string, onChainCommitment: Uint8Array): boolean {
  return bytesToHex(licenseCommitment(decodeLicenseKey(key))) === bytesToHex(onChainCommitment);
}

describe('license service tag: poster and displayer agree', () => {
  it('registered service (slug present) — merchant accepts the displayed key', () => {
    const serviceId = 'disney-plus';
    const onChain = commitmentPostedBySubscribe(NOTE_SECRET, serviceId);
    const shown = keyShownByCard(NOTE_SECRET, { serviceId, retailerAddress: RETAILER });
    expect(merchantAccepts(shown, onChain)).toBe(true);
  });

  it('free-form recipient (subscribe.tsx sets serviceId to "") — merchant accepts the displayed key', () => {
    // THE regression. `params.serviceId || ''` makes serviceId the empty
    // string, which is falsy on both sides — the whole point is that both
    // sides then land on the SAME fallback.
    const serviceId = '';
    const onChain = commitmentPostedBySubscribe(NOTE_SECRET, serviceId);
    const shown = keyShownByCard(NOTE_SECRET, { serviceId, retailerAddress: RETAILER });
    expect(merchantAccepts(shown, onChain)).toBe(true);
  });

  it('recovered vault (no serviceId at all) — merchant accepts the displayed key', () => {
    // upsertStreamFromVault sets recipientAddress = vault.retailer and leaves
    // serviceId undefined.
    const onChain = commitmentPostedBySubscribe(NOTE_SECRET, undefined);
    const shown = keyShownByCard(NOTE_SECRET, { serviceId: undefined, retailerAddress: RETAILER });
    expect(merchantAccepts(shown, onChain)).toBe(true);
  });

  it('the streamId fallback that shipped would be rejected — this is the defect, kept executable', () => {
    const onChain = commitmentPostedBySubscribe(NOTE_SECRET, '');
    // Reproduce the OLD display rule verbatim: `props.serviceId || props.streamId`
    // with the empty serviceId that `params.serviceId || ''` actually produced.
    const oldStreamId = 'stream_1754000000000_abc123def';
    const emptyServiceId: string = '';
    const oldRuleTag = emptyServiceId || oldStreamId;
    const oldRuleKey = encodeLicenseKey(deriveLicenseSecret(NOTE_SECRET, oldRuleTag));
    expect(merchantAccepts(oldRuleKey, onChain)).toBe(false);
    // …and the fixed rule is accepted for the same subscription.
    expect(merchantAccepts(keyShownByCard(NOTE_SECRET, { retailerAddress: RETAILER }), onChain)).toBe(true);
  });

  it('a recovered vault under the old rule was wrong 100% of the time', () => {
    // upsertStreamFromVault calls generateId(), so the stream id is random and
    // unrelated to anything on chain. Ten independent draws, none accepted.
    const onChain = commitmentPostedBySubscribe(NOTE_SECRET, undefined);
    for (let i = 0; i < 10; i++) {
      const randomStreamId = `stream_${1_754_000_000_000 + i}_${Math.random().toString(36).slice(2, 11)}`;
      const oldRuleKey = encodeLicenseKey(deriveLicenseSecret(NOTE_SECRET, randomStreamId));
      expect(merchantAccepts(oldRuleKey, onChain), randomStreamId).toBe(false);
    }
  });

  it('the tag is not normalised — already-issued keys keep working', () => {
    // A slug is used verbatim. Trimming or lower-casing here would change the
    // HKDF info and orphan every key already derived from the raw bytes.
    expect(licenseServiceTag('  Disney-Plus  ', RETAILER)).toBe('  Disney-Plus  ');
    expect(licenseServiceTag('Disney-Plus', RETAILER)).toBe('Disney-Plus');
    expect(licenseServiceTag('', RETAILER)).toBe(RETAILER);
    expect(licenseServiceTag(undefined, RETAILER)).toBe(RETAILER);
    expect(licenseServiceTag(null, RETAILER)).toBe(RETAILER);
  });

  it('the tag rule reproduces the pre-fix poster expression exactly', () => {
    // The chain already holds commitments made with `serviceId || retailer`.
    // The new helper must be byte-identical to that expression or it orphans
    // every vault subscribed before this change.
    const cases: Array<string | undefined | null> = [
      'disney-plus',
      'netflix',
      '',
      undefined,
      null,
      '  ',
      '0',
    ];
    for (const s of cases) {
      const legacy = s || RETAILER;
      expect(licenseServiceTag(s, RETAILER), JSON.stringify(s)).toBe(legacy);
    }
  });
});
