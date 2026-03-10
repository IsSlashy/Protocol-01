/**
 * ArciumProvider — Lazy-init MPC privacy layer.
 *
 * When the user enables MPC, this provider initializes the Arcium client
 * and makes it available to all downstream screens via useArcium().
 *
 * Design: zero overhead when MPC is disabled (no client instantiated).
 */

import React, { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useArciumStore } from '../stores/arciumStore';
import { isArciumAvailable } from '../services/arcium';

interface ArciumContextValue {
  /** Whether MPC-enhanced privacy is active and ready */
  isMpcActive: boolean;
  /** Whether the Arcium program exists on-chain */
  programAvailable: boolean;
}

const ArciumContext = createContext<ArciumContextValue>({
  isMpcActive: false,
  programAvailable: false,
});

export function useArcium(): ArciumContextValue {
  return useContext(ArciumContext);
}

export function ArciumProvider({ children }: { children: ReactNode }) {
  const { mpcEnabled, status, programAvailable, initialize, setProgramAvailable, setStatus } =
    useArciumStore();
  const clientInitAttempted = useRef(false);

  // Load persisted preference on mount
  useEffect(() => {
    initialize();
  }, []);

  // Probe program availability once (background, non-blocking)
  useEffect(() => {
    let cancelled = false;
    console.log('[MPC] Probing Arcium program availability...');
    isArciumAvailable().then((available) => {
      console.log('[MPC] Program available:', available);
      if (!cancelled) setProgramAvailable(available);
    });
    return () => { cancelled = true; };
  }, []);

  // Initialize MPC client when enabled — retries if wallet not yet available
  useEffect(() => {
    if (!mpcEnabled) {
      setStatus('disabled');
      clientInitAttempted.current = false;
      return;
    }

    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const tryInit = (attempt: number) => {
      console.log(`[MPC] Attempting client init (attempt ${attempt})...`);
      setStatus('initializing');

      import('../services/arcium/mpcClient')
        .then(({ getMpcClient }) => {
          return getMpcClient();
        })
        .then((client) => {
          if (client) {
            console.log('[MPC] Client initialized successfully!');
            if (!programAvailable) setProgramAvailable(true);
            setStatus('ready');
          } else if (attempt < 5) {
            // Wallet may not be ready yet — retry after delay
            const delay = attempt * 2000; // 2s, 4s, 6s, 8s
            console.log(`[MPC] Client null (wallet not ready?) — retrying in ${delay}ms`);
            setStatus('ready'); // mark ready so UI is usable, ops have own fallback
            retryTimer = setTimeout(() => tryInit(attempt + 1), delay);
          } else {
            console.warn('[MPC] Client null after 5 attempts — giving up, ops use fallback');
            if (!programAvailable) setProgramAvailable(true);
            setStatus('ready');
          }
        })
        .catch((e) => {
          console.warn('[MPC] Client init error:', e.message);
          if (!programAvailable) setProgramAvailable(true);
          setStatus('ready');
        });
    };

    if (!clientInitAttempted.current) {
      clientInitAttempted.current = true;
      tryInit(1);
    } else {
      setStatus('ready');
    }

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [mpcEnabled]);

  const isMpcActive = mpcEnabled && status === 'ready';

  return (
    <ArciumContext.Provider value={{ isMpcActive, programAvailable }}>
      {children}
    </ArciumContext.Provider>
  );
}
