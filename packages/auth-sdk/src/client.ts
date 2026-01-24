/**
 * Protocol 01 Auth Client SDK
 *
 * Use this in your web application to generate auth QR codes
 * and handle the authentication flow.
 *
 * @example
 * ```typescript
 * import { P01AuthClient } from '@p01/auth-sdk/client';
 *
 * const auth = new P01AuthClient({
 *   serviceId: 'my-service',
 *   serviceName: 'My Streaming Service',
 *   callbackUrl: 'https://myservice.com/auth/callback',
 * });
 *
 * // Create a login session
 * const session = await auth.createSession();
 *
 * // Display QR code
 * document.getElementById('qr').innerHTML = session.qrCodeSvg;
 *
 * // Wait for completion
 * const result = await auth.waitForCompletion(session.sessionId);
 * if (result.success) {
 *   console.log('User logged in:', result.wallet);
 * }
 * ```
 */

import {
  ServiceConfig,
  AuthQRPayload,
  AuthSession,
  SessionStatus,
  AuthEvent,
  QRDisplayOptions,
  VerificationResult,
} from './types';

import {
  generateSessionId,
  generateChallenge,
  generateDeepLink,
  DEFAULT_SESSION_TTL,
  MAX_SESSION_TTL,
} from './protocol';

export interface P01AuthClientConfig {
  /** Unique service identifier */
  serviceId: string;
  /** Human-readable service name */
  serviceName: string;
  /** Callback URL for auth completion */
  callbackUrl: string;
  /** Service logo URL */
  logoUrl?: string;
  /** SPL token mint for subscription verification */
  subscriptionMint?: string;
  /** Session TTL in milliseconds (default: 5 minutes) */
  sessionTtl?: number;
  /** WebSocket URL for real-time updates (optional) */
  wsUrl?: string;
  /** Custom storage for sessions (default: in-memory) */
  sessionStorage?: SessionStorage;
}

export interface SessionStorage {
  get(sessionId: string): Promise<AuthSession | null>;
  set(session: AuthSession): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface CreateSessionResult {
  /** Unique session ID */
  sessionId: string;
  /** Deep link URL for QR code */
  deepLink: string;
  /** QR code as SVG string */
  qrCodeSvg: string;
  /** QR code as data URL (for img src) */
  qrCodeDataUrl: string;
  /** Session expiration timestamp */
  expiresAt: number;
  /** Full session object */
  session: AuthSession;
}

/**
 * In-memory session storage (for development/simple use cases)
 */
class InMemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, AuthSession>();

  async get(sessionId: string): Promise<AuthSession | null> {
    return this.sessions.get(sessionId) || null;
  }

  async set(session: AuthSession): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

/**
 * P01 Auth Client for service providers
 */
export class P01AuthClient {
  private config: P01AuthClientConfig;
  private storage: SessionStorage;
  private eventListeners = new Map<string, Set<(event: AuthEvent) => void>>();
  private ws: WebSocket | null = null;

  constructor(config: P01AuthClientConfig) {
    this.config = {
      sessionTtl: DEFAULT_SESSION_TTL,
      ...config,
    };

    // Cap session TTL
    if (this.config.sessionTtl! > MAX_SESSION_TTL) {
      this.config.sessionTtl = MAX_SESSION_TTL;
    }

    this.storage = config.sessionStorage || new InMemorySessionStorage();
  }

