import { useState, useCallback } from 'react';
import { useSpecter } from './provider';
import type { PaymentOptions, PaymentResult, SpecterError } from '../types';

interface UsePaymentReturn {
  pay: (options: PaymentOptions) => Promise<PaymentResult | null>;
  isLoading: boolean;
  error: SpecterError | null;
  lastPayment: PaymentResult | null;
}

/**
 * Hook for making one-time payments
 *
 * @example
 * ```tsx
 * function PaymentPage() {
 *   const { pay, isLoading, error, lastPayment } = usePayment();
 *
 *   const handlePay = async () => {
 *     const result = await pay({
 *       recipient: 'seller_wallet',
 *       amount: 25,
 *       token: 'USDC',
 *       private: true, // Use stealth address
 *     });
 *
 *     if (result) {
 *       console.log('Payment sent!', result.signature);
 *     }
 *   };
 *
 *   return (
 *     <button onClick={handlePay} disabled={isLoading}>
 *       {isLoading ? 'Sending...' : 'Pay $25'}
 *     </button>
 *   );
 * }
 * ```
 */
export function usePayment(): UsePaymentReturn {
  const { specter, isConnected, connect } = useSpecter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<SpecterError | null>(null);
  const [lastPayment, setLastPayment] = useState<PaymentResult | null>(null);

  const pay = useCallback(
    async (options: PaymentOptions): Promise<PaymentResult | null> => {
      setIsLoading(true);
      setError(null);

      try {
        // Connect if not connected
        if (!isConnected) {
          await connect();
        }

        const result = await specter.pay(options);
        setLastPayment(result);

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

  return {
    pay,
    isLoading,
    error,
    lastPayment,
  };
}
