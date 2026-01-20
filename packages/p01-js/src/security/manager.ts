/**
 * Security Manager for Protocol 01
 *
 * Central orchestrator for all security features:
 * - Stealth addresses (DKSAP)
 * - Encrypted memos
 * - Confidential amounts
 *
 * Design principles:
 * - Simple API: Easy to use for common cases
 * - Non-invasive: Users opt-in to privacy features
 * - Configurable: Different security levels for different needs
 */

import type {
  SecurityLevel,
  SecurityConfig,
  SecurityFeatures,
  StealthKeyPair,
  StealthAddress,
  StealthPayment,
  EncryptedPayload,
  ConfidentialAmount,
} from './types';

import {
  generateStealthKeyPair,
  generateStealthAddress,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  scanAndDeriveStealthPayment,
} from './stealth';

import {
  encryptForRecipient,
  decryptFromSender,
  generateEncryptionKeyPair,
} from './encryption';

// ============ Types ============

/**
 * Transaction to scan for stealth payments
 */
export interface Transaction {
  signature: string;
  ephemeralPublicKey?: Uint8Array;
  viewTag?: number;
  recipient: string;
  amount: number;
  tokenMint: string;
  timestamp: number;
  memo?: string;
}

/**
 * Prepared private transaction
 */
export interface PreparedTransaction {
  /** Recipient address (stealth or regular) */
  recipient: string;
  /** Amount to send */
  amount: number;
  /** Encrypted memo (if enabled) */
  encryptedMemo?: string;
  /** Ephemeral public key for stealth address */
  ephemeralPublicKey?: Uint8Array;
  /** View tag for efficient scanning */
  viewTag?: number;
  /** Confidential amount commitment */
  confidentialAmount?: ConfidentialAmount;
  /** Security level used */
  securityLevel: SecurityLevel;
  /** Metadata for transaction */
  metadata: {
    isStealthPayment: boolean;
    hasMemo: boolean;
    isConfidential: boolean;
  };
}

/**
 * Security info summary
 */
export interface SecurityInfo {
  level: SecurityLevel;
  features: string[];
  hasStealthKeys: boolean;
  metaAddress?: string;
}

// ============ Errors ============

/**
 * Security-related errors with user-friendly messages
 */
export class SecurityError extends Error {
  constructor(
    message: string,
    public readonly code: SecurityErrorCode,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}

export type SecurityErrorCode =
  | 'STEALTH_NOT_INITIALIZED'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'INVALID_META_ADDRESS'
  | 'INVALID_PUBLIC_KEY'
  | 'FEATURE_DISABLED'
  | 'CONFIGURATION_ERROR';

// ============ Default Configuration ============

const DEFAULT_CONFIG: SecurityConfig = {
  defaultLevel: 'standard',
  features: {
    stealthAddresses: true,
    encryptedMemos: true,
    confidentialAmounts: false, // Requires ZK setup
    zkProofs: false, // Requires Light Protocol
  },
};

// ============ Security Manager ============

/**
 * SecurityManager - Central hub for Protocol 01 security features
 *
 * @example Basic usage
 * ```typescript
 * const security = new SecurityManager();
 *
 * // Generate stealth keys for receiving private payments
 * security.generateStealthKeys();
 *
 * // Share your meta-address with senders
 * const metaAddress = security.getStealthMetaAddress();
 *
 * // Sender creates a one-time address for payment
 * const stealthAddr = security.createStealthPaymentAddress(recipientMetaAddress);
 *
 * // Scan for incoming payments
 * const payments = security.scanIncomingPayments(transactions);
 * ```
 *
 * @example Private payment preparation
 * ```typescript
 * const security = new SecurityManager({ defaultLevel: 'private' });
 *
 * const prepared = await security.preparePrivatePayment({
 *   amount: 100,
 *   recipient: recipientMetaAddress,
 *   memo: 'Payment for services'
 * });
 * ```
 */
export class SecurityManager {
  private config: SecurityConfig;
  private stealthKeys: StealthKeyPair | null = null;
  private encryptionKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null;

  /**
   * Create a new SecurityManager instance
   *
   * @param config - Optional configuration overrides
   */
  constructor(config?: Partial<SecurityConfig>) {
    this.config = this.mergeConfig(config);
  }

  // ============ Configuration ============

