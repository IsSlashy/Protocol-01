/**
 * STARK Prover Provider — On-device quantum-resistant proof generation.
 *
 * Wraps the StarkProver WebView component and exposes proof generation
 * and commitment computation through React context.
 *
 * The WASM module is only 50KB so it loads eagerly (no lazy loading needed).
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import {
  StarkProver,
  type StarkProverHandle,
  type StarkProverMessage,
} from '../services/stark/StarkProver';
import { getZkService } from '../services/zk';
import { assertSpendWitness, CIRCUIT_SPEND } from '../services/stark/spendWitness';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

export interface StarkProofResult {
  commitment: string;
  proofHex: string;
  proofSize: number;
  durationMs: number;
}

export interface GenericStarkProofResult {
  circuitId: number;
  publicInputs: string[];
  proofHex: string;
  proofSize: number;
  durationMs: number;
}

interface StarkProverContextType {
  isReady: boolean;
  generateProof: (subscriberSecret: string) => Promise<StarkProofResult>;
  computeCommitment: (subscriberSecret: string) => Promise<string>;
  generatePoolCommitmentProof: (np: string, secret: string, epoch: string, mint: string) => Promise<GenericStarkProofResult>;
  generateBalanceProof: (sk: string, balance: string, salt: string, mint: string) => Promise<GenericStarkProofResult>;
  generateConfidentialBalanceProof: (spendingKey: string, oldBalance: string, oldSalt: string, newBalance: string, newSalt: string, amount: string, amountSalt: string, tokenMint: string) => Promise<GenericStarkProofResult>;
  generateTransferProof: (spendingKey: string, tokenMint: string, inAmount1: string, inRand1: string, inAmount2: string, inRand2: string, outAmount1: string, outRand1: string, outRecipient1: string, outAmount2: string, outRand2: string, outRecipient2: string, publicAmount: string) => Promise<GenericStarkProofResult>;
  generateMerkleUpdateProof: (oldLeaf: string, newLeaf: string, pathElements: string[], pathIndices: number[]) => Promise<GenericStarkProofResult>;
  /** V3 — circuit 3 (merkle_path). Proves `leaf` is at `root` via the supplied
   *  path. Used by `unshield_denominated_stark_v3` stacked on top of C1. */
  generateMerklePathProof: (leaf: string, pathElements: string[], pathIndices: number[]) => Promise<GenericStarkProofResult>;
  /**
   * [C7] The spend proof — C1's pool commitment and C3's Merkle path in ONE
   * trace, so `unshield_denominated_stark_v4` can settle a withdrawal without
   * the note commitment ever appearing on the wire.
   *
   * ⛔ `recipientHash` means the proof CANNOT be built without knowing who is
   * being paid: sha256(recipient) is in the transcript, so a proof made for A
   * cannot be replayed to pay B. It is also why the recipient has to be known
   * at PREPARE time, not only at execution.
   *
   * publicInputs layout is ORDER-SENSITIVE: [nullifier, root, rh0, rh1, rh2, rh3].
   */
  generateSpendProof: (nullifierPreimage: string, secret: string, blinding: string, tokenMint: string, pathElements: string[], pathIndices: number[], recipientHash: string[]) => Promise<GenericStarkProofResult>;
  error: string | null;
}

const StarkProverContext = createContext<StarkProverContextType | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface StarkProverProviderProps {
  children: ReactNode;
}

