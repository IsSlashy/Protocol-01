import { createContext, useMemo, type ReactNode } from 'react';
import { PrivacySDK } from '../client';
import type { PrivacySDKConfig } from '../types';

export const PrivacyContext = createContext<PrivacySDK | null>(null);

export interface PrivacyProviderProps {
  config: PrivacySDKConfig;
  children: ReactNode;
}

/**
 * React context provider for the Privacy SDK.
 *
 * @example
 * ```tsx
 * import { PrivacyProvider } from '@protocol-01/privacy-sdk/react';
 *
 * function App() {
 *   return (
 *     <PrivacyProvider config={{ connection, wallet, network: 'devnet' }}>
 *       <MyComponent />
 *     </PrivacyProvider>
 *   );
 * }
 * ```
 */
export function PrivacyProvider({ config, children }: PrivacyProviderProps) {
  const sdk = useMemo(() => new PrivacySDK(config), [
    config.connection,
    config.wallet,
    config.network,
  ]);

  return (
    <PrivacyContext.Provider value={sdk}>
      {children}
    </PrivacyContext.Provider>
  );
}
