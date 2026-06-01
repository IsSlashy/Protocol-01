/**
 * License store — persists the subscription license keys minted at subscribe
 * time so the user can re-copy them (the popup closes between sessions).
 *
 * Keyed by `${retailer}:${mode}` so re-subscribing to the same merchant in the
 * same mode overwrites rather than duplicates.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { LicenseMode } from '../services/license';

export interface LicenseEntry {
  licenseKey: string;
  retailer: string; // base58
  mode: LicenseMode;
  serviceName?: string;
  createdAt: number;
}

interface LicenseState {
  licenses: Record<string, LicenseEntry>;
  saveLicense: (entry: LicenseEntry) => void;
  getLicense: (retailer: string, mode: LicenseMode) => LicenseEntry | null;
  reset: () => void;
}

const keyOf = (retailer: string, mode: LicenseMode) => `${retailer}:${mode}`;

export const useLicenseStore = create<LicenseState>()(
  persist(
    (set, get) => ({
      licenses: {},
      saveLicense: (entry) => {
        set((state) => ({
          licenses: { ...state.licenses, [keyOf(entry.retailer, entry.mode)]: entry },
        }));
      },
      getLicense: (retailer, mode) => get().licenses[keyOf(retailer, mode)] ?? null,
      reset: () => set({ licenses: {} }),
    }),
    {
      name: 'p01-licenses',
      storage: createJSONStorage(() => ({
        getItem: async (name: string) => {
          const r = await chrome.storage.local.get(name);
          return r[name] || null;
        },
        setItem: async (name: string, value: string) => {
          await chrome.storage.local.set({ [name]: value });
        },
        removeItem: async (name: string) => {
          await chrome.storage.local.remove(name);
        },
      })),
    },
  ),
);
