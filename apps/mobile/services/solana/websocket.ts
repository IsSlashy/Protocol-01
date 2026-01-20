/**
 * Solana WebSocket Listener Service
 *
 * Real-time transaction monitoring for subscription memos.
 * Listens for P01_SUB_V1: prefixed memos and emits events
 * when subscriptions are added, updated, or cancelled.
 */

import { PublicKey, Connection, Logs, Context } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { getCluster, type SolanaCluster } from './connection';
import type { Stream, StreamFrequency, StreamStatus } from './streams';

// ============ Constants ============

// Solana Memo Program ID
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Protocol prefixes for identifying P01 subscription memos
const MEMO_PREFIX = 'P01_SUB_V1:';
const UPDATE_PREFIX = 'P01_SUB_UPD:';

// WebSocket endpoints for each cluster
const WS_ENDPOINTS: Record<SolanaCluster, string> = {
  'devnet': 'wss://api.devnet.solana.com',
  'mainnet-beta': 'wss://api.mainnet-beta.solana.com',
  'testnet': 'wss://api.testnet.solana.com',
};

// Reconnection settings
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

// ============ Types ============

/**
 * Event types emitted by the WebSocket service
 */
export type WebSocketEventType =
  | 'subscription_added'
  | 'subscription_updated'
  | 'subscription_cancelled';

/**
 * Compact subscription format from on-chain storage
 */
interface OnChainSubscription {
  v: 1;                      // Version
  id: string;                // Subscription ID
  n: string;                 // Name
  r: string;                 // Recipient address
  a: number;                 // Amount (in token smallest unit)
  t?: string;                // Token mint (undefined = SOL)
  i: string;                 // Interval: 'd' | 'w' | 'm' | 'y'
  s: string;                 // Status: 'a' | 'p' | 'c' (active/paused/cancelled)
  np: number;                // Next payment timestamp (seconds)
  mp: number;                // Max payments (0 = unlimited)
  pm: number;                // Payments made
  c: number;                 // Created at timestamp (seconds)
  // Privacy settings
  an?: number;               // Amount noise %
  tn?: number;               // Timing noise hours
  st?: boolean;              // Use stealth address
  // Origin info
  o?: string;                // Origin URL
}

/**
 * Update memo format
 */
interface OnChainUpdate {
  id: string;                // Subscription ID
  s: string;                 // New status: 'a' | 'p' | 'c'
  u: number;                 // Update timestamp (seconds)
}

/**
 * Subscription event data
 */
export interface SubscriptionEvent {
  type: WebSocketEventType;
  subscription: Stream;
  signature: string;
  timestamp: number;
}

/**
 * WebSocket connection state
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

// ============ Conversion Maps ============

const INTERVAL_MAP: Record<string, StreamFrequency> = {
  d: 'daily',
  w: 'weekly',
  m: 'monthly',
  y: 'monthly', // Map yearly to monthly for mobile
};

const STATUS_MAP: Record<string, StreamStatus> = {
  a: 'active',
  p: 'paused',
  c: 'cancelled',
};

// ============ Conversion Functions ============

/**
 * Convert on-chain subscription to mobile Stream format
 */
function convertToStream(sub: OnChainSubscription, walletAddress: string): Stream {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const intervalMs: Record<string, number> = {
    d: DAY_MS,
    w: 7 * DAY_MS,
    m: 30 * DAY_MS,
    y: 365 * DAY_MS,
  };

  const frequency = INTERVAL_MAP[sub.i] || 'monthly';
  const status = STATUS_MAP[sub.s] || 'active';
  const nextPaymentDate = sub.np * 1000;
  const createdAt = sub.c * 1000;

  // Mobile uses different amount handling
  // Extension stores in lamports/smallest unit, mobile stores in SOL
  const decimals = sub.t ? 6 : 9; // USDC = 6, SOL = 9
  const amountInToken = sub.a / Math.pow(10, decimals);

  return {
    id: sub.id,
    name: sub.n,
    description: sub.o ? `Subscription from ${sub.o}` : undefined,
    recipientAddress: sub.r,
    recipientName: sub.n,
    totalAmount: sub.mp > 0 ? amountInToken * sub.mp : amountInToken * 12,
    amountPerPayment: amountInToken,
    frequency,
    startDate: createdAt,
    endDate: sub.mp > 0 ? createdAt + (intervalMs[sub.i] || DAY_MS * 30) * sub.mp : undefined,
    nextPaymentDate,
    amountStreamed: amountInToken * sub.pm,
    paymentsCompleted: sub.pm,
    totalPayments: sub.mp > 0 ? sub.mp : undefined,
    status,
    direction: 'outgoing',
    serviceName: sub.n,
    createdAt,
    updatedAt: Date.now(),
    paymentHistory: [],
  };
}

// ============ SolanaWebSocket Class ============

/**
 * WebSocket service for real-time Solana transaction monitoring
 */
export class SolanaWebSocket extends EventEmitter {
  private connection: Connection | null = null;
  private walletAddress: string | null = null;
  private subscriptionId: number | null = null;
  private logsSubscriptionId: number | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts: number = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isManualDisconnect: boolean = false;

