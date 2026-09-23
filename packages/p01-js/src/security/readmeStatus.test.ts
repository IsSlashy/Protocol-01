import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Audit v1, F76 and F77: the fixes change what the security module does, and
 * the package published on npm (0.3.2) still has the old behaviour. The README
 * must say both, so an integrator does not take the npm build for the fixed one.
 */
const README = readFileSync(resolve(__dirname, '..', '..', 'README.md'), 'utf8');
const section = (() => {
  const at = README.indexOf('### Security primitives: status');
  return at < 0 ? '' : README.slice(at, README.indexOf('\n## ', at) < 0 ? undefined : README.indexOf('\n## ', at));
})();

describe('p01-js README states the status of its security primitives (F76, F77)', () => {
  it('has the status section', () => {
    expect(section, 'no "### Security primitives: status" section').not.toBe('');
  });
  it('Pedersen: H from hash-to-curve now; commitments of 0.3.2 and earlier are not binding', () => {
    expect(section).toMatch(/hash-to-curve/i);
    expect(section).toMatch(/0\.3\.2[\s\S]{0,300}not binding|not binding[\s\S]{0,300}0\.3\.2/i);
  });
  it('confidential transfers fail closed (no range proof)', () => {
    expect(section).toMatch(/verifyConfidentialTransfer[\s\S]{0,200}(false|refuse|fail)/i);
    expect(section).toMatch(/no range proof/i);
  });
  it('confidential.ts header matches the fixed H (F76 residual): hash-to-curve now, h·G only for 0.3.2 and earlier', () => {
    const src = readFileSync(resolve(__dirname, 'confidential.ts'), 'utf8');
    const header = src.slice(0, src.indexOf('*/'));
    expect(header).not.toMatch(/hiding but NOT\s+\*?\s*binding: the second generator H is derived as h·G/);
    expect(header).toMatch(/hash-to-curve/i);
    expect(header).toMatch(/PEDERSEN_H_DST/);
    expect(header).toMatch(/0\.3\.2[\s\S]{0,200}h·G[\s\S]{0,200}not\s+(\*\s+)?binding/i);
    expect(header).toMatch(/no range proof/i);
  });
  it('stealth: the key is a scalar, signing goes through signWithStealthKey / signStealthPayment, streams record the ephemeral keys', () => {
    expect(section).toMatch(/scalar/i);
    expect(section).toMatch(/signStealthPayment/);
    expect(section).toMatch(/stealthTicks/);
  });
});
