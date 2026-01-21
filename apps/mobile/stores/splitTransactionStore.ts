/**
 * Split Transaction Store
 *
 * Manages split transactions, their execution schedule, and background processing.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';

import {
  TransactionSplitter,
  SplitTransaction,
  SplitPart,
  SplitConfig,
  DEFAULT_SPLIT_CONFIG,
} from '@/services/privacy/transactionSplitter';

// Background task name
const SPLIT_FORWARD_TASK = 'SPLIT_FORWARD_TASK';

interface SplitTransactionState {
  // State
  activeSplits: SplitTransaction[];
  completedSplits: SplitTransaction[];
  config: SplitConfig;
  isProcessing: boolean;
  error: string | null;

  // Actions
  setConfig: (config: Partial<SplitConfig>) => void;
  createSplit: (
    recipientAddress: string,
    amount: number,
    senderSecretKey: Uint8Array
  ) => Promise<SplitTransaction>;
  executeSplit: (
    splitId: string,
    senderSecretKey: Uint8Array,
    onProgress?: (message: string, progress: number) => void
  ) => Promise<void>;
  processScheduledForwards: (senderSecretKey: Uint8Array) => Promise<void>;
  cancelSplit: (splitId: string) => void;
  clearCompleted: () => void;
  getSplitById: (splitId: string) => SplitTransaction | undefined;
}

export const useSplitTransactionStore = create<SplitTransactionState>()(
  persist(
    (set, get) => ({
      // Initial state
      activeSplits: [],
      completedSplits: [],
      config: DEFAULT_SPLIT_CONFIG,
      isProcessing: false,
      error: null,

      // Set configuration
      setConfig: (newConfig) => {
        set(state => ({
          config: { ...state.config, ...newConfig },
        }));
      },

      // Create a new split transaction
      createSplit: async (recipientAddress, amount, senderSecretKey) => {
        const { config } = get();

        set({ isProcessing: true, error: null });

        try {
          const { Keypair } = await import('@solana/web3.js');
          const senderKeypair = Keypair.fromSecretKey(senderSecretKey);
          const splitter = new TransactionSplitter(senderKeypair);

          const splitTx = await splitter.prepareSplit(
            recipientAddress,
            amount,
            config
          );

          set(state => ({
            activeSplits: [...state.activeSplits, splitTx],
            isProcessing: false,
          }));

          return splitTx;

        } catch (error) {
          set({
            isProcessing: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      // Execute a split transaction (fund temp wallets and start schedule)
      executeSplit: async (splitId, senderSecretKey, onProgress) => {
        const { activeSplits } = get();
        const splitTx = activeSplits.find(s => s.id === splitId);

        if (!splitTx) {
          throw new Error('Split transaction not found');
        }

        set({ isProcessing: true, error: null });

        try {
          const { Keypair } = await import('@solana/web3.js');
          const senderKeypair = Keypair.fromSecretKey(senderSecretKey);
          const splitter = new TransactionSplitter(senderKeypair);

          // Phase 1: Fund all temp wallets
          onProgress?.('Funding temporary wallets...', 0);

          const updatedSplit = await splitter.fundTempWallets(
            splitTx,
            (part, index) => {
              const progress = ((index + 1) / splitTx.parts.length) * 50;
              onProgress?.(`Funded part ${index + 1}/${splitTx.parts.length}`, progress);

              // Update state
              set(state => ({
                activeSplits: state.activeSplits.map(s =>
                  s.id === splitId ? { ...splitTx } : s
                ),
              }));
            }
          );

          onProgress?.('All temp wallets funded. Waiting for scheduled delivery...', 50);

          // Schedule notification for first forward
          const firstPart = updatedSplit.parts.find(p => p.status === 'funded');
          if (firstPart) {
            await scheduleForwardNotification(updatedSplit, firstPart);
          }

          // Update state
          set(state => ({
            activeSplits: state.activeSplits.map(s =>
              s.id === splitId ? updatedSplit : s
            ),
            isProcessing: false,
          }));

          // Register background task
          await registerBackgroundTask();

        } catch (error) {
          set({
            isProcessing: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },

      // Process any scheduled forwards that are due
      processScheduledForwards: async (senderSecretKey) => {
        const { activeSplits } = get();

        if (activeSplits.length === 0) return;

        const { Keypair } = await import('@solana/web3.js');
        const senderKeypair = Keypair.fromSecretKey(senderSecretKey);

        for (const splitTx of activeSplits) {
          if (splitTx.status !== 'in_progress') continue;

          const splitter = new TransactionSplitter(senderKeypair);
          const nextPart = splitter.getNextScheduledPart(splitTx);

          if (nextPart) {
            try {
              const partIndex = splitTx.parts.findIndex(p => p.id === nextPart.id);
              await splitter.forwardPart(splitTx, partIndex);

              // Check if completed
              if (splitter.isCompleted(splitTx)) {
                await splitter.cleanup(splitTx);

                // Move to completed
                set(state => ({
                  activeSplits: state.activeSplits.filter(s => s.id !== splitTx.id),
                  completedSplits: [...state.completedSplits, splitTx],
                }));

                // Notify completion
                await sendCompletionNotification(splitTx);
              } else {
                // Update state and schedule next notification
                set(state => ({
                  activeSplits: state.activeSplits.map(s =>
                    s.id === splitTx.id ? { ...splitTx } : s
                  ),
                }));

                const next = splitter.getNextScheduledPart(splitTx);
                if (next) {
                  await scheduleForwardNotification(splitTx, next);
                }
              }
            } catch (error) {
              console.error('[SplitStore] Forward failed:', error);
            }
          }
        }
      },

      // Cancel a split (only if not yet executed)
      cancelSplit: (splitId) => {
        set(state => ({
          activeSplits: state.activeSplits.filter(s => s.id !== splitId),
        }));
      },

      // Clear completed splits
      clearCompleted: () => {
        set({ completedSplits: [] });
      },

      // Get split by ID
      getSplitById: (splitId) => {
        const { activeSplits, completedSplits } = get();
        return (
          activeSplits.find(s => s.id === splitId) ||
          completedSplits.find(s => s.id === splitId)
        );
      },
    }),
    {
      name: 'p01-split-transactions',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);

/**
 * Schedule a notification for the next forward
 */
