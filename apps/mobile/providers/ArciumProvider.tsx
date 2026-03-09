/**
 * ArciumProvider — Lazy-init MPC privacy layer.
 *
 * Checks program availability on mount. When the user enables MPC in
 * Settings → Privacy, this provider initializes the Arcium client
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
    isArciumAvailable().then((available) => {
      if (!cancelled) setProgramAvailable(available);
    });
    return () => { cancelled = true; };
  }, []);

  // Initialize MPC client when enabled + program available
  useEffect(() => {
    if (!mpcEnabled) {
      setStatus('disabled');
      return;
    }
    if (!programAvailable) {
      setStatus('idle');
      return;
    }

    // Lazy-init the Arcium client (once per session)
    if (!clientInitAttempted.current) {
      clientInitAttempted.current = true;
      setStatus('initializing');

      import('../services/arcium/mpcClient')
        .then(({ getMpcClient }) => getMpcClient())
        .then((client) => {
          setStatus(client ? 'ready' : 'error', client ? undefined : 'Client init failed');
        })
        .catch((e) => {
          setStatus('error', e.message);
          console.warn('[ArciumProvider] Client init failed:', e.message);
        });
    } else {
      setStatus('ready');
    }
  }, [mpcEnabled, programAvailable]);

  const isMpcActive = mpcEnabled && programAvailable && status === 'ready';

  return (
    <ArciumContext.Provider value={{ isMpcActive, programAvailable }}>
      {children}
    </ArciumContext.Provider>
  );
}
