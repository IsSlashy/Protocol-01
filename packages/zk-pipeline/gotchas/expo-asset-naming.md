# Gotcha: Expo Asset Hash-Based Naming

**Time lost discovering this: ~3 hours**

## The Problem

When you bundle assets with Expo (via Metro), the files get renamed to
hash-based names. For example:

```
assets/circuits/my_circuit.wasm
-> asset_abc123def456.wasm  (in the APK)
```

The Expo Asset system knows the mapping, but if you inject a new JS bundle
via APK injection (without rebuilding the native app), the Asset registry
is stale and can't find the files.

## The Symptom

- `Asset.fromModule(require('./circuit.wasm')).downloadAsync()` fails
- The file exists in the APK but with a different name
- Works fine with a full native build, breaks with APK injection

## The Fix

### Option 1: Dual loading strategy (recommended)

Try Expo Asset first, fall back to direct file:// access:

```typescript
try {
  // Try Expo Asset (works with native builds)
  result = await loadViaExpoAsset();
} catch {
  // Fall back to direct APK asset (works with injection)
  result = await loadFromApkAssets('my_circuit.wasm', 'my_circuit_final.zkey');
}
```

### Option 2: Inject with predictable names

When injecting circuits into the APK, use predictable names:

```python
# In inject-apk.py
new_zip.writestr('assets/my_circuit.wasm', wasm_data)
new_zip.writestr('assets/my_circuit_final.zkey', zkey_data)
```

Then load via XHR in the WebView:

```javascript
// Inside the hidden WebView
var response = await fetch('my_circuit.wasm');  // relative to baseUrl
```

The `@p01/react-native-zk` package handles both strategies automatically.
