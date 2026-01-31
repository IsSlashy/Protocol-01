/**
 * ZK Prover Provider - Lazy Loading Version
 *
 * Provides client-side ZK proof generation using a hidden WebView.
 * All cryptographic operations stay on the device - no backend needed.
 *
 * IMPORTANT: The WebView and circuits are NOT loaded at startup.
 * They only load when generateProof() is called for the first time.
 * This prevents ANR caused by the 19MB circuit file.
 */

import React, { createContext, useContext, useRef, useState, useCallback, ReactNode } from 'react';
import { View, StyleSheet, InteractionManager } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { getZkService } from '../services/zk';

// Circuit data - loaded on first use to avoid ANR at startup
let TRANSFER_WASM_BASE64: string | null = null;
let TRANSFER_ZKEY_BASE64: string | null = null;
let circuitLoadPromise: Promise<boolean> | null = null;

// Load circuit data only when first needed - uses InteractionManager to not block UI
async function loadCircuitData(): Promise<boolean> {
  if (TRANSFER_WASM_BASE64 && TRANSFER_ZKEY_BASE64) return true;
  if (circuitLoadPromise) return circuitLoadPromise;

  circuitLoadPromise = new Promise((resolve) => {
    // Wait for interactions to complete before loading heavy data
    InteractionManager.runAfterInteractions(async () => {
      try {
        // Dynamic import - only loads when this function is called
        const circuitModule = await import('../assets/circuits/circuitData');
        TRANSFER_WASM_BASE64 = circuitModule.TRANSFER_WASM_BASE64;
        TRANSFER_ZKEY_BASE64 = circuitModule.TRANSFER_ZKEY_BASE64;
        resolve(true);
      } catch (err) {
        console.error('[ZK Prover] Failed to load circuit data:', err);
        resolve(false);
      }
    });
  });

  return circuitLoadPromise;
}

// Groth16 proof type
interface Groth16Proof {
  pi_a: Uint8Array;
  pi_b: Uint8Array;
  pi_c: Uint8Array;
}

// Context type
interface ZkProverContextType {
  isReady: boolean;
  isCircuitLoaded: boolean;
  generateProof: (inputs: Record<string, string>) => Promise<Groth16Proof>;
  startProver: () => Promise<boolean>; // Explicitly start the prover
  error: string | null;
}

const ZkProverContext = createContext<ZkProverContextType | null>(null);

// Pending proof requests
const pendingRequests = new Map<string, {
  resolve: (proof: Groth16Proof) => void;
  reject: (error: Error) => void;
}>();

