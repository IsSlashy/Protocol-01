module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          jsxImportSource: 'nativewind',
          // Hermes does not support `import.meta`. Some workspace packages
          // (notably @protocol-01/stark-prover dist) emit `import.meta.url`
          // for WASM-loader URL resolution; this polyfill rewrites it at
          // bundle time to a Hermes-safe expression.
          unstable_transformImportMeta: true,
        },
      ],
      'nativewind/babel',
    ],
    plugins: [
      [
        'module-resolver',
        {
          root: ['.'],
          alias: {
            '@': '.',
          },
        },
      ],
      'react-native-reanimated/plugin',
    ],
  };
};
