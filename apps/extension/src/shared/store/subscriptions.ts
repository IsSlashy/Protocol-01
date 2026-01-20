/**
 * Subscriptions Store - Stream Secure State Management
 *
 * Manages subscription state with Chrome storage persistence
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import {
  StreamSubscription,
  CreateSubscriptionParams,
  PaymentRecord,
  createSubscription as createSub,
  pauseSubscription as pauseSub,
  resumeSubscription as resumeSub,
  cancelSubscription as cancelSub,
  updateSubscription as updateSub,
  updateSubscriptionAfterPayment,
  calculateMonthlyCost,
  calculateYearlyCost,
  getDueSubscriptions,
  executeSubscriptionPayment,
} from '../services/stream';
import { NetworkType } from '../services/wallet';
import { Keypair } from '@solana/web3.js';

// ============ Types ============

export interface SubscriptionsState {
  // Data
  subscriptions: StreamSubscription[];
  isLoading: boolean;
  error: string | null;

  // Computed values
  activeCount: number;
  pausedCount: number;
  monthlyCost: number;
  yearlyCost: number;

  // Actions
  addSubscription: (params: CreateSubscriptionParams) => StreamSubscription;
  removeSubscription: (id: string) => void;
  pauseSubscription: (id: string) => void;
  resumeSubscription: (id: string) => void;
  cancelSubscription: (id: string) => void;
  updateSubscription: (
    id: string,
    updates: Partial<Pick<StreamSubscription, 'amount' | 'amountNoise' | 'timingNoise' | 'useStealthAddress'>>
  ) => void;

  // Payment processing
  processPayment: (id: string, keypair: Keypair, network: NetworkType) => Promise<string>;
  addPaymentRecord: (subscriptionId: string, payment: PaymentRecord) => void;

  // Queries
  getSubscription: (id: string) => StreamSubscription | undefined;
  getActiveSubscriptions: () => StreamSubscription[];
  getPausedSubscriptions: () => StreamSubscription[];
  getCancelledSubscriptions: () => StreamSubscription[];
  getDueSubscriptions: () => StreamSubscription[];
  getSubscriptionsByOrigin: (origin: string) => StreamSubscription[];

  // Utilities
  refreshComputedValues: () => void;
  clearError: () => void;
  setLoading: (loading: boolean) => void;
}

// ============ Store ============

export const useSubscriptionsStore = create<SubscriptionsState>()(
  persist(
    (set, get) => ({
      // Initial state
      subscriptions: [],
      isLoading: false,
      error: null,
      activeCount: 0,
      pausedCount: 0,
      monthlyCost: 0,
      yearlyCost: 0,

      // Add a new subscription
      addSubscription: (params: CreateSubscriptionParams) => {
        const subscription = createSub(params);

        set((state) => {
          const newSubscriptions = [...state.subscriptions, subscription];
          return {
            subscriptions: newSubscriptions,
            activeCount: newSubscriptions.filter(s => s.status === 'active').length,
            pausedCount: newSubscriptions.filter(s => s.status === 'paused').length,
            monthlyCost: calculateMonthlyCost(newSubscriptions),
            yearlyCost: calculateYearlyCost(newSubscriptions),
          };
        });

        return subscription;
      },

      // Remove a subscription completely
      removeSubscription: (id: string) => {
        set((state) => {
          const newSubscriptions = state.subscriptions.filter(s => s.id !== id);
          return {
            subscriptions: newSubscriptions,
            activeCount: newSubscriptions.filter(s => s.status === 'active').length,
            pausedCount: newSubscriptions.filter(s => s.status === 'paused').length,
            monthlyCost: calculateMonthlyCost(newSubscriptions),
            yearlyCost: calculateYearlyCost(newSubscriptions),
          };
        });
      },

      // Pause a subscription
      pauseSubscription: (id: string) => {
        set((state) => {
          const newSubscriptions = state.subscriptions.map(s =>
            s.id === id ? pauseSub(s) : s
          );
          return {
            subscriptions: newSubscriptions,
            activeCount: newSubscriptions.filter(s => s.status === 'active').length,
            pausedCount: newSubscriptions.filter(s => s.status === 'paused').length,
            monthlyCost: calculateMonthlyCost(newSubscriptions),
            yearlyCost: calculateYearlyCost(newSubscriptions),
          };
        });
      },

      // Resume a paused subscription
      resumeSubscription: (id: string) => {
        set((state) => {
          const newSubscriptions = state.subscriptions.map(s =>
            s.id === id ? resumeSub(s) : s
          );
          return {
            subscriptions: newSubscriptions,
            activeCount: newSubscriptions.filter(s => s.status === 'active').length,
            pausedCount: newSubscriptions.filter(s => s.status === 'paused').length,
            monthlyCost: calculateMonthlyCost(newSubscriptions),
            yearlyCost: calculateYearlyCost(newSubscriptions),
          };
        });
      },

      // Cancel a subscription (permanent)
      cancelSubscription: (id: string) => {
        set((state) => {
          const newSubscriptions = state.subscriptions.map(s =>
            s.id === id ? cancelSub(s) : s
          );
          return {
            subscriptions: newSubscriptions,
            activeCount: newSubscriptions.filter(s => s.status === 'active').length,
            pausedCount: newSubscriptions.filter(s => s.status === 'paused').length,
            monthlyCost: calculateMonthlyCost(newSubscriptions),
            yearlyCost: calculateYearlyCost(newSubscriptions),
          };
        });
      },

      // Update subscription settings
      updateSubscription: (id, updates) => {
        set((state) => {
          const newSubscriptions = state.subscriptions.map(s =>
            s.id === id ? updateSub(s, updates) : s
          );
          return {
            subscriptions: newSubscriptions,
            monthlyCost: calculateMonthlyCost(newSubscriptions),
            yearlyCost: calculateYearlyCost(newSubscriptions),
          };
        });
      },

      // Process a payment for a subscription
      processPayment: async (id: string, keypair: Keypair, network: NetworkType) => {
        const { subscriptions } = get();
        const sub = subscriptions.find(s => s.id === id);

        if (!sub) {
          throw new Error('Subscription not found');
        }

        if (sub.status !== 'active') {
          throw new Error('Subscription is not active');
        }

        set({ isLoading: true, error: null });

        try {
          const { signature, payment } = await executeSubscriptionPayment(sub, keypair, network);

          // Update subscription with payment record
          set((state) => {
            const newSubscriptions = state.subscriptions.map(s =>
              s.id === id ? updateSubscriptionAfterPayment(s, payment) : s
            );
            return {
              subscriptions: newSubscriptions,
              isLoading: false,
              monthlyCost: calculateMonthlyCost(newSubscriptions),
              yearlyCost: calculateYearlyCost(newSubscriptions),
            };
          });

          return signature;
        } catch (error) {
          set({
            isLoading: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      // Add a payment record manually (for background processing)
      addPaymentRecord: (subscriptionId: string, payment: PaymentRecord) => {
        set((state) => {
          const newSubscriptions = state.subscriptions.map(s =>
            s.id === subscriptionId ? updateSubscriptionAfterPayment(s, payment) : s
          );
          return {
            subscriptions: newSubscriptions,
            monthlyCost: calculateMonthlyCost(newSubscriptions),
            yearlyCost: calculateYearlyCost(newSubscriptions),
          };
        });
      },

      // Get a specific subscription
      getSubscription: (id: string) => {
        return get().subscriptions.find(s => s.id === id);
      },

      // Get active subscriptions
      getActiveSubscriptions: () => {
        return get().subscriptions.filter(s => s.status === 'active');
      },

      // Get paused subscriptions
      getPausedSubscriptions: () => {
        return get().subscriptions.filter(s => s.status === 'paused');
      },

      // Get cancelled subscriptions
      getCancelledSubscriptions: () => {
        return get().subscriptions.filter(s => s.status === 'cancelled');
      },

      // Get subscriptions that need payment processing
      getDueSubscriptions: () => {
        return getDueSubscriptions(get().subscriptions);
      },

      // Get subscriptions by dApp origin
      getSubscriptionsByOrigin: (origin: string) => {
        return get().subscriptions.filter(s => s.origin === origin);
      },

      // Refresh computed values
      refreshComputedValues: () => {
        set((state) => ({
          activeCount: state.subscriptions.filter(s => s.status === 'active').length,
          pausedCount: state.subscriptions.filter(s => s.status === 'paused').length,
          monthlyCost: calculateMonthlyCost(state.subscriptions),
          yearlyCost: calculateYearlyCost(state.subscriptions),
        }));
      },

      // Clear error
      clearError: () => {
        set({ error: null });
      },

      // Set loading state
      setLoading: (loading: boolean) => {
        set({ isLoading: loading });
      },
    }),
    {
      name: 'p01-subscriptions',
      storage: createJSONStorage(() => chromeStorage),
      partialize: (state) => ({
        // Only persist the subscriptions array
        subscriptions: state.subscriptions,
      }),
      onRehydrateStorage: () => {
        return (state) => {
          // Refresh computed values after rehydration
          if (state) {
            state.refreshComputedValues();
          }
        };
      },
    }
  )
);

// ============ Selectors ============

/**
 * Select subscription by ID
 */
