#!/usr/bin/env node
// Chunked Remotion render — splits a composition into N frame-range chunks,
// renders each in a fresh Chrome instance (dodges the 0x1A MEMORY_MANAGEMENT
// BSOD Windows throws when Chromium accumulates too much VRAM at 4K), then
// concatenates the parts with ffmpeg.
//
// Usage:
//   node scripts/render-chunked.mjs <compositionId> <output> [--chunk=500] [--gl=angle] [--total=N]
//
// If --total is omitted, the script asks Remotion for the composition's
// duration via `remotion compositions --log=error`.

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [compositionId, output] = positional;

if (!compositionId || !output) {
  console.error('Usage: render-chunked.mjs <compositionId> <output> [--chunk=500] [--gl=angle] [--total=N]');
  process.exit(1);
}

const chunkSize = Number(flags.chunk ?? 500);
const gl = String(flags.gl ?? 'angle');
const outputPath = resolve(appRoot, output);
const partsDir = resolve(appRoot, 'out/parts', basename(output, extname(output)));
mkdirSync(partsDir, { recursive: true });

// ---------------------------------------------------------------------------
// Resolve total frame count
// ---------------------------------------------------------------------------

function getTotalFrames() {
  if (flags.total) return Number(flags.total);
  console.log('→ probing composition duration via `remotion compositions`…');
  const out = execFileSync('npx', ['remotion', 'compositions', '--log=error'], {
    cwd: appRoot,
    encoding: 'utf8',
    shell: true,
  });
  // Table output: columns "Composition ID", "Width x Height", "FPS", "Duration"
  const line = out.split('\n').find((l) => l.trim().startsWith(compositionId));
  if (!line) throw new Error(`Composition "${compositionId}" not found`);
  // The duration column is the last number on the line
  const nums = line.match(/\d+/g);
  if (!nums) throw new Error('Could not parse duration');
  return Number(nums[nums.length - 1]);
}

const totalFrames = getTotalFrames();
const chunks = [];
for (let start = 0; start < totalFrames; start += chunkSize) {
  const end = Math.min(start + chunkSize - 1, totalFrames - 1);
  chunks.push({ start, end });
}

console.log(`Composition: ${compositionId}`);
console.log(`Total frames: ${totalFrames}`);
console.log(`Chunk size:   ${chunkSize}`);
console.log(`Chunks:       ${chunks.length}`);
console.log(`GL backend:   ${gl}`);
console.log(`Output:       ${outputPath}`);
console.log(`Parts dir:    ${partsDir}`);
console.log('');

// ---------------------------------------------------------------------------
// Render each chunk — fresh Chrome instance per call, releases GPU memory
// ---------------------------------------------------------------------------

const partPaths = [];
for (let i = 0; i < chunks.length; i++) {
  const { start, end } = chunks[i];
  const partPath = join(partsDir, `part-${String(i).padStart(3, '0')}.mp4`);
  partPaths.push(partPath);

  if (existsSync(partPath) && !flags.force) {
    console.log(`[${i + 1}/${chunks.length}] skip (exists): frames ${start}-${end}`);
    continue;
  }

  console.log(`[${i + 1}/${chunks.length}] render frames ${start}-${end} → ${basename(partPath)}`);
  const t0 = Date.now();
  const result = spawnSync(
    'npx',
    [
      'remotion',
      'render',
      compositionId,
      partPath,
      `--frames=${start}-${end}`,
      `--gl=${gl}`,
      '--concurrency=1',
    ],
    { cwd: appRoot, stdio: 'inherit', shell: true },
  );
  if (result.status !== 0) {
    console.error(`chunk ${i + 1} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ↳ chunk ${i + 1} done in ${dt}s`);
}

// ---------------------------------------------------------------------------
// ffmpeg concat
// ---------------------------------------------------------------------------

const concatFile = join(partsDir, 'concat.txt');
writeFileSync(
  concatFile,
  partPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n') + '\n',
);

console.log('\n→ ffmpeg concat');
mkdirSync(dirname(outputPath), { recursive: true });
const concat = spawnSync(
  'ffmpeg',
  ['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', outputPath],
  { stdio: 'inherit', shell: true },
);
if (concat.status !== 0) {
  console.error('ffmpeg concat failed');
  process.exit(concat.status ?? 1);
}

console.log(`\n✓ Done → ${outputPath}`);

if (flags.clean) {
  rmSync(partsDir, { recursive: true, force: true });
  console.log(`  (cleaned ${partsDir})`);
}
