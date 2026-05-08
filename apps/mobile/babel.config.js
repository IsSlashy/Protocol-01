module.exports = function (api) {
  // Cache the compiled config per BABEL_ENV — without keying on env, the
  // dev bundle and prod bundle would share a cache and the env-conditional
  // plugins (transform-remove-console) would not re-evaluate.
  api.cache.using(() => process.env.BABEL_ENV || process.env.NODE_ENV);
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
    // Production-only: strip ALL console.* calls from the bundle so that
    // adb logcat on a release APK reveals nothing about app internals.
    // This closes the device-side leak L8 in the privacy hardening plan —
    // an attacker with physical adb access can no longer harvest secrets,
    // proof bytes, stealth signers, or recovery flow breadcrumbs by tailing
    // ReactNativeJS logs.
    //
    // We strip log/warn/error/info/debug/trace alike. Crash reporting (if
    // ever wired) must go through a non-console channel (Sentry SDK direct
    // call, etc.). Dev builds keep all logs intact via api.cache(true)
    // separating production / development bundles.
    env: {
      production: {
        plugins: [
          // TEMP — diagnostic build for sub-renewal investigation 2026-05-08.
          // transform-remove-console is disabled so that [Sub:*] structured
          // logs survive in a release-signed standalone APK. Revert before
          // shipping any release intended for users.
          // ['transform-remove-console', { exclude: [] }],
        ],
      },
    },
  };
};
