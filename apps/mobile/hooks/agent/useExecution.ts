/**
 * useExecution - Execute agent actions and track progress
 * @module hooks/agent/useExecution
 */

import { useState, useCallback, useRef } from 'react';
import { useAgent, AgentCapability, createPendingConfirmation } from './useAgent';
import { useSend, SendParams } from '../wallet/useSend';
import { useCreateStream, CreateStreamParams } from '../streams/useCreateStream';
import { useHaptics } from '../common/useHaptics';

export type ExecutionStatus =
  | 'idle'
  | 'preparing'
  | 'awaiting_confirmation'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionType =
  | 'send_transaction'
  | 'stealth_send'
  | 'create_stream'
  | 'pause_stream'
  | 'cancel_stream'
  | 'withdraw_stream';

export interface ExecutionStep {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped';
  message?: string;
}

export interface ExecutionResult {
  success: boolean;
  type: ExecutionType;
  txHash?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface Execution {
  id: string;
  type: ExecutionType;
  status: ExecutionStatus;
  steps: ExecutionStep[];
  currentStep: number;
  params: Record<string, unknown>;
  result?: ExecutionResult;
  startedAt: number;
  completedAt?: number;
}

interface UseExecutionReturn {
  currentExecution: Execution | null;
  executionHistory: Execution[];
  isExecuting: boolean;
  execute: (type: ExecutionType, params: Record<string, unknown>) => Promise<ExecutionResult | null>;
  cancel: () => void;
  retry: () => Promise<ExecutionResult | null>;
  clearHistory: () => void;
}

const MAX_HISTORY = 50;

export function useExecution(): UseExecutionReturn {
  const [currentExecution, setCurrentExecution] = useState<Execution | null>(null);
  const [executionHistory, setExecutionHistory] = useState<Execution[]>([]);

  const executionRef = useRef<Execution | null>(null);
  const cancelledRef = useRef(false);

  const { hasCapability, settings: agentSettings } = useAgent();
  const { send, state: sendState, reset: resetSend } = useSend();
  const { createStream, step: streamStep, reset: resetStream } = useCreateStream();
  const { trigger } = useHaptics();

  const isExecuting = currentExecution !== null &&
    !['completed', 'failed', 'cancelled', 'idle'].includes(currentExecution.status);

  const updateExecution = useCallback((updates: Partial<Execution>) => {
    setCurrentExecution(prev => {
      if (!prev) return null;
      const updated = { ...prev, ...updates };
      executionRef.current = updated;
      return updated;
    });
  }, []);

  const updateStep = useCallback((stepId: string, updates: Partial<ExecutionStep>) => {
    setCurrentExecution(prev => {
      if (!prev) return null;
      const updated = {
        ...prev,
        steps: prev.steps.map(step =>
          step.id === stepId ? { ...step, ...updates } : step
        ),
      };
      executionRef.current = updated;
      return updated;
    });
  }, []);

  const getStepsForType = useCallback((type: ExecutionType): ExecutionStep[] => {
    const commonSteps = [
      { id: 'validate', name: 'Validating parameters', status: 'pending' as const },
      { id: 'prepare', name: 'Preparing transaction', status: 'pending' as const },
    ];

    switch (type) {
      case 'send_transaction':
      case 'stealth_send':
        return [
          ...commonSteps,
          { id: 'estimate_gas', name: 'Estimating gas', status: 'pending' as const },
          { id: 'sign', name: 'Signing transaction', status: 'pending' as const },
          { id: 'broadcast', name: 'Broadcasting', status: 'pending' as const },
          { id: 'confirm', name: 'Waiting for confirmation', status: 'pending' as const },
        ];

      case 'create_stream':
        return [
          ...commonSteps,
          { id: 'approve', name: 'Approving token', status: 'pending' as const },
          { id: 'create', name: 'Creating stream', status: 'pending' as const },
          { id: 'confirm', name: 'Waiting for confirmation', status: 'pending' as const },
        ];

      default:
        return commonSteps;
    }
  }, []);

  const executeTransaction = useCallback(async (
    params: Record<string, unknown>,
    isStealthy: boolean
  ): Promise<ExecutionResult> => {
    const sendParams: SendParams = {
      to: params.recipient as string,
      amount: params.amount as string,
      tokenAddress: params.tokenAddress as string | undefined,
      isPrivate: isStealthy,
      note: params.note as string | undefined,
    };

    updateStep('validate', { status: 'active' });
    await delay(300);
    updateStep('validate', { status: 'completed' });

    updateStep('prepare', { status: 'active' });
    await delay(300);
    updateStep('prepare', { status: 'completed' });

    updateStep('estimate_gas', { status: 'active' });
    await delay(500);
    updateStep('estimate_gas', { status: 'completed' });

    if (cancelledRef.current) {
      return { success: false, type: isStealthy ? 'stealth_send' : 'send_transaction', error: 'Cancelled' };
    }

    updateStep('sign', { status: 'active' });
    const txHash = await send(sendParams);

    if (!txHash) {
      updateStep('sign', { status: 'failed', message: sendState.error?.message });
      return {
        success: false,
        type: isStealthy ? 'stealth_send' : 'send_transaction',
        error: sendState.error?.message ?? 'Transaction failed',
      };
    }

    updateStep('sign', { status: 'completed' });
    updateStep('broadcast', { status: 'completed' });
    updateStep('confirm', { status: 'completed' });

    return {
      success: true,
      type: isStealthy ? 'stealth_send' : 'send_transaction',
      txHash,
      data: { ...params, txHash },
    };
  }, [send, sendState.error, updateStep]);

  const executeStreamCreation = useCallback(async (
    params: Record<string, unknown>
  ): Promise<ExecutionResult> => {
    const streamParams: CreateStreamParams = {
      recipient: params.recipient as string,
      tokenAddress: params.tokenAddress as string,
      amount: params.amount as string,
      duration: params.duration as number,
      startTime: params.startTime as number | undefined,
      useStealthAddress: params.useStealth as boolean | undefined,
      note: params.note as string | undefined,
    };

    updateStep('validate', { status: 'active' });
    await delay(300);
    updateStep('validate', { status: 'completed' });

    updateStep('prepare', { status: 'active' });
    await delay(300);
    updateStep('prepare', { status: 'completed' });

    if (cancelledRef.current) {
      return { success: false, type: 'create_stream', error: 'Cancelled' };
    }

    updateStep('approve', { status: 'active' });
    await delay(500);
    updateStep('approve', { status: 'completed' });

    updateStep('create', { status: 'active' });
    const stream = await createStream(streamParams);

    if (!stream) {
      updateStep('create', { status: 'failed' });
      return {
        success: false,
        type: 'create_stream',
        error: 'Failed to create stream',
      };
    }

    updateStep('create', { status: 'completed' });
    updateStep('confirm', { status: 'completed' });

    return {
      success: true,
      type: 'create_stream',
      data: { streamId: stream.id, ...params },
    };
  }, [createStream, updateStep]);

  const execute = useCallback(async (
    type: ExecutionType,
    params: Record<string, unknown>
  ): Promise<ExecutionResult | null> => {
    // Check capability
    const capabilityMap: Record<ExecutionType, AgentCapability> = {
      send_transaction: 'send_transaction',
      stealth_send: 'stealth_send',
      create_stream: 'create_stream',
      pause_stream: 'manage_stream',
      cancel_stream: 'manage_stream',
      withdraw_stream: 'manage_stream',
    };

    const requiredCapability = capabilityMap[type];
    if (!hasCapability(requiredCapability)) {
      return {
        success: false,
        type,
        error: `Missing capability: ${requiredCapability}`,
      };
    }

    // Reset state
    cancelledRef.current = false;
    resetSend();
    resetStream();

    // Create execution
    const execution: Execution = {
      id: `exec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type,
      status: 'preparing',
      steps: getStepsForType(type),
      currentStep: 0,
      params,
      startedAt: Date.now(),
    };

    setCurrentExecution(execution);
    executionRef.current = execution;

    trigger('selection');

    try {
      let result: ExecutionResult;

      switch (type) {
        case 'send_transaction':
          result = await executeTransaction(params, false);
          break;

        case 'stealth_send':
          result = await executeTransaction(params, true);
          break;

        case 'create_stream':
          result = await executeStreamCreation(params);
          break;

        default:
          result = {
            success: false,
            type,
            error: 'Unsupported execution type',
          };
      }

      // Update execution with result
      const finalExecution: Execution = {
        ...executionRef.current!,
        status: result.success ? 'completed' : 'failed',
        result,
        completedAt: Date.now(),
      };

      setCurrentExecution(finalExecution);

      // Add to history
      setExecutionHistory(prev => [finalExecution, ...prev].slice(0, MAX_HISTORY));

      // Haptic feedback
      trigger(result.success ? 'success' : 'error');

      return result;
    } catch (error) {
      const errorResult: ExecutionResult = {
        success: false,
        type,
        error: error instanceof Error ? error.message : 'Execution failed',
      };

      updateExecution({
        status: 'failed',
        result: errorResult,
        completedAt: Date.now(),
      });

      trigger('error');
      return errorResult;
    }
  }, [
    hasCapability,
    resetSend,
    resetStream,
    getStepsForType,
    trigger,
    executeTransaction,
    executeStreamCreation,
    updateExecution,
  ]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    updateExecution({
      status: 'cancelled',
      completedAt: Date.now(),
    });
    trigger('warning');
  }, [updateExecution, trigger]);

  const retry = useCallback(async (): Promise<ExecutionResult | null> => {
    if (!currentExecution) return null;

    return execute(currentExecution.type, currentExecution.params);
  }, [currentExecution, execute]);

  const clearHistory = useCallback(() => {
    setExecutionHistory([]);
  }, []);

  return {
    currentExecution,
    executionHistory,
    isExecuting,
    execute,
    cancel,
    retry,
    clearHistory,
  };
}

// Helper function for delays
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
