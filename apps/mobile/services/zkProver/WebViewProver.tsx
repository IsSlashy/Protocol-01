/**
 * WebViewProver — Hidden WebView for client-side Groth16 proof generation.
 *
 * Runs snarkjs inside a 1x1 invisible WebView, providing an async API
 * for proof generation entirely on-device. Private inputs never leave the phone.
 *
 * Architecture:
 *   1. WebView loads a minimal HTML shell
 *   2. snarkjs source is injected via injectJavaScript (no CDN, fully offline)
 *   3. Circuit WASM + zkey are sent as base64 via postMessage
 *   4. Proof inputs sent via postMessage, proof returned via onMessage
 *   5. ~1-5s proof time on modern devices depending on circuit size
 *
 * This component is managed by the singleton ZkProverService (see ./index.ts).
 * It should be rendered once in the app's root layout and never unmounted.
 *
 * SECURITY: All proving happens on-device. Spending keys never leave the phone.
 */

import React, {
  useRef,
  useState,
  useCallback,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Messages sent FROM the WebView TO React Native */
export interface WebViewIncomingMessage {
  type:
    | 'ready'
    | 'snarkjsLoaded'
    | 'snarkjsError'
    | 'circuitLoaded'
    | 'circuitLoadFailed'
    | 'proof'
    | 'error'
    | 'log';
  id?: string;
  name?: string;
  success?: boolean;
  source?: string;
  error?: string;
  proof?: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  publicSignals?: string[];
  durationMs?: number;
  wasmSize?: number;
  zkeySize?: number;
  message?: string;
}

/** Imperative handle exposed to the parent (ZkProverService) */
export interface WebViewProverHandle {
  /** Inject the snarkjs library source code into the WebView */
  injectSnarkjs(source: string): void;
  /** Load a circuit from base64-encoded WASM and zkey */
  loadCircuit(name: string, wasmBase64: string, zkeyBase64: string): void;
  /** Request proof generation */
  requestProof(id: string, circuitName: string, inputs: Record<string, string>): void;
  /** Check if the WebView is mounted */
  isMounted(): boolean;
}

/** Props for the WebViewProver component */
interface WebViewProverProps {
  /** Called when a message is received from the WebView */
  onMessage: (msg: WebViewIncomingMessage) => void;
  /** Called when the WebView encounters a fatal error */
  onError?: (error: string) => void;
}

// ---------------------------------------------------------------------------
// Inline HTML shell
// ---------------------------------------------------------------------------

/**
 * Minimal HTML that sets up the message handling infrastructure.
 * snarkjs is injected later via injectJavaScript to avoid bundling
 * 700KB in a string literal and to support offline loading from
 * the device filesystem.
 */
const PROVER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; connect-src 'none';">
  <style>body{margin:0;padding:0;background:transparent;}</style>
</head>
<body>
<script>
(function() {
  'use strict';

  // ---- State ----
  var circuits = {};
  var snarkjsReady = false;

  // ---- Logging bridge ----
  function log(msg) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'log', message: String(msg)
      }));
    } catch(e) {}
  }

  // ---- Message handling ----
  function handleMessage(event) {
    var raw = event.data;
    var data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch(e) {
      log('Message parse error: ' + e.message);
      return;
    }

    switch (data.type) {
      case 'injectSnarkjs':
        injectSnarkjs(data.source);
        break;
      case 'loadCircuit':
        loadCircuitBase64(data);
        break;
      case 'prove':
        prove(data);
        break;
      default:
        log('Unknown message type: ' + data.type);
    }
  }

  document.addEventListener('message', handleMessage);
  window.addEventListener('message', handleMessage);

  // ---- snarkjs injection ----
  function injectSnarkjs(source) {
    try {
      // Create a script element and evaluate the snarkjs source
      var script = document.createElement('script');
      script.textContent = source;
      document.head.appendChild(script);

      if (typeof snarkjs !== 'undefined' && snarkjs.groth16) {
        snarkjsReady = true;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'snarkjsLoaded'
        }));
      } else {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'snarkjsError',
          error: 'snarkjs loaded but groth16 not found on global'
        }));
      }
    } catch(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'snarkjsError',
        error: 'Failed to inject snarkjs: ' + e.message
      }));
    }
  }

  // ---- Circuit loading (base64) ----
  function loadCircuitBase64(data) {
    var name = data.name || 'default';
    try {
      // Decode base64 to Uint8Array
      var wasmBinary = atob(data.wasm);
      var wasmBytes = new Uint8Array(wasmBinary.length);
      for (var i = 0; i < wasmBinary.length; i++) {
        wasmBytes[i] = wasmBinary.charCodeAt(i);
      }

      var zkeyBinary = atob(data.zkey);
      var zkeyBytes = new Uint8Array(zkeyBinary.length);
      for (var j = 0; j < zkeyBinary.length; j++) {
        zkeyBytes[j] = zkeyBinary.charCodeAt(j);
      }

      circuits[name] = { wasm: wasmBytes, zkey: zkeyBytes };

      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded',
        name: name,
        success: true,
        source: 'base64',
        wasmSize: wasmBytes.length,
        zkeySize: zkeyBytes.length
      }));
    } catch(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoadFailed',
        name: name,
        success: false,
        error: 'Base64 decode failed: ' + e.message
      }));
    }
  }

  // ---- Proof generation ----
  async function prove(data) {
    var id = data.id;
    var name = data.name || 'default';

    try {
      if (!snarkjsReady || typeof snarkjs === 'undefined') {
        throw new Error('snarkjs is not loaded');
      }

      var c = circuits[name];
      if (!c || !c.wasm || !c.zkey) {
        throw new Error('Circuit "' + name + '" is not loaded');
      }

      // Parse inputs: arrays encoded as JSON strings need to be parsed back
      var parsedInputs = {};
      for (var k in data.inputs) {
        if (data.inputs.hasOwnProperty(k)) {
          var v = data.inputs[k];
          if (typeof v === 'string') {
            // Try to parse as JSON array
            if (v.charAt(0) === '[') {
              try { parsedInputs[k] = JSON.parse(v); } catch(_) { parsedInputs[k] = v; }
            } else {
              parsedInputs[k] = v;
            }
          } else {
            parsedInputs[k] = v;
          }
        }
      }

      var startTime = performance.now();
      var result = await snarkjs.groth16.fullProve(parsedInputs, c.wasm, c.zkey);
      var elapsed = Math.round(performance.now() - startTime);

      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'proof',
        id: id,
        proof: result.proof,
        publicSignals: result.publicSignals,
        durationMs: elapsed
      }));
    } catch(e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'error',
        id: id,
        error: e.message || 'Proof generation failed'
      }));
    }
  }

  // ---- Signal readiness ----
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const WebViewProver = forwardRef<WebViewProverHandle, WebViewProverProps>(
  function WebViewProver({ onMessage, onError }, ref) {
    const webViewRef = useRef<WebView | null>(null);
    const [mounted, setMounted] = useState(false);

    // Track mount state
    useEffect(() => {
      setMounted(true);
      return () => { setMounted(false); };
    }, []);

    // Handle messages from WebView
    const handleMessage = useCallback(
      (event: WebViewMessageEvent) => {
        try {
          const data: WebViewIncomingMessage = JSON.parse(event.nativeEvent.data);
          onMessage(data);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown parse error';
          console.error('[WebViewProver] Failed to parse message:', message);
        }
      },
      [onMessage],
    );

    // Handle WebView errors
    const handleError = useCallback(
      (syntheticEvent: { nativeEvent: { description?: string } }) => {
        const description = syntheticEvent.nativeEvent.description ?? 'Unknown WebView error';
        console.error('[WebViewProver] WebView error:', description);
        onError?.(description);
      },
      [onError],
    );

    // Expose imperative API
    useImperativeHandle(ref, () => ({
      injectSnarkjs(source: string) {
        if (!webViewRef.current) return;
        // Escape the source for safe injection into a JSON string inside JS
        // We use a two-step approach: send as a message to avoid escaping issues
        // with the massive snarkjs source code
        const escaped = JSON.stringify(source);
        webViewRef.current.injectJavaScript(
          `window.postMessage(JSON.stringify({ type: 'injectSnarkjs', source: ${escaped} }), '*'); true;`,
        );
      },

      loadCircuit(name: string, wasmBase64: string, zkeyBase64: string) {
        if (!webViewRef.current) return;
        // For large payloads, we chunk the injection to avoid hitting
        // the injectJavaScript string size limit. However, postMessage
        // via injectJavaScript is the most reliable approach.
        //
        // We send the message as a window.postMessage call which the
        // WebView's message listener will pick up.
        const message = JSON.stringify({
          type: 'loadCircuit',
          name,
          wasm: wasmBase64,
          zkey: zkeyBase64,
        });
        // Split into a variable assignment to avoid inline string issues
        webViewRef.current.injectJavaScript(
          `(function() {
            var msg = ${JSON.stringify(message)};
            window.postMessage(msg, '*');
          })(); true;`,
        );
      },

      requestProof(id: string, circuitName: string, inputs: Record<string, string>) {
        if (!webViewRef.current) return;
        const message = JSON.stringify({
          type: 'prove',
          id,
          name: circuitName,
          inputs,
        });
        webViewRef.current.injectJavaScript(
          `window.postMessage(${JSON.stringify(message)}, '*'); true;`,
        );
      },

      isMounted() {
        return mounted && webViewRef.current !== null;
      },
    }), [mounted]);

    return (
      <View style={styles.hidden} pointerEvents="none">
        <WebView
          ref={webViewRef}
          source={{ html: PROVER_HTML }}
          onMessage={handleMessage}
          onError={handleError}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['file://']}
          // L12: allowFileAccess removed — circuit data is injected via postMessage (base64),
          // not loaded from file://. No file:// access needed for this WebView.
          // Performance settings
          cacheEnabled={false}
          incognito
          // Prevent user interaction
          scrollEnabled={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
      </View>
    );
  },
);

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
    // Move off-screen to ensure no visual artifacts
    left: -9999,
    top: -9999,
  },
});
