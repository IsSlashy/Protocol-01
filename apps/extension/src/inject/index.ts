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
    // Privacy preferences chosen on the dApp. Forwarded as-is to the background
    // (handleCreateSubscription), which surfaces them in the approval popup.
    amountNoise?: number;
    timingNoise?: number;
    useStealthAddress?: boolean;
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
   * Pause a subscription. Freezes the subscription clock and cuts access;
   * prepaid days are not lost and resume picks them back up.
   *
   * BREAKING CHANGE: replaces `cancelSubscription`. A Protocol 01 subscription
   * is a one-way prepaid envelope — money that enters it can only ever leave it
   * toward the merchant, and the protocol has no instruction that could send any
   * of it back. Pause and resume are the whole set of subscriber controls.
   */
  async pauseSubscription(subscriptionId: string): Promise<{ success: boolean }> {
    return sendMessage<{ success: boolean }>('PAUSE_SUBSCRIPTION', {
      origin: window.location.origin,
      subscriptionId,
    });
  },

  /**
   * Resume a paused subscription.
   */
  async resumeSubscription(subscriptionId: string): Promise<{ success: boolean }> {
    return sendMessage<{ success: boolean }>('RESUME_SUBSCRIPTION', {
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

// ============ Wallet Standard Types ============
//
// Hand-written on purpose. @wallet-standard/base exists in the monorepo root
// node_modules (apps/web pulls it in) but is NOT a dependency of
// @protocol-01/extension, and this file is bundled by esbuild into an IIFE that
// runs in the *page* realm — adding an import here just to get types would
// either fail pnpm's strict resolution or drag a package into the page bundle
// for nothing. These declarations mirror @wallet-standard/base@1.x; if the spec
// moves, this block is what has to move with it.

type IdentifierString = `${string}:${string}`;

/** Mirrors @wallet-standard/wallet's ReadonlyWalletAccount. */
interface StandardWalletAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly IdentifierString[];
  readonly features: readonly IdentifierString[];
  readonly label?: string;
  readonly icon?: string;
}

interface StandardWallet {
  readonly version: '1.0.0';
  readonly name: string;
  readonly icon: `data:image/svg+xml;base64,${string}`;
  readonly chains: readonly IdentifierString[];
  readonly features: Readonly<Record<string, unknown>>;
  readonly accounts: readonly StandardWalletAccount[];
}

/** The `{ register }` api the app hands us on both registration paths. */
interface WalletStandardRegisterApi {
  register(...wallets: StandardWallet[]): () => void;
}

interface StandardEventsChangeProperties {
  readonly chains?: readonly IdentifierString[];
  readonly features?: Readonly<Record<string, unknown>>;
  readonly accounts?: readonly StandardWalletAccount[];
}

type StandardEventsListener = (properties: StandardEventsChangeProperties) => void;

interface SolanaSignTransactionInput {
  readonly account: StandardWalletAccount;
  readonly transaction: Uint8Array;
  readonly chain?: IdentifierString;
}

interface SolanaSignMessageInput {
  readonly account: StandardWalletAccount;
  readonly message: Uint8Array;
}

interface SolanaSignAndSendTransactionInput {
  readonly account: StandardWalletAccount;
  readonly transaction: Uint8Array;
  readonly chain: IdentifierString;
  readonly options?: {
    readonly preflightCommitment?: string;
    readonly skipPreflight?: boolean;
    readonly maxRetries?: number;
    readonly minContextSlot?: number;
  };
}

// ============ Window Injection ============

declare global {
  interface Window {
    solana?: typeof provider;
    protocol01: typeof provider;
    phantom?: { solana?: typeof provider };
  }
  // The app dispatches this the first time it calls getWallets(); its detail IS
  // the registration api. Declaring it here is what keeps the listener below
  // strictly typed instead of casting an Event.
  interface WindowEventMap {
    'wallet-standard:app-ready': CustomEvent<WalletStandardRegisterApi>;
  }
}

// ============ Wallet Standard Registration ============
//
// WHY THIS BLOCK WAS REWRITTEN (2026-08-18). What shipped before dispatched a
// 'wallet-standard:register' event whose detail was an OBJECT holding a
// register function. Both halves were wrong:
//   - the spec's event is 'wallet-standard:register-wallet';
//   - its detail is a CALLBACK the app invokes with its own api. Read
//     @wallet-standard/app/lib/esm/wallets.js: the app does
//     addEventListener('wallet-standard:register-wallet', ({detail: cb}) => cb(api)).
// So nothing listened to the name we sent, and nothing could have consumed the
// shape we sent even if it had. Protocol 01 never appeared in a
// @solana/wallet-adapter modal: to every dApp that does not poke window.solana
// by hand, this extension looked uninstalled. It went unseen because the whole
// thing sat inside a `catch {}` commented "registration is optional". It is not
// optional — it is the only door a wallet-adapter dApp knows how to open.

const WALLET_ICON: `data:image/svg+xml;base64,${string}` =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIGZpbGw9IiMwMEZGRkYiLz48dGV4dCB4PSI1MCUiIHk9IjUwJSIgZG9taW5hbnQtYmFzZWxpbmU9Im1pZGRsZSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iIzAwMCIgZm9udC1zaXplPSIxMiIgZm9udC1mYW1pbHk9Im1vbm9zcGFjZSI+MDE8L3RleHQ+PC9zdmc+';

// localnet is in the list because the manifest injects on http://localhost:*/*
// and @solana/wallet-standard-util maps a localhost endpoint to
// 'solana:localnet'; without it the adapter refuses to send from a local dApp.
// mainnet is in the list because that same mapper falls back to
// 'solana:mainnet' for ANY endpoint it does not recognise (a custom Helius or
// Triton URL), and a chain missing from account.chains makes
// StandardWalletAdapter.sendTransaction throw before it ever reaches us.
const P01_CHAINS: readonly IdentifierString[] = [
  'solana:mainnet',
  'solana:devnet',
  'solana:testnet',
  'solana:localnet',
];

// The only cluster the approval popup actually broadcasts to. Not a preference
// — a literal: popup/pages/ApproveTransaction.tsx builds
// `new RpcConnectionManager({ cluster: 'devnet' })` and calls sendRawTransaction
// on it for every sign-and-send approval, whatever the dApp asked for.
const SENDABLE_CHAIN: IdentifierString = 'solana:devnet';

// Deliberately WITHOUT 'solana:signAndSendTransaction'.
// StandardWalletAdapter.sendTransaction takes the signAndSend path only when
// the ACCOUNT lists that feature, and otherwise falls back to signTransaction
// followed by the dApp's own connection.sendRawTransaction. Because our popup
// hardcodes the devnet RPC (see SENDABLE_CHAIN), letting the adapter take the
// signAndSend path would broadcast a mainnet-intended transaction to devnet and
// hand the dApp a signature that can never confirm where it is watching.
// Omitting it here routes every adapter send through the dApp's own endpoint,
// which is by construction the right cluster. The feature is still published on
// the wallet below for direct wallet-standard callers, where it refuses any
// chain it cannot really send on.
const P01_ACCOUNT_FEATURES: readonly IdentifierString[] = [
  'solana:signTransaction',
  'solana:signMessage',
];

let standardAccounts: readonly StandardWalletAccount[] = [];
const changeListeners = new Set<StandardEventsListener>();

function emitStandardChange(properties: StandardEventsChangeProperties): void {
  changeListeners.forEach((listener) => {
    try {
      listener(properties);
    } catch (error) {
      console.error('Error in wallet-standard change listener:', error);
    }
  });
}

function createStandardAccount(publicKey: PublicKey): StandardWalletAccount {
  return Object.freeze({
    address: publicKey.toBase58(),
    publicKey: publicKey.toBytes(),
    chains: P01_CHAINS,
    features: P01_ACCOUNT_FEATURES,
    label: 'Protocol 01',
  });
}

/**
 * Mirror the provider's connection state into the standard `accounts` array.
 *
 * Wired to the provider's own event bus rather than called from the connect
 * feature, so a dApp that connects through window.solana — or a push from the
 * background (ACCOUNT_CHANGED / DISCONNECT) — moves the standard wallet too.
 * One source of truth; provider.connect() emits 'connect' synchronously before
 * it resolves, so the connect feature can simply read this afterwards.
 *
 * The early return is load-bearing, not an optimisation: StandardWalletAdapter
 * compares accounts by OBJECT IDENTITY (`account !== this.#account` in its
 * change handler). Rebuilding an identical account object would read as an
 * account switch and make the adapter re-emit 'connect' on every event.
 */
function syncStandardAccounts(): void {
  const publicKey = provider.publicKey;
  const next: readonly StandardWalletAccount[] =
    provider.isConnected && publicKey ? [createStandardAccount(publicKey)] : [];

  const unchanged =
    next.length === standardAccounts.length &&
    next.every((account, i) => account.address === standardAccounts[i].address);
  if (unchanged) return;

  standardAccounts = next;
  emitStandardChange({ accounts: standardAccounts });
}

provider.on('connect', syncStandardAccounts);
provider.on('disconnect', syncStandardAccounts);
provider.on('accountChanged', syncStandardAccounts);

/**
 * The extension signs with whatever key the popup currently has unlocked; it
 * has no way to sign as some other account. Honouring a mismatched `account`
 * would silently return a signature from a different key than the dApp asked
 * for, so refuse instead.
 */
function assertRequestedAccount(account: StandardWalletAccount): void {
  const connected = standardAccounts[0];
  if (!connected) {
    throw new Error('Protocol 01: wallet not connected');
  }
  if (account.address !== connected.address) {
    throw new Error(
      `Protocol 01: refusing to sign for ${account.address} — the unlocked wallet is ${connected.address}`
    );
  }
}

function assertSendableChain(chain: IdentifierString): void {
  if (chain !== SENDABLE_CHAIN) {
    throw new Error(
      `Protocol 01: signAndSendTransaction broadcasts on ${SENDABLE_CHAIN} only (the approval popup ` +
        `builds a devnet connection), so it cannot send a ${chain} transaction. Use signTransaction ` +
        'and send it on your own connection.'
    );
  }
}

type WireTransaction = Transaction & { _signedBytes?: Uint8Array };

/**
 * provider.signTransaction() speaks web3.js Transaction objects (it calls
 * .serialize() on them) while the Wallet Standard speaks wire bytes. Rather
 * than duplicating the sendMessage/origin/approval plumbing, hand the provider
 * the smallest object its call site actually touches.
 */
function wireTransaction(bytes: Uint8Array): WireTransaction {
  return {
    serialize: () => bytes,
    signatures: [],
  };
}

/**
 * provider.signTransaction does NOT return a signed transaction: it stashes the
 * signed bytes on the object it was given as `_signedBytes` and returns that
 * same object (see its own "In production, use Transaction.from()" note). If
 * that ever changes, this is the line that would otherwise start handing the
 * dApp the UNSIGNED bytes back — so it throws rather than guesses.
 */
function takeSignedBytes(tx: WireTransaction): Uint8Array {
  const signed = tx._signedBytes;
  if (!signed) {
    throw new Error('Protocol 01: signer returned no signed transaction bytes');
  }
  return signed;
}

const walletStandardFeatures: Record<string, unknown> = {
  'standard:connect': {
    version: '1.0.0',
    connect: async (
      input?: { silent?: boolean }
    ): Promise<{ accounts: readonly StandardWalletAccount[] }> => {
      if (input?.silent) {
        // autoConnect(). CONNECT_SILENT never opens a popup; provider.connect
        // throws when the origin was never approved, but the spec says a silent
        // connect returns no accounts rather than failing, so swallow it here.
        // The adapter still raises WalletAccountError afterwards — autoConnect
        // on an unapproved origin is a visible no-op, never a prompt.
        try {
          await provider.connect({ onlyIfTrusted: true });
        } catch {
          return { accounts: [] };
        }
        return { accounts: standardAccounts };
      }

      await provider.connect();
      return { accounts: standardAccounts };
    },
  },

  'standard:disconnect': {
    version: '1.0.0',
    disconnect: async (): Promise<void> => {
      await provider.disconnect();
    },
  },

  // Without this feature StandardWalletAdapter throws in its constructor — it
  // subscribes to 'change' before doing anything else. It is also the only
  // channel by which an account switch inside the extension reaches the dApp.
  'standard:events': {
    version: '1.0.0',
    on: (event: 'change', listener: StandardEventsListener): (() => void) => {
      if (event !== 'change') return () => undefined;
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
  },

  'solana:signTransaction': {
    version: '1.0.0',
    // Both are real: the approval popup sniffs the version byte and
    // deserialises v0 through VersionedTransaction, legacy through
    // Transaction.from (popup/pages/ApproveTransaction.tsx).
    supportedTransactionVersions: ['legacy', 0],
    signTransaction: async (
      ...inputs: SolanaSignTransactionInput[]
    ): Promise<readonly { signedTransaction: Uint8Array }[]> => {
      if (inputs.length === 0) return [];
      inputs.forEach((input) => assertRequestedAccount(input.account));

      if (inputs.length === 1) {
        const tx = wireTransaction(inputs[0].transaction);
        await provider.signTransaction(tx);
        return [{ signedTransaction: takeSignedBytes(tx) }];
      }

      // One approval for the whole batch, on purpose. The background stores the
      // pending approval under a SINGLE 'currentApproval' key in
      // chrome.storage.session, so N concurrent single-transaction approvals
      // would overwrite each other and the user would only ever see the last.
      const txs = inputs.map((input) => wireTransaction(input.transaction));
      await provider.signAllTransactions(txs);
      return txs.map((tx) => ({ signedTransaction: takeSignedBytes(tx) }));
    },
  },

  'solana:signMessage': {
    version: '1.0.0',
    signMessage: async (
      ...inputs: SolanaSignMessageInput[]
    ): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]> => {
      const outputs: { signedMessage: Uint8Array; signature: Uint8Array }[] = [];
      // Sequential for the single 'currentApproval' slot reason above: two
      // approvals in flight at once means one of them is silently lost.
      for (const input of inputs) {
        assertRequestedAccount(input.account);
        const { signature } = await provider.signMessage(input.message);
        // The popup signs these exact bytes with nacl.sign.detached and adds no
        // domain prefix, so signedMessage is the input verbatim. The dApp
        // verifies the signature against whatever we return here — returning
        // anything else produces a signature that does not verify.
        outputs.push({ signedMessage: input.message, signature });
      }
      return outputs;
    },
  },
};

// Published for direct wallet-standard callers only; P01_ACCOUNT_FEATURES
// deliberately keeps @solana/wallet-adapter off this path. Gated on the
// provider actually having the method, so the feature list never advertises
// something the provider cannot do.
if (typeof provider.signAndSendTransaction === 'function') {
  walletStandardFeatures['solana:signAndSendTransaction'] = {
    version: '1.0.0',
    supportedTransactionVersions: ['legacy', 0],
    signAndSendTransaction: async (
      ...inputs: SolanaSignAndSendTransactionInput[]
    ): Promise<readonly { signature: Uint8Array }[]> => {
      const outputs: { signature: Uint8Array }[] = [];
      for (const input of inputs) {
        assertRequestedAccount(input.account);
        assertSendableChain(input.chain);
        const tx = wireTransaction(input.transaction);
        // The popup currently ignores these send options (it hardcodes
        // skipPreflight:false / preflightCommitment:'confirmed'); forwarded
        // anyway so the wire is not the thing that has to change when it stops.
        const { signature } = await provider.signAndSendTransaction(tx, {
          skipPreflight: input.options?.skipPreflight,
          preflightCommitment: input.options?.preflightCommitment,
          maxRetries: input.options?.maxRetries,
          minContextSlot: input.options?.minContextSlot,
        });
        // The popup returns base58 out of sendRawTransaction; the standard
        // wants the raw 64 signature bytes and re-encodes them itself.
        outputs.push({ signature: base58Decode(signature) });
      }
      return outputs;
    },
  };
}

const p01StandardWallet: StandardWallet = Object.freeze({
  version: '1.0.0',
  name: 'Protocol 01',
  icon: WALLET_ICON,
  chains: P01_CHAINS,
  features: Object.freeze(walletStandardFeatures),
  // A getter, not a snapshot: the app holds this one object forever and reads
  // .accounts after every 'change'. An array captured at registration time
  // leaves the adapter connecting to nothing — which is exactly what the old
  // `accounts: []` did.
  get accounts(): readonly StandardWalletAccount[] {
    return standardAccounts;
  },
});
// Freezing stops a page from quietly swapping a feature out from under us. It
// is a speed bump, not a boundary: this script shares the page's realm, so a
// hostile page can still shadow the whole wallet. The real boundary is the
// approval popup, which lives in the extension and signs nothing without a
// click.

function registerWalletStandard(api: WalletStandardRegisterApi): void {
  // Registering twice is safe and expected: both paths below can fire on the
  // same page load, and @wallet-standard/app dedupes on OBJECT IDENTITY (a Set
  // of wallets). Never rebuild p01StandardWallet per registration, or the
  // dApp's modal grows a second "Protocol 01" entry.
  try {
    api.register(p01StandardWallet);
  } catch (error) {
    console.error('Protocol 01: wallet-standard registration failed', error);
  }
}

// ============ Inject ============

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

  // Both registration paths are required, and which one wins is a race we do
  // not control. If the app called getWallets() before this script ran, its
  // 'wallet-standard:app-ready' has already fired and only the dispatch below
  // is heard; if the app loads later (the common case for a document_start
  // injection) only the listener fires. A wallet that implements one of the two
  // is invisible to half the dApps in the ecosystem.
  window.addEventListener('wallet-standard:app-ready', (event) => {
    registerWalletStandard(event.detail);
  });

  window.dispatchEvent(
    new CustomEvent<(api: WalletStandardRegisterApi) => void>('wallet-standard:register-wallet', {
      // detail is the CALLBACK, not an object with a register method. The app
      // invokes it with its own api. This inversion is the whole reason the old
      // code could not have worked even with the right event name.
      detail: (api: WalletStandardRegisterApi) => registerWalletStandard(api),
    })
  );
}

// Only inject on http/https pages
if (
  window.location.protocol === 'https:' ||
  window.location.protocol === 'http:'
) {
  injectProvider();
}

export {};