  /**
   * Create a new authentication session
   */
  async createSession(options?: {
    /** Custom session TTL */
    ttl?: number;
    /** Additional metadata */
    metadata?: Record<string, string>;
  }): Promise<CreateSessionResult> {
    const sessionId = generateSessionId();
    const challenge = generateChallenge();
    const now = Date.now();
    const ttl = options?.ttl || this.config.sessionTtl!;
    const expiresAt = now + ttl;

    // Create session
    const session: AuthSession = {
      sessionId,
      serviceId: this.config.serviceId,
      challenge,
      status: 'pending',
      createdAt: now,
      expiresAt,
    };

    // Store session
    await this.storage.set(session);

    // Create QR payload
    const payload: AuthQRPayload = {
      v: 1,
      protocol: 'p01-auth',
      service: this.config.serviceId,
      session: sessionId,
      challenge,
      callback: this.config.callbackUrl,
      exp: expiresAt,
      name: this.config.serviceName,
      logo: this.config.logoUrl,
    };

    if (this.config.subscriptionMint) {
      payload.mint = this.config.subscriptionMint;
    }

    // Generate deep link
    const deepLink = generateDeepLink(payload);

    // Generate QR code
    const qrCodeSvg = this.generateQRCodeSvg(deepLink);
    const qrCodeDataUrl = this.svgToDataUrl(qrCodeSvg);

    // Emit event
    this.emit({ type: 'session_created', session });

    // Set up expiration timer
    setTimeout(() => {
      this.handleSessionExpired(sessionId);
    }, ttl);

    return {
      sessionId,
      deepLink,
      qrCodeSvg,
      qrCodeDataUrl,
      expiresAt,
      session,
    };
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<AuthSession | null> {
    return this.storage.get(sessionId);
  }

  /**
   * Update session status
   */
  async updateSession(
    sessionId: string,
    updates: Partial<AuthSession>
  ): Promise<AuthSession | null> {
    const session = await this.storage.get(sessionId);
    if (!session) return null;

    const updated = { ...session, ...updates };
    await this.storage.set(updated);

    return updated;
  }

  /**
   * Handle incoming auth callback
   * Call this when your callback URL receives a POST request
   */
  async handleCallback(body: {
    sessionId: string;
    wallet: string;
    signature: string;
    publicKey: string;
    timestamp: number;
    subscriptionProof?: any;
  }): Promise<VerificationResult> {
    const session = await this.storage.get(body.sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    if (session.status === 'completed') {
      return { success: false, error: 'Session already completed' };
    }

    if (Date.now() > session.expiresAt) {
      return { success: false, error: 'Session expired' };
    }

    // Verify signature
    const isValidSignature = await this.verifySignature(
      session,
      body.wallet,
      body.signature,
      body.publicKey,
      body.timestamp
    );

    if (!isValidSignature) {
      await this.updateSession(body.sessionId, { status: 'failed' });
      this.emit({
        type: 'session_failed',
        sessionId: body.sessionId,
        error: 'Invalid signature',
      });
      return { success: false, error: 'Invalid signature' };
    }

    // Verify subscription if required
    let subscriptionActive = true;
    if (this.config.subscriptionMint && body.subscriptionProof) {
      subscriptionActive = this.verifySubscriptionProof(body.subscriptionProof);
    }

    if (this.config.subscriptionMint && !subscriptionActive) {
      await this.updateSession(body.sessionId, { status: 'failed' });
      this.emit({
        type: 'session_failed',
        sessionId: body.sessionId,
        error: 'Subscription not active',
      });
      return { success: false, error: 'Subscription not active' };
    }

    // Update session as completed
    const updatedSession = await this.updateSession(body.sessionId, {
      status: 'completed',
      walletAddress: body.wallet,
      signature: body.signature,
      subscriptionProof: body.subscriptionProof,
    });

    this.emit({
      type: 'session_completed',
      session: updatedSession!,
      wallet: body.wallet,
    });

    return {
      success: true,
      wallet: body.wallet,
      subscriptionActive,
      session: {
        id: session.sessionId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      },
    };
  }

  /**
   * Wait for session completion (polling or WebSocket)
   */
  async waitForCompletion(
    sessionId: string,
    options?: {
      /** Polling interval in ms (default: 2000) */
      pollInterval?: number;
      /** Timeout in ms (default: session TTL) */
      timeout?: number;
    }
  ): Promise<VerificationResult> {
    const pollInterval = options?.pollInterval || 2000;
    const session = await this.storage.get(sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    const timeout = options?.timeout || session.expiresAt - Date.now();

    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkSession = async () => {
        const current = await this.storage.get(sessionId);

        if (!current) {
          resolve({ success: false, error: 'Session not found' });
          return;
        }

        if (current.status === 'completed') {
          resolve({
            success: true,
            wallet: current.walletAddress,
            subscriptionActive: !!current.subscriptionProof,
            session: {
              id: current.sessionId,
              createdAt: current.createdAt,
              expiresAt: current.expiresAt,
            },
          });
          return;
        }

        if (current.status === 'failed' || current.status === 'rejected') {
          resolve({ success: false, error: `Session ${current.status}` });
          return;
        }

        if (Date.now() - startTime > timeout) {
          resolve({ success: false, error: 'Timeout waiting for completion' });
          return;
        }

        // Continue polling
        setTimeout(checkSession, pollInterval);
      };

      checkSession();
    });
  }

  /**
   * Subscribe to session events
   */
  onSessionEvent(
    sessionId: string,
    callback: (event: AuthEvent) => void
  ): () => void {
    if (!this.eventListeners.has(sessionId)) {
      this.eventListeners.set(sessionId, new Set());
    }
    this.eventListeners.get(sessionId)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.eventListeners.get(sessionId)?.delete(callback);
    };
  }

