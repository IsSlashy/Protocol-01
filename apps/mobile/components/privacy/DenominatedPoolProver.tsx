/**
 * Denominated Pool WebView Prover
 *
 * Hidden WebView that runs snarkjs in a browser environment for
 * client-side Groth16 proof generation.
 *
 * Supports TWO circuits:
 *   - "pool" (denominated_pool) — for shield/unshield operations
 *   - "transfer" (denominated_transfer) — for ZK→ZK transfers
 *
 * RULE #1: All proving happens on-device. No private inputs leave the phone.
 *
 * Architecture:
 *   1. WebView loads snarkjs from CDN
 *   2. Circuit files loaded directly from APK assets (file:///android_asset/)
 *   3. Proof inputs sent via postMessage, proof returned via onMessage
 *   4. ~1-3s proof time on modern phones
 *
 * Usage:
 *   Wrap a screen with <DenominatedPoolProverProvider>
 *   Call generateProof(inputs, 'pool') or generateProof(inputs, 'transfer')
 */

import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { View, StyleSheet } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitType = 'pool' | 'transfer';

export interface DenominatedPoolProof {
  proof: any; // snarkjs proof format (pi_a, pi_b, pi_c)
  publicSignals: string[];
}

interface DenominatedPoolProverContextType {
  isReady: boolean;
  isCircuitLoaded: boolean;
  isProving: boolean;
  generateProof: (inputs: Record<string, string | string[]>, circuit?: CircuitType) => Promise<DenominatedPoolProof>;
  preloadCircuit: (circuit?: CircuitType) => Promise<boolean>;
  error: string | null;
}

// ---------------------------------------------------------------------------
// WebView HTML — loads snarkjs + circuit files, generates proofs
// ---------------------------------------------------------------------------

const PROVER_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net file:; style-src 'unsafe-inline'; connect-src file:;">
</head>
<body>
<script>
  // Store circuits by type
  var circuits = {};

  document.addEventListener('message', handleMessage);
  window.addEventListener('message', handleMessage);

  function handleMessage(event) {
    try {
      var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data.type === 'loadCircuit') loadCircuitFromBase64(data);
      else if (data.type === 'loadFromAssets') loadCircuitFromAssets(data.circuit || 'pool');
      else if (data.type === 'prove') prove(data);
    } catch (e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'error', id: 'parse', error: 'Message parse error: ' + e.message
      }));
    }
  }

  // Load circuit from base64 data sent by React Native (fallback)
  async function loadCircuitFromBase64(data) {
    var ct = data.circuit || 'pool';
    try {
      var wasmBin = Uint8Array.from(atob(data.wasm), function(c) { return c.charCodeAt(0); });
      var zkeyBin = Uint8Array.from(atob(data.zkey), function(c) { return c.charCodeAt(0); });
      circuits[ct] = { wasm: wasmBin, zkey: zkeyBin };
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded', success: true, source: 'base64', circuit: ct,
        wasmSize: wasmBin.length, zkeySize: zkeyBin.length
      }));
    } catch (error) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded', success: false, circuit: ct, error: error.message
      }));
    }
  }

  // Load a file via XMLHttpRequest (works with file:// on Android WebView)
  function loadFileXHR(url) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function() {
        if (xhr.status === 0 || xhr.status === 200) {
          if (xhr.response && xhr.response.byteLength > 0) {
            resolve(xhr.response);
          } else {
            reject(new Error('Empty response for ' + url));
          }
        } else {
          reject(new Error('XHR failed: status ' + xhr.status + ' for ' + url));
        }
      };
      xhr.onerror = function() {
        reject(new Error('XHR error for ' + url));
      };
      xhr.send();
    });
  }

  // Asset file names by circuit type
  var ASSET_NAMES = {
    pool: { wasm: 'denominated_pool_circuit.wasm', zkey: 'denominated_pool_circuit.zkey' },
    transfer: { wasm: 'denominated_transfer_circuit.wasm', zkey: 'denominated_transfer_circuit.zkey' }
  };

  // Load circuit directly from APK assets via XHR
  async function loadCircuitFromAssets(ct) {
    try {
      var names = ASSET_NAMES[ct] || ASSET_NAMES.pool;
      var wasmBuf = await loadFileXHR(names.wasm);
      var zkeyBuf = await loadFileXHR(names.zkey);

      circuits[ct] = { wasm: new Uint8Array(wasmBuf), zkey: new Uint8Array(zkeyBuf) };

      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded', success: true, source: 'apk_assets', circuit: ct,
        wasmSize: circuits[ct].wasm.length, zkeySize: circuits[ct].zkey.length
      }));
    } catch (error) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoadFailed', circuit: ct, error: error.message
      }));
    }
  }

  async function prove(data) {
    var id = data.id;
    var ct = data.circuit || 'pool';
    try {
      var c = circuits[ct];
      if (!c || !c.wasm || !c.zkey) throw new Error('Circuit "' + ct + '" not loaded');
      if (typeof snarkjs === 'undefined') throw new Error('snarkjs not loaded');

      var start = performance.now();

      // Parse array inputs
      var parsed = {};
      for (var k in data.inputs) {
        var v = data.inputs[k];
        if (typeof v === 'string' && v.startsWith('[')) parsed[k] = JSON.parse(v);
        else parsed[k] = v;
      }

      var result = await snarkjs.groth16.fullProve(parsed, c.wasm, c.zkey);
      var ms = Math.round(performance.now() - start);

      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'proof', id: id,
        proof: result.proof,
        publicSignals: result.publicSignals,
        durationMs: ms
      }));
    } catch (error) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'error', id: id, error: error.message || 'Proof generation failed'
      }));
    }
  }

  // Send ready immediately
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));

  // Load snarkjs asynchronously
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/snarkjs@0.7.0/build/snarkjs.min.js';
  s.onload = function() {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'snarkjsLoaded' }));
  };
  s.onerror = function() {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'error', id: 'snarkjs', error: 'Failed to load snarkjs from CDN'
    }));
  };
  document.head.appendChild(s);
