import type { ReactNode } from "react";

/**
 * The white paper's markdown renderer: the smallest one that covers what
 * docs/WHITEPAPER.md actually uses, and nothing else.
 *
 * WHY A HAND-WRITTEN RENDERER. The web app ships no markdown library (no
 * react-markdown, remark or MDX; checked 2026-09-23), every long page here is
 * hand-written JSX, and adding a dependency means a `pnpm install` plus a
 * lockfile change for one page. The paper uses a small, stable subset:
 * ATX headings, paragraphs, **bold**, *italic*, `code`, [links](x), <autolinks>,
 * flat bullet and numbered lists, pipe tables, fenced code blocks, `---` rules,
 * blockquotes and HTML comments. That subset is below.
 *
 * WHY IT IS SAFE. It never emits raw HTML: every node is a React element, so any
 * `<` in the source is text, and HTML comments are dropped before parsing (they
 * hold the paper's editing notes). Links are limited to http(s), mailto and
 * in-page anchors; a relative link (the paper points at `CLAIMS.md` and other
 * files next to it) is resolved against the repository's docs/ folder on GitHub,
 * because /whitepaper has no CLAIMS.md next to it.
 *
 * WHAT IT DOES NOT DO, ON PURPOSE: nested lists, setext headings, reference
 * links, raw HTML blocks, footnotes. If the paper ever needs one, extend this
 * file and its test (__tests__/pages/WhitepaperPage.test.tsx) together.
 */

/** Relative links in the paper are relative to docs/ in the repository. */
export const WHITEPAPER_DOCS_BASE =
  "https://github.com/IsSlashy/Protocol-01/blob/master/docs/";

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { kind: "heading"; level: number; text: string; id: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "rule" }
  | { kind: "quote"; blocks: Block[] };

export type TocEntry = { id: string; text: string; level: 2 | 3 };

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * Every unfilled placeholder the paper still contains, in the order found.
 * An empty array is the only state in which /whitepaper renders the paper.
 *
 * What counts, and why the rule is not a bare `includes("{{AUDIT_STATUS")`:
 *
 *  - HTML comments are ignored. They are never rendered, and the paper keeps
 *    permanent ones: `<!-- {{AUDIT_STATUS}}: ... -->` and
 *    `<!-- /{{AUDIT_STATUS}} -->` fence the audit block so it can be updated in
 *    place, and a comment above the benchmark table documents the
 *    `{{BENCH:<flow>:<stat>}}` syntax. A bare substring test would refuse the
 *    finished paper forever.
 *  - The exact inline-code reference `` `{{AUDIT_STATUS}}` `` is ignored. The
 *    paper uses it as the NAME of a section of docs/CLAIMS.md ("listed in
 *    `docs/CLAIMS.md` under `{{AUDIT_STATUS}}`"), not as a slot to fill.
 *  - Everything else of the form `{{UPPER...` counts, inline code included:
 *    the benchmark's run line puts its placeholders in backticks
 *    (`` `{{BENCH:run:id}}` ``), and those are real, unfilled slots.
 */
export function findUnfilledPlaceholders(source: string): string[] {
  const visible = stripHtmlComments(normalizeNewlines(source)).replace(
    /`\{\{AUDIT_STATUS\}\}`/g,
    "",
  );
  const found: string[] = [];
  const re = /\{\{\s*[A-Z][A-Z0-9_]*(?:[:\s][^}\n]*)?\}?\}?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(visible))) found.push(m[0]);
  return found;
}

export function normalizeNewlines(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/** Terminated comments only. An unterminated `<!--` is left in as text, so it
    shows up on the page instead of silently swallowing the rest of the paper. */
export function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+.-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isTableStart(lines: string[], i: number): boolean {
  return (
    lines[i].trimStart().startsWith("|") &&
    i + 1 < lines.length &&
    lines[i + 1].includes("-") &&
    TABLE_SEP.test(lines[i + 1])
  );
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    isTableStart(lines, i)
  );
}

/** Split a table row on `|`, ignoring pipes inside code spans and `\|`. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      if (inCode === 0) inCode = n;
      else if (inCode === n) inCode = 0;
      cur += s.slice(i, i + n);
      i += n - 1;
      continue;
    }
    if (c === "|" && inCode === 0) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(sep: string): Align[] {
  return splitRow(sep).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/** Parse markdown into blocks. Heading ids are assigned by `assignIds`. */
