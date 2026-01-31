// Monkey-patch CJS require() to resolve packages from pnpm store on Windows
// where symlinks can't be followed due to permission issues
const Module = require('module');
const nodePath = require('path');
const fs = require('fs');

const PNPM_STORE = nodePath.resolve('P:/p01/packages/zk-sdk/node_modules/.pnpm');

// Cache store entries
let _entries = null;
function getEntries() {
  if (!_entries) {
    try { _entries = fs.readdirSync(PNPM_STORE); } catch(e) { _entries = []; }
  }
  return _entries;
}

// Node built-in modules
const BUILTINS = new Set(Module.builtinModules || []);
// Also add common names without node: prefix
['fs','path','os','crypto','util','events','stream','http','https','net','tls','url',
 'zlib','assert','child_process','readline','tty','module','querystring','worker_threads',
 'async_hooks','perf_hooks','buffer','string_decoder','dns','dgram','cluster','vm','v8',
 'process','console','diagnostics_channel','inspector','timers','punycode','constants',
 'sys','domain'].forEach(m => BUILTINS.add(m));

function findPackageDir(packageName) {
  const entries = getEntries();
  const prefix = packageName.replace(/\//g, '+') + '@';
  const match = entries.find(e => e.startsWith(prefix));
  if (match) {
    const dir = nodePath.join(PNPM_STORE, match, 'node_modules', packageName);
    if (fs.existsSync(dir)) return dir;
  }

  // Scoped package alternate naming
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    const scopedPrefix = `${scope}+${name}@`;
    const scopedMatch = entries.find(e => e.startsWith(scopedPrefix));
    if (scopedMatch) {
      const dir = nodePath.join(PNPM_STORE, scopedMatch, 'node_modules', packageName);
      if (fs.existsSync(dir)) return dir;
    }
  }

  // Brute force
  for (const dir of entries) {
    const pkgDir = nodePath.join(PNPM_STORE, dir, 'node_modules', packageName);
    try {
      if (fs.existsSync(nodePath.join(pkgDir, 'package.json'))) return pkgDir;
    } catch(e) {}
  }

  return null;
}

function resolveSubpathExport(pkgDir, subpath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(nodePath.join(pkgDir, 'package.json'), 'utf8'));
    if (!pkg.exports) return null;

    const exportKey = './' + subpath;
    const exp = pkg.exports[exportKey];
    if (!exp) return null;

    // Handle different export formats
    let target;
    if (typeof exp === 'string') {
      target = exp;
    } else if (typeof exp === 'object') {
      // Prefer require for CJS context
      if (exp.require) {
        target = typeof exp.require === 'string' ? exp.require : (exp.require.default || Object.values(exp.require)[0]);
      } else if (exp.default) {
        target = typeof exp.default === 'string' ? exp.default : exp.default;
      } else if (exp.import) {
        target = typeof exp.import === 'string' ? exp.import : (exp.import.default || Object.values(exp.import)[0]);
      }
    }

    if (target) {
      const resolved = nodePath.join(pkgDir, target);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch(e) {}
  return null;
}

const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  try {
    return origResolveFilename.call(this, request, parent, isMain, options);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      // Skip node built-in modules
      if (request.startsWith('node:') || BUILTINS.has(request)) throw err;
      // Skip relative/absolute paths
      if (request.startsWith('.') || request.startsWith('/') || /^[A-Z]:/i.test(request)) throw err;

      // Parse package name and subpath
      let packageName, subpath;
      if (request.startsWith('@')) {
        const parts = request.split('/');
        packageName = parts.slice(0, 2).join('/');
        subpath = parts.slice(2).join('/');
      } else {
        const parts = request.split('/');
        packageName = parts[0];
        subpath = parts.slice(1).join('/');
      }

      const pkgDir = findPackageDir(packageName);
      if (pkgDir) {
        // First try subpath exports from package.json
        if (subpath) {
          const exportPath = resolveSubpathExport(pkgDir, subpath);
          if (exportPath) return exportPath;

          // Direct file resolution
          const directPath = nodePath.join(pkgDir, subpath);
          try {
            return origResolveFilename.call(this, directPath, parent, isMain, options);
          } catch(e) {}
        }

        // Resolve the package main entry
        try {
          return origResolveFilename.call(this, pkgDir, parent, isMain, options);
        } catch(e2) {
          // Read package.json and resolve main manually
          try {
            const pkg = JSON.parse(fs.readFileSync(nodePath.join(pkgDir, 'package.json'), 'utf8'));
            const main = pkg.main || pkg.module || 'index.js';
            const fullPath = nodePath.join(pkgDir, main);
            if (fs.existsSync(fullPath)) return fullPath;
          } catch(e3) {}
        }
      }
    }
    throw err;
  }
};
