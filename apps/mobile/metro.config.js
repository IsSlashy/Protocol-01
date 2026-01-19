const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Add Node.js polyfills for crypto libraries
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  stream: require.resolve('readable-stream'),
  crypto: require.resolve('react-native-get-random-values'),
  buffer: require.resolve('buffer'),
};

module.exports = withNativeWind(config, { input: './global.css' });
