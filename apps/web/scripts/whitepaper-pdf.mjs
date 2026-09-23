#!/usr/bin/env node
// Print https://styx.cash/whitepaper, as built locally, to
// apps/web/public/styx-whitepaper.pdf with headless Edge or Chrome.
//
// RUN IT AFTER A LOCAL PRODUCTION BUILD, never instead of one:
//
//   pnpm --filter @protocol-01/web build          (or `next build` in apps/web)
//   node apps/web/scripts/whitepaper-pdf.mjs      (starts `next start`, prints, stops it)
//   node apps/web/scripts/whitepaper-pdf.mjs --url http://localhost:3000
//                                                 (uses a server you already started)
//
// Then commit BOTH public/styx-whitepaper.pdf and public/styx-whitepaper.pdf.json.
// The page offers "Download PDF" only when the sha256 recorded in that .json
// matches the committed docs/WHITEPAPER.md (lib/whitepaper/source.ts), so a PDF
// of an older draft is never linked next to a newer page.
//
// It refuses, with a non-zero exit and nothing written, when:
//   - there is no production build (.next/BUILD_ID missing),
//   - the page shows the "being finalised" notice (a {{BENCH:...}} or
//     {{AUDIT_STATUS}} placeholder is still unfilled),
//   - the build is stale: the page was built from a different
//     docs/WHITEPAPER.md than the one on disk now,
//   - the page, as the browser renders it after hydration, is not in English
//     (see "English only" below),
//   - the browser produced no PDF, or something that is not a PDF.
//
// ENGLISH ONLY. The paper is English, but the page's own UI strings (the
// overline, the "Contents" title, <html lang>) come from I18nProvider, which
// picks French in the browser for a French-locale machine when there is no
// styx-country cookie, as on a local `next start`. So the script forces English
// three ways: it prints /whitepaper?lang=en (resolveLocale in i18n/index.tsx
// honours ?lang first), it starts the browser with --lang=en-US and
// --accept-lang=en-US, and it gives the browser an English LANG/LANGUAGE. Then,
// before printing, it has the same browser, with the same flags and URL, dump
// the hydrated DOM, and refuses unless that DOM is the English page.
//
// The browser discovery and the Windows "Edge does not exit" workaround are the
// ones of scripts/render-docs-pdf.mjs, which prints the other site PDFs.
// No dependency beyond Node 24 and an installed Edge or Chrome.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  copyFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(WEB, '..', '..');
const SOURCE = join(REPO, 'docs', 'WHITEPAPER.md');
const OUT_PDF = join(WEB, 'public', 'styx-whitepaper.pdf');
const OUT_MANIFEST = join(WEB, 'public', 'styx-whitepaper.pdf.json');
const MIN_PDF_BYTES = 50_000;

function fail(msg, code = 1) {
  console.error(`\n[whitepaper-pdf] ${msg}`);
  process.exit(code);
}

// ---- Arguments --------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const externalUrl = argValue('--url');
const port = Number(argValue('--port') ?? 3917);

// ---- The source, and the same sha256 the page computes ----------------------
// Keep in step with whitepaperSha256() in lib/whitepaper/source.ts: LF line
// endings, no BOM, UTF-8.

if (!existsSync(SOURCE)) fail(`${SOURCE} not found.`);
const source = readFileSync(SOURCE, 'utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');

// ---- Browser ----------------------------------------------------------------

const BROWSER_CANDIDATES =
  platform() === 'win32'
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
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

const browser = process.env.WHITEPAPER_PDF_BROWSER ?? BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!browser) fail('No Chrome/Edge binary found. Install one, or set WHITEPAPER_PDF_BROWSER.');

// ---- Server -----------------------------------------------------------------

let server = null;

