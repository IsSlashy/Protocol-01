/**
 * ZKProver — Hidden WebView for client-side Groth16 proof generation.
 *
 * Runs snarkjs inside a 1x1 invisible WebView, providing a clean async API
 * for proof generation entirely on-device. Private inputs never leave the phone.
 *
 * Architecture:
 *   1. WebView loads snarkjs from CDN
 *   2. Circuit files loaded via XHR from app assets or injected as base64
 *   3. Proof inputs sent via postMessage, proof returned via onMessage
 *   4. ~1-3s proof time on modern devices
 */

import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  type ReactNode,
} from 'react';
import { View, StyleSheet } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import type { CircuitConfig, ProofResult, ProverOptions, ZKProverRef } from './types';

// ---------------------------------------------------------------------------
// WebView HTML — generic snarkjs prover
// ---------------------------------------------------------------------------

const PROVER_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<script>
  var circuits = {};

  document.addEventListener('message', handleMessage);
  window.addEventListener('message', handleMessage);

  function handleMessage(event) {
    try {
      var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (data.type === 'loadCircuit') loadCircuitFromBase64(data);
      else if (data.type === 'loadFromUri') loadCircuitFromUri(data);
      else if (data.type === 'prove') prove(data);
    } catch (e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'error', id: 'parse', error: 'Message parse error: ' + e.message
      }));
    }
  }

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
      xhr.onerror = function() { reject(new Error('XHR error for ' + url)); };
      xhr.send();
    });
  }

  async function loadCircuitFromBase64(data) {
    var name = data.name || 'default';
    try {
      var wasmBin = Uint8Array.from(atob(data.wasm), function(c) { return c.charCodeAt(0); });
      var zkeyBin = Uint8Array.from(atob(data.zkey), function(c) { return c.charCodeAt(0); });
      circuits[name] = { wasm: wasmBin, zkey: zkeyBin };
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded', success: true, source: 'base64', name: name,
        wasmSize: wasmBin.length, zkeySize: zkeyBin.length
      }));
    } catch (error) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded', success: false, name: name, error: error.message
      }));
    }
  }

  async function loadCircuitFromUri(data) {
    var name = data.name || 'default';
    try {
      var wasmBuf = await loadFileXHR(data.wasmUri);
      var zkeyBuf = await loadFileXHR(data.zkeyUri);
      circuits[name] = { wasm: new Uint8Array(wasmBuf), zkey: new Uint8Array(zkeyBuf) };
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded', success: true, source: 'uri', name: name,
        wasmSize: circuits[name].wasm.length, zkeySize: circuits[name].zkey.length
      }));
    } catch (error) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoadFailed', name: name, error: error.message
      }));
    }
  }

  async function prove(data) {
    var id = data.id;
    var name = data.name || 'default';
    try {
      var c = circuits[name];
      if (!c || !c.wasm || !c.zkey) throw new Error('Circuit "' + name + '" not loaded');
      if (typeof snarkjs === 'undefined') throw new Error('snarkjs not loaded');

      var start = performance.now();
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

  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));

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

interface ZKProverContextType {
  isReady: boolean;
  isProving: boolean;
  loadCircuit: (name: string, config: CircuitConfig) => Promise<boolean>;
  prove: (name: string, inputs: Record<string, string | string[]>, options?: ProverOptions) => Promise<ProofResult>;
  preload: (name: string) => Promise<boolean>;
  isLoaded: (name: string) => boolean;
  error: string | null;
}

const ProverContext = createContext<ZKProverContextType | null>(null);

const pendingRequests = new Map<
  string,
  { resolve: (r: ProofResult) => void; reject: (e: Error) => void }
>();

// ---------------------------------------------------------------------------
// Provider Component
// ---------------------------------------------------------------------------

interface ZKProverProviderProps {
  children: ReactNode;
  /** Base URL for WebView (default: 'file:///android_asset/') */
  baseUrl?: string;
  /** snarkjs CDN URL override */
  snarkjsCdnUrl?: string;
}

