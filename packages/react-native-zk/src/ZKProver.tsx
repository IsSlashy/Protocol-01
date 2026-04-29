/**
 * ZKProver — Hidden WebView for client-side STARK proof generation.
 *
 * v2: swaps the v1 Groth16 + snarkjs pipeline for a Goldilocks-field STARK
 * pipeline backed by `p01_stark_bg.wasm` (~124 KB, inlined as base64 in
 * `wasmData.ts`). Proofs are quantum-safe and ~10x larger than Groth16
 * (~9 KB vs ~256 B), but proving is ~5x faster and there is no trusted
 * setup — no `.zkey`, no CDN load.
 *
 * Architecture mirrors the browser-extension twin
 * `apps/extension/src/shared/workers/starkProver.worker.ts`:
 *   1. Hidden 1x1 WebView mounts and posts `ready`.
 *   2. WebView decodes `STARK_WASM_BASE64`, instantiates the wasm-bindgen
 *      module, posts `wasmLoaded`. Private inputs never leave the device.
 *   3. Host sends `{ type: 'generate*Proof', id, ...args }` via
 *      `injectJavaScript`; WebView replies with `{ type: 'proof', id, ... }`
 *      or `{ type: 'error', id, error }`.
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

import { STARK_WASM_BASE64 } from './wasmData';
import type { ProofResult, ProverOptions, ZKProverRef } from './types';

// ---------------------------------------------------------------------------
// WebView HTML — minimal wasm-bindgen glue, mirrors the worker line-for-line.
// ---------------------------------------------------------------------------

const PROVER_HTML_HEAD = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body><script>
(function() {
  var wasm = null;
  var cachedMem = null;
  var wasmVectorLen = 0;
  var decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  decoder.decode();
  var encoder = new TextEncoder();

  function post(msg) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }

  function getMem() {
    if (!wasm) throw new Error('WASM not initialized');
    if (cachedMem === null || cachedMem.byteLength === 0) {
      cachedMem = new Uint8Array(wasm.memory.buffer);
    }
    return cachedMem;
  }

  function getStringFromWasm(ptr, len) {
    var adjustedPtr = ptr >>> 0;
    return decoder.decode(getMem().subarray(adjustedPtr, adjustedPtr + len));
  }

  function passStringToWasm(arg) {
    var malloc = wasm.__wbindgen_malloc;
    var realloc = wasm.__wbindgen_realloc;
    var len = arg.length;
    var ptr = malloc(len, 1) >>> 0;
    var mem = getMem();
    var offset = 0;
    for (; offset < len; offset++) {
      var code = arg.charCodeAt(offset);
      if (code > 0x7f) break;
      mem[ptr + offset] = code;
    }
    if (offset !== len) {
      var sliced = arg;
      if (offset !== 0) sliced = arg.slice(offset);
      var newLen = offset + sliced.length * 3;
      ptr = realloc(ptr, len, newLen, 1) >>> 0;
      len = newLen;
      mem = getMem();
      var view = mem.subarray(ptr + offset, ptr + len);
      var written = encoder.encodeInto(sliced, view).written;
      offset += written;
      ptr = realloc(ptr, len, offset, 1) >>> 0;
    }
    wasmVectorLen = offset;
    return ptr;
  }

  function readStringReturn(ret) {
    var ptr = ret[0];
    var len = ret[1];
    var s = getStringFromWasm(ptr, len);
    wasm.__wbindgen_free(ptr, len, 1);
    return s;
  }

  function base64ToBytes(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function initWasm(b64) {
    try {
      var bytes = base64ToBytes(b64);
      var imports = {
        './p01_stark_bg.js': {
          __wbindgen_init_externref_table: function() {
            var table = wasm.__wbindgen_externrefs;
            var offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
          }
        }
      };
      WebAssembly.instantiate(bytes, imports).then(function(result) {
        wasm = result.instance.exports;
        cachedMem = null;
        wasm.__wbindgen_start();
        post({ type: 'wasmLoaded' });
      }).catch(function(err) {
        post({ type: 'wasmError', error: 'WASM init failed: ' + (err && err.message || String(err)) });
      });
    } catch (err) {
      post({ type: 'wasmError', error: 'WASM init failed: ' + (err && err.message || String(err)) });
    }
  }

  function ensureReady(id) {
    if (!wasm) {
      post({ type: 'error', id: id, error: 'WASM not initialized' });
      return false;
    }
    return true;
  }

  // ---- Circuit dispatch ----

  function generateProof(id, secret) {
    if (!ensureReady(id)) return;
    try {
      var t0 = performance.now();
      var json = readStringReturn(wasm.generate_stark_proof(BigInt(secret)));
      var dt = Math.round(performance.now() - t0);
      var r = JSON.parse(json);
      post({
        type: 'proof', id: id,
        circuitId: 0,
        commitment: r.commitment,
        publicInputs: [r.commitment],
        proofHex: r.proof_hex,
        proofSize: r.proof_size,
        durationMs: dt
      });
    } catch (err) {
      post({ type: 'error', id: id, error: err && err.message || 'Proof generation failed' });
    }
  }

  function computeCommitment(id, secret) {
    if (!ensureReady(id)) return;
    try {
      var commitment = readStringReturn(wasm.compute_stark_commitment(BigInt(secret)));
      post({
        type: 'proof', id: id,
        circuitId: 0,
        commitment: commitment,
        publicInputs: [commitment],
        proofHex: '',
        proofSize: 0
      });
    } catch (err) {
      post({ type: 'error', id: id, error: err && err.message || 'Commitment failed' });
    }
  }

  function generatePoolProof(id, np, secret, epoch, mint) {
    if (!ensureReady(id)) return;
    try {
      var t0 = performance.now();
      var json = readStringReturn(
        wasm.generate_pool_commitment_stark_proof(BigInt(np), BigInt(secret), BigInt(epoch), BigInt(mint))
      );
      var dt = Math.round(performance.now() - t0);
      var r = JSON.parse(json);
      post({
        type: 'proof', id: id,
        circuitId: r.circuit_id,
        nullifier: r.nullifier,
        commitment: r.commitment,
        publicInputs: [r.nullifier, r.commitment],
        proofHex: r.proof_hex,
        proofSize: r.proof_size,
        durationMs: dt
      });
    } catch (err) {
      post({ type: 'error', id: id, error: err && err.message || 'Pool proof failed' });
    }
  }

  function generateBalanceProof(id, sk, balance, salt, mint) {
    if (!ensureReady(id)) return;
    try {
      var t0 = performance.now();
      var json = readStringReturn(
        wasm.generate_balance_stark_proof(BigInt(sk), BigInt(balance), BigInt(salt), BigInt(mint))
      );
      var dt = Math.round(performance.now() - t0);
      var r = JSON.parse(json);
      post({
        type: 'proof', id: id,
        circuitId: r.circuit_id,
        commitment: r.commitment,
        publicInputs: [r.commitment, r.token_mint],
        proofHex: r.proof_hex,
        proofSize: r.proof_size,
        durationMs: dt
      });
    } catch (err) {
      post({ type: 'error', id: id, error: err && err.message || 'Balance proof failed' });
    }
  }

  function generateMerklePathProof(id, leaf, elements, indices) {
    if (!ensureReady(id)) return;
    try {
      var t0 = performance.now();
      var elemsPtr = passStringToWasm(elements.join(','));
      var elemsLen = wasmVectorLen;
      var idxPtr = passStringToWasm(indices.join(','));
      var idxLen = wasmVectorLen;
      var ret = wasm.generate_merkle_path_stark_proof(BigInt(leaf), elemsPtr, elemsLen, idxPtr, idxLen);
      var json = readStringReturn(ret);
      var dt = Math.round(performance.now() - t0);
      var r = JSON.parse(json);
      post({
        type: 'proof', id: id,
        circuitId: r.circuit_id,
        publicInputs: [r.leaf, r.root],
        proofHex: r.proof_hex,
        proofSize: r.proof_size,
        durationMs: dt
      });
    } catch (err) {
      post({ type: 'error', id: id, error: err && err.message || 'Merkle path proof failed' });
    }
  }

  function generateConfidentialBalanceProof(id, sk, oldBal, oldSalt, newBal, newSalt, amount, amountSalt, mint) {
    if (!ensureReady(id)) return;
    try {
      var t0 = performance.now();
      var ret = wasm.generate_confidential_balance_stark_proof(
        BigInt(sk), BigInt(oldBal), BigInt(oldSalt),
        BigInt(newBal), BigInt(newSalt),
        BigInt(amount), BigInt(amountSalt), BigInt(mint)
      );
      var json = readStringReturn(ret);
      var dt = Math.round(performance.now() - t0);
      var r = JSON.parse(json);
      post({
        type: 'proof', id: id,
        circuitId: 4,
        publicInputs: [r.old_commitment, r.new_commitment, r.amount_hash, r.token_mint],
        proofHex: r.proof_hex,
        proofSize: r.proof_size,
        durationMs: dt
      });
    } catch (err) {
      post({ type: 'error', id: id, error: err && err.message || 'Confidential balance proof failed' });
    }
  }

  function generateTransferProof(id, a) {
    if (!ensureReady(id)) return;
    try {
      var t0 = performance.now();
      var ret = wasm.generate_transfer_stark_proof(
        BigInt(a.spendingKey), BigInt(a.tokenMint),
        BigInt(a.inAmount1), BigInt(a.inRand1),
        BigInt(a.inAmount2), BigInt(a.inRand2),
        BigInt(a.outAmount1), BigInt(a.outRecipient1), BigInt(a.outRand1),
        BigInt(a.outAmount2), BigInt(a.outRecipient2), BigInt(a.outRand2),
        BigInt(a.publicAmount)
      );
      var json = readStringReturn(ret);
      var dt = Math.round(performance.now() - t0);
      var r = JSON.parse(json);
      post({
        type: 'proof', id: id,
        circuitId: 5,
        publicInputs: [
          r.nullifier_1, r.nullifier_2,
          r.output_commitment_1, r.output_commitment_2,
          r.public_amount, r.token_mint
        ],
        proofHex: r.proof_hex,
        proofSize: r.proof_size,
        durationMs: dt
      });
    } catch (err) {
      post({ type: 'error', id: id, error: err && err.message || 'Transfer proof failed' });
    }
  }

  function generateMerkleUpdateProof(id, oldLeaf, newLeaf, elements, indices) {
    if (!ensureReady(id)) return;
    if (!wasm.generate_merkle_update_stark_proof) {
      post({
        type: 'error', id: id,
        error: 'Circuit 6 (MERKLE_UPDATE) is not exported by the bundled WASM. Ship a custom WASM build via loadFromExpoAsset/loadFromApkAssets — see packages/stark-prover/README.md for the rebuild command.'
      });
      return;
    }
    try {
      var t0 = performance.now();
      var elemsPtr = passStringToWasm(elements.join(','));
      var elemsLen = wasmVectorLen;
      var idxPtr = passStringToWasm(indices.join(','));
      var idxLen = wasmVectorLen;
      var ret = wasm.generate_merkle_update_stark_proof(
        BigInt(oldLeaf), BigInt(newLeaf), elemsPtr, elemsLen, idxPtr, idxLen
      );
      var json = readStringReturn(ret);
      var dt = Math.round(performance.now() - t0);
      var r = JSON.parse(json);
      post({
        type: 'proof', id: id,
        circuitId: r.circuit_id,
        publicInputs: [r.old_leaf, r.new_leaf, r.old_root, r.new_root, String(r.depth)],
        proofHex: r.proof_hex,
        proofSize: r.proof_size,
        durationMs: dt
      });
    } catch (err) {
      post({ type: 'error', id: id, error: err && err.message || 'Merkle update proof failed' });
    }
  }

  // ---- Message router ----

  function handleMessage(event) {
    try {
      var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      switch (data.type) {
        case 'init':                            initWasm(data.wasm); break;
        case 'generateProof':                   generateProof(data.id, data.secret); break;
        case 'computeCommitment':               computeCommitment(data.id, data.secret); break;
        case 'generatePoolProof':               generatePoolProof(data.id, data.nullifierPreimage, data.secret, data.epoch, data.mint); break;
        case 'generateBalanceProof':            generateBalanceProof(data.id, data.spendingKey, data.balance, data.salt, data.mint); break;
        case 'generateMerklePathProof':         generateMerklePathProof(data.id, data.leaf, data.pathElements, data.pathIndices); break;
        case 'generateConfidentialBalanceProof': generateConfidentialBalanceProof(data.id, data.spendingKey, data.oldBalance, data.oldSalt, data.newBalance, data.newSalt, data.amount, data.amountSalt, data.tokenMint); break;
        case 'generateTransferProof':           generateTransferProof(data.id, data.args); break;
        case 'generateMerkleUpdateProof':       generateMerkleUpdateProof(data.id, data.oldLeaf, data.newLeaf, data.pathElements, data.pathIndices); break;
        default:
          post({ type: 'error', id: data.id || 'unknown', error: 'Unknown message type: ' + data.type });
      }
    } catch (e) {
      post({ type: 'error', id: 'parse', error: 'Message parse error: ' + (e && e.message || String(e)) });
    }
  }

  document.addEventListener('message', handleMessage);
  window.addEventListener('message', handleMessage);

  post({ type: 'ready' });
})();
</script></body></html>`;

// ---------------------------------------------------------------------------
// Pending request bookkeeping
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (r: ProofResult) => void;
  reject: (e: Error) => void;
}
const pendingRequests = new Map<string, Pending>();

function buildProofResult(data: {
  proofHex?: string;
  proofSize?: number;
  circuitId?: number;
  publicInputs?: string[];
  commitment?: string;
  nullifier?: string;
  durationMs?: number;
}): ProofResult {
  const result: ProofResult = {
    proofHex: data.proofHex ?? '',
    proofSize: data.proofSize ?? 0,
    circuitId: data.circuitId ?? 0,
  };
  if (data.publicInputs) result.publicInputs = data.publicInputs;
  if (data.commitment) result.commitment = data.commitment;
  if (data.nullifier) result.nullifier = data.nullifier;
  if (typeof data.durationMs === 'number') result.durationMs = data.durationMs;
  return result;
}

function dispatchInjected(
  webView: WebView | null,
  payload: Record<string, unknown>,
): void {
  if (!webView) throw new Error('WebView not available');
  const message = JSON.stringify(payload);
  webView.injectJavaScript(`
    window.postMessage(${JSON.stringify(message)}, '*');
    true;
  `);
}

function trackProof(
  webView: WebView | null,
  payload: Record<string, unknown>,
  options?: ProverOptions,
): Promise<ProofResult> {
  const id = String(payload.id);
  const timeout = options?.timeout ?? 30_000;
  return new Promise<ProofResult>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    try {
      dispatchInjected(webView, payload);
    } catch (err) {
      pendingRequests.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`STARK proof generation timed out after ${timeout}ms.`));
      }
    }, timeout);
  });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Hook surface returned by {@link useZKProver}. Exposes the same 8 typed
 * circuit methods as {@link ZKProverRef}, plus reactive state.
 *
 * Note: `isReady` is exposed as a reactive boolean here (vs the `isReady()`
 * method on {@link ZKProverRef}) so consumers can put it directly into JSX.
 */