function stopServer() {
  if (!server || server.exitCode !== null) return;
  if (platform() === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  } else {
    server.kill('SIGTERM');
  }
}
process.on('exit', stopServer);
process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status === 200) return await res.text();
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e?.cause?.code ?? e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${url} did not answer 200 within ${timeoutMs / 1000} s (last: ${last}).`);
}

let base = externalUrl?.replace(/\/+$/, '');
if (!base) {
  if (!existsSync(join(WEB, '.next', 'BUILD_ID'))) {
    fail('No production build in apps/web/.next. Run the build first (next build), then this script.');
  }
  const require = createRequire(join(WEB, 'package.json'));
  const nextBin = require.resolve('next/dist/bin/next');
  base = `http://localhost:${port}`;
  console.log(`[whitepaper-pdf] starting next start on ${base}`);
  server = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    cwd: WEB,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[whitepaper-pdf] next start exited with ${code}`);
  });
}

const pageUrl = `${base}/whitepaper`;
// What the browser loads: forced to English (see "English only" above).
const printUrl = `${pageUrl}?lang=en`;

// ---- Checks on the served page ---------------------------------------------

const html = await waitFor(pageUrl, 90_000);

const state = /data-whitepaper-state="(final|pending)"/.exec(html)?.[1];
if (state !== 'final') {
  fail(
    state === 'pending'
      ? 'The page shows "being finalised": docs/WHITEPAPER.md still has an unfilled {{BENCH:...}} or {{AUDIT_STATUS}} placeholder. Nothing printed.'
      : `Could not find data-whitepaper-state on ${pageUrl}. Is this the right server?`,
    2,
  );
}

const builtSha = /data-source-sha256="([0-9a-f]{64})"/.exec(html)?.[1];
if (builtSha !== sha256) {
  fail(
    `Stale build: the page was built from a docs/WHITEPAPER.md with sha256 ${builtSha ?? '(none)'}, ` +
      `the file on disk is ${sha256}. Rebuild, then run this again. Nothing printed.`,
    3,
  );
}

// ---- Browser runs -----------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'styx-whitepaper-'));
const tmpPdf = join(work, 'styx-whitepaper.pdf');
console.log(`[whitepaper-pdf] browser: ${browser}`);

// The same flags and environment for the English check and for the print, so
// the check describes the page that gets printed. Each run gets its own fresh
// profile: no stored locale, no cookie, and no chance of the second run being
// handed to a lingering process of the first (Edge on Windows keeps some alive).
const browserEnv = { ...process.env, LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en', LC_ALL: 'en_US.UTF-8' };
function browserArgs(profileName) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=en-US',
    '--accept-lang=en-US,en',
    `--user-data-dir=${join(work, profileName)}`,
    '--run-all-compositor-stages-before-draw',
    // Long enough for hydration: I18nProvider resolves the locale in an effect.
    '--virtual-time-budget=20000',
  ];
}

// ---- English check, on the hydrated DOM ------------------------------------

// Strings that only the French dictionary puts on this page (i18n/fr.ts:
// whitepaper.*, footer.*). The paper itself is English and contains none.
const FRENCH_MARKERS = [
  'Sommaire',
  'Livre blanc',
  'Retour au sommaire',
  'Rédigé en anglais',
  'Télécharger le PDF',
  'min de lecture',
  'Devnet uniquement',
];

function dumpDom() {
  const opts = {
    env: browserEnv,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 90_000,
    stdio: ['ignore', 'pipe', 'inherit'],
  };
  try {
    return execFileSync(browser, [...browserArgs('profile-dom'), '--dump-dom', printUrl], opts);
  } catch (err) {
    // Same Windows quirk as the print below: Edge can outlive its output.
    const out = typeof err?.stdout === 'string' ? err.stdout : err?.stdout?.toString('utf8');
    if (out && out.includes('</html>')) return out;
    fail(`The browser could not render ${printUrl} for the English check: ${err?.message ?? err}`);
  }
}

console.log(`[whitepaper-pdf] checking that ${printUrl} renders in English`);
const dom = dumpDom();
{
  const problems = [];
  if (!/data-whitepaper-state="final"/.test(dom)) problems.push('no data-whitepaper-state="final" in the rendered page');
  const htmlLang = /<html\b[^>]*\blang="([^"]*)"/i.exec(dom)?.[1];
  if (htmlLang !== 'en') problems.push(`<html lang> is "${htmlLang ?? '(none)'}", not "en"`);
  const tocTitle = /<h2\b[^>]*\bid="contents"[^>]*>([^<]*)</.exec(dom)?.[1]?.trim();
  if (tocTitle !== 'Contents') problems.push(`the contents title is "${tocTitle ?? '(missing)'}", not "Contents"`);
  if (!dom.includes('White paper')) problems.push('the English overline "White paper" is missing');
  for (const marker of FRENCH_MARKERS) {
    if (dom.includes(marker)) problems.push(`French UI text "${marker}" is on the page`);
  }
  if (problems.length > 0) {
    stopServer();
    fail(`The page did not render in English, so nothing was printed:\n  - ${problems.join('\n  - ')}`, 4);
  }
}
console.log('[whitepaper-pdf] English check passed (lang="en", "Contents", no French UI text)');

// ---- Print ------------------------------------------------------------------

console.log(`[whitepaper-pdf] ${printUrl} -> ${OUT_PDF}`);

const startedAt = Date.now();
try {
  execFileSync(
    browser,
    [...browserArgs('profile-pdf'), '--no-pdf-header-footer', `--print-to-pdf=${tmpPdf}`, printUrl],
    { stdio: 'inherit', timeout: 90_000, env: browserEnv },
  );
} catch (err) {
  // Edge headless on Windows often keeps renderer processes alive after the
  // PDF is written, so the call times out even on success. Accept it only if a
  // fresh PDF exists.
  if (!existsSync(tmpPdf) || statSync(tmpPdf).mtimeMs < startedAt) {
    stopServer();
    fail(`The browser failed and wrote no PDF: ${err?.message ?? err}`);
  }
  console.warn('[whitepaper-pdf] browser did not exit cleanly, but a PDF was written; checking it');
}

stopServer();

if (!existsSync(tmpPdf)) fail('The browser wrote no PDF.');
const pdf = readFileSync(tmpPdf);
if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') fail('The output is not a PDF.');
if (pdf.length < MIN_PDF_BYTES) {
  fail(`The PDF is only ${pdf.length} bytes (expected at least ${MIN_PDF_BYTES}): the page probably did not render. Nothing written.`);
}

try {
  renameSync(tmpPdf, OUT_PDF);
} catch {
  copyFileSync(tmpPdf, OUT_PDF); // different drive on Windows
}
writeFileSync(
  OUT_MANIFEST,
  JSON.stringify(
    {
      source: 'docs/WHITEPAPER.md',
      sha256,
      bytes: pdf.length,
      pdfSha256: createHash('sha256').update(pdf).digest('hex'),
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  /* Edge may still hold the profile; the OS cleans tmp */
}

console.log(`[whitepaper-pdf] wrote ${OUT_PDF} (${pdf.length} bytes) and ${OUT_MANIFEST}`);
console.log(
  '[whitepaper-pdf] Open the PDF and read it before committing both files: its contents page must say "Contents", not "Sommaire".',
);
process.exit(0);
