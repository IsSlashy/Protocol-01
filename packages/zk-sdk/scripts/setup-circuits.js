#!/usr/bin/env node

/**
 * Protocol 01 Circuit Setup Script
 *
 * Downloads / copies the ZK circuit files (WASM + zkey + verification keys)
 * required by @protocol-01/zk-sdk, @protocol-01/zkspl-sdk, and @protocol-01/specter-sdk to generate
 * Groth16 proofs.
 *
 * Usage:
 *   npx @protocol-01/zk-sdk setup          # after npm install
 *   node scripts/setup-circuits.js  # from within the package
 *
 * The script looks for circuit files in the Protocol 01 monorepo first
 * (../../circuits/build), then falls back to a download URL hint.
 *
 * Pure Node.js -- no external dependencies.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Circuit manifest -- every file needed across all Protocol 01 ZK SDKs
// ---------------------------------------------------------------------------

const CIRCUITS = [
  {
    name: 'transfer',
    wasm: 'transfer.wasm',
    zkey: 'transfer_final.zkey',
    vkey: 'transfer_vk.json',
  },
  {
    name: 'confidential_balance',
    wasm: 'confidential_balance.wasm',
    zkey: 'confidential_balance_final.zkey',
    vkey: 'confidential_balance_vk.json',
  },
  {
    name: 'balance_proof',
    wasm: 'balance_proof.wasm',
    zkey: 'balance_proof_final.zkey',
    vkey: 'balance_proof_vk.json',
  },
  {
    name: 'denominated_pool',
    wasm: 'denominated_pool.wasm',
    zkey: 'denominated_pool_final.zkey',
    vkey: 'denominated_pool_vk.json',
  },
  {
    name: 'denominated_transfer',
    wasm: 'denominated_transfer.wasm',
    zkey: 'denominated_transfer_final.zkey',
    vkey: 'denominated_transfer_vk.json',
  },
  {
    name: 'subscriber_ownership',
    wasm: 'subscriber_ownership.wasm',
    zkey: 'subscriber_ownership_final.zkey',
    vkey: 'subscriber_ownership_vk.json',
  },
];

const RELEASE_URL = 'https://github.com/protocol-01/circuits/releases';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the monorepo circuits/build directory.
 * Works whether invoked from packages/zk-sdk or from the repo root.
 */
