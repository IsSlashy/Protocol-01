import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACK_ENV,
  PUBLICLY_NAMED_IN_THIS_REPO,
  assertPayerNotPubliclyNamed,
  publicPayerRefusal,
} from './publicPayer';

/**
 * The guard this file pins exists because a real withdrawal was paid for by the
 * one address this project has published the most.
 *
 * `22psv1tF…` — the first circuit-7 spend that ever landed — publishes no field
 * of its deposit and is still attributable to the operator in one
 * `getTransaction`, because its fee payer is the upgrade authority of the pool
 * AND the verifier. That is pinned on-chain evidence at
 * `verify/fixtures/v4-live` (P11 FAIL), not a hypothetical.
 *
 * A guard nobody can trip is a guard nobody trusts, and the live harnesses that
 * call this are all inert without an env var, so none of them would ever
 * exercise it. Hence a pure function and this file.
 */
describe('the live harnesses refuse a publicly named fee payer', () => {
  const ADMIN = '7gWpzSZALYz3Um8G7yUxaT6Av2tvw1Cn6VAhSZSB6QmU';
  const STRANGER = 'GwX3VTnGRkLpY4uQ6tJCx8yh4rkJTeiCHp7cQw3uN5Cm';

  it('refuses the CLI default key, which is the upgrade authority', () => {
    expect(() => assertPayerNotPubliclyNamed(ADMIN, 'a live v4 withdrawal', {})).toThrow(
      /refusing to pay/i,
    );
  });

  it('says WHY, so the message survives being pasted without context', () => {
    const refusal = publicPayerRefusal(ADMIN)!;
    expect(refusal).toContain('upgrade authority');
    expect(refusal).toContain('README.md');
    expect(refusal).toContain('verify/fixtures/v4-live');
    // The way out must be in the message. A refusal that does not say how to
    // proceed gets worked around by deleting the guard.
    expect(refusal).toContain('P01_LIVE_KEYPAIR');
    expect(refusal).toContain(ACK_ENV);
  });

  it('allows an address this repository has never named', () => {
    expect(publicPayerRefusal(STRANGER)).toBeNull();
    expect(() => assertPayerNotPubliclyNamed(STRANGER, 'anything', {})).not.toThrow();
  });

  it('lets an explicit acknowledgement through, and ONLY the exact value', () => {
    expect(() => assertPayerNotPubliclyNamed(ADMIN, 'x', { [ACK_ENV]: '1' })).not.toThrow();
    // "true", "yes" and "0" are the shapes someone reaches for from memory. A
    // guard that accepts any truthy string is one typo away from being off.
    for (const sloppy of ['true', 'yes', '0', '', 'TRUE']) {
      expect(() => assertPayerNotPubliclyNamed(ADMIN, 'x', { [ACK_ENV]: sloppy })).toThrow();
    }
  });

  /**
   * ANTI-VACUITY. The two assertions above prove the function behaves; this one
   * proves it is pointed at the right addresses. If someone rotates a constant
   * in `fee.rs` and forgets this list, the guard keeps passing while protecting
   * nothing — the exact shape of hollow guard this repository has been bitten by.
   */
  it('still names the addresses fee.rs actually pins', () => {
    const feeRs = readFileSync(
      join(__dirname, '../../../../../programs/zk_shielded/src/fee.rs'),
      'utf8',
    );
    for (const [address, why] of Object.entries(PUBLICLY_NAMED_IN_THIS_REPO)) {
      expect(feeRs, `${address} is listed as "${why}" but fee.rs never mentions it`).toContain(
        address,
      );
    }
    expect(Object.keys(PUBLICLY_NAMED_IN_THIS_REPO).length).toBeGreaterThanOrEqual(2);
  });
});
