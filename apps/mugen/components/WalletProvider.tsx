'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface P01WalletState {
  connected: boolean;
  publicKey: string | null;
  shortAddress: string | null;
  connectionMethod: 'extension' | 'mobile' | null;
  extensionDetected: boolean;
}

interface P01WalletContextValue extends P01WalletState {
  connect: () => Promise<void>;
  connectViaQR: (walletAddress: string) => void;
  disconnect: () => void;
  showConnectModal: boolean;
  setShowConnectModal: (v: boolean) => void;
}

const P01WalletContext = createContext<P01WalletContextValue>({
  connected: false,
  publicKey: null,
  shortAddress: null,
  connectionMethod: null,
  extensionDetected: false,
  connect: async () => {},
  connectViaQR: () => {},
  disconnect: () => {},
  showConnectModal: false,
  setShowConnectModal: () => {},
});

export function useP01Wallet() {
  return useContext(P01WalletContext);
}

// ─── Provider ───────────────────────────────────────────────────────────────

export default function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<P01WalletState>(() => {
    // Restore from localStorage on mount
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('p01-wallet-connection');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.publicKey) {
            return {
              connected: false, // Will verify via silent connect
              publicKey: parsed.publicKey,
              shortAddress: `${parsed.publicKey.slice(0, 4)}...${parsed.publicKey.slice(-4)}`,
              connectionMethod: parsed.connectionMethod || null,
              extensionDetected: false,
            };
          }
        }
      } catch {}
    }
    return {
      connected: false,
      publicKey: null,
      shortAddress: null,
      connectionMethod: null,
      extensionDetected: false,
    };
  });
  const [showConnectModal, setShowConnectModal] = useState(false);

  // Detect P01 extension on mount + auto-reconnect
  useEffect(() => {
    const check = () => {
      const hasExtension = typeof window !== 'undefined' && !!(window as any).protocol01;
      setState((s) => ({ ...s, extensionDetected: hasExtension }));

      // Auto-reconnect if we had a previous extension connection
      if (hasExtension && !state.connected && state.publicKey) {
        const p01 = (window as any).protocol01;
        p01.connect({ onlyIfTrusted: true })
          .then((result: any) => {
            const pubkey = result.publicKey?.toString?.() || result.publicKey?.toBase58?.() || String(result.publicKey);
            setState({
              connected: true,
              publicKey: pubkey,
              shortAddress: `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`,
              connectionMethod: 'extension',
              extensionDetected: true,
            });
          })
          .catch(() => {
            // Extension present but not connected — clear stale state
            localStorage.removeItem('p01-wallet-connection');
            setState((s) => ({ ...s, connected: false, publicKey: null, shortAddress: null, connectionMethod: null }));
          });
      }
    };

    // Check immediately and after extension init event
    check();
    window.addEventListener('protocol01#initialized', check);
    // Fallback: check again after a short delay (extension may load after page)
    const timeout = setTimeout(check, 1500);

    return () => {
      window.removeEventListener('protocol01#initialized', check);
      clearTimeout(timeout);
    };
  }, []);

  // Connect via extension
  const connect = useCallback(async () => {
    const p01 = (window as any).protocol01;

    if (p01) {
      try {
        const result = await p01.connect();
        const pubkey = result.publicKey.toString?.() || result.publicKey.toBase58?.() || String(result.publicKey);
        setState({
          connected: true,
          publicKey: pubkey,
          shortAddress: `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`,
          connectionMethod: 'extension',
          extensionDetected: true,
        });
        localStorage.setItem('p01-wallet-connection', JSON.stringify({ publicKey: pubkey, connectionMethod: 'extension' }));
        setShowConnectModal(false);
      } catch (err) {
        console.error('[P01 Wallet] Extension connect failed:', err);
      }
    } else {
      setShowConnectModal(true);
    }
  }, []);

  // Connect via QR (called when session polling detects completion)
  const connectViaQR = useCallback((walletAddress: string) => {
    setState({
      connected: true,
      publicKey: walletAddress,
      shortAddress: `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`,
      connectionMethod: 'mobile',
      extensionDetected: state.extensionDetected,
    });
    localStorage.setItem('p01-wallet-connection', JSON.stringify({ publicKey: walletAddress, connectionMethod: 'mobile' }));
    setShowConnectModal(false);
  }, [state.extensionDetected]);

  const disconnect = useCallback(() => {
    const p01 = (window as any).protocol01;
    if (p01?.disconnect) {
      p01.disconnect().catch(() => {});
    }
    localStorage.removeItem('p01-wallet-connection');
    setState({
      connected: false,
      publicKey: null,
      shortAddress: null,
      connectionMethod: null,
      extensionDetected: state.extensionDetected,
    });
  }, [state.extensionDetected]);

  return (
    <P01WalletContext.Provider
      value={{
        ...state,
        connect,
        connectViaQR,
        disconnect,
        showConnectModal,
        setShowConnectModal,
      }}
    >
      {children}
    </P01WalletContext.Provider>
  );
}
