#!/usr/bin/env node
/**
 * Assemble docs/protocol-01-design-document.html from docs/_sections/*.html.
 *
 * The document is written one page per file so sections can be revised, or
 * written in parallel, without eighteen pages of layout drifting apart. This
 * script only concatenates: the page frame, the running head and the folio come
 * from _styx-print.css, and every section file is expected to open a `.page`.
 *
 * The stylesheets are INLINED rather than linked. Chrome prints this file from a
 * file:// URL, and a linked sheet plus four base64 faces was one relative path
 * away from silently printing in Times New Roman on a white ground.
 *
 * Usage: node docs/_assemble-design-doc.mjs
 * Then:  node scripts/render-docs-pdf.mjs design
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = dirname(fileURLToPath(import.meta.url));
const SECTIONS = join(DOCS, '_sections');

const fonts = readFileSync(join(DOCS, '_styx-print-fonts.css'), 'utf8');
const css = readFileSync(join(DOCS, '_styx-print.css'), 'utf8');

const files = readdirSync(SECTIONS).filter((f) => f.endsWith('.html')).sort();
if (!files.length) {
  console.error('No section files in docs/_sections');
  process.exit(1);
}

const body = files.map((f) => readFileSync(join(SECTIONS, f), 'utf8').trim()).join('\n\n');

const pageCount = (body.match(/class="page/g) || []).length;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Styx Protocol, Design and Architecture</title>
<meta name="description" content="Styx Protocol design and architecture document. A shielded payment pool on Solana with hash-based STARK proofs and hybrid post-quantum stealth addresses. Devnet, not audited.">
<style>
${fonts}
</style>
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;

const out = join(DOCS, 'protocol-01-design-document.html');
writeFileSync(out, html);

console.log(`assembled ${files.length} section files, ${pageCount} pages`);
console.log(`  ${out}`);
console.log(`  ${(html.length / 1024).toFixed(0)} KB (of which ${(fonts.length / 1024).toFixed(0)} KB is inlined fonts)`);
for (const f of files) console.log(`    ${f}`);
