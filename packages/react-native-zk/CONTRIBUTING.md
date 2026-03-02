# Contributing to @p01/react-native-zk

Thank you for your interest in contributing! This library enables client-side ZK proof generation in React Native apps.

## Development Setup

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```

2. Build TypeScript:
   ```bash
   npm run build
   ```

3. Testing requires a React Native environment (emulator or device). The library uses a hidden WebView, which cannot be unit tested in a pure Node.js context.

## Project Structure

```
src/
  index.ts          # Public exports
  types.ts          # TypeScript interfaces
  ZKProver.tsx      # WebView prover component (Provider + Ref APIs)
  CircuitLoader.ts  # Circuit asset loading utilities
tools/
  inject-apk.py    # APK injection for fast development cycles
example/
  App.tsx           # Minimal example app
```

## Guidelines

- Keep the library generic. Do not add application-specific logic.
- All ZK proving must happen on-device inside the WebView. No private inputs should be sent to any server.
- Maintain both the Provider (context) API and the Ref-based API.
- Test on both Android and iOS when possible.
- Keep the snarkjs CDN version pinned to a known-good release (currently 0.7.0).

## Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes
4. Ensure TypeScript compiles without errors (`npm run build`)
5. Open a Pull Request with a clear description

## Reporting Issues

When reporting bugs, please include:
- Device model and OS version
- React Native version
- Circuit size (number of constraints, wasm/zkey file sizes)
- Error messages from the WebView (check `onMessage` logs)
- Whether the issue occurs on Android, iOS, or both
