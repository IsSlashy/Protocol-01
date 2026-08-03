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
      console.log('[StarkProver/WebView]', msg.message);
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
        const t0 = Date.now();

        // [MEASURE 2026-08-03] 180s -> 600s. NOT a fix, an instrument.
        //
        // MEASURED on device 0019235AU004508 with release 1.0.3: an unshield
        // (C1 + C3) hit the 180s ceiling and rejected, so the only thing anyone
        // has ever learned about on-device proving is "more than 180,000 ms".
        // `docs/MOBILE_PROVER_LATENCY.md` calls this the biggest hole in the
        // budget and its only reference is a DESKTOP C6 at 1,571 ms.
        //
        // The ceiling has to move or the number cannot be obtained: the request
        // is killed before the WebView ever reports its `durationMs`. This was
        // already bumped once for exactly these circuits (60s -> 180s,
        // 2026-05-23, Nothing A001) and that was treated as the fix rather than
        // as the symptom. 600s is a measuring window, not a product decision —
        // once the real figure exists, set this from it deliberately.
        const timer = setTimeout(() => {
          console.log(
            `[P01PERF] TIMEOUT after ${Date.now() - t0} ms — proof exceeded the ceiling`,
          );
          if (pendingRequests.current.has(id)) {
            pendingRequests.current.delete(id);
            reject(new Error('STARK proof generation timed out'));
          }
        }, 600000);

        pendingRequests.current.set(id, {
          resolve: (v: any) => {
            clearTimeout(timer);
            // [MEASURE 2026-08-03] The one line that was missing. `durationMs`
            // already crossed the bridge and was assigned at all seven call
            // sites, then discarded without ever being printed — see
            // MOBILE_PROVER_LATENCY.md item I1. Logged HERE, at the single
            // choke point every request returns through, so no circuit can be
            // instrumented and another forgotten.
            //
            // Two numbers on purpose: `prover` is what the WebView measured for
            // the proof itself, `bridge` is wall clock including marshalling a
            // ~280 KB hex payload across the RN bridge. If they diverge, the
            // cost is transport and not arithmetic, and that changes the fix.
            const wall = Date.now() - t0;
            const d = (v as any)?.durationMs;
            const sz = (v as any)?.proofSize;
            const cid = (v as any)?.circuitId;
            console.log(
              `[P01PERF] circuit=${cid ?? '?'} prover=${d ?? '?'} ms bridge=${wall} ms proofSize=${sz ?? '?'}`,
            );
            resolve(v);
          },
          reject: (e: any) => {
            clearTimeout(timer);
            console.log(`[P01PERF] FAILED after ${Date.now() - t0} ms: ${e?.message ?? e}`);
            reject(e);
          },
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
      error: 'StarkProverProvider not in component tree',
    };
  }
  return context;
}