export function StarkProverProvider({ children }: StarkProverProviderProps) {
  const proverRef = useRef<StarkProverHandle>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRequests = useRef<Map<string, PendingRequest>>(new Map());
  const requestCounter = useRef(0);

  const onMessage = useCallback((msg: StarkProverMessage) => {
    if (msg.type === 'wasmLoaded') {
      setIsReady(true);
      setError(null);
      console.log('[StarkProver] WASM loaded, ready for proofs');
    }

    if (msg.type === 'wasmError') {
      setError(msg.error ?? 'WASM initialization failed');
      console.error('[StarkProver] WASM error:', msg.error);
    }

    if (msg.type === 'log') {
      // ⛔ __DEV__-GATED BECAUSE THIS RECEIVER IS UNFILTERED AND THE EMITTER IS
      // NOT TYPE-CHECKED.
      //
      // It prints whatever the WebView sends on the `log` channel, verbatim.
      // The channel is DORMANT — services/stark/StarkProver.tsx:89 declares
      // `log()` and nothing calls it — but the receiver is live, and the thing
      // that would call it is a plain ES5 string injected into the WebView:
      // not type-checked, not linted, shipped verbatim. One `log(secret)` in
      // that string and this line puts a nullifier preimage in logcat.
      //
      // Two independent defences now, because one was measured insufficient
      // on 2026-08-27: this gate, and transform-remove-console re-enabled in
      // babel.config.js with only error and warn excluded. Either alone would
      // do; keeping both means neither being reverted silently reopens it.
      //
      // The content is KEPT rather than redacted: a debug channel that hides
      // what it was asked to show is a channel nobody uses, and dev builds do
      // not ship.
      if (__DEV__) console.log('[StarkProver/WebView]', msg.message);
    }

    if ((msg.type === 'proof' || msg.type === 'error') && msg.id) {
      const pending = pendingRequests.current.get(msg.id);
      if (pending) {
        pendingRequests.current.delete(msg.id);
        if (msg.type === 'error') {
          pending.reject(new Error(msg.error ?? 'Unknown STARK error'));
        } else {
          pending.resolve(msg);
        }
      }
    }
  }, []);

  const onError = useCallback((err: string) => {
    setError(err);
    console.error('[StarkProver] WebView error:', err);
  }, []);

  const sendRequestRaw = useCallback(
    <T,>(callFn: (id: string) => void): Promise<T> => {
      return new Promise((resolve, reject) => {
        if (!proverRef.current?.isMounted()) {
          reject(new Error('STARK prover not mounted'));
          return;
        }
        if (!isReady) {
          reject(new Error('STARK WASM not loaded yet'));
          return;
        }

        const id = `stark_${++requestCounter.current}`;

        // ⛔ DO NOT PUT A `[P01PERF]` LINE (or any other per-proof log) HERE.
        //
        // This function is the single funnel for EVERY generate*Proof wrapper
        // below — C1, C2, C3, C4, C5, C6 and C7 all come through it. A line
        // emitted from this resolve is therefore not a benchmark: it fires on a
        // real user's spend, on the device, in production. `babel.config.js`
        // has `transform-remove-console` COMMENTED OUT (line 51) and nothing
        // else noops console in release, so such a line reaches a shipped APK
        // and anyone holding the phone reads it with
        // `adb logcat -s ReactNativeJS`.
        //
        // It leaks no proof, witness, nullifier or commitment — but it does
        // timestamp the act: "this handset produced a circuit-7 spend proof at
        // T". Correlated against the v4 withdrawals on chain around T, that is
        // exactly the payer<->note edge the whole C7 design exists to remove.
        // The timing is metadata, and metadata is the linkage.
        //
        // The benchmark owns this measurement instead, and already emits the
        // identical string, byte for byte, in the recorded 2026-08-03 device
        // format:
        //   services/stark/c7Bench.ts:101   (per proof, + a median line)
        // driven on device from
        //   app/(main)/(settings)/privacy-test.tsx  (Privacy tech tests -> C7)
        // and in Node from
        //   scripts/c7-bench-node.ts
        // `runC7Bench` takes its sink as a parameter, so the caller decides
        // where the line goes. That is what "opt-in" has to mean here: the
        // measurement is reachable only by someone who deliberately started a
        // benchmark, never as a side effect of paying.
        const timer = setTimeout(() => {
          if (pendingRequests.current.has(id)) {
            pendingRequests.current.delete(id);
            reject(new Error('STARK proof generation timed out'));
          }
        }, 180000); // 180s — bumped from 60s 2026-05-23, circuit 1/3 on Nothing A001 was timing out

        pendingRequests.current.set(id, {
          resolve: (v: any) => { clearTimeout(timer); resolve(v); },
          reject: (e: any) => { clearTimeout(timer); reject(e); },
        });

        callFn(id);
      });
    },
    [isReady],
  );

  const sendRequest = useCallback(
    <T,>(method: 'generateProof' | 'computeCommitment', secret: string): Promise<T> => {
      return sendRequestRaw<T>((id) => {
        if (method === 'generateProof') {
          proverRef.current!.generateProof(id, secret);
        } else {
          proverRef.current!.computeCommitment(id, secret);
        }
      });
    },
    [sendRequestRaw],
  );

  const generateProof = useCallback(
    async (subscriberSecret: string): Promise<StarkProofResult> => {
      const msg = await sendRequest<StarkProverMessage>('generateProof', subscriberSecret);
      return {
        commitment: msg.commitment!,
        proofHex: msg.proofHex!,
        proofSize: msg.proofSize!,
        durationMs: msg.durationMs!,
      };
    },
    [sendRequest],
  );

  const computeCommitment = useCallback(
    async (subscriberSecret: string): Promise<string> => {
      const msg = await sendRequest<StarkProverMessage>('computeCommitment', subscriberSecret);
      return msg.commitment!;
    },
    [sendRequest],
  );

  const generatePoolCommitmentProof = useCallback(
    async (np: string, secret: string, epoch: string, mint: string): Promise<GenericStarkProofResult> => {
      const msg = await sendRequestRaw<StarkProverMessage>((id) => {
        proverRef.current!.generatePoolCommitmentProof(id, np, secret, epoch, mint);
      });
      return {
        circuitId: msg.circuitId ?? 1,
        publicInputs: msg.publicInputs ?? [],
        proofHex: msg.proofHex!,
        proofSize: msg.proofSize!,
        durationMs: msg.durationMs!,
      };
    },
    [sendRequestRaw],
  );

  const generateBalanceProof = useCallback(
    async (sk: string, balance: string, salt: string, mint: string): Promise<GenericStarkProofResult> => {
      const msg = await sendRequestRaw<StarkProverMessage>((id) => {
        proverRef.current!.generateBalanceProof(id, sk, balance, salt, mint);
      });
      return {
        circuitId: msg.circuitId ?? 2,
        publicInputs: msg.publicInputs ?? [],
        proofHex: msg.proofHex!,
        proofSize: msg.proofSize!,
        durationMs: msg.durationMs!,
      };
    },
    [sendRequestRaw],
  );

  const generateConfidentialBalanceProof = useCallback(
    async (
      spendingKey: string, oldBalance: string, oldSalt: string,
      newBalance: string, newSalt: string,
      amount: string, amountSalt: string, tokenMint: string,
    ): Promise<GenericStarkProofResult> => {
      const msg = await sendRequestRaw<StarkProverMessage>((id) => {
        proverRef.current!.generateConfidentialBalanceProof(
          id, spendingKey, oldBalance, oldSalt, newBalance, newSalt, amount, amountSalt, tokenMint,
        );
      });
      return {
        circuitId: msg.circuitId ?? 4,
        publicInputs: msg.publicInputs ?? [],
        proofHex: msg.proofHex!,
        proofSize: msg.proofSize!,
        durationMs: msg.durationMs!,
      };
    },
    [sendRequestRaw],
  );

  const generateTransferProof = useCallback(
    async (
      spendingKey: string, tokenMint: string,
      inAmount1: string, inRand1: string,
      inAmount2: string, inRand2: string,
      outAmount1: string, outRand1: string, outRecipient1: string,
      outAmount2: string, outRand2: string, outRecipient2: string,
      publicAmount: string,
    ): Promise<GenericStarkProofResult> => {
      const msg = await sendRequestRaw<StarkProverMessage>((id) => {
        proverRef.current!.generateTransferProof(
          id, spendingKey, tokenMint,
          inAmount1, inRand1, inAmount2, inRand2,
          outAmount1, outRand1, outRecipient1,
          outAmount2, outRand2, outRecipient2,
          publicAmount,
        );
      });
      return {
        circuitId: msg.circuitId ?? 5,
        publicInputs: msg.publicInputs ?? [],
        proofHex: msg.proofHex!,
        proofSize: msg.proofSize!,
        durationMs: msg.durationMs!,
      };
    },
    [sendRequestRaw],
  );

  const generateMerkleUpdateProof = useCallback(
    async (
      oldLeaf: string, newLeaf: string,
      pathElements: string[], pathIndices: number[],
    ): Promise<GenericStarkProofResult> => {
      const msg = await sendRequestRaw<StarkProverMessage>((id) => {
        proverRef.current!.generateMerkleUpdateProof(id, oldLeaf, newLeaf, pathElements, pathIndices);
      });
      return {
        circuitId: msg.circuitId ?? 6,
        publicInputs: msg.publicInputs ?? [],
        proofHex: msg.proofHex!,
        proofSize: msg.proofSize!,
        durationMs: msg.durationMs!,
      };
    },
    [sendRequestRaw],
  );

  // V3 quick-win: expose circuit 3 (merkle_path) the same way C6 is exposed.
  // The underlying StarkProver.tsx already supports `generateMerklePathProof`
  // (line 51 of StarkProver.tsx), this just bridges it into the React context.
  const generateMerklePathProof = useCallback(
    async (
      leaf: string,
      pathElements: string[], pathIndices: number[],
    ): Promise<GenericStarkProofResult> => {
      const msg = await sendRequestRaw<StarkProverMessage>((id) => {
        proverRef.current!.generateMerklePathProof(id, leaf, pathElements, pathIndices);
      });
      return {
        circuitId: msg.circuitId ?? 3,
        publicInputs: msg.publicInputs ?? [],
        proofHex: msg.proofHex!,
        proofSize: msg.proofSize!,
        durationMs: msg.durationMs!,
      };
    },
    [sendRequestRaw],
  );

  /**
   * [C7] See the doc comment on `StarkProverContextType.generateSpendProof`.
   *
   * The arity guard runs HERE, synchronously, before anything is injected into
   * the WebView — `stark/src/air/spend.rs` parses the CSV with
   * `filter_map(.. .ok())` and silently drops what it cannot read, so a short
   * path yields a perfectly valid proof of a tree nobody uses. The WebView
   * repeats the check because it is the last boundary before the wasm; this one
   * exists because it can be unit-tested in Node and that one cannot.
   */
  const generateSpendProof = useCallback(
    async (
      nullifierPreimage: string, secret: string, blinding: string, tokenMint: string,
      pathElements: string[], pathIndices: number[], recipientHash: string[],
    ): Promise<GenericStarkProofResult> => {
      assertSpendWitness({
        nullifierPreimage, secret, blinding, tokenMint,
        pathElements, pathIndices, recipientHash,
      });
      const msg = await sendRequestRaw<StarkProverMessage>((id) => {
        proverRef.current!.generateSpendProof(
          id, nullifierPreimage, secret, blinding, tokenMint,
          pathElements, pathIndices, recipientHash,
        );
      });
      return {
        circuitId: msg.circuitId ?? CIRCUIT_SPEND,
        publicInputs: msg.publicInputs ?? [],
        proofHex: msg.proofHex!,
        proofSize: msg.proofSize!,
        durationMs: msg.durationMs!,
      };
    },
    [sendRequestRaw],
  );

  // Register this prover with the privacy-router autonomous runner so
  // unshield/split hops can generate real STARK proofs while the app is
  // foregrounded. Cleared on unmount so background ticks fall back to the
  // RETRY+local-notification path.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { setForegroundProver, clearForegroundProver } = await import('../services/privacyRouter/autonomousRunner');
        if (cancelled) return;
        setForegroundProver({
          isReady,
          generatePoolCommitmentProof: async (np, secret, epoch, mint) => {
            const r = await generatePoolCommitmentProof(np, secret, epoch, mint);
            return { proofHex: r.proofHex, proofSize: r.proofSize, publicInputs: r.publicInputs };
          },
          // C3 (merkle_path) — required by the split hop now that
          // split_note_stark proves source-note membership.
          generateMerklePathProof: async (leaf, pathElements, pathIndices) => {
            const r = await generateMerklePathProof(leaf, pathElements, pathIndices);
            return { proofHex: r.proofHex, proofSize: r.proofSize, publicInputs: r.publicInputs };
          },
        });
        return () => clearForegroundProver();
      } catch {
        // privacy-router optional in this build
      }
    })();
    return () => { cancelled = true; };
  }, [isReady, generatePoolCommitmentProof, generateMerklePathProof]);

  // Wire circuit 6 (merkle_update) + circuit 5 (transfer) provers into
  // ZkService so shield/transfer/unshield can generate STARK proofs without
  // threading the hook through every caller.
  useEffect(() => {
    if (!isReady) return;
    try {
      const zkService = getZkService();
      zkService.setMerkleUpdateProver(async (oldLeaf, newLeaf, pathElements, pathIndices) => {
        const result = await generateMerkleUpdateProof(oldLeaf, newLeaf, pathElements, pathIndices);
        return {
          circuitId: result.circuitId,
          publicInputs: result.publicInputs,
          proofHex: result.proofHex,
          proofSize: result.proofSize,
        };
      });
      // V3 — wire C3 (merkle_path) prover the same way C6 is wired.
      zkService.setMerklePathProver(async (leaf, pathElements, pathIndices) => {
        const result = await generateMerklePathProof(leaf, pathElements, pathIndices);
        return {
          circuitId: result.circuitId,
          publicInputs: result.publicInputs,
          proofHex: result.proofHex,
          proofSize: result.proofSize,
        };
      });
      zkService.setTransferProver(async (
        spendingKey, tokenMint,
        inAmount1, inRand1, inAmount2, inRand2,
        outAmount1, outRand1, outRecipient1,
        outAmount2, outRand2, outRecipient2,
        publicAmount,
      ) => {
        const result = await generateTransferProof(
          spendingKey, tokenMint,
          inAmount1, inRand1, inAmount2, inRand2,
          outAmount1, outRand1, outRecipient1,
          outAmount2, outRand2, outRecipient2,
          publicAmount,
        );
        return {
          circuitId: result.circuitId,
          publicInputs: result.publicInputs,
          proofHex: result.proofHex,
          proofSize: result.proofSize,
        };
      });
      console.log('[StarkProver] merkle_update + transfer provers wired into ZkService');
    } catch (err) {
      console.warn('[StarkProver] Failed to wire into ZkService:', err);
    }
  }, [isReady, generateMerkleUpdateProof, generateMerklePathProof, generateTransferProof]);

  const contextValue: StarkProverContextType = {
    isReady,
    generateProof,
    computeCommitment,
    generatePoolCommitmentProof,
    generateBalanceProof,
    generateConfidentialBalanceProof,
    generateTransferProof,
    generateMerkleUpdateProof,
    generateMerklePathProof,
    generateSpendProof,
    error,
  };

  return (
    <StarkProverContext.Provider value={contextValue}>
      <StarkProver ref={proverRef} onMessage={onMessage} onError={onError} />
      {children}
    </StarkProverContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStarkProver(): StarkProverContextType {
  const context = useContext(StarkProverContext);
  if (!context) {
    const notAvailable = async () => { throw new Error('STARK prover not available'); };
    return {
      isReady: false,
      generateProof: notAvailable as any,
      computeCommitment: notAvailable as any,
      generatePoolCommitmentProof: notAvailable as any,
      generateBalanceProof: notAvailable as any,
      generateConfidentialBalanceProof: notAvailable as any,
      generateTransferProof: notAvailable as any,
      generateMerkleUpdateProof: notAvailable as any,
      generateMerklePathProof: notAvailable as any,
      generateSpendProof: notAvailable as any,
      error: 'StarkProverProvider not in component tree',
    };
  }
  return context;
}