export function ZKProverProvider({ children, baseUrl = 'file:///android_asset/' }: ZKProverProviderProps) {
  const webViewRef = useRef<WebView | null>(null);
  const [webViewEnabled, setWebViewEnabled] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isProving, setIsProving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readyRef = useRef(false);
  const loadedCircuits = useRef<Record<string, boolean>>({});
  const uriLoadFailed = useRef<Record<string, boolean>>({});
  const readyPromise = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const circuitPromise = useRef<{ resolve: () => void } | null>(null);

  // Store circuit configs for fallback loading
  const circuitConfigs = useRef<Record<string, CircuitConfig>>({});

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
        return;
      }

      if (data.type === 'circuitLoaded') {
        const name = data.name || 'default';
        loadedCircuits.current[name] = data.success;
        if (data.success) setError(null);
        else setError(data.error || 'Failed to load circuit');
        circuitPromise.current?.resolve();
        return;
      }

      if (data.type === 'circuitLoadFailed') {
        const name = data.name || 'default';
        uriLoadFailed.current[name] = true;
        circuitPromise.current?.resolve();
        return;
      }

      if (data.type === 'proof') {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          pendingRequests.delete(data.id);
          setIsProving(false);
          pending.resolve({
            proof: data.proof,
            publicSignals: data.publicSignals,
            durationMs: data.durationMs,
          });
        }
        return;
      }

      if (data.type === 'error') {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          pendingRequests.delete(data.id);
          setIsProving(false);
          pending.reject(new Error(data.error));
        }
        return;
      }
    } catch (err: any) {
      console.error('[ZKProver] Message parse error:', err);
    }
  }, []);

  const waitForReady = (): Promise<void> => {
    if (readyRef.current) return Promise.resolve();
    return new Promise((resolve, reject) => {
      readyPromise.current = { resolve, reject };
      setTimeout(() => {
        if (!readyRef.current) reject(new Error('WebView init timed out (15s)'));
      }, 15000);
    });
  };

  const waitForCircuitMessage = (): Promise<void> => {
    return new Promise((resolve) => {
      circuitPromise.current = { resolve };
      setTimeout(() => resolve(), 15000);
    });
  };

  const loadCircuit = useCallback(async (name: string, config: CircuitConfig): Promise<boolean> => {
    try {
      circuitConfigs.current[name] = config;

      if (!webViewEnabled) {
        setWebViewEnabled(true);
        await new Promise((r) => setTimeout(r, 300));
      }

      await waitForReady();

      if (loadedCircuits.current[name]) return true;

      // Try loading from URI first (works with file:// on Android WebView)
      uriLoadFailed.current[name] = false;
      webViewRef.current?.injectJavaScript(`
        loadCircuitFromUri({
          name: '${name}',
          wasmUri: '${config.wasmUri}',
          zkeyUri: '${config.zkeyUri}'
        });
        true;
      `);

      await waitForCircuitMessage();
      return !!loadedCircuits.current[name];
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }, [webViewEnabled]);

  const preload = useCallback(async (name: string): Promise<boolean> => {
    const config = circuitConfigs.current[name];
    if (!config) return false;
    return loadCircuit(name, config);
  }, [loadCircuit]);

  const isLoaded = useCallback((name: string): boolean => {
    return !!loadedCircuits.current[name];
  }, []);

  const prove = useCallback(
    async (name: string, inputs: Record<string, string | string[]>, options?: ProverOptions): Promise<ProofResult> => {
      const ready = loadedCircuits.current[name];
      if (!ready) {
        const loaded = await preload(name);
        if (!loaded) throw new Error(`Circuit "${name}" not loaded. Call loadCircuit() first.`);
      }

      if (!webViewRef.current) throw new Error('WebView not available');

      setIsProving(true);
      const id = Math.random().toString(36).slice(2);
      const timeout = options?.timeout ?? 180_000;

      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });

        const serialized: Record<string, string> = {};
        for (const [k, v] of Object.entries(inputs)) {
          serialized[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
        }

        const message = JSON.stringify({ type: 'prove', id, inputs: serialized, name });
        webViewRef.current?.injectJavaScript(`
          window.postMessage(${JSON.stringify(message)}, '*');
          true;
        `);

        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            setIsProving(false);
            reject(new Error(`Proof generation timed out (${timeout / 1000}s)`));
          }
        }, timeout);
      });
    },
    [preload],
  );

  return (
    <ProverContext.Provider
      value={{ isReady, isProving, loadCircuit, prove, preload, isLoaded, error }}
    >
      {webViewEnabled && (
        <View style={styles.hidden}>
          <WebView
            ref={webViewRef}
            source={{ html: PROVER_HTML, baseUrl }}
            onMessage={onMessage}
            javaScriptEnabled
            domStorageEnabled
            originWhitelist={['*']}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            onError={(e: any) => {
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
// Ref-based component (alternative API)
// ---------------------------------------------------------------------------

export const ZKProver = forwardRef<ZKProverRef, { baseUrl?: string }>(
  function ZKProver({ baseUrl = 'file:///android_asset/' }: { baseUrl?: string }, ref: any) {
    const webViewRef = useRef<WebView | null>(null);
    const readyRef = useRef(false);
    const loadedCircuits = useRef<Record<string, boolean>>({});
    const circuitConfigs = useRef<Record<string, CircuitConfig>>({});
    const readyPromise = useRef<{ resolve: () => void } | null>(null);
    const circuitPromise = useRef<{ resolve: () => void } | null>(null);

    const waitForReady = (): Promise<void> => {
      if (readyRef.current) return Promise.resolve();
      return new Promise((resolve) => {
        readyPromise.current = { resolve };
        setTimeout(() => resolve(), 15000);
      });
    };

    const waitForCircuit = (): Promise<void> => {
      return new Promise((resolve) => {
        circuitPromise.current = { resolve };
        setTimeout(() => resolve(), 15000);
      });
    };

    const onMessage = useCallback((event: WebViewMessageEvent) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (data.type === 'ready') {
          readyRef.current = true;
          readyPromise.current?.resolve();
        } else if (data.type === 'circuitLoaded') {
          loadedCircuits.current[data.name || 'default'] = data.success;
          circuitPromise.current?.resolve();
        } else if (data.type === 'circuitLoadFailed') {
          circuitPromise.current?.resolve();
        } else if (data.type === 'proof') {
          const p = pendingRequests.get(data.id);
          if (p) {
            pendingRequests.delete(data.id);
            p.resolve({
              proof: data.proof,
              publicSignals: data.publicSignals,
              durationMs: data.durationMs,
            });
          }
        } else if (data.type === 'error') {
          const p = pendingRequests.get(data.id);
          if (p) {
            pendingRequests.delete(data.id);
            p.reject(new Error(data.error));
          }
        }
      } catch (e) {
        // Silently ignore parse errors in ref-based component
      }
    }, []);

    useImperativeHandle(ref, () => ({
      loadCircuit: async (name: string, config: CircuitConfig) => {
        circuitConfigs.current[name] = config;
        await waitForReady();
        if (loadedCircuits.current[name]) return true;
        webViewRef.current?.injectJavaScript(
          `loadCircuitFromUri({ name: '${name}', wasmUri: '${config.wasmUri}', zkeyUri: '${config.zkeyUri}' }); true;`
        );
        await waitForCircuit();
        return !!loadedCircuits.current[name];
      },
      prove: async (name: string, inputs: Record<string, string | string[]>, options?: ProverOptions) => {
        if (!loadedCircuits.current[name]) throw new Error(`Circuit "${name}" not loaded`);
        const id = Math.random().toString(36).slice(2);
        const timeout = options?.timeout ?? 180_000;
        return new Promise((resolve, reject) => {
          pendingRequests.set(id, { resolve, reject });
          const serialized: Record<string, string> = {};
          for (const [k, v] of Object.entries(inputs)) {
            serialized[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
          }
          webViewRef.current?.injectJavaScript(
            `window.postMessage(${JSON.stringify(JSON.stringify({ type: 'prove', id, inputs: serialized, name }))}, '*'); true;`
          );
          setTimeout(() => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id);
              reject(new Error('Proof timed out'));
            }
          }, timeout);
        });
      },
      preload: async (name: string) => !!loadedCircuits.current[name],
      isLoaded: (name: string) => !!loadedCircuits.current[name],
    }));

    return (
      <View style={styles.hidden}>
        <WebView
          ref={webViewRef}
          source={{ html: PROVER_HTML, baseUrl }}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
        />
      </View>
    );
  }
);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useZKProver(): ZKProverContextType {
  const ctx = useContext(ProverContext);
  if (!ctx) {
    throw new Error('useZKProver must be used within a <ZKProverProvider>');
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
