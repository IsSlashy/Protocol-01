/**
 * ZK Prover Provider
 *
 * Provides client-side ZK proof generation using a hidden WebView.
 * All cryptographic operations stay on the device - no backend needed.
 *
 * Shield operations work without proofs.
 * Transfer/unshield require circuit files to be bundled.
 */

import React, { createContext, useContext, useRef, useState, useCallback, useEffect, ReactNode } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
// Use legacy API - readAsStringAsync is deprecated in SDK 54
import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import { getZkService } from '../services/zk';
// Pre-generated base64 circuit data (avoids asset loading issues)
import { TRANSFER_WASM_BASE64, TRANSFER_ZKEY_BASE64 } from '../assets/circuits/circuitData';

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

      console.log('[WebView] Starting proof generation...');
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
      console.log('[WebView] Proof generated in ' + duration + 's');

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
 */
export function ZkProverProvider({ children }: ZkProverProviderProps) {
  const webViewRef = useRef<WebView>(null);
  const [isReady, setIsReady] = useState(false);
  const [isCircuitLoaded, setIsCircuitLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use ref for circuit loaded state to avoid stale closure in callback
  const isCircuitLoadedRef = useRef(false);

  // Handle WebView messages
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'ready') {
        console.log('[ZK Prover] WebView ready');
        setIsReady(true);
        // Try to load circuit files
        loadCircuitFiles();
        return;
      }

      if (data.type === 'circuitLoaded') {
        console.log('[ZK Prover] Circuit loaded:', data.success);
        isCircuitLoadedRef.current = data.success;
        setIsCircuitLoaded(data.success);
        if (!data.success && data.error) {
          setError(data.error);
        } else {
          setError(null);
          // Connect prover to ZK service
          const zkService = getZkService();
          zkService.setProver(generateProofViaWebView);
          console.log('[ZK Prover] Connected to ZK service');
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

  // Load circuit files from pre-generated base64 data
  const loadCircuitFiles = async () => {
    try {
      console.log('[ZK Prover] Loading circuit files from embedded data...');
      setError('Loading ZK circuits...');

      // Use pre-generated base64 data (avoids React Native asset loading issues)
      if (!TRANSFER_WASM_BASE64 || !TRANSFER_ZKEY_BASE64) {
        console.error('[ZK Prover] Circuit data not available');
        setError('ZK circuits not bundled. Only shield available.');
        setIsCircuitLoaded(false);
        return;
      }

      console.log('[ZK Prover] Using embedded circuit data...');
      console.log(`[ZK Prover] WASM size: ${(TRANSFER_WASM_BASE64.length * 0.75 / 1024 / 1024).toFixed(2)} MB`);
      console.log(`[ZK Prover] ZKEY size: ${(TRANSFER_ZKEY_BASE64.length * 0.75 / 1024 / 1024).toFixed(2)} MB`);

      // Send to WebView
      const message = JSON.stringify({
        type: 'loadCircuit',
        wasm: TRANSFER_WASM_BASE64,
        zkey: TRANSFER_ZKEY_BASE64,
      });

      console.log('[ZK Prover] Sending circuits to WebView...');
      webViewRef.current?.injectJavaScript(`
        window.postMessage(${JSON.stringify(message)}, '*');
        true;
      `);

      setError(null);
    } catch (err: any) {
      console.error('[ZK Prover] Failed to load circuit files:', err);
      setError(`Circuit error: ${err.message}. Only shield available.`);
      setIsCircuitLoaded(false);
    }
  };

  // Generate proof via WebView
  const generateProofViaWebView = useCallback(async (inputs: Record<string, string>): Promise<Groth16Proof> => {
    if (!webViewRef.current) {
      throw new Error('WebView not available');
    }

    // Use ref to avoid stale closure issue
    if (!isCircuitLoadedRef.current) {
      throw new Error('Circuit files not loaded. Only shield operations are available.');
    }

    const id = Math.random().toString(36).substring(2);

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify({ type: 'prove', id, inputs });
      webViewRef.current?.injectJavaScript(`
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
  }, []); // No dependencies - uses refs for mutable state

  // Context generateProof function
  const generateProof = useCallback(async (inputs: Record<string, string>): Promise<Groth16Proof> => {
    if (!isReady) {
      throw new Error('ZK Prover not ready');
    }
    return generateProofViaWebView(inputs);
  }, [isReady, generateProofViaWebView]);

  const contextValue: ZkProverContextType = {
    isReady,
    isCircuitLoaded,
    generateProof,
    error,
  };

  return (
    <ZkProverContext.Provider value={contextValue}>
      {/* Hidden WebView for proof generation */}
      <View style={styles.hiddenWebView}>
        <WebView
          ref={webViewRef}
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
      {children}
    </ZkProverContext.Provider>
  );
}

/**
 * Hook to access the ZK Prover
 */
export function useZkProver(): ZkProverContextType {
  const context = useContext(ZkProverContext);
  if (!context) {
    throw new Error('useZkProver must be used within a ZkProverProvider');
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
