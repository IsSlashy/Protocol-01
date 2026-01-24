// Polyfills must be imported BEFORE anything else
import 'react-native-get-random-values';
import { Buffer } from 'buffer';
global.Buffer = Buffer;
import 'react-native-url-polyfill/auto';
import '@ethersproject/shims';

// Now import expo-router
import 'expo-router/entry';
