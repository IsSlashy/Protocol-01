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
          // ⛔ RE-ENABLED 2026-08-27, WITH error AND warn EXCLUDED.
          //
          // It was commented out on 2026-05-08 as a diagnostic, so that [Sub:*]
          // logs would survive in a release-signed APK, above a note reading
          // "Revert before shipping any release intended for users". That note
          // was 3.5 months stale and the build it described shipped.
          //
          // What it cost: a builder put a per-proof timing line on the SHARED
          // proof funnel, and it reached production devices. It carried no
          // secret, and it was still a linkage — it timestamps "this handset
          // produced a circuit-7 spend proof at T", and v4 withdrawals on chain
          // around T are public. That is the payer<->note edge circuit 7 exists
          // to cut, rebuilt from a log line.
          //
          // MEASURED before choosing the shape, because "~2,900 calls" was a
          // figure repeated without checking. In app/ providers/ services/
          // utils/ components/ stores/ hooks/:
          //     console.log    372      stripped
          //     console.debug    3      stripped
          //     console.warn   201      KEPT
          //     console.error  216      KEPT
          //
          // So this is not "silence everything or nothing". The paths people
          // debug against are warn and error; the exposure is in log. Excluding
          // the two keeps every failure visible in logcat while removing the
          // 375 lines that narrate what the app is doing.
          //
          // ⚠️ [Sub:*] renewal logs ARE console.log and they go with this. If a
          // renewal investigation needs them again, exclude 'log' for that build
          // rather than deleting this line — and put it back afterwards, which
          // is what did not happen last time.
          ['transform-remove-console', { exclude: ['error', 'warn'] }],
        ],
      },
    },
  };
};
