/**
 * useAgent - AI Agent state and capabilities
 * @module hooks/agent/useAgent
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';
import { useWallet } from '../wallet/useWallet';
import { useNetwork } from '../common/useNetwork';

export type AgentStatus =
  | 'idle'         // Ready for commands
  | 'listening'    // Waiting for user input
  | 'thinking'     // Processing request
  | 'executing'    // Performing action
  | 'confirming'   // Waiting for user confirmation
  | 'error'        // Error state
  | 'disabled';    // Agent disabled

export type AgentCapability =
  | 'send_transaction'
  | 'stealth_send'
  | 'create_stream'
  | 'manage_stream'
  | 'check_balance'
  | 'price_lookup'
  | 'contact_lookup'
  | 'explain_transaction'
  | 'gas_estimation'
  | 'schedule_payment';

export interface AgentSettings {
  enabled: boolean;
  voiceEnabled: boolean;
  autoConfirm: boolean;
  autoConfirmLimit: bigint; // Max amount to auto-confirm
  allowedCapabilities: AgentCapability[];
  language: string;
  personality: 'professional' | 'friendly' | 'minimal';
}

export interface AgentState {
  status: AgentStatus;
  lastActivity: number;
  currentTask?: string;
  pendingConfirmation?: PendingConfirmation;
  errorMessage?: string;
}

export interface PendingConfirmation {
  id: string;
  type: 'transaction' | 'stream' | 'permission';
  summary: string;
  details: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_SETTINGS: AgentSettings = {
  enabled: true,
  voiceEnabled: false,
  autoConfirm: false,
  autoConfirmLimit: BigInt(0),
  allowedCapabilities: [
    'check_balance',
    'price_lookup',
    'contact_lookup',
    'explain_transaction',
    'gas_estimation',
  ],
  language: 'en',
  personality: 'friendly',
};

interface UseAgentReturn {
  state: AgentState;
  settings: AgentSettings;
  isEnabled: boolean;
  isReady: boolean;
  capabilities: AgentCapability[];
  updateSettings: (updates: Partial<AgentSettings>) => Promise<boolean>;
  enableAgent: () => Promise<boolean>;
  disableAgent: () => Promise<boolean>;
  resetAgent: () => void;
  confirmAction: (confirmationId: string) => Promise<boolean>;
  rejectAction: (confirmationId: string) => Promise<boolean>;
  hasCapability: (capability: AgentCapability) => boolean;
  grantCapability: (capability: AgentCapability) => Promise<boolean>;
  revokeCapability: (capability: AgentCapability) => Promise<boolean>;
}

export function useAgent(): UseAgentReturn {
  const [state, setState] = useState<AgentState>({
    status: 'idle',
    lastActivity: Date.now(),
  });

  const { wallet, status: walletStatus } = useWallet();
  const { isConnected } = useNetwork();

  const {
    value: settings,
    setValue: setSettings,
  } = useAsyncStorage<AgentSettings>({
    key: `${ASYNC_KEYS.SETTINGS}_agent`,
    defaultValue: DEFAULT_SETTINGS,
  });

  const currentSettings = settings ?? DEFAULT_SETTINGS;

  // Check if agent is ready to operate
  const isEnabled = currentSettings.enabled;
  const isReady = useMemo(() => {
    return (
      isEnabled &&
      walletStatus === 'unlocked' &&
      wallet !== null &&
      isConnected &&
      state.status !== 'disabled'
    );
  }, [isEnabled, walletStatus, wallet, isConnected, state.status]);

  // Update status based on dependencies
  useEffect(() => {
    if (!isEnabled) {
      setState(prev => ({ ...prev, status: 'disabled' }));
    } else if (!wallet || walletStatus !== 'unlocked') {
      setState(prev => ({
        ...prev,
        status: 'idle',
        errorMessage: 'Wallet not unlocked',
      }));
    } else if (!isConnected) {
      setState(prev => ({
        ...prev,
        status: 'idle',
        errorMessage: 'No network connection',
      }));
    } else if (state.status === 'disabled') {
      setState(prev => ({ ...prev, status: 'idle', errorMessage: undefined }));
    }
  }, [isEnabled, wallet, walletStatus, isConnected, state.status]);

  const updateSettings = useCallback(async (
    updates: Partial<AgentSettings>
  ): Promise<boolean> => {
    try {
      const newSettings = { ...currentSettings, ...updates };
      await setSettings(newSettings);
      return true;
    } catch {
      return false;
    }
  }, [currentSettings, setSettings]);

  const enableAgent = useCallback(async (): Promise<boolean> => {
    const success = await updateSettings({ enabled: true });
    if (success) {
      setState(prev => ({ ...prev, status: 'idle', errorMessage: undefined }));
    }
    return success;
  }, [updateSettings]);

  const disableAgent = useCallback(async (): Promise<boolean> => {
    const success = await updateSettings({ enabled: false });
    if (success) {
      setState(prev => ({
        ...prev,
        status: 'disabled',
        currentTask: undefined,
        pendingConfirmation: undefined,
      }));
    }
    return success;
  }, [updateSettings]);

  const resetAgent = useCallback(() => {
    setState({
      status: isEnabled ? 'idle' : 'disabled',
      lastActivity: Date.now(),
    });
  }, [isEnabled]);

  const confirmAction = useCallback(async (
    confirmationId: string
  ): Promise<boolean> => {
    if (!state.pendingConfirmation || state.pendingConfirmation.id !== confirmationId) {
      return false;
    }

    setState(prev => ({
      ...prev,
      status: 'executing',
      pendingConfirmation: undefined,
    }));

    // In real implementation, this would trigger the actual execution
    // through the useExecution hook

    setState(prev => ({
      ...prev,
      status: 'idle',
      lastActivity: Date.now(),
    }));

    return true;
  }, [state.pendingConfirmation]);

  const rejectAction = useCallback(async (
    confirmationId: string
  ): Promise<boolean> => {
    if (!state.pendingConfirmation || state.pendingConfirmation.id !== confirmationId) {
      return false;
    }

    setState(prev => ({
      ...prev,
      status: 'idle',
      pendingConfirmation: undefined,
      lastActivity: Date.now(),
    }));

    return true;
  }, [state.pendingConfirmation]);

  const hasCapability = useCallback((
    capability: AgentCapability
  ): boolean => {
    return currentSettings.allowedCapabilities.includes(capability);
  }, [currentSettings.allowedCapabilities]);

  const grantCapability = useCallback(async (
    capability: AgentCapability
  ): Promise<boolean> => {
    if (hasCapability(capability)) return true;

    const newCapabilities = [...currentSettings.allowedCapabilities, capability];
    return updateSettings({ allowedCapabilities: newCapabilities });
  }, [hasCapability, currentSettings.allowedCapabilities, updateSettings]);

  const revokeCapability = useCallback(async (
    capability: AgentCapability
  ): Promise<boolean> => {
    if (!hasCapability(capability)) return true;

    const newCapabilities = currentSettings.allowedCapabilities.filter(c => c !== capability);
    return updateSettings({ allowedCapabilities: newCapabilities });
  }, [hasCapability, currentSettings.allowedCapabilities, updateSettings]);

  return {
    state,
    settings: currentSettings,
    isEnabled,
    isReady,
    capabilities: currentSettings.allowedCapabilities,
    updateSettings,
    enableAgent,
    disableAgent,
    resetAgent,
    confirmAction,
    rejectAction,
    hasCapability,
    grantCapability,
    revokeCapability,
  };
}

// Export for external state updates
export function createPendingConfirmation(
  type: PendingConfirmation['type'],
  summary: string,
  details: Record<string, unknown>,
  expiresInSeconds: number = 60
): PendingConfirmation {
  const now = Date.now();
  return {
    id: `confirm_${now}_${Math.random().toString(36).substring(2, 9)}`,
    type,
    summary,
    details,
    createdAt: now,
    expiresAt: now + expiresInSeconds * 1000,
  };
}
