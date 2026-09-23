/**
 * Audit v1 close-out, lane L5 (2026-09-23): the served design document PDF,
 * /parcours and /demo/pitch.
 *
 * - F20, F21, F26: `apps/web/public/protocol-01-design-document.pdf` (served at
 *   /protocol-01-design-document.pdf, handed to judges by docs/HACKATHON.md:4)
 *   was printed before the section sources were fixed. It still said "27 on
 *   circuits 0, 1, 2 and 4" (C0 and C4 run 22 since 2026-09-12), called blob
 *   0ad6d7f1 the one on master (d5583d41 since 2026-09-20), put every circuit
 *   at "1 of 16 coefficients" (C0, C4 and C7 run 2 of 32), and quoted the
 *   pre-mask 47.75 to 52.53 floor.
 * - F18: the same PDF, and /parcours (`app/parcours/_components/data.ts`),
 *   quoted soundness figures above what docs/SECURITY-LEVELS.md computes for
 *   the deployed verifier ("42 to 46", "47 à 52", "21 à 26").
 * - F50: /demo/pitch slide 03 said a withdrawal republishes the deposit's
 *   commitment and "no client-side change can fix it"; the web withdrawal on
 *   circuit 7 publishes no commitment.
 *
 * The figures themselves are held to the calculator by the Rust prose gate
 * (`tools/security-levels/tests/prose.rs`); this file checks the PDF text,
 * which that gate cannot read, and the refuted sentences.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pdfText, squash } from './pdfText';

const ROOT = join(__dirname, '../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function shippedBlobPrefix(): string {
  const rec = JSON.parse(read('packages/stark-prover/deployed-verifier.json'));
  return String(rec.deployed.accepts_client_blob_sha256).slice(0, 8);
}

describe('[AUDIT-V1 close-out F20/F21/F26/F18] the served design document PDF', () => {
  for (const pdf of ['docs/protocol-01-design-document.pdf', 'apps/web/public/protocol-01-design-document.pdf']) {
    const text = squash(pdfText(join(ROOT, pdf)));
    const has = (s: string) => text.includes(squash(s));

    it(`${pdf} states the verifier's query counts, not the retired ones`, () => {
      expect(has('27 on circuits 0, 1, 2 and 4')).toBe(false);
      expect(has('27 on circuits 1 and 2; 22 on circuits 0, 3, 4, 5, 6 and 7')).toBe(true);
    });

    it(`${pdf} names the blob master ships`, () => {
      expect(has(shippedBlobPrefix())).toBe(true);
      expect(has('On master since 12 September 2026: 265,324 bytes')).toBe(false);
      expect(has('36c1fd4e')).toBe(false);
    });

    it(`${pdf} does not put every circuit at one terminal bound`, () => {
      expect(has('above 1 of 16 coefficients')).toBe(false);
      expect(has('47.75 to 52.53')).toBe(false);
    });

    it(`${pdf} quotes no soundness range above the calculator`, () => {
      for (const stale of ['42 to 46 bit', '21 to 26 bits', '47 to 52']) expect(has(stale), stale).toBe(false);
    });
  }
});

describe('[AUDIT-V1 close-out F18] /parcours soundness figures', () => {
  const data = read('apps/web/app/parcours/_components/data.ts');
  const limits = data.slice(data.indexOf('export const LIMITS'));

  it('drops the figures above the calculator', () => {
    for (const stale of ['47 à 52 bits', '42 à 46 bits', '21 à 26 bits']) expect(limits).not.toContain(stale);
  });

  it('points at the generated file for its figures', () => {
    const body = /label: 'Ce que la solidité vaut',\s*body: "([^"]*)"/.exec(limits)?.[1] ?? '';
    expect(body).toContain('docs/SECURITY-LEVELS.md');
    expect(body).toMatch(/décodage unique/);
    expect(body).toMatch(/Johnson/);
  });

  it('does not say the deposit-withdrawal link has no client-side fix', () => {
    const body = /label: 'Liaison dépôt-retrait',\s*body: "([^"]*)"/.exec(limits)?.[1] ?? '';
    expect(body).not.toMatch(/aucun correctif côté client ne le répare/);
    expect(body).toMatch(/circuit 7/);
  });
});

describe('[AUDIT-V1 close-out F50] /demo/pitch slide 03', () => {
  const page = read('apps/web/app/demo/pitch/page.tsx');

  it('does not say no client-side change can hide or fix the deposit link', () => {
    expect(page).not.toMatch(/no\s+client-side\s+change\s+can\s+(fix|hide)\s+it/);
    expect(page).not.toMatch(/Hiding that link is the next circuit, not a shipped feature/);
  });

  it('says which withdrawal still republishes the commitment', () => {
    const slide = page.slice(page.indexOf('function Slide4Notes'), page.indexOf('function', page.indexOf('function Slide4Notes') + 10));
    expect(slide).toMatch(/circuit 7/);
    expect(slide).toMatch(/phone/);
  });
});
