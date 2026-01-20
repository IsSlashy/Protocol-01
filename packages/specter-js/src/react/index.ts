/**
 * @specter/js React Hooks
 *
 * React integration for Specter Protocol.
 *
 * @example
 * ```tsx
 * import { SpecterProvider, useSpecter, useSubscription } from '@specter/js/react';
 *
 * function App() {
 *   return (
 *     <SpecterProvider>
 *       <PaymentPage />
 *     </SpecterProvider>
 *   );
 * }
 *
 * function PaymentPage() {
 *   const { connect, isConnected, publicKey } = useSpecter();
 *   const { subscribe, isLoading } = useSubscription();
 *
 *   return (
 *     <button onClick={() => subscribe({
 *       recipient: 'merchant',
 *       merchantName: 'Netflix',
 *       amount: 15.99,
 *       period: 'monthly',
 *     })}>
 *       Subscribe with Specter
 *     </button>
 *   );
 * }
 * ```
 */

export { SpecterProvider, useSpecter } from './provider';
export { useSubscription } from './use-subscription';
export { usePayment } from './use-payment';
export { PayButton } from './pay-button';
export { SubscribeButton } from './subscribe-button';
