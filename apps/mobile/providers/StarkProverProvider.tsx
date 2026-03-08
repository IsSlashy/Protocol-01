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

        const timer = setTimeout(() => {
          if (pendingRequests.current.has(id)) {
            pendingRequests.current.delete(id);
            reject(new Error('STARK proof generation timed out'));
          }
        }, 60000); // 60s for larger proofs

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

  const contextValue: StarkProverContextType = {
    isReady,
    generateProof,
    computeCommitment,
    generatePoolCommitmentProof,
    generateBalanceProof,
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
      error: 'StarkProverProvider not in component tree',
    };
  }
  return context;
}
