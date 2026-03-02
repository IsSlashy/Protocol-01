<div align="center">

# @p01/react-native-zk

**Built by [Protocol 01](https://github.com/IsSlashy/Protocol-01) — The Privacy Layer for Solana**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

Client-side Groth16 ZK proof generation for React Native apps using a hidden WebView. No backend required.

## The Problem

React Native does not support WebAssembly or the cryptographic primitives that snarkjs requires. Native modules like `react-native-rapidsnark` exist but require complex native build steps, platform-specific C++ toolchains, and often break across React Native versions.

## The Solution

Run snarkjs inside an invisible 1x1 WebView. The WebView has full browser capabilities (WASM, BigInt, SubtleCrypto), so snarkjs works out of the box. Private inputs are passed via `postMessage` and never leave the device. Proof results are returned via `onMessage`.

This approach gives you:
- Zero native code to maintain
- Works with Expo (managed and bare)
- Same snarkjs version as your web app
- ~1-3 second proof generation on modern phones

## Features

- **Two API styles** -- Context Provider (`useZKProver` hook) or Ref-based (`ZKProverRef`)
- **Multi-circuit support** -- Load and prove with multiple circuits simultaneously
- **Automatic circuit loading** -- Loads `.wasm` and `.zkey` from app assets or injected base64
- **Caching** -- Circuit files loaded once and cached in memory
- **Timeout handling** -- Configurable proof generation timeout (default 3 minutes)
- **APK injection tool** -- Python script for fast dev cycles without full EAS rebuilds
- **Expo + bare RN compatible** -- Works with both Expo Asset system and direct file access

## Installation

```bash
npm install @p01/react-native-zk react-native-webview
```

If using Expo:
```bash
npx expo install react-native-webview expo-asset expo-file-system
```

## Quick Start

### Option 1: Provider Pattern (Recommended)

Wrap your app or screen with `ZKProverProvider`, then use the `useZKProver` hook anywhere in the tree.

```tsx
import { ZKProverProvider, useZKProver } from '@p01/react-native-zk';

// In your app root or screen
function App() {
  return (
    <ZKProverProvider>
      <MyScreen />
    </ZKProverProvider>
  );
}

// In any child component
function MyScreen() {
  const { loadCircuit, prove, isReady, isProving } = useZKProver();

  const handleProve = async () => {
    // Load circuit (cached after first call)
    await loadCircuit('myCircuit', {
      wasmUri: 'my_circuit.wasm',
      zkeyUri: 'my_circuit_final.zkey',
    });

    // Generate proof
    const result = await prove('myCircuit', {
      secret: '123456789',
      nullifier: '987654321',
      pathElements: ['0', '1', '2', '3'],
      pathIndices: ['0', '1', '0', '1'],
    });

    console.log('Proof:', result.proof);
    console.log('Public signals:', result.publicSignals);
    console.log(`Generated in ${result.durationMs}ms`);
  };

  return <Button title="Prove" onPress={handleProve} disabled={isProving} />;
}
```

### Option 2: Ref Pattern

Use the `ZKProver` component directly with a ref, without needing a Provider.

```tsx
import { useRef } from 'react';
import { ZKProver, type ZKProverRef } from '@p01/react-native-zk';

function MyScreen() {
  const proverRef = useRef<ZKProverRef>(null);

  const handleProve = async () => {
    await proverRef.current?.loadCircuit('myCircuit', {
      wasmUri: 'my_circuit.wasm',
      zkeyUri: 'my_circuit_final.zkey',
    });

    const result = await proverRef.current?.prove('myCircuit', {
      secret: '123456789',
      nullifier: '987654321',
    });

    console.log('Proof:', result?.proof);
  };

  return (
    <>
      <Button title="Prove" onPress={handleProve} />
      <ZKProver ref={proverRef} />
    </>
  );
}
```

## Bundling Circuit Files

Circuit files (`.wasm` and `.zkey`) need to be accessible to the WebView. There are several approaches:

### Android: APK Assets

Place circuit files in your Android project's `android/app/src/main/assets/` directory. They will be accessible via `file:///android_asset/`.

```ts
await loadCircuit('myCircuit', {
  wasmUri: 'my_circuit.wasm',        // Loaded from android_asset/
  zkeyUri: 'my_circuit_final.zkey',
});
```

### Expo: Asset System

Register `.wasm` and `.zkey` in your `metro.config.js` asset extensions, then use the `CircuitLoader` helpers:

```js
// metro.config.js
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('wasm', 'zkey');
module.exports = config;
```

```ts
import { loadFromExpoAsset } from '@p01/react-native-zk';

const wasmModule = require('./assets/my_circuit.wasm');
const zkeyModule = require('./assets/my_circuit_final.zkey');

const { wasmBase64, zkeyBase64 } = await loadFromExpoAsset(wasmModule, zkeyModule);
```

### APK Injection (Fast Dev Cycle)

Use the included `inject-apk.py` tool to inject circuit files into an existing APK without rebuilding:

```bash
python tools/inject-apk.py \
  --apk base.apk \
  --dist ./dist \
  --circuit-dir ./circuits \
  --output patched.apk

zipalign -f -v 4 patched.apk aligned.apk
apksigner sign --ks ~/.android/debug.keystore aligned.apk
adb install -r aligned.apk
```

This reduces the deploy cycle from 30+ minutes (full EAS build) to 2-3 minutes.

## Performance

Proof generation times on real devices (Groth16, BN128 curve):

| Circuit Size | Device | Time |
|---|---|---|
| ~1,000 constraints | Mid-range Android | ~0.5s |
| ~5,000 constraints | Mid-range Android | ~1.5s |
| ~5,000 constraints | iPhone 13+ | ~1.0s |
| ~15,000 constraints | Mid-range Android | ~3.0s |
| ~15,000 constraints | iPhone 13+ | ~2.0s |
| ~50,000 constraints | Mid-range Android | ~8.0s |

Times include witness computation and proof generation. Circuit loading (first time) adds 1-3 seconds depending on file size.

## How It Works

```
React Native App
  |
  |  postMessage({ type: 'prove', inputs: {...} })
  v
+--------------------------------------------------+
| Hidden WebView (1x1px, opacity: 0)               |
|                                                   |
|   snarkjs (loaded from CDN)                       |
|   + circuit.wasm (witness generator)              |
|   + circuit.zkey (proving key)                    |
|                                                   |
|   1. Compute witness from inputs                  |
|   2. Generate Groth16 proof                       |
|   3. Return proof + public signals                |
+--------------------------------------------------+
  |
  |  onMessage({ type: 'proof', proof, publicSignals })
  v
React Native App
```

All private inputs stay on-device. The only network request is loading snarkjs from CDN (cached after first load).

## API Reference

### `<ZKProverProvider>`

Context provider that renders a hidden WebView and exposes proving functions.

**Props:**
| Prop | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | `'file:///android_asset/'` | Base URL for the WebView |
| `children` | `ReactNode` | required | Child components |

### `useZKProver()`

Hook that returns the prover context. Must be used within a `<ZKProverProvider>`.

**Returns:**
| Property | Type | Description |
|---|---|---|
| `isReady` | `boolean` | Whether the WebView and snarkjs are loaded |
| `isProving` | `boolean` | Whether a proof is currently being generated |
| `error` | `string \| null` | Last error message |
| `loadCircuit` | `(name, config) => Promise<boolean>` | Load a circuit by name |
| `prove` | `(name, inputs, options?) => Promise<ProofResult>` | Generate a proof |
| `preload` | `(name) => Promise<boolean>` | Preload a previously configured circuit |
| `isLoaded` | `(name) => boolean` | Check if a circuit is loaded |

### `<ZKProver>`

Ref-based component (alternative to Provider pattern).

**Ref methods (`ZKProverRef`):**
| Method | Type | Description |
|---|---|---|
| `loadCircuit` | `(name, config) => Promise<boolean>` | Load a circuit |
| `prove` | `(name, inputs, options?) => Promise<ProofResult>` | Generate a proof |
| `preload` | `(name) => Promise<boolean>` | Preload a circuit |
| `isLoaded` | `(name) => boolean` | Check if loaded |

### `CircuitConfig`

```ts
interface CircuitConfig {
  wasmUri: string;  // URI to .wasm file
  zkeyUri: string;  // URI to .zkey file
}
```

### `ProofResult`

```ts
interface ProofResult {
  proof: {
    pi_a: [string, string, string];
    pi_b: [[string, string], [string, string], [string, string]];
    pi_c: [string, string, string];
    protocol: string;
    curve: string;
  };
  publicSignals: string[];
  durationMs?: number;
}
```

### `ProverOptions`

```ts
interface ProverOptions {
  timeout?: number;                    // Default: 180000 (3 minutes)
  onProgress?: (step: string) => void; // Progress callback
}
```

### Circuit Loader Functions

```ts
// Load with caching (provide your own loader function)
loadCircuitAssets(name: string, loader: () => Promise<CircuitLoadResult>): Promise<CircuitLoadResult>

// Load from Expo Asset system
loadFromExpoAsset(wasmModule: number, zkeyModule: number): Promise<CircuitLoadResult>

// Load from Android APK assets
loadFromApkAssets(wasmPath: string, zkeyPath: string): Promise<CircuitLoadResult>

// Check cache
isCircuitCached(name: string): boolean

// Clear cache
clearCircuitCache(name?: string): void
```

## Troubleshooting

**"snarkjs not loaded"** -- The CDN request for snarkjs failed. Check internet connectivity. The WebView needs to fetch `https://cdn.jsdelivr.net/npm/snarkjs@0.7.0/build/snarkjs.min.js` once.

**"Circuit not loaded"** -- Call `loadCircuit()` before `prove()`. Check that your `.wasm` and `.zkey` files are accessible at the specified URIs.

**Proof timeout** -- Large circuits (50k+ constraints) may take longer than the default 3-minute timeout. Increase via `options.timeout`.

**Android file access** -- Ensure `allowFileAccess`, `allowFileAccessFromFileURLs`, and `allowUniversalAccessFromFileURLs` are enabled on the WebView (the library sets these by default).

## License

MIT

---

## Part of the Protocol 01 Ecosystem

This library is extracted from [Protocol 01](https://github.com/IsSlashy/Protocol-01), the privacy layer for Solana. P01 uses denominated privacy pools with client-side Groth16 proving to provide complete unlinkability on Solana.

| Library | Purpose |
|---------|---------|
| **@p01/react-native-zk** | Client-side ZK proving on mobile |
| **@p01/solana-verifier** | On-chain Groth16 verification |
| **@p01/privacy-toolkit** | Merkle trees, commitments, proof formatting |
| **@p01/zk-pipeline** | End-to-end guide: circuit -> mobile -> on-chain |

[Website](https://protocol-01.vercel.app) · [Twitter](https://twitter.com/Protocol01_) · [Discord](https://discord.gg/KfmhPFAHNH)
