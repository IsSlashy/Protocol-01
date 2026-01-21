/**
 * RealtimeSyncService - WebSocket-based real-time subscription sync
 *
 * Connects to Solana WebSocket to listen for new subscription events.
 * When a new subscription is detected:
 * - Syncs the subscription to local store (streamStore)
 * - Updates UI
 */

import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { getConnection } from '../solana/connection';
import { syncFromBlockchain, loadStreams, Stream } from '../solana/streams';
import { useStreamStore } from '../../stores/streamStore';

// ============ Types ============

export type SyncStatus = 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error';

export interface SyncEvent {
  type: 'subscription_added' | 'subscription_updated' | 'sync_complete' | 'error';
  data?: Stream | { newStreams: number; updatedStreams: number };
  error?: string;
  timestamp: number;
}

export interface RealtimeSyncConfig {
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnection delay in ms (default: 3000) */
  reconnectDelay?: number;
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Enable push notifications (default: false for Expo Go compatibility) */
  enableNotifications?: boolean;
  /** Sync interval for periodic checks in ms (default: 60000) */
  syncInterval?: number;
}

type SyncEventListener = (event: SyncEvent) => void;

// ============ Constants ============

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PREFIX = 'P01_SUB_V1:';

const DEFAULT_CONFIG: Required<RealtimeSyncConfig> = {
  autoReconnect: true,
  reconnectDelay: 3000,
  maxReconnectAttempts: 5,
  enableNotifications: true, // Will fail silently in Expo Go
  syncInterval: 300000, // 5 minutes (increased to avoid rate limits)
};

// ============ RealtimeSyncService ============

export class RealtimeSyncService {
  private walletAddress: string | null = null;
  private connection: Connection | null = null;
  private subscriptionId: number | null = null;
  private status: SyncStatus = 'disconnected';
  private config: Required<RealtimeSyncConfig>;
  private reconnectAttempts: number = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private syncIntervalId: NodeJS.Timeout | null = null;
  private listeners: Set<SyncEventListener> = new Set();
  private knownStreamIds: Set<string> = new Set();
  private isStarting: boolean = false;

  constructor(config: RealtimeSyncConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============ Public Methods ============

  /**
   * Start the real-time sync service
   */
  async start(walletAddress: string): Promise<void> {
    if (this.isStarting) {
      console.log('[RealtimeSync] Already starting, ignoring duplicate call');
      return;
    }

    if (this.status === 'connected' && this.walletAddress === walletAddress) {
      console.log('[RealtimeSync] Already connected to same wallet');
      return;
    }

    this.isStarting = true;

    try {
      // Stop any existing connection first
      if (this.status !== 'disconnected') {
        await this.stop();
      }

      this.walletAddress = walletAddress;
      this.setStatus('connecting');

      console.log('[RealtimeSync] Starting sync service for wallet:', walletAddress);

      // Load existing streams to track known IDs
      await this.loadKnownStreams();

      // Initialize connection
      this.connection = getConnection();

      // Request notification permissions
      if (this.config.enableNotifications) {
        await this.requestNotificationPermissions();
      }

      // Subscribe to account logs for memo program activity
      await this.subscribeToLogs();

      // Start periodic sync interval
      this.startPeriodicSync();

      // Perform initial sync
      await this.performSync();

      this.setStatus('connected');
      this.reconnectAttempts = 0;

      console.log('[RealtimeSync] Service started successfully');
    } catch (error) {
      console.error('[RealtimeSync] Failed to start:', error);
      this.setStatus('error');
      this.emitEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to start sync service',
        timestamp: Date.now(),
      });
      this.scheduleReconnect();
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Stop the real-time sync service
   */
  async stop(): Promise<void> {
    console.log('[RealtimeSync] Stopping sync service...');

    // Clear reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Clear sync interval
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    // Unsubscribe from logs
    if (this.subscriptionId !== null && this.connection) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch (error) {
        console.warn('[RealtimeSync] Error removing logs listener:', error);
      }
      this.subscriptionId = null;
    }

    this.connection = null;
    this.walletAddress = null;
    this.knownStreamIds.clear();
    this.setStatus('disconnected');

    console.log('[RealtimeSync] Service stopped');
  }

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Get connected wallet address
   */
  getWalletAddress(): string | null {
    return this.walletAddress;
  }