  /**
   * Set the default security level
   *
   * @param level - Security level to use by default
   */
  setSecurityLevel(level: SecurityLevel): void {
    this.config.defaultLevel = level;
  }

  /**
   * Get the current security level
   */
  getSecurityLevel(): SecurityLevel {
    return this.config.defaultLevel;
  }

  /**
   * Update security features
   *
   * @param features - Partial feature flags to update
   */
  updateFeatures(features: Partial<SecurityFeatures>): void {
    this.config.features = { ...this.config.features, ...features };
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<SecurityConfig> {
    return { ...this.config };
  }

  // ============ Stealth Addresses ============

  /**
   * Generate stealth key pair for receiving private payments
   *
   * Keys are stored in memory and must be regenerated on restart.
   * For persistence, export and store securely.
   *
   * @returns The generated stealth key pair
   * @throws SecurityError if stealth addresses are disabled
   */
  generateStealthKeys(): StealthKeyPair {
    this.ensureFeatureEnabled('stealthAddresses');

    try {
      this.stealthKeys = generateStealthKeyPair();
      return this.stealthKeys;
    } catch (error) {
      throw new SecurityError(
        'Failed to generate stealth keys. Please try again.',
        'CONFIGURATION_ERROR',
        error
      );
    }
  }

  /**
   * Import existing stealth keys
   *
   * @param keys - Stealth key pair to import
   */
  importStealthKeys(keys: StealthKeyPair): void {
    this.ensureFeatureEnabled('stealthAddresses');
    this.stealthKeys = { ...keys };
  }

  /**
   * Export stealth keys (for secure storage)
   *
   * @returns The current stealth key pair or null
   */
  exportStealthKeys(): StealthKeyPair | null {
    return this.stealthKeys ? { ...this.stealthKeys } : null;
  }

  /**
   * Check if stealth keys are initialized
   */
  hasStealthKeys(): boolean {
    return this.stealthKeys !== null;
  }

  /**
   * Get the stealth meta-address to share with senders
   *
   * This is the address you share publicly to receive private payments.
   *
   * @returns Encoded meta-address string
   * @throws SecurityError if stealth keys not initialized
   */
  getStealthMetaAddress(): string {
    this.ensureStealthInitialized();

    return encodeStealthMetaAddress(
      this.stealthKeys!.scanPublicKey,
      this.stealthKeys!.spendPublicKey
    );
  }

  /**
   * Create a one-time stealth address for sending to a recipient
   *
   * @param recipientMetaAddress - The recipient's meta-address
   * @returns StealthAddress with one-time address and ephemeral key
   * @throws SecurityError if meta-address is invalid
   */
  createStealthPaymentAddress(recipientMetaAddress: string): StealthAddress {
    this.ensureFeatureEnabled('stealthAddresses');

    try {
      const decoded = decodeStealthMetaAddress(recipientMetaAddress);
      return generateStealthAddress(decoded);
    } catch (error) {
      if (error instanceof SecurityError) throw error;

      throw new SecurityError(
        'Invalid recipient meta-address. Please check the address and try again.',
        'INVALID_META_ADDRESS',
        error
      );
    }
  }

  /**
   * Scan transactions for incoming stealth payments
   *
   * @param transactions - Transactions to scan
   * @returns Array of detected payments with spending keys
   * @throws SecurityError if stealth keys not initialized
   */
  scanIncomingPayments(transactions: Transaction[]): StealthPayment[] {
    this.ensureStealthInitialized();

    const payments: StealthPayment[] = [];

    for (const tx of transactions) {
      // Skip transactions without stealth payment data
      if (!tx.ephemeralPublicKey || tx.viewTag === undefined) {
        continue;
      }

      try {
        const result = scanAndDeriveStealthPayment(
          tx.ephemeralPublicKey,
          tx.viewTag,
          this.stealthKeys!.scanPrivateKey,
          this.stealthKeys!.spendPrivateKey,
          this.stealthKeys!.spendPublicKey
        );

        if (result.isOurs && result.privateKey) {
          payments.push({
            signature: tx.signature,
            amount: tx.amount,
            tokenMint: tx.tokenMint,
            privateKey: result.privateKey,
            timestamp: tx.timestamp,
          });
        }
      } catch (error) {
        // Skip transactions that fail scanning
        console.warn('Error scanning transaction:', tx.signature, error);
      }
    }

    return payments;
  }

  /**
   * Check if an address is a valid stealth meta-address format
   *
   * @param address - Address to check
   */
  isStealthAddress(address: string): boolean {
    try {
      decodeStealthMetaAddress(address);
      return true;
    } catch {
      return false;
    }
  }

  // ============ Encryption ============

  /**
   * Initialize encryption keys
   *
   * @returns The public key to share with others
   */
  async initializeEncryption(): Promise<Uint8Array> {
    this.ensureFeatureEnabled('encryptedMemos');

    try {
      this.encryptionKeyPair = await generateEncryptionKeyPair();
      return this.encryptionKeyPair.publicKey;
    } catch (error) {
      throw new SecurityError(
        'Failed to initialize encryption. Please try again.',
        'CONFIGURATION_ERROR',
        error
      );
    }
  }

  /**
   * Get encryption public key
   */
  getEncryptionPublicKey(): Uint8Array | null {
    return this.encryptionKeyPair?.publicKey ?? null;
  }

  /**
   * Encrypt a memo for a specific recipient
   *
   * @param content - Memo content to encrypt
   * @param recipientPubKey - Recipient's public key (hex or base64)
   * @returns Encrypted memo as base64 string
   */
  async encryptMemo(content: string, recipientPubKey: string): Promise<string> {
    this.ensureFeatureEnabled('encryptedMemos');

    try {
      const payload = await encryptForRecipient(
        new TextEncoder().encode(content),
        this.parsePublicKey(recipientPubKey)
      );

      return this.serializeEncryptedPayload(payload);
    } catch (error) {
      if (error instanceof SecurityError) throw error;

      throw new SecurityError(
        'Failed to encrypt memo. Please check the recipient public key.',
        'ENCRYPTION_FAILED',
        error
      );
    }
  }

  /**
   * Decrypt a memo encrypted for this user
   *
   * @param encryptedMemo - Base64 encoded encrypted memo
   * @returns Decrypted memo content
   */
  async decryptMemo(encryptedMemo: string): Promise<string> {
    this.ensureFeatureEnabled('encryptedMemos');
    this.ensureEncryptionInitialized();

    try {
      const payload = this.deserializeEncryptedPayload(encryptedMemo);
      const decrypted = await decryptFromSender(
        payload,
        this.encryptionKeyPair!.privateKey
      );

      return new TextDecoder().decode(decrypted);
    } catch (error) {
      if (error instanceof SecurityError) throw error;

      throw new SecurityError(
        'Failed to decrypt memo. The memo may not be intended for you.',
        'DECRYPTION_FAILED',
        error
      );
    }
  }

  /**
   * Encrypt arbitrary metadata object
   *
   * @param data - Object to encrypt
   * @param recipientPubKey - Recipient's public key
   * @returns Encrypted data as base64 string
   */
  async encryptMetadata(data: object, recipientPubKey: string): Promise<string> {
    const json = JSON.stringify(data);
    return this.encryptMemo(json, recipientPubKey);
  }

  /**
   * Decrypt metadata object
   *
   * @param encrypted - Encrypted metadata string
   * @returns Decrypted object
   */
  async decryptMetadata(encrypted: string): Promise<object> {
    const json = await this.decryptMemo(encrypted);

    try {
      return JSON.parse(json);
    } catch {
      throw new SecurityError(
        'Failed to parse decrypted metadata. Data may be corrupted.',
        'DECRYPTION_FAILED'
      );
    }
  }

  // ============ Transaction Preparation ============

  /**
   * Prepare a private payment transaction
   *
   * This method orchestrates stealth addresses and encryption based on
   * the security level.
   *
   * @param options - Payment options
   * @returns Prepared transaction ready for signing
   */
  async preparePrivatePayment(options: {
    amount: number;
    recipient: string;
    memo?: string;
    securityLevel?: SecurityLevel;
  }): Promise<PreparedTransaction> {
    const level = options.securityLevel ?? this.config.defaultLevel;

    const prepared: PreparedTransaction = {
      recipient: options.recipient,
      amount: options.amount,
      securityLevel: level,
      metadata: {
        isStealthPayment: false,
        hasMemo: false,
        isConfidential: false,
      },
    };

    // Standard level: no privacy features
    if (level === 'standard') {
      return prepared;
    }

    // Private and above: use stealth address
    if (this.shouldUseStealthAddress(level)) {
      try {
        const stealthAddr = this.createStealthPaymentAddress(options.recipient);
        prepared.recipient = stealthAddr.address;
        prepared.ephemeralPublicKey = stealthAddr.ephemeralPublicKey;
        prepared.viewTag = stealthAddr.viewTag;
        prepared.metadata.isStealthPayment = true;
      } catch (error) {
        // If meta-address parsing fails, assume it's a regular address
        if (level === 'maximum') {
          throw error; // Maximum level requires stealth
        }
        // For 'private' level, fall back to regular address
        console.warn('Could not create stealth address, using regular address');
      }
    }

    // Encrypt memo if provided and feature enabled
    if (options.memo && this.shouldEncryptMemo(level)) {
      try {
        // For stealth payments, derive encryption key from ephemeral key
        // For regular payments, we need the recipient's encryption public key
        const recipientEncryptionKey = this.deriveEncryptionKeyFromMetaAddress(options.recipient);
        prepared.encryptedMemo = await this.encryptMemo(options.memo, recipientEncryptionKey);
        prepared.metadata.hasMemo = true;
      } catch (error) {
        if (level === 'maximum') {
          throw new SecurityError(
            'Failed to encrypt memo. Maximum security requires encryption.',
            'ENCRYPTION_FAILED',
            error
          );
        }
        // For lower levels, include memo as-is or skip
        console.warn('Could not encrypt memo:', error);
      }
    }

    // Confidential amounts (requires ZK setup)
    if (this.shouldUseConfidentialAmounts(level) && this.config.features.confidentialAmounts) {
      // Confidential amounts would be implemented here
      // For now, this is a placeholder for future ZK integration
      prepared.metadata.isConfidential = true;
    }

    return prepared;
  }

  // ============ Helpers ============

  /**
   * Get security information summary
   */
  getSecurityInfo(): SecurityInfo {
    const enabledFeatures: string[] = [];

    if (this.config.features.stealthAddresses) {
      enabledFeatures.push('Stealth Addresses');
    }
    if (this.config.features.encryptedMemos) {
      enabledFeatures.push('Encrypted Memos');
    }
    if (this.config.features.confidentialAmounts) {
      enabledFeatures.push('Confidential Amounts');
    }
    if (this.config.features.zkProofs) {
      enabledFeatures.push('ZK Proofs');
    }

    return {
      level: this.config.defaultLevel,
      features: enabledFeatures,
      hasStealthKeys: this.hasStealthKeys(),
      metaAddress: this.stealthKeys ? this.getStealthMetaAddress() : undefined,
    };
  }

  /**
   * Validate a meta-address format
   *
   * @param metaAddress - Address to validate
   * @returns true if valid
   */
  isValidMetaAddress(metaAddress: string): boolean {
    try {
      decodeStealthMetaAddress(metaAddress);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear all stored keys from memory
   *
   * Call this when the user logs out or the session ends.
   */
  clearKeys(): void {
    if (this.stealthKeys) {
      // Overwrite sensitive data before clearing
      this.stealthKeys.scanPrivateKey.fill(0);
      this.stealthKeys.spendPrivateKey.fill(0);
      this.stealthKeys = null;
    }

    if (this.encryptionKeyPair) {
      this.encryptionKeyPair.privateKey.fill(0);
      this.encryptionKeyPair = null;
    }
  }

  // ============ Private Methods ============

  private mergeConfig(partial?: Partial<SecurityConfig>): SecurityConfig {
    if (!partial) return { ...DEFAULT_CONFIG };

    return {
      ...DEFAULT_CONFIG,
      ...partial,
      features: {
        ...DEFAULT_CONFIG.features,
        ...partial.features,
      },
    };
  }

  private ensureFeatureEnabled(feature: keyof SecurityFeatures): void {
    if (!this.config.features[feature]) {
      const featureNames: Record<keyof SecurityFeatures, string> = {
        stealthAddresses: 'Stealth addresses',
        encryptedMemos: 'Encrypted memos',
        confidentialAmounts: 'Confidential amounts',
        zkProofs: 'ZK proofs',
      };

      throw new SecurityError(
        `${featureNames[feature]} are not enabled. Enable them in your configuration.`,
        'FEATURE_DISABLED'
      );
    }
  }

  private ensureStealthInitialized(): void {
    if (!this.stealthKeys) {
      throw new SecurityError(
        'Stealth keys not initialized. Call generateStealthKeys() first.',
        'STEALTH_NOT_INITIALIZED'
      );
    }
  }

  private ensureEncryptionInitialized(): void {
    if (!this.encryptionKeyPair) {
      throw new SecurityError(
        'Encryption not initialized. Call initializeEncryption() first.',
        'CONFIGURATION_ERROR'
      );
    }
  }

  private shouldUseStealthAddress(level: SecurityLevel): boolean {
    return (
      this.config.features.stealthAddresses &&
      (level === 'private' || level === 'confidential' || level === 'maximum')
    );
  }

  private shouldEncryptMemo(level: SecurityLevel): boolean {
    return (
      this.config.features.encryptedMemos &&
      (level === 'private' || level === 'confidential' || level === 'maximum')
    );
  }

  private shouldUseConfidentialAmounts(level: SecurityLevel): boolean {
    return level === 'confidential' || level === 'maximum';
  }

  private parsePublicKey(key: string): Uint8Array {
    // Try to detect format (hex or base64)
    try {
      if (/^[0-9a-fA-F]+$/.test(key)) {
        // Hex format
        const bytes = new Uint8Array(key.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(key.substr(i * 2, 2), 16);
        }
        return bytes;
      } else {
        // Assume base64
        const binary = atob(key);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }
    } catch {
      throw new SecurityError(
        'Invalid public key format. Expected hex or base64 encoded key.',
        'INVALID_PUBLIC_KEY'
      );
    }
  }

  private serializeEncryptedPayload(payload: EncryptedPayload): string {
    return btoa(JSON.stringify(payload));
  }

  private deserializeEncryptedPayload(data: string): EncryptedPayload {
    try {
      return JSON.parse(atob(data));
    } catch {
      throw new SecurityError(
        'Invalid encrypted data format.',
        'DECRYPTION_FAILED'
      );
    }
  }

  private deriveEncryptionKeyFromMetaAddress(metaAddress: string): string {
    try {
      const decoded = decodeStealthMetaAddress(metaAddress);
      // Use scan public key as encryption key (common pattern)
      return this.bytesToHex(decoded.scanPublicKey);
    } catch {
      // If not a meta-address, assume it's already a public key
      return metaAddress;
    }
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

// ============ Factory Functions ============

/**
 * Create a SecurityManager with standard settings (no privacy by default)
 */
export function createStandardSecurity(): SecurityManager {
  return new SecurityManager({
    defaultLevel: 'standard',
    features: {
      stealthAddresses: false,
      encryptedMemos: false,
      confidentialAmounts: false,
      zkProofs: false,
    },
  });
}

/**
 * Create a SecurityManager with private settings (stealth + encryption)
 */
export async function createPrivateSecurity(): Promise<SecurityManager> {
  const manager = new SecurityManager({
    defaultLevel: 'private',
    features: {
      stealthAddresses: true,
      encryptedMemos: true,
      confidentialAmounts: false,
      zkProofs: false,
    },
  });

  // Auto-initialize keys
  manager.generateStealthKeys();
  await manager.initializeEncryption();

  return manager;
}

/**
 * Create a SecurityManager with maximum privacy settings
 *
 * Note: Confidential amounts require additional ZK setup
 */
export async function createMaximumSecurity(lightProgramId?: string): Promise<SecurityManager> {
  const manager = new SecurityManager({
    defaultLevel: 'maximum',
    features: {
      stealthAddresses: true,
      encryptedMemos: true,
      confidentialAmounts: !!lightProgramId,
      zkProofs: !!lightProgramId,
    },
    lightProgramId,
  });

  // Auto-initialize keys
  manager.generateStealthKeys();
  await manager.initializeEncryption();

  return manager;
}

// ============ Exports ============

export type {
  SecurityLevel,
  SecurityConfig,
  SecurityFeatures,
  StealthKeyPair,
  StealthMetaAddress,
  StealthAddress,
  StealthPayment,
  EncryptedPayload,
  EncryptedMemo,
  ConfidentialAmount,
} from './types';
