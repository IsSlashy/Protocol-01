// Polyfills must be imported BEFORE anything else
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
global.Buffer = Buffer;
import './polyfills/buffer-layout-shim'; // Buffer read/write methods on Uint8Array (for buffer-layout)
import 'react-native-url-polyfill/auto';
import '@ethersproject/shims';

// Suppress noisy WebSocket errors from Solana RPC (intermittent on devnet)
import { LogBox } from 'react-native';
LogBox.ignoreLogs(['ws error: undefined']);

// Now import expo-router
import 'expo-router/entry';