export const selectSubscription = (id: string) => (state: SubscriptionsState) =>
  state.subscriptions.find(s => s.id === id);

/**
 * Select active subscriptions
 */
export const selectActiveSubscriptions = (state: SubscriptionsState) =>
  state.subscriptions.filter(s => s.status === 'active');

/**
 * Select subscriptions sorted by next payment
 */
export const selectSubscriptionsByNextPayment = (state: SubscriptionsState) =>
  [...state.subscriptions]
    .filter(s => s.status === 'active')
    .sort((a, b) => a.nextPayment - b.nextPayment);

/**
 * Select total payment history
 */
export const selectAllPayments = (state: SubscriptionsState) =>
  state.subscriptions.flatMap(s => s.payments).sort((a, b) => b.timestamp - a.timestamp);

/**
 * Select recent payments (last 30 days)
 */
export const selectRecentPayments = (state: SubscriptionsState) => {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return state.subscriptions
    .flatMap(s => s.payments)
    .filter(p => p.timestamp >= thirtyDaysAgo)
    .sort((a, b) => b.timestamp - a.timestamp);
};

// ============ Hooks ============

/**
 * Hook to get subscription statistics
 */
export function useSubscriptionStats() {
  const { subscriptions, activeCount, pausedCount, monthlyCost, yearlyCost } = useSubscriptionsStore();

  const totalPaid = subscriptions.reduce((sum, s) => sum + s.totalPaid, 0);
  const totalPayments = subscriptions.reduce((sum, s) => sum + s.paymentsMade, 0);

  // Next payment due
  const activeSubscriptions = subscriptions.filter(s => s.status === 'active');
  const nextDue = activeSubscriptions.length > 0
    ? Math.min(...activeSubscriptions.map(s => s.nextPayment))
    : null;

  return {
    total: subscriptions.length,
    activeCount,
    pausedCount,
    cancelledCount: subscriptions.filter(s => s.status === 'cancelled').length,
    monthlyCost,
    yearlyCost,
    totalPaid,
    totalPayments,
    nextDue,
  };
}
