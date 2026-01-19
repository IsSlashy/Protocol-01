/**
 * useSend - Send transaction logic with stealth support
 * @module hooks/wallet/useSend
 */

import { useState, useCallback, useMemo } from 'react';
import { useWallet } from './useWallet';
import { useBalance } from './useBalance';
import { useTransactions } from './useTransactions';
import { useNetwork } from '../common/useNetwork';
import { useHaptics } from '../common/useHaptics';

export interface SendParams {
  to: string;
  amount: string;
  tokenAddress?: string; // Native token if not provided
  isPrivate?: boolean; // Use stealth address
  note?: string;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface GasEstimate {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  estimatedFee: bigint;
  estimatedFeeFormatted: string;
  estimatedFeeUsd: number;
}

export type SendStep =
  | 'idle'
  | 'validating'
  | 'estimating_gas'
  | 'confirming'
  | 'signing'
  | 'broadcasting'
  | 'waiting_confirmation'
  | 'completed'
  | 'failed';

export interface SendState {
  step: SendStep;
  txHash?: string;
  error?: Error;
  gasEstimate?: GasEstimate;
}

interface UseSendReturn {
  state: SendState;
  isLoading: boolean;
  canSend: boolean;
  estimateGas: (params: SendParams) => Promise<GasEstimate | null>;
  validateAddress: (address: string) => { valid: boolean; type: 'address' | 'ens' | 'stealth' };
  validateAmount: (amount: string, tokenAddress?: string) => {
    valid: boolean;
    error?: string;
    maxAmount?: string;
  };
  send: (params: SendParams) => Promise<string | null>;
  reset: () => void;
}

// Address validation regex
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const ENS_REGEX = /^[a-zA-Z0-9-]+\.eth$/;
const STEALTH_META_REGEX = /^st:eth:0x[a-fA-F0-9]+$/;

export function useSend(): UseSendReturn {
  const [state, setState] = useState<SendState>({ step: 'idle' });

  const { wallet, status: walletStatus } = useWallet();
  const { balance } = useBalance({ address: wallet?.address ?? null });
  const { addPendingTransaction, updateTransaction } = useTransactions({
    address: wallet?.address ?? null,
  });
  const { isConnected, chainId } = useNetwork();
  const { trigger } = useHaptics();

  const isLoading = useMemo(() => {
    return !['idle', 'completed', 'failed'].includes(state.step);
  }, [state.step]);

  const canSend = useMemo(() => {
    return (
      walletStatus === 'unlocked' &&
      wallet !== null &&
      isConnected &&
      state.step === 'idle'
    );
  }, [walletStatus, wallet, isConnected, state.step]);

  const validateAddress = useCallback((
    address: string
  ): { valid: boolean; type: 'address' | 'ens' | 'stealth' } => {
    const trimmed = address.trim();

    if (ETH_ADDRESS_REGEX.test(trimmed)) {
      return { valid: true, type: 'address' };
    }

    if (ENS_REGEX.test(trimmed)) {
      return { valid: true, type: 'ens' };
    }

    if (STEALTH_META_REGEX.test(trimmed)) {
      return { valid: true, type: 'stealth' };
    }

    return { valid: false, type: 'address' };
  }, []);

  const validateAmount = useCallback((
    amount: string,
    tokenAddress?: string
  ): { valid: boolean; error?: string; maxAmount?: string } => {
    if (!balance) {
      return { valid: false, error: 'Balance not loaded' };
    }

    // Parse amount
    let parsedAmount: bigint;
    try {
      // Convert string to bigint (assuming 18 decimals for simplicity)
      const [integer, decimal = ''] = amount.split('.');
      const paddedDecimal = decimal.padEnd(18, '0').slice(0, 18);
      parsedAmount = BigInt(integer + paddedDecimal);
    } catch {
      return { valid: false, error: 'Invalid amount format' };
    }

    if (parsedAmount <= BigInt(0)) {
      return { valid: false, error: 'Amount must be greater than 0' };
    }

    // Check balance
    if (tokenAddress) {
      const token = balance.tokens.find(
        t => t.address.toLowerCase() === tokenAddress.toLowerCase()
      );
      if (!token) {
        return { valid: false, error: 'Token not found' };
      }
      if (parsedAmount > token.balance) {
        return {
          valid: false,
          error: 'Insufficient token balance',
          maxAmount: token.balanceFormatted,
        };
      }
    } else {
      // Native token - account for gas
      const estimatedGas = BigInt('50000000000000'); // ~0.00005 ETH placeholder
      if (parsedAmount + estimatedGas > balance.native) {
        const maxAmount = balance.native - estimatedGas;
        return {
          valid: false,
          error: 'Insufficient balance (including gas)',
          maxAmount: maxAmount > 0 ? balance.nativeFormatted : '0',
        };
      }
    }

    return { valid: true };
  }, [balance]);

  const estimateGas = useCallback(async (
    params: SendParams
  ): Promise<GasEstimate | null> => {
    setState(prev => ({ ...prev, step: 'estimating_gas' }));

    try {
      // In real implementation, call provider.estimateGas
      // and provider.getFeeData

      const gasLimit = BigInt(params.isPrivate ? 150000 : 21000);
      const maxFeePerGas = BigInt('30000000000'); // 30 gwei
      const maxPriorityFeePerGas = BigInt('2000000000'); // 2 gwei

      const estimatedFee = gasLimit * maxFeePerGas;
      const estimatedFeeFormatted = (Number(estimatedFee) / 1e18).toFixed(6);
      const estimatedFeeUsd = Number(estimatedFee) / 1e18 * 2500; // Placeholder ETH price

      const estimate: GasEstimate = {
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        estimatedFee,
        estimatedFeeFormatted,
        estimatedFeeUsd,
      };

      setState(prev => ({ ...prev, step: 'idle', gasEstimate: estimate }));
      return estimate;
    } catch (err) {
      setState({
        step: 'failed',
        error: err instanceof Error ? err : new Error('Gas estimation failed'),
      });
      return null;
    }
  }, []);

  const send = useCallback(async (
    params: SendParams
  ): Promise<string | null> => {
    if (!canSend || !wallet) {
      return null;
    }

    try {
      // Step 1: Validate
      setState({ step: 'validating' });

      const addressValidation = validateAddress(params.to);
      if (!addressValidation.valid) {
        throw new Error('Invalid recipient address');
      }

      const amountValidation = validateAmount(params.amount, params.tokenAddress);
      if (!amountValidation.valid) {
        throw new Error(amountValidation.error ?? 'Invalid amount');
      }

      // Step 2: Estimate gas
      setState({ step: 'estimating_gas' });
      const gasEstimate = await estimateGas(params);
      if (!gasEstimate) {
        throw new Error('Failed to estimate gas');
      }

      // Step 3: Wait for user confirmation (handled by UI)
      setState(prev => ({ ...prev, step: 'confirming', gasEstimate }));

      // In real app, this would wait for user to confirm in UI
      // For now, continue immediately

      // Step 4: Resolve recipient address
      let toAddress = params.to;
      if (addressValidation.type === 'ens') {
        // Resolve ENS - placeholder
        toAddress = '0x' + '1'.repeat(40);
      } else if (addressValidation.type === 'stealth' || params.isPrivate) {
        // Generate ephemeral stealth address
        // In real implementation, use stealth address library
        toAddress = '0x' + '2'.repeat(40);
      }

      // Step 5: Sign transaction
      setState(prev => ({ ...prev, step: 'signing' }));

      // In real implementation, sign with wallet
      // const signedTx = await wallet.signTransaction(tx);

      // Step 6: Broadcast
      setState(prev => ({ ...prev, step: 'broadcasting' }));

      // Placeholder tx hash
      const txHash = '0x' + Math.random().toString(16).slice(2).padEnd(64, '0');

      // Add to pending transactions
      addPendingTransaction({
        hash: txHash,
        type: params.isPrivate ? 'stealth_send' : 'send',
        from: wallet.address,
        to: toAddress,
        value: BigInt(parseFloat(params.amount) * 1e18),
        valueFormatted: params.amount,
        tokenAddress: params.tokenAddress,
        isPrivate: params.isPrivate ?? false,
        note: params.note,
      });

      // Step 7: Wait for confirmation
      setState(prev => ({ ...prev, step: 'waiting_confirmation', txHash }));

      // In real implementation, wait for tx receipt
      // const receipt = await provider.waitForTransaction(txHash);

      // Simulate confirmation delay
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Update transaction status
      updateTransaction(txHash, {
        status: 'confirmed',
        confirmations: 1,
        blockNumber: 12345678,
      });

      // Step 8: Complete
      setState({ step: 'completed', txHash });
      trigger('success');

      return txHash;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Transaction failed');
      setState({ step: 'failed', error });
      trigger('error');
      return null;
    }
  }, [
    canSend,
    wallet,
    validateAddress,
    validateAmount,
    estimateGas,
    addPendingTransaction,
    updateTransaction,
    trigger,
  ]);

  const reset = useCallback(() => {
    setState({ step: 'idle' });
  }, []);

  return {
    state,
    isLoading,
    canSend,
    estimateGas,
    validateAddress,
    validateAmount,
    send,
    reset,
  };
}
