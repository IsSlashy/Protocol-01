import { useContext, useCallback, useState } from 'react';
import { PrivacyContext } from './provider';
import type { PrivacySDK } from '../client';
import type {
  ShieldParams,
  UnshieldParams,
  PrivateTransferParams,
  ShieldReceipt,
  UnshieldReceipt,
  TransferReceipt,
  StealthSendParams,
  StealthSendReceipt,
  StealthPayment,
  StealthScanOptions,
  StealthClaimReceipt,
  ConfidentialDepositParams,
  ConfidentialTransferParams,
  ConfidentialWithdrawParams,
  ConfidentialBalanceResult,
  CreateStreamParams,
  StreamReceipt,
  StreamInfo,
  CreateSubscriptionParams,
  SubscriptionReceipt,
  SubscriptionInfo,
  CreateVaultParams,
  VaultReceipt,
  VaultDepositParams,
  VaultWithdrawParams,
  RegisterParams,
  RegistryEntry,
  RelayJobParams,
  RelayJobReceipt,
  TxResult,
  TokenSymbol,
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

/** Shield, unshield, and private transfer hooks */
export function useShield() {
  const sdk = useSDK();

  const [shield, shieldState] = useAsyncAction(
    useCallback((params: ShieldParams) => sdk.shield.shield(params), [sdk]),
  );
  const [unshield, unshieldState] = useAsyncAction(
    useCallback((params: UnshieldParams) => sdk.shield.unshield(params), [sdk]),
  );
  const [transfer, transferState] = useAsyncAction(
    useCallback((params: PrivateTransferParams) => sdk.shield.transfer(params), [sdk]),
  );
  const [getBalance, balanceState] = useAsyncAction(
    useCallback((token: TokenSymbol) => sdk.shield.getShieldedBalance(token), [sdk]),
  );

  return {
    shield, shieldState,
    unshield, unshieldState,
    transfer, transferState,
    getBalance, balanceState,
  };
}

/** Stealth address hooks */
export function useStealth() {
  const sdk = useSDK();

  const [generateMetaAddress, metaAddressState] = useAsyncAction(
    useCallback(() => sdk.stealth.generateMetaAddress(), [sdk]),
  );
  const [send, sendState] = useAsyncAction(
    useCallback((params: StealthSendParams) => sdk.stealth.send(params), [sdk]),
  );
  const [scan, scanState] = useAsyncAction(
    useCallback(
      (viewingKey: Uint8Array, spendingPubKey: Uint8Array, options?: StealthScanOptions) =>
        sdk.stealth.scan(viewingKey, spendingPubKey, options),
      [sdk],
    ),
  );
  const [claim, claimState] = useAsyncAction(
    useCallback(
      (payment: StealthPayment, spendingKey: Uint8Array, viewingKey: Uint8Array) =>
        sdk.stealth.claim(payment, spendingKey, viewingKey),
      [sdk],
    ),
  );

  return {
    generateMetaAddress, metaAddressState,
    send, sendState,
    scan, scanState,
    claim, claimState,
  };
}

/** Confidential balance hooks */
export function useConfidential() {
  const sdk = useSDK();

  const [deposit, depositState] = useAsyncAction(
    useCallback((params: ConfidentialDepositParams) => sdk.confidential.deposit(params), [sdk]),
  );
  const [transfer, transferState] = useAsyncAction(
    useCallback((params: ConfidentialTransferParams) => sdk.confidential.transfer(params), [sdk]),
  );
  const [withdraw, withdrawState] = useAsyncAction(
    useCallback((params: ConfidentialWithdrawParams) => sdk.confidential.withdraw(params), [sdk]),
  );
  const [getBalance, balanceState] = useAsyncAction(
    useCallback((token: TokenSymbol) => sdk.confidential.getBalance(token), [sdk]),
  );

  return {
    deposit, depositState,
    transfer, transferState,
    withdraw, withdrawState,
    getBalance, balanceState,
  };
}

/** Payment stream hooks */
export function useStreams() {
  const sdk = useSDK();

  const [create, createState] = useAsyncAction(
    useCallback((params: CreateStreamParams) => sdk.streams.create(params), [sdk]),
  );
  const [withdraw, withdrawState] = useAsyncAction(
    useCallback((address: PublicKey) => sdk.streams.withdraw(address), [sdk]),
  );
  const [cancel, cancelState] = useAsyncAction(
    useCallback((address: PublicKey) => sdk.streams.cancel(address), [sdk]),
  );
  const [getStream, streamState] = useAsyncAction(
    useCallback((address: PublicKey) => sdk.streams.getStream(address), [sdk]),
  );
  const [listStreams, listState] = useAsyncAction(
    useCallback((role: 'sender' | 'recipient') => sdk.streams.listStreams(role), [sdk]),
  );

  return {
    create, createState,
    withdraw, withdrawState,
    cancel, cancelState,
    getStream, streamState,
    listStreams, listState,
  };
}

/** Subscription hooks */
export function useSubscriptions() {
  const sdk = useSDK();

  const [create, createState] = useAsyncAction(
    useCallback((params: CreateSubscriptionParams) => sdk.subscriptions.create(params), [sdk]),
  );
  const [cancel, cancelState] = useAsyncAction(
    useCallback((address: PublicKey) => sdk.subscriptions.cancel(address), [sdk]),
  );
  const [pause, pauseState] = useAsyncAction(
    useCallback((address: PublicKey) => sdk.subscriptions.pause(address), [sdk]),
  );
  const [resume, resumeState] = useAsyncAction(
    useCallback((address: PublicKey) => sdk.subscriptions.resume(address), [sdk]),
  );

  return {
    create, createState,
    cancel, cancelState,
    pause, pauseState,
    resume, resumeState,
  };
}

/** Quantum-safe vault hooks */
export function useVault() {
  const sdk = useSDK();

  const [create, createState] = useAsyncAction(
    useCallback((params: CreateVaultParams) => sdk.vault.create(params), [sdk]),
  );
  const [deposit, depositState] = useAsyncAction(
    useCallback((params: VaultDepositParams) => sdk.vault.deposit(params), [sdk]),
  );
  const [withdraw, withdrawState] = useAsyncAction(
    useCallback((params: VaultWithdrawParams) => sdk.vault.withdraw(params), [sdk]),
  );

  return {
    create, createState,
    deposit, depositState,
    withdraw, withdrawState,
  };
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