// WebView HTML with snarkjs
const PROVER_WEBVIEW_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.jsdelivr.net/npm/snarkjs@0.7.0/build/snarkjs.min.js"></script>
</head>
<body>
<script>
  let circuitWasm = null;
  let circuitZkey = null;
  let isReady = false;

  // Handle messages from React Native
  document.addEventListener('message', handleMessage);
  window.addEventListener('message', handleMessage);

  function handleMessage(event) {
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;

      if (data.type === 'loadCircuit') {
        loadCircuitFiles(data);
      } else if (data.type === 'prove') {
        generateProof(data);
      }
    } catch (e) {
      console.error('Message parse error:', e);
    }
  }

  async function loadCircuitFiles(data) {
    try {
      // Decode base64 circuit files
      const wasmBinary = Uint8Array.from(atob(data.wasm), c => c.charCodeAt(0));
      const zkeyBinary = Uint8Array.from(atob(data.zkey), c => c.charCodeAt(0));

      circuitWasm = wasmBinary;
      circuitZkey = zkeyBinary;

      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded',
        success: true
      }));
    } catch (error) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'circuitLoaded',
        success: false,
        error: error.message
      }));
    }
  }

  async function generateProof(data) {
    const { id, inputs } = data;

    try {
      if (!circuitWasm || !circuitZkey) {
        throw new Error('Circuit files not loaded');
      }

      const startTime = performance.now();

      // Parse JSON array inputs
      const parsedInputs = {};
      for (const [key, value] of Object.entries(inputs)) {
        if (typeof value === 'string' && value.startsWith('[')) {
          parsedInputs[key] = JSON.parse(value);
        } else {
          parsedInputs[key] = value;
        }
      }

      // Generate proof
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        parsedInputs,
        circuitWasm,
        circuitZkey
      );

      const duration = ((performance.now() - startTime) / 1000).toFixed(2);

      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'proof',
        id,
        proof,
        publicSignals
      }));

    } catch (error) {
      console.error('[WebView] Proof error:', error);
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'error',
        id,
        error: error.message || 'Proof generation failed'
      }));
    }
  }

  // Signal ready
  isReady = true;
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
</script>
<p style="color: #666; font-family: monospace;">ZK Prover Active</p>
</body>
</html>
`;

/**
 * Convert snarkjs proof to byte arrays
 * IMPORTANT: Solana's alt_bn128 precompile expects BIG-ENDIAN encoding
 */
function convertProof(snarkjsProof: any): Groth16Proof {
  // Convert a field element to 32 bytes in BIG-ENDIAN (MSB at index 0)
  const fieldToBytesBE = (value: bigint): Uint8Array => {
    const bytes = new Uint8Array(32);
    let temp = value;
    // Fill from the end (index 31) to the start (index 0)
    for (let i = 31; i >= 0; i--) {
      bytes[i] = Number(temp & BigInt(0xff));
      temp = temp >> BigInt(8);
    }
    return bytes;
  };

  // G1 point: [x, y] -> 64 bytes (big-endian x, big-endian y)
  const pointToBytes = (point: string[]): Uint8Array => {
    const bytes = new Uint8Array(64);
    const xBytes = fieldToBytesBE(BigInt(point[0]));
    const yBytes = fieldToBytesBE(BigInt(point[1]));
    bytes.set(xBytes, 0);
    bytes.set(yBytes, 32);
    return bytes;
  };

  // G2 point: [[x0, x1], [y0, y1]] -> 128 bytes
  // For alt_bn128, G2 uses Fp2 elements stored as (c1, c0) order
  const point2ToBytes = (point: string[][]): Uint8Array => {
    const bytes = new Uint8Array(128);
    // x = x0 + x1*i stored as [x1, x0] (c1 first, then c0)
    // y = y0 + y1*i stored as [y1, y0] (c1 first, then c0)
    const x1Bytes = fieldToBytesBE(BigInt(point[0][1]));
    const x0Bytes = fieldToBytesBE(BigInt(point[0][0]));
    const y1Bytes = fieldToBytesBE(BigInt(point[1][1]));
    const y0Bytes = fieldToBytesBE(BigInt(point[1][0]));
    bytes.set(x1Bytes, 0);
    bytes.set(x0Bytes, 32);
    bytes.set(y1Bytes, 64);
    bytes.set(y0Bytes, 96);
    return bytes;
  };

  return {
    pi_a: pointToBytes(snarkjsProof.pi_a.slice(0, 2)),
    pi_b: point2ToBytes(snarkjsProof.pi_b.slice(0, 2)),
    pi_c: pointToBytes(snarkjsProof.pi_c.slice(0, 2)),
  };
}

// Props
interface ZkProverProviderProps {
  children: ReactNode;
}

/**
 * ZK Prover Provider Component
 *
 * LAZY LOADING: The WebView is NOT rendered at startup.
 * It only renders when startProver() or generateProof() is called.
 */
export function ZkProverProvider({ children }: ZkProverProviderProps) {
  const webViewRef = useRef<WebView>(null);
  const [webViewEnabled, setWebViewEnabled] = useState(false); // Don't render WebView initially
  const [isReady, setIsReady] = useState(false);
  const [isCircuitLoaded, setIsCircuitLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use ref for circuit loaded state to avoid stale closure in callback
  const isCircuitLoadedRef = useRef(false);
  const webViewReadyRef = useRef(false);
  const webViewRefCurrent = useRef<WebView | null>(null);

  // Promise resolvers for initialization
  const webViewReadyPromise = useRef<{
    resolve: () => void;
    reject: (err: Error) => void;
  } | null>(null);

  // Handle WebView messages
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'ready') {
        webViewReadyRef.current = true;
        setIsReady(true);
        webViewReadyPromise.current?.resolve();
        return;
      }

      if (data.type === 'circuitLoaded') {
        isCircuitLoadedRef.current = data.success;
        setIsCircuitLoaded(data.success);
        if (!data.success && data.error) {
          setError(data.error);
        } else {
          setError(null);
          // Connect prover to ZK service
          const zkService = getZkService();
          zkService.setProver(generateProofViaWebView);
        }
        return;
      }

      if (data.type === 'proof') {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          pendingRequests.delete(data.id);
          const proof = convertProof(data.proof);
          pending.resolve(proof);
        }
        return;
      }

      if (data.type === 'error') {
        const pending = pendingRequests.get(data.id);
        if (pending) {
          pendingRequests.delete(data.id);
          pending.reject(new Error(data.error));
        }
        return;
      }
    } catch (err) {
      console.error('[ZK Prover] Message parse error:', err);
    }
  }, []);

  // Wait for WebView to be ready
  const waitForWebView = (): Promise<void> => {
    if (webViewReadyRef.current) return Promise.resolve();

    return new Promise((resolve, reject) => {
      webViewReadyPromise.current = { resolve, reject };
      // Timeout after 30 seconds
      setTimeout(() => {
        if (!webViewReadyRef.current) {
          reject(new Error('WebView initialization timed out'));
        }
      }, 30000);
    });
  };

  // Load circuit files into WebView
  const loadCircuitFiles = async () => {
    try {
      setError('Loading ZK circuits...');

      // Load the circuit data (uses InteractionManager internally)
      const loaded = await loadCircuitData();

      if (!loaded || !TRANSFER_WASM_BASE64 || !TRANSFER_ZKEY_BASE64) {
        console.error('[ZK Prover] Circuit data not available');
        setError('ZK circuits not bundled. Only shield available.');
        setIsCircuitLoaded(false);
        return false;
      }


      // Send to WebView
      const message = JSON.stringify({
        type: 'loadCircuit',
        wasm: TRANSFER_WASM_BASE64,
        zkey: TRANSFER_ZKEY_BASE64,
      });

      webViewRefCurrent.current?.injectJavaScript(`
        window.postMessage(${JSON.stringify(message)}, '*');
        true;
      `);

      setError(null);
      return true;
    } catch (err: any) {
      console.error('[ZK Prover] Failed to load circuit files:', err);
      setError(`Circuit error: ${err.message}. Only shield available.`);
      setIsCircuitLoaded(false);
      return false;
    }
  };

  // Start the prover (enables WebView and loads circuits)
  const startProver = useCallback(async (): Promise<boolean> => {

    // Enable WebView if not already
    if (!webViewEnabled) {
      setWebViewEnabled(true);
      // Wait a frame for React to render the WebView
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Wait for WebView to be ready
    try {
      await waitForWebView();
    } catch (err) {
      console.error('[ZK Prover] WebView failed to initialize:', err);
      setError('Failed to initialize ZK prover');
      return false;
    }

    // Load circuits if not already loaded
    if (!isCircuitLoadedRef.current) {
      const loaded = await loadCircuitFiles();
      // Wait for circuit loaded message
      await new Promise(resolve => setTimeout(resolve, 2000));
      return isCircuitLoadedRef.current;
    }

    return true;
  }, [webViewEnabled]);

  // Generate proof via WebView
  const generateProofViaWebView = useCallback(async (inputs: Record<string, string>): Promise<Groth16Proof> => {
    // Start prover if not already started
    const ready = await startProver();
    if (!ready) {
      throw new Error('Failed to initialize ZK prover. Please try again.');
    }

    if (!webViewRefCurrent.current) {
      throw new Error('WebView not available');
    }

    const id = Math.random().toString(36).substring(2);

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify({ type: 'prove', id, inputs });
      webViewRefCurrent.current?.injectJavaScript(`
        window.postMessage(${JSON.stringify(message)}, '*');
        true;
      `);

      // Timeout after 3 minutes
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Proof generation timed out'));
        }
      }, 180000);
    });
  }, [startProver]);

  // Context generateProof function
  const generateProof = useCallback(async (inputs: Record<string, string>): Promise<Groth16Proof> => {
    return generateProofViaWebView(inputs);
  }, [generateProofViaWebView]);

  const contextValue: ZkProverContextType = {
    isReady,
    isCircuitLoaded,
    generateProof,
    startProver,
    error,
  };

  return (
    <ZkProverContext.Provider value={contextValue}>
      {/* Hidden WebView for proof generation - only rendered when enabled */}
      {webViewEnabled && (
        <View style={styles.hiddenWebView}>
          <WebView
            ref={(ref) => {
              webViewRefCurrent.current = ref;
            }}
            source={{ html: PROVER_WEBVIEW_HTML }}
            onMessage={onMessage}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            originWhitelist={['*']}
            onError={(e) => {
              console.error('[ZK Prover] WebView error:', e.nativeEvent);
              setError('WebView error: ' + e.nativeEvent.description);
            }}
          />
        </View>
      )}
      {children}
    </ZkProverContext.Provider>
  );
}

/**
 * Hook to access the ZK Prover
 * Returns a mock context if provider is not available (for graceful degradation)
 */
let _zkProverWarnedOnce = false;
export function useZkProver(): ZkProverContextType {
  const context = useContext(ZkProverContext);
  if (!context) {
    // Return mock context instead of throwing - allows app to work without ZK features
    if (!_zkProverWarnedOnce) {
      _zkProverWarnedOnce = true;
    }
    return {
      isReady: false,
      isCircuitLoaded: false,
      generateProof: async () => {
        throw new Error('ZK Prover not available. Please restart the app to enable ZK features.');
      },
      startProver: async () => false,
      error: 'ZK Prover not initialized - circuits not loaded to save memory',
    };
  }
  return context;
}

const styles = StyleSheet.create({
  hiddenWebView: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
});
