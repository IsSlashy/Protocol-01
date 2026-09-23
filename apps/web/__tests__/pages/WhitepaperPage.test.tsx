import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WhitepaperView from '@/app/whitepaper/WhitepaperView';
import StyxFooter from '@/app/_styx/StyxFooter';
import DocsPage from '@/app/docs/page';
import { WhitepaperPdfFlag } from '@/lib/whitepaper/pdfFlag';
import {
  findUnfilledPlaceholders,
  parsePaper,
  resolveHref,
  WHITEPAPER_DOCS_BASE,
} from '@/lib/whitepaper/markdown';
import { loadWhitepaperSource, whitepaperPath, whitepaperSha256 } from '@/lib/whitepaper/source';
import en from '@/i18n/en';
import fr from '@/i18n/fr';

/**
 * /whitepaper renders docs/WHITEPAPER.md at build time. Three promises:
 *
 *  1. The markdown the paper uses renders as the paper: headings with anchors,
 *     emphasis, code, links, lists, tables in a scroll wrapper, code blocks.
 *  2. A paper with an unfilled {{BENCH:...}} or {{AUDIT_STATUS}} slot is
 *     NEVER rendered: the page shows a "being finalised" notice and nothing of
 *     the paper, so a half-filled version cannot go public.
 *  3. The contents are built from the paper's own headings, in order.
 *
 * Rendered from fixtures, not from the real file, so the suite does not change
 * verdict while the paper is being finished. One test at the end checks the
 * real file for consistency only.
 */

const FIXTURE = `# Styx: a *test* paper

**White paper, fixture edition.** Volta Team, <https://styx.cash>.

---

## 1. Summary

A paragraph with **bold**, *italic*, \`inline code\` and a [claims link](CLAIMS.md),
continued on a second line.

<!-- {{AUDIT_STATUS}}: an editing note that must never reach the page -->

Fix status is listed in \`docs/CLAIMS.md\` under \`{{AUDIT_STATUS}}\`.

<!-- /{{AUDIT_STATUS}} -->

### 1.1 Details

1. First numbered item.
2. Second numbered item, with \`code | pipe\`.

- A bullet.
- Another [unsafe](javascript:alert(1)) bullet.

| Flow | median |
|---|---:|
| Withdrawal | 12.3 |
| Code \`a | b\` | 4 |

## 2. Reproduce

\`\`\`sh
cargo test --locked   # a comment
\`\`\`

## 1. Summary

A duplicate heading gets its own anchor.
`;

afterEach(() => {
  vi.restoreAllMocks();
});

function paperState(container: HTMLElement): string | null {
  return container.querySelector('[data-whitepaper-state]')?.getAttribute('data-whitepaper-state') ?? null;
}

