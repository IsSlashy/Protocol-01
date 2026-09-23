import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeNewlines } from "./markdown";

/**
 * docs/WHITEPAPER.md, read from disk when /whitepaper is prerendered.
 *
 * HOW THE FILE REACHES VERCEL. The paper lives at the repository root, outside
 * apps/web. Vercel clones the whole monorepo and runs `next build` from
 * apps/web, so at build time the file sits at ../../docs/WHITEPAPER.md
 * relative to process.cwd(). The route is `force-static`: the page, its
 * metadata and its share images are rendered once, during `next build`, from
 * the committed file, and nothing reads it at request time. As a second guard,
 * next.config.mjs lists the file under `outputFileTracingIncludes` for this
 * route, so the file is also inside the server bundle should the route ever be
 * rendered on demand.
 *
 * FAILING LOUDLY. A missing or empty file throws. During `next build` that
 * aborts the prerender of /whitepaper and with it the whole build, so a
 * deploy can never publish an empty white paper page. (An unfinished paper is
 * a different case, handled by the page: see findUnfilledPlaceholders.)
 */

/** Where the paper may be, most likely first. apps/web is the normal cwd. */
function candidates(): string[] {
  const cwd = process.cwd();
  return [
    join(cwd, "..", "..", "docs", "WHITEPAPER.md"),
    // `next build` run from the repository root with a path argument.
    join(cwd, "docs", "WHITEPAPER.md"),
  ];
}

export function whitepaperPath(): string {
  const tried = candidates();
  const found = tried.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `[whitepaper] docs/WHITEPAPER.md not found. /whitepaper is rendered from that ` +
        `file at build time and must not be published empty. Looked in:\n  ${tried.join("\n  ")}`,
    );
  }
  return found;
}

export function loadWhitepaperSource(): string {
  const file = whitepaperPath();
  const text = normalizeNewlines(readFileSync(file, "utf8")).replace(/^﻿/, "");
  if (text.trim().length === 0) {
    throw new Error(`[whitepaper] ${file} is empty. Refusing to build /whitepaper.`);
  }
  if (!/^# \S/m.test(text)) {
    throw new Error(
      `[whitepaper] ${file} has no level-1 heading ("# Title"). Refusing to build /whitepaper.`,
    );
  }
  return text;
}

/**
 * sha256 of the paper with line endings normalised to LF, so a Windows
 * checkout (CRLF) and the Linux build on Vercel (LF) agree. The same function
 * is duplicated in scripts/whitepaper-pdf.mjs, which records it next to the
 * PDF; the page offers the PDF only when the two match.
 */
export function whitepaperSha256(source: string): string {
  return createHash("sha256")
    .update(normalizeNewlines(source).replace(/^﻿/, ""), "utf8")
    .digest("hex");
}

/** Written by scripts/whitepaper-pdf.mjs next to public/styx-whitepaper.pdf. */
export const PDF_PUBLIC_PATH = "/styx-whitepaper.pdf";
const PDF_MANIFEST = "styx-whitepaper.pdf.json";

/**
 * True when public/styx-whitepaper.pdf exists AND was printed from this exact
 * paper. A PDF of an older draft is never offered next to a newer page: the
 * link simply does not render until the PDF is printed again.
 */
export function pdfMatchesSource(source: string): boolean {
  const dir = join(process.cwd(), "public");
  const pdf = join(dir, PDF_PUBLIC_PATH.slice(1));
  const manifest = join(dir, PDF_MANIFEST);
  if (!existsSync(pdf) || !existsSync(manifest)) return false;
  try {
    const recorded = JSON.parse(readFileSync(manifest, "utf8")) as { sha256?: unknown };
    return recorded.sha256 === whitepaperSha256(source);
  } catch {
    return false;
  }
}
