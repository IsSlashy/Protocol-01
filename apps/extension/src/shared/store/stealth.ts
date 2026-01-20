/**
 * Stealth Store - Gestion de l'état des adresses stealth
 *
 * Stocke:
 * - Les clés stealth (chiffrées)
 * - La meta-address publiable
 * - Les paiements stealth détectés
 * - Les préférences stealth
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import { encrypt, decrypt, EncryptedData } from '../services/crypto';
import {
  StealthKeyPair,
  StealthPayment,
  generateStealthKeys,
  createMetaAddress,
  calculateStealthBalance,
  lamportsToSol,
  deriveSpendingKeyFromBase58,
} from '../services/stealth';
import { getConnection, NetworkType } from '../services/wallet';
import {
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

// =============================================================================
// TYPES
// =============================================================================

export interface StealthState {
  // État d'initialisation
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;

  // Clés stealth (chiffrées pour la persistance)
  encryptedStealthKeys: EncryptedData | null;

  // Meta-address publiable (pas sensible, peut être partagée)
  metaAddress: string | null;

  // Paiements stealth détectés
  payments: StealthPayment[];

  // Balance stealth totale (en lamports)
  stealthBalance: number;

  // Préférences
  stealthModeEnabled: boolean;
  autoScan: boolean;
  lastScanTimestamp: number | null;

  // Clés en mémoire (jamais persistées)
  _stealthKeys: StealthKeyPair | null;

  // Actions
  initializeStealth: (mnemonic: string, password: string) => Promise<void>;
  unlockStealth: (password: string) => Promise<boolean>;
  lockStealth: () => void;
  resetStealth: () => void;

  // Gestion des paiements
  addPayment: (payment: StealthPayment) => void;
  markPaymentClaimed: (paymentId: string, claimSignature: string) => void;
  removePayment: (paymentId: string) => void;
  syncPayments: (payments: StealthPayment[]) => void;

  // Claim
  claimPayment: (
    paymentId: string,
    destinationAddress: string,
    network: NetworkType
  ) => Promise<string>;

  // Préférences
  toggleStealthMode: () => void;
  toggleAutoScan: () => void;
  updateLastScan: () => void;

  // Utilitaires
  clearError: () => void;
  getStealthBalanceSol: () => number;
}

// =============================================================================
// STORE
// =============================================================================

export const useStealthStore = create<StealthState>()(
  persist(
    (set, get) => ({
      // État initial
      isInitialized: false,
      isLoading: false,
      error: null,
      encryptedStealthKeys: null,
      metaAddress: null,
      payments: [],
      stealthBalance: 0,
      stealthModeEnabled: false,
      autoScan: true,
      lastScanTimestamp: null,
      _stealthKeys: null,

      // =========================================================================
      // INITIALISATION ET AUTHENTIFICATION
      // =========================================================================

      /**
       * Initialise les clés stealth à partir du mnemonic
       * Doit être appelé après la création/import du wallet
       */
      initializeStealth: async (mnemonic: string, password: string) => {
        set({ isLoading: true, error: null });

        try {
          // Générer les clés stealth
          const stealthKeys = await generateStealthKeys(mnemonic);

          // Créer la meta-address
          const metaAddress = createMetaAddress(stealthKeys);

          // Sérialiser les clés pour le chiffrement
          const keysData = JSON.stringify({
            spendingKey: Array.from(stealthKeys.spendingKey),
            spendingPubKey: Array.from(stealthKeys.spendingPubKey),
            viewingKey: Array.from(stealthKeys.viewingKey),
            viewingPubKey: Array.from(stealthKeys.viewingPubKey),
          });

          // Chiffrer les clés
          const encryptedStealthKeys = await encrypt(keysData, password);

          set({
            isInitialized: true,
            isLoading: false,
            encryptedStealthKeys,
            metaAddress,
            _stealthKeys: stealthKeys,
          });
        } catch (error) {
          set({
            isLoading: false,
            error: (error as Error).message || 'Failed to initialize stealth keys',
          });
          throw error;
        }
      },

      /**
       * Déverrouille les clés stealth avec le mot de passe
       */
      unlockStealth: async (password: string) => {
        const { encryptedStealthKeys } = get();

        if (!encryptedStealthKeys) {
          set({ error: 'Stealth keys not initialized' });
          return false;
        }

        set({ isLoading: true, error: null });

        try {
          // Déchiffrer les clés
          const keysData = await decrypt(encryptedStealthKeys, password);
          const parsed = JSON.parse(keysData);

          // Reconstruire le StealthKeyPair
          const stealthKeys: StealthKeyPair = {
            spendingKey: new Uint8Array(parsed.spendingKey),
            spendingPubKey: new Uint8Array(parsed.spendingPubKey),
            viewingKey: new Uint8Array(parsed.viewingKey),
            viewingPubKey: new Uint8Array(parsed.viewingPubKey),
          };

          // Recalculer la balance
          const payments = get().payments;
          const stealthBalance = calculateStealthBalance(payments);

          set({
            isLoading: false,
            _stealthKeys: stealthKeys,
            stealthBalance,
          });

          return true;
        } catch (error) {
          set({
            isLoading: false,
            error: 'Failed to unlock stealth keys',
          });
          return false;
        }
      },

      /**
       * Verrouille les clés stealth (efface de la mémoire)
       */
      lockStealth: () => {
        set({
          _stealthKeys: null,
        });
      },

      /**
       * Réinitialise complètement l'état stealth
       */
      resetStealth: () => {
        set({
          isInitialized: false,
          isLoading: false,
          error: null,
          encryptedStealthKeys: null,
          metaAddress: null,
          payments: [],
          stealthBalance: 0,
          stealthModeEnabled: false,
          autoScan: true,
          lastScanTimestamp: null,
          _stealthKeys: null,
        });
      },

      // =========================================================================
      // GESTION DES PAIEMENTS
      // =========================================================================

      /**
       * Ajoute un nouveau paiement stealth détecté
       */
      addPayment: (payment: StealthPayment) => {
        const { payments } = get();

        // Vérifier que le paiement n'existe pas déjà
        if (payments.some((p) => p.id === payment.id)) {
          return;
        }

        const newPayments = [...payments, payment];
        const stealthBalance = calculateStealthBalance(newPayments);

        set({
          payments: newPayments,
          stealthBalance,
        });
      },

      /**
       * Marque un paiement comme réclamé
       */
      markPaymentClaimed: (paymentId: string, claimSignature: string) => {
        const { payments } = get();

        const newPayments = payments.map((p) =>
          p.id === paymentId
            ? { ...p, claimed: true, claimSignature }
            : p
        );

        const stealthBalance = calculateStealthBalance(newPayments);

        set({
          payments: newPayments,
          stealthBalance,
        });
      },

      /**
       * Supprime un paiement de la liste
       */
      removePayment: (paymentId: string) => {
        const { payments } = get();

        const newPayments = payments.filter((p) => p.id !== paymentId);
        const stealthBalance = calculateStealthBalance(newPayments);

        set({
          payments: newPayments,
          stealthBalance,
        });
      },

      /**
       * Synchronise les paiements (après un scan)
       */
      syncPayments: (newPayments: StealthPayment[]) => {
        const { payments: existingPayments } = get();

        // Créer un map des paiements existants
        const existingMap = new Map(existingPayments.map((p) => [p.id, p]));

        // Merger: garder l'état claimed des paiements existants
        const mergedPayments = newPayments.map((newPayment) => {
          const existing = existingMap.get(newPayment.id);
          if (existing) {
            return {
              ...newPayment,
              claimed: existing.claimed,
              claimSignature: existing.claimSignature,
            };
          }
          return newPayment;
        });

        // Ajouter les anciens paiements qui ne sont plus dans la liste (historique)
        const newIds = new Set(newPayments.map((p) => p.id));
        for (const existing of existingPayments) {
          if (!newIds.has(existing.id) && existing.claimed) {
            mergedPayments.push(existing);
          }
        }

        const stealthBalance = calculateStealthBalance(mergedPayments);

        set({
          payments: mergedPayments,
          stealthBalance,
          lastScanTimestamp: Date.now(),
        });
      },

      // =========================================================================
      // CLAIM (RÉCLAMATION DE FONDS)
      // =========================================================================

      /**
       * Réclame les fonds d'un paiement stealth
       */
      claimPayment: async (
        paymentId: string,
        destinationAddress: string,
        network: NetworkType
      ) => {
        const { payments, _stealthKeys } = get();

        if (!_stealthKeys) {
          throw new Error('Stealth keys not unlocked');
        }

        const payment = payments.find((p) => p.id === paymentId);
        if (!payment) {
          throw new Error('Payment not found');
        }

        if (payment.claimed) {
          throw new Error('Payment already claimed');
        }

        set({ isLoading: true, error: null });

        try {
          // Dériver la clé de dépense pour cette adresse stealth
          const stealthKeypair = await deriveSpendingKeyFromBase58(
            _stealthKeys,
            payment.ephemeralPubKey
          );

          // Créer la transaction de transfert
          const connection = getConnection(network);

          // Calculer le montant à envoyer (moins les frais)
          const estimatedFee = 5000; // ~5000 lamports pour une simple transaction
          const amountToSend = payment.amount - estimatedFee;

          if (amountToSend <= 0) {
            throw new Error('Payment amount too small to claim after fees');
          }

          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: stealthKeypair.publicKey,
              toPubkey: new (await import('@solana/web3.js')).PublicKey(destinationAddress),
              lamports: amountToSend,
            })
          );

          // Envoyer la transaction
          const signature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [stealthKeypair]
          );

          // Marquer comme réclamé
          get().markPaymentClaimed(paymentId, signature);

          set({ isLoading: false });

          return signature;
        } catch (error) {
          set({
            isLoading: false,
            error: (error as Error).message || 'Failed to claim payment',
          });
          throw error;
        }
      },

      // =========================================================================
      // PRÉFÉRENCES
      // =========================================================================

      /**
       * Active/désactive le mode stealth
       */
      toggleStealthMode: () => {
        set((state) => ({
          stealthModeEnabled: !state.stealthModeEnabled,
        }));
      },

      /**
       * Active/désactive le scan automatique
       */
      toggleAutoScan: () => {
        set((state) => ({
          autoScan: !state.autoScan,
        }));
      },

      /**
       * Met à jour le timestamp du dernier scan
       */
      updateLastScan: () => {
        set({ lastScanTimestamp: Date.now() });
      },

      // =========================================================================
      // UTILITAIRES
      // =========================================================================

      /**
       * Efface l'erreur actuelle
       */
      clearError: () => {
        set({ error: null });
      },

      /**
       * Retourne la balance stealth en SOL
       */
      getStealthBalanceSol: () => {
        const { stealthBalance } = get();
        return lamportsToSol(stealthBalance);
      },
    }),
    {
      name: 'p01-stealth',
      storage: createJSONStorage(() => chromeStorage),
      // Ne persister que les données nécessaires (pas les clés en mémoire)
      partialize: (state) => ({
        isInitialized: state.isInitialized,
        encryptedStealthKeys: state.encryptedStealthKeys,
        metaAddress: state.metaAddress,
        payments: state.payments,
        stealthBalance: state.stealthBalance,
        stealthModeEnabled: state.stealthModeEnabled,
        autoScan: state.autoScan,
        lastScanTimestamp: state.lastScanTimestamp,
      }),
    }
  )
);

// =============================================================================
// SÉLECTEURS
// =============================================================================

/**
 * Sélecteur pour obtenir les paiements non réclamés
 */
export const selectUnclaimedPayments = (state: StealthState): StealthPayment[] => {
  return state.payments.filter((p) => !p.claimed);
};

/**
 * Sélecteur pour obtenir les paiements réclamés
 */
export const selectClaimedPayments = (state: StealthState): StealthPayment[] => {
  return state.payments.filter((p) => p.claimed);
};

/**
 * Sélecteur pour le nombre de paiements en attente
 */
export const selectPendingPaymentsCount = (state: StealthState): number => {
  return state.payments.filter((p) => !p.claimed).length;
};
