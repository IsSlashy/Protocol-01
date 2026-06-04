const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

// Force absolute path to avoid junction/symlink __dirname issues on Windows
const projectRoot = path.resolve(__dirname);
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Explicitly set project root for monorepo
config.projectRoot = projectRoot;

// Monorepo setup - watch the workspace root but only resolve from project
config.watchFolders = [workspaceRoot];

// Exclude Rust target/, .git, and other non-JS directories from Metro's resolver
// Prevents crashes from transient temp files in cargo build artifacts
config.resolver.blockList = [
  /[/\\]target[/\\]/,
  /[/\\]\.git[/\\]/,
  /[/\\]\.anchor[/\\]/,
  /[/\\]wasm-out[/\\]/,
  /[/\\]arcium-review[/\\]/,
];

// Also exclude from the file watcher to prevent EACCES crashes on Rust target dirs
config.watcher = {
  ...config.watcher,
  additionalExclusions: [
    /[/\\]target[/\\]/,
    /[/\\]\.git[/\\]/,
    /[/\\]\.anchor[/\\]/,
    /[/\\]wasm-out[/\\]/,
    /[/\\]arcium-review[/\\]/,
  ],
};
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Disallow packages outside of the project root from being resolved
config.resolver.disableHierarchicalLookup = true;

// Prioritize browser field in package.json for jose and other browser-compatible packages
config.resolver.resolverMainFields = ['browser', 'main', 'module'];

// Find @noble/hashes base path for subpath resolution
let nobleHashesPath;
try {
  nobleHashesPath = path.dirname(require.resolve('@noble/hashes/package.json', { paths: [projectRoot, workspaceRoot] }));
} catch (e) {
  nobleHashesPath = path.join(projectRoot, 'node_modules/@noble/hashes');
}

// Find @scure/bip39 base path
let scureBip39Path;
try {
  scureBip39Path = path.dirname(require.resolve('@scure/bip39/package.json', { paths: [projectRoot, workspaceRoot] }));
} catch (e) {
  scureBip39Path = path.join(projectRoot, 'node_modules/@scure/bip39');
}

// Add Node.js polyfills for crypto libraries
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('readable-stream'),
  crypto: path.resolve(projectRoot, 'polyfills/crypto-shim.js'),
  buffer: require.resolve('buffer'),
  // Shims for @coral-xyz/anchor (Node core modules unavailable in RN)
  path: path.resolve(projectRoot, 'polyfills/empty.js'),
  fs: path.resolve(projectRoot, 'polyfills/empty.js'),
  os: path.resolve(projectRoot, 'polyfills/empty.js'),
  // Map @noble/hashes subpaths directly to ESM files
  '@noble/hashes/sha256': path.join(nobleHashesPath, 'esm/sha256.js'),
  '@noble/hashes/sha3': path.join(nobleHashesPath, 'esm/sha3.js'),
  '@noble/hashes/ripemd160': path.join(nobleHashesPath, 'esm/ripemd160.js'),
  '@noble/hashes/utils': path.join(nobleHashesPath, 'esm/utils.js'),
  '@noble/hashes/hmac': path.join(nobleHashesPath, 'esm/hmac.js'),
  '@noble/hashes/pbkdf2': path.join(nobleHashesPath, 'esm/pbkdf2.js'),
  '@noble/hashes/hkdf': path.join(nobleHashesPath, 'esm/hkdf.js'),
  '@noble/hashes/sha512': path.join(nobleHashesPath, 'esm/sha512.js'),
  // Map @scure/bip39 subpaths
  '@scure/bip39/wordlists/english': path.join(scureBip39Path, 'esm/wordlists/english.js'),
};

// Find jose browser base path.
// Optional: jose was only ever pulled in transitively by @privy-io/react-auth.
// With Privy removed (spec §3 Phase 1) jose is no longer in the tree, so guard
// the resolve like the @noble/@scure blocks above — an unguarded require.resolve
// here throws MODULE_NOT_FOUND and Metro's config loader masks it as a bogus
// "ERR_UNSUPPORTED_ESM_URL_SCHEME" on Windows. Re-shims automatically if jose returns.
let joseBrowserDir = null;
try {
  const joseBasePath = path.dirname(require.resolve('jose/package.json', { paths: [projectRoot] }));
  joseBrowserDir = path.join(joseBasePath, 'dist', 'browser');
} catch (e) {
  joseBrowserDir = null;
}

