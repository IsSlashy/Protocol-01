/**
 * Protocol 01 Wallet - Injected Provider
 *
 * Provides Solana wallet standard API compatible with Phantom/Solflare.
 * Exposes window.solana and window.protocol01 for dApp interactions.
 *
 * This script runs in the page context (not extension context).
 *
 * Standard Wallet API:
 * - connect() - Connect to wallet
 * - disconnect() - Disconnect wallet
 * - signMessage(message) - Sign a message
 * - signTransaction(transaction) - Sign a single transaction
 * - signAllTransactions(transactions) - Sign multiple transactions
 * - signAndSendTransaction(transaction) - Sign and send a transaction
 *
 * Events:
 * - connect - Emitted when wallet connects
 * - disconnect - Emitted when wallet disconnects
 * - accountChanged - Emitted when active account changes
 */

// ============ Constants ============

const CHANNEL = 'p01-extension-channel';
const REQUEST_TIMEOUT = 300000; // 5 minutes for approval flows

// ============ UUID Generator (fallback for non-secure contexts) ============

function generateUUID(): string {
  // Use crypto.randomUUID if available (secure contexts)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback using crypto.getRandomValues
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Set version (4) and variant (RFC4122)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Last resort fallback using Math.random (not cryptographically secure)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============ Types ============

interface PublicKey {
  toString(): string;
  toBase58(): string;
  toBytes(): Uint8Array;
  equals(other: PublicKey): boolean;
}

interface Transaction {
  serialize(config?: { requireAllSignatures?: boolean; verifySignatures?: boolean }): Uint8Array;
  signatures: Array<{ publicKey: PublicKey; signature: Uint8Array | null }>;
}

interface SendOptions {
  skipPreflight?: boolean;
  preflightCommitment?: string;
  maxRetries?: number;
  minContextSlot?: number;
}

type EventCallback = (...args: unknown[]) => void;

// ============ Pending Requests ============

const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();

// Map approval requestIds to original requestIds for async approval flows
const approvalToOriginal = new Map<string, string>();

// ============ Event System ============

const eventListeners = new Map<string, Set<EventCallback>>();

function addEventListener(event: string, callback: EventCallback): void {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
  }
  eventListeners.get(event)!.add(callback);
}

function removeEventListener(event: string, callback: EventCallback): void {
  eventListeners.get(event)?.delete(callback);
}

function emit(event: string, ...args: unknown[]): void {
  eventListeners.get(event)?.forEach((cb) => {
    try {
      cb(...args);
    } catch (error) {
      console.error(`Error in ${event} event handler:`, error);
    }
  });
}

// ============ Message Communication ============

function sendMessage<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = generateUUID();

    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Request timeout - user may have closed the approval window'));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(requestId, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timeout,
    });

    window.postMessage({
      source: 'p01-inject',
      channel: CHANNEL,
      type,
      payload,
      requestId,
    }, '*');
  });
}

// Listen for responses from content script
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== 'p01-content') return;
  if (event.data?.channel !== CHANNEL) return;

  const { type, payload, requestId, error } = event.data;

  // Handle approval results
  if (type === 'APPROVAL_RESULT') {
    // Look up the original requestId from the approval requestId
    const originalRequestId = approvalToOriginal.get(requestId) || requestId;
    const pending = pendingRequests.get(originalRequestId);

    if (pending) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(originalRequestId);
      approvalToOriginal.delete(requestId);

      if (payload?.approved) {
        pending.resolve(payload.data || { success: true });
      } else {
        pending.reject(new Error(payload?.reason || 'User rejected the request'));
      }
    }
    return;
  }

  // Handle regular responses
  if (type.endsWith('_RESPONSE')) {
    const pending = pendingRequests.get(requestId);
    if (pending) {
      // Check if this is a pending approval response (async flow)
      if (payload?.pending && payload?.requestId) {
        // Store mapping from approval requestId to original requestId
        // Don't resolve yet - wait for APPROVAL_RESULT
        approvalToOriginal.set(payload.requestId, requestId);
        console.log('[Protocol 01] Waiting for approval:', payload.requestId);
        return;
      }

      clearTimeout(pending.timeout);
      pendingRequests.delete(requestId);

      if (error || payload?.error) {
        pending.reject(new Error(error || payload?.error));
      } else {
        pending.resolve(payload);
      }
    }
  }

  // Handle pushed events from background
  if (type === 'ACCOUNT_CHANGED') {
    const newPublicKey = payload?.publicKey ? createPublicKey(payload.publicKey) : null;
    provider._publicKey = newPublicKey;
    emit('accountChanged', newPublicKey);
  }

  if (type === 'DISCONNECT') {
    provider._publicKey = null;
    provider._isConnected = false;
    emit('disconnect');
  }
});

