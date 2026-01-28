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

// Add Node.js polyfills for crypto libraries
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('readable-stream'),
  crypto: require.resolve('react-native-get-random-values'),
  buffer: require.resolve('buffer'),
};

// Find jose browser base path
const joseBasePath = path.dirname(require.resolve('jose/package.json', { paths: [projectRoot] }));
const joseBrowserDir = path.join(joseBasePath, 'dist', 'browser');

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
    try {
      const resolved = require.resolve(`@noble/hashes/esm/${subpath}.js`, { paths: [projectRoot, workspaceRoot] });
      return { filePath: resolved, type: 'sourceFile' };
    } catch (e) {
      try {
        const resolved = require.resolve(`@noble/hashes/${subpath}.js`, { paths: [projectRoot, workspaceRoot] });
        return { filePath: resolved, type: 'sourceFile' };
      } catch (e2) {
        // Fallback to default resolution
      }
    }
  }

  // Handle @scure/bip39 subpath exports
  if (moduleName.startsWith('@scure/bip39/')) {
    const subpath = moduleName.replace('@scure/bip39/', '');
    try {
      const resolved = require.resolve(`@scure/bip39/esm/${subpath}.js`, { paths: [projectRoot, workspaceRoot] });
      return { filePath: resolved, type: 'sourceFile' };
    } catch (e) {
      try {
        const resolved = require.resolve(`@scure/bip39/${subpath}.js`, { paths: [projectRoot, workspaceRoot] });
        return { filePath: resolved, type: 'sourceFile' };
      } catch (e2) {
        // Fallback to default resolution
      }
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
      try {
        require.resolve(withExt);
        return {
          filePath: withExt,
          type: 'sourceFile',
        };
      } catch (e) {
        // Fallback
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