function findMonorepoBuildDir() {
  // When run from packages/zk-sdk  -> ../../circuits/build
  // When run from repo root         -> circuits/build
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'circuits', 'build'),
    path.resolve(process.cwd(), 'circuits', 'build'),
    path.resolve(process.cwd(), '..', '..', 'circuits', 'build'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Find the source path of a circuit file inside the build directory.
 *
 * WASM files live in  <build>/<name>_js/<name>.wasm
 * zkey files live in  <build>/<name>_final.zkey
 * vkey files live in  <build>/<name>_vk.json
 *
 * For the transfer circuit there is also a copy at the repo root
 * (circuits/transfer_js/transfer.wasm) -- we prefer circuits/build.
 */
function resolveSourceFile(buildDir, circuit, fileType) {
  const fileName =
    fileType === 'wasm'
      ? circuit.wasm
      : fileType === 'zkey'
        ? circuit.zkey
        : circuit.vkey;

  if (fileType === 'wasm') {
    // WASM lives inside <name>_js/ subdirectory
    const wasmPath = path.join(buildDir, circuit.name + '_js', fileName);
    if (fs.existsSync(wasmPath)) return wasmPath;
  }

  // zkey and vkey live directly in the build dir
  const directPath = path.join(buildDir, fileName);
  if (fs.existsSync(directPath)) return directPath;

  // Fallback: the legacy verification_key.json (transfer only)
  if (fileType === 'vkey' && circuit.name === 'transfer') {
    const legacyVk = path.join(buildDir, 'verification_key.json');
    if (fs.existsSync(legacyVk)) return legacyVk;
  }

  return null;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const destDir = path.resolve(process.cwd(), 'circuits');

  console.log('');
  console.log('  Protocol 01 -- Circuit Setup');
  console.log('  ============================');
  console.log('');

  // 1. Locate the monorepo build directory
  const buildDir = findMonorepoBuildDir();

  if (!buildDir) {
    console.log('  Circuit files not found in monorepo.');
    console.log('');
    console.log('  For external use, download from:');
    console.log('    ' + RELEASE_URL);
    console.log('');
    console.log('  Then place the files in: ' + destDir);
    console.log('');
    console.log('  Required files:');
    for (const circuit of CIRCUITS) {
      console.log('    - ' + circuit.wasm);
      console.log('    - ' + circuit.zkey);
      console.log('    - ' + circuit.vkey);
    }
    console.log('');
    process.exit(1);
  }

  console.log('  Source:      ' + buildDir);
  console.log('  Destination: ' + destDir);
  console.log('');

  // 2. Ensure destination directory exists
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // 3. Copy each file
  let copied = 0;
  let skipped = 0;
  let missing = 0;
  let totalBytes = 0;
  const missingFiles = [];

  for (const circuit of CIRCUITS) {
    for (const fileType of ['wasm', 'zkey', 'vkey']) {
      const destFileName =
        fileType === 'wasm'
          ? circuit.wasm
          : fileType === 'zkey'
            ? circuit.zkey
            : circuit.vkey;

      const srcPath = resolveSourceFile(buildDir, circuit, fileType);
      const destPath = path.join(destDir, destFileName);

      if (!srcPath) {
        console.log('  [MISSING]  ' + destFileName);
        missing++;
        missingFiles.push(destFileName);
        continue;
      }

      // Skip if destination already exists and has the same size
      if (fs.existsSync(destPath)) {
        const srcStat = fs.statSync(srcPath);
        const destStat = fs.statSync(destPath);
        if (srcStat.size === destStat.size) {
          console.log('  [OK]       ' + destFileName + '  (' + formatSize(destStat.size) + ', already up to date)');
          skipped++;
          totalBytes += destStat.size;
          continue;
        }
      }

      // Copy the file
      fs.copyFileSync(srcPath, destPath);
      const stat = fs.statSync(destPath);
      totalBytes += stat.size;
      copied++;
      console.log('  [COPIED]   ' + destFileName + '  (' + formatSize(stat.size) + ')');
    }
  }

  // 4. Summary
  console.log('');
  console.log('  ----------------------------------------');
  console.log('  Total:   ' + (copied + skipped + missing) + ' files');
  console.log('  Copied:  ' + copied);
  console.log('  Current: ' + skipped);
  if (missing > 0) {
    console.log('  Missing: ' + missing);
  }
  console.log('  Size:    ' + formatSize(totalBytes));
  console.log('');

  if (missing > 0) {
    console.log('  WARNING: ' + missing + ' file(s) not found in the monorepo build.');
    console.log('  Missing files:');
    for (const f of missingFiles) {
      console.log('    - ' + f);
    }
    console.log('');
    console.log('  You may need to compile them first:');
    console.log('    cd circuits && circom <name>.circom --wasm --r1cs -o build');
    console.log('    snarkjs groth16 setup build/<name>.r1cs pot20_final.ptau build/<name>_0000.zkey');
    console.log('    echo "entropy" | snarkjs zkey contribute build/<name>_0000.zkey build/<name>_final.zkey');
    console.log('    snarkjs zkey export verificationkey build/<name>_final.zkey build/<name>_vk.json');
    console.log('');
  }

  if (copied > 0 || skipped > 0) {
    console.log('  Circuit files are ready. You can now use:');
    console.log('');
    console.log("    const prover = new ZkProver('./circuits/transfer.wasm', './circuits/transfer_final.zkey');");
    console.log('');
  }
}

main();
