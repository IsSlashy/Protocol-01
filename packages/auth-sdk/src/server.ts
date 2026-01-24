/**
 * Protocol 01 Auth Server SDK
 *
 * Server-side utilities for verifying P01 authentication
 *
 * @example
 * ```typescript
 * import { P01AuthServer } from '@p01/auth-sdk/server';
 *
 * const auth = new P01AuthServer({
 *   serviceId: 'my-service',
 *   subscriptionMint: 'SUBSxxxx...',
 *   rpcUrl: 'https://api.mainnet-beta.solana.com',
 * });
 *
 * // In your callback endpoint
 * app.post('/auth/callback', async (req, res) => {
 *   const result = await auth.verifyCallback(req.body);
 *   if (result.success) {
 *     // Create user session
 *     req.session.wallet = result.wallet;
 *   }
 * });
 * ```
 */

import { Connection, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  AuthResponse,
  SubscriptionProof,
  VerificationResult,
  AuthSession,
} from './types';
import { createSignMessage, isTimestampValid } from './protocol';

export interface P01AuthServerConfig {
  /** Your service ID */
  serviceId: string;
  /** SPL token mint for subscription (optional) */
  subscriptionMint?: string;
  /** Solana RPC URL */
  rpcUrl?: string;
  /** Maximum age of auth timestamp (default: 60s) */
  maxTimestampAge?: number;
  /** Session store for multi-server setups */
  sessionStore?: ServerSessionStore;
}

export interface ServerSessionStore {
  get(sessionId: string): Promise<AuthSession | null>;
  set(session: AuthSession): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/**
 * P01 Auth Server for backend verification
 */
export class P01AuthServer {
  private config: P01AuthServerConfig;
  private connection: Connection | null = null;

  constructor(config: P01AuthServerConfig) {
    this.config = {
      maxTimestampAge: 60000,
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      ...config,
    };

    if (this.config.subscriptionMint) {
      this.connection = new Connection(this.config.rpcUrl!);
    }
  }

  /**
   * Verify an authentication callback
   */
  async verifyCallback(
    response: AuthResponse,
    session?: AuthSession
  ): Promise<VerificationResult> {
    try {
      // Verify timestamp is recent
      if (!isTimestampValid(response.timestamp, this.config.maxTimestampAge)) {
        return { success: false, error: 'Timestamp expired or invalid' };
      }

      // Get session if store provided
      let sessionData = session;
      if (!sessionData && this.config.sessionStore) {
        sessionData = await this.config.sessionStore.get(response.sessionId) || undefined;
      }

      // Verify signature
      const signatureValid = await this.verifySignature(
        response,
        sessionData?.challenge
      );

      if (!signatureValid) {
        return { success: false, error: 'Invalid signature' };
      }

      // Verify subscription if required
      if (this.config.subscriptionMint) {
        const subscriptionValid = await this.verifySubscription(
          response.wallet,
          response.subscriptionProof
        );

        if (!subscriptionValid) {
          return { success: false, error: 'Subscription not active' };
        }

        return {
          success: true,
          wallet: response.wallet,
          subscriptionActive: true,
        };
      }

      return {
        success: true,
        wallet: response.wallet,
      };
    } catch (error: any) {
      return { success: false, error: error.message || 'Verification failed' };
    }
  }

  /**
   * Verify a signature
   */
  async verifySignature(
    response: AuthResponse,
    challenge?: string
  ): Promise<boolean> {
    try {
      // Reconstruct signed message
      const message = createSignMessage(
        this.config.serviceId,
        response.sessionId,
        challenge || '',
        response.timestamp
      );

      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = bs58.decode(response.signature);
      const publicKeyBytes = bs58.decode(response.publicKey);

      // Verify wallet matches public key
      const derivedWallet = new PublicKey(publicKeyBytes).toBase58();
      if (derivedWallet !== response.wallet) {
        return false;
      }

      return nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKeyBytes
      );
    } catch (error) {
      console.error('[P01Auth] Signature verification error:', error);
      return false;
    }
  }

  /**
   * Verify subscription on-chain
   */
  async verifySubscription(
    wallet: string,
    proof?: SubscriptionProof
  ): Promise<boolean> {
    if (!this.config.subscriptionMint) {
      return true; // No subscription required
    }

    // First check the provided proof
    if (proof) {
      const proofValid = this.validateSubscriptionProof(proof);
      if (!proofValid) {
        return false;
      }
    }

    // Then verify on-chain
    if (this.connection) {
      try {
        const walletPubkey = new PublicKey(wallet);
        const mintPubkey = new PublicKey(this.config.subscriptionMint);

        // Get associated token account
        const [ata] = PublicKey.findProgramAddressSync(
          [
            walletPubkey.toBuffer(),
            new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
            mintPubkey.toBuffer(),
          ],
          new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
        );

        const accountInfo = await this.connection.getTokenAccountBalance(ata);
        const balance = BigInt(accountInfo.value.amount);

        return balance > 0;
      } catch (error) {
        // Token account doesn't exist or other error
        console.error('[P01Auth] On-chain verification error:', error);
        return false;
      }
    }

    return false;
  }

  /**
   * Validate subscription proof structure
   */
  validateSubscriptionProof(proof: SubscriptionProof): boolean {
    if (!proof.mint || !proof.balance) {
      return false;
    }

    // Check mint matches expected
    if (this.config.subscriptionMint && proof.mint !== this.config.subscriptionMint) {
      return false;
    }

    // Check balance is positive
    const balance = BigInt(proof.balance);
    if (balance <= 0) {
      return false;
    }

    // Check not expired
    if (proof.expiresAt && Date.now() > proof.expiresAt) {
      return false;
    }

    return true;
  }

  /**
   * Create Express/Fastify middleware
   */
  middleware() {
    return async (req: any, res: any, next: any) => {
      // Check for P01 auth header
      const authHeader = req.headers['x-p01-auth'];
      if (!authHeader) {
        return next();
      }

      try {
        const authData = JSON.parse(
          Buffer.from(authHeader, 'base64').toString()
        );
        const result = await this.verifyCallback(authData);

        if (result.success) {
          req.p01Auth = {
            wallet: result.wallet,
            subscriptionActive: result.subscriptionActive,
          };
        }
      } catch (error) {
        // Invalid auth header, continue without auth
      }

      next();
    };
  }

  /**
   * Check if a wallet has active subscription (direct check)
   */
  async checkSubscription(wallet: string): Promise<{
    active: boolean;
    balance?: string;
    expiresAt?: number;
  }> {
    if (!this.config.subscriptionMint || !this.connection) {
      return { active: true };
    }

    try {
      const walletPubkey = new PublicKey(wallet);
      const mintPubkey = new PublicKey(this.config.subscriptionMint);

      const [ata] = PublicKey.findProgramAddressSync(
        [
          walletPubkey.toBuffer(),
          new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(),
          mintPubkey.toBuffer(),
        ],
        new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
      );

      const accountInfo = await this.connection.getTokenAccountBalance(ata);
      const balance = BigInt(accountInfo.value.amount);

      return {
        active: balance > 0,
        balance: accountInfo.value.amount,
      };
    } catch {
      return { active: false };
    }
  }
}

export default P01AuthServer;