// ============ PublicKey Implementation ============

function createPublicKey(address: string): PublicKey {
  const bytes = base58Decode(address);

  return {
    toString: () => address,
    toBase58: () => address,
    toBytes: () => bytes,
    equals: (other: PublicKey) => address === other.toBase58(),
  };
}

// Base58 decoding (simplified for Solana addresses)
function base58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP[ALPHABET[i]] = i;
  }

  let bytes: number[] = [0];
  for (const char of str) {
    const value = ALPHABET_MAP[char];
    if (value === undefined) throw new Error('Invalid base58 character');

    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Handle leading zeros
  for (const char of str) {
    if (char === '1') bytes.push(0);
    else break;
  }

  return new Uint8Array(bytes.reverse());
}

// Base58 encoding - exports for potential dApp use
export function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }

  let result = '';
  while (num > 0) {
    result = ALPHABET[Number(num % BigInt(58))] + result;
    num = num / BigInt(58);
  }

  // Handle leading zeros
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result;
    else break;
  }

  return result || '1';
}

// ============ Utility Functions ============

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============ Provider Implementation ============

const provider = {
  // ============ Properties ============

  isProtocol01: true,
  isPhantom: false, // Don't spoof Phantom
  isSolflare: false, // Don't spoof Solflare

  _isConnected: false,
  _publicKey: null as PublicKey | null,

  get isConnected(): boolean {
    return this._isConnected;
  },

  get publicKey(): PublicKey | null {
    return this._publicKey;
  },

  // ============ Connection Methods ============

  /**
   * Connect to the wallet
   * Opens approval popup if not already connected
   */
  async connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }> {
    // If onlyIfTrusted, only connect if already approved
    if (options?.onlyIfTrusted) {
      const result = await sendMessage<{ connected: boolean; publicKey?: string }>(
        'CONNECT_SILENT'
      );

      if (!result.connected || !result.publicKey) {
        throw new Error('User has not approved this app');
      }

      this._publicKey = createPublicKey(result.publicKey);
      this._isConnected = true;
      emit('connect', { publicKey: this._publicKey });
      return { publicKey: this._publicKey };
    }

    // Normal connect flow with approval popup
    const result = await sendMessage<{ publicKey: string }>('CONNECT', {
      origin: window.location.origin,
      title: document.title,
      icon: getFavicon(),
    });

    if (!result.publicKey) {
      throw new Error('Failed to connect');
    }

    this._publicKey = createPublicKey(result.publicKey);
    this._isConnected = true;
    emit('connect', { publicKey: this._publicKey });

    return { publicKey: this._publicKey };
  },

  /**
   * Disconnect from the wallet
   */
  async disconnect(): Promise<void> {
    await sendMessage('DISCONNECT', {
      origin: window.location.origin,
    });

    this._publicKey = null;
    this._isConnected = false;
    emit('disconnect');
  },

  // ============ Signing Methods ============

  /**
   * Sign a message
   * @param message - The message to sign (Uint8Array)
   * @param display - Optional display format ('utf8' or 'hex')
   */
  async signMessage(
    message: Uint8Array,
    display?: 'utf8' | 'hex'
  ): Promise<{ signature: Uint8Array; publicKey: PublicKey }> {
    if (!this._isConnected || !this._publicKey) {
      throw new Error('Wallet not connected');
    }

    // Convert message to base64 for transport
    const messageBase64 = uint8ArrayToBase64(message);

    // Determine display text
    let displayText: string;
    if (display === 'utf8') {
      displayText = new TextDecoder().decode(message);
    } else if (display === 'hex') {
      displayText = Array.from(message)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } else {
      // Try to decode as UTF-8, fallback to hex
      try {
        displayText = new TextDecoder('utf-8', { fatal: true }).decode(message);
      } catch {
        displayText = Array.from(message)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      }
    }

    const result = await sendMessage<{ signature: string }>('SIGN_MESSAGE', {
      origin: window.location.origin,
      message: messageBase64,
      displayText,
    });

    return {
      signature: base64ToUint8Array(result.signature),
      publicKey: this._publicKey,
    };
  },

  /**
   * Sign a transaction
   * @param transaction - The transaction to sign
   */
  async signTransaction<T extends Transaction>(transaction: T): Promise<T> {
    if (!this._isConnected || !this._publicKey) {
      throw new Error('Wallet not connected');
    }

    // Serialize transaction for transport
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const transactionBase64 = uint8ArrayToBase64(serialized);

    const result = await sendMessage<{ signedTransaction: string }>('SIGN_TRANSACTION', {
      origin: window.location.origin,
      transaction: transactionBase64,
    });

    // Return the signed transaction
    // In a real implementation, we'd deserialize and return the signed transaction
    // For now, we'll modify the original transaction object
    const signedBytes = base64ToUint8Array(result.signedTransaction);

    // The background script returns the fully signed transaction bytes
    // We need to reconstruct it - this is a simplified approach
    // In production, use @solana/web3.js Transaction.from()
    (transaction as unknown as { _signedBytes: Uint8Array })._signedBytes = signedBytes;

    return transaction;
  },

  /**
   * Sign multiple transactions
   * @param transactions - Array of transactions to sign
   */
  async signAllTransactions<T extends Transaction>(transactions: T[]): Promise<T[]> {
    if (!this._isConnected || !this._publicKey) {
      throw new Error('Wallet not connected');
    }

    const serializedTransactions = transactions.map((tx) => {
      const serialized = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      return uint8ArrayToBase64(serialized);
    });

    const result = await sendMessage<{ signedTransactions: string[] }>(
      'SIGN_ALL_TRANSACTIONS',
      {
        origin: window.location.origin,
        transactions: serializedTransactions,
      }
    );

    // Return signed transactions
    return transactions.map((tx, i) => {
      const signedBytes = base64ToUint8Array(result.signedTransactions[i]);
      (tx as unknown as { _signedBytes: Uint8Array })._signedBytes = signedBytes;
      return tx;
    });
  },

  /**
   * Sign and send a transaction
   * @param transaction - The transaction to sign and send
   * @param options - Send options
   */
  async signAndSendTransaction<T extends Transaction>(
    transaction: T,
    options?: SendOptions
  ): Promise<{ signature: string; publicKey: PublicKey }> {
    if (!this._isConnected || !this._publicKey) {
      throw new Error('Wallet not connected');
    }

    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const transactionBase64 = uint8ArrayToBase64(serialized);

    const result = await sendMessage<{ signature: string }>('SIGN_AND_SEND_TRANSACTION', {
      origin: window.location.origin,
      transaction: transactionBase64,
      options,
    });

    return {
      signature: result.signature,
      publicKey: this._publicKey,
    };
  },

  // ============ Event Methods ============

  /**
   * Add event listener
   */
  on(event: string, callback: EventCallback): void {
    addEventListener(event, callback);
  },

  /**
   * Remove event listener
   */
  off(event: string, callback: EventCallback): void {
    removeEventListener(event, callback);
  },

  /**
   * Add event listener (alias for on)
   */
  addListener(event: string, callback: EventCallback): void {
    addEventListener(event, callback);
  },

  /**
   * Remove event listener (alias for off)
   */
  removeListener(event: string, callback: EventCallback): void {
    removeEventListener(event, callback);
  },

  // ============ Protocol 01 Specific Methods ============

  /**
   * Send a private transaction using stealth addresses
   */
  async sendPrivate(options: {
    recipient: string;
    amount: number;
    tokenMint?: string;
  }): Promise<{ signature: string }> {
    if (!this._isConnected) {
      throw new Error('Wallet not connected');
    }

    return sendMessage<{ signature: string }>('SEND_PRIVATE', {
      origin: window.location.origin,
      ...options,
    });
  },

  /**
   * Generate a stealth address for private receiving
   */
  async generateStealthAddress(): Promise<{ address: string; ephemeralPublicKey: string }> {
    if (!this._isConnected) {
      throw new Error('Wallet not connected');
    }

    return sendMessage<{ address: string; ephemeralPublicKey: string }>(
      'GENERATE_STEALTH_ADDRESS',
      { origin: window.location.origin }
    );
  },

  /**
   * Create a subscription (Stream Secure)
   */
  async subscribe(options: {
    recipient: string;
    merchantName: string;
    merchantLogo?: string;
    tokenMint?: string;
    amountPerPeriod: number;
    periodSeconds: number;
    maxPeriods?: number;
    description?: string;
  }): Promise<{ subscriptionId: string; address: string }> {
    if (!this._isConnected) {
      throw new Error('Wallet not connected');
    }

    return sendMessage<{ subscriptionId: string; address: string }>('CREATE_SUBSCRIPTION', {
      origin: window.location.origin,
      ...options,
      maxPeriods: options.maxPeriods ?? 0,
    });
  },

  /**
   * Get active subscriptions
   */
  async getSubscriptions(): Promise<
    Array<{
      id: string;
      address: string;
      recipient: string;
      merchantName: string;
      amountPerPeriod: number;
      periodSeconds: number;
      maxPeriods: number;
      periodsPaid: number;
      isActive: boolean;
    }>
  > {
    return sendMessage<{ subscriptions: unknown[] }>('GET_SUBSCRIPTIONS', {
      origin: window.location.origin,
    }).then((r) => r.subscriptions as never[]);
  },

  /**
   * Cancel a subscription
   */
  async cancelSubscription(subscriptionId: string): Promise<{ success: boolean }> {
    return sendMessage<{ success: boolean }>('CANCEL_SUBSCRIPTION', {
      origin: window.location.origin,
      subscriptionId,
    });
  },
};