  /**
   * Add event listener
   */
  addEventListener(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: SyncEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Force a manual sync
   */
  async forceSync(): Promise<{ newStreams: number; updatedStreams: number }> {
    if (!this.walletAddress) {
      throw new Error('No wallet connected');
    }

    return this.performSync();
  }

  // ============ Private Methods ============

  private setStatus(status: SyncStatus): void {
    this.status = status;
    console.log('[RealtimeSync] Status changed:', status);
  }

  private emitEvent(event: SyncEvent): void {
    this.listeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        console.error('[RealtimeSync] Error in event listener:', error);
      }
    });
  }

  private async loadKnownStreams(): Promise<void> {
    try {
      const streams = await loadStreams();
      this.knownStreamIds = new Set(streams.map(s => s.id));
      console.log('[RealtimeSync] Loaded', this.knownStreamIds.size, 'known streams');
    } catch (error) {
      console.warn('[RealtimeSync] Failed to load known streams:', error);
    }
  }

  private async requestNotificationPermissions(): Promise<void> {
    try {
      // Dynamic import to avoid crash in Expo Go
      const Notifications = await import('expo-notifications');
      const { status: existingStatus } = await Notifications.getPermissionsAsync();

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') {
          console.warn('[RealtimeSync] Notification permissions not granted');
        }
      }
    } catch (error) {
      // Silently fail in Expo Go
      console.log('[RealtimeSync] Notifications not available (Expo Go)');
    }
  }

  private async subscribeToLogs(): Promise<void> {
    if (!this.connection || !this.walletAddress) {
      throw new Error('Connection or wallet not initialized');
    }

    const pubkey = new PublicKey(this.walletAddress);

    // Subscribe to logs mentioning the wallet address
    this.subscriptionId = this.connection.onLogs(
      pubkey,
      (logs: Logs, context: Context) => {
        this.handleLogs(logs, context);
      },
      'confirmed'
    );

    console.log('[RealtimeSync] Subscribed to logs, subscription ID:', this.subscriptionId);
  }

  private async handleLogs(logs: Logs, context: Context): Promise<void> {
    try {
      // Check if this log contains memo program activity
      const hasMemoActivity = logs.logs.some(
        log => log.includes(MEMO_PROGRAM_ID) || log.includes('Program log: Memo')
      );

      if (!hasMemoActivity) {
        return;
      }

      // Check for subscription memo in logs
      const hasSubscriptionMemo = logs.logs.some(
        log => log.includes(MEMO_PREFIX) || log.includes('P01_SUB')
      );

      if (hasSubscriptionMemo) {
        console.log('[RealtimeSync] Detected subscription activity, triggering sync...');
        // Delay sync slightly to allow transaction to be confirmed
        setTimeout(() => this.performSync(), 2000);
      }
    } catch (error) {
      console.error('[RealtimeSync] Error handling logs:', error);
    }
  }

  private async performSync(): Promise<{ newStreams: number; updatedStreams: number }> {
    if (!this.walletAddress) {
      return { newStreams: 0, updatedStreams: 0 };
    }

    this.setStatus('syncing');

    try {
      console.log('[RealtimeSync] Performing sync...');

      // Sync from blockchain
      const result = await syncFromBlockchain(this.walletAddress);

      console.log('[RealtimeSync] Sync result:', result);

      // Refresh the stream store (don't pass wallet to avoid double sync)
      const streamStore = useStreamStore.getState();
      await streamStore.refresh(); // Just reload local data, sync already done above

      // Check for new streams and send notifications
      if (result.newStreams > 0) {
        const streams = await loadStreams();
        const newStreams = streams.filter(s => !this.knownStreamIds.has(s.id));

        for (const stream of newStreams) {
          this.knownStreamIds.add(stream.id);

          // Send notification for new subscription
          if (this.config.enableNotifications) {
            await this.sendSubscriptionNotification(stream);
          }

          // Emit event
          this.emitEvent({
            type: 'subscription_added',
            data: stream,
            timestamp: Date.now(),
          });
        }
      }

      // Emit sync complete event
      this.emitEvent({
        type: 'sync_complete',
        data: result,
        timestamp: Date.now(),
      });

      this.setStatus('connected');
      return result;
    } catch (error) {
      console.error('[RealtimeSync] Sync failed:', error);
      this.setStatus('error');
      this.emitEvent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Sync failed',
        timestamp: Date.now(),
      });
      return { newStreams: 0, updatedStreams: 0 };
    }
  }

  private async sendSubscriptionNotification(stream: Stream): Promise<void> {
    try {
      // Dynamic import to avoid crash in Expo Go
      const Notifications = await import('expo-notifications');
      const intervalDisplay = this.formatFrequency(stream.frequency, stream.customIntervalDays);

      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Nouvel abonnement ajouté',
          body: `${stream.name} - ${stream.amountPerPayment.toFixed(4)} SOL/${intervalDisplay}`,
          data: {
            subscriptionId: stream.id,
            type: 'subscription_added',
          },
          sound: true,
        },
        trigger: null,
      });

      console.log('[RealtimeSync] Notification sent for subscription:', stream.name);
    } catch (error) {
      // Silently fail in Expo Go
      console.log('[RealtimeSync] New subscription (notif unavailable):', stream.name);
    }
  }

  private formatFrequency(frequency: string, customDays?: number): string {
    switch (frequency) {
      case 'daily':
        return 'jour';
      case 'weekly':
        return 'semaine';
      case 'biweekly':
        return '2 semaines';
      case 'monthly':
        return 'mois';
      case 'custom':
        return `${customDays || 1} jours`;
      default:
        return frequency;
    }
  }

  private startPeriodicSync(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
    }

    this.syncIntervalId = setInterval(() => {
      if (this.status === 'connected' && this.walletAddress) {
        console.log('[RealtimeSync] Periodic sync triggered');
        this.performSync().catch(err => {
          console.error('[RealtimeSync] Periodic sync failed:', err);
        });
      }
    }, this.config.syncInterval);

    console.log('[RealtimeSync] Periodic sync started, interval:', this.config.syncInterval, 'ms');
  }

  private scheduleReconnect(): void {
    if (!this.config.autoReconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.log('[RealtimeSync] Max reconnection attempts reached');
      this.emitEvent({
        type: 'error',
        error: 'Max reconnection attempts reached',
        timestamp: Date.now(),
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * this.reconnectAttempts;

    console.log(`[RealtimeSync] Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimeout = setTimeout(async () => {
      if (this.walletAddress && this.status !== 'connected') {
        console.log('[RealtimeSync] Attempting reconnection...');
        await this.start(this.walletAddress);
      }
    }, delay);
  }
}

// ============ Singleton Instance ============

let instance: RealtimeSyncService | null = null;

/**
 * Get the singleton RealtimeSyncService instance
 */
export function getRealtimeSyncService(config?: RealtimeSyncConfig): RealtimeSyncService {
  if (!instance) {
    instance = new RealtimeSyncService(config);
  }
  return instance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetRealtimeSyncService(): void {
  if (instance) {
    instance.stop();
    instance = null;
  }
}

export default RealtimeSyncService;