// Helper to find a file in node_modules directories
const fs = require('fs');
function findInNodeModules(subpath, nodeModulesPaths, originModulePath) {
  // First try the configured paths
  for (const nmPath of nodeModulesPaths) {
    const fullPath = path.join(nmPath, subpath);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // If origin is available, try to find node_modules relative to it
  if (originModulePath) {
    let dir = path.dirname(originModulePath);
    // Walk up the directory tree looking for node_modules
    for (let i = 0; i < 10; i++) {
      const nmPath = path.join(dir, 'node_modules', subpath);
      if (fs.existsSync(nmPath)) {
        return nmPath;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

// Custom resolver for native/Node shims (snarkjs etc.).
// (The former @privy-io zod resolver was removed with Privy — spec §3 Phase 1.)
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Shim snarkjs and its Node.js dependencies for React Native.
  // Mobile uses the remote Rust prover exclusively — snarkjs is never called.
  if (['snarkjs', 'readline', 'fastfile', 'circom_runtime', 'ejs'].includes(moduleName)) {
    return {
      filePath: path.resolve(projectRoot, 'polyfills/empty.js'),
      type: 'sourceFile',
    };
  }

  // Stub Node-only fs/promises and node:fs subpaths used by workspace
  // libraries that target Node (notably @protocol-01/stark-prover dist's
  // disk-based WASM loader). The runtime path uses the inlined base64 WASM
  // so these imports are dead-code at the call site, but Metro still has to
  // resolve them statically.
  if (moduleName === 'fs/promises' || moduleName === 'node:fs' || moduleName === 'node:fs/promises' || moduleName === 'node:path') {
    return {
      filePath: path.resolve(projectRoot, 'polyfills/empty.js'),
      type: 'sourceFile',
    };
  }

  // Handle ox/erc8010 polyfill (required by viem)
  if (moduleName === 'ox/erc8010') {
    return {
      filePath: path.resolve(projectRoot, 'polyfills/ox-erc8010.js'),
      type: 'sourceFile',
    };
  }

  // Hermes-compatible shims for @noble/curves modules that fail in React Native.
  // twistedEdwards() crashes because BigInt arithmetic produces wrong results
  // for generator validation (isEdValidXY) in Hermes, causing ed25519.CURVE = undefined.
  if (moduleName === '@noble/curves/ed25519') {
    return {
      filePath: path.resolve(projectRoot, 'polyfills/noble-ed25519-shim.js'),
      type: 'sourceFile',
    };
  }
  if (moduleName === '@noble/curves/abstract/edwards') {
    return {
      filePath: path.resolve(projectRoot, 'polyfills/noble-edwards-shim.js'),
      type: 'sourceFile',
    };
  }

  // Handle @noble/curves subpath exports (abstract/modular, abstract/montgomery, etc.)
  if (moduleName.startsWith('@noble/curves/')) {
    const subpath = moduleName.replace('@noble/curves/', '');
    const esmPath = findInNodeModules(`@noble/curves/esm/${subpath}.js`, config.resolver.nodeModulesPaths, context.originModulePath);
    if (esmPath) {
      return { filePath: esmPath, type: 'sourceFile' };
    }
    const regularPath = findInNodeModules(`@noble/curves/${subpath}.js`, config.resolver.nodeModulesPaths, context.originModulePath);
    if (regularPath) {
      return { filePath: regularPath, type: 'sourceFile' };
    }
  }

  // Handle @noble/hashes subpath exports (sha256, sha3, ripemd160, utils, etc.)
  if (moduleName.startsWith('@noble/hashes/')) {
    const subpath = moduleName.replace('@noble/hashes/', '');
    // Try ESM first, then regular
    const esmPath = findInNodeModules(`@noble/hashes/esm/${subpath}.js`, config.resolver.nodeModulesPaths, context.originModulePath);
    if (esmPath) {
      return { filePath: esmPath, type: 'sourceFile' };
    }
    const regularPath = findInNodeModules(`@noble/hashes/${subpath}.js`, config.resolver.nodeModulesPaths, context.originModulePath);
    if (regularPath) {
      return { filePath: regularPath, type: 'sourceFile' };
    }
  }

  // Handle @scure/bip39 subpath exports
  if (moduleName.startsWith('@scure/bip39/')) {
    const subpath = moduleName.replace('@scure/bip39/', '');
    const esmPath = findInNodeModules(`@scure/bip39/esm/${subpath}.js`, config.resolver.nodeModulesPaths, context.originModulePath);
    if (esmPath) {
      return { filePath: esmPath, type: 'sourceFile' };
    }
    const regularPath = findInNodeModules(`@scure/bip39/${subpath}.js`, config.resolver.nodeModulesPaths, context.originModulePath);
    if (regularPath) {
      return { filePath: regularPath, type: 'sourceFile' };
    }
  }

  // Force jose to use browser version (not Node.js version).
  // Only active when jose is present (joseBrowserDir resolved above).
  if (joseBrowserDir && moduleName === 'jose') {
    return {
      filePath: path.join(joseBrowserDir, 'index.js'),
      type: 'sourceFile',
    };
  }

  // Redirect any import coming FROM jose/dist/node to jose/dist/browser
  if (joseBrowserDir && context.originModulePath && context.originModulePath.includes('jose') &&
      context.originModulePath.includes(path.join('dist', 'node'))) {
    // Rewrite the origin path to browser version
    const browserOrigin = context.originModulePath
      .replace(/dist[\\\/]node[\\\/]esm/g, 'dist/browser')
      .replace(/dist[\\\/]node[\\\/]cjs/g, 'dist/browser');

    if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
      // Relative import - resolve from browser directory
      const resolvedPath = path.resolve(path.dirname(browserOrigin), moduleName);
      const withExt = resolvedPath.endsWith('.js') ? resolvedPath : resolvedPath + '.js';
      if (fs.existsSync(withExt)) {
        return {
          filePath: withExt,
          type: 'sourceFile',
        };
      }
    }
  }

  // Use default resolver for everything else
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Add asset extensions for ZK circuit files
config.resolver.assetExts = [
  ...config.resolver.assetExts,
  'wasm',
  'zkey',
];

module.exports = withNativeWind(config, { input: './global.css' });
