/**
 * Hook for Helio subscriptions
 * Manage crypto subscriptions and recurring payments
 */

import { useState, useCallback, useEffect } from 'react';
import { Linking } from 'react-native';
import { useWalletStore } from '../../stores/walletStore';
import { helio, HelioSubscription, SubscriptionPlan } from '../../services/payments';
import { isMainnet } from '../../services/solana/connection';

// Helio API credentials
const HELIO_API_KEY = process.env.EXPO_PUBLIC_HELIO_API_KEY || '';
const HELIO_SECRET_KEY = process.env.HELIO_SECRET_KEY;

interface UseSubscriptionsReturn {
  // State
  isLoading: boolean;
  error: string | null;
  subscriptions: HelioSubscription[];
  plans: SubscriptionPlan[];

  // Actions
  fetchSubscriptions: () => Promise<void>;
  fetchPlans: () => Promise<void>;
  cancelSubscription: (id: string) => Promise<boolean>;
  openCheckout: (planId: string) => Promise<void>;

  // Helpers
  getActiveSubscriptions: () => HelioSubscription[];
  isSubscribedTo: (planId: string) => boolean;
  getNextRenewal: (subscription: HelioSubscription) => Date | null;
}

export function useSubscriptions(): UseSubscriptionsReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<HelioSubscription[]>([]);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);

  const { publicKey } = useWalletStore();

  // Initialize Helio on mount
  useEffect(() => {
    if (HELIO_API_KEY) {
      helio.initialize({
        apiKey: HELIO_API_KEY,
        secretKey: HELIO_SECRET_KEY,
        network: isMainnet() ? 'mainnet' : 'devnet',
      });
    }
  }, []);

  // Fetch subscriptions when wallet changes
  useEffect(() => {
    if (publicKey) {
      fetchSubscriptions();
    }
  }, [publicKey]);

  const fetchSubscriptions = useCallback(async () => {
    if (!publicKey) return;

    setIsLoading(true);
    setError(null);

    try {
      const subs = await helio.getSubscriptionsByWallet(publicKey);
      setSubscriptions(subs);
    } catch (err: any) {
      setError(err.message);
      console.error('[useSubscriptions] Fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  const fetchPlans = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const allPlans = await helio.getSubscriptionPlans();
      setPlans(allPlans);
    } catch (err: any) {
      setError(err.message);
      console.error('[useSubscriptions] Fetch plans error:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const cancelSubscription = useCallback(async (id: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      await helio.cancelSubscription(id);
      // Refresh subscriptions list
      await fetchSubscriptions();
      return true;
    } catch (err: any) {
      setError(err.message);
      console.error('[useSubscriptions] Cancel error:', err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [fetchSubscriptions]);

  const openCheckout = useCallback(async (planId: string) => {
    const url = helio.getCheckoutUrl({
      type: 'subscription',
      id: planId,
      walletAddress: publicKey || undefined,
      theme: 'dark',
    });

    try {
      await Linking.openURL(url);
    } catch (err: any) {
      setError(err.message);
      console.error('[useSubscriptions] Open checkout error:', err);
    }
  }, [publicKey]);

  const getActiveSubscriptions = useCallback(() => {
    return subscriptions.filter(s => s.status === 'ACTIVE');
  }, [subscriptions]);

  const isSubscribedTo = useCallback((planId: string) => {
    return subscriptions.some(
      s => s.planId === planId && s.status === 'ACTIVE'
    );
  }, [subscriptions]);

  const getNextRenewal = useCallback((subscription: HelioSubscription): Date | null => {
    if (subscription.status !== 'ACTIVE') return null;
    return new Date(subscription.renewalDate);
  }, []);

  return {
    isLoading,
    error,
    subscriptions,
    plans,
    fetchSubscriptions,
    fetchPlans,
    cancelSubscription,
    openCheckout,
    getActiveSubscriptions,
    isSubscribedTo,
    getNextRenewal,
  };
}
