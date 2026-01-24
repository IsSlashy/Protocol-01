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

// Add Node.js polyfills for crypto libraries
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('readable-stream'),
  crypto: require.resolve('react-native-get-random-values'),
  buffer: require.resolve('buffer'),
};

// Add asset extensions for ZK circuit files
config.resolver.assetExts = [
  ...config.resolver.assetExts,
  'wasm',
  'zkey',
];

module.exports = withNativeWind(config, { input: './global.css' });
