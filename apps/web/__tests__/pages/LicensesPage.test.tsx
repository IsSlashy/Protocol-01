import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import LicensesPage from '@/app/licenses/page';
import {
  PROJECT_LICENSE_TEXT,
  MIT_LICENSE_TEXT_BEFORE_POLYFORM,
} from '@/app/licenses/licenseText';

/**
 * /licenses, after the relicense of 2026-09-22.
 *
 * The project's own code moved from MIT to the PolyForm Strict License 1.0.0
 * (source-available, noncommercial). Three facts must stay true on this page:
 *
 *  1. The licence it prints is the file in the repository, byte for byte. A
 *     paraphrase presented as a licence is a misrepresentation (the page once
 *     printed an abridged MIT text), so the constants are compared with the
 *     files themselves, not with a copy of them.
 *  2. What was already published under MIT stays MIT: every commit before the
 *     one that replaced the MIT LICENSE with PolyForm Strict, and every npm
 *     version published before 2026-09-22. A licence already granted cannot be
 *     withdrawn, so the page must say so and must not present the repository as
 *     MIT any more. The boundary is that relicensing commit, not a pinned hash:
 *     a pinned hash went stale once already (beaa87ba was named as the last MIT
 *     commit, and 74f3e7c5 was then pushed under MIT on top of it).
 *  3. /LICENSE is the upstream PolyForm Strict 1.0.0 text preceded only by
 *     "Required Notice:" lines. Explanatory prose inside the licence file makes
 *     the licence ambiguous, and so does claiming a restriction the licence
 *     does not contain ("production deployment needs a licence": PolyForm
 *     Strict permits any noncommercial purpose, including a noncommercial
 *     organisation running the software in production).
 *
 * The third-party table is not this suite's business beyond "it is still
 * there": those rows repeat each dependency's own licence.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/* sha256 of PolyForm-Strict-1.0.0.md at tag 1.0.0 of
   github.com/polyformproject/polyform-licenses. */
const UPSTREAM_POLYFORM_STRICT_SHA256 =
  '9eb48619fbc193ab7bb327b090cfcc703000265b83e670f81f231d0b1c43c56e';

function repoFile(name: string): string {
  return readFileSync(path.join(REPO_ROOT, name), 'utf8');
}

function pageText(): string {
  return document.body.textContent ?? '';
}

function splitNotices(text: string): { notices: string[]; body: string } {
  const cut = text.indexOf('\n\n');
  return { notices: text.slice(0, cut).split('\n'), body: text.slice(cut + 2) };
}

