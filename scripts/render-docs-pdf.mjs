#!/usr/bin/env node
// Render the public marketing HTML docs to PDF using a headless Chromium.
// Tries Microsoft Edge first, then Google Chrome. No external deps.
//
// Usage:
//   node scripts/render-docs-pdf.mjs            (renders all targets)
//   node scripts/render-docs-pdf.mjs pitch      (just pitch deck)
//   node scripts/render-docs-pdf.mjs design
//   node scripts/render-docs-pdf.mjs charter
//   node scripts/render-docs-pdf.mjs project-tree

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { platform } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = resolve(REPO_ROOT, 'docs');
const WEB_PUBLIC = resolve(REPO_ROOT, 'apps/web/public');

const BROWSER_CANDIDATES = platform() === 'win32'
  ? [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
  : platform() === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ];

const browser = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('No Chrome/Edge binary found. Install Microsoft Edge or Google Chrome.');
  process.exit(1);
}

const TARGETS = {
  pitch: {
    html: resolve(DOCS, 'PROTOCOL_01_PITCH_DECK.html'),
    docsPdf: resolve(DOCS, 'PROTOCOL_01_PITCH_DECK.pdf'),
    webPdf: resolve(WEB_PUBLIC, 'pitch-deck.pdf'),
  },
  design: {
    html: resolve(DOCS, 'protocol-01-design-document.html'),
    docsPdf: resolve(DOCS, 'protocol-01-design-document.pdf'),
    webPdf: resolve(WEB_PUBLIC, 'protocol-01-design-document.pdf'),
  },
  charter: {
    html: resolve(DOCS, 'PROTOCOL_01_ECONOMIC_CHARTER.html'),
    docsPdf: resolve(DOCS, 'PROTOCOL_01_ECONOMIC_CHARTER.pdf'),
    webPdf: resolve(WEB_PUBLIC, 'economic-charter.pdf'),
  },
  'project-tree': {
    html: resolve(DOCS, 'project-tree.html'),
    docsPdf: resolve(DOCS, 'project-tree.pdf'),
    webPdf: null,
  },
};

const arg = process.argv[2];
const selected = !arg || arg === 'all' ? Object.keys(TARGETS) : [arg];
for (const key of selected) {
  if (!TARGETS[key]) {
    console.error(`Unknown target: ${key}. Choices: ${Object.keys(TARGETS).join(', ')}, all`);
    process.exit(1);
  }
}

console.log(`Browser: ${browser}`);

for (const key of selected) {
  const t = TARGETS[key];
  if (!existsSync(t.html)) {
    console.warn(`[${key}] skipped, HTML missing: ${t.html}`);
    continue;
  }
  const fileUrl = `file:///${t.html.replace(/\\/g, '/')}`;
  console.log(`[${key}] ${t.html} -> ${t.docsPdf}`);
  // Edge headless on Windows often fails to release renderer subprocesses,
  // so execFileSync hangs even after the PDF has been written. Wrap in try
  // and fall back to a freshness check on the PDF: if it was updated within
  // the last minute, the render succeeded and we can proceed to copy.
  const startedAt = Date.now();
  try {
    execFileSync(
      browser,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--no-pdf-header-footer',
        '--virtual-time-budget=10000',
        `--print-to-pdf=${t.docsPdf}`,
        fileUrl,
      ],
      { stdio: 'inherit', timeout: 45_000 },
    );
  } catch (err) {
    if (!existsSync(t.docsPdf) || statSync(t.docsPdf).mtimeMs < startedAt) {
      throw err;
    }
    console.warn(`[${key}] browser did not exit cleanly, but PDF was produced; continuing`);
  }

  if (t.webPdf) {
    mkdirSync(dirname(t.webPdf), { recursive: true });
    copyFileSync(t.docsPdf, t.webPdf);
    console.log(`[${key}] copied to ${t.webPdf}`);
  }
}

console.log('\nDone. Review the PDFs and commit if they look correct.');
