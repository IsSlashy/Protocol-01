// Custom ESM loader to resolve pnpm symlinked packages on Windows + Node 24
import { resolve as pathResolve, join, dirname } from 'node:path';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PNPM_STORE = 'P:\\p01\\packages\\zk-sdk\\node_modules\\.pnpm';
const DEBUG = !!process.env.LOADER_DEBUG;

function log(...args) {
  if (DEBUG) process.stderr.write('[loader] ' + args.join(' ') + '\n');
}

// Cache for resolved packages and directory entries
const resolveCache = new Map();
let _storeEntries = null;
function getStoreEntries() {
  if (!_storeEntries) {
    try {
      _storeEntries = readdirSync(PNPM_STORE);
    } catch(e) {
      log('ERROR reading store:', e.message);
      _storeEntries = [];
    }
  }
  return _storeEntries;
}

function findPackageInStore(packageName) {
  if (resolveCache.has(packageName)) return resolveCache.get(packageName);

  const entries = getStoreEntries();

  // Match package@version pattern
  const prefix = packageName.replace(/\//g, '+') + '@';
  const match = entries.find(e => e.startsWith(prefix));
  if (match) {
    const pkgPath = join(PNPM_STORE, match, 'node_modules', packageName);
    try {
      if (existsSync(pkgPath)) {
        resolveCache.set(packageName, pkgPath);
        return pkgPath;
      }
    } catch(e) {
      log('existsSync failed for', pkgPath, ':', e.message);
    }
  }

  // Check scoped packages with different naming
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    const scopedPrefix = `${scope}+${name}@`;
    const scopedMatch = entries.find(e => e.startsWith(scopedPrefix));
    if (scopedMatch) {
      const pkgPath = join(PNPM_STORE, scopedMatch, 'node_modules', packageName);
      try {
        if (existsSync(pkgPath)) {
          resolveCache.set(packageName, pkgPath);
          return pkgPath;
        }
      } catch(e) {}
    }
  }

  // Brute-force search: look in every .pnpm directory's node_modules
  for (const dir of entries) {
    const pkgPath = join(PNPM_STORE, dir, 'node_modules', packageName);
    try {
      const pkgJsonPath = join(pkgPath, 'package.json');
      if (existsSync(pkgJsonPath)) {
        // Make sure this is the real directory, not a symlink that will fail
        try {
          statSync(pkgJsonPath);
          resolveCache.set(packageName, pkgPath);
          return pkgPath;
        } catch(e) {
          // Try to follow the symlink manually
          try {
            const real = realpathSync(pkgPath);
            if (existsSync(join(real, 'package.json'))) {
              resolveCache.set(packageName, real);
              return real;
            }
          } catch(e2) {}
        }
      }
    } catch(e) {}
  }

  log('NOT FOUND:', packageName);
  return null;
}

function getPackageMain(pkgPath) {
  try {
    const pkgJson = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
    // ESM: check exports "." entry first
    if (pkgJson.exports) {
      const exp = pkgJson.exports;
      if (typeof exp === 'string') return join(pkgPath, exp);
      if (exp['.']) {
        const dot = exp['.'];
        if (typeof dot === 'string') return join(pkgPath, dot);
        // Handle {types, import, require, default} object
        if (typeof dot === 'object') {
          if (dot.import) {
            const importVal = typeof dot.import === 'string' ? dot.import : (dot.import.default || Object.values(dot.import)[0]);
            if (importVal) return join(pkgPath, importVal);
          }
          if (dot.default) return join(pkgPath, dot.default);
          if (dot.require) {
            const reqVal = typeof dot.require === 'string' ? dot.require : (dot.require.default || Object.values(dot.require)[0]);
            if (reqVal) return join(pkgPath, reqVal);
          }
        }
      }
      if (exp.import) {
        const importVal = typeof exp.import === 'string' ? exp.import : (exp.import.default || Object.values(exp.import)[0]);
        if (importVal) return join(pkgPath, importVal);
      }
      if (exp.default) return join(pkgPath, exp.default);
    }
    if (pkgJson.module) return join(pkgPath, pkgJson.module);
    if (pkgJson.main) return join(pkgPath, pkgJson.main);
    return join(pkgPath, 'index.js');
  } catch(e) {
    log('getPackageMain error for', pkgPath, ':', e.message);
    return join(pkgPath, 'index.js');
  }
}