describe('/whitepaper: renders the paper from markdown', () => {
  it('renders the title as the single h1 and marks the page final', () => {
    const { container } = render(<WhitepaperView source={FIXTURE} pdfAvailable={false} />);
    expect(paperState(container)).toBe('final');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe('Styx: a test paper');
    expect(within(h1s[0]).getByText('test').tagName).toBe('EM');
  });

  it('renders headings with stable, unique anchors', () => {
    render(<WhitepaperView source={FIXTURE} pdfAvailable={false} />);
    const summary = document.getElementById('1-summary');
    expect(summary?.tagName).toBe('H2');
    expect(document.getElementById('11-details')?.tagName).toBe('H3');
    expect(document.getElementById('2-reproduce')?.tagName).toBe('H2');
    // The second "1. Summary" does not steal the first one's anchor.
    expect(document.getElementById('1-summary-2')?.tagName).toBe('H2');
    expect(summary?.querySelector('a.wp-anchor')?.getAttribute('href')).toBe('#1-summary');
  });

  it('renders inline markdown, and resolves relative links against docs/ on GitHub', () => {
    render(<WhitepaperView source={FIXTURE} pdfAvailable={false} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('inline code').tagName).toBe('CODE');
    const claims = screen.getByRole('link', { name: 'claims link' });
    expect(claims.getAttribute('href')).toBe(`${WHITEPAPER_DOCS_BASE}CLAIMS.md`);
    expect(claims.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'https://styx.cash' }).getAttribute('href')).toBe(
      'https://styx.cash',
    );
    // Soft line breaks join into one paragraph.
    expect(screen.getByText(/continued on a second line/).tagName).toBe('P');
  });

  it('never renders an unsafe link as a link', () => {
    render(<WhitepaperView source={FIXTURE} pdfAvailable={false} />);
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull();
    expect(screen.getByText('unsafe')).toBeInTheDocument();
    expect(resolveHref('javascript:alert(1)')).toBeNull();
    expect(resolveHref('data:text/html,x')).toBeNull();
    expect(resolveHref('//evil.example')).toBeNull();
    expect(resolveHref('#1-summary')).toBe('#1-summary');
  });

  it('drops HTML comments and keeps the named CLAIMS.md reference', () => {
    const { container } = render(<WhitepaperView source={FIXTURE} pdfAvailable={false} />);
    expect(container.textContent).not.toMatch(/editing note/);
    expect(container.innerHTML).not.toMatch(/<!--/);
    expect(screen.getByText('{{AUDIT_STATUS}}').tagName).toBe('CODE');
  });

  it('renders lists, a table in a scrollable wrapper, and code blocks', () => {
    const { container } = render(<WhitepaperView source={FIXTURE} pdfAvailable={false} />);
    const ol = container.querySelector('.wp-article ol');
    expect(ol?.querySelectorAll('li')).toHaveLength(2);
    expect(within(ol as HTMLElement).getByText('code | pipe').tagName).toBe('CODE');
    expect(container.querySelector('.wp-article ul')?.querySelectorAll('li')).toHaveLength(2);

    const table = screen.getByRole('table');
    expect(table.closest('.wp-table-wrap')).not.toBeNull();
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Flow',
      'median',
    ]);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    // A pipe inside a code span does not split the cell.
    expect(within(rows[2]).getAllByRole('cell')).toHaveLength(2);
    expect(within(rows[1]).getAllByRole('cell')[1].style.textAlign).toBe('right');

    const pre = container.querySelector('pre.styx-code');
    expect(pre?.textContent).toBe('cargo test --locked   # a comment');
  });

  it('offers the PDF only when the page says it matches this paper', () => {
    const { unmount } = render(<WhitepaperView source={FIXTURE} pdfAvailable={false} />);
    expect(screen.queryByTestId('whitepaper-pdf')).toBeNull();
    unmount();
    render(<WhitepaperView source={FIXTURE} pdfAvailable pdfHref="/styx-whitepaper.pdf" />);
    const link = screen.getByTestId('whitepaper-pdf');
    expect(link.getAttribute('href')).toBe('/styx-whitepaper.pdf');
    expect(link.textContent).toContain(en.whitepaper.downloadPdf);
  });
});

describe('/whitepaper: builds the contents from the headings', () => {
  it('lists every level-2 and level-3 heading, in order, nested', () => {
    render(<WhitepaperView source={FIXTURE} pdfAvailable={false} />);
    const toc = screen.getByTestId('whitepaper-toc');
    const hrefs = within(toc)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#1-summary', '#11-details', '#2-reproduce', '#1-summary-2']);
    // 1.1 sits inside the list item of section 1.
    const details = within(toc).getByRole('link', { name: '1.1 Details' });
    expect(details.closest('ol.wp-toc-sub')).not.toBeNull();
    expect(within(toc).getByText(en.whitepaper.contents)).toBeInTheDocument();
  });

  it('matches parsePaper, and the title is not in the contents', () => {
    const { toc, title } = parsePaper(FIXTURE);
    expect(title).toBe('Styx: a *test* paper');
    expect(toc.map((e) => [e.level, e.text])).toEqual([
      [2, '1. Summary'],
      [3, '1.1 Details'],
      [2, '2. Reproduce'],
      [2, '1. Summary'],
    ]);
  });
});