  /**
   * Cancel a session
   */
  async cancelSession(sessionId: string): Promise<void> {
    await this.storage.delete(sessionId);
    this.eventListeners.delete(sessionId);
  }

  // Private methods

  private emit(event: AuthEvent): void {
    const sessionId = 'sessionId' in event
      ? event.sessionId
      : 'session' in event
        ? event.session.sessionId
        : null;

    if (sessionId) {
      const listeners = this.eventListeners.get(sessionId);
      listeners?.forEach(cb => cb(event));
    }
  }

  private async handleSessionExpired(sessionId: string): Promise<void> {
    const session = await this.storage.get(sessionId);
    if (session && session.status === 'pending') {
      await this.updateSession(sessionId, { status: 'expired' });
      this.emit({ type: 'session_expired', sessionId });
    }
  }

  private async verifySignature(
    session: AuthSession,
    wallet: string,
    signature: string,
    publicKey: string,
    timestamp: number
  ): Promise<boolean> {
    try {
      // Dynamic import for tweetnacl (works in both browser and Node)
      const nacl = await import('tweetnacl');
      const bs58 = await import('bs58');

      // Reconstruct the signed message
      const message = `P01-AUTH:${session.serviceId}:${session.sessionId}:${session.challenge}:${timestamp}`;
      const messageBytes = new TextEncoder().encode(message);

      // Decode signature and public key
      const signatureBytes = bs58.default.decode(signature);
      const publicKeyBytes = bs58.default.decode(publicKey);

      // Verify
      return nacl.default.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKeyBytes
      );
    } catch (error) {
      console.error('[P01Auth] Signature verification failed:', error);
      return false;
    }
  }

  private verifySubscriptionProof(proof: any): boolean {
    // Basic validation - in production, verify on-chain
    if (!proof || !proof.mint || !proof.balance) {
      return false;
    }

    // Check if balance is greater than 0
    const balance = BigInt(proof.balance);
    if (balance <= 0) {
      return false;
    }

    // Check if subscription is not expired
    if (proof.expiresAt && Date.now() > proof.expiresAt) {
      return false;
    }

    return true;
  }

  /**
   * Generate QR code as SVG (simple implementation)
   * For production, use a proper QR library like 'qrcode'
   */
  private generateQRCodeSvg(data: string, options?: QRDisplayOptions): string {
    const size = options?.size || 256;
    const darkColor = options?.darkColor || '#000000';
    const lightColor = options?.lightColor || '#ffffff';

    // Simple QR matrix generation (placeholder - use real QR library in production)
    // This generates a placeholder pattern
    const moduleCount = 33; // QR version 4
    const moduleSize = size / moduleCount;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;
    svg += `<rect width="100%" height="100%" fill="${lightColor}"/>`;

    // Generate QR pattern based on data hash
    const hash = this.simpleHash(data);
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        // Position patterns (corners)
        if (this.isPositionPattern(row, col, moduleCount)) {
          svg += `<rect x="${col * moduleSize}" y="${row * moduleSize}" width="${moduleSize}" height="${moduleSize}" fill="${darkColor}"/>`;
          continue;
        }

        // Data modules based on hash
        const idx = row * moduleCount + col;
        if ((hash[idx % hash.length].charCodeAt(0) + idx) % 3 === 0) {
          svg += `<rect x="${col * moduleSize}" y="${row * moduleSize}" width="${moduleSize}" height="${moduleSize}" fill="${darkColor}"/>`;
        }
      }
    }

    // Add logo in center if requested
    if (options?.logo && options.logoUrl) {
      const logoSize = size * 0.2;
      const logoPos = (size - logoSize) / 2;
      svg += `<rect x="${logoPos - 2}" y="${logoPos - 2}" width="${logoSize + 4}" height="${logoSize + 4}" fill="${lightColor}"/>`;
      svg += `<image x="${logoPos}" y="${logoPos}" width="${logoSize}" height="${logoSize}" href="${options.logoUrl}"/>`;
    }

    svg += '</svg>';
    return svg;
  }

  private isPositionPattern(row: number, col: number, size: number): boolean {
    // Top-left
    if (row < 7 && col < 7) return true;
    // Top-right
    if (row < 7 && col >= size - 7) return true;
    // Bottom-left
    if (row >= size - 7 && col < 7) return true;
    return false;
  }

  private simpleHash(str: string): string {
    let hash = '';
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash += ((char * 31 + i) % 256).toString(16).padStart(2, '0');
    }
    return hash.repeat(10); // Make it longer for more coverage
  }

  private svgToDataUrl(svg: string): string {
    const encoded = encodeURIComponent(svg);
    return `data:image/svg+xml,${encoded}`;
  }
}

export default P01AuthClient;
