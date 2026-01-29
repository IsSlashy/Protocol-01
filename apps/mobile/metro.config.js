const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Explicitly set project root for monorepo
config.projectRoot = projectRoot;

// Monorepo setup - watch the workspace root but only resolve from project
config.watchFolders = [workspaceRoot];
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
  crypto: require.resolve('react-native-get-random-values'),
  buffer: require.resolve('buffer'),
  // Map @noble/hashes subpaths directly to ESM files
  '@noble/hashes/sha256': path.join(nobleHashesPath, 'esm/sha256.js'),
  '@noble/hashes/sha3': path.join(nobleHashesPath, 'esm/sha3.js'),
  '@noble/hashes/ripemd160': path.join(nobleHashesPath, 'esm/ripemd160.js'),
  '@noble/hashes/utils': path.join(nobleHashesPath, 'esm/utils.js'),
  '@noble/hashes/hmac': path.join(nobleHashesPath, 'esm/hmac.js'),
  '@noble/hashes/pbkdf2': path.join(nobleHashesPath, 'esm/pbkdf2.js'),
  '@noble/hashes/hkdf': path.join(nobleHashesPath, 'esm/hkdf.js'),
  // Map @scure/bip39 subpaths
  '@scure/bip39/wordlists/english': path.join(scureBip39Path, 'esm/wordlists/english.js'),
};

// Find jose browser base path
const joseBasePath = path.dirname(require.resolve('jose/package.json', { paths: [projectRoot] }));
const joseBrowserDir = path.join(joseBasePath, 'dist', 'browser');

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

// Custom resolver for Privy SDK dependencies
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Handle ox/erc8010 polyfill (required by viem)
  if (moduleName === 'ox/erc8010') {
    return {
      filePath: path.resolve(projectRoot, 'polyfills/ox-erc8010.js'),
      type: 'sourceFile',
    };
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

  // Force jose to use browser version (not Node.js version)
  if (moduleName === 'jose') {
    return {
      filePath: path.join(joseBrowserDir, 'index.js'),
      type: 'sourceFile',
    };
  }

  // Redirect any import coming FROM jose/dist/node to jose/dist/browser
  if (context.originModulePath && context.originModulePath.includes('jose') &&
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
