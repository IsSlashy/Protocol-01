/**
 * StarkProver — Hidden WebView for client-side STARK proof generation.
 *
 * Runs the p01-stark WASM module inside a 1x1 invisible WebView.
 * Generates compact STARK proofs (~9KB) entirely on-device.
 *
 * Architecture:
 *   1. WebView loads HTML with embedded WASM loader
 *   2. WASM module initialized from base64 (50KB)
 *   3. Proof request sent via postMessage, result returned via onMessage
 *   4. ~100-500ms proof time on modern devices
 *
 * SECURITY: All proving happens on-device. Secrets never leave the phone.
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
import { STARK_WASM_BASE64 } from './wasmData';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StarkProverMessage {
  type: 'ready' | 'wasmLoaded' | 'wasmError' | 'proof' | 'error' | 'log';
  id?: string;
  error?: string;
  commitment?: string;
  nullifier?: string;
  circuitId?: number;
  publicInputs?: string[];
  proofHex?: string;
  proofSize?: number;
  durationMs?: number;
  message?: string;
}

export interface StarkProverHandle {
  generateProof(id: string, subscriberSecret: string): void;
  computeCommitment(id: string, subscriberSecret: string): void;
  generatePoolCommitmentProof(id: string, np: string, secret: string, epoch: string, mint: string): void;
  generateBalanceProof(id: string, sk: string, balance: string, salt: string, mint: string): void;
  generateMerklePathProof(id: string, leaf: string, pathElements: string[], pathIndices: number[]): void;
  generateConfidentialBalanceProof(id: string, spendingKey: string, oldBalance: string, oldSalt: string, newBalance: string, newSalt: string, amount: string, amountSalt: string, tokenMint: string): void;
  generateTransferProof(id: string, spendingKey: string, tokenMint: string, inAmount1: string, inRand1: string, inAmount2: string, inRand2: string, outAmount1: string, outRand1: string, outRecipient1: string, outAmount2: string, outRand2: string, outRecipient2: string, publicAmount: string): void;
  isMounted(): boolean;
}

interface StarkProverProps {
  onMessage: (msg: StarkProverMessage) => void;
  onError?: (error: string) => void;
}

// ---------------------------------------------------------------------------
// WebView HTML — loads WASM and exposes proof generation
// ---------------------------------------------------------------------------

const STARK_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none';">
  <style>body{margin:0;padding:0;background:transparent;}</style>
</head>
<body>
<script>
(function() {
  'use strict';

  var wasmInstance = null;

  function log(msg) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'log', message: String(msg)
      }));
    } catch(e) {}
  }

  function post(data) {
    window.ReactNativeWebView.postMessage(JSON.stringify(data));
  }

  // ---- WASM helpers (matched to wasm-bindgen glue) ----
  var cachedDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  cachedDecoder.decode();
  var cachedEncoder = new TextEncoder();
  var WASM_VECTOR_LEN = 0;
  var cachedUint8Mem = null;

  if (!('encodeInto' in cachedEncoder)) {
    cachedEncoder.encodeInto = function(arg, view) {
      var buf = cachedEncoder.encode(arg);
      view.set(buf);
      return { read: arg.length, written: buf.length };
    };
  }

  function getUint8Memory() {
    if (cachedUint8Mem === null || cachedUint8Mem.byteLength === 0) {
      cachedUint8Mem = new Uint8Array(wasmInstance.exports.memory.buffer);
    }
    return cachedUint8Mem;
  }

  function getStringFromWasm(ptr, len) {
    ptr = ptr >>> 0;
    return cachedDecoder.decode(getUint8Memory().subarray(ptr, ptr + len));
  }

  function passStringToWasm(arg) {
    var malloc = wasmInstance.exports.__wbindgen_malloc;
    var realloc = wasmInstance.exports.__wbindgen_realloc;
    var len = arg.length;
    var ptr = malloc(len, 1) >>> 0;
    var mem = getUint8Memory();
    var offset = 0;
    for (; offset < len; offset++) {
      var code = arg.charCodeAt(offset);
      if (code > 0x7F) break;
      mem[ptr + offset] = code;
    }
    if (offset !== len) {
      if (offset !== 0) arg = arg.slice(offset);
      ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
      var view = getUint8Memory().subarray(ptr + offset, ptr + len);
      var ret = cachedEncoder.encodeInto(arg, view);
      offset += ret.written;
      ptr = realloc(ptr, len, offset, 1) >>> 0;
    }
    WASM_VECTOR_LEN = offset;
    return ptr;
  }

  function callWasmStringFn(fn, arg) {
    var ret = fn(arg);
    var ptr = ret[0], len = ret[1];
    var str = getStringFromWasm(ptr, len);
    wasmInstance.exports.__wbindgen_free(ptr, len, 1);
    return str;
  }

  function callWasmStringFn4(fn, a, b, c, d) {
    var ret = fn(a, b, c, d);
    var ptr = ret[0], len = ret[1];
    var str = getStringFromWasm(ptr, len);
    wasmInstance.exports.__wbindgen_free(ptr, len, 1);
    return str;
  }

  // ---- WASM initialization ----
  function handleMessage(event) {
    var data;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch(e) { return; }

    switch (data.type) {
      case 'initWasm':
        initWasm(data.wasmBase64);
        break;
      case 'generateProof':
        generateProof(data.id, data.secret);
        break;
      case 'computeCommitment':
        computeCommitment(data.id, data.secret);
        break;
      case 'generatePoolProof':
        generatePoolProof(data.id, data.args);
        break;
      case 'generateBalanceProof':
        generateBalanceProofFn(data.id, data.args);
        break;
      case 'generateMerklePathProof':
        generateMerklePathProofFn(data.id, data.leaf, data.pathElements, data.pathIndices);
        break;
      case 'generateConfidentialBalanceProof':
        generateConfidentialBalanceProofFn(data.id, data);
        break;
      case 'generateTransferProof':
        generateTransferProofFn(data.id, data);
        break;
    }
  }

  document.addEventListener('message', handleMessage);
  window.addEventListener('message', handleMessage);

  function initWasm(base64) {
    try {
      var binary = atob(base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      var imports = {
        './p01_stark_bg.js': {
          __wbindgen_init_externref_table: function() {
            var table = wasmInstance.exports.__wbindgen_externrefs;
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
        wasmInstance = result.instance;
        cachedUint8Mem = null;
        wasmInstance.exports.__wbindgen_start();
        post({ type: 'wasmLoaded' });
      }).catch(function(e) {
        post({ type: 'wasmError', error: 'WASM init failed: ' + e.message });
      });
    } catch(e) {
      post({ type: 'wasmError', error: 'WASM decode failed: ' + e.message });
    }
  }

  function generateProof(id, secretStr) {
    try {
      if (!wasmInstance) throw new Error('WASM not initialized');
      var secret = BigInt(secretStr);
      var startTime = performance.now();
      var jsonStr = callWasmStringFn(
        wasmInstance.exports.generate_stark_proof, secret
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      post({
        type: 'proof',
        id: id,
        commitment: result.commitment,
        proofHex: result.proof_hex,
        proofSize: result.proof_size,
        durationMs: elapsed
      });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message || 'Proof generation failed' });
    }
  }

  function computeCommitment(id, secretStr) {
    try {
      if (!wasmInstance) throw new Error('WASM not initialized');
      var secret = BigInt(secretStr);
      var result = callWasmStringFn(
        wasmInstance.exports.compute_stark_commitment, secret
      );
      post({ type: 'proof', id: id, commitment: result });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message });
    }
  }

  function generatePoolProof(id, args) {
    try {
      if (!wasmInstance) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var jsonStr = callWasmStringFn4(
        wasmInstance.exports.generate_pool_commitment_stark_proof,
        BigInt(args[0]), BigInt(args[1]), BigInt(args[2]), BigInt(args[3])
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      post({
        type: 'proof', id: id,
        circuitId: result.circuit_id,
        nullifier: result.nullifier,
        commitment: result.commitment,
        publicInputs: [result.nullifier, result.commitment],
        proofHex: result.proof_hex,
        proofSize: result.proof_size,
        durationMs: elapsed
      });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message || 'Pool proof failed' });
    }
  }

  function generateBalanceProofFn(id, args) {
    try {
      if (!wasmInstance) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var jsonStr = callWasmStringFn4(
        wasmInstance.exports.generate_balance_stark_proof,
        BigInt(args[0]), BigInt(args[1]), BigInt(args[2]), BigInt(args[3])
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      post({
        type: 'proof', id: id,
        circuitId: result.circuit_id,
        commitment: result.commitment,
        publicInputs: [result.commitment, result.token_mint],
        proofHex: result.proof_hex,
        proofSize: result.proof_size,
        durationMs: elapsed
      });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message || 'Balance proof failed' });
    }
  }

  function generateMerklePathProofFn(id, leaf, pathElements, pathIndices) {
    try {
      if (!wasmInstance) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var elemsCsv = pathElements.join(',');
      var indicesCsv = pathIndices.join(',');
      // Pass strings to WASM via passStringToWasm
      var elemsPtr = passStringToWasm(elemsCsv);
      var elemsLen = WASM_VECTOR_LEN;
      var indicesPtr = passStringToWasm(indicesCsv);
      var indicesLen = WASM_VECTOR_LEN;
      var ret = wasmInstance.exports.generate_merkle_path_stark_proof(
        BigInt(leaf), elemsPtr, elemsLen, indicesPtr, indicesLen
      );
      var jsonStr = getStringFromWasm(ret[0], ret[1]);
      wasmInstance.exports.__wbindgen_free(ret[0], ret[1], 1);
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      post({
        type: 'proof', id: id,
        circuitId: result.circuit_id,
        publicInputs: [result.leaf, result.root],
        proofHex: result.proof_hex,
        proofSize: result.proof_size,
        durationMs: elapsed
      });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message || 'Merkle proof failed' });
    }
  }

  function generateConfidentialBalanceProofFn(id, data) {
    try {
      if (!wasmInstance) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var ret = wasmInstance.exports.generate_confidential_balance_stark_proof(
        BigInt(data.spendingKey),
        BigInt(data.oldBalance),
        BigInt(data.oldSalt),
        BigInt(data.newBalance),
        BigInt(data.newSalt),
        BigInt(data.amount),
        BigInt(data.amountSalt),
        BigInt(data.tokenMint)
      );
      var jsonStr = getStringFromWasm(ret[0], ret[1]);
      wasmInstance.exports.__wbindgen_free(ret[0], ret[1], 1);
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      post({
        type: 'proof', id: id,
        circuitId: 4,
        publicInputs: [result.old_commitment, result.new_commitment, result.amount_hash, result.token_mint],
        proofHex: result.proof_hex,
        proofSize: result.proof_size,
        durationMs: elapsed
      });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message || 'Confidential balance proof failed' });
    }
  }

  function generateTransferProofFn(id, data) {
    try {
      if (!wasmInstance) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var ret = wasmInstance.exports.generate_transfer_stark_proof(
        BigInt(data.spendingKey),
        BigInt(data.tokenMint),
        BigInt(data.inAmount1),
        BigInt(data.inRand1),
        BigInt(data.inAmount2),
        BigInt(data.inRand2),
        BigInt(data.outAmount1),
        BigInt(data.outRand1),
        BigInt(data.outRecipient1),
        BigInt(data.outAmount2),
        BigInt(data.outRand2),
        BigInt(data.outRecipient2),
        BigInt(data.publicAmount)
      );
      var jsonStr = getStringFromWasm(ret[0], ret[1]);
      wasmInstance.exports.__wbindgen_free(ret[0], ret[1], 1);
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      post({
        type: 'proof', id: id,
        circuitId: 5,
        publicInputs: [result.nullifier_1, result.nullifier_2, result.output_commitment_1, result.output_commitment_2, result.public_amount, result.token_mint],
        proofHex: result.proof_hex,
        proofSize: result.proof_size,
        durationMs: elapsed
      });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message || 'Transfer proof failed' });
    }
  }

  post({ type: 'ready' });
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const StarkProver = forwardRef<StarkProverHandle, StarkProverProps>(
  function StarkProver({ onMessage, onError }, ref) {
    const webViewRef = useRef<WebView | null>(null);
    const [mounted, setMounted] = useState(false);
    const wasmSent = useRef(false);

    useEffect(() => {
      setMounted(true);
      return () => { setMounted(false); };
    }, []);

    const handleMessage = useCallback(
      (event: WebViewMessageEvent) => {
        try {
          const data: StarkProverMessage = JSON.parse(event.nativeEvent.data);

          // Auto-send WASM when WebView is ready
          if (data.type === 'ready' && !wasmSent.current && webViewRef.current) {
            wasmSent.current = true;
            const msg = JSON.stringify({
              type: 'initWasm',
              wasmBase64: STARK_WASM_BASE64,
            });
            webViewRef.current.injectJavaScript(
              `window.postMessage(${JSON.stringify(msg)}, '*'); true;`,
            );
          }

          onMessage(data);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown parse error';
          console.error('[StarkProver] Failed to parse message:', message);
        }
      },
      [onMessage],
    );

    const handleError = useCallback(
      (syntheticEvent: { nativeEvent: { description?: string } }) => {
        const description = syntheticEvent.nativeEvent.description ?? 'Unknown WebView error';
        console.error('[StarkProver] WebView error:', description);
        onError?.(description);
      },
      [onError],
    );

    const inject = useCallback((msg: string) => {
      webViewRef.current?.injectJavaScript(
        `window.postMessage(${JSON.stringify(msg)}, '*'); true;`,
      );
    }, []);

    useImperativeHandle(ref, () => ({
      generateProof(id: string, subscriberSecret: string) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({ type: 'generateProof', id, secret: subscriberSecret }));
      },

      computeCommitment(id: string, subscriberSecret: string) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({ type: 'computeCommitment', id, secret: subscriberSecret }));
      },

      generatePoolCommitmentProof(id: string, np: string, secret: string, epoch: string, mint: string) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({ type: 'generatePoolProof', id, args: [np, secret, epoch, mint] }));
      },

      generateBalanceProof(id: string, sk: string, balance: string, salt: string, mint: string) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({ type: 'generateBalanceProof', id, args: [sk, balance, salt, mint] }));
      },

      generateMerklePathProof(id: string, leaf: string, pathElements: string[], pathIndices: number[]) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({ type: 'generateMerklePathProof', id, leaf, pathElements, pathIndices }));
      },

      generateConfidentialBalanceProof(id: string, spendingKey: string, oldBalance: string, oldSalt: string, newBalance: string, newSalt: string, amount: string, amountSalt: string, tokenMint: string) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({
          type: 'generateConfidentialBalanceProof', id,
          spendingKey, oldBalance, oldSalt, newBalance, newSalt, amount, amountSalt, tokenMint,
        }));
      },

      generateTransferProof(id: string, spendingKey: string, tokenMint: string, inAmount1: string, inRand1: string, inAmount2: string, inRand2: string, outAmount1: string, outRand1: string, outRecipient1: string, outAmount2: string, outRand2: string, outRecipient2: string, publicAmount: string) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({
          type: 'generateTransferProof', id,
          spendingKey, tokenMint,
          inAmount1, inRand1, inAmount2, inRand2,
          outAmount1, outRand1, outRecipient1,
          outAmount2, outRand2, outRecipient2,
          publicAmount,
        }));
      },

      isMounted() {
        return mounted && webViewRef.current !== null;
      },
    }), [mounted, inject]);

    return (
      <View style={styles.hidden} pointerEvents="none">
        <WebView
          ref={webViewRef}
          source={{ html: STARK_HTML }}
          onMessage={handleMessage}
          onError={handleError}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['file://']}
          // L12: allowFileAccess removed — WASM data is injected via postMessage (base64),
          // not loaded from file://. No file:// access needed for this WebView.
          cacheEnabled={false}
          incognito
          scrollEnabled={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
    left: -9999,
    top: -9999,
  },
});