  constructor() {
    super();
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Get WebSocket endpoint for current cluster
   */
  private getWsEndpoint(): string {
    const cluster = getCluster();
    return WS_ENDPOINTS[cluster];
  }

  /**
   * Connect to the Solana WebSocket
   */
  async connect(): Promise<void> {
    if (this.connectionState === 'connected' || this.connectionState === 'connecting') {
      console.log('[WebSocket] Already connected or connecting');
      return;
    }

    this.isManualDisconnect = false;
    this.connectionState = 'connecting';
    this.emit('state_change', this.connectionState);

    try {
      const wsEndpoint = this.getWsEndpoint();
      console.log(`[WebSocket] Connecting to ${wsEndpoint}...`);

      // Create connection with WebSocket commitment
      this.connection = new Connection(wsEndpoint, {
        commitment: 'confirmed',
        wsEndpoint: wsEndpoint,
      });

      // Verify connection is working by making a simple request
      await this.connection.getSlot();

      this.connectionState = 'connected';
      this.reconnectAttempts = 0;
      this.emit('state_change', this.connectionState);
      console.log('[WebSocket] Connected successfully');

      // Re-subscribe if we have a wallet address
      if (this.walletAddress) {
        await this.subscribe(this.walletAddress);
      }
    } catch (error) {
      console.error('[WebSocket] Connection failed:', error);
      this.connectionState = 'disconnected';
      this.emit('state_change', this.connectionState);
      this.emit('error', error);

      // Attempt reconnect
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the WebSocket
   */
  async disconnect(): Promise<void> {
    this.isManualDisconnect = true;

    // Clear any pending reconnect
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    await this.unsubscribe();

    this.connection = null;
    this.connectionState = 'disconnected';
    this.emit('state_change', this.connectionState);
    console.log('[WebSocket] Disconnected');
  }

  /**
   * Subscribe to account changes and transaction logs for a wallet
   */
  async subscribe(walletAddress: string): Promise<void> {
    if (!this.connection) {
      console.warn('[WebSocket] Cannot subscribe: not connected');
      return;
    }

    // Unsubscribe from previous wallet if any
    await this.unsubscribe();

    this.walletAddress = walletAddress;

    try {
      const pubkey = new PublicKey(walletAddress);

      // Subscribe to account changes
      console.log(`[WebSocket] Subscribing to account: ${walletAddress}`);
      this.subscriptionId = this.connection.onAccountChange(
        pubkey,
        (accountInfo, context) => {
          console.log('[WebSocket] Account changed:', context.slot);
          this.emit('account_change', { accountInfo, context });
        },
        'confirmed'
      );

      // Subscribe to transaction logs mentioning this wallet
      console.log(`[WebSocket] Subscribing to logs for: ${walletAddress}`);
      this.logsSubscriptionId = this.connection.onLogs(
        pubkey,
        (logs, context) => {
          this.handleLogs(logs, context);
        },
        'confirmed'
      );

      console.log(`[WebSocket] Subscribed with IDs: account=${this.subscriptionId}, logs=${this.logsSubscriptionId}`);
    } catch (error) {
      console.error('[WebSocket] Subscription failed:', error);
      this.emit('error', error);
    }
  }

  /**
   * Unsubscribe from current wallet
   */
  async unsubscribe(): Promise<void> {
    if (!this.connection) return;

    try {
      if (this.subscriptionId !== null) {
        await this.connection.removeAccountChangeListener(this.subscriptionId);
        console.log(`[WebSocket] Unsubscribed from account: ${this.subscriptionId}`);
        this.subscriptionId = null;
      }

      if (this.logsSubscriptionId !== null) {
        await this.connection.removeOnLogsListener(this.logsSubscriptionId);
        console.log(`[WebSocket] Unsubscribed from logs: ${this.logsSubscriptionId}`);
        this.logsSubscriptionId = null;
      }
    } catch (error) {
      console.error('[WebSocket] Unsubscribe error:', error);
    }
  }

  /**
   * Handle incoming transaction logs
   */
  private async handleLogs(logs: Logs, context: Context): Promise<void> {
    const { signature, logs: logMessages, err } = logs;

    if (err) {
      console.log(`[WebSocket] Transaction ${signature} failed:`, err);
      return;
    }

    // Look for memo program logs
    for (const log of logMessages) {
      // Check for P01 subscription memo
      if (log.includes(MEMO_PREFIX)) {
        await this.handleSubscriptionMemo(log, signature);
      }
      // Check for P01 update memo
      else if (log.includes(UPDATE_PREFIX)) {
        await this.handleUpdateMemo(log, signature);
      }
    }
  }

  /**
   * Parse and handle subscription creation memo
   */
  private async handleSubscriptionMemo(log: string, signature: string): Promise<void> {
    try {
      // Extract the JSON part from the log
      const prefixIndex = log.indexOf(MEMO_PREFIX);
      if (prefixIndex === -1) return;

      const jsonStr = log.slice(prefixIndex + MEMO_PREFIX.length);
      const sub = JSON.parse(jsonStr) as OnChainSubscription;

      if (!this.walletAddress) {
        console.warn('[WebSocket] No wallet address set');
        return;
      }

      const stream = convertToStream(sub, this.walletAddress);

      const event: SubscriptionEvent = {
        type: 'subscription_added',
        subscription: stream,
        signature,
        timestamp: Date.now(),
      };

      console.log(`[WebSocket] New subscription detected: ${stream.name}`);
      this.emit('subscription_added', event);
      this.emit('subscription_event', event);
    } catch (error) {
      console.error('[WebSocket] Failed to parse subscription memo:', error);
    }
  }

  /**
   * Parse and handle subscription update memo
   */
  private async handleUpdateMemo(log: string, signature: string): Promise<void> {
    try {
      // Extract the JSON part from the log
      const prefixIndex = log.indexOf(UPDATE_PREFIX);
      if (prefixIndex === -1) return;

      const jsonStr = log.slice(prefixIndex + UPDATE_PREFIX.length);
      const update = JSON.parse(jsonStr) as OnChainUpdate;

      const status = STATUS_MAP[update.s] || 'active';

      // Determine event type based on status
      let eventType: WebSocketEventType;
      if (update.s === 'c') {
        eventType = 'subscription_cancelled';
      } else {
        eventType = 'subscription_updated';
      }

      // Create a partial stream for the update
      const partialStream: Stream = {
        id: update.id,
        name: '',
        recipientAddress: '',
        totalAmount: 0,
        amountPerPayment: 0,
        frequency: 'monthly',
        startDate: 0,
        nextPaymentDate: 0,
        amountStreamed: 0,
        paymentsCompleted: 0,
        status,
        direction: 'outgoing',
        createdAt: 0,
        updatedAt: update.u * 1000,
        paymentHistory: [],
      };

      const event: SubscriptionEvent = {
        type: eventType,
        subscription: partialStream,
        signature,
        timestamp: Date.now(),
      };

      console.log(`[WebSocket] Subscription ${eventType}: ${update.id}`);
      this.emit(eventType, event);
      this.emit('subscription_event', event);
    } catch (error) {
      console.error('[WebSocket] Failed to parse update memo:', error);
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.isManualDisconnect) {
      console.log('[WebSocket] Manual disconnect - not reconnecting');
      return;
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[WebSocket] Max reconnect attempts reached');
      this.emit('max_reconnects_reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * Math.min(this.reconnectAttempts, 5);

    console.log(`[WebSocket] Scheduling reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

    this.connectionState = 'reconnecting';
    this.emit('state_change', this.connectionState);

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Reset reconnect counter (call when connection is stable)
   */
  resetReconnectCounter(): void {
    this.reconnectAttempts = 0;
  }
}

// ============ Singleton Instance ============

let websocketInstance: SolanaWebSocket | null = null;

/**
 * Get the singleton WebSocket instance
 */
export function getSolanaWebSocket(): SolanaWebSocket {
  if (!websocketInstance) {
    websocketInstance = new SolanaWebSocket();
  }
  return websocketInstance;
}

/**
 * Reset the WebSocket instance (useful for testing or network changes)
 */
export function resetSolanaWebSocket(): void {
  if (websocketInstance) {
    websocketInstance.disconnect();
    websocketInstance = null;
  }
}

// ============ Convenience Functions ============

/**
 * Start real-time subscription monitoring for a wallet
 */
export async function startSubscriptionMonitoring(walletAddress: string): Promise<SolanaWebSocket> {
  const ws = getSolanaWebSocket();
  await ws.connect();
  await ws.subscribe(walletAddress);
  return ws;
}

/**
 * Stop real-time subscription monitoring
 */
export async function stopSubscriptionMonitoring(): Promise<void> {
  const ws = getSolanaWebSocket();
  await ws.disconnect();
}

/**
 * Add a listener for subscription events
 */
export function onSubscriptionEvent(
  callback: (event: SubscriptionEvent) => void
): () => void {
  const ws = getSolanaWebSocket();
  ws.on('subscription_event', callback);

  // Return unsubscribe function
  return () => {
    ws.off('subscription_event', callback);
  };
}

/**
 * Add a listener for specific subscription event types
 */
export function onSubscriptionAdded(
  callback: (event: SubscriptionEvent) => void
): () => void {
  const ws = getSolanaWebSocket();
  ws.on('subscription_added', callback);
  return () => ws.off('subscription_added', callback);
}

export function onSubscriptionUpdated(
  callback: (event: SubscriptionEvent) => void
): () => void {
  const ws = getSolanaWebSocket();
  ws.on('subscription_updated', callback);
  return () => ws.off('subscription_updated', callback);
}

export function onSubscriptionCancelled(
  callback: (event: SubscriptionEvent) => void
): () => void {
  const ws = getSolanaWebSocket();
  ws.on('subscription_cancelled', callback);
  return () => ws.off('subscription_cancelled', callback);
}

/**
 * Add a listener for connection state changes
 */
export function onConnectionStateChange(
  callback: (state: ConnectionState) => void
): () => void {
  const ws = getSolanaWebSocket();
  ws.on('state_change', callback);
  return () => ws.off('state_change', callback);
}
