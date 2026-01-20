import { useState, useCallback } from 'react';
import { useSpecter } from './provider';
import type {
  SubscriptionOptions,
  SubscriptionResult,
  Subscription,
  SpecterError,
} from '../types';

interface UseSubscriptionReturn {
  subscribe: (options: SubscriptionOptions) => Promise<SubscriptionResult | null>;
  cancelSubscription: (id: string) => Promise<boolean>;
  getSubscriptions: () => Promise<Subscription[]>;
  subscriptions: Subscription[];
  isLoading: boolean;
  error: SpecterError | null;
}

/**
 * Hook for managing Stream Secure subscriptions
 *
 * @example
 * ```tsx
 * function SubscribePage() {
 *   const { subscribe, isLoading, error } = useSubscription();
 *
 *   const handleSubscribe = async () => {
 *     const result = await subscribe({
 *       recipient: 'merchant_wallet',
 *       merchantName: 'Netflix',
 *       amount: 15.99,
 *       period: 'monthly',
 *       maxPayments: 12,
 *     });
 *
 *     if (result) {
 *       console.log('Subscribed!', result.subscriptionId);
 *     }
 *   };
 *
 *   return (
 *     <button onClick={handleSubscribe} disabled={isLoading}>
 *       {isLoading ? 'Processing...' : 'Subscribe'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useSubscription(): UseSubscriptionReturn {
  const { specter, isConnected, connect } = useSpecter();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<SpecterError | null>(null);

  const subscribe = useCallback(
    async (options: SubscriptionOptions): Promise<SubscriptionResult | null> => {
      setIsLoading(true);
      setError(null);

      try {
        // Connect if not connected
        if (!isConnected) {
          await connect();
        }

        const result = await specter.subscribe(options);

        // Refresh subscriptions list
        const updated = await specter.getSubscriptions();
        setSubscriptions(updated);

        return result;
      } catch (err) {
        setError(err as SpecterError);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [specter, isConnected, connect]
  );

  const cancelSubscription = useCallback(
    async (subscriptionId: string): Promise<boolean> => {
      setIsLoading(true);
      setError(null);

      try {
        await specter.cancelSubscription(subscriptionId);

        // Refresh subscriptions list
        const updated = await specter.getSubscriptions();
        setSubscriptions(updated);

        return true;
      } catch (err) {
        setError(err as SpecterError);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [specter]
  );

  const getSubscriptions = useCallback(async (): Promise<Subscription[]> => {
    setIsLoading(true);
    setError(null);

    try {
      const subs = await specter.getSubscriptions();
      setSubscriptions(subs);
      return subs;
    } catch (err) {
      setError(err as SpecterError);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [specter]);

  return {
    subscribe,
    cancelSubscription,
    getSubscriptions,
    subscriptions,
    isLoading,
    error,
  };
}
