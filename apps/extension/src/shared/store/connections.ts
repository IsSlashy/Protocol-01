/**
 * Connected Sites Store
 *
 * Manages the list of dApps that have been authorized to connect to the wallet.
 * Persisted via chrome.storage.local for persistence across sessions.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import type { ConnectedDapp, DappPermission } from '../types';

export interface ConnectionsState {
  // Connected dApps indexed by origin
  connectedDapps: Record<string, ConnectedDapp>;

  // Actions
  addConnection: (dapp: ConnectedDapp) => void;
  removeConnection: (origin: string) => void;
  isConnected: (origin: string) => boolean;
  getConnection: (origin: string) => ConnectedDapp | null;
  hasPermission: (origin: string, permission: DappPermission) => boolean;
  updatePermissions: (origin: string, permissions: DappPermission[]) => void;
  getAllConnections: () => ConnectedDapp[];
  clearAllConnections: () => void;
}

export const useConnectionsStore = create<ConnectionsState>()(
  persist(
    (set, get) => ({
      connectedDapps: {},

      addConnection: (dapp: ConnectedDapp) => {
        set((state) => ({
          connectedDapps: {
            ...state.connectedDapps,
            [dapp.origin]: dapp,
          },
        }));
      },

      removeConnection: (origin: string) => {
        set((state) => {
          const { [origin]: _, ...rest } = state.connectedDapps;
          return { connectedDapps: rest };
        });
      },

      isConnected: (origin: string) => {
        return !!get().connectedDapps[origin];
      },

      getConnection: (origin: string) => {
        return get().connectedDapps[origin] || null;
      },

      hasPermission: (origin: string, permission: DappPermission) => {
        const dapp = get().connectedDapps[origin];
        return dapp?.permissions.includes(permission) ?? false;
      },

      updatePermissions: (origin: string, permissions: DappPermission[]) => {
        set((state) => {
          const dapp = state.connectedDapps[origin];
          if (!dapp) return state;

          return {
            connectedDapps: {
              ...state.connectedDapps,
              [origin]: {
                ...dapp,
                permissions,
              },
            },
          };
        });
      },

      getAllConnections: () => {
        return Object.values(get().connectedDapps);
      },

      clearAllConnections: () => {
        set({ connectedDapps: {} });
      },
    }),
    {
      name: 'p01-connections',
      storage: createJSONStorage(() => chromeStorage),
    }
  )
);

// ============ Helper functions for background script ============

/**
 * Get all connected sites from storage (for use in background script)
 */
export async function getConnectedSites(): Promise<Record<string, ConnectedDapp>> {
  try {
    const result = await chrome.storage.local.get('p01-connections');
    const data = result['p01-connections'];
    if (data) {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      return parsed.state?.connectedDapps || {};
    }
  } catch (error) {
    console.error('Failed to get connected sites:', error);
  }
  return {};
}

/**
 * Add a connected site to storage (for use in background script)
 */
export async function addConnectedSite(dapp: ConnectedDapp): Promise<void> {
  try {
    const sites = await getConnectedSites();
    sites[dapp.origin] = dapp;

    await chrome.storage.local.set({
      'p01-connections': JSON.stringify({
        state: { connectedDapps: sites },
        version: 0,
      }),
    });
  } catch (error) {
    console.error('Failed to add connected site:', error);
    throw error;
  }
}

/**
 * Remove a connected site from storage (for use in background script)
 */
export async function removeConnectedSite(origin: string): Promise<void> {
  try {
    const sites = await getConnectedSites();
    delete sites[origin];

    await chrome.storage.local.set({
      'p01-connections': JSON.stringify({
        state: { connectedDapps: sites },
        version: 0,
      }),
    });
  } catch (error) {
    console.error('Failed to remove connected site:', error);
    throw error;
  }
}

/**
 * Check if a site is connected (for use in background script)
 */
export async function isSiteConnected(origin: string): Promise<boolean> {
  const sites = await getConnectedSites();
  return !!sites[origin];
}

/**
 * Check if a site has a specific permission (for use in background script)
 */
export async function siteHasPermission(
  origin: string,
  permission: DappPermission
): Promise<boolean> {
  const sites = await getConnectedSites();
  const site = sites[origin];
  return site?.permissions.includes(permission) ?? false;
}