function tryResolveFile(filePath) {
  const candidates = [
    filePath,
    filePath + '.js',
    filePath + '.mjs',
    filePath + '.cjs',
    filePath + '.ts',
    filePath + '.json',
    filePath + '.node',
    join(filePath, 'index.js'),
    join(filePath, 'index.mjs'),
    join(filePath, 'index.cjs'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch(e) {}
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  // Handle relative imports that might be missing file extensions
  if (specifier.startsWith('.') && context.parentURL) {
    try {
      const parentPath = fileURLToPath(context.parentURL);
      const parentDir = dirname(parentPath);
      const absPath = pathResolve(parentDir, specifier);

      // Only intervene if the exact path doesn't exist (missing extension)
      if (!existsSync(absPath) || statSync(absPath).isDirectory()) {
        const resolved = tryResolveFile(absPath);
        if (resolved) {
          return { shortCircuit: true, url: pathToFileURL(resolved).href };
        }
      }
    } catch(e) {
      // Try extension resolution on error too
      try {
        const parentPath = fileURLToPath(context.parentURL);
        const parentDir = dirname(parentPath);
        const absPath = pathResolve(parentDir, specifier);
        const resolved = tryResolveFile(absPath);
        if (resolved) {
          return { shortCircuit: true, url: pathToFileURL(resolved).href };
        }
      } catch(e2) {}
    }
  }

  // Handle bare specifiers (package names)
  if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:') && !specifier.startsWith('node:')) {
    let packageName = specifier;
    let subpath = '';
    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      packageName = parts.slice(0, 2).join('/');
      subpath = parts.slice(2).join('/');
    } else {
      const parts = specifier.split('/');
      packageName = parts[0];
      subpath = parts.slice(1).join('/');
    }

    const pkgPath = findPackageInStore(packageName);
    if (pkgPath) {
      let resolvedPath;
      if (subpath) {
        resolvedPath = tryResolveFile(join(pkgPath, subpath));
        // Also check package.json exports for subpath
        if (!resolvedPath) {
          try {
            const pkgJson = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
            if (pkgJson.exports && pkgJson.exports['./' + subpath]) {
              const exp = pkgJson.exports['./' + subpath];
              const target = typeof exp === 'string' ? exp
                : (typeof exp === 'object' ? (exp.import || exp.default || exp.require) : null);
              if (target) {
                const targetStr = typeof target === 'string' ? target : (target.default || Object.values(target)[0]);
                if (targetStr) resolvedPath = join(pkgPath, targetStr);
              }
            }
          } catch(e) {}
        }
      } else {
        resolvedPath = getPackageMain(pkgPath);
      }

      if (resolvedPath) {
        try {
          if (existsSync(resolvedPath)) {
            return { shortCircuit: true, url: pathToFileURL(resolvedPath).href };
          }
        } catch(e) {}
      }
    }
  }

  // Default resolution with fallback
  try {
    return nextResolve(specifier, context);
  } catch(err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL) {
      try {
        const parentPath = fileURLToPath(context.parentURL);
        const parentDir = dirname(parentPath);
        if (specifier.startsWith('.')) {
          const absPath = pathResolve(parentDir, specifier);
          const resolved = tryResolveFile(absPath);
          if (resolved) {
            return { shortCircuit: true, url: pathToFileURL(resolved).href };
          }
        }
      } catch(e) {}
    }
    throw err;
  }
}
