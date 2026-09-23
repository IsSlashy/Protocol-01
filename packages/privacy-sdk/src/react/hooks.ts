import { useContext, useCallback, useState } from 'react';
import { PrivacyContext } from './provider';
import type { PrivacySDK } from '../client';
import type {
  RegisterParams,
  RelayJobParams,
} from '../types';
import type { PublicKey } from '@solana/web3.js';

function useSDK(): PrivacySDK {
  const sdk = useContext(PrivacyContext);
  if (!sdk) {
    throw new Error('usePrivacy must be used within a <PrivacyProvider>');
  }
  return sdk;
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

function useAsyncAction<TParams extends any[], TResult>(
  fn: (...args: TParams) => Promise<TResult>,
): [(...args: TParams) => Promise<TResult>, AsyncState<TResult>] {
  const [state, setState] = useState<AsyncState<TResult>>({
    data: null,
    loading: false,
    error: null,
  });

  const execute = useCallback(async (...args: TParams): Promise<TResult> => {
    setState({ data: null, loading: true, error: null });
    try {
      const result = await fn(...args);
      setState({ data: result, loading: false, error: null });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setState({ data: null, loading: false, error });
      throw error;
    }
  }, [fn]);

  return [execute, state];
}

/** Access the full Privacy SDK instance */
export function usePrivacy(): PrivacySDK {
  return useSDK();
}

/** Stealth registry hooks */
export function useRegistry() {
  const sdk = useSDK();

  const [register, registerState] = useAsyncAction(
    useCallback((params: RegisterParams) => sdk.registry.register(params), [sdk]),
  );
  const [lookup, lookupState] = useAsyncAction(
    useCallback((wallet: PublicKey) => sdk.registry.lookup(wallet), [sdk]),
  );
  const [isRegistered, registeredState] = useAsyncAction(
    useCallback((wallet: PublicKey) => sdk.registry.isRegistered(wallet), [sdk]),
  );

  return {
    register, registerState,
    lookup, lookupState,
    isRegistered, registeredState,
  };
}

/** Privacy relay hooks */
export function useRelay() {
  const sdk = useSDK();

  const [submitJob, submitState] = useAsyncAction(
    useCallback((params: RelayJobParams) => sdk.relay.submitJob(params), [sdk]),
  );
  const [listRelayers, relayersState] = useAsyncAction(
    useCallback(() => sdk.relay.listRelayers(), [sdk]),
  );

  return {
    submitJob, submitState,
    listRelayers, relayersState,
  };
}

