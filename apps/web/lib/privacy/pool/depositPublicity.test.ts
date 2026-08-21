import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHO IS NAMED BY A DEPOSIT, AND WHETHER ANYONE CHOSE IT.
 *
 * 🚨 THE DEFECT THIS PINS, AND IT WAS SELF-INFLICTED ON 2026-08-21.
 * `shieldToPool` set `relayThroughDeployment: true` unconditionally, and the
 * relayed path — correctly — refuses rather than falling back. Together those
 * two right decisions made a deployment with no `P01_TILL_ADDRESS` unable to
 * deposit AT ALL, including the treasury.
 *
 * That is the opposite of the intent. Unlinkability is a property of the note's
 * ORIGIN: the only thing that makes a purchase unlinkable is a note somebody
 * ELSE deposited, so the treasury's deposit is supposed to be named, in public,
 * and `docs/DEMO-untraceable-subscription.md` says so in bold. Blocking it left
 * the inventory empty and the product with no unlinkable path at all. The
 * refusal was aimed at buyers and hit the treasury.
 *
 * ⛔ AND THE FIX HAS ITS OWN FAILURE MODE, WHICH IS WORSE THAN THE BUG. A flag
 * that opens the public path is one edit away from being passed unconditionally
 * — at which point every buyer's wallet is named on chain, silently, with no
 * error and no way for them to detect it afterwards. So the assertions below
 * are as much about `treasuryMode` being the ONLY source of it as about the
 * flag existing.
 *
 * Source scans, the idiom `relayCapDenominations.test.ts` already uses here: a
 * decision that must hold across two files is asserted against those files'
 * text rather than against a copy of it.
 */
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');
const shieldClient = (): string => read('../shieldClient.ts');
const poolPanel = (): string => read('../../../components/pay/PoolPanel.tsx');

describe('a deposit is relayed unless someone deliberately said otherwise', () => {
  it('no longer forces the relay on every caller', () => {
    // The literal that closed the treasury out.
    expect(shieldClient()).not.toMatch(/relayThroughDeployment:\s*true\s*,/);
  });

  it('derives the choice from an explicit intent, not from availability', () => {
    // ⚠️ NOT "relay if a till is configured". That would be the silent fallback
    // this whole path exists to refuse: a deployment that lost its till would
    // quietly start naming every buyer instead of refusing.
    expect(shieldClient()).toMatch(/relayThroughDeployment:\s*!params\.depositPublicly/);
    expect(shieldClient()).toMatch(/depositPublicly\?:\s*boolean/);
  });

  it('never turns the public deposit on for everyone', () => {
    // The one-edit disaster: `depositPublicly: true` at the call site names
    // every buyer's wallet on chain with no error anywhere.
    const panel = poolPanel();
    expect(panel).toMatch(/depositPublicly:\s*treasuryMode/);
    expect(panel).not.toMatch(/depositPublicly:\s*true/);
  });

  it('keeps the operator screen behind explicit intent', () => {
    // `treasuryMode` is `?treasury=1` — not a permission check, but it cannot
    // appear in front of an ordinary user by accident, which is the failure
    // that actually happens.
    expect(poolPanel()).toMatch(/treasury=1|treasuryMode/);
  });
});
