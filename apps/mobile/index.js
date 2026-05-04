// Privacy hardening — runtime console silencer (release builds only).
//
// babel-plugin-transform-remove-console strips console.* from OUR source at
// build time, but third-party libs (Reanimated, NativeWind, css-interop)
// ship pre-compiled JS that bypasses our babel config — their warnings would
// still leak to logcat on a release APK.
//
// This belt-and-braces no-op override runs FIRST, before any library code
// initializes, so even libs that internally call console.* hit a void
// function. Combined with the babel transform, an attacker tailing
// `adb logcat ReactNativeJS:V` on a compromised device sees absolutely
// nothing app-related.
//
// __DEV__ is `true` in Metro dev mode and `false` in release builds — Hermes
// inlines this constant so the if-block is dead-code-eliminated in dev.
if (!__DEV__) {
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  console.info = noop;
  console.debug = noop;
  console.trace = noop;
}

// Polyfills must be imported BEFORE anything else
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
global.Buffer = Buffer;
import './polyfills/buffer-layout-shim'; // Buffer read/write methods on Uint8Array (for buffer-layout)
import 'react-native-url-polyfill/auto';
import '@ethersproject/shims';

// Suppress noisy WebSocket errors from Solana RPC (intermittent on devnet)
import { LogBox } from 'react-native';
LogBox.ignoreLogs([
  'ws error: undefined',
  'unable to activate keep awake',
  'Unable to activate keep awake',
]);

// Now import expo-router
import 'expo-router/entry';
