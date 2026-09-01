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
const appPage = (): string => read('../../../app/(pay)/app/page.tsx');

describe('a deposit is relayed unless someone deliberately said otherwise', () => {
  it('no longer forces the relay on every caller', () => {
    // The literal that closed the treasury out.
    expect(shieldClient()).not.toMatch(/relayThroughDeployment:\s*true\s*,/);
  });

  it('forces the relay on a contribution, and names the invariant to say why', () => {
    // 🚨 THE ONE PLACE A FORCED RELAY IS CORRECT. A contribution's deposit is
    // funded by the deployment precisely so the buyer's wallet never appears on
    // it, and unlike the shield there is no deployment in which the public path
    // would be right: a contribution requires a till by construction, because
    // the buyer has just paid it.
    //
    // ⛔ It earns that exemption by being a NAMED invariant instead of the bare
    // literal the assertion above bans file-wide. The ban keeps protecting
    // `shieldToPool` -- which is what closed the treasury out in 2026-08-21 --
    // while this line still says which path it is and why.
    const src = shieldClient();
    expect(src).toMatch(/const CONTRIBUTION_IS_ALWAYS_RELAYED = true;/);
    expect(src).toMatch(/relayThroughDeployment: CONTRIBUTION_IS_ALWAYS_RELAYED/);
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

describe('the page a tester reads before signing says what actually happens', () => {
  /**
   * 🚨 THE PAGE DENIED A MECHANISM THE CODE HAD ACQUIRED THAT MORNING. Under a
   * heading reading "Four things this page will not pretend", `/app` printed
   * `relayer: none on this page` and `pre-fund: public transfer from your
   * wallet`. Both had been true; the relayed deposit made both false the same
   * day, and this is the page every tester reads immediately before signing.
   *
   * ⛔ A PAGE THAT UNDERSTATES ITS PRIVACY IS AS WRONG AS ONE THAT OVERSTATES
   * IT. The instinct is to police only the second. But a reader who is told
   * their wallet funds the pool directly will act on that — and the whole point
   * of the detour is that it no longer does. Both directions are the same
   * defect: prose that does not match the code.
   */

  it('does not deny the relayer it now uses', () => {
    const page = appPage();
    expect(page).not.toMatch(/no relayer on this page/i);
    expect(page).not.toMatch(/none on this page/i);
  });

  it('does not tell the buyer their wallet pre-funds the signer', () => {
    // The pre-fund now goes from the wallet to the DEPLOYMENT, and the
    // deployment funds the signer. The old row said the opposite.
    expect(appPage()).not.toMatch(/public transfer from your wallet\s*$/m);
  });

  it('does not claim the wallet pays for every transaction', () => {
    // ⚠️ THE SAME CLAIM LIVED IN THREE MORE PLACES than the two rows that were
    // found first: the hero lede, the meta description a link preview quotes,
    // and the header comment listing what the page discloses. A phrase repeated
    // across a page is not fixed by fixing one instance of it, and grepping for
    // the exact row text missed all three.
    //
    // The SendForm badge is deliberately not covered here: a stealth send
    // really does have no relayer and really is paid by the wallet, so that
    // sentence is scoped and still true.
    const page = appPage();
    expect(page).not.toMatch(/pays for every\s+transaction/i);
    expect(page).not.toMatch(/wallet is on every transaction/i);
  });

  it('names the operator fee the buyer signs for', () => {
    // It rides inside their own transaction and cannot be declined, so the page
    // that precedes the signature has to say it exists.
    expect(appPage()).toMatch(/1% operator fee/i);
  });

  it('stays consistent with the code it describes', () => {
    // The cross-file invariant, which is the only one that cannot rot in one
    // direction: while `shieldToPool` asks for the relay, the page may not deny
    // having one.
    const relays = /relayThroughDeployment:\s*!params\.depositPublicly/.test(shieldClient());
    if (relays) {
      expect(appPage()).toMatch(/this deployment, for the funding leg/i);
    }
  });
});