async function scheduleForwardNotification(
  splitTx: SplitTransaction,
  part: SplitPart
): Promise<void> {
  try {
    const delay = Math.max(0, part.scheduledTime - Date.now());

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Split Transfer Progress',
        body: `Part ${splitTx.parts.indexOf(part) + 1}/${splitTx.parts.length} will be delivered (${part.amount.toFixed(4)} SOL)`,
        data: { splitId: splitTx.id, partId: part.id },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(1, Math.floor(delay / 1000)),
      },
    });
  } catch (error) {
    console.error('[SplitStore] Failed to schedule notification:', error);
  }
}

/**
 * Send completion notification
 */
async function sendCompletionNotification(
  splitTx: SplitTransaction
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Split Transfer Complete',
        body: `All ${splitTx.parts.length} parts delivered (${splitTx.totalAmount.toFixed(4)} SOL total)`,
        data: { splitId: splitTx.id },
      },
      trigger: null, // Immediate
    });
  } catch (error) {
    console.error('[SplitStore] Failed to send completion notification:', error);
  }
}

/**
 * Register background task for processing forwards
 */
async function registerBackgroundTask(): Promise<void> {
  try {
    await BackgroundFetch.registerTaskAsync(SPLIT_FORWARD_TASK, {
      minimumInterval: 15 * 60, // 15 minutes
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch (error) {
    console.error('[SplitStore] Failed to register background task:', error);
  }
}

/**
 * Define the background task
 */
TaskManager.defineTask(SPLIT_FORWARD_TASK, async () => {
  try {
    // Note: In production, we'd need to securely retrieve the keypair
    // This is a simplified version - real implementation would use
    // secure storage and biometric auth
    console.log('[SplitStore] Background task running...');

    // Return success - actual processing happens when user opens app
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (error) {
    console.error('[SplitStore] Background task failed:', error);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export default useSplitTransactionStore;