describe('/whitepaper: refuses a paper with an unfilled placeholder', () => {
  const cases: [string, string][] = [
    ['a bare benchmark slot', 'A withdrawal takes {{BENCH:withdrawal-warm:median}} s.'],
    ['a benchmark slot in inline code', 'Run `{{BENCH:run:id}}` of the day.'],
    ['a benchmark slot in a table', '| n |\n|---|\n| {{BENCH:deposit:n}} |'],
    ['a bare audit-status slot', '{{AUDIT_STATUS}}'],
    ['a half-typed slot', 'Median {{BENCH:withdrawal-warm'],
  ];

  for (const [name, snippet] of cases) {
    it(`shows only the "being finalised" notice for ${name}`, () => {
      const source = `${FIXTURE}\n\n${snippet}\n`;
      expect(findUnfilledPlaceholders(source).length).toBeGreaterThan(0);
      const { container } = render(<WhitepaperView source={source} pdfAvailable />);
      expect(paperState(container)).toBe('pending');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en.whitepaper.pendingTitle);
      expect(screen.getByText(en.whitepaper.pendingBody)).toBeInTheDocument();
      // Nothing of the paper, and no PDF link.
      expect(container.textContent).not.toMatch(/test paper|Summary|Withdrawal/);
      expect(screen.queryByTestId('whitepaper-toc')).toBeNull();
      expect(screen.queryByTestId('whitepaper-pdf')).toBeNull();
      expect(container.querySelector('.wp-article')).toBeNull();
    });
  }

  it('ignores placeholders inside HTML comments and the named CLAIMS.md section', () => {
    expect(findUnfilledPlaceholders(FIXTURE)).toEqual([]);
    expect(
      findUnfilledPlaceholders('<!-- Placeholders: {{BENCH:<flow>:<stat>}} -->\nDone.'),
    ).toEqual([]);
    expect(findUnfilledPlaceholders('listed under `{{AUDIT_STATUS}}`.')).toEqual([]);
  });

  it('treats CRLF sources like LF ones', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    expect(findUnfilledPlaceholders(crlf)).toEqual([]);
    expect(parsePaper(crlf).toc).toEqual(parsePaper(FIXTURE).toc);
    expect(whitepaperSha256(crlf)).toBe(whitepaperSha256(FIXTURE));
  });
});

describe('/whitepaper: the real file', () => {
  it('fails loudly when docs/WHITEPAPER.md cannot be found', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'wp-missing-'));
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(empty, 'apps', 'web'));
    expect(() => whitepaperPath()).toThrow(/WHITEPAPER\.md not found/);
  });

  it('renders the committed paper in exactly one of the two states', () => {
    const source = loadWhitepaperSource();
    const onDisk = readFileSync(whitepaperPath(), 'utf8').replace(/\r\n?/g, '\n');
    expect(source).toBe(onDisk.replace(/^﻿/, ''));
    const pending = findUnfilledPlaceholders(source).length > 0;
    const { container } = render(<WhitepaperView source={source} pdfAvailable={false} />);
    expect(paperState(container)).toBe(pending ? 'pending' : 'final');
    if (!pending) {
      // Sections 1 to 9 of the paper are all in the contents.
      const toc = screen.getByTestId('whitepaper-toc');
      for (let n = 1; n <= 9; n++) {
        expect(within(toc).getByRole('link', { name: new RegExp(`^${n}\\. `) })).toBeInTheDocument();
      }
      expect(container.textContent).not.toMatch(/\{\{\s*BENCH:/);
    }
  });
});

describe('/whitepaper: linked from the site, in English and French', () => {
  it('is in the shared footer', () => {
    render(<StyxFooter />);
    const link = screen.getByRole('link', { name: en.footer.whitepaper });
    expect(link.getAttribute('href')).toBe('/whitepaper');
  });

  it('has every UI string in both dictionaries', () => {
    expect(Object.keys(fr.whitepaper).sort()).toEqual(Object.keys(en.whitepaper).sort());
    for (const value of [...Object.values(en.whitepaper), ...Object.values(fr.whitepaper)]) {
      expect(value.trim()).not.toBe('');
    }
    expect(fr.footer.whitepaper).toBe('Livre blanc');
    expect(en.docs.whitepaper).toBeTruthy();
    expect(fr.docs.whitepaper).toBeTruthy();
  });

  it('makes none of the forbidden property claims in its own strings', () => {
    const own = JSON.stringify([
      en.whitepaper,
      fr.whitepaper,
      en.footer.whitepaper,
      en.docs.whitepaperMeta,
      en.docs.whitepaperMetaPdf,
      fr.docs.whitepaperMeta,
      fr.docs.whitepaperMetaPdf,
    ]);
    expect(own).not.toMatch(/zero.?knowledge|untraceable|trustless|\bfirst\b|128 bits|open.?source/i);
  });
});

/**
 * The /docs button to the paper. It used to say "Web page and PDF" whatever the
 * build held, while /whitepaper offers the PDF only once a PDF printed from this
 * exact paper is committed. Now app/docs/layout.tsx works out the same answer at
 * build time (pdfMatchesSource) and passes it down through WhitepaperPdfFlag.
 */