describe('/licenses: the licence texts are the files, verbatim', () => {
  it('prints /LICENSE byte for byte', () => {
    expect(PROJECT_LICENSE_TEXT).toBe(repoFile('LICENSE'));
  });

  it('/LICENSE is PolyForm Strict 1.0.0 with Volta Team as the required notice', () => {
    expect(PROJECT_LICENSE_TEXT.startsWith(
      'Required Notice: Copyright (c) 2025-2026 Volta Team',
    )).toBe(true);
    expect(PROJECT_LICENSE_TEXT).toContain('# PolyForm Strict License 1.0.0');
    expect(PROJECT_LICENSE_TEXT).toContain('<https://polyformproject.org/licenses/strict/1.0.0>');
  });

  it('/LICENSE is only Required Notice lines, a blank line, then the upstream text unchanged', () => {
    const { notices, body } = splitNotices(PROJECT_LICENSE_TEXT);
    for (const line of notices) expect(line.startsWith('Required Notice: ')).toBe(true);
    expect(body.startsWith('# PolyForm Strict License 1.0.0\n')).toBe(true);
    expect(createHash('sha256').update(body, 'utf8').digest('hex')).toBe(
      UPSTREAM_POLYFORM_STRICT_SHA256,
    );
  });

  it('/LICENSE carries the MIT fact as a Required Notice, tied to the relicensing commit', () => {
    const notices = splitNotices(PROJECT_LICENSE_TEXT).notices.join('\n');
    expect(notices).toMatch(
      /^Required Notice: .*before the commit that replaced .*MIT License.*are available under the MIT License/m,
    );
    expect(notices).toContain('LICENSE-MIT-BEFORE-POLYFORM');
    expect(notices).not.toMatch(/beaa87ba/);
  });

  it('/LICENSE claims no restriction PolyForm Strict does not contain', () => {
    expect(PROJECT_LICENSE_TEXT).not.toMatch(/production/i);
  });

  it('every packages/*/LICENSE is the root /LICENSE, byte for byte', () => {
    const pkgs = readdirSync(path.join(REPO_ROOT, 'packages')).filter((d) =>
      existsSync(path.join(REPO_ROOT, 'packages', d, 'LICENSE')),
    );
    // 15 until 2026-09-23, when eight packages nothing used were deleted
    // (arcium-sdk, privacy-toolkit, react-native-zk, specter-js, ui,
    // whitelist-sdk, zk-sdk, zkspl-sdk). Seven packages carry a LICENSE today.
    expect(pkgs.length).toBeGreaterThanOrEqual(7);
    for (const d of pkgs) {
      expect(repoFile(path.join('packages', d, 'LICENSE')), d).toBe(PROJECT_LICENSE_TEXT);
    }
  });

  it('prints the MIT text that still covers every commit before the relicense, byte for byte', () => {
    const history = repoFile('LICENSE-MIT-BEFORE-POLYFORM');
    expect(history.endsWith(MIT_LICENSE_TEXT_BEFORE_POLYFORM)).toBe(true);
    expect(MIT_LICENSE_TEXT_BEFORE_POLYFORM.startsWith('MIT License\n')).toBe(true);
    // The header names the relicensing commit as the boundary, not a hash.
    expect(history).toMatch(/before the commit that replaced/);
    expect(history).not.toMatch(/beaa87ba/);
  });
});

describe('/licenses: what the page says', () => {
  it('names PolyForm Strict 1.0.0 as the licence of this repository', () => {
    render(<LicensesPage />);
    expect(screen.getByText(/This repository: PolyForm Strict 1\.0\.0/)).toBeInTheDocument();
    expect(screen.getByText('PolyForm Strict License 1.0.0 · /LICENSE')).toBeInTheDocument();
  });

  it('no longer presents the repository as MIT or as open source', () => {
    render(<LicensesPage />);
    const text = pageText();
    expect(text).not.toMatch(/This repository: MIT/);
    expect(text).not.toMatch(/This repository is MIT/);
    expect(text).not.toMatch(/redistribute freely/i);
    expect(text).not.toMatch(/open source/i);
  });

  it('says plainly that the MIT copies stay MIT', () => {
    render(<LicensesPage />);
    expect(screen.getByText('MIT License · every commit before the relicense')).toBeInTheDocument();
    expect(pageText()).toMatch(/are available under the MIT License/);
  });

  it('puts the MIT boundary at the relicensing commit, not at a pinned hash', () => {
    render(<LicensesPage />);
    const text = pageText();
    // beaa87ba was not the last commit published under MIT (74f3e7c5 was
    // pushed on top of it the same evening), so naming it as the boundary put
    // MIT-licensed code under PolyForm.
    expect(text).not.toMatch(/beaa87ba/);
    expect(text).toMatch(/before the one that replaced the MIT License/);
  });

  it('says what needs a commercial license, and that noncommercial verification does not', () => {
    render(<LicensesPage />);
    const text = pageText();
    expect(text).toMatch(/noncommercial/i);
    expect(text).toMatch(/written license from Volta Team/);
    // PolyForm Strict ties the need for a licence to commercial purpose, not
    // to "production": a noncommercial organisation may run it in production.
    expect(text).not.toMatch(/Commercial use, production deployment/);
    expect(text).toMatch(/Commercial use \(including production deployment by a business\)/);
  });

  it('keeps the third-party table', () => {
    render(<LicensesPage />);
    expect(screen.getByText('winterfell')).toBeInTheDocument();
    // circom / snarkjs left the table on 2026-09-23 with the last root
    // devDependencies and Groth16 test scripts that installed them.
    expect(screen.queryByText('circom / snarkjs')).toBeNull();
  });
});