// ============ Helper Functions ============

function getFavicon(): string | undefined {
  const link =
    document.querySelector<HTMLLinkElement>("link[rel*='icon']") ||
    document.querySelector<HTMLLinkElement>("link[rel='shortcut icon']");
  return link?.href || undefined;
}

// ============ Window Injection ============

declare global {
  interface Window {
    solana?: typeof provider;
    protocol01: typeof provider;
    phantom?: { solana?: typeof provider };
  }
}

// Inject provider
function injectProvider() {
  // Primary: window.protocol01
  if (typeof window.protocol01 === 'undefined') {
    Object.defineProperty(window, 'protocol01', {
      value: provider,
      writable: false,
      configurable: false,
    });
  }

  // Standard: window.solana (if not already taken)
  if (typeof window.solana === 'undefined') {
    Object.defineProperty(window, 'solana', {
      value: provider,
      writable: false,
      configurable: false,
    });
  }

  // Dispatch events to notify dApps
  window.dispatchEvent(new CustomEvent('protocol01#initialized'));

  // Also dispatch wallet-standard events for compatibility
  try {
    const event = new CustomEvent('wallet-standard:register', {
      detail: {
        register: (callback: (wallet: unknown) => void) => {
          callback({
            name: 'Protocol 01',
            icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIGZpbGw9IiMwMEZGRkYiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzAwMCIgZm9udC1zaXplPSIxMiIgZm9udC1mYW1pbHk9Im1vbm9zcGFjZSI+MDE8L3RleHQ+PC9zdmc+',
            chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet'],
            features: {
              'standard:connect': { connect: provider.connect.bind(provider) },
              'standard:disconnect': { disconnect: provider.disconnect.bind(provider) },
              'solana:signTransaction': {
                signTransaction: provider.signTransaction.bind(provider),
              },
              'solana:signMessage': { signMessage: provider.signMessage.bind(provider) },
            },
            accounts: [],
          });
        },
      },
    });
    window.dispatchEvent(event);
  } catch (e) {
    // Wallet standard registration is optional
  }

  console.log('[Protocol 01] Wallet provider injected');
}

// Only inject on http/https pages
if (
  window.location.protocol === 'https:' ||
  window.location.protocol === 'http:'
) {
  injectProvider();
}

export {};
