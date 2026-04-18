/**
 * ZK Prover Provider — Lazy Loading Version (v2)
 *
 * Provides client-side ZK proof generation using a hidden WebView.
 * All cryptographic operations stay on the device — no backend needed.
 *
 * IMPORTANT: The WebView and circuits are NOT loaded at startup.
 * They only load when generateProof() or startProver() is called
 * for the first time. This prevents ANR caused by the 19MB circuit file.
 *
 * Architecture (v2):
 *   ZkProverProvider (this file)
 *     └─ <WebViewProver />          — components/zk/WebViewProver.tsx
 *     └─ webviewProverService       — services/zk/webviewProver.ts
 *     └─ circuit loading            — assets/circuits/circuitData.ts (transfer)
 *                                   — services/denominatedPool/circuitLoader.ts (pool, denominated_transfer)
 *
 * The provider wires the WebView component to the service singleton, then
 * connects the service to ZkService so all existing code paths automatically
 * use local proving.
 */

import React, { createContext, useContext, useRef, useState, useCallback, useEffect, type ReactNode } from 'react';
import { InteractionManager } from 'react-native';
import { WebViewProver, type WebViewProverHandle, type WebViewProverMessage } from '../components/zk/WebViewProver';
import {
  webviewProverService,
  convertSnarkjsProofToBytes,
  type CircuitName,
  type Groth16Proof,
} from '../services/zk/webviewProver';

// -----------------------------------------------------------------------
// Lazy circuit data loading (transfer circuit — 19MB base64)
// -----------------------------------------------------------------------

let TRANSFER_WASM_BASE64: string | null = null;
let TRANSFER_ZKEY_BASE64: string | null = null;
let circuitLoadPromise: Promise<boolean> | null = null;

async function loadTransferCircuitData(): Promise<boolean> {
  if (TRANSFER_WASM_BASE64 && TRANSFER_ZKEY_BASE64) return true;
  if (circuitLoadPromise) return circuitLoadPromise;

  circuitLoadPromise = new Promise((resolve) => {
    InteractionManager.runAfterInteractions(async () => {
      try {
        const circuitModule = await import('../assets/circuits/circuitData');
        TRANSFER_WASM_BASE64 = circuitModule.TRANSFER_WASM_BASE64;
        TRANSFER_ZKEY_BASE64 = circuitModule.TRANSFER_ZKEY_BASE64;
        resolve(true);
      } catch (err) {
        console.error('[ZkProver] Failed to load transfer circuit data:', err);
        resolve(false);
      }
    });
  });

  return circuitLoadPromise;
}

// -----------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------

interface ZkProverContextType {
  /** WebView is mounted and snarkjs is loaded */
  isReady: boolean;
  /** At least the transfer circuit is loaded */
  isCircuitLoaded: boolean;
  /** Generate a Groth16 proof (byte-array format for Solana) */
  generateProof: (inputs: Record<string, string>) => Promise<Groth16Proof>;
  /** Generate a raw snarkjs-format proof (string arrays for relayer) */
  generateRawProof: (inputs: Record<string, string>) => Promise<{
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
    publicSignals: string[];
  }>;
  /** Explicitly start the prover (enables WebView, loads snarkjs + circuits) */
  startProver: () => Promise<boolean>;
  /** Load an additional circuit by name */
  loadCircuit: (circuit: CircuitName) => Promise<boolean>;
  /** Human-readable error, or null */
  error: string | null;
}

const ZkProverContext = createContext<ZkProverContextType | null>(null);

// -----------------------------------------------------------------------
// Provider
// -----------------------------------------------------------------------

interface ZkProverProviderProps {
  children: ReactNode;
}

