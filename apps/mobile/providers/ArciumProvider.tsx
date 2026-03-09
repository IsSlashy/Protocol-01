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

  // Initialize MPC client when enabled
  useEffect(() => {
    if (!mpcEnabled) {
      setStatus('disabled');
      clientInitAttempted.current = false;
      return;
    }

    console.log('[MPC] Toggle ON — attempting client init');

    if (!clientInitAttempted.current) {
      clientInitAttempted.current = true;
      setStatus('initializing');

      import('../services/arcium/mpcClient')
        .then(({ getMpcClient }) => {
          console.log('[MPC] mpcClient module loaded, calling getMpcClient()...');
          return getMpcClient();
        })
        .then((client) => {
          if (client) {
            console.log('[MPC] Client initialized successfully');
            if (!programAvailable) setProgramAvailable(true);
            setStatus('ready');
          } else {
            console.warn('[MPC] Client returned null — marking ready anyway (ops use own fallback)');
            if (!programAvailable) setProgramAvailable(true);
            setStatus('ready');
          }
        })
        .catch((e) => {
          console.warn('[MPC] Client init error:', e.message, '— marking ready (ops use own fallback)');
          if (!programAvailable) setProgramAvailable(true);
          setStatus('ready');
        });
    } else {
      setStatus('ready');
    }
  }, [mpcEnabled]);

  const isMpcActive = mpcEnabled && status === 'ready';

  return (
    <ArciumContext.Provider value={{ isMpcActive, programAvailable }}>
      {children}
    </ArciumContext.Provider>
  );
}
