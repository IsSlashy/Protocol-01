/**
 * License store: persists the subscription license keys minted at subscribe
 * time so the user can re-copy them (the popup closes between sessions), and
 * since 2026-09-02 also what it takes to REBUILD one.
 *
 * WHY A KEY CAN BE REBUILT
 * A private key is deterministic: `licenseKeyForPrivate(noteSecret, serviceTag)`
 * (services/license.ts). The note secret is already on disk, encrypted, in the
 * vault store under the vault PDA (FIX B in services/subscriptionVault.ts
 * wrote it there BEFORE the subscribe tx). The only other input is the service
 * tag, and nothing recorded it: the key itself used to be derived and saved
 * only after two more confirmed transactions, a getProgramAccounts and a
 * fetchVault, so a popup that closed in that window left a paid vault whose
 * commitment was on chain and no key anywhere. `vaultTags` closes that: the tag
 * is recorded the instant the vault may exist (just before the tx is sent),
 * and `deriveLicenseForVault` rebuilds the key on demand from the two inputs.
 *
 * `licenses` stays keyed by `${retailer}:${mode}` because SubscriptionDetails
 * reads it that way; a second subscription to the same merchant overwrites the
 * entry there but not its `vaultTags` record, so both keys stay presentable.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { licenseKeyForPrivate, type LicenseMode } from '../services/license';

export interface LicenseEntry {
  licenseKey: string;
  retailer: string; // base58
  mode: LicenseMode;
  serviceName?: string;
  createdAt: number;
  /** The vault PDA (base58) this key opens. Absent on entries minted before 2026-09-02. */
  vaultAddress?: string;
  /** The HKDF service tag the key was derived with (registry slug, else retailer). */
  serviceTag?: string;
}

/**
 * What the store needs to rebuild a vault's key without holding the key: the
 * tag. The note secret lives (encrypted) in the vault store under the same PDA.
 */
export interface VaultLicenseTag {
  vaultAddress: string;
  retailer: string;
  serviceTag: string;
  serviceName?: string;
  recordedAt: number;
  /**
   * When this device saw the subscribe tx confirmed and minted the key. Absent
   * means the tx was sent but its confirmation was never observed here (popup
   * closed, RPC timed out): the vault may or may not exist on chain.
   */
  confirmedAt?: number;
}

/** A key the device can hand over, minted or rebuilt. */
export interface PresentableLicense extends LicenseEntry {
  /** False when the key was rebuilt for a vault whose confirmation this device never saw. */
  confirmed: boolean;
}

interface LicenseState {
  licenses: Record<string, LicenseEntry>;
  vaultTags: Record<string, VaultLicenseTag>;
  /**
   * Persist a minted key. When the entry names its vault and tag, the matching
   * `vaultTags` record is written too and stamped confirmed, so a key minted
   * here is always rebuildable and always reads as confirmed.
   */
  saveLicense: (entry: LicenseEntry) => void;
  getLicense: (retailer: string, mode: LicenseMode) => LicenseEntry | null;
  /** Record the tag for a vault that is about to exist. Idempotent per vault. */
  recordVaultTag: (tag: Omit<VaultLicenseTag, 'recordedAt'>) => void;
  /**
   * Rebuild the key for a vault from its note secret and recorded tag. Null
   * when either is missing, or when the wallet is locked (the secret is
   * encrypted at rest and the session password is what decrypts it).
   */
  deriveLicenseForVault: (vaultAddress: string) => Promise<LicenseEntry | null>;
  /**
   * Every key this device can present: one per known vault (the minted entry
   * when it exists, else a rebuilt one), plus legacy entries minted before the
   * vault address was recorded. Newest first.
   */
  presentableLicenses: () => Promise<PresentableLicense[]>;
  reset: () => void;
}

const keyOf = (retailer: string, mode: LicenseMode) => `${retailer}:${mode}`;

export const useLicenseStore = create<LicenseState>()(
  persist(
    (set, get) => ({
      licenses: {},
      vaultTags: {},
      saveLicense: (entry) => {
        set((state) => {
          const licenses = { ...state.licenses, [keyOf(entry.retailer, entry.mode)]: entry };
          if (!entry.vaultAddress || !entry.serviceTag) return { licenses };
          const existing = state.vaultTags[entry.vaultAddress];
          const vaultTags = {
            ...state.vaultTags,
            [entry.vaultAddress]: {
              vaultAddress: entry.vaultAddress,
              retailer: entry.retailer,
              serviceTag: entry.serviceTag,
              serviceName: entry.serviceName ?? existing?.serviceName,
              recordedAt: existing?.recordedAt ?? entry.createdAt,
              confirmedAt: existing?.confirmedAt ?? entry.createdAt,
            },
          };
          return { licenses, vaultTags };
        });
      },
      getLicense: (retailer, mode) => get().licenses[keyOf(retailer, mode)] ?? null,
      recordVaultTag: (tag) => {
        set((state) => {
          const existing = state.vaultTags[tag.vaultAddress];
          return {
            vaultTags: {
              ...state.vaultTags,
              [tag.vaultAddress]: {
                ...existing,
                ...tag,
                recordedAt: existing?.recordedAt ?? Date.now(),
              },
            },
          };
        });
      },
      deriveLicenseForVault: async (vaultAddress) => {
        const tag = get().vaultTags[vaultAddress];
        if (!tag) return null;
        // Dynamic import: the vault store imports the vault service, which
        // imports this store. Resolving it lazily keeps the module graph acyclic.
        const { useSubscriptionVaultStore } = await import('./subscriptionVault');
        const secret = await useSubscriptionVaultStore.getState().getSecret(vaultAddress);
        if (!secret) return null;
        return {
          licenseKey: licenseKeyForPrivate(secret, tag.serviceTag),
          retailer: tag.retailer,
          mode: 'zk',
          serviceName: tag.serviceName,
          createdAt: tag.confirmedAt ?? tag.recordedAt,
          vaultAddress,
          serviceTag: tag.serviceTag,
        };
      },
      presentableLicenses: async () => {
        const { licenses, vaultTags, deriveLicenseForVault } = get();
        const minted = Object.values(licenses);
        const out: PresentableLicense[] = [];
        const tags = Object.values(vaultTags).sort((a, b) => b.recordedAt - a.recordedAt);
        for (const tag of tags) {
          const entry =
            minted.find((l) => l.vaultAddress === tag.vaultAddress) ??
            (await deriveLicenseForVault(tag.vaultAddress));
          if (entry) out.push({ ...entry, confirmed: tag.confirmedAt != null });
        }
        for (const l of minted) {
          if (!l.vaultAddress) out.push({ ...l, confirmed: true });
        }
        return out;
      },
      reset: () => set({ licenses: {}, vaultTags: {} }),
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
      partialize: (state) => ({ licenses: state.licenses, vaultTags: state.vaultTags }),
    },
  ),
);
