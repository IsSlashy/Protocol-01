import { Download } from "lucide-react";
import StyxShell from "../_styx/StyxShell";
import {
  findUnfilledPlaceholders,
  parsePaper,
  renderBlocks,
  renderInline,
  type TocEntry,
} from "@/lib/whitepaper/markdown";
import { WpReadingMeta, WpText } from "./WpText";
import "./whitepaper.css";

/**
 * /whitepaper, given the paper's markdown. Kept apart from page.tsx so the test
 * can render it from a fixture instead of the real file.
 *
 * Two states, and the root element says which (`data-whitepaper-state`), so
 * scripts/whitepaper-pdf.mjs can refuse to print the wrong one:
 *
 *  - "final": no placeholder is left. The paper renders, with its contents.
 *  - "pending": at least one `{{BENCH:...}}` / `{{AUDIT_STATUS}}` slot is still
 *    unfilled. NOTHING of the paper is rendered, only a "being finalised"
 *    notice, so a half-filled paper can never be read, shared or printed from
 *    this URL.
 */
export default function WhitepaperView({
  source,
  pdfAvailable,
  pdfHref = "/styx-whitepaper.pdf",
  sourceSha256,
}: {
  source: string;
  /** True only when the PDF on disk was printed from this exact source. */
  pdfAvailable: boolean;
  pdfHref?: string;
  /** sha256 of the source (LF line endings). scripts/whitepaper-pdf.mjs checks
      it against docs/WHITEPAPER.md, so a stale build is never printed. */
  sourceSha256?: string;
}) {
  const pending = findUnfilledPlaceholders(source);

  if (pending.length > 0) {
    return (
      <StyxShell>
        <div
          className="wp-root"
          data-whitepaper-state="pending"
          data-source-sha256={sourceSha256}
        >
          <section className="styx-container-narrow styx-hero">
            <p className="styx-overline">
              <WpText k="whitepaper.overline" />
            </p>
            <h1 className="styx-h2" style={{ marginTop: "1.5rem" }}>
              <WpText k="whitepaper.pendingTitle" />
            </h1>
            <div className="styx-hero-rule" aria-hidden="true" />
            <div className="styx-admission" role="status">
              <p className="styx-admission-body" style={{ margin: 0 }}>
                <WpText k="whitepaper.pendingBody" />
              </p>
            </div>
          </section>
        </div>
      </StyxShell>
    );
  }

  const paper = parsePaper(source);

  return (
    <StyxShell>
      <div
        className="wp-root"
        data-whitepaper-state="final"
        data-source-sha256={sourceSha256}
      >
        <header className="styx-container-narrow wp-hero">
          <p className="styx-overline">
            <WpText k="whitepaper.overline" />
          </p>
          <h1 id="whitepaper" className="wp-title">{renderInline(paper.title, "title")}</h1>
          <div className="styx-hero-rule" aria-hidden="true" />
          <div className="wp-hero-meta wp-noprint">
            {pdfAvailable ? (
              <a
                href={pdfHref}
                download
                className="styx-btn-ghost styx-sweep"
                data-testid="whitepaper-pdf"
              >
                <Download size={13} aria-hidden="true" style={{ flex: "none" }} />
                <WpText k="whitepaper.downloadPdf" />
              </a>
            ) : null}
            <span className="styx-note">
              <WpReadingMeta words={paper.words} /> &middot;{" "}
              <WpText k="whitepaper.englishOnly" />
            </span>
          </div>
        </header>

        <div className="styx-container-narrow">
          <Toc entries={paper.toc} />
          <article className="wp-article" aria-labelledby="whitepaper">
            {renderBlocks(paper.blocks)}
          </article>
        </div>

        <a href="#contents" className="wp-totop wp-noprint">
          <span aria-hidden="true">&uarr;</span> <WpText k="whitepaper.backToContents" />
        </a>
      </div>
    </StyxShell>
  );
}

/**
 * The contents, built from the paper's level-2 and level-3 headings. A plain
 * block at the top of the paper rather than a sticky rail: the root layout's
 * `overflow-hidden` wrapper stops `position: sticky` from sticking (see the
 * note on .styx-header in app/_styx/styx.css), and a printed paper wants its
 * contents on the first pages anyway. The fixed "back to contents" link covers
 * navigation from deep in the text.
 */
function Toc({ entries }: { entries: TocEntry[] }) {
  if (entries.length === 0) return null;
  // Group each level-3 entry under the level-2 entry before it.
  const groups: { head: TocEntry | null; children: TocEntry[] }[] = [];
  for (const e of entries) {
    if (e.level === 2 || groups.length === 0) {
      groups.push(e.level === 2 ? { head: e, children: [] } : { head: null, children: [e] });
    } else {
      groups[groups.length - 1].children.push(e);
    }
  }
  return (
    <nav className="wp-toc" aria-labelledby="contents" data-testid="whitepaper-toc">
      <h2 id="contents" className="styx-overline wp-toc-title">
        <WpText k="whitepaper.contents" />
      </h2>
      <ol className="wp-toc-list">
        {groups.map((g, n) => (
          <li key={g.head?.id ?? `g${n}`}>
            {g.head ? <a href={`#${g.head.id}`}>{g.head.text}</a> : null}
            {g.children.length > 0 ? (
              <ol className="wp-toc-sub">
                {g.children.map((c) => (
                  <li key={c.id}>
                    <a href={`#${c.id}`}>{c.text}</a>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
