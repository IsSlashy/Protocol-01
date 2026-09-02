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
import { STARK_GLUE_IIFE } from './starkGlueIife';

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
  generateMerkleUpdateProof(id: string, oldLeaf: string, newLeaf: string, pathElements: string[], pathIndices: number[]): void;
  /** [C7] The spend proof. `pathElements`/`pathIndices` must be exactly 12
   *  long (C7's subtree depth, NOT the pool's 15) and `recipientHash` exactly
   *  4 limbs — the WebView refuses anything else rather than let the Rust
   *  silently drop what it cannot parse. */
  generateSpendProof(id: string, nullifierPreimage: string, secret: string, blinding: string, tokenMint: string, pathElements: string[], pathIndices: number[], recipientHash: string[]): void;
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
<script>${STARK_GLUE_IIFE}</script>
<script>
(function() {
  'use strict';

  var glue = null;

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

  // ---- WASM, through the bundled wasm-bindgen glue ----
  //
  // THIS BLOCK USED TO BE A HAND-ROLLED COPY OF THE wasm-bindgen ABI:
  // getUint8Memory / getStringFromWasm / passStringToWasm over
  // exports.memory, plus an import object with exactly ONE entry. It was one
  // of FIVE such copies in this repository.
  //
  // One entry was enough for the pre-C7 blob: pure computation, no randomness,
  // no JS interop. MEASURED on the circuit-7 build, it needs TWENTY-FIVE -- the
  // spend prover draws a 1,280-element CSPRNG mask and that pulls
  // getrandom -> crypto -> the whole wasm-bindgen shim surface. This copy could
  // not have loaded that blob at all.
  //
  // And the import names are CONTENT-HASHED
  // (__wbg_crypto_38df2bab126b63dc), so hand-writing them is work redone on
  // every rebuild, five times over.
  //
  // The other three surfaces just import the package. This one cannot: it
  // runs as an ES5 template string inside a WebView <script>, with no module
  // system at all. So the generated glue is bundled to an IIFE assigning one
  // global and injected above -- see
  // packages/stark-prover/scripts/stark-glue-iife.mjs.
  //
  // The glue's wrappers take and return real JS values, which is why the
  // handlers below pass CSV strings directly and no longer decode (ptr,len).

  // ---- Refusals ----
  //
  // The Rust wrappers do not throw. When one refuses -- no CSPRNG for the
  // blinding mask (C1, C3, C5, C6 and C7 all draw one since the lift-column
  // wave), a path of the wrong arity, a malformed recipient hash -- it returns
  // {"error": "..."} IN PLACE OF the proof JSON. Every handler below checks
  // for that before it reads a field. Until 2026-09-02 only the C7 handler
  // did, so a refused C1 came back as {type:'proof'} with circuitId, proofHex
  // and proofSize all undefined, and the host found out when it tried to
  // upload nothing. A refusal must arrive as {type:'error'}, in the prover's
  // own words.

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
      case 'generateMerkleUpdateProof':
        generateMerkleUpdateProofFn(data.id, data.oldLeaf, data.newLeaf, data.pathElements, data.pathIndices);
        break;
      case 'generateSpendProof':
        generateSpendProofFn(data.id, data);
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
      // Synchronous compile: wasm-unsafe-eval in the CSP above is exactly the
      // permission this needs, and the glue's initSync wants a Module, not raw
      // bytes. The blocking cost lands once, on a 1x1 hidden WebView.
      glue = P01StarkGlue;
      glue.initSync({ module: new WebAssembly.Module(bytes) });
      post({ type: 'wasmLoaded' });
    } catch(e) {
      glue = null;
      post({ type: 'wasmError', error: 'WASM init failed: ' + (e && e.message || String(e)) });
    }
  }

  function generateProof(id, secretStr) {
    try {
      if (!glue) throw new Error('WASM not initialized');
      var secret = BigInt(secretStr);
      var startTime = performance.now();
      var jsonStr = glue.generate_stark_proof(secret);
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      if (result.error) throw new Error('Prover refused: ' + result.error);
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
      if (!glue) throw new Error('WASM not initialized');
      var secret = BigInt(secretStr);
      var result = glue.compute_stark_commitment(secret);
      post({ type: 'proof', id: id, commitment: result });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message });
    }
  }

  function generatePoolProof(id, args) {
    try {
      if (!glue) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var jsonStr = glue.generate_pool_commitment_stark_proof(
        BigInt(args[0]), BigInt(args[1]), BigInt(args[2]), BigInt(args[3])
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      if (result.error) throw new Error('Prover refused: ' + result.error);
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
      if (!glue) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var jsonStr = glue.generate_balance_stark_proof(
        BigInt(args[0]), BigInt(args[1]), BigInt(args[2]), BigInt(args[3])
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      if (result.error) throw new Error('Prover refused: ' + result.error);
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
      if (!glue) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var jsonStr = glue.generate_merkle_path_stark_proof(
        BigInt(leaf), pathElements.join(','), pathIndices.join(',')
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      if (result.error) throw new Error('Prover refused: ' + result.error);
      // [C3 depth binding] depth is the 3rd public input, bound on-chain
      // (verifier rejects depth != 15). Fall back to the path length for
      // older WASM that does not emit the depth field.
      var depth = (typeof result.depth === 'number') ? result.depth : pathIndices.length;
      post({
        type: 'proof', id: id,
        circuitId: result.circuit_id,
        publicInputs: [result.leaf, result.root, String(depth)],
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
      if (!glue) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var jsonStr = glue.generate_confidential_balance_stark_proof(
        BigInt(data.spendingKey),
        BigInt(data.oldBalance),
        BigInt(data.oldSalt),
        BigInt(data.newBalance),
        BigInt(data.newSalt),
        BigInt(data.amount),
        BigInt(data.amountSalt),
        BigInt(data.tokenMint)
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      if (result.error) throw new Error('Prover refused: ' + result.error);
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

  function generateMerkleUpdateProofFn(id, oldLeaf, newLeaf, pathElements, pathIndices) {
    try {
      if (!glue) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var jsonStr = glue.generate_merkle_update_stark_proof(
        BigInt(oldLeaf), BigInt(newLeaf), pathElements.join(','), pathIndices.join(',')
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      if (result.error) throw new Error('Prover refused: ' + result.error);
      post({
        type: 'proof', id: id,
        circuitId: result.circuit_id,
        publicInputs: [result.old_leaf, result.new_leaf, result.old_root, result.new_root, String(result.depth)],
        proofHex: result.proof_hex,
        proofSize: result.proof_size,
        durationMs: elapsed
      });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message || 'Merkle update proof failed' });
    }
  }

  function generateTransferProofFn(id, data) {
    try {
      if (!glue) throw new Error('WASM not initialized');
      var startTime = performance.now();
      var jsonStr = glue.generate_transfer_stark_proof(
        BigInt(data.spendingKey),
        BigInt(data.tokenMint),
        BigInt(data.inAmount1),
        BigInt(data.inRand1),
        BigInt(data.inAmount2),
        BigInt(data.inRand2),
        BigInt(data.outAmount1),
        BigInt(data.outRecipient1),
        BigInt(data.outRand1),
        BigInt(data.outAmount2),
        BigInt(data.outRecipient2),
        BigInt(data.outRand2),
        BigInt(data.publicAmount)
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      if (result.error) throw new Error('Prover refused: ' + result.error);
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

  // [C7] The spend proof: C1's pool commitment and C3's Merkle path in ONE
  // trace. Ported from apps/extension/src/shared/workers/starkProver.worker.ts
  // (generateSpendProof) -- same guards, same public-input order, same
  // durationMs -- rewritten as ES5 because this runs as a template string
  // inside a WebView <script> with no module system at all.
  //
  // THE COMMITMENT IS NOT AMONG THE PUBLIC INPUTS AND THAT IS THE POINT. v3
  // spent on a C1 + C3 pair tied together by stark_commitment, published in
  // the clear, so a withdrawal named the leaf it spent and anyone reading the
  // tree walked back to the deposit that funded it.
  //
  // THE SIX PUBLIC INPUTS ARE ORDER-SENSITIVE: [nullifier, root, rh0..rh3].
  // unshield_denominated_stark_v4 rebuilds the same 48 bytes to compare
  // against the buffer's public_inputs_hash. Sorting or reordering them breaks
  // that hash, and the failure lands AFTER the whole ~78-chunk upload rather
  // than early.
  //
  // The mask is drawn INSIDE the wasm from a real CSPRNG -- which is why this
  // WebView needs the full 25-import wasm-bindgen surface the bundled glue
  // provides, and why the hand-rolled one-import shim this file used to carry
  // could not have loaded the C7 blob at all. There is deliberately no way to
  // pass a mask in.
  function generateSpendProofFn(id, data) {
    try {
      if (!glue) throw new Error('WASM not initialized');
      if (typeof glue.generate_spend_stark_proof !== 'function') {
        post({ type: 'error', id: id, error: 'Circuit 7 (SPEND) is not exported by the bundled WASM. '
          + 'The pre-C7 blob (229,640 B / 51a947e3) exports eight functions; the C7 build has nine.' });
        return;
      }
      // Checked here rather than left to the Rust: it parses the CSV with
      // filter_map(.. .ok()), which SILENTLY DROPS entries it cannot read, so
      // a truncated path and a malformed one are indistinguishable by the time
      // it sees them -- and an 11-deep proof is a valid proof of a tree nobody
      // uses. It would upload, verify, and settle nothing.
      // THIS LITERAL WAS 12 AND THE CIRCUIT HAD MOVED TO 11, so every
      // circuit-7 spend failed HERE, before the wasm was reached. Rust owns the
      // depth (air/spend.rs CANONICAL_DEPTH, lib.rs, verify.rs); this mirrors
      // it across a wire that carries no types and moves with it. The comment
      // above is now inverted: 11 IS the tree that is used.
      //
      // NO BACKTICKS ANYWHERE IN THIS SCRIPT, COMMENTS INCLUDED. The whole page
      // is one TypeScript template literal, so a backtick here closes
      // STARK_HTML early. From 2026-08-31 to 2026-09-02 this very comment
      // quoted three file names in backticks: TypeScript stopped parsing the
      // file (19 diagnostics) and webviewProver.test.ts saw a page with a
      // single <script> tag. Nothing else noticed, because nothing else reads
      // the string as a template.
      const C7_PATH_DEPTH = 11;
      if (data.pathElements.length !== C7_PATH_DEPTH || data.pathIndices.length !== C7_PATH_DEPTH) {
        post({ type: 'error', id: id, error: 'Circuit 7 needs exactly ' + C7_PATH_DEPTH
          + ' path elements and ' + C7_PATH_DEPTH + ' indices (its subtree depth is '
          + C7_PATH_DEPTH + ', NOT the pool 15). Got '
          + data.pathElements.length + ' and ' + data.pathIndices.length + '.' });
        return;
      }
      if (data.recipientHash.length !== 4) {
        post({ type: 'error', id: id, error: 'Circuit 7 needs 4 recipientHash limbs, got '
          + data.recipientHash.length + '.' });
        return;
      }
      var startTime = performance.now();
      var jsonStr = glue.generate_spend_stark_proof(
        BigInt(data.nullifierPreimage), BigInt(data.secret),
        BigInt(data.blinding), BigInt(data.tokenMint),
        data.pathElements.join(','), data.pathIndices.join(','), data.recipientHash.join(',')
      );
      var elapsed = Math.round(performance.now() - startTime);
      var result = JSON.parse(jsonStr);
      if (result.error) {
        post({ type: 'error', id: id, error: 'Circuit 7 prover refused: ' + result.error });
        return;
      }
      post({
        type: 'proof', id: id,
        circuitId: result.circuit_id,
        publicInputs: [result.nullifier, result.root].concat(result.recipient_hash),
        proofHex: result.proof_hex,
        proofSize: result.proof_size,
        durationMs: elapsed
      });
    } catch(e) {
      post({ type: 'error', id: id, error: e.message || 'Spend proof failed' });
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

      generateMerkleUpdateProof(id: string, oldLeaf: string, newLeaf: string, pathElements: string[], pathIndices: number[]) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({
          type: 'generateMerkleUpdateProof', id,
          oldLeaf, newLeaf, pathElements, pathIndices,
        }));
      },

      generateSpendProof(id: string, nullifierPreimage: string, secret: string, blinding: string, tokenMint: string, pathElements: string[], pathIndices: number[], recipientHash: string[]) {
        if (!webViewRef.current) return;
        inject(JSON.stringify({
          type: 'generateSpendProof', id,
          nullifierPreimage, secret, blinding, tokenMint,
          pathElements, pathIndices, recipientHash,
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