export interface ZKProverContextValue {
  /** True once the inlined STARK WASM module is instantiated. */
  isReady: boolean;
  /** True while at least one proof request is in flight. */
  isProving: boolean;
  /** Last error message from WASM init or proof dispatch (if any). */
  error: string | null;
  /** Eagerly initialise the WASM module. Idempotent. */
  loadWasm(): Promise<boolean>;
  generateProof: ZKProverRef['generateProof'];
  computeCommitment: ZKProverRef['computeCommitment'];
  generatePoolCommitmentProof: ZKProverRef['generatePoolCommitmentProof'];
  generateBalanceProof: ZKProverRef['generateBalanceProof'];
  generateMerklePathProof: ZKProverRef['generateMerklePathProof'];
  generateConfidentialBalanceProof: ZKProverRef['generateConfidentialBalanceProof'];
  generateTransferProof: ZKProverRef['generateTransferProof'];
  generateMerkleUpdateProof: ZKProverRef['generateMerkleUpdateProof'];
}

const ProverContext = createContext<ZKProverContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider Component
// ---------------------------------------------------------------------------

interface ZKProverProviderProps {
  children: ReactNode;
  /** WebView base URL (default: `file:///android_asset/`). */
  baseUrl?: string;
  /**
   * Override the inlined WASM blob (base64). Useful for shipping a custom
   * build that exports `generate_merkle_update_stark_proof`. Defaults to
   * the bundled `STARK_WASM_BASE64`.
   */
  wasmBase64?: string;
}

