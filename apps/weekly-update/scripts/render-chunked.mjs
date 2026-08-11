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
/* Every composition in this project is 60fps. It is needed at the remux step to
   write one explicit constant-rate clock; pass --fps if that ever stops being
   true, because a wrong value here silently retimes the whole film. */
const fps = Number(flags.fps ?? 60);
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

      /* Quality. The script used to pass none of this and take Remotion's
         defaults, which are wrong for a film that is almost entirely near-black
         with one-pixel hairlines and text at low alpha.

         --image-format=png: intermediate frames are JPEG at quality 80 by
         default. On flat dark grounds that produces visible ringing around type
         and blocking in the gradients, and it is thrown away before the encoder
         ever sees it. These frames compress well as PNG because the picture is
         mostly one colour, so the cost is small.

         --crf=16: h264 default is 18. Two steps lower costs some file size and
         buys back the faint hairlines, which are exactly what an aggressive
         encoder decides to spend nothing on.

         Deliberately NOT changed: 8-bit yuv420p, because a 10-bit file would
         resist banding better and then fail to play in half the places this film
         gets opened. And --concurrency stays at 1: short-lived processes are the
         reason this script exists at all, since a long single-pass 4K render
         bluescreens this machine. */
      '--image-format=png',
      '--crf=16',

      /* Pin the pixel format. With PNG intermediates the encoder was picking
         yuvj420p, which signals FULL range. On a film built on #070709 that is
         not cosmetic: a player that reads full-range levels as limited lifts the
         blacks, and one that does the reverse crushes them. yuv420p is what
         every target expects. */
      '--pixel-format=yuv420p',
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

/**
 * Concatenate in TWO steps, through a raw h264 elementary stream.
 *
 * The one-step `-f concat -c copy` straight to mp4 produced a file with the right
 * frame count and the wrong clock. Measured on the 7200 frame film: 7200 frames
 * at 60fps is 120 seconds, and the container claimed 707.1. Each part carries its
 * own edit list and timebase, and copying them into one mp4 accumulates the
 * error, so a player scrubs an 11 minute timeline over two minutes of pictures.
 * At two parts the same bug is almost invisible (2.09s instead of 2.00s), which
 * is exactly why it survived until a 15 part render.
 *
 * Going through Annex B throws away every per-part timestamp, and remuxing the
 * bare stream with an explicit `-r 60` writes one clean constant-rate clock. Both
 * steps are `-c copy`, so this is still lossless: no frame is re-encoded.
 *
 * +faststart moves the index to the head so the film starts playing before it has
 * finished downloading, which matters for a 4K file opened from a link.
 */
console.log('\n→ ffmpeg concat (raw h264, then remux at an explicit 60fps)');
mkdirSync(dirname(outputPath), { recursive: true });

const rawPath = join(partsDir, 'concat.h264');
const toRaw = spawnSync(
  'ffmpeg',
  [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-c', 'copy', '-bsf:v', 'h264_mp4toannexb',
    '-f', 'h264', rawPath,
  ],
  { stdio: 'inherit', shell: true },
);
if (toRaw.status !== 0) {
  console.error('ffmpeg concat to raw h264 failed');
  process.exit(toRaw.status ?? 1);
}

const concat = spawnSync(
  'ffmpeg',
  [
    '-y', '-fflags', '+genpts', '-r', String(fps), '-i', rawPath,
    '-c', 'copy', '-movflags', '+faststart', outputPath,
  ],
  { stdio: 'inherit', shell: true },
);
if (concat.status !== 0) {
  console.error('ffmpeg remux failed');
  process.exit(concat.status ?? 1);
}

/* Refuse to report success on a file whose clock disagrees with its frames. That
   is the defect this rewrite exists for, and it was invisible for one render. */
const probe = spawnSync(
  'ffprobe',
  ['-v', 'error', '-select_streams', 'v:0',
   '-show_entries', 'stream=nb_frames', '-show_entries', 'format=duration',
   '-of', 'default=noprint_wrappers=1:nokey=1', outputPath],
  { encoding: 'utf8', shell: true },
);
const [frames, seconds] = String(probe.stdout || '').trim().split(/\s+/).map(Number);
if (Number.isFinite(frames) && Number.isFinite(seconds)) {
  const expected = frames / fps;
  const drift = Math.abs(seconds - expected);
  console.log(`  clock check: ${frames} frames, ${seconds.toFixed(3)}s, expected ${expected.toFixed(3)}s`);
  if (drift > 0.5) {
    console.error(`  ✗ duration is off by ${drift.toFixed(2)}s. Not reporting success.`);
    process.exit(1);
  }
}

console.log(`\n✓ Done → ${outputPath}`);

if (flags.clean) {
  rmSync(partsDir, { recursive: true, force: true });
  console.log(`  (cleaned ${partsDir})`);
}