export function ZkProverProvider({ children }: ZkProverProviderProps) {
  const webViewRef = useRef<WebViewProverHandle>(null);
  const [webViewEnabled, setWebViewEnabled] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isCircuitLoaded, setIsCircuitLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs to avoid stale closures
  const isCircuitLoadedRef = useRef(false);
  const startedRef = useRef(false);

  // ------------------------------------------------------------------
  // WebView message handler — delegates to service
  // ------------------------------------------------------------------

  const onProverMessage = useCallback((msg: WebViewProverMessage) => {
    webviewProverService.handleMessage(msg);

    // Mirror key state into React state for consumers
    if (msg.type === 'snarkjsLoaded') {
      setIsReady(webviewProverService.isReady);
    }

    if (msg.type === 'circuitLoaded' && msg.success && msg.circuit === 'transfer') {
      isCircuitLoadedRef.current = true;
      setIsCircuitLoaded(true);
      setError(null);
      // Note: transfer/shield/unshield are STARK-proven through StarkProverProvider.
      // This Groth16 WebView is retained only for subscribe-private + vault-detail.
    }

    if (msg.type === 'circuitLoaded' && !msg.success) {
      setError(msg.error ?? 'Circuit load failed');
    }

    if (msg.type === 'error' && msg.id === 'snarkjs_load') {
      setError('Failed to load snarkjs. Check internet connection.');
    }
  }, []);

  // ------------------------------------------------------------------
  // Attach / detach the WebView handle to the service
  // ------------------------------------------------------------------

  useEffect(() => {
    if (webViewRef.current) {
      webviewProverService.attachWebView(webViewRef.current);
    }
    return () => {
      webviewProverService.detachWebView();
    };
  }, [webViewEnabled]);

  // Re-attach whenever the ref changes (WebView mount/unmount cycles)
  const handleRefChange = useCallback((handle: WebViewProverHandle | null) => {
    (webViewRef as React.MutableRefObject<WebViewProverHandle | null>).current = handle;
    if (handle) {
      webviewProverService.attachWebView(handle);
    }
  }, []);

  // ------------------------------------------------------------------
  // Load transfer circuit into the WebView
  // ------------------------------------------------------------------

  const loadTransferCircuit = useCallback(async (): Promise<boolean> => {
    if (isCircuitLoadedRef.current) return true;

    setError('Loading ZK circuits...');

    // Strategy 1: Try loading from APK assets (fast, no JS bridge overhead)
    try {
      const assetResult = await webviewProverService.loadCircuitFromAssets('transfer');
      if (assetResult) return true;
    } catch {
      console.log('[ZkProver] APK asset loading not available, falling back to base64');
    }

    // Strategy 2: Load circuit data as base64 and send to WebView
    const loaded = await loadTransferCircuitData();
    if (!loaded || !TRANSFER_WASM_BASE64 || !TRANSFER_ZKEY_BASE64) {
      setError('ZK circuits not bundled. Only shield operations available.');
      return false;
    }

    try {
      const result = await webviewProverService.loadCircuit(
        'transfer',
        TRANSFER_WASM_BASE64,
        TRANSFER_ZKEY_BASE64,
      );
      if (!result) {
        setError('Failed to load circuit into WebView');
      }
      return result;
    } catch (err: any) {
      setError(`Circuit load error: ${err.message}`);
      return false;
    }
  }, []);

  // ------------------------------------------------------------------
  // Public: startProver — enables WebView + loads circuits
  // ------------------------------------------------------------------

  const startProver = useCallback(async (): Promise<boolean> => {
    if (startedRef.current && isCircuitLoadedRef.current) return true;
    startedRef.current = true;

    // 1. Enable WebView rendering
    if (!webViewEnabled) {
      setWebViewEnabled(true);
      // Wait for React to render the WebView and for it to mount
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 2. Wait for WebView + snarkjs
    try {
      await webviewProverService.waitForReady();
      setIsReady(true);
    } catch (err: any) {
      console.error('[ZkProver] WebView failed to initialize:', err);
      setError('Failed to initialize ZK prover: ' + err.message);
      return false;
    }

    // 3. Load the transfer circuit
    return loadTransferCircuit();
  }, [webViewEnabled, loadTransferCircuit]);

  // ------------------------------------------------------------------
  // Public: loadCircuit — load additional circuits (pool, denominated_transfer)
  // ------------------------------------------------------------------

  const loadCircuit = useCallback(async (circuit: CircuitName): Promise<boolean> => {
    // Ensure the prover is started
    if (!startedRef.current) {
      const started = await startProver();
      if (!started) return false;
    }

    if (webviewProverService.isCircuitLoaded(circuit)) return true;

    // For non-transfer circuits, use the denominated pool circuit loader
    if (circuit === 'pool' || circuit === 'denominated_transfer') {
      try {
        // Try APK assets first
        const assetResult = await webviewProverService.loadCircuitFromAssets(circuit);
        if (assetResult) return true;
      } catch {
        // Fall through to base64 loading
      }

      // Fallback: use the circuit loader service
      try {
        const { loadCircuitAssets } = await import('../services/denominatedPool/circuitLoader');
        const circuitType = circuit === 'pool' ? 'pool' : 'transfer';
        const { wasmBase64, zkeyBase64 } = await loadCircuitAssets(circuitType);
        return webviewProverService.loadCircuit(circuit, wasmBase64, zkeyBase64);
      } catch (err: any) {
        console.error(`[ZkProver] Failed to load ${circuit} circuit:`, err);
        setError(`Failed to load ${circuit}: ${err.message}`);
        return false;
      }
    }

    // Unknown circuit — caller must provide base64 data
    setError(`Unknown circuit "${circuit}". Use webviewProverService.loadCircuit() directly.`);
    return false;
  }, [startProver]);

  // ------------------------------------------------------------------
  // Public: generateProof — byte-array format (Solana on-chain)
  // ------------------------------------------------------------------

  const generateProof = useCallback(async (inputs: Record<string, string>): Promise<Groth16Proof> => {
    // Auto-start if needed
    const ready = await startProver();
    if (!ready) {
      throw new Error('Failed to initialize ZK prover. Please try again.');
    }

    const result = await webviewProverService.generateProof('transfer', inputs);
    return convertSnarkjsProofToBytes(result.proof);
  }, [startProver]);

  // ------------------------------------------------------------------
  // Public: generateRawProof — snarkjs format (relayer)
  // ------------------------------------------------------------------

  const generateRawProof = useCallback(async (inputs: Record<string, string>) => {
    const ready = await startProver();
    if (!ready) {
      throw new Error('Failed to initialize ZK prover. Please try again.');
    }

    const result = await webviewProverService.generateProof('transfer', inputs);
    return { proof: result.proof, publicSignals: result.publicSignals };
  }, [startProver]);

  // ------------------------------------------------------------------
  // Context value
  // ------------------------------------------------------------------

  const contextValue: ZkProverContextType = {
    isReady,
    isCircuitLoaded,
    generateProof,
    generateRawProof,
    startProver,
    loadCircuit,
    error,
  };

  return (
    <ZkProverContext.Provider value={contextValue}>
      {/* Hidden WebView — only rendered after startProver() is called */}
      <WebViewProver
        ref={handleRefChange}
        onMessage={onProverMessage}
        enabled={webViewEnabled}
      />
      {children}
    </ZkProverContext.Provider>
  );
}

// -----------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------

/**
 * Hook to access the ZK Prover.
 * Returns a mock context if provider is not available (graceful degradation).
 */
let _warnedOnce = false;
export function useZkProver(): ZkProverContextType {
  const context = useContext(ZkProverContext);
  if (!context) {
    if (!_warnedOnce) {
      _warnedOnce = true;
      console.warn('[useZkProver] ZkProverProvider not in component tree — returning mock context');
    }
    return {
      isReady: false,
      isCircuitLoaded: false,
      generateProof: async () => {
        throw new Error('ZK Prover not available. Please restart the app to enable ZK features.');
      },
      generateRawProof: async () => {
        throw new Error('ZK Prover not available. Please restart the app to enable ZK features.');
      },
      startProver: async () => false,
      loadCircuit: async () => false,
      error: 'ZK Prover not initialized — circuits not loaded to save memory',
    };
  }
  return context;
}
