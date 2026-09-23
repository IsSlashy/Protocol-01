import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Audit v1, finding F68: the README fix of round 4 also flipped the whole file
 * from LF (as committed) to CRLF, a 235-line churn with no content reason that
 * buries the real change in review. The repository has no .gitattributes and
 * core.autocrlf is off, so what is on disk is what gets committed. The text
 * files of this package stay LF, as at HEAD.
 */
describe('privacy-toolkit text files keep LF line endings (F68)', () => {
  for (const f of ['README.md', 'CONTRIBUTING.md', 'package.json']) {
    it(`${f} has no CRLF`, () => {
      const bytes = readFileSync(join(__dirname, '..', f));
      expect(bytes.includes(Buffer.from('\r\n'))).toBe(false);
    });
  }
});
