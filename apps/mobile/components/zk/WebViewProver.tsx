/**
 * WebViewProver — Hidden WebView component for client-side ZK proof generation.
 *
 * React Native's Hermes engine does not support WebAssembly, which snarkjs
 * requires. This component renders a 0x0 hidden WebView that loads a full
 * browser JS engine (V8/JSC on Android/iOS) with WASM support, then
 * communicates with the RN layer via postMessage / onMessage.
 *
 * This component is intentionally "dumb" — it owns the WebView ref and
 * message routing. All orchestration (circuit loading, queueing, timeouts)
 * lives in the webviewProver service.
 *
 * SECURITY: No private inputs ever leave the device. The WebView runs
 * locally with no network access beyond the initial snarkjs CDN fetch.
 */

import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

// Import the HTML source as a string constant. We use inline HTML rather
// than require() because Metro does not bundle .html files as loadable
// WebView sources. The canonical HTML lives in assets/prover.html for
// reference; this constant is the runtime copy.
import { PROVER_HTML } from './proverHtml';

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

/** Messages coming FROM the WebView */
export type WebViewProverMessage =
  | { type: 'ready' }
  | { type: 'snarkjsLoaded' }
  | { type: 'circuitLoaded'; success: boolean; source?: string; circuit: string; wasmSize?: number; zkeySize?: number; error?: string }
  | { type: 'circuitLoadFailed'; circuit: string; error: string }
  | { type: 'proof'; id: string; proof: any; publicSignals: string[]; durationMs: number }
  | { type: 'error'; id: string; error: string }
  | { type: 'pong'; snarkjsReady: boolean; loadedCircuits: string[] };

/** Callback to receive parsed messages from the WebView */
export type OnProverMessage = (message: WebViewProverMessage) => void;

/** Imperative handle exposed via ref */
export interface WebViewProverHandle {
  /** Send a JSON-serialisable message to the WebView */
  postMessage: (message: Record<string, unknown>) => void;
  /** Inject raw JavaScript into the WebView */
  injectJS: (js: string) => void;
  /** Whether the WebView DOM is mounted */
  isMounted: () => boolean;
}

interface WebViewProverProps {
  /** Called for every message the WebView sends back */
  onMessage: OnProverMessage;
  /** If false the WebView DOM is not rendered (saves memory on startup) */
  enabled?: boolean;
}

// -----------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------

export const WebViewProver = forwardRef<WebViewProverHandle, WebViewProverProps>(
  function WebViewProver({ onMessage, enabled = false }, ref) {
    const webViewRef = useRef<WebView | null>(null);
    const [mounted, setMounted] = useState(false);

    // Expose imperative methods to parent
    useImperativeHandle(ref, () => ({
      postMessage(message: Record<string, unknown>) {
        const json = JSON.stringify(message);
        // injectJavaScript is the reliable cross-platform way; postMessage
        // has inconsistencies between Android and iOS WebView implementations.
        webViewRef.current?.injectJavaScript(`
          window.postMessage(${JSON.stringify(json)}, '*');
          true;
        `);
      },
      injectJS(js: string) {
        webViewRef.current?.injectJavaScript(js + '\ntrue;');
      },
      isMounted() {
        return mounted && webViewRef.current != null;
      },
    }), [mounted]);

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      try {
        const data: WebViewProverMessage = JSON.parse(event.nativeEvent.data);
        onMessage(data);
      } catch (err) {
        console.error('[WebViewProver] Failed to parse message:', err);
      }
    }, [onMessage]);

    const handleLoadEnd = useCallback(() => {
      setMounted(true);
    }, []);

    const handleError = useCallback((e: any) => {
      console.error('[WebViewProver] WebView error:', e.nativeEvent?.description ?? e);
      onMessage({ type: 'error', id: 'webview_crash', error: 'WebView error: ' + (e.nativeEvent?.description ?? 'unknown') });
    }, [onMessage]);

    if (!enabled) return null;

    return (
      <View style={styles.hidden} pointerEvents="none">
        <WebView
          ref={webViewRef}
          source={{ html: PROVER_HTML, baseUrl: 'file:///android_asset/' }}
          onMessage={handleMessage}
          onLoadEnd={handleLoadEnd}
          onError={handleError}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          // Android: allow file:///android_asset/ access for APK-bundled circuits
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          // Disable user interaction — this is an invisible compute surface
          scrollEnabled={false}
          bounces={false}
          // Performance: single-process rendering
          androidLayerType="none"
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 0,
    height: 0,
    opacity: 0,
    overflow: 'hidden',
  },
});