describe('/docs: the white paper button claims a PDF only when there is one', () => {
  function whitepaperButton(container: HTMLElement): HTMLElement {
    const links = Array.from(container.querySelectorAll<HTMLElement>('a[href="/whitepaper"]'));
    const button = links.find((a) => a.textContent?.includes(en.docs.whitepaper));
    expect(button).toBeTruthy();
    return button as HTMLElement;
  }

  it('says "Web page" and no PDF by default (no flag, or no matching PDF)', () => {
    window.scrollTo = vi.fn();
    const { container } = render(<DocsPage />);
    const button = whitepaperButton(container);
    expect(button.textContent).toContain(en.docs.whitepaperMeta);
    expect(button.textContent).not.toMatch(/PDF/);
  });

  it('says "Web page and PDF" when the build found a matching PDF', () => {
    window.scrollTo = vi.fn();
    const { container } = render(
      <WhitepaperPdfFlag available>
        <DocsPage />
      </WhitepaperPdfFlag>,
    );
    expect(whitepaperButton(container).textContent).toContain(en.docs.whitepaperMetaPdf);
  });

  it('keeps the two strings apart in both dictionaries', () => {
    expect(en.docs.whitepaperMeta).toBe('Web page · English');
    expect(fr.docs.whitepaperMeta).toBe('Page web · en anglais');
    for (const meta of [en.docs.whitepaperMeta, fr.docs.whitepaperMeta]) {
      expect(meta).not.toMatch(/PDF/);
    }
    for (const meta of [en.docs.whitepaperMetaPdf, fr.docs.whitepaperMetaPdf]) {
      expect(meta).toMatch(/PDF/);
    }
  });
});

/**
 * The PDF is English. The page's own UI strings come from I18nProvider, which
 * picks French in a browser with a French locale and no styx-country cookie, as
 * on a local `next start` on the founder's machine. scripts/whitepaper-pdf.mjs
 * therefore prints /whitepaper?lang=en, and resolveLocale honours ?lang first.
 */
describe('/whitepaper: the PDF is printed in English', () => {
  let languages: PropertyDescriptor | undefined;

  function frenchBrowser() {
    languages = Object.getOwnPropertyDescriptor(window.navigator, 'languages');
    Object.defineProperty(window.navigator, 'languages', { value: ['fr-FR', 'fr'], configurable: true });
    try {
      localStorage.removeItem('p01-web-locale');
    } catch {
      /* no storage */
    }
  }

  afterEach(() => {
    if (languages) Object.defineProperty(window.navigator, 'languages', languages);
    else delete (window.navigator as unknown as Record<string, unknown>).languages;
    languages = undefined;
    window.history.replaceState(null, '', '/');
    document.documentElement.lang = '';
  });

  async function renderContentsTitle() {
    // setup.tsx mocks useT for every other test; this one needs the real provider.
    const real = await vi.importActual<typeof import('@/i18n')>('@/i18n');
    function Title() {
      const t = real.useT();
      return <h2 data-testid="title">{t('whitepaper.contents')}</h2>;
    }
    render(
      <real.I18nProvider>
        <Title />
      </real.I18nProvider>,
    );
    return screen.getByTestId('title');
  }

  it('a French browser without ?lang gets the French UI (the case the script guards against)', async () => {
    frenchBrowser();
    window.history.replaceState(null, '', '/whitepaper');
    const title = await renderContentsTitle();
    await waitFor(() => expect(title.textContent).toBe(fr.whitepaper.contents));
    expect(document.documentElement.lang).toBe('fr');
  });

  it('?lang=en forces the English UI in a French browser', async () => {
    frenchBrowser();
    window.history.replaceState(null, '', '/whitepaper?lang=en');
    // Start from French, so waiting for "en" proves the provider's effect ran.
    document.documentElement.lang = 'fr';
    const title = await renderContentsTitle();
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(title.textContent).toBe(en.whitepaper.contents);
  });

  it('the script prints the ?lang=en page, with an English browser, after checking the rendered DOM', () => {
    const script = readFileSync(path.resolve(__dirname, '../../scripts/whitepaper-pdf.mjs'), 'utf8');
    expect(script).toMatch(/const printUrl = `\$\{pageUrl\}\?lang=en`;/);
    expect(script).toContain("'--lang=en-US'");
    expect(script).toMatch(/'--accept-lang=en-US/);
    // The English check (a --dump-dom of the same URL) runs before the print.
    const check = script.indexOf("'--dump-dom', printUrl");
    const print = script.indexOf('`--print-to-pdf=${tmpPdf}`, printUrl');
    expect(check).toBeGreaterThan(0);
    expect(print).toBeGreaterThan(check);
    for (const marker of ['Sommaire', 'Livre blanc']) expect(script).toContain(`'${marker}'`);
    expect(script).toContain('"Contents"');
    expect(fr.whitepaper.contents).toBe('Sommaire');
    expect(en.whitepaper.contents).toBe('Contents');
  });
});