</script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ProverContext = createContext<DenominatedPoolProverContextType | null>(null);

// Pending proof requests
const pendingRequests = new Map<
  string,
  { resolve: (r: DenominatedPoolProof) => void; reject: (e: Error) => void }
>();

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function DenominatedPoolProverProvider({ children }: { children: ReactNode }) {
  const webViewRef = useRef<WebView | null>(null);
  const [webViewEnabled, setWebViewEnabled] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [circuitLoaded, setCircuitLoaded] = useState(false);
  const [isProving, setIsProving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readyRef = useRef(false);
  // Track loaded circuits by type
  const circuitLoadedMap = useRef<Record<string, boolean>>({});
  const assetLoadFailedMap = useRef<Record<string, boolean>>({});
  const readyPromise = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const circuitPromise = useRef<{ resolve: () => void } | null>(null);

  // ------------------------------------------------------------------
  // WebView message handler
  // ------------------------------------------------------------------

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'ready') {
        readyRef.current = true;
        setIsReady(true);
        readyPromise.current?.resolve();
        return;
      }

      if (data.type === 'snarkjsLoaded') {
        console.log('[DenomProver] snarkjs loaded from CDN');
        return;
      }

      if (data.type === 'circuitLoaded') {
        const ct = data.circuit || 'pool';
        circuitLoadedMap.current[ct] = data.success;
        if (ct === 'pool') setCircuitLoaded(data.success);
        if (data.success) {
          console.log(
            `[DenomProver] Circuit "${ct}" loaded (${data.source}): wasm=${(data.wasmSize / 1024).toFixed(0)}KB, zkey=${(data.zkeySize / 1024).toFixed(0)}KB`,
          );
          setError(null);
        } else {
          console.error(`[DenomProver] Circuit "${ct}" load failed:`, data.error);
          setError(data.error || 'Failed to load circuit');
        }
        circuitPromise.current?.resolve();
        return;
      }

      if (data.type === 'circuitLoadFailed') {
        const ct = data.circuit || 'pool';
        console.warn(`[DenomProver] WebView asset load failed (${ct}):`, data.error);
        assetLoadFailedMap.current[ct] = true;
        circuitPromise.current?.resolve();
        return;
      }

      if (data.type === 'proof') {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          pendingRequests.delete(data.id);
          console.log(`[DenomProver] Proof generated in ${data.durationMs}ms`);
          setIsProving(false);
          pending.resolve({ proof: data.proof, publicSignals: data.publicSignals });
        }
        return;
      }

      if (data.type === 'error') {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          pendingRequests.delete(data.id);
          setIsProving(false);
          pending.reject(new Error(data.error));
        } else {
          console.error('[DenomProver] WebView error:', data.error);
        }
        return;
      }
    } catch (err) {
      console.error('[DenomProver] Message parse error:', err);
    }
  }, []);

  // ------------------------------------------------------------------
  // Wait for WebView ready
  // ------------------------------------------------------------------

  const waitForReady = (): Promise<void> => {
    if (readyRef.current) return Promise.resolve();
    return new Promise((resolve, reject) => {
      readyPromise.current = { resolve, reject };
      setTimeout(() => {
        if (!readyRef.current) reject(new Error('WebView init timed out'));
      }, 15000);
    });
  };

  // ------------------------------------------------------------------
  // Wait for circuit loaded/failed message
  // ------------------------------------------------------------------

  const waitForCircuitMessage = (): Promise<void> => {
    return new Promise((resolve) => {
      circuitPromise.current = { resolve };
      setTimeout(() => resolve(), 15000);
    });
  };

  // ------------------------------------------------------------------
  // Public: preload circuit
  // ------------------------------------------------------------------

  const preloadCircuit = useCallback(async (circuit: CircuitType = 'pool'): Promise<boolean> => {
    try {
      // Enable WebView
      if (!webViewEnabled) {
        setWebViewEnabled(true);
        await new Promise((r) => setTimeout(r, 300));
      }

      await waitForReady();

      if (circuitLoadedMap.current[circuit]) return true;

      setError(`Loading ${circuit} circuit files...`);

      // Step 1: Tell WebView to try loading directly from APK assets
      console.log(`[DenomProver] Asking WebView to load ${circuit} circuit from APK assets...`);
      assetLoadFailedMap.current[circuit] = false;
      const step1Promise = waitForCircuitMessage();
      webViewRef.current?.injectJavaScript(`
        loadCircuitFromAssets('${circuit}');
        true;
      `);

      await step1Promise;

      if (circuitLoadedMap.current[circuit]) return true;

      // Step 2: Fallback — load via React Native and send base64
      if (assetLoadFailedMap.current[circuit]) {
        console.log(`[DenomProver] APK asset load failed for ${circuit}, trying Expo Asset fallback...`);
        const { loadCircuitAssets } = await import('../../services/denominatedPool/circuitLoader');
        const { wasmBase64, zkeyBase64 } = await loadCircuitAssets(circuit);
        console.log(`[DenomProver] Sending ${circuit} circuit via postMessage...`);

        // Set up wait BEFORE postMessage to avoid race condition where
        // WebView responds before waitForCircuitMessage creates the promise
        const loadPromise = waitForCircuitMessage();
        webViewRef.current?.postMessage(JSON.stringify({
          type: 'loadCircuit',
          circuit,
          wasm: wasmBase64,
          zkey: zkeyBase64,
        }));

        await loadPromise;
      }

      return !!circuitLoadedMap.current[circuit];
    } catch (err: any) {
      console.error(`[DenomProver] preloadCircuit(${circuit}) error:`, err.message);
      setError(err.message);
      return false;
    }
  }, [webViewEnabled]);

  // ------------------------------------------------------------------
  // Public: generate proof
  // ------------------------------------------------------------------

  const generateProof = useCallback(
    async (inputs: Record<string, string | string[]>, circuit: CircuitType = 'pool'): Promise<DenominatedPoolProof> => {
      // Ensure circuit is loaded
      const ready = await preloadCircuit(circuit);
      if (!ready) throw new Error(`Failed to load ${circuit} circuit. Ensure internet is available for snarkjs CDN.`);

      if (!webViewRef.current) throw new Error('WebView not available');

      setIsProving(true);
      const id = Math.random().toString(36).slice(2);

      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });

        // Serialize inputs
        const serialized: Record<string, string> = {};
        for (const [k, v] of Object.entries(inputs)) {
          serialized[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
        }

        const message = JSON.stringify({ type: 'prove', id, inputs: serialized, circuit });
        webViewRef.current?.injectJavaScript(`
          window.postMessage(${JSON.stringify(message)}, '*');
          true;
        `);

        // 3 minute timeout
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            setIsProving(false);
            reject(new Error('Proof generation timed out (3 min)'));
          }
        }, 180_000);
      });
    },
    [preloadCircuit],
  );

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <ProverContext.Provider
      value={{ isReady, isCircuitLoaded: circuitLoaded, isProving, generateProof, preloadCircuit, error }}
    >
      {webViewEnabled && (
        <View style={styles.hidden}>
          <WebView
            ref={webViewRef}
            source={{ html: PROVER_HTML, baseUrl: 'file:///android_asset/' }}
            onMessage={onMessage}
            javaScriptEnabled
            domStorageEnabled
            originWhitelist={['file://']}
            // L12: allowFileAccess is required here — the WebView loads circuit files from
            // file:///android_asset/ via baseUrl. Circuits are APK-bundled static assets.
            allowFileAccess
            onError={(e) => {
              console.error('[DenomProver] WebView error:', e.nativeEvent);
              setError('WebView error: ' + e.nativeEvent.description);
            }}
          />
        </View>
      )}
      {children}
    </ProverContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDenominatedPoolProver(): DenominatedPoolProverContextType {
  const ctx = useContext(ProverContext);
  if (!ctx) {
    return {
      isReady: false,
      isCircuitLoaded: false,
      isProving: false,
      generateProof: async () => {
        throw new Error('DenominatedPoolProverProvider not in component tree');
      },
      preloadCircuit: async () => false,
      error: 'Prover not initialized',
    };
  }
  return ctx;
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
});
