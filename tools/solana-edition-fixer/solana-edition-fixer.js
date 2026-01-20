#!/usr/bin/env node
/**
 * Solana Edition 2024 Fixer
 *
 * A comprehensive tool to fix Rust edition 2024 compatibility issues
 * for Solana/Anchor projects using older toolchains.
 *
 * Problem: Solana platform-tools use Cargo 1.84.x, but edition 2024 requires Cargo 1.85+
 * Solution: Pin dependencies to versions that don't require edition 2024
 *
 * Usage:
 *   npx solana-edition-fixer [project-path]
 *   node solana-edition-fixer.js [project-path]
 *
 * Options:
 *   --fix        Apply fixes automatically
 *   --dry-run    Show what would be changed (default)
 *   --verbose    Show detailed output
 *   --json       Output as JSON
 *
 * Created by: Protocol 01 / Volta Team
 * License: MIT
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load the database
const DATABASE_PATH = path.join(__dirname, 'edition2024-database.json');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function loadDatabase() {
  try {
    const data = fs.readFileSync(DATABASE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    // Embedded fallback database
    return {
      crates: {
        'constant_time_eq': { maxCompatible: '0.3.1' },
        'base64ct': { maxCompatible: '1.6.0' },
        'subtle': { maxCompatible: '2.5.0' },
        'zeroize': { maxCompatible: '1.7.0' },
        'crypto-common': { maxCompatible: '0.1.6' },
        'blake3': { maxCompatible: '1.5.0' },
        'digest': { maxCompatible: '0.10.7' },
        'cipher': { maxCompatible: '0.4.4' },
        'aead': { maxCompatible: '0.5.2' },
        'signature': { maxCompatible: '2.2.0' },
        'wit-bindgen': { maxCompatible: '0.24.0' },
        'yoke': { maxCompatible: '0.7.4' },
      }
    };
  }
}

function parseCargoLock(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return null;
  }

  const content = fs.readFileSync(lockPath, 'utf8');
  const packages = [];

  // Match package blocks
  const packageRegex = /\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g;
  let match;

  while ((match = packageRegex.exec(content)) !== null) {
    packages.push({
      name: match[1],
      version: match[2]
    });
  }

  return packages;
}

function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(s => parseInt(s, 10) || 0);
  const parts2 = v2.split('.').map(s => parseInt(s, 10) || 0);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

function findProblematicDeps(packages, database) {
  const issues = [];

  for (const pkg of packages) {
    const crateInfo = database.crates[pkg.name];
    if (crateInfo) {
      const comparison = compareVersions(pkg.version, crateInfo.maxCompatible);
      if (comparison > 0) {
        issues.push({
          name: pkg.name,
          currentVersion: pkg.version,
          maxCompatible: crateInfo.maxCompatible,
          reason: crateInfo.reason || 'Requires edition 2024',
          usedBy: crateInfo.usedBy || []
        });
      }
    }
  }

  return issues;
}

function generateCargoUpdateCommands(issues) {
  return issues.map(issue =>
    `cargo update -p ${issue.name} --precise ${issue.maxCompatible}`
  );
}

function generatePatchSection(issues) {
  const lines = ['[patch.crates-io]'];
  for (const issue of issues) {
    lines.push(`${issue.name} = "=${issue.maxCompatible}"`);
  }
  return lines.join('\n');
}

function generateCargoConfig() {
  return `# Cargo configuration for Solana/Anchor compatibility
# Place this in .cargo/config.toml

[resolver]
# MSRV-aware resolver - prefer versions compatible with rust-version
incompatible-rust-versions = "fallback"

[net]
git-fetch-with-cli = true

[registries.crates-io]
protocol = "sparse"
`;
}

function checkCargoToml(projectPath) {
  const cargoTomlPath = path.join(projectPath, 'Cargo.toml');
  if (!fs.existsSync(cargoTomlPath)) {
    return { exists: false };
  }

  const content = fs.readFileSync(cargoTomlPath, 'utf8');
  return {
    exists: true,
    hasRustVersion: content.includes('rust-version'),
    hasPatchSection: content.includes('[patch.crates-io]'),
    content
  };
}

function applyFixes(projectPath, issues, options = {}) {
  const results = {
    updated: [],
    failed: [],
    skipped: []
  };

  log('\nApplying fixes...', 'cyan');

  // Run cargo update commands
  for (const issue of issues) {
    const cmd = `cargo update -p ${issue.name} --precise ${issue.maxCompatible}`;
    log(`  Running: ${cmd}`, 'yellow');

    try {
      execSync(cmd, {
        cwd: projectPath,
        stdio: options.verbose ? 'inherit' : 'pipe'
      });
      results.updated.push(issue.name);
      log(`  ✓ ${issue.name} → ${issue.maxCompatible}`, 'green');
    } catch (err) {
      // Check if the crate is not in the dependency tree
      if (err.message && err.message.includes('not found')) {
        results.skipped.push(issue.name);
        log(`  - ${issue.name} (not in dependency tree)`, 'yellow');
      } else {
        results.failed.push({ name: issue.name, error: err.message });
        log(`  ✗ ${issue.name}: ${err.message}`, 'red');
      }
    }
  }

  return results;
}

function printBanner() {
  console.log('');
  log('╔══════════════════════════════════════════════════════════════════╗', 'cyan');
  log('║                                                                  ║', 'cyan');
  log('║   Solana Edition 2024 Fixer                                      ║', 'cyan');
  log('║   Fix Rust edition 2024 compatibility for Solana/Anchor         ║', 'cyan');
  log('║                                                                  ║', 'cyan');
  log('║   Created by Protocol 01 / Volta Team                           ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════════════╝', 'cyan');
  console.log('');
}

function printHelp() {
  console.log(`
Usage: solana-edition-fixer [options] [project-path]

Options:
  --fix        Apply fixes automatically
  --dry-run    Show what would be changed (default)
  --verbose    Show detailed output
  --json       Output as JSON
  --help       Show this help message

Examples:
  solana-edition-fixer                    # Check current directory
  solana-edition-fixer ./my-project       # Check specific project
  solana-edition-fixer --fix              # Apply fixes
  solana-edition-fixer --fix --verbose    # Apply fixes with detailed output
`);
}

function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const options = {
    fix: args.includes('--fix'),
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
    json: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h')
  };

  // Get project path (first non-flag argument)
  const projectPath = args.find(arg => !arg.startsWith('--')) || '.';

  if (options.help) {
    printBanner();
    printHelp();
    return;
  }

  if (!options.json) {
    printBanner();
  }

  // Load database
  const database = loadDatabase();

  // Check if project exists
  const cargoLockPath = path.join(projectPath, 'Cargo.lock');
  const cargoTomlPath = path.join(projectPath, 'Cargo.toml');

  if (!fs.existsSync(cargoTomlPath)) {
    log(`Error: No Cargo.toml found in ${path.resolve(projectPath)}`, 'red');
    process.exit(1);
  }

  log(`Analyzing project: ${path.resolve(projectPath)}`, 'blue');
  console.log('');

  // Check Cargo.toml configuration
  const cargoTomlInfo = checkCargoToml(projectPath);

  if (!cargoTomlInfo.hasRustVersion) {
    log('⚠ Warning: No rust-version specified in Cargo.toml', 'yellow');
    log('  Add: rust-version = "1.75" to your [package] section', 'yellow');
    console.log('');
  }

  // Parse Cargo.lock
  const packages = parseCargoLock(cargoLockPath);

  if (!packages) {
    log('⚠ No Cargo.lock found. Run `cargo generate-lockfile` first.', 'yellow');

    if (options.fix) {
      log('  Generating Cargo.lock...', 'cyan');
      try {
        execSync('cargo generate-lockfile', { cwd: projectPath, stdio: 'inherit' });
        return main(); // Retry
      } catch (err) {
        log('  Failed to generate Cargo.lock', 'red');
        process.exit(1);
      }
    }
    process.exit(1);
  }

  log(`Found ${packages.length} packages in Cargo.lock`, 'blue');
  console.log('');

  // Find problematic dependencies
  const issues = findProblematicDeps(packages, database);

  if (options.json) {
    console.log(JSON.stringify({
      projectPath: path.resolve(projectPath),
      totalPackages: packages.length,
      issues,
      commands: generateCargoUpdateCommands(issues)
    }, null, 2));
    return;
  }

  if (issues.length === 0) {
    log('═══════════════════════════════════════════════════════════════════', 'green');
    log('✓ No edition 2024 compatibility issues found!', 'green');
    log('═══════════════════════════════════════════════════════════════════', 'green');
    return;
  }

  log(`Found ${issues.length} problematic dependencies:`, 'yellow');
  console.log('');

  for (const issue of issues) {
    log(`  ⚠ ${issue.name}`, 'yellow');
    log(`    Current: ${issue.currentVersion}`, 'red');
    log(`    Max compatible: ${issue.maxCompatible}`, 'green');
    if (issue.reason) {
      log(`    Reason: ${issue.reason}`, 'blue');
    }
    console.log('');
  }

  if (options.fix) {
    // Apply fixes
    const results = applyFixes(projectPath, issues, options);

    console.log('');
    log('═══════════════════════════════════════════════════════════════════', 'cyan');
    log('Results:', 'cyan');
    log(`  Updated: ${results.updated.length}`, 'green');
    log(`  Skipped: ${results.skipped.length}`, 'yellow');
    log(`  Failed:  ${results.failed.length}`, 'red');
    log('═══════════════════════════════════════════════════════════════════', 'cyan');

    if (results.failed.length > 0) {
      console.log('');
      log('Some dependencies could not be updated automatically.', 'yellow');
      log('Try adding a [patch.crates-io] section to your Cargo.toml:', 'yellow');
      console.log('');
      console.log(generatePatchSection(results.failed.map(f =>
        issues.find(i => i.name === f.name)
      ).filter(Boolean)));
    }
  } else {
    // Show fix commands
    console.log('');
    log('═══════════════════════════════════════════════════════════════════', 'cyan');
    log('To fix these issues, run:', 'cyan');
    log('═══════════════════════════════════════════════════════════════════', 'cyan');
    console.log('');

    log('Option 1: Run cargo update commands', 'blue');
    console.log('');
    for (const cmd of generateCargoUpdateCommands(issues)) {
      console.log(`  ${cmd}`);
    }

    console.log('');
    log('Option 2: Add to Cargo.toml [patch.crates-io]', 'blue');
    console.log('');
    console.log(generatePatchSection(issues));

    console.log('');
    log('Option 3: Enable MSRV-aware resolver', 'blue');
    console.log('');
    console.log(generateCargoConfig());

    console.log('');
    log('Or run with --fix to apply changes automatically:', 'green');
    log('  solana-edition-fixer --fix', 'green');
  }
}

// Export for use as module
module.exports = {
  loadDatabase,
  parseCargoLock,
  findProblematicDeps,
  generateCargoUpdateCommands,
  generatePatchSection,
  applyFixes
};

// Run if executed directly
if (require.main === module) {
  main();
}