/**
 * Context provider that renders a hidden 1x1 WebView and instantiates the
 * inlined STARK WASM module. Exposes proof generation to descendant
 * components via {@link useZKProver}. Private inputs never leave the device.
 *
 * @example
 * ```tsx
 * import { ZKProverProvider, useZKProver } from '@protocol-01/react-native-zk';
 *
 * function App() {
 *   return <ZKProverProvider><Screen /></ZKProverProvider>;
 * }
 *
 * function Screen() {
 *   const { generatePoolCommitmentProof, isProving } = useZKProver();
 *   const onPress = async () => {
 *     const r = await generatePoolCommitmentProof('req-1', np, secret, epoch, mint);
 *     console.log(r.proofHex);
 *   };
 *   return <Button onPress={onPress} disabled={isProving} />;
 * }
 * ```
 */
export function ZKProverProvider({
  children,
  baseUrl = 'file:///android_asset/',
  wasmBase64 = STARK_WASM_BASE64,
}: ZKProverProviderProps) {
  const webViewRef = useRef<WebView | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isProving, setIsProving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readyRef = useRef(false);
  const wasmReadyRef = useRef(false);
  const wasmReadyPromise = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      setError('ZK Prover WebView emitted a non-JSON message.');
      return;
    }
    const type = data.type as string;
    if (type === 'ready') {
      readyRef.current = true;
      // Auto-init WASM once the WebView signals ready.
      dispatchInjected(webViewRef.current, { type: 'init', wasm: wasmBase64 });
      return;
    }
    if (type === 'wasmLoaded') {
      wasmReadyRef.current = true;
      setIsReady(true);
      setError(null);
      wasmReadyPromise.current?.resolve();
      wasmReadyPromise.current = null;
      return;
    }
    if (type === 'wasmError') {
      const msg = (data.error as string) ?? 'WASM init failed';
      setError(msg);
      wasmReadyPromise.current?.reject(new Error(msg));
      wasmReadyPromise.current = null;
      return;
    }
    if (type === 'proof') {
      const id = data.id as string;
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        if (pendingRequests.size === 0) setIsProving(false);
        pending.resolve(buildProofResult(data));
      }
      return;
    }
    if (type === 'error') {
      const id = data.id as string;
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        if (pendingRequests.size === 0) setIsProving(false);
        pending.reject(new Error((data.error as string) ?? 'Proof generation failed'));
      } else {
        setError((data.error as string) ?? 'Unknown WebView error');
      }
    }
  }, [wasmBase64]);

  const loadWasm = useCallback((): Promise<boolean> => {
    if (wasmReadyRef.current) return Promise.resolve(true);
    return new Promise<boolean>((resolve, reject) => {
      wasmReadyPromise.current = {
        resolve: () => resolve(true),
        reject,
      };
      setTimeout(() => {
        if (!wasmReadyRef.current) {
          wasmReadyPromise.current = null;
          reject(new Error('STARK WASM init timed out after 15s. Ensure react-native-webview >= 13.0.0 is installed.'));
        }
      }, 15_000);
    });
  }, []);

  const ensureWasm = useCallback(async () => {
    if (!wasmReadyRef.current) await loadWasm();
  }, [loadWasm]);

  const startProof = useCallback(async (
    payload: Record<string, unknown>,
    options?: ProverOptions,
  ): Promise<ProofResult> => {
    await ensureWasm();
    setIsProving(true);
    try {
      return await trackProof(webViewRef.current, payload, options);
    } finally {
      if (pendingRequests.size === 0) setIsProving(false);
    }
  }, [ensureWasm]);

  const value: ZKProverContextValue = {
    isReady,
    isProving,
    error,
    loadWasm,
    generateProof: (id, secret, options) =>
      startProof({ type: 'generateProof', id, secret }, options),
    computeCommitment: (id, secret, options) =>
      startProof({ type: 'computeCommitment', id, secret }, options),
    generatePoolCommitmentProof: (id, np, secret, epoch, mint, options) =>
      startProof({ type: 'generatePoolProof', id, nullifierPreimage: np, secret, epoch, mint }, options),
    generateBalanceProof: (id, sk, balance, salt, mint, options) =>
      startProof({ type: 'generateBalanceProof', id, spendingKey: sk, balance, salt, mint }, options),
    generateMerklePathProof: (id, leaf, pathElements, pathIndices, options) =>
      startProof({ type: 'generateMerklePathProof', id, leaf, pathElements, pathIndices }, options),
    generateConfidentialBalanceProof: (id, sk, oldBal, oldSalt, newBal, newSalt, amount, amountSalt, mint, options) =>
      startProof({
        type: 'generateConfidentialBalanceProof', id,
        spendingKey: sk,
        oldBalance: oldBal, oldSalt,
        newBalance: newBal, newSalt,
        amount, amountSalt, tokenMint: mint,
      }, options),
    generateTransferProof: (id, args, options) =>
      startProof({ type: 'generateTransferProof', id, args }, options),
    generateMerkleUpdateProof: (id, oldLeaf, newLeaf, pathElements, pathIndices, options) =>
      startProof({
        type: 'generateMerkleUpdateProof', id, oldLeaf, newLeaf, pathElements, pathIndices,
      }, options),
  };

  return (
    <ProverContext.Provider value={value}>
      <View style={styles.hidden}>
        <WebView
          ref={webViewRef}
          source={{ html: PROVER_HTML_HEAD, baseUrl }}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          onError={(e: { nativeEvent: { description: string } }) => {
            setError('ZK Prover WebView failed to initialize. Ensure react-native-webview >= 13.0.0 is installed. Details: ' + e.nativeEvent.description);
          }}
        />
      </View>
      {children}
    </ProverContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Ref-based component (alternative API)
// ---------------------------------------------------------------------------

interface ZKProverComponentProps {
  baseUrl?: string;
  wasmBase64?: string;
}

/**
 * Ref-based STARK prover component. Use when you prefer direct ref access
 * over the React context API. Renders a hidden 1x1 WebView that runs the
 * inlined STARK WASM module.
 *
 * @example
 * ```tsx
 * import { useRef } from 'react';
 * import { ZKProver, type ZKProverRef } from '@protocol-01/react-native-zk';
 *
 * function Screen() {
 *   const ref = useRef<ZKProverRef>(null);
 *   const onPress = async () => {
 *     const r = await ref.current?.generateBalanceProof('req-1', sk, bal, salt, mint);
 *     console.log(r?.proofHex);
 *   };
 *   return <ZKProver ref={ref} />;
 * }
 * ```
 */
export const ZKProver = forwardRef<ZKProverRef, ZKProverComponentProps>(
  function ZKProver({ baseUrl = 'file:///android_asset/', wasmBase64 = STARK_WASM_BASE64 }, ref) {
    const webViewRef = useRef<WebView | null>(null);
    const wasmReadyRef = useRef(false);
    const wasmReadyPromise = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);

    const onMessage = useCallback((event: WebViewMessageEvent) => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(event.nativeEvent.data); } catch { return; }
      const type = data.type as string;
      if (type === 'ready') {
        dispatchInjected(webViewRef.current, { type: 'init', wasm: wasmBase64 });
        return;
      }
      if (type === 'wasmLoaded') {
        wasmReadyRef.current = true;
        wasmReadyPromise.current?.resolve();
        wasmReadyPromise.current = null;
        return;
      }
      if (type === 'wasmError') {
        const msg = (data.error as string) ?? 'WASM init failed';
        wasmReadyPromise.current?.reject(new Error(msg));
        wasmReadyPromise.current = null;
        return;
      }
      if (type === 'proof') {
        const id = data.id as string;
        const pending = pendingRequests.get(id);
        if (pending) { pendingRequests.delete(id); pending.resolve(buildProofResult(data)); }
        return;
      }
      if (type === 'error') {
        const id = data.id as string;
        const pending = pendingRequests.get(id);
        if (pending) {
          pendingRequests.delete(id);
          pending.reject(new Error((data.error as string) ?? 'Proof generation failed'));
        }
      }
    }, [wasmBase64]);

    const loadWasm = useCallback((): Promise<boolean> => {
      if (wasmReadyRef.current) return Promise.resolve(true);
      return new Promise<boolean>((resolve, reject) => {
        wasmReadyPromise.current = { resolve: () => resolve(true), reject };
        setTimeout(() => {
          if (!wasmReadyRef.current) {
            wasmReadyPromise.current = null;
            reject(new Error('STARK WASM init timed out after 15s.'));
          }
        }, 15_000);
      });
    }, []);

    const startProof = useCallback(async (
      payload: Record<string, unknown>,
      options?: ProverOptions,
    ): Promise<ProofResult> => {
      if (!wasmReadyRef.current) await loadWasm();
      return trackProof(webViewRef.current, payload, options);
    }, [loadWasm]);

    useImperativeHandle(ref, () => ({
      loadWasm,
      isReady: () => wasmReadyRef.current,
      generateProof: (id, secret, options) =>
        startProof({ type: 'generateProof', id, secret }, options),
      computeCommitment: (id, secret, options) =>
        startProof({ type: 'computeCommitment', id, secret }, options),
      generatePoolCommitmentProof: (id, np, secret, epoch, mint, options) =>
        startProof({ type: 'generatePoolProof', id, nullifierPreimage: np, secret, epoch, mint }, options),
      generateBalanceProof: (id, sk, balance, salt, mint, options) =>
        startProof({ type: 'generateBalanceProof', id, spendingKey: sk, balance, salt, mint }, options),
      generateMerklePathProof: (id, leaf, pathElements, pathIndices, options) =>
        startProof({ type: 'generateMerklePathProof', id, leaf, pathElements, pathIndices }, options),
      generateConfidentialBalanceProof: (id, sk, oldBal, oldSalt, newBal, newSalt, amount, amountSalt, mint, options) =>
        startProof({
          type: 'generateConfidentialBalanceProof', id,
          spendingKey: sk,
          oldBalance: oldBal, oldSalt,
          newBalance: newBal, newSalt,
          amount, amountSalt, tokenMint: mint,
        }, options),
      generateTransferProof: (id, args, options) =>
        startProof({ type: 'generateTransferProof', id, args }, options),
      generateMerkleUpdateProof: (id, oldLeaf, newLeaf, pathElements, pathIndices, options) =>
        startProof({
          type: 'generateMerkleUpdateProof', id, oldLeaf, newLeaf, pathElements, pathIndices,
        }, options),
    }), [loadWasm, startProof]);

    return (
      <View style={styles.hidden}>
        <WebView
          ref={webViewRef}
          source={{ html: PROVER_HTML_HEAD, baseUrl }}
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
  },
);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the {@link ZKProverContextValue} from the surrounding
 * {@link ZKProverProvider}. Throws if used outside a provider.
 */
export function useZKProver(): ZKProverContextValue {
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