export function parseBlocks(source: string): Block[] {
  const lines = stripHtmlComments(normalizeNewlines(source)).split("\n");
  return parseLines(lines);
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].trim();
        if (close.startsWith(marker[0].repeat(marker.length)) && /^(`+|~+)$/.test(close)) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ kind: "code", lang: fence[2] ?? "", code: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2].trim(),
        id: "",
      });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = parseAlign(lines[i + 1]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const row = splitRow(lines[i]);
        // Pad or trim to the header's width so a ragged row cannot shift columns.
        rows.push(header.map((_, c) => row[c] ?? ""));
        i++;
      }
      blocks.push({ kind: "table", header, align, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const q = QUOTE.exec(lines[i]);
        inner.push(q ? q[1] : lines[i]);
        i++;
      }
      blocks.push({ kind: "quote", blocks: parseLines(inner) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const re = isOrdered ? ORDERED : BULLET;
      const items: string[] = [];
      const start = ordered ? Number(ordered[1]) : 1;
      while (i < lines.length) {
        const cur = lines[i];
        const m = re.exec(cur);
        if (m) {
          items.push(isOrdered ? m[2] : m[1]);
          i++;
          continue;
        }
        if (cur.trim() === "") {
          // A blank line ends the list unless the next item of the same kind
          // follows it (a "loose" list).
          let j = i;
          while (j < lines.length && lines[j].trim() === "") j++;
          if (j < lines.length && re.test(lines[j])) {
            i = j;
            continue;
          }
          break;
        }
        if (startsBlock(lines, i)) break;
        // Lazy continuation of the current item.
        items[items.length - 1] += "\n" + cur.trim();
        i++;
      }
      blocks.push({ kind: "list", ordered: isOrdered, start, items });
      continue;
    }

    // Paragraph: runs until a blank line or the start of another block.
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Headings, anchors, table of contents
// ---------------------------------------------------------------------------

/** Markdown inline syntax removed, for anchors, the TOC and the page title. */
export function plainText(inline: string): string {
  return inline
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
    .replace(/\*([^*\s][^*]*?)\*/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** GitHub-style slug: "2.1 Chain observer (anyone)" -> "21-chain-observer-anyone". */
export function slugify(text: string): string {
  const slug = plainText(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return slug || "section";
}

/** Ids the page itself uses; a heading never takes one of them. */
const RESERVED_IDS = ["contents", "styx-content", "whitepaper"];

/** Give every heading a unique id, in document order. Mutates and returns. */
export function assignIds(blocks: Block[]): Block[] {
  const used = new Set(RESERVED_IDS);
  const visit = (list: Block[]) => {
    for (const b of list) {
      if (b.kind === "heading") {
        const base = slugify(b.text);
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        b.id = id;
      } else if (b.kind === "quote") {
        visit(b.blocks);
      }
    }
  };
  visit(blocks);
  return blocks;
}

/** Levels 2 and 3 become the table of contents. Level 1 is the page title. */
export function buildToc(blocks: Block[]): TocEntry[] {
  return blocks
    .filter(
      (b): b is Extract<Block, { kind: "heading" }> =>
        b.kind === "heading" && (b.level === 2 || b.level === 3),
    )
    .map((b) => ({ id: b.id, text: plainText(b.text), level: b.level as 2 | 3 }));
}

export type ParsedPaper = {
  /** The first level-1 heading, as markdown inline text ("" if none). */
  title: string;
  /** Everything except that title heading. */
  blocks: Block[];
  toc: TocEntry[];
  words: number;
};

export function parsePaper(source: string): ParsedPaper {
  const all = assignIds(parseBlocks(source));
  const titleIndex = all.findIndex((b) => b.kind === "heading" && b.level === 1);
  const title =
    titleIndex >= 0 ? (all[titleIndex] as Extract<Block, { kind: "heading" }>).text : "";
  const blocks = titleIndex >= 0 ? all.filter((_, k) => k !== titleIndex) : all;
  const words = stripHtmlComments(normalizeNewlines(source))
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w)).length;
  return { title, blocks, toc: buildToc(blocks), words };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The href to render, or null when the link must be shown as plain text. */
export function resolveHref(raw: string): string | null {
  const href = raw.trim();
  if (href.startsWith("#")) return href;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // javascript:, data:, ...
  if (href.startsWith("//")) return null;
  try {
    return new URL(href, WHITEPAPER_DOCS_BASE).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|<>~]/;
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^>\s]+)>/y;
const LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/y;
const BOLD = /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/y;
const ITALIC = /\*(?=[^\s*])([\s\S]+?)(?<=[^\s*])\*(?!\*)/y;

function renderLink(href: string, children: ReactNode, key: string): ReactNode {
  const resolved = resolveHref(href);
  if (!resolved) return <span key={key}>{children}</span>;
  const external = !resolved.startsWith("#");
  return (
    <a
      key={key}
      href={resolved}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

/** Render one run of inline markdown to React nodes. */
export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let k = 0;
  const key = () => `${keyPrefix}.${k++}`;
  const flush = () => {
    if (buf) {
      out.push(buf.replace(/\n/g, " "));
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (c === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let j = text.indexOf(fence, i + n);
      // The closing run must be exactly n long.
      while (j !== -1 && text[j + n] === "`") {
        let run = n;
        while (text[j + run] === "`") run++;
        j = text.indexOf(fence, j + run);
      }
      if (j !== -1) {
        let code = text.slice(i + n, j).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) {
          code = code.slice(1, -1);
        }
        flush();
        out.push(<code key={key()}>{code}</code>);
        i = j + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }

    if (c === "<") {
      AUTOLINK.lastIndex = i;
      const m = AUTOLINK.exec(text);
      if (m) {
        flush();
        const k2 = key();
        out.push(renderLink(m[1], m[1].replace(/^mailto:/i, ""), k2));
        i += m[0].length;
        continue;
      }
    }

    if (c === "[") {
      LINK.lastIndex = i;
      const m = LINK.exec(text);
      if (m) {
        flush();
        const k2 = key();
        out.push(renderLink(m[2], renderInline(m[1], k2), k2));
        i += m[0].length;
        continue;
      }
    }

    if (c === "*") {
      BOLD.lastIndex = i;
      const b = BOLD.exec(text);
      if (b) {
        flush();
        const k2 = key();
        out.push(<strong key={k2}>{renderInline(b[1], k2)}</strong>);
        i += b[0].length;
        continue;
      }
      ITALIC.lastIndex = i;
      const it = text[i + 1] === "*" ? null : ITALIC.exec(text);
      if (it) {
        flush();
        const k2 = key();
        out.push(<em key={k2}>{renderInline(it[1], k2)}</em>);
        i += it[0].length;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function HeadingTag({ level, id, children }: { level: number; id: string; children: ReactNode }) {
  const anchor = (
    <a className="wp-anchor" href={`#${id}`} aria-hidden="true" tabIndex={-1}>
      #
    </a>
  );
  // Level 1 is the page title and is rendered by the page. A second level-1
  // heading inside the paper is shown as a level 2, so the page keeps one h1.
  if (level <= 2)
    return (
      <h2 id={id} className="wp-h2">
        {children}
        {anchor}
      </h2>
    );
  if (level === 3)
    return (
      <h3 id={id} className="wp-h3">
        {children}
        {anchor}
      </h3>
    );
  return (
    <h4 id={id} className="wp-h4">
      {children}
      {anchor}
    </h4>
  );
}

export function renderBlocks(blocks: Block[], keyPrefix = "b"): ReactNode[] {
  return blocks.map((b, n) => {
    const key = `${keyPrefix}${n}`;
    switch (b.kind) {
      case "heading":
        return (
          <HeadingTag key={key} level={b.level} id={b.id}>
            {renderInline(b.text, key)}
          </HeadingTag>
        );
      case "paragraph":
        return <p key={key}>{renderInline(b.text, key)}</p>;
      case "list": {
        const items = b.items.map((item, m) => (
          <li key={`${key}.${m}`}>{renderInline(item, `${key}.${m}`)}</li>
        ));
        return b.ordered ? (
          <ol key={key} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "table":
        return (
          <div
            key={key}
            className="styx-table-wrap wp-table-wrap"
            role="region"
            aria-label="Table"
            tabIndex={0}
          >
            <table className="styx-table wp-table">
              <thead>
                <tr>
                  {b.header.map((h, c) => (
                    <th
                      key={c}
                      scope="col"
                      style={b.align[c] ? { textAlign: b.align[c]! } : undefined}
                    >
                      {renderInline(h, `${key}.h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        style={b.align[c] ? { textAlign: b.align[c]! } : undefined}
                      >
                        {renderInline(cell, `${key}.${r}.${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "code":
        return (
          <div key={key} className="styx-code-panel wp-code">
            {b.lang ? <div className="styx-code-head">{b.lang}</div> : null}
            <pre className="styx-code">
              <code>{b.code}</code>
            </pre>
          </div>
        );
      case "rule":
        return <hr key={key} className="wp-rule" />;
      case "quote":
        return (
          <blockquote key={key} className="wp-quote">
            {renderBlocks(b.blocks, `${key}.`)}
          </blockquote>
        );
    }
  });
}
