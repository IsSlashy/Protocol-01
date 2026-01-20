#!/usr/bin/env node
/**
 * Solana Dependency Fixer
 *
 * Fixes Cargo.lock to use versions compatible with Solana's Rust 1.75
 * by downgrading crates that require edition 2024.
 *
 * Usage: node fix-deps.js [path/to/Cargo.lock]
 */

const fs = require('fs');
const path = require('path');

// Crates with maximum compatible versions (before edition 2024 requirement)
const MAX_COMPATIBLE_VERSIONS = {
  'constant_time_eq': '0.3.1',
  'base64ct': '1.6.0',
  'subtle': '2.5.0',
  'password-hash': '0.5.0',
  'crypto-common': '0.1.6',
  'zeroize': '1.7.0',
  'aead': '0.5.2',
  'cipher': '0.4.4',
  'universal-hash': '0.5.1',
  'inout': '0.1.3',
  'signature': '2.2.0',
  'elliptic-curve': '0.13.8',
  'sec1': '0.7.3',
  'spki': '0.7.3',
  'pkcs8': '0.10.2',
  'der': '0.7.9',
  'pem-rfc7468': '0.7.0',
};

function parseCargoLock(content) {
  const packages = [];
  const packageRegex = /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g;
  let match;

  while ((match = packageRegex.exec(content)) !== null) {
    packages.push({
      name: match[1],
      version: match[2],
      fullMatch: match[0],
      index: match.index
    });
  }

  return packages;
}

function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const lockPath = args[0] || 'Cargo.lock';

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Solana Dependency Fixer                                  ║');
  console.log('║     Fixes edition 2024 compatibility issues                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!fs.existsSync(lockPath)) {
    console.error(`Error: ${lockPath} not found`);
    console.log('');
    console.log('Usage: node fix-deps.js [path/to/Cargo.lock]');
    process.exit(1);
  }

  let content = fs.readFileSync(lockPath, 'utf8');
  const packages = parseCargoLock(content);

  console.log(`Found ${packages.length} packages in Cargo.lock`);
  console.log('');
  console.log('Checking for problematic dependencies...');
  console.log('');

  const issues = [];
  const fixes = [];

  for (const pkg of packages) {
    if (MAX_COMPATIBLE_VERSIONS[pkg.name]) {
      const maxVersion = MAX_COMPATIBLE_VERSIONS[pkg.name];
      const comparison = compareVersions(pkg.version, maxVersion);

      if (comparison > 0) {
        issues.push({
          name: pkg.name,
          current: pkg.version,
          max: maxVersion
        });

        // Create the fix
        const oldEntry = `[[package]]\nname = "${pkg.name}"\nversion = "${pkg.version}"`;
        const newEntry = `[[package]]\nname = "${pkg.name}"\nversion = "${maxVersion}"`;

        fixes.push({
          name: pkg.name,
          old: oldEntry,
          new: newEntry,
          oldVersion: pkg.version,
          newVersion: maxVersion
        });
      } else {
        console.log(`  ✓ ${pkg.name}: ${pkg.version} (OK)`);
      }
    }
  }

  if (issues.length === 0) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✓ No problematic dependencies found!');
    console.log('═══════════════════════════════════════════════════════════════');
    return;
  }

  console.log('');
  console.log('Found problematic dependencies:');
  for (const issue of issues) {
    console.log(`  ⚠ ${issue.name}: ${issue.current} → ${issue.max}`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('To fix these issues, you need to:');
  console.log('');
  console.log('1. Add this to your Cargo.toml:');
  console.log('');
  console.log('[patch.crates-io]');
  for (const issue of issues) {
    console.log(`${issue.name} = "=${issue.max}"`);
  }
  console.log('');
  console.log('2. Then run: cargo update');
  console.log('');
  console.log('Or use cargo update with --precise:');
  console.log('');
  for (const issue of issues) {
    console.log(`cargo update -p ${issue.name} --precise ${issue.max}`);
  }
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
}

main();
